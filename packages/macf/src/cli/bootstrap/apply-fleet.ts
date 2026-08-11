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
 *
 * ## Recovery-artifact lifecycle (§D5 "durable before gate 2," 2026-08-11 review)
 *
 * This module OWNS the recovery-artifact path (`vault-write.ts`'s
 * `agentRecoveryArtifactPath`) at both ends of its lifecycle, so the write
 * side and the delete side can never drift apart:
 *
 *   - **Write side:** `applyFleet` builds ONE `writeRecoveryArtifact`
 *     closure (knowing `manifestPath` → the recovery dir, and
 *     `manifest.transport.age_recipient` → who it encrypts to) and splices
 *     it onto the `AgentApplyDeps` object `deps.buildAgentDeps` returns —
 *     that factory deliberately does NOT produce this field (see
 *     `apply-agent.ts`'s `realAgentApplyDeps` doc); this module is the one
 *     with the fleet-level context to build it. `apply-agent.ts` calls it
 *     per-agent, immediately after gate 1, before gate 2 — see its module
 *     doc.
 *   - **Delete side:** ONLY after the batched final-vault compose SUCCEEDS
 *     (the same `vault.status === 'written'` branch that writes the batched
 *     `fleet.lock` entries below) does this module delete each `created`
 *     role's recovery artifact — its credential now has a durable home in
 *     the vault of record, so the write-only insurance copy is no longer
 *     needed. A FAILED compose deliberately leaves every recovery artifact
 *     from this run in place — see the recovery procedure below.
 *   - **Pre-flight (the part that makes "closed" true, not just "usually
 *     true"):** `writeRecoveryArtifact` itself rejects when
 *     `transport.age_recipient` is unconfigured (nothing to encrypt to) —
 *     but by the time it would run, gate 1 has ALREADY minted a real,
 *     irreversible GitHub App. Discovering the misconfiguration there is
 *     too late: the credential can never be captured (no recipient means
 *     no artifact either), so THAT App's credential is genuinely lost, not
 *     just delayed. `wouldCreateWithNoRecipient` / `noRecipientPreflightFailure`
 *     close this by refusing gate 1 ENTIRELY for any role that would take
 *     the CREATE path when `recipients` is empty — computed once, before
 *     the loop, from the same immutable `manifest.transport.age_recipient`
 *     input `writeRecoveryArtifact` itself would have checked. This is the
 *     ONLY reason the "credential-loss hole is closed" claim below is true
 *     rather than "true except when misconfigured."
 *
 * ## Recovery procedure — "App created, not yet in the final vault"
 *
 * A crash (or a failed batched vault write) after gate 1 succeeded for one
 * or more agents but before this module's `vault.status === 'written'`
 * branch runs leaves: (a) a REAL App on GitHub for each such role, (b) that
 * role's credential durable in `secrets/recovery/<role>.age`, and (c) NO
 * `fleet.lock` entry for that role (lock entries for `created` outcomes are
 * written only in the SAME branch that deletes the artifacts, above).
 *
 * **Being accurate about what a re-run actually does today (no
 * auto-resume):** a re-run's `confirmBeforeCreateGuard` sees no
 * `fleet.lock` entry for the role, so it authorizes `create` again —
 * `apply-agent.ts` attempts gate 1 A SECOND TIME with the SAME derived App
 * name. GitHub rejects the duplicate name loudly (rather than silently
 * creating a second App or transparently resuming the first), so the
 * re-run also reports `status: 'failed'` for that role. There is currently
 * NO code path that detects "this App already exists, resume from here" on
 * a re-run for a role with no lock entry — that would require a live
 * PEM→JWT presence check keyed on the DERIVED handle before attempting
 * create, which is out of this increment's scope (the same vault-aware
 * `resolveKeyPath` gap `apply-agent.ts`'s module doc already flags).
 *
 * **What IS durable, and the MANUAL recovery it enables:** the credential
 * itself is not lost — it survives in the recovery artifact. To recover:
 *
 *   1. Decrypt the artifact with the operator's (or the VM's) age identity:
 *      `age -d -i <identity-file> secrets/recovery/<role>.age` — the
 *      plaintext is a small shell-sourceable block (`MACF_RECOVERY_<ROLE>_*`
 *      keys: app id/name/slug/client id/client secret/webhook secret/PEM
 *      base64 — no `install_id`, since gate 2 never completed).
 *   2. If the App's install did NOT complete: finish it manually at
 *      `https://github.com/apps/<app-slug>/installations/new`, or delete
 *      the orphaned App in GitHub Settings → Developer settings → GitHub
 *      Apps and let a clean re-run recreate it from scratch (simpler if the
 *      install never happened and no other secret already depends on this
 *      App's identity).
 *   3. If the App's install DID complete (recorded install_id obtainable
 *      via `gh api /app/installations` with the recovered PEM, or from the
 *      GitHub UI): hand-compose a `fleet.lock` entry + fold the recovered
 *      secret into `vault.age` — `writeVault` does not merge, so this is a
 *      manual, one-off decrypt-edit-reencrypt of the vault by the operator,
 *      not an `apply` invocation. There is no automated tool for this fold
 *      in the current increment. **Field mapping** (the two plaintexts use
 *      DIFFERENT key prefixes — `buildVaultPlaintext` in `vault-write.ts`
 *      is the canonical target shape): recovery's `MACF_RECOVERY_<ROLE>_*`
 *      → vault's `MACF_AGENT_<HANDLE-SEGMENT>_*`, where `<HANDLE-SEGMENT>`
 *      is `toVariableSegment(deriveAppHandle(fleet, role))` — i.e. the
 *      SAME value as recovery's own `APP_NAME` field, NOT the bare role.
 *      `client_id`/`client_secret`/`webhook_secret` carry over 1:1;
 *      `PRIVATE_KEY_B64` in both is the SAME base64 PEM, copied verbatim;
 *      `install_id` has no source in the recovery artifact — it comes from
 *      wherever step 3 obtained it (the `gh api` call or the UI), above.
 *
 * This procedure is intentionally NOT fully automated in Slice 2b increment
 * 5a — the credential-loss hole IS closed (the pre-flight above means no
 * App is ever created when its credential could never be captured, so
 * nothing is silently gone for any App that DOES get created), but
 * automatic re-use of an orphaned-but-real App is future scope.
 */
import { dirname, join } from 'node:path';
import type { FleetLock, FleetLockAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { AgentApplyDeps, AgentApplyOutcome } from './apply-agent.js';
import { applyAgentIdentity } from './apply-agent.js';
import type { AppCredentials } from './manifest-exchange.js';
import type { RepoInitStepDeps, RepoInitStepOutcome } from './apply-repo-init.js';
import { applyRepoInitForAgent } from './apply-repo-init.js';
import type { FleetLockAgentUpdate, FleetLockIdentityChange } from './fleet-lock.js';
import { composeFleetLock, writeFleetLock } from './fleet-lock.js';
import type { VaultAgentSecrets, VaultEncryptFn, WriteVaultDeps } from './vault-write.js';
import {
  VaultError,
  ageEncryptToFile,
  agentRecoveryArtifactPath,
  buildVaultPlaintext,
  removeAgentRecoveryArtifact,
  vaultAgentSecretsForFingerprint,
  writeAgentRecoveryArtifact,
  writeVault,
} from './vault-write.js';

export interface FleetApplyDeps {
  /**
   * Builds every `AgentApplyDeps` primitive EXCEPT `writeRecoveryArtifact`
   * — `applyFleet` supplies that one itself (see this module's doc's
   * "Recovery-artifact lifecycle" section); it is the layer with the
   * fleet-level context (`manifestPath`, `manifest.transport.age_recipient`)
   * the writer needs.
   */
  readonly buildAgentDeps: (log: (line: string) => void) => Omit<AgentApplyDeps, 'writeRecoveryArtifact'>;
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

/** `manifest.transport.age_recipient` as the single-element recipients list `writeVault`/`writeAgentRecoveryArtifact` both expect — `null` (unconfigured) becomes an empty list, which each of those functions rejects loudly on its own. */
function ageRecipients(manifest: FleetManifest): readonly string[] {
  return manifest.transport.age_recipient !== null ? [manifest.transport.age_recipient] : [];
}

/**
 * Splice the fleet-level `writeRecoveryArtifact` implementation onto the
 * base `AgentApplyDeps` `deps.buildAgentDeps` returns — see this module's
 * doc's "Recovery-artifact lifecycle" section for why THIS module (not
 * `apply-agent.ts`, not `commands/bootstrap-apply.ts`) owns this wiring:
 * it is the layer that knows both `manifestPath` (→ the recovery dir) and
 * `manifest.transport.age_recipient` (→ who to encrypt to). Reuses
 * `deps.vaultDeps.encrypt` — the SAME injectable `age` seam the final vault
 * write uses (task requirement: no separate encrypt seam to keep in sync).
 *
 * Logs the artifact's PATH (never its contents) on success — the whole
 * point of the artifact is that an operator can FIND it after a crash, so
 * the transcript has to say where. On failure, the path is folded into the
 * re-thrown error's message so it also reaches `AgentApplyOutcome.reason`
 * (the one surface `--json` output guarantees callers see) without
 * `apply-agent.ts` needing to know anything about paths.
 */
function buildAgentDepsWithRecovery(secretsDir: string, recipients: readonly string[], deps: FleetApplyDeps): AgentApplyDeps {
  const base = deps.buildAgentDeps(deps.log);
  const encrypt: VaultEncryptFn = deps.vaultDeps.encrypt ?? ageEncryptToFile;
  return {
    ...base,
    writeRecoveryArtifact: async (role: string, creds: AppCredentials): Promise<void> => {
      const outPath = agentRecoveryArtifactPath(secretsDir, role);
      try {
        await writeAgentRecoveryArtifact(role, creds, recipients, outPath, encrypt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${msg} (recovery-artifact path: ${outPath})`, { cause: err });
      }
      deps.log(`Role "${role}": credential durably recorded at ${outPath} (recovery artifact, pre-gate-2, DR-043 §D5).`);
    },
  };
}

/**
 * DR-043 §D5 pre-flight — see the module doc's "Recovery-artifact
 * lifecycle" section. `confirmBeforeCreateGuard` returns `{action:
 * 'create'}` UNCONDITIONALLY (zero I/O) whenever `prior === undefined` —
 * so with `recipients` empty, EVERY such role is guaranteed to hit gate 1
 * only to have `writeRecoveryArtifact` reject moments later, having
 * already minted a real, irreversible GitHub App with an UNRECOVERABLE
 * credential (no recipient means no artifact is possible either). This
 * pre-flight recognizes that deterministically and refuses gate 1 for
 * those roles ENTIRELY — the only way the "credential-loss hole is closed"
 * claim in this module's + `apply-agent.ts`'s doc is actually true: a role
 * that DOES reach gate 1 is now guaranteed to have a non-empty
 * `recipients`, so `writeAgentRecoveryArtifact`'s own no-recipients
 * rejection becomes unreachable via this orchestrator (it remains as
 * defense-in-depth for a caller that drives `applyAgentIdentity` directly).
 * A role WITH a prior lock entry is unaffected — reuse/resume/skip/drift
 * never mint a new credential, so an unconfigured recipient can't lose one.
 */
function wouldCreateWithNoRecipient(prior: FleetLockAgent | undefined, recipients: readonly string[]): boolean {
  return prior === undefined && recipients.length === 0;
}

function noRecipientPreflightFailure(role: string): AgentApplyOutcome {
  return {
    role,
    status: 'failed',
    reason:
      `role "${role}" has no prior fleet.lock entry, so it would take the CREATE path — but ` +
      'transport.age_recipient is not configured (DR-043 §D5), so its credential could NEVER be made durable ' +
      '(no recipient to encrypt the recovery artifact OR the final vault to). Refusing to open consent gate 1 ' +
      "for a credential that can never be saved — mint an age recipient and set transport.age_recipient in " +
      'fleet.yaml, then re-run.',
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
  const secretsDir = join(dirname(manifestPath), 'secrets');
  const vaultOutPath = join(secretsDir, 'vault.age');
  const recipients = ageRecipients(manifest);
  const agentDeps = buildAgentDepsWithRecovery(secretsDir, recipients, deps);

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
    // DR-043 §D5 pre-flight — see `noRecipientPreflightFailure`'s doc.
    // Never opens gate 1 for a role that could never make its credential
    // durable in the first place.
    const identity = wouldCreateWithNoRecipient(prior, recipients)
      ? noRecipientPreflightFailure(agent.role)
      : await applyAgentIdentity(agent, manifest, prior, agentDeps);

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
    // The credential each `created` role's recovery artifact was insurance
    // FOR now has a durable home in the FINAL vault (§D5 store of record) —
    // the write-only insurance copy is no longer needed. A FAILED compose
    // (the `if` above not taken) deliberately leaves every artifact from
    // this run in place — see the module doc's recovery procedure.
    for (const role of Object.keys(pendingCreatedUpdates)) {
      removeAgentRecoveryArtifact(agentRecoveryArtifactPath(secretsDir, role));
    }
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
