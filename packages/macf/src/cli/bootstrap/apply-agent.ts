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
import {
  GATE_TOTAL,
  manifestFormAction,
  startInstallInterstitial as realStartInstallInterstitial,
  startManifestFlow as realStartManifestFlow,
} from './manifest-flow-server.js';
import type { InstallInterstitialHandles, InstallInterstitialOptions, ManifestFlowHandles, StartManifestFlowOptions } from './manifest-flow-server.js';
import { exchangeManifestCode as realExchangeManifestCode } from './manifest-exchange.js';
import type { AppCredentials } from './manifest-exchange.js';
import {
  appInstallationUrl,
  confirmAppInstallation as realConfirmAppInstallation,
  waitForAppInstallation as realWaitForAppInstallation,
} from './identity-confirm.js';
import type { ConfirmedInstall, ExpectedIdentity, IdentityConfirmation, WaitForAppInstallationOptions } from './identity-confirm.js';
import { appSettingsAdvancedUrl } from './app-identity-removal.js';
import { appNameCollisionRefusalMessage, resolveAppPresenceStatus } from './app-presence.js';
import type { Presence } from './plan.js';

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
  /**
   * Consent gate 2's own locally-served interstitial (groundnuty/macf#952) —
   * serves the "Only select repositories" + exact-repo-list instruction on
   * OUR page BEFORE the operator ever reaches GitHub's install page. Called
   * for BOTH the create path and the resume-install path (every gate-2 run
   * gets an interstitial, regardless of how gate 2 was reached) — see
   * {@link runGate2WithInterstitial}.
   */
  readonly startInstallInterstitial: (opts: InstallInterstitialOptions) => Promise<InstallInterstitialHandles>;
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
  /**
   * Post-gate-2 install validation (groundnuty/macf#943) — called with the
   * `ConfirmedInstall` gate 2 just observed, BEFORE this module reports
   * `'created'`/`'resumed-install'`. Returns a rejection reason string to
   * fail the identity apply, `undefined` to accept. `undefined`/omitted
   * (every ordinary agent's deps) preserves the pre-#943 behavior exactly —
   * gate 2 succeeding is always sufficient. The runner-ops is the only
   * caller that supplies this (asserting `repositorySelection === 'selected'`
   * — GitHub's App-manifest flow has no field to FORCE the install-time repo
   * scope at creation, so this is the verify-then-refuse enforcement point;
   * see `apply-runner-ops.ts`'s doc). A rejection here does NOT delete
   * the App or the install — same "GitHub App-name uniqueness is the retry
   * safety net" posture the rest of this module's gate-2 failures already
   * rely on (module doc's "gate 1→2 window" section).
   */
  readonly validateInstall?: (install: ConfirmedInstall) => string | undefined;
  /**
   * Pre-flight App-NAME-collision check (groundnuty/macf#967 Defect 2) — run
   * ONLY on the `decision.action === 'create'` path (NO `fleet.lock` entry
   * for this role), immediately BEFORE gate 1 opens. "No lock entry" ≠ "no
   * App by this name exists on GitHub" — a prior lock can have been wiped
   * (`macf fleet destroy`), or the name can collide with something created
   * out-of-band. Without this check, that collision surfaces as GitHub's raw
   * "name already taken" error INSIDE the browser gate; this catches it
   * first and states both remedies.
   *
   * Optional — omitted (every pre-fix caller/test) degrades to no refusal:
   * proceeds to gate 1 exactly as before, GitHub's own App-name uniqueness
   * remaining the backstop (module doc's "gate 1→2 window"). Only a
   * confirmed `'present'` refuses — `'unknown'` NEVER blocks a legitimate
   * create (Amendment A's honest-unknown floor cuts both ways). Real
   * default: `app-presence.ts::resolveAppPresenceStatus`, a bare top-level
   * reference — `manifest.owner` is already in scope at the call site.
   */
  readonly checkAppNameCollision?: (owner: FleetManifest['owner'], appSlug: string) => Promise<Presence>;
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
    startInstallInterstitial: realStartInstallInterstitial,
    exchangeManifestCode: realExchangeManifestCode,
    waitForAppInstallation: realWaitForAppInstallation,
    confirmAppInstallation: realConfirmAppInstallation,
    checkAppNameCollision: resolveAppPresenceStatus,
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
 *
 * `opts.instructionLines` (groundnuty/macf#952) — printed to the terminal
 * ONE PER LINE, BEFORE `deps.openUrl` is ever called. This is the ordering
 * the whole issue is about: the operator's first live install picked
 * GitHub's "All repositories" over "Only select repositories" because the
 * requirement only appeared in the FAILURE message, after the click. Logging
 * the instruction ahead of the navigation — headless (`--yes`) runs included,
 * since `deps.log` is unconditional here — means a run with no page to read
 * still gets the same instruction, in the same terminal transcript, before
 * (never after) the point where following it would matter.
 */
async function announceAndOpenGate(
  deps: Pick<AgentApplyDeps, 'log' | 'openUrl'>,
  role: string,
  gateLabel: string,
  url: string,
  waitLabel: string,
  opts: { readonly fatal: boolean; readonly caveat?: string; readonly instructionLines?: readonly string[] },
): Promise<void> {
  const caveatSuffix = opts.caveat !== undefined ? ` ${opts.caveat}` : '';
  for (const line of opts.instructionLines ?? []) {
    deps.log(`Role "${role}": ${line}`);
  }
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
 * The manifest/homepage shape one identity apply needs — deliberately
 * NARROWER than {@link FleetAgent} (groundnuty/macf#943). A `FleetAgent`
 * carries `profile`/`repo`/`deploy_path`/`provenance` fields that only make
 * sense for a fleet.yaml-declared coordination agent; the runner-ops
 * App (`apply-runner-ops.ts`) is a fleet-level identity with none of
 * those (no home repo, no deploy target) but goes through the EXACT SAME
 * confirm-before-create → gate 1 → gate 2 sequence. {@link applyIdentity} is
 * that sequence, parameterized on this request; {@link applyAgentIdentity}
 * below is now a thin wrapper deriving one from a `FleetAgent` — its own
 * behavior for the FleetAgent path is unchanged byte-for-byte.
 */
export interface IdentityRequest {
  readonly role: string;
  /** Homepage shown on the App page — `undefined` falls through to `buildAppManifest`'s own default. */
  readonly homepageUrl?: string;
  /** Overrides `buildAppManifest`'s DR-019-derived permission set. `undefined` (every agent) keeps the DR-019 set. */
  readonly permissions?: Readonly<Record<string, string>>;
  /** Overrides `buildAppManifest`'s default coordination events. `undefined` (every agent) keeps the default set. */
  readonly events?: readonly string[];
}

/**
 * The EXACT repos consent gate 2's interstitial names for this identity
 * (groundnuty/macf#952) — derived from the manifest, never a hand-maintained
 * parallel list. A `role` that matches a declared `manifest.agents[].role`
 * (every ordinary coordination agent) is scoped to just its OWN home repo —
 * `FleetAgentSchema` already enforces one repo per role (`fleet-manifest.ts`'s
 * "every agent needs its own home repo" uniqueness check), so that repo is
 * the entire, unambiguous answer. A `role` with NO match (today, only the
 * runner-ops — `RUNNER_OPS_ROLE` is deliberately never declared in
 * `fleet.yaml`'s `agents[]`, per `apply-runner-ops.ts`'s doc) needs to mint
 * runner-registration tokens for ANY of the fleet's repos, so every declared
 * agent's repo is listed.
 */
export function installReposForIdentity(role: string, manifest: FleetManifest): readonly string[] {
  const match = manifest.agents.find((a) => a.role === role);
  return match !== undefined ? [match.repo] : manifest.agents.map((a) => a.repo);
}

/**
 * The one-sentence "why" the gate-2 interstitial shows for THIS identity's
 * permission set (groundnuty/macf#952). `administration: write` (today, only
 * the runner-ops — see `apply-runner-ops.ts::RUNNER_OPS_PERMISSIONS`) gets
 * the specific blast-radius framing the operator's incident report asked
 * for verbatim, including that `apply` enforces it
 * (`validateRunnerOpsInstall`'s post-gate-2 refusal, unchanged by this
 * function). Every other identity (DR-019's set — no `administration` at
 * all) gets a generic but still concrete reason: broader access is unused
 * capability, not a convenience.
 */
export function installWhyText(permissions: Readonly<Record<string, string>> | undefined): string {
  if (permissions?.['administration'] === 'write') {
    return (
      'Why: this App holds administration:write; granting it every repository in the account is blast radius ' +
      'the fleet does not need, and apply will refuse an "all" install.'
    );
  }
  return (
    'Why: this App only needs access to the repo(s) listed above — granting every repository in the account is ' +
    'broader access than this identity uses.'
  );
}

/**
 * Drive ONE identity through confirm-before-create → gate 1 → gate 2. See the
 * module doc for the full sequence + the gate-1→gate-2 window discussion.
 * NEVER throws — every failure path resolves to `status: 'failed'`.
 */
export async function applyIdentity(
  request: IdentityRequest,
  manifest: FleetManifest,
  prior: FleetLockAgent | undefined,
  deps: AgentApplyDeps,
): Promise<AgentApplyOutcome> {
  const role = request.role;
  const handle = deriveAppHandle(manifest.metadata.name, role);
  // Best-known slug for a PRE-EXISTING App is the derived handle — a prior
  // successful gate 1 submitted `buildAppManifest`'s `name` field, which IS
  // deriveAppHandle's output (barring a rare GitHub collision-suffix — the
  // same caveat `app-manifest.ts`'s `PlannedAppCreation.installUrl` doc
  // flags for the dry-run preview).
  const guardExpected: ExpectedIdentity = { appSlug: handle, accountLogin: manifest.owner.account };
  // groundnuty/macf#952 — computed ONCE, valid on EITHER gate-2 path (create
  // or resume-install): both derive from `request`/`manifest`, neither from
  // anything gate 1 produces.
  const repos = installReposForIdentity(role, manifest);
  const whyText = installWhyText(request.permissions);

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
    return runGate2WithInterstitial(role, decision.appId, decision.keyPath, guardExpected, handle, appInstallationUrl(handle), repos, whyText, deps, {
      caveat:
        '(URL predicted from the fleet/role naming convention — no GitHub-confirmed slug is available on this ' +
        'path; if it 404s, find the App via Settings → Developer settings → GitHub Apps instead.)',
    });
  }

  // Pre-flight the App-NAME collision BEFORE gate 1 (groundnuty/macf#967
  // Defect 2 — see `checkAppNameCollision`'s doc). Only CONFIRMED 'present'
  // refuses; 'absent'/'unknown' proceed unchanged.
  if (deps.checkAppNameCollision) {
    let collision: Presence;
    try {
      collision = await deps.checkAppNameCollision(manifest.owner, handle);
    } catch (err) {
      // Fail-open, same posture every honest-unknown read in this package
      // takes — a throwing dep is inconclusive, never a refusal.
      deps.log(`Role "${role}": pre-flight App-name-collision check failed (${errMessage(err)}) — proceeding to gate 1; GitHub's own uniqueness check remains the backstop.`);
      collision = 'unknown';
    }
    if (collision === 'present') {
      const reason = appNameCollisionRefusalMessage(handle, appSettingsAdvancedUrl(manifest.owner, handle));
      deps.log(`Role "${role}": REFUSED before consent gate 1 — ${reason}`);
      return { role, status: 'failed', reason };
    }
  }

  // decision.action === 'create' — consent gate 1.
  deps.log(`Role "${role}": no prior App — starting consent gate 1 of ${String(GATE_TOTAL)} (App-manifest creation).`);
  let creds: AppCredentials;
  try {
    const flow = await deps.startManifestFlow({
      buildManifest: (redirectUrl) =>
        buildAppManifest({
          fleetName: manifest.metadata.name,
          role,
          redirectUrl,
          homepageUrl: request.homepageUrl,
          permissions: request.permissions,
          events: request.events,
        }),
      formAction: manifestFormAction(manifest.owner),
      timeoutMs: deps.gateTimeoutMs,
      role,
    });
    try {
      await announceAndOpenGate(deps, role, `consent gate 1 of ${String(GATE_TOTAL)} (App-manifest form)`, flow.startUrl, 'Create GitHub App', {
        fatal: true,
        instructionLines: [
          `creating GitHub App "${handle}" — the page that opened shows the manifest submitted AS-IS (nothing ` +
            'to edit); GitHub will then show its own confirmation page — click "Create GitHub App" there.',
        ],
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
  const pemPath = writeScratchPem(role, creds.pem);
  try {
    const outcome = await runGate2WithInterstitial(role, creds.appId, pemPath, gate2Expected, creds.slug, appInstallationUrl(creds.slug), repos, whyText, deps, {});
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
 * Drive ONE agent through confirm-before-create → gate 1 → gate 2. Thin
 * wrapper over {@link applyIdentity} (groundnuty/macf#943) — derives an
 * {@link IdentityRequest} from `agent.role`/`agent.repo` and delegates; the
 * FleetAgent-path behavior is unchanged from before this wrapper existed
 * (same role, same `repoHomepageUrl`, no permissions/events override).
 */
export async function applyAgentIdentity(
  agent: FleetAgent,
  manifest: FleetManifest,
  prior: FleetLockAgent | undefined,
  deps: AgentApplyDeps,
): Promise<AgentApplyOutcome> {
  return applyIdentity({ role: agent.role, homepageUrl: repoHomepageUrl(agent.repo) }, manifest, prior, deps);
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
    // groundnuty/macf#943 — post-gate-2 install validation (see
    // `AgentApplyDeps.validateInstall`'s doc). Checked BEFORE reporting
    // success: a rejection here means gate 2 technically completed but the
    // install doesn't satisfy this identity's own contract (e.g. the
    // runner-ops's repository_selection !== 'selected').
    const rejection = deps.validateInstall?.(install);
    if (rejection !== undefined) {
      return { role, status: 'failed', reason: `consent gate 2 (install) rejected: ${rejection}` };
    }
    deps.log(`Role "${role}": install confirmed (install_id ${install.installId}).`);
    return { role, status: 'resumed-install', appId, installId: install.installId };
  } catch (err) {
    return { role, status: 'failed', reason: `consent gate 2 (install) failed: ${errMessage(err)}` };
  }
}

/**
 * Serve consent gate 2's own interstitial (groundnuty/macf#952), announce +
 * open ITS URL (never GitHub's install URL directly — see this module's
 * `manifest-flow-server.ts` doc), run the gate-2 poll, then close the
 * interstitial. Shared by BOTH gate-2 call sites in {@link applyIdentity}
 * (create path + resume-install path) so the instruction/repo-list/why-text
 * content and the "our page first" ordering are identical on either path —
 * one implementation, not two that could drift.
 *
 * `installUrl` is still printed in the terminal instruction lines (never
 * only embedded in the served page) — a headless/`--yes` run has no page to
 * read (groundnuty/macf#952 requirement 3).
 *
 * **Never lets a local-listener failure become an unhandled throw.**
 * `applyIdentity` documents (module doc, top of file) that it NEVER throws —
 * every failure resolves to `status: 'failed'`, which `apply-fleet.ts`
 * relies on. `deps.startInstallInterstitial` binding an ephemeral port CAN
 * fail (`EADDRINUSE`, fd exhaustion, sandboxed environments without loopback)
 * — by the time this runs, a real GitHub App may already exist (CREATE path)
 * or exist for certain (resume-install path), so treating a bind failure as
 * fatal would manufacture exactly the orphaned-App class this module's "gate
 * 1→2 window" doc section exists to avoid. Instead: log the degradation and
 * fall back to opening GitHub's REAL install URL directly — the terminal
 * instruction lines (repo list, "Only select repositories", why-text) still
 * printed either way, so the operator loses the interstitial page, not the
 * instruction. Same `fatal: false` posture gate 2 already has for a browser-
 * launch failure.
 */
interface Gate2Page {
  /** What to `openUrl` — the interstitial's own URL on success, GitHub's real install URL on a bind failure. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Starts the interstitial; on a bind failure, degrades to "open GitHub's
 * install URL directly" rather than propagating (see
 * {@link runGate2WithInterstitial}'s doc for why a local-listener failure
 * must never abort an identity that may already exist on GitHub).
 */
async function startInterstitialOrFallback(deps: AgentApplyDeps, role: string, opts: InstallInterstitialOptions): Promise<Gate2Page> {
  try {
    const handles = await deps.startInstallInterstitial(opts);
    return { url: handles.startUrl, close: handles.close };
  } catch (err) {
    deps.log(
      `Role "${role}": could not start the local install-instruction page (${errMessage(err)}) — falling back to ` +
        "GitHub's install page directly. The instruction below still applies.",
    );
    return { url: opts.installUrl, close: () => Promise.resolve() };
  }
}

async function runGate2WithInterstitial(
  role: string,
  appId: string,
  keyPath: string,
  expected: ExpectedIdentity,
  appSlug: string,
  installUrl: string,
  repos: readonly string[],
  whyText: string,
  deps: AgentApplyDeps,
  opts: { readonly caveat?: string },
): Promise<Gate2Outcome> {
  const page = await startInterstitialOrFallback(deps, role, {
    role,
    appName: appSlug,
    installUrl,
    repos,
    whyText,
    // The install page is always the SECOND (and last) of the two gates —
    // literal `2`, not derived from `GATE_TOTAL` (which happens to equal 2
    // today but means "how many gates total," not "which gate this is").
    gateNumber: 2,
    gateTotal: GATE_TOTAL,
  });
  try {
    await announceAndOpenGate(deps, role, `consent gate ${String(GATE_TOTAL)} of ${String(GATE_TOTAL)} (App install page)`, page.url, 'Install', {
      fatal: false,
      caveat: opts.caveat,
      instructionLines: [
        'on the page that opens, choose "Only select repositories" — NOT "All repositories".',
        `select exactly: ${repos.length > 0 ? repos.join(', ') : '(no repos declared in the fleet manifest — verify before installing)'}`,
        whyText,
        `GitHub's install page: ${installUrl}`,
      ],
    });
    return await runGate2(role, appId, keyPath, expected, deps);
  } finally {
    try {
      await page.close();
    } catch (err) {
      // Never let a close-failure mask the real gate-2 result computed above.
      deps.log(`Role "${role}": closing the local install-instruction page failed (${errMessage(err)}) — harmless, the page is one-shot.`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
