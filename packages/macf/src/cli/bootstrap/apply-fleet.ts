/**
 * `applyFleet` — the fleet-level driver behind `macf bootstrap apply`'s
 * mutating path (DR-043 §D2/§D3/§D5, Slice 2b increment 5a of
 * groundnuty/macf#838). Sibling to `plan.ts` (the read-only reconciler this
 * module shares its manifest/lock types with) and `apply-agent.ts` (the
 * per-agent identity primitive this module loops over).
 *
 * Pure orchestration over injected deps — no direct `gh`/`age`/`git` calls
 * live here, only calls into `apply-agent.ts` / `apply-repo-init.ts` /
 * `vault-write.ts` / `fleet-lock.ts`, all deps-injected — so the SEQUENCING
 * (who gets written when, in what order, and why) is unit-testable with
 * zero real I/O.
 *
 * ## Ordering rationale — why lock writes split into TWO moments
 *
 * Agents are processed ONE AT A TIME, fully (identity → repo-init) before
 * the next agent starts — see `apply-agent.ts`'s module doc for why that
 * narrows the gate-1→gate-2 window to a single agent.
 *
 * `fleet.lock` is written at two DIFFERENT points, deliberately:
 *
 *   1. **Immediately**, per-agent, for `reused` / `resumed-install`
 *      outcomes — these carry no NEW secret material (either the App was
 *      already fully confirmed, or gate 2 just completed for an App whose
 *      credentials were already durably vaulted by a PRIOR successful
 *      apply), so there is nothing to lose by recording `app_id`/
 *      `install_id` right away. This is what makes a re-run after an
 *      interruption skip work it already finished.
 *   2. **Only after a successful vault write**, batched, for `created`
 *      outcomes — `vault-write.ts`'s `writeVault` is a SINGLE-SHOT,
 *      whole-payload operation (its own module doc: it deliberately does
 *      not decrypt-merge-reencrypt a prior vault), so there is no way to
 *      durably persist ONE freshly-minted agent's secret without ALSO
 *      persisting every OTHER freshly-minted agent's secret from this same
 *      run in the SAME `age` invocation. The invariant this module upholds:
 *      **`fleet.lock` must never claim a `created` agent is provisioned
 *      before its credentials are durably in the vault** — recording it
 *      early would leave the credential lost forever (memory-only, never
 *      written anywhere) while claiming success. If the vault write fails,
 *      those agents' lock entries are deliberately left UNWRITTEN; a re-run
 *      sees no prior entry, retries gate 1, and GitHub's own App-name
 *      uniqueness is the backstop against a silent duplicate (same
 *      mechanism `apply-agent.ts` already relies on for the narrower
 *      per-agent window — see its module doc).
 *
 * `repo-init` runs for BOTH lock-write moments (it depends on neither —
 * `.github/workflows/agent-router.yml` + `agent-config.json` only need the
 * DERIVED app handle, not a confirmed live identity), so a `created` agent's
 * routing config still lands even in the rare case the vault write fails
 * afterward.
 */
import { dirname, join } from 'node:path';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { AgentApplyDeps, AgentApplyOutcome } from './apply-agent.js';
import { applyAgentIdentity } from './apply-agent.js';
import type { RepoInitStepDeps, RepoInitStepOutcome } from './apply-repo-init.js';
import { applyRepoInitForAgent } from './apply-repo-init.js';
import type { FleetLockAgentUpdate, FleetLockIdentityChange } from './fleet-lock.js';
import { composeFleetLock, writeFleetLock } from './fleet-lock.js';
import type { VaultAgentSecrets, WriteVaultDeps } from './vault-write.js';
import { VaultError, buildVaultPlaintext, vaultAgentSecretsForFingerprint, writeVault } from './vault-write.js';

export interface FleetApplyDeps {
  readonly buildAgentDeps: (log: (line: string) => void) => AgentApplyDeps;
  readonly repoInitDeps: RepoInitStepDeps;
  readonly vaultDeps: WriteVaultDeps;
  /** Injectable clock, threaded into `writeVault`'s version-suffix (deterministic tests). */
  readonly now: () => Date;
  readonly log: (line: string) => void;
  /** `true` → an existing `secrets/vault.age` is versioned (timestamped sibling), not clobbered. Mirrors `MACF_BOOTSTRAP_VAULT_VERSION=1` (`bootstrap-build-vault.sh` precedent). Default `false` (fail loud on an existing vault). */
  readonly allowVaultVersion?: boolean;
}

export interface AgentApplyRecord {
  readonly role: string;
  readonly identity: AgentApplyOutcome;
  /** `undefined` when identity wasn't resolved this run (`skipped-unverified` / `drift` / `failed`) — repo-init never runs for those. */
  readonly repoInit?: RepoInitStepOutcome;
}

export type VaultApplyOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'written'; readonly path: string; readonly versioned: boolean }
  | { readonly status: 'failed'; readonly reason: string };

export interface FleetApplyResult {
  readonly lockPath: string;
  readonly finalLock: FleetLock | null;
  readonly agents: readonly AgentApplyRecord[];
  readonly vault: VaultApplyOutcome;
  /** Accumulated across every incremental `composeFleetLock` call this run — DR-043 Amendment A §A2 "never silently resolve" drift. */
  readonly identityChanges: readonly FleetLockIdentityChange[];
}

function agentVaultSecrets(appHandle: string, outcome: Extract<AgentApplyOutcome, { status: 'created' }>): VaultAgentSecrets {
  return {
    appHandle,
    appId: outcome.appId,
    installId: outcome.installId,
    clientId: outcome.credentials.clientId,
    clientSecret: outcome.credentials.clientSecret,
    webhookSecret: outcome.credentials.webhookSecret,
    pem: outcome.credentials.pem,
  };
}

/**
 * Drive the full fleet through identity + repo-init + the (deferred, batched)
 * vault write. NEVER throws — every failure resolves into the returned
 * result's per-agent `identity`/`repoInit` outcomes or the top-level `vault`
 * outcome; the caller (`commands/bootstrap-apply.ts`) decides the exit code
 * and renders the human summary.
 */
export async function applyFleet(
  manifest: FleetManifest,
  manifestPath: string,
  priorLock: FleetLock | null,
  deps: FleetApplyDeps,
): Promise<FleetApplyResult> {
  const lockPath = join(dirname(manifestPath), 'fleet.lock');
  const vaultOutPath = join(dirname(manifestPath), 'secrets', 'vault.age');
  const agentDeps = deps.buildAgentDeps(deps.log);

  let currentLock = priorLock;
  const records: AgentApplyRecord[] = [];
  const pendingVaultAgents: VaultAgentSecrets[] = [];
  const pendingCreatedUpdates: Record<string, FleetLockAgentUpdate> = {};
  const identityChanges: FleetLockIdentityChange[] = [];

  const writeIncrementalLock = (role: string, update: FleetLockAgentUpdate): void => {
    const composed = composeFleetLock({ fleet: manifest.metadata.name, previous: currentLock, agentUpdates: { [role]: update } });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
    identityChanges.push(...composed.identityChanges);
  };

  for (const agent of manifest.agents) {
    const prior = currentLock?.agents.find((a) => a.role === agent.role);
    const identity = await applyAgentIdentity(agent, manifest, prior, agentDeps);

    let repoInitOutcome: RepoInitStepOutcome | undefined;
    const handle = deriveAppHandle(manifest.metadata.name, agent.role);

    if (identity.status === 'reused' || identity.status === 'resumed-install') {
      writeIncrementalLock(agent.role, { appId: identity.appId, installId: identity.installId });
      repoInitOutcome = await applyRepoInitForAgent(agent, manifest, deps.repoInitDeps);
    } else if (identity.status === 'created') {
      const secrets = agentVaultSecrets(handle, identity);
      pendingVaultAgents.push(secrets);
      pendingCreatedUpdates[agent.role] = {
        appId: identity.appId,
        installId: identity.installId,
        secrets: vaultAgentSecretsForFingerprint(secrets),
      };
      repoInitOutcome = await applyRepoInitForAgent(agent, manifest, deps.repoInitDeps);
    }
    // skipped-unverified / drift / failed: no lock write, no repo-init —
    // this agent's identity is unresolved this run.

    records.push({ role: agent.role, identity, repoInit: repoInitOutcome });
  }

  const vault = await settleVault(manifest, vaultOutPath, pendingVaultAgents, deps);
  if (vault.status === 'written' && Object.keys(pendingCreatedUpdates).length > 0) {
    // Batched, not per-role: `writeVault` just persisted EVERY `created`
    // agent's secret in ONE `age` invocation, so their lock entries become
    // durable together too — see the module doc's ordering rationale.
    const composed = composeFleetLock({ fleet: manifest.metadata.name, previous: currentLock, agentUpdates: pendingCreatedUpdates });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
    identityChanges.push(...composed.identityChanges);
  }

  return { lockPath, finalLock: currentLock, agents: records, vault, identityChanges };
}

/**
 * Assemble + attempt the single, whole-payload vault write for every
 * `created` agent this run. Returns the outcome WITHOUT writing
 * `fleet.lock` — the caller does that only on `status: 'written'` (see
 * module doc's ordering rationale).
 */
async function settleVault(
  manifest: FleetManifest,
  vaultOutPath: string,
  pendingVaultAgents: readonly VaultAgentSecrets[],
  deps: FleetApplyDeps,
): Promise<VaultApplyOutcome> {
  if (pendingVaultAgents.length === 0) return { status: 'skipped' };

  try {
    const recipient = manifest.transport.age_recipient;
    if (recipient === null) {
      throw new VaultError(
        'vault_no_age_recipient',
        'transport.age_recipient is null — no age recipient configured to encrypt the newly-minted credentials ' +
          'to. Mint one with `age-keygen` and set transport.age_recipient in fleet.yaml, then re-run apply — the ' +
          'App/install identities already recorded above are NOT re-created on re-run (GitHub App-name ' +
          'uniqueness is the guard).',
      );
    }
    const plaintext = buildVaultPlaintext({ agents: [...pendingVaultAgents] });
    const result = await writeVault(
      plaintext,
      { outPath: vaultOutPath, recipients: [recipient], allowVersion: deps.allowVaultVersion === true, now: deps.now },
      deps.vaultDeps,
    );
    return { status: 'written', path: result.path, versioned: result.versioned };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

// Re-exported so callers building a `VaultPayload`-shaped record elsewhere
// (tests, future increments) reuse the same fingerprint mapping this module
// uses internally, without importing `vault-write.ts` AND `fleet-lock.ts`
// separately for one helper each.
export { vaultAgentSecretsForFingerprint };
