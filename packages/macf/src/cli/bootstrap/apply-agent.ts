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
 * Both gates share one UX sequence ({@link announceAndOpenGate}): print the
 * URL, best-effort-open it in the operator's browser, then log what's being
 * waited on. Gate 1's open is fatal-on-failure (nothing exists on GitHub yet
 * to orphan); gate 2's is best-effort (a real App already exists by then —
 * see that function's doc).
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
 * {@link applyAgentIdentity}'s inline comment on that branch. Closing the
 * DUPLICATE-App-on-retry half of this window fully requires a vault-aware
 * `resolveKeyPath` (a live PEM→JWT re-check immediately after gate 1, before
 * gate 2) — out of scope for this increment (DR-043 Amendment A's
 * vault-aware observer/confirm is Slice-2+ scope); the hook
 * (`AgentApplyDeps.resolveKeyPath`) is already wired for it.
 *
 * **The CREDENTIAL-LOSS half of this window is closed for `applyFleet`, the
 * sole production caller (2026-08-11 review of this increment) — NOT by
 * this module alone.** Immediately after `exchangeManifestCode` returns —
 * BEFORE gate 2 opens — `deps.writeRecoveryArtifact` encrypts the just-
 * issued credentials to a per-agent recovery artifact
 * (`vault-write.ts::writeAgentRecoveryArtifact`, its own path, distinct from
 * the batched `vault.age`). A rejection there is a HARD failure for this
 * agent: this module refuses to proceed to gate 2 with a credential that
 * exists ONLY in process memory (DR-043 §D5 — the property that makes the
 * vault "of record" IS crash-safety, and a multi-minute operator-wait
 * (gate 2) sits between minting the credential and the batched compose that
 * would otherwise be its only durable home). But THIS module has no way to
 * know in advance whether `writeRecoveryArtifact` even CAN succeed (e.g. no
 * age recipient configured means no artifact is possible at all) — so on
 * its own, a rejection here would still mean gate 1 already minted a real
 * App whose credential is now provably unrecoverable. `apply-fleet.ts`
 * closes that gap with a PRE-FLIGHT (see its module doc) that refuses gate
 * 1 entirely for a role it can prove would hit this failure — making the
 * "closed" claim true for the orchestrator as a whole, not just for this
 * module in isolation. The artifact is deleted once the SAME credential
 * lands in the FINAL vault (`apply-fleet.ts`'s job, not this module's — it
 * owns the batched compose). What is still NOT automated
 * even with the artifact durable: on a crash between gate 1 and the final
 * vault write, a RE-RUN's confirm-before-create guard sees no `fleet.lock`
 * entry for this role (a lock entry requires gate 2 + a successful vault
 * write) and attempts gate 1 AGAIN — GitHub rejects the duplicate App name
 * loudly rather than resuming, so the re-run reports `status: 'failed'`
 * too. The App is orphaned-but-real on GitHub and its credential is
 * durable-but-unmerged in the recovery artifact; folding it into
 * `fleet.lock` + `vault.age` is a MANUAL operator step (decrypt the
 * artifact, then either complete the install + hand-merge the secret, or
 * delete the orphaned App and let a clean re-run recreate it) — see
 * `apply-fleet.ts`'s module doc for the full recovery procedure.
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
  /**
   * Persist `creds` to a durable, per-agent recovery artifact — DR-043 §D5
   * "durable before gate 2" (see this module's doc). Called EXACTLY once per
   * CREATE path, immediately after `exchangeManifestCode` resolves and
   * BEFORE gate 2 starts. MUST NOT be a no-op in production — a rejection
   * here is treated as a HARD failure for this agent (see
   * {@link applyAgentIdentity}'s call site): this module refuses to open
   * gate 2 with a credential durable only in process memory. Required
   * (not optional) because skipping it silently would reintroduce exactly
   * the hole this hook exists to close. Fleet-level wiring
   * (`apply-fleet.ts`) supplies the real implementation — it is the layer
   * that knows the recovery-artifact path + age recipients; this module
   * only knows WHEN to call it, not WHERE the artifact lives.
   */
  readonly writeRecoveryArtifact: (role: string, creds: AppCredentials) => Promise<void>;
}

/**
 * The real dependency set for every gate primitive EXCEPT
 * `writeRecoveryArtifact` — that one needs fleet-level context (the
 * manifest's age recipients + the manifest path) this function doesn't
 * have, so `apply-fleet.ts` supplies it (see that module's doc). The return
 * type reflects the omission explicitly rather than stubbing a fake writer
 * here that would just be thrown away.
 */
export function realAgentApplyDeps(
  openUrl: (url: string) => Promise<void>,
  log: (line: string) => void,
): Omit<AgentApplyDeps, 'writeRecoveryArtifact'> {
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
 * establishes for the plan-time / resume-install reads). This was ONCE the
 * only place this module wrote a raw PEM to disk; exported (groundnuty/macf#920)
 * so `apply-repo-init.ts` reuses the SAME 0600-scratch-file primitive to mint
 * a `repoInit` label-creation token from a freshly-created agent's in-memory
 * PEM, instead of duplicating this pattern. Callers MUST remove the result
 * (`cleanupScratchPem`) in a `finally` — it is never the vault, never
 * permanent, and never survives past the ONE call it exists for.
 */
export function writeScratchPem(role: string, pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), `macf-bootstrap-agent-${role}-`));
  const path = join(dir, 'key.pem');
  writeFileSync(path, pem, { mode: 0o600 });
  return path;
}

export function cleanupScratchPem(pemPath: string): void {
  try {
    rmSync(join(pemPath, '..'), { recursive: true, force: true });
  } catch {
    /* best-effort — never let scratch-file cleanup mask the real gate result */
  }
}

/**
 * The shared consent-gate UX sequence for BOTH gates — print the URL, best-
 * effort-open it, then log what the operator is being asked to click.
 *
 * **Printing the URL BEFORE `deps.openUrl` runs (not after) is the whole
 * point of this helper.** A live fleet-provisioning run showed `openUrl()`
 * can return successfully with NO browser tab ever actually appearing (the
 * silent-fallback-hazards.md shape: the call "succeeds" but the operator-
 * visible outcome it exists to produce doesn't happen) — recovering meant
 * `lsof`-ing the operator's Mac to find the ephemeral port by hand. Printing
 * first means the URL survives in the transcript regardless of whether the
 * open worked, and regardless of whether the process later hangs on the
 * gate itself (the operator can always scroll up).
 *
 * `opts.fatal` distinguishes the two gates' failure posture:
 *   - **gate 1** (`fatal: true`) — nothing has been created on GitHub yet, so
 *     an `openUrl` failure aborting this agent (existing behavior, unchanged
 *     here) is safe: there's nothing to orphan.
 *   - **gate 2** (`fatal: false`) — by the time this runs (either the
 *     just-created App on the CREATE path, or a pre-existing one on the
 *     resume-install path) a real GitHub App already exists. Aborting on a
 *     mere browser-launch failure would manufacture exactly the orphaned-App
 *     class this module's "gate 1→2 window" doc section exists to avoid —
 *     the printed URL is the fallback, so a launch failure is logged and
 *     the poll proceeds regardless.
 *
 * `opts.caveat`, when given, is appended to the URL line — used by the
 * resume-install call site to flag that its URL is a DERIVED PREDICTION
 * (`deriveAppHandle`), not a GitHub-confirmed slug (see
 * `applyAgentIdentity`'s `guardExpected` comment) — never overclaiming
 * accuracy the caller doesn't have, same discipline
 * `waitForInstallTimeoutMessage` already applies to its own diagnostics.
 */
async function announceAndOpenGate(
  deps: Pick<AgentApplyDeps, 'log' | 'openUrl'>,
  role: string,
  gateLabel: string,
  url: string,
  waitLabel: string,
  opts: { readonly fatal: boolean; readonly caveat?: string },
): Promise<void> {
  const caveatSuffix = opts.caveat !== undefined ? ` ${opts.caveat}` : '';
  deps.log(
    `Role "${role}": ${gateLabel} — opening this URL in your browser now (if it didn't open, open it yourself): ` +
      `${url}${caveatSuffix}`,
  );
  if (opts.fatal) {
    await deps.openUrl(url);
  } else {
    try {
      await deps.openUrl(url);
    } catch (err) {
      deps.log(`Role "${role}": could not automatically open a browser (${errMessage(err)}) — use the URL above.`);
    }
  }
  deps.log(`Role "${role}": waiting for you to click "${waitLabel}" …`);
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
    await announceAndOpenGate(deps, role, 'consent gate 2 (App install page)', appInstallationUrl(handle), 'Install', {
      fatal: false,
      caveat:
        '(URL predicted from the fleet/role naming convention — no GitHub-confirmed slug is available on this ' +
        'path; if it 404s, find the App via Settings → Developer settings → GitHub Apps instead.)',
    });
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
      await announceAndOpenGate(deps, role, 'consent gate 1 (App-manifest form)', flow.startUrl, 'Create GitHub App', {
        fatal: true,
      });
      const code = await flow.waitForCode();
      creds = await deps.exchangeManifestCode(code);
    } finally {
      await flow.close();
    }
  } catch (err) {
    return { role, status: 'failed', reason: `consent gate 1 (App creation) failed: ${errMessage(err)}` };
  }

  // DR-043 §D5 "durable before gate 2" (2026-08-11 review of this
  // increment) — the App now EXISTS on GitHub and `creds` is its ONLY
  // credential copy, held in process memory. Gate 2 is a multi-minute
  // operator-wait; persist the credential to its own recovery artifact
  // BEFORE opening that wait, not after. A failure here is a HARD stop —
  // proceeding to gate 2 with a non-durable credential is the exact hole
  // this call closes. See the module doc's "gate 1→2 window" section.
  const recoveryFailure = await writeRecoveryArtifactOrFail(role, creds, deps);
  if (recoveryFailure !== undefined) {
    return { role, status: 'failed', reason: recoveryFailure };
  }

  deps.log(
    `Role "${role}": App "${creds.name}" created (app_id ${creds.appId}), recovery artifact durably written — ` +
      'starting consent gate 2 (install).',
  );
  const gate2Expected: ExpectedIdentity = { appSlug: creds.slug, accountLogin: manifest.owner.account };
  await announceAndOpenGate(deps, role, 'consent gate 2 (App install page)', appInstallationUrl(creds.slug), 'Install', {
    fatal: false,
  });
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

/**
 * Wraps `deps.writeRecoveryArtifact` with the DR-043 §D5 "durable before
 * gate 2" failure framing (see the module doc + {@link applyAgentIdentity}'s
 * call site). Returns `undefined` on success, or the failure reason string
 * to return as `{ status: 'failed' }` — kept OUT of `applyAgentIdentity`'s
 * own body purely to keep that function's already-long branch sequence
 * scannable (same reasoning `runGate2` was already extracted for). NEVER
 * includes a credential value in the returned reason — only `role`/`appId`/
 * `name`, mirroring every other failure-reason string in this module.
 */
async function writeRecoveryArtifactOrFail(role: string, creds: AppCredentials, deps: AgentApplyDeps): Promise<string | undefined> {
  try {
    await deps.writeRecoveryArtifact(role, creds);
    return undefined;
  } catch (err) {
    return (
      `credential durability write failed BEFORE consent gate 2 (DR-043 §D5): ${errMessage(err)} — the App WAS ` +
      `created on GitHub (app_id ${creds.appId}, handle "${creds.name}") but its ONLY credential copy is process ` +
      'memory, about to be lost if this process exits. Refusing to proceed to gate 2 until the credential is ' +
      'durable. Fix the durability issue (recovery-artifact write target, disk space, missing age recipient) and ' +
      're-run — GitHub\'s own App-name uniqueness protects against a duplicate on retry.'
    );
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
