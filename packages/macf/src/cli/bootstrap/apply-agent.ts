/**
 * Per-agent identity provisioning — `macf bootstrap apply`'s orchestrator
 * core (DR-043 §D2, Slice 2b increment 5a of groundnuty/macf#838).
 *
 * {@link applyAgentIdentity} drives ONE agent through the full identity
 * sequence:
 *
 *   1. **Confirm-before-create guard** ({@link confirmBeforeCreateGuard}) —
 *      never create an App that already exists. A role with NO prior
 *      `fleet.lock` entry is authorized to create; a role WITH one is only
 *      re-confirmed live when a decryptable key path is available (see the
 *      guard's own doc for why that is `undefined` by default in this
 *      increment) — otherwise apply refuses to create, honestly, rather than
 *      risk a silent duplicate.
 *   2. **Consent gate 1** (`manifest-flow-server.ts` + `manifest-exchange.ts`)
 *      — ONLY when the guard authorizes a create.
 *   3. **Consent gate 2** (`identity-confirm.ts::waitForAppInstallation`) —
 *      for a freshly-created App, or to RESUME polling an App that exists on
 *      GitHub but has zero installs yet (the guard's `app-no-install` case —
 *      exactly the shape a gate-1-succeeded/gate-2-interrupted prior run
 *      leaves behind, so resuming here rather than re-creating is what makes
 *      that class of partial failure recoverable, module doc §"the gate
 *      1→2 window" below).
 *
 * Every network/subprocess touch is behind {@link AgentApplyDeps} — this
 * module does zero real I/O when driven by injected fakes, and never throws
 * (every failure mode, including a thrown gate, resolves to an
 * `AgentApplyOutcome` with `status: 'failed'`).
 *
 * **Never logs a secret.** `AgentApplyOutcome`'s `created` variant carries
 * the raw {@link AppCredentials} (PEM, client secret, webhook secret) so the
 * caller can assemble the vault payload — but this module's OWN `deps.log`
 * calls only ever mention role/app_id/install_id/handle/URLs, never a
 * credential value.
 *
 * ## The gate-1→gate-2 window (a deliberate, documented limitation)
 *
 * If the process dies between gate 1 succeeding and gate 2 completing, the
 * App EXISTS on GitHub but its PEM was only ever held in memory — this
 * module never writes a PERMANENT plaintext credential file (the vault is
 * the only durable secret store, DR-043 §D5), and `vault-write.ts`'s
 * `writeVault` is a single-shot, whole-payload operation (see its module doc
 * — it deliberately does not decrypt-merge-reencrypt a prior vault), so a
 * per-agent credential cannot be durably persisted mid-run either. Two
 * mitigations, both real but partial:
 *
 *   - **The window is per-agent, not per-run.** Agents are processed one at
 *     a time, fully (gate 1 THEN gate 2 for agent N, before starting agent
 *     N+1) — never "gate 1 for every agent, then gate 2 for every agent" —
 *     so an interruption only ever endangers the ONE agent in flight.
 *   - **GitHub's own App-name uniqueness is the safety net against a silent
 *     duplicate.** `deriveAppHandle` is deterministic, so a re-run's guard
 *     (seeing no `fleet.lock` entry for this role, because a lock entry
 *     requires a non-empty `install_id` — DR-043 `FleetLockAgentSchema` —
 *     which a gate-2-interrupted run never reached) will attempt gate 1
 *     AGAIN with the SAME `name`. GitHub rejects a duplicate App name
 *     loudly (at manifest-submit or exchange time) rather than silently
 *     creating a second App — this is an INHERENT property of the
 *     App-manifest flow, not a check this module performs.
 *
 * A gate-2 failure (including a timeout) on the CREATE path is therefore
 * reported as `status: 'failed'`, carrying the install URL so the operator
 * can complete the install manually in the same terminal session — see
 * {@link applyAgentIdentity}'s inline comment on that branch. Closing this
 * window fully requires a vault-aware `resolveKeyPath` (a live PEM→JWT
 * re-check immediately after gate 1, before gate 2) — out of scope for this
 * increment (DR-043 Amendment A's vault-aware observer/confirm is Slice-2+
 * scope); the hook (`AgentApplyDeps.resolveKeyPath`) is already wired for it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetAgent, FleetLockAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import { buildAppManifest, repoHomepageUrl } from './app-manifest.js';
import { manifestFormAction, startManifestFlow as realStartManifestFlow } from './manifest-flow-server.js';
import type { ManifestFlowHandles, StartManifestFlowOptions } from './manifest-flow-server.js';
import { exchangeManifestCode as realExchangeManifestCode } from './manifest-exchange.js';
import type { AppCredentials } from './manifest-exchange.js';
import {
  appInstallationUrl,
  confirmAppInstallation as realConfirmAppInstallation,
  waitForAppInstallation as realWaitForAppInstallation,
} from './identity-confirm.js';
import type { ConfirmedInstall, ExpectedIdentity, IdentityConfirmation, WaitForAppInstallationOptions } from './identity-confirm.js';

// --- Confirm-before-create guard ---

export type CreateGuardDecision =
  | { readonly action: 'create' }
  | { readonly action: 'reuse-confirmed'; readonly install: ConfirmedInstall }
  | { readonly action: 'resume-install'; readonly appId: string; readonly keyPath: string }
  | { readonly action: 'skip-unverified'; readonly appId: string; readonly reason: string }
  | { readonly action: 'drift'; readonly reason: string; readonly installs: readonly ConfirmedInstall[] };

export interface CreateGuardDeps {
  readonly confirmAppInstallation: (
    appId: string,
    keyPath: string,
    expected?: ExpectedIdentity,
  ) => Promise<IdentityConfirmation>;
  /**
   * Resolve a decryptable PEM path for a role with a PRIOR lock entry.
   * **`undefined` (the production default in this increment) for every
   * role, always** — there is no vault-decrypt primitive yet (DR-043
   * Amendment A1's "plan without vault access stays honest-`unknown`",
   * applied here to `apply`'s create boundary rather than `plan`'s read
   * boundary). A future increment wires this to the age-decrypted vault so
   * a role WITH a prior lock entry can be live-reconfirmed instead of
   * unconditionally deferred to `skip-unverified`.
   */
  readonly resolveKeyPath?: (role: string, priorAppId: string) => string | undefined;
}

/**
 * Never authorize a create when a `fleet.lock` entry for this role already
 * exists — that is the entire "confirm-before-create" contract (DR-043 §D2
 * point 1). A role absent from `fleet.lock` is the ONLY case authorized to
 * create without a live check (see the module doc's "gate-1→gate-2 window"
 * section for why a live check isn't possible there either way — there is
 * no known `app_id` yet to check against).
 */
export async function confirmBeforeCreateGuard(
  role: string,
  prior: FleetLockAgent | undefined,
  expected: ExpectedIdentity,
  deps: CreateGuardDeps,
): Promise<CreateGuardDecision> {
  if (prior === undefined) return { action: 'create' };

  const keyPath = deps.resolveKeyPath?.(role, prior.app_id);
  if (keyPath === undefined) {
    return {
      action: 'skip-unverified',
      appId: prior.app_id,
      reason:
        `fleet.lock records an App for "${role}" (app_id ${prior.app_id}) but no private-key path is ` +
        'available to live-reconfirm it (vault-decrypt is not wired in this apply increment — DR-043 ' +
        'Amendment A). Refusing to create a possibly-duplicate App. Verify manually on GitHub, or extend ' +
        'this run with a resolveKeyPath once a vault-decrypt seam exists.',
    };
  }

  const confirmation = await deps.confirmAppInstallation(prior.app_id, keyPath, expected);
  switch (confirmation.status) {
    case 'confirmed':
      return { action: 'reuse-confirmed', install: confirmation.install };
    case 'app-no-install':
      return { action: 'resume-install', appId: prior.app_id, keyPath };
    case 'installed-unexpected-target':
      return {
        action: 'drift',
        reason:
          `App "${role}" (app_id ${prior.app_id}) is installed, but not on the expected target — ` +
          'DR-043 Amendment A §A2 lock-vs-live drift. Never silently resolved; requires operator confirmation.',
        installs: confirmation.installs,
      };
    case 'unconfirmable':
      return {
        action: 'skip-unverified',
        appId: prior.app_id,
        reason:
          `Could not confirm the existing App for "${role}" (app_id ${prior.app_id}) live — GitHub was ` +
          'never successfully queried (JWT mint failure / 401 / network / timeout). Refusing to create a ' +
          'possibly-duplicate App. Check the app-id↔key-path pairing and network reachability, then re-run.',
      };
  }
}

// --- Per-agent identity flow ---

export interface AgentApplyDeps {
  readonly startManifestFlow: (opts: StartManifestFlowOptions) => Promise<ManifestFlowHandles>;
  readonly exchangeManifestCode: (code: string) => Promise<AppCredentials>;
  readonly waitForAppInstallation: (opts: WaitForAppInstallationOptions) => Promise<ConfirmedInstall>;
  readonly confirmAppInstallation: CreateGuardDeps['confirmAppInstallation'];
  readonly resolveKeyPath?: CreateGuardDeps['resolveKeyPath'];
  /** Open a URL in the operator's own browser — injectable so tests never launch one. */
  readonly openUrl: (url: string) => Promise<void>;
  readonly log: (line: string) => void;
  /** Overall budget for EACH gate. Defaults to the gate primitives' own defaults (10 min). */
  readonly gateTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** The real dependency set — every field is the actual primitive from its sibling module. */
export function realAgentApplyDeps(openUrl: (url: string) => Promise<void>, log: (line: string) => void): AgentApplyDeps {
  return {
    startManifestFlow: realStartManifestFlow,
    exchangeManifestCode: realExchangeManifestCode,
    waitForAppInstallation: realWaitForAppInstallation,
    confirmAppInstallation: realConfirmAppInstallation,
    openUrl,
    log,
  };
}

export type AgentApplyOutcome =
  | { readonly role: string; readonly status: 'created'; readonly appId: string; readonly installId: string; readonly credentials: AppCredentials }
  | { readonly role: string; readonly status: 'reused'; readonly appId: string; readonly installId: string }
  | { readonly role: string; readonly status: 'resumed-install'; readonly appId: string; readonly installId: string }
  | { readonly role: string; readonly status: 'skipped-unverified'; readonly appId: string; readonly reason: string }
  | { readonly role: string; readonly status: 'drift'; readonly reason: string; readonly installs: readonly ConfirmedInstall[] }
  | { readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Write a PEM to a short-lived 0600 scratch file for the duration of a JWT
 * mint (`confirmAppInstallation`/`waitForAppInstallation` both take a FILE
 * path, not raw PEM text — the same contract `identity-confirm.ts` already
 * establishes for the plan-time / resume-install reads). This is the ONLY
 * place this module writes a raw PEM to disk, and callers MUST remove it
 * (`cleanupScratchPem`) in a `finally` — it is never the vault, never
 * permanent, and never survives past the ONE gate-2 poll it exists for.
 */
function writeScratchPem(role: string, pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), `macf-bootstrap-agent-${role}-`));
  const path = join(dir, 'key.pem');
  writeFileSync(path, pem, { mode: 0o600 });
  return path;
}

function cleanupScratchPem(pemPath: string): void {
  try {
    rmSync(join(pemPath, '..'), { recursive: true, force: true });
  } catch {
    /* best-effort — never let scratch-file cleanup mask the real gate result */
  }
}

/**
 * Drive ONE agent through confirm-before-create → gate 1 → gate 2. See the
 * module doc for the full sequence + the gate-1→gate-2 window discussion.
 * NEVER throws — every failure path resolves to `status: 'failed'`.
 */
export async function applyAgentIdentity(
  agent: FleetAgent,
  manifest: FleetManifest,
  prior: FleetLockAgent | undefined,
  deps: AgentApplyDeps,
): Promise<AgentApplyOutcome> {
  const role = agent.role;
  const handle = deriveAppHandle(manifest.metadata.name, role);
  // Best-known slug for a PRE-EXISTING App is the derived handle — a prior
  // successful gate 1 submitted `buildAppManifest`'s `name` field, which IS
  // deriveAppHandle's output (barring a rare GitHub collision-suffix — the
  // same caveat `app-manifest.ts`'s `PlannedAppCreation.installUrl` doc
  // flags for the dry-run preview).
  const guardExpected: ExpectedIdentity = { appSlug: handle, accountLogin: manifest.owner.account };

  let decision: CreateGuardDecision;
  try {
    decision = await confirmBeforeCreateGuard(role, prior, guardExpected, deps);
  } catch (err) {
    return { role, status: 'failed', reason: `confirm-before-create guard threw: ${errMessage(err)}` };
  }

  if (decision.action === 'reuse-confirmed') {
    deps.log(`Role "${role}": App + install already confirmed live (app_id ${decision.install.appId}) — nothing to do.`);
    return { role, status: 'reused', appId: decision.install.appId, installId: decision.install.installId };
  }
  if (decision.action === 'skip-unverified') {
    deps.log(`Role "${role}": SKIPPED — ${decision.reason}`);
    return { role, status: 'skipped-unverified', appId: decision.appId, reason: decision.reason };
  }
  if (decision.action === 'drift') {
    deps.log(`Role "${role}": DRIFT — ${decision.reason}`);
    return { role, status: 'drift', reason: decision.reason, installs: decision.installs };
  }

  if (decision.action === 'resume-install') {
    // `decision.keyPath` came from `deps.resolveKeyPath` — a resource this
    // module did NOT create, so it is NOT this module's to delete (contrast
    // the CREATE path below, which writes its own scratch PEM and owns its
    // cleanup).
    deps.log(`Role "${role}": App exists (app_id ${decision.appId}) with zero installs — resuming at consent gate 2.`);
    return runGate2(role, decision.appId, decision.keyPath, guardExpected, deps);
  }

  // decision.action === 'create' — consent gate 1.
  deps.log(`Role "${role}": no prior App — starting consent gate 1 (App-manifest creation).`);
  let creds: AppCredentials;
  try {
    const flow = await deps.startManifestFlow({
      buildManifest: (redirectUrl) =>
        buildAppManifest({ fleetName: manifest.metadata.name, role, redirectUrl, homepageUrl: repoHomepageUrl(agent.repo) }),
      formAction: manifestFormAction(manifest.owner),
      timeoutMs: deps.gateTimeoutMs,
    });
    try {
      await deps.openUrl(flow.startUrl);
      deps.log(`Role "${role}": opened the App-manifest form in your browser — click "Create GitHub App" to continue.`);
      const code = await flow.waitForCode();
      creds = await deps.exchangeManifestCode(code);
    } finally {
      await flow.close();
    }
  } catch (err) {
    return { role, status: 'failed', reason: `consent gate 1 (App creation) failed: ${errMessage(err)}` };
  }

  deps.log(`Role "${role}": App "${creds.name}" created (app_id ${creds.appId}) — starting consent gate 2 (install).`);
  const gate2Expected: ExpectedIdentity = { appSlug: creds.slug, accountLogin: manifest.owner.account };
  const pemPath = writeScratchPem(role, creds.pem);
  try {
    const outcome = await runGate2(role, creds.appId, pemPath, gate2Expected, deps);
    if (outcome.status === 'failed') {
      // Gate 1 succeeded but gate 2 didn't — see the module doc's "gate
      // 1→2 window" section. The App EXISTS on GitHub; give the operator a
      // direct, actionable recovery path rather than just "it failed."
      return {
        role,
        status: 'failed',
        reason:
          `${outcome.reason} — the App WAS created on GitHub (app_id ${creds.appId}, handle "${creds.name}") but ` +
          `its install did not complete. Finish the install manually at ${appInstallationUrl(creds.slug)} and ` +
          're-run once a vault-aware confirm is available, or delete the orphaned App on GitHub and retry.',
      };
    }
    return { role, status: 'created', appId: creds.appId, installId: outcome.installId, credentials: creds };
  } finally {
    cleanupScratchPem(pemPath);
  }
}

/** The only two shapes `runGate2` itself produces — narrower than the full {@link AgentApplyOutcome} union so callers can narrow on `status === 'failed'` without a cast. */
type Gate2Outcome =
  | { readonly role: string; readonly status: 'resumed-install'; readonly appId: string; readonly installId: string }
  | { readonly role: string; readonly status: 'failed'; readonly reason: string };

/** Runs the gate-2 poll. Cleanup of `keyPath` (when it's a scratch file this module owns) is the CALLER's job — see call sites. */
async function runGate2(
  role: string,
  appId: string,
  keyPath: string,
  expected: ExpectedIdentity,
  deps: AgentApplyDeps,
): Promise<Gate2Outcome> {
  try {
    const install = await deps.waitForAppInstallation({
      appId,
      keyPath,
      expected,
      timeoutMs: deps.gateTimeoutMs,
      pollIntervalMs: deps.pollIntervalMs,
      onUnexpectedTarget: (installs) => {
        deps.log(
          `Role "${role}": WARNING — install observed on an unexpected target while polling (` +
            `${installs.map((i) => `${i.appSlug || '(no slug)'}@${i.accountLogin || '(no account)'}`).join(', ')}). ` +
            'Still polling in case the CORRECT install also completes.',
        );
      },
    });
    deps.log(`Role "${role}": install confirmed (install_id ${install.installId}).`);
    return { role, status: 'resumed-install', appId, installId: install.installId };
  } catch (err) {
    return { role, status: 'failed', reason: `consent gate 2 (install) failed: ${errMessage(err)}` };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
