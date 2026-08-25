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
 *      1→2 window" below). A credential recovered from a durable artifact
 *      (macf#988) is checked live BEFORE this gate opens
 *      ({@link skipGate2IfAlreadyInstalled}, groundnuty/macf#1137) — the
 *      install itself may already be confirmed from the prior run even
 *      though THIS run's vault never recorded it, and gate 2 is skipped
 *      entirely when so.
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
 * owns the batched compose).
 *
 * **The RE-RUN half of this window is ALSO closed, as of macf#988
 * (DR-043 Amendment B's consume side).** Originally: on a crash between
 * gate 1 and the final vault write, a RE-RUN's confirm-before-create guard
 * sees no `fleet.lock` entry for this role (a lock entry requires gate 2 +
 * a successful vault write) and attempts gate 1 AGAIN — GitHub rejects the
 * duplicate App name loudly rather than resuming, so the re-run ALSO
 * reported `status: 'failed'`, leaving the App orphaned-but-real on GitHub
 * and its credential durable-but-unmerged, recoverable only via a MANUAL
 * operator decrypt-and-fold. `deps.findRecoveryArtifact` closes this
 * automatically: `applyIdentity` checks it BEFORE either the App-name-
 * collision pre-flight or gate 1 (see that function's call site + the
 * artifact's new durable, operator-scoped location in `vault-write.ts`'s
 * module doc — the location fix is WHAT makes automatic re-run recovery
 * possible; the artifact has to outlive the crashed run for a later run to
 * find it). A found + decrypted artifact resumes straight at consent gate
 * 2 (see {@link finishGate2FromCredentials}) instead of re-attempting gate
 * 1 — no manual decrypt-and-fold needed for the common case. The one
 * residual: `deps.findRecoveryArtifact` can only decrypt when
 * `--identity-key` is supplied to this `apply` run (the same operator
 * identity that would decrypt the vault); without it, the artifact is
 * still FOUND (existence is reported) but not consumed, and the run falls
 * through to the pre-#988 refusal.
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
import { requiredRegistryRepoCoverage } from './registry-repo-coverage.js';

// --- Confirm-before-create guard ---

export type CreateGuardDecision =
  | { readonly action: 'create' }
  /**
   * `keyPath` (groundnuty/macf#1012) — the SAME decryptable PEM path used to
   * live-reconfirm this install, carried forward so `applyIdentity` can run
   * `AgentApplyDeps.validateInstall` on THIS path too, not only on the
   * CREATE/`resume-install` paths that flow through `runGate2`. Without it,
   * a post-gate-2 live check (e.g. registry-repo installation coverage)
   * would be structurally silent on every already-provisioned role re-
   * confirmed on a re-run — see `registry-repo-coverage.ts`'s "Coverage
   * scope" doc section for why that gap matters concretely.
   */
  | { readonly action: 'reuse-confirmed'; readonly install: ConfirmedInstall; readonly keyPath: string }
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
        'available to live-reconfirm it (vault-decrypt is not wired in this apply increment). ' +
        'Refusing to create a possibly-duplicate App. Verify manually on GitHub, or extend ' +
        'this run with a resolveKeyPath once a vault-decrypt seam exists.',
    };
  }

  const confirmation = await deps.confirmAppInstallation(prior.app_id, keyPath, expected);
  switch (confirmation.status) {
    case 'confirmed':
      return { action: 'reuse-confirmed', install: confirmation.install, keyPath };
    case 'app-no-install':
      return { action: 'resume-install', appId: prior.app_id, keyPath };
    case 'installed-unexpected-target':
      return {
        action: 'drift',
        reason:
          `App "${role}" (app_id ${prior.app_id}) is installed, but not on the expected target — ` +
          'a lock-vs-live drift. Never silently resolved; requires operator confirmation.',
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

/**
 * What `validateInstall`/`validateReuse` may return on rejection
 * (groundnuty/macf#1063 widens this from a bare `string`).
 *
 * A bare `string` — every pre-#1063 caller, e.g. `apply-runner-ops.ts::
 * validateRunnerOpsInstall` — is used AS-IS for both the technical
 * `AgentApplyOutcome.reason`/`Gate2Outcome.reason` AND, because there is no
 * cleaner alternative supplied, the interactive retry dialogue too.
 *
 * `{ message, retryInstruction }` lets a caller supply a SEPARATE,
 * plain-language sentence for the interactive "here's what to click"
 * dialogue (macf#1063 requirement 2 — "say exactly what to click," never a
 * 404/HTTP-status/issue-number sentence) while `message` still carries the
 * full technical detail into `reason` — the CLI's `--json`/log surface,
 * unchanged from #1012's own accepted text. `retryInstruction` omitted (or
 * a bare-string rejection) falls back to `message` for the dialogue too —
 * preserves every pre-#1063 caller's behavior exactly (see
 * {@link rejectionParts}).
 *
 * `missingRepos` (groundnuty/macf#1176) lets a rejecting hook name the
 * SPECIFIC `owner/repo`(s) it found missing, structurally — a bare
 * `retryInstruction` sentence names the repo in PROSE ("add
 * groundnuty/demo-fresh-control under Repository access…"), which is fine
 * for reading but not something a caller can safely re-derive a copyable
 * repo list from (parsing prose is fragile). Only
 * `registry-repo-coverage.ts::buildRegistryRepoValidateInstall` supplies it
 * today — the one rejecting hook with an actual specific repo in hand;
 * every other rejection (a bare string, or `{message}` with no
 * `missingRepos`) omits it, and callers fall back to the identity's FULL
 * required set (see `runGate2WithInterstitial`'s doc) rather than guessing.
 */
export type InstallRejection = string | { readonly message: string; readonly retryInstruction?: string; readonly missingRepos?: readonly string[] };

/** Normalizes an {@link InstallRejection} to its logical parts — the ONE place `runGate2`, `applyIdentity`'s reuse-confirmed branch, and `resumeGate2Preflight` extract `message`/`retryInstruction`/`missingRepos`, so none of the three drift on how a bare string degrades. */
function rejectionParts(rejection: InstallRejection): { readonly message: string; readonly retryInstruction?: string; readonly missingRepos?: readonly string[] } {
  return typeof rejection === 'string' ? { message: rejection } : rejection;
}

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
  /**
   * Give the operator a beat to read {@link announceAndOpenGate}'s just-
   * printed instructions BEFORE the browser opens (groundnuty/macf#952
   * follow-up). The ordering fix alone (instructionLines logged before
   * `openUrl`, #962/#974) closed "the requirement only appears in the
   * failure message" — but print-then-open-immediately left a live-witnessed
   * SEPARATE gap: *"the first instructions were so fast that I didn't notice
   * them at all."* Called ONCE per gate, with the role + gate label already
   * logged, immediately BEFORE `deps.openUrl` runs — see that call site.
   *
   * MUST resolve on its own under a headless run — this hook is the only
   * thing standing between "an unattended `--yes` run" and "a scripted run
   * that hangs forever on stdin" (coordination.md's "never hang an
   * unattended run"), so the production wiring
   * (`bootstrap-apply.ts::realWaitForOperatorBeat`) is unconditional-resolve
   * under `--yes` and a real blocking "press Enter" prompt only when
   * interactive. Optional; omitted (every pre-this-fix test, and any caller
   * that doesn't supply it) is a no-op — preserves the immediate-open
   * behavior exactly.
   */
  readonly waitForOperatorBeat?: (role: string, gateLabel: string) => Promise<void>;
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
   * Look for + decrypt a durable recovery artifact for this role, checked
   * ONCE on the CREATE path — BEFORE either the App-name-collision
   * pre-flight or consent gate 1 (macf#988, DR-043 Amendment B's consume
   * side; see this module's + `vault-write.ts`'s "Location, corrected" doc
   * sections). A resolved credential means gate 1 is skipped entirely —
   * this role already has a real GitHub App and its only credential copy
   * from a PRIOR run that crashed after gate 1 succeeded but before that
   * credential ever reached the vault — and the run resumes straight at
   * consent gate 2 with the recovered credentials (see
   * {@link finishGate2FromCredentials}). `undefined` (the RESOLVED value,
   * not the field itself) means "nothing usable this run": either no
   * artifact exists (the ordinary case), or one exists but couldn't be
   * consumed (no `--identity-key` supplied, wrong key, or a
   * malformed/corrupted file) — a real implementation logs WHY before
   * resolving `undefined` so the operator can tell "nothing to recover"
   * apart from "recovery was available but not applied." `undefined`/omitted
   * (every pre-#988 caller/test) preserves the pre-#988 behavior exactly —
   * always attempt gate 1 fresh, with the App-name-collision pre-flight as
   * the (weaker, refuse-only) backstop. Optional — fleet-level wiring
   * (`apply-fleet.ts`, mirroring `writeRecoveryArtifact`'s own wiring)
   * supplies the real implementation; this module only knows WHEN to call
   * it, not WHERE the artifact lives or how it's decrypted.
   */
  readonly findRecoveryArtifact?: (role: string) => Promise<AppCredentials | undefined>;
  /**
   * Post-install validation — called with the `ConfirmedInstall` just
   * observed PLUS the decryptable key path used to observe it (groundnuty/
   * macf#1012 added the `keyPath` param; originally install-only, macf#943),
   * BEFORE this module reports `'created'`/`'resumed-install'`/`'reused'`.
   * Called on EVERY path that resolves a `ConfirmedInstall` — the CREATE
   * path, `resume-install` (both via `runGate2`), AND `reuse-confirmed`
   * (an already-provisioned role re-confirmed live on a re-run — see
   * `applyIdentity`'s `decision.action === 'reuse-confirmed'` branch). May
   * return synchronously OR a `Promise` — `runGate2`/`applyIdentity` always
   * `await` the result, so a plain sync return (every pre-#1012 caller)
   * resolves immediately with no behavior change. Returns a rejection
   * reason string to fail the identity apply, `undefined` to accept.
   * `undefined`/omitted (every ordinary agent's deps pre-#1012) preserves
   * the pre-#943 behavior exactly — a confirmed install is always
   * sufficient. Two callers supply this today: the runner-ops
   * (`apply-runner-ops.ts::validateRunnerOpsInstall`, asserting
   * `repositorySelection === 'selected'` — GitHub's App-manifest flow has no
   * field to FORCE the install-time repo scope at creation, so this is the
   * verify-then-refuse enforcement point; see that module's doc) and, when
   * `registry.type === 'repo'`, every ordinary agent (`apply-fleet.ts`
   * wiring `registry-repo-coverage.ts::buildRegistryRepoValidateInstall` —
   * verifies the registry repo is actually reachable by this App's
   * installation; see that module's doc). A rejection here does NOT delete
   * the App or the install — same "GitHub App-name uniqueness is the retry
   * safety net" posture the rest of this module's gate-2 failures already
   * rely on (module doc's "gate 1→2 window" section).
   */
  readonly validateInstall?: (install: ConfirmedInstall, keyPath: string) => InstallRejection | undefined | Promise<InstallRejection | undefined>;
  /**
   * Post-REUSE validation (groundnuty/macf#1012) — SEPARATE from
   * {@link validateInstall} on purpose, checked in
   * `applyIdentity`'s `decision.action === 'reuse-confirmed'` branch only.
   * `validateInstall` is invoked for the runner-ops (`apply-runner-ops.ts::
   * validateRunnerOpsInstall`) on the CREATE/`resume-install` paths (via
   * `runGate2`) — reusing that SAME hook for `reuse-confirmed` too would
   * have silently started re-checking `repository_selection` on every
   * runner-ops REUSE, a behavior change for an EXISTING caller this issue
   * never asked for (confirmed empirically: doing so broke 6 unrelated
   * `apply-fleet`/`bootstrap-apply` tests whose fixtures never populate
   * `repositorySelection` on a reuse-confirmed install, because nothing
   * checked it there before). A dedicated field means a caller opts a
   * ROLE's REUSE path in explicitly (today: only the registry-repo-coverage
   * check, `apply-fleet.ts` wiring `registry-repo-coverage.ts::
   * buildRegistryRepoValidateInstall` onto BOTH `validateInstall` AND this
   * field for ordinary agents when `registry.type === 'repo'`) rather than
   * inheriting it implicitly. `undefined`/omitted (every pre-#1012 caller,
   * and the runner-ops today) means reuse is never re-validated — preserves
   * pre-#1012 behavior exactly.
   */
  readonly validateReuse?: (install: ConfirmedInstall, keyPath: string) => InstallRejection | undefined | Promise<InstallRejection | undefined>;
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
  /**
   * Whether a RECOVERABLE consent-gate-2 rejection (a `validateInstall` /
   * `validateReuse` rejection — see those fields' docs) re-opens the SAME
   * install page and re-checks, instead of failing on the first rejection
   * (groundnuty/macf#1063 — the operator's own words: *"it has to have a
   * verify step, and then report to the user that he made a mistake and
   * tell him to redo it, and present him with the dialogue again"*).
   * Bounded to {@link MAX_GATE2_REOPEN_ATTEMPTS} re-opens, then fails with
   * the full explanation — see {@link retryRecoverableGate2Rejection}.
   *
   * **Recoverable vs not (macf#1063 requirement 4) is decided structurally,
   * not by inspecting the rejection message.** By the time `validateInstall`
   * / `validateReuse` is ever CALLED, gate 1 has already succeeded (or an
   * existing install has already been CONFIRMED live) — the App, its key,
   * and the fact that some install exists are already good. A rejection
   * from one of those two hooks is therefore, by construction, an
   * install-SCOPE problem only (missing repo, "All repositories" instead of
   * "Only select") — fixable by revisiting the SAME page. A wrong App, a
   * revoked key, or a non-200/404 read failure never reach this flag at
   * all: those resolve to `unconfirmable` / `skip-unverified` / `drift` /
   * a gate-1 failure, all BEFORE either hook is ever called — untouched by
   * this retry, exactly as before #1063.
   *
   * **Only ever `true` for an INTERACTIVE run.** `bootstrap-apply.ts`'s
   * production wiring derives it from the SAME `assumeYes` that already
   * gates `waitForOperatorBeat`'s prompt-vs-no-op split (`assumeYes !==
   * true`) — a closure-SELECTION at `resolveMutateDeps` call time, never a
   * runtime branch inside a shared closure (mirrors `realWaitForOperatorBeat`'s
   * own doc on why that split lives there). An unattended `--yes` run must
   * verify once, refuse, and exit — EXACTLY as before this issue — never
   * reopen a browser with nobody there to click it (macf#1038's same
   * constraint). `undefined`/omitted (every pre-#1063 caller/test, and
   * every `--yes` run) preserves the exact pre-#1063 behavior: one check,
   * then fail.
   */
  readonly allowInstallRetry?: boolean;
  /**
   * Blocks a gate-2 RETRY (never the first, normal attempt) between the
   * browser opening and the re-check that follows (groundnuty/macf#1063) —
   * the operator's own genuine window to go fix the install and come back,
   * distinct from {@link waitForOperatorBeat} (which only guarantees the
   * INSTRUCTIONS were read before the browser took focus, not that the fix
   * was made). Needed because on a retry the App is ALREADY installed —
   * that is WHY the rejection was recoverable — so `waitForAppInstallation`'s
   * poll resolves on its very first check with no wait at all; without this
   * hook, `validate` would re-run before the operator could possibly have
   * acted, burning the whole retry budget in milliseconds (see
   * `runGate2WithInterstitial`'s `postOpenWait` doc for the mechanics).
   *
   * Same closure-SELECTION-not-runtime-branch + never-hangs-under-`--yes`
   * contract as `waitForOperatorBeat` (`bootstrap-apply.ts`'s production
   * wiring pairs the two, both derived from the SAME `assumeYes`) — moot
   * under `--yes` in practice, since `allowInstallRetry` is never `true`
   * there either, so this is never even called. `undefined`/omitted
   * (every pre-#1063 caller/test) is a safe no-op — `runGate2WithInterstitial`
   * only calls it when `retryRecoverableGate2Rejection` explicitly supplies
   * `postOpenWait`, and that closure treats a missing hook as "proceed
   * immediately" rather than hanging.
   */
  readonly waitForOperatorFix?: (role: string, gateLabel: string) => Promise<void>;
}

/**
 * The real dependency set for every gate primitive EXCEPT
 * `writeRecoveryArtifact` — that one needs fleet-level context (the
 * manifest's age recipients + the manifest path) this function doesn't
 * have, so `apply-fleet.ts` supplies it (see that module's doc). The return
 * type reflects the omission explicitly rather than stubbing a fake writer
 * here that would just be thrown away.
 *
 * `waitForOperatorBeat` (groundnuty/macf#952 follow-up) is a THIRD, optional,
 * trailing parameter — appended last so every pre-this-fix positional call
 * site keeps compiling unchanged, same convention `resolveMutateDeps`'s own
 * trailing optional params already establish. Omitted entirely (not merely
 * `undefined`) when the caller doesn't pass one, so `AgentApplyDeps`'s own
 * "omitted is a no-op" default applies — never silently overridden to a
 * no-op function this call site would own.
 */
export function realAgentApplyDeps(
  openUrl: (url: string) => Promise<void>,
  log: (line: string) => void,
  waitForOperatorBeat?: (role: string, gateLabel: string) => Promise<void>,
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
    ...(waitForOperatorBeat !== undefined ? { waitForOperatorBeat } : {}),
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
 *
 * `deps.waitForOperatorBeat` (groundnuty/macf#952 follow-up) runs AFTER every
 * line above is logged and BEFORE `deps.openUrl` — the same "before, never
 * after" ordering `instructionLines` already established, extended from "the
 * text exists in the transcript" to "the operator had a beat to read it
 * before the browser took focus." See that field's own doc on `AgentApplyDeps`
 * for why the production wiring never blocks a headless run.
 */
async function announceAndOpenGate(
  deps: Pick<AgentApplyDeps, 'log' | 'openUrl' | 'waitForOperatorBeat'>,
  role: string,
  gateLabel: string,
  url: string,
  waitLabel: string,
  opts: { readonly fatal: boolean; readonly caveat?: string; readonly instructionLines?: readonly string[]; readonly repoNames?: readonly string[] },
): Promise<void> {
  const caveatSuffix = opts.caveat !== undefined ? ` ${opts.caveat}` : '';
  for (const line of opts.instructionLines ?? []) {
    deps.log(`Role "${role}": ${line}`);
  }
  // groundnuty/macf#1176 — the copyable payload, printed as its OWN block:
  // a lead-in sentence (prefixed like every other instruction line) then
  // the bare names UNPREFIXED and indented — "nothing but the names,
  // directly copyable, nothing to trim" holds for the indented lines
  // themselves, not for the sentence introducing them. Mirrors
  // `manifest-flow-server.ts::renderCopyableRepoBlock`'s browser rendering
  // — same content, different wrapper (indentation vs `<pre>`).
  if (opts.repoNames !== undefined && opts.repoNames.length > 0) {
    deps.log(`Role "${role}": repositories to select (copy exactly, one per line):`);
    for (const name of opts.repoNames) {
      deps.log(`    ${name}`);
    }
  }
  deps.log(
    `Role "${role}": ${gateLabel} — opening this URL in your browser now (if it didn't open, open it yourself): ` +
      `${url}${caveatSuffix}`,
  );
  await deps.waitForOperatorBeat?.(role, gateLabel);
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
  /**
   * Overrides {@link installReposForIdentity}'s derived install-repo list
   * (groundnuty/macf#1074). `undefined` (every agent, and `runner-ops`)
   * keeps the derived behavior byte-identical — this field exists for the
   * router App specifically, whose correct install target is the fleet's
   * REGISTRY (`apply-router-app.ts::routerAppInstallRepos`), not any
   * agent's repo; `installReposForIdentity`'s generic "no declared-agent
   * match → every agent repo" fallback would be wrong for it (and, for a
   * `profile`-scoped registry, would miss the actual target entirely — the
   * registry can live at a repo that is none of the fleet's agents' repos).
   * An empty array is a valid, honest override (e.g. `registry.type ===
   * 'local'`, which has no GitHub App surface at all) — `applyIdentity`
   * does not special-case it further than gate 2's interstitial listing
   * zero repos, which the confirm-before-create/install-flow machinery
   * already tolerates the way it tolerates any other repo list.
   */
  readonly installRepos?: readonly string[];
  /**
   * Overrides the derived App handle (groundnuty/macf#1082) — `undefined`
   * (every agent, `runner-ops`, and the router App's PER-FLEET scope) keeps
   * `deriveAppHandle(manifest.metadata.name, role)`, byte-identical to
   * before this field existed. The router App's SHARED scope is the one
   * caller that supplies this: its handle must NOT be fleet-prefixed (a
   * fixed, cross-fleet-recognizable name is the whole point of "shared" —
   * see `apply-router-app.ts`'s module doc), and `deriveAppHandle` cannot
   * produce that (it always prepends `manifest.metadata.name`). Threaded
   * into every place `applyIdentity` would otherwise derive the handle
   * itself: the confirm-before-create guard's `expected.appSlug`, the
   * App-name-collision pre-flight, the submitted manifest's `name`
   * (`buildAppManifest`'s `nameOverride`), and every install/settings URL.
   */
  readonly handleOverride?: string;
}

/**
 * Which declared-agent identities the registry-repo-coverage requirement
 * applies to (groundnuty/macf#1156) — `role` matches a declared
 * `manifest.agents[].role` (every ordinary coordination agent). The
 * runner-ops fallback (`role` with no match) is deliberately EXCLUDED: it
 * never touches the registry (`apply-fleet.ts`'s own per-agent-loop doc:
 * "never the runner-ops, below — it never touches the registry"), so
 * folding the control repo into ITS install list would grant access this
 * identity structurally never uses — the same over-broad-scope reasoning
 * `installWhyText` already applies to `administration: write`.
 */
function registryControlRepoFor(role: string, manifest: FleetManifest): string | undefined {
  const isOrdinaryAgent = manifest.agents.some((a) => a.role === role);
  if (!isOrdinaryAgent) return undefined;
  const coverage = requiredRegistryRepoCoverage(manifest);
  return coverage === undefined ? undefined : `${coverage.owner}/${coverage.repo}`;
}

/**
 * The EXACT repos consent gate 2's interstitial names for this identity
 * (groundnuty/macf#952) — derived from the manifest, never a hand-maintained
 * parallel list. A `role` that matches a declared `manifest.agents[].role`
 * (every ordinary coordination agent) is scoped to its OWN home repo —
 * `FleetAgentSchema` already enforces one repo per role (`fleet-manifest.ts`'s
 * "every agent needs its own home repo" uniqueness check) — PLUS the fleet's
 * control repo when `registry.type === 'repo'` (groundnuty/macf#1156, below).
 * A `role` with NO match (today, only the runner-ops — `RUNNER_OPS_ROLE` is
 * deliberately never declared in `fleet.yaml`'s `agents[]`, per
 * `apply-runner-ops.ts`'s doc) needs to mint runner-registration tokens for
 * ANY of the fleet's repos, so every declared agent's repo is listed — this
 * branch is UNCHANGED by #1156 (see {@link registryControlRepoFor}'s doc for
 * why the runner-ops is excluded from the control-repo addition).
 *
 * **groundnuty/macf#1156 — the control-repo fold-in.** `#1012`/`#1015`
 * require every ordinary agent App's installation to ALSO cover the
 * registry repo when `registry.type === 'repo'` — a LIVE fact
 * `registry-repo-coverage.ts`'s `buildRegistryRepoValidateInstall` verifies
 * post-gate-2 and REFUSES on. Before this fix, this function never
 * consulted `registry` at all: the gate-2 instruction (and the
 * `--dry-run`/pre-approval preview, `bootstrap-apply.ts::plannedAppCreations`
 * — which calls this SAME function) told the operator to select exactly one
 * repo, the operator did, and the coverage check then correctly refused the
 * result — the live incident this issue reports. `requiredRegistryRepoCoverage`
 * (`registry-repo-coverage.ts`) is the SAME derivation `apply-fleet.ts`'s
 * per-agent loop reads to build the live check itself — one function, so
 * the instruction an operator follows and the check that verifies it cannot
 * independently drift (the `#1136` precedent this issue cites). `own.includes`
 * guards the pathological case where an agent's home repo IS the control
 * repo — no duplicate entry.
 */
export function installReposForIdentity(role: string, manifest: FleetManifest): readonly string[] {
  const match = manifest.agents.find((a) => a.role === role);
  if (match === undefined) return manifest.agents.map((a) => a.repo);
  const own = [match.repo];
  const controlRepo = registryControlRepoFor(role, manifest);
  return controlRepo === undefined || own.includes(controlRepo) ? own : [...own, controlRepo];
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
 *
 * `registryControlRepo` (groundnuty/macf#1156), when given, appends a
 * ONE-CLAUSE reason for the extra repo `installReposForIdentity` folded in —
 * "an operator who understands *why* will not mis-fix it later" (the
 * issue's own acceptance criterion). `undefined` (every call site except
 * `applyIdentity`'s ordinary-agent branch when the registry is repo-scoped)
 * keeps this function's return byte-identical to before this parameter
 * existed.
 */
export function installWhyText(permissions: Readonly<Record<string, string>> | undefined, registryControlRepo?: string): string {
  const base =
    permissions?.['administration'] === 'write'
      ? 'Why: this App holds administration:write; granting it every repository in the account is blast radius ' +
        'the fleet does not need, and apply will refuse an "all" install.'
      : 'Why: this App only needs access to the repo(s) listed above — granting every repository in the account is ' +
        'broader access than this identity uses.';
  if (registryControlRepo === undefined) return base;
  return `${base} ${registryControlRepo} is included because this App must read the fleet registry.`;
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
  // groundnuty/macf#1082 — `request.handleOverride` wins outright when
  // supplied (the router App's SHARED scope; see `IdentityRequest.
  // handleOverride`'s doc). Every other caller keeps the derived handle,
  // byte-identical to before this field existed.
  const handle = request.handleOverride ?? deriveAppHandle(manifest.metadata.name, role);
  // Best-known slug for a PRE-EXISTING App is the derived handle — a prior
  // successful gate 1 submitted `buildAppManifest`'s `name` field, which IS
  // deriveAppHandle's output (barring a rare GitHub collision-suffix — the
  // same caveat `app-manifest.ts`'s `PlannedAppCreation.installUrl` doc
  // flags for the dry-run preview).
  const guardExpected: ExpectedIdentity = { appSlug: handle, accountLogin: manifest.owner.account };
  // groundnuty/macf#952 — computed ONCE, valid on EITHER gate-2 path (create
  // or resume-install): both derive from `request`/`manifest`, neither from
  // anything gate 1 produces. groundnuty/macf#1074 —
  // `request.installRepos`, when supplied, wins outright (see
  // `IdentityRequest.installRepos`'s doc for why the router App needs this).
  const repos = request.installRepos ?? installReposForIdentity(role, manifest);
  // groundnuty/macf#1156 — the one-clause "why" for the control repo ONLY
  // when `installReposForIdentity`'s OWN derivation (not an
  // `installRepos` override — the router App's override already targets
  // the registry directly, for a different reason `installWhyText`'s doc
  // doesn't need to restate) actually folded it in.
  const registryControlRepo = request.installRepos === undefined ? registryControlRepoFor(role, manifest) : undefined;
  const whyText = installWhyText(request.permissions, registryControlRepo);

  let decision: CreateGuardDecision;
  try {
    decision = await confirmBeforeCreateGuard(role, prior, guardExpected, deps);
  } catch (err) {
    return { role, status: 'failed', reason: `confirm-before-create guard threw: ${errMessage(err)}` };
  }

  if (decision.action === 'reuse-confirmed') {
    // groundnuty/macf#1012 — `validateReuse` (DELIBERATELY separate from
    // `validateInstall` — see that field's doc for why sharing one hook
    // would have silently widened the runner-ops's `repository_selection`
    // check onto every reuse, a behavior change for an existing caller this
    // issue never asked for). An already-provisioned role re-confirmed on a
    // re-run is exactly the shape a registry-repo-coverage regression would
    // otherwise hit silently — the fleet was already `reused`, never
    // touching `runGate2` again.
    const rejection = await deps.validateReuse?.(decision.install, decision.keyPath);
    if (rejection !== undefined) {
      const { message, retryInstruction, missingRepos } = rejectionParts(rejection);
      deps.log(`Role "${role}": REFUSED on reuse — ${message}`);
      // groundnuty/macf#1063 — the ONE edge back to the gate this issue adds.
      // Pre-#1063 this branch `return`ed here unconditionally (the module
      // doc's own words: "never touching `runGate2` again") — a role that
      // was ALREADY provisioned, re-confirmed live on THIS run, but whose
      // install scope has drifted (or was wrong from the start) had no path
      // back to consent gate 2 short of a full manual re-provision. Retrying
      // re-runs the SAME gate-2 UX (`runGate2WithInterstitial`, never a
      // second gate path) with `deps.validateReuse` itself as the
      // re-check — not `validateInstall` — so a caller that wires the two
      // hooks differently (today none do; `apply-fleet.ts` wires both to the
      // SAME closure) still gets re-verified against the check that
      // actually rejected it.
      const retried = await retryRecoverableGate2Rejection(
        role,
        decision.install.appId,
        decision.keyPath,
        guardExpected,
        handle,
        appInstallationUrl(handle),
        repos,
        whyText,
        deps,
        {
          role,
          status: 'failed',
          reason: `existing install re-verification rejected: ${message}`,
          recoverable: true,
          ...(retryInstruction !== undefined ? { retryInstruction } : {}),
          ...(missingRepos !== undefined ? { missingRepos } : {}),
        },
        deps.validateReuse,
      );
      if (retried.status === 'resumed-install') {
        // Nothing was minted this run (no gate 1, no new credential) —
        // 'reused' is the honest status for "the install is confirmed good
        // NOW," matching what this branch would have reported had the
        // operator's FIRST click already been correct.
        deps.log(`Role "${role}": install corrected on retry (app_id ${decision.install.appId}) — treated as reused.`);
        return { role, status: 'reused', appId: decision.install.appId, installId: retried.installId };
      }
      return { role, status: 'failed', reason: retried.reason };
    }
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
    const resumeCaveat = {
      caveat:
        '(URL predicted from the fleet/role naming convention — no GitHub-confirmed slug is available on this ' +
        'path; if it 404s, find the App via Settings → Developer settings → GitHub Apps instead.)',
    };
    const firstAttempt = await runGate2WithInterstitial(role, decision.appId, decision.keyPath, guardExpected, handle, appInstallationUrl(handle), repos, whyText, deps, resumeCaveat);
    // groundnuty/macf#1063 — no-op unless `firstAttempt` is a recoverable
    // `validateInstall` rejection AND `deps.allowInstallRetry` is set (see
    // `retryRecoverableGate2Rejection`'s doc); every pre-#1063 outcome shape
    // (success, a `waitForAppInstallation` throw, an unwired validateInstall)
    // returns `firstAttempt` unchanged on the FIRST loop check.
    return retryRecoverableGate2Rejection(role, decision.appId, decision.keyPath, guardExpected, handle, appInstallationUrl(handle), repos, whyText, deps, firstAttempt);
  }

  // macf#988 (DR-043 Amendment B consume side) — checked BEFORE either the
  // App-name-collision pre-flight or gate 1: a role whose App already
  // exists on GitHub but crashed before its credential reached the vault
  // (this is the EXACT trace macf#988 reproduced: "REFUSED before consent
  // gate 1 — App … already exists but is not in this fleet's vault") may
  // have left a durable recovery artifact behind. Finding one here answers
  // the collision question implicitly (the App exists AND we hold its only
  // credential copy) and turns today's refusal into automatic resume —
  // exactly the point of writing the artifact durably in the first place.
  if (deps.findRecoveryArtifact) {
    let recovered: AppCredentials | undefined;
    try {
      recovered = await deps.findRecoveryArtifact(role);
    } catch (err) {
      // Fail-open, same posture `checkAppNameCollision`'s own catch below
      // takes — a throwing dep is inconclusive, never a refusal; GitHub's
      // own App-name uniqueness remains the backstop either way.
      deps.log(
        `Role "${role}": recovery-artifact check failed (${errMessage(err)}) — proceeding as a normal create; ` +
          "GitHub's own App-name uniqueness remains the backstop.",
      );
      recovered = undefined;
    }
    if (recovered !== undefined) {
      deps.log(
        `Role "${role}": recovered credentials from a durable recovery artifact (app_id ${recovered.appId}, ` +
          `handle "${recovered.name}") — resuming at consent gate 2 instead of re-creating.`,
      );
      return finishGate2FromCredentials(role, recovered, manifest, repos, whyText, deps, true);
    }
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
          nameOverride: request.handleOverride,
        }),
      formAction: manifestFormAction(manifest.owner),
      timeoutMs: deps.gateTimeoutMs,
      role,
    });
    try {
      // groundnuty/macf#971 — the explanation lives HERE, not on the served
      // page: that page's own `<script>` submits it before a human can read
      // it (the operator, live: "if I cannot see them, I'm not sure why they
      // are there"). `announceAndOpenGate` prints every `instructionLines`
      // entry BEFORE `deps.openUrl` runs (see its doc), so this is the first
      // and only readable copy of the explanation, regardless of whether the
      // browser opens, a human is watching, or this is a headless `--yes` run.
      await announceAndOpenGate(deps, role, `consent gate 1 of ${String(GATE_TOTAL)} (App-manifest form)`, flow.startUrl, 'Create GitHub App', {
        fatal: true,
        instructionLines: [
          `creating GitHub App "${handle}" — its settings (permissions, webhook events) come from the fleet ` +
            'manifest and are submitted AS-IS; there is nothing for you to review or edit.',
          'the browser tab opening next will submit automatically and land on GitHub\'s own confirmation page — ' +
            'click "Create GitHub App" there to finish.',
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
  return finishGate2FromCredentials(role, creds, manifest, repos, whyText, deps, false);
}

/**
 * groundnuty/macf#1137 — the pre-gate-2 observation for a RECOVERED
 * credential ({@link finishGate2FromCredentials}'s `viaRecovery: true`
 * caller only — see that function's call site). A credential recovered
 * from a durable artifact resumes a PRIOR run's gate 1; by construction
 * THIS run's `fleet.lock`/vault never recorded the role (that absence is
 * exactly why `applyIdentity`'s `findRecoveryArtifact` branch fired at
 * all), but the INSTALL itself may already be confirmed on GitHub from
 * that prior run. Opening gate 2 to ask the operator to click "Install"
 * for an App that is already installed spends the tool's most expensive
 * ask (DR-044) on work that is already done — the only work actually
 * remaining is the vault write `apply-fleet.ts` performs with this
 * function's returned `credentials`.
 *
 * Reuses `deps.confirmAppInstallation` — the SAME install-confirm
 * primitive `confirmBeforeCreateGuard` above already calls for a role WITH
 * a prior `fleet.lock` entry — rather than adding a second implementation
 * of "does this App already have a confirmed install" (the drift class
 * `install-scope.ts`'s module doc catalogs: independently-maintained
 * copies of the same GitHub-observation drifting apart). Unlike the
 * org-owner-scoped `GET /orgs/{org}/installations` listing
 * (`app-presence.ts`/`observer.ts`'s `listOrgInstallRepositorySelections`,
 * used by `plan`'s fleet-wide drift scan), this primitive mints a JWT from
 * the App's OWN key and asks `GET /app/installations` — authoritative for
 * "is THIS App installed" regardless of org ownership, and it already
 * carries `repositorySelection` for {@link AgentApplyDeps.validateInstall}
 * to re-check, so one call answers both "does it exist" and "is it
 * correctly scoped."
 *
 * Returns `{ action: 'skip-gate-2' }` (skip gate 2 entirely) ONLY when
 * GitHub confirms the install exists AND `deps.validateInstall` accepts it;
 * `{ action: 'open-gate-2' }` (fall through to the normal gate-2 flow)
 * otherwise:
 *
 *   - `app-no-install` / `installed-unexpected-target` — the install
 *     genuinely isn't there (yet, or not where expected). Gate opens,
 *     exactly as before this fix, with `rejection: undefined` — nothing was
 *     learned about which repos are covered, so there is nothing to derive
 *     a resumed-gate instruction from (honest-unknown floor, groundnuty/
 *     macf#1160).
 *   - `unconfirmable` — the credential could not observe the install THIS
 *     TIME (JWT-mint failure, 401, network, timeout). DR-043 Amendment A's
 *     honest-unknown floor: never read as "absent," so the gate still
 *     opens (`rejection: undefined`, same reasoning as above) — but
 *     `deps.log` states WHY it couldn't skip, rather than silently gating
 *     with no explanation.
 *   - `confirmed` but `deps.validateInstall` rejects (wrong repo scope,
 *     unreachable registry repo) — never silently accepted as "already
 *     done" (this must not weaken the `install-scope.ts` refusal). The
 *     normal gate-2 flow re-observes the SAME confirmed install almost
 *     immediately (the poll's first check) and reports the identical
 *     rejection through the established `allowInstallRetry` reopen loop —
 *     no new failure handling invented here. **groundnuty/macf#1160:** the
 *     REJECTION itself is now returned (`{ action: 'open-gate-2', rejection
 *     }`) rather than discarded — this is the "resumed" gate's own
 *     already-computed observation of what's missing (never a second
 *     query); {@link finishGate2FromCredentials} uses it to instruct the
 *     operator to add only what this check found missing, instead of
 *     restating the FULL required set as if nothing had been done yet.
 *   - A throwing `deps.confirmAppInstallation` is fail-open (inconclusive,
 *     never a silent skip) — same posture `checkAppNameCollision`'s own
 *     catch takes just above in {@link applyIdentity}. `rejection:
 *     undefined` — the throw means nothing was observed.
 */
type Gate2PreflightResult =
  | { readonly action: 'skip-gate-2'; readonly outcome: AgentApplyOutcome }
  /**
   * `rejection` (groundnuty/macf#1160) carries whatever
   * `deps.validateInstall` ALREADY returned during this pre-flight, when it
   * did — `undefined` when the confirmed-install check never ran at all
   * (no confirmed install to check, or the confirm itself threw/couldn't
   * observe). {@link finishGate2FromCredentials} is the ONLY consumer; it
   * never re-queries to fill this in — the honest-unknown floor for this
   * field is "no resumed-gate instruction," not "guess one."
   */
  | { readonly action: 'open-gate-2'; readonly rejection: InstallRejection | undefined };

async function skipGate2IfAlreadyInstalled(
  role: string,
  creds: AppCredentials,
  expected: ExpectedIdentity,
  pemPath: string,
  deps: AgentApplyDeps,
): Promise<Gate2PreflightResult> {
  let confirmation: IdentityConfirmation;
  try {
    confirmation = await deps.confirmAppInstallation(creds.appId, pemPath, expected);
  } catch (err) {
    deps.log(
      `Role "${role}": pre-gate-2 install check threw (${errMessage(err)}) — cannot confirm whether the install ` +
        'already exists; opening consent gate 2 to be safe.',
    );
    return { action: 'open-gate-2', rejection: undefined };
  }
  if (confirmation.status === 'unconfirmable') {
    deps.log(
      `Role "${role}": could not confirm whether the install already exists (GitHub was never successfully asked — ` +
        'JWT mint failure, 401, network, or timeout) — opening consent gate 2 to be safe.',
    );
    return { action: 'open-gate-2', rejection: undefined };
  }
  // app-no-install / installed-unexpected-target — genuinely needs the gate; nothing about repo coverage was learned.
  if (confirmation.status !== 'confirmed') return { action: 'open-gate-2', rejection: undefined };

  const rejection = await deps.validateInstall?.(confirmation.install, pemPath);
  // exists, but scope/coverage is wrong — real work remains; let the normal
  // gate-2 flow handle it, carrying the rejection forward (groundnuty/macf#1160)
  // instead of discarding what this check just learned.
  if (rejection !== undefined) return { action: 'open-gate-2', rejection };

  deps.log(
    `Role "${role}": install already confirmed on GitHub (install_id ${confirmation.install.installId}) — skipping ` +
      "consent gate 2. This fleet's vault never recorded this role's install (that mismatch is why the recovery " +
      'path resumed here) — a vault/GitHub drift worth reconciling.',
  );
  return {
    action: 'skip-gate-2',
    outcome: { role, status: 'created', appId: creds.appId, installId: confirmation.install.installId, credentials: creds },
  };
}

/**
 * The RESUMED-gate instruction (groundnuty/macf#1160) — an install for this
 * App already exists (confirmed live by {@link skipGate2IfAlreadyInstalled}
 * just above), but the SAME pre-gate-2 check found it insufficient. Reuses
 * that check's OWN `message`/`retryInstruction` — never re-derives the
 * required set from the manifest, never issues a second query — so the
 * operator is told to add only what THIS check found missing, instead of
 * `runGate2WithInterstitial`'s default "select exactly: <every required
 * repo>" (which restates repos the operator may already have selected on an
 * earlier run — the live incident this issue reports). A bare-string
 * rejection (no `retryInstruction` — e.g. `install-scope.ts`'s scope-only
 * check, which has no single "missing repo" to name) falls back to its own
 * `message`; still strictly better than the prior full-list text, which
 * never mentioned the scope problem at all.
 * Also used (groundnuty/macf#1175) as the terminal-only explanation printed
 * directly by {@link resumeGate2Preflight} when the resumed gate refuses
 * WITHOUT opening a page — see that function's doc for why the same two
 * sentences now reach the operator via `deps.log` rather than via
 * `runGate2WithInterstitial`'s `instructionLines`.
 */
function gate2ResumedInstructionLines(rejection: InstallRejection): readonly string[] {
  const { message, retryInstruction } = rejectionParts(rejection);
  return [
    "this App's install already exists from an earlier run — resuming, not starting over.",
    retryInstruction ?? message,
  ];
}

/**
 * groundnuty/macf#1160 — the `viaRecovery` half of {@link finishGate2FromCredentials},
 * split out purely to keep that function's own body scannable (same
 * reasoning `runGate2` was already extracted for). `viaRecovery: false`
 * (the fresh-mint path) never even calls {@link skipGate2IfAlreadyInstalled}
 * — same as before this issue — and always resolves `{}`, the ordinary
 * full-list first attempt.
 *
 * On `viaRecovery: true`, resolves ONE of three shapes:
 *   - `earlyOutcome` set — the pre-flight found an already-good install;
 *     `finishGate2FromCredentials` returns it, skipping gate 2 entirely
 *     (unchanged from groundnuty/macf#1137).
 *   - `reopenRecoverable` set — groundnuty/macf#1175: the pre-flight found
 *     an install that already exists but is INSUFFICIENT (the SAME
 *     already-computed rejection {@link gate2ResumedInstructionLines} used
 *     to narrate). **This is the fix for #1175's live bug.** The pre-#1175
 *     code passed this case to `runGate2WithInterstitial` as an ordinary
 *     "first attempt" — which opens a page, prints "waiting for you to
 *     click Install," and then polls `waitForAppInstallation`. But that
 *     poll checks immediately and returns on the FIRST call once ANY
 *     confirmed install exists on the expected target
 *     (`identity-confirm.ts::waitForAppInstallation`) — repo-scope is a
 *     SEPARATE check this function's caller runs after. Since the install
 *     already exists (that is WHY the pre-flight ran at all), the poll
 *     resolves instantly, `validateInstall` re-runs against the SAME
 *     unchanged install, and rejects again — all before the operator could
 *     read the page, let alone act on it (three live reproductions; see
 *     the issue). There is no new event for a wait to be waiting FOR: the
 *     install won't change until the operator edits it, and nothing this
 *     process does can make that happen sooner.
 *
 *     Two honest responses existed: (a) poll installation CONTENTS for a
 *     CHANGE instead of mere existence, or (b) admit there is nothing to
 *     wait for right now and ask the operator to fix it outside this run.
 *     (a) needs its own timeout budget and risks an unattended run hanging
 *     on a fix that may never come; (b) cannot hang, is exactly as
 *     actionable (the fix instruction is identical either way), and is the
 *     SAME shape this module already uses for the `reuse-confirmed` +
 *     `validateReuse`-rejects path (`applyIdentity`'s `decision.action ===
 *     'reuse-confirmed'` branch, just above `runGate2WithInterstitial`'s
 *     own doc) — that branch ALSO builds a `recoverable: true` outcome by
 *     hand and hands it straight to {@link retryRecoverableGate2Rejection}
 *     WITHOUT a first "blind" gate-2 attempt. This function takes (b), for
 *     consistency with that established pattern: `finishGate2FromCredentials`
 *     feeds `reopenRecoverable` straight into
 *     {@link retryRecoverableGate2Rejection} as the STARTING outcome,
 *     skipping `runGate2WithInterstitial`'s "first attempt" entirely. In
 *     the default (unattended / `--yes`) posture — `deps.allowInstallRetry`
 *     unset — that retry loop is itself a no-op (its own doc), so NO page
 *     opens and NO "waiting for you to click" is ever printed for a wait
 *     that cannot happen: the operator gets an immediate, honest refusal
 *     naming what to fix, via `deps.log` (mirrored below) AND the final
 *     `AgentApplyOutcome.reason`. When an operator HAS opted into
 *     interactive retries (`allowInstallRetry` + `waitForOperatorFix`), the
 *     SAME retry loop reopens the page with a genuine post-open wait — the
 *     tool this module already has for "let the operator act, then
 *     re-check," reused rather than duplicated.
 *   - neither set — the pre-flight learned nothing (no confirmed install to
 *     check, or the confirm itself couldn't observe one) — the ordinary
 *     full-list attempt, honest-unknown floor: no observation, no delta
 *     claim.
 */
async function resumeGate2Preflight(
  viaRecovery: boolean,
  role: string,
  creds: AppCredentials,
  expected: ExpectedIdentity,
  pemPath: string,
  deps: AgentApplyDeps,
): Promise<{ readonly earlyOutcome?: AgentApplyOutcome; readonly reopenRecoverable?: Gate2Outcome }> {
  if (!viaRecovery) return {};
  const preflight = await skipGate2IfAlreadyInstalled(role, creds, expected, pemPath, deps);
  if (preflight.action === 'skip-gate-2') return { earlyOutcome: preflight.outcome };
  if (preflight.rejection === undefined) return {};

  const { message, retryInstruction, missingRepos } = rejectionParts(preflight.rejection);
  for (const line of gate2ResumedInstructionLines(preflight.rejection)) {
    deps.log(`Role "${role}": ${line}`);
  }
  // groundnuty/macf#1175 — gated on `allowInstallRetry`, NOT unconditional.
  // When the operator has opted into interactive retries,
  // `retryRecoverableGate2Rejection` (fed `reopenRecoverable` below) DOES
  // reopen the page with a genuine `postOpenWait` — printing "not opening a
  // wait page … re-run apply" here unconditionally would then contradict
  // that page's own "Reopening the install page … I will re-check
  // automatically once you do" a few lines later in the SAME transcript
  // (the exact same-transcript-contradiction class groundnuty/macf#1165/
  // #1168 already fixed twice, applied to a new pair of lines). Only the
  // unattended (`allowInstallRetry` unset) posture is honest to say "not
  // waiting" — that is the ONLY posture where nothing further waits.
  if (deps.allowInstallRetry !== true) {
    deps.log(
      `Role "${role}": not opening a wait page for this — the install already exists, so a page claiming to ` +
        'wait would resolve on its very first check against the SAME insufficient install, before you could ' +
        `act on it. Make the change on GitHub (${appInstallationUrl(creds.slug)}), then re-run apply.`,
    );
  }
  return {
    reopenRecoverable: {
      role,
      status: 'failed',
      reason: `consent gate 2 (install) rejected: ${message}`,
      recoverable: true,
      ...(retryInstruction !== undefined ? { retryInstruction } : {}),
      ...(missingRepos !== undefined ? { missingRepos } : {}),
    },
  };
}

/**
 * Run (or resume) consent gate 2 for a role whose credential is ALREADY
 * known — either freshly minted via gate 1 moments ago, or recovered from a
 * durable artifact a PRIOR run's gate 1 left behind before it crashed
 * (macf#988, DR-043 Amendment B's consume side — see
 * {@link applyIdentity}'s `deps.findRecoveryArtifact` call site). Both
 * paths report the IDENTICAL `status: 'created'` shape — `apply-fleet.ts`'s
 * vault-fold logic only cares that credentials exist to fold in, never
 * which path produced them. `viaRecovery` changes the wording of a
 * gate-2-failure reason (naming the credential's origin for an operator
 * reading the transcript) AND, per groundnuty/macf#1137, runs
 * {@link skipGate2IfAlreadyInstalled} FIRST (through {@link resumeGate2Preflight},
 * groundnuty/macf#1160) — the fresh-mint path (`viaRecovery: false`) never
 * does, since an App gate 1 just created cannot already have an install.
 *
 * **Why the recovered path does NOT call `deps.writeRecoveryArtifact`
 * again:** `AgentApplyDeps.writeRecoveryArtifact`'s own doc says "called
 * EXACTLY once per CREATE path" — that invariant is about the FRESH-mint
 * path (this function's `viaRecovery: false` caller), where writing the
 * artifact IS what makes the just-exchanged credential durable. On the
 * recovered path the credential is ALREADY durable — it is, by
 * construction, the artifact `deps.findRecoveryArtifact` just read back —
 * so re-writing it would just re-encrypt the identical bytes to the same
 * path. Both paths still delete the SAME artifact once the credential
 * lands in the final vault (`apply-fleet.ts`'s `operatorRecoveryArtifactPath`
 * is deterministic in `(fleetName, role)`, independent of which path wrote
 * it), so the durable-before-gate-2 invariant holds either way.
 */
async function finishGate2FromCredentials(
  role: string,
  creds: AppCredentials,
  manifest: FleetManifest,
  repos: readonly string[],
  whyText: string,
  deps: AgentApplyDeps,
  viaRecovery: boolean,
): Promise<AgentApplyOutcome> {
  const gate2Expected: ExpectedIdentity = { appSlug: creds.slug, accountLogin: manifest.owner.account };
  const pemPath = writeScratchPem(role, creds.pem);
  try {
    const preflight = await resumeGate2Preflight(viaRecovery, role, creds, gate2Expected, pemPath, deps);
    if (preflight.earlyOutcome !== undefined) return preflight.earlyOutcome;
    // groundnuty/macf#1175 — `reopenRecoverable`, when set, is a
    // pre-flight-detected confirmed-but-insufficient install: skip the
    // "blind" first `runGate2WithInterstitial` attempt entirely (see
    // `resumeGate2Preflight`'s doc for why that attempt's wait cannot ever
    // actually wait here) and feed it straight to the SAME recoverable-
    // rejection retry every other path gets, below.
    const firstAttempt =
      preflight.reopenRecoverable ??
      (await runGate2WithInterstitial(role, creds.appId, pemPath, gate2Expected, creds.slug, appInstallationUrl(creds.slug), repos, whyText, deps, {}));
    // groundnuty/macf#1063 — the SAME recoverable-rejection retry the
    // resume-install path gets (see that call site's doc); a no-op unless
    // `firstAttempt` is a recoverable `validateInstall` rejection AND
    // `deps.allowInstallRetry` is set. `pemPath` stays alive across every
    // retry — it's cleaned up once, in this function's own `finally`, only
    // after the LAST attempt returns.
    const outcome = await retryRecoverableGate2Rejection(role, creds.appId, pemPath, gate2Expected, creds.slug, appInstallationUrl(creds.slug), repos, whyText, deps, firstAttempt);
    if (outcome.status === 'failed') {
      // Gate 1 succeeded but gate 2 didn't — see the module doc's "gate
      // 1→2 window" section. The App EXISTS on GitHub; give the operator a
      // direct, actionable recovery path rather than just "it failed."
      return {
        role,
        status: 'failed',
        reason:
          `${outcome.reason} — the App WAS created on GitHub (${viaRecovery ? 'recovered from a durable recovery artifact; ' : ''}app_id ${creds.appId}, handle "${creds.name}") but ` +
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
      `credential durability write failed BEFORE consent gate 2: ${errMessage(err)} — the App WAS ` +
      `created on GitHub (app_id ${creds.appId}, handle "${creds.name}") but its ONLY credential copy is process ` +
      'memory, about to be lost if this process exits. Refusing to proceed to gate 2 until the credential is ' +
      'durable. Fix the durability issue (recovery-artifact write target, disk space, missing age recipient) and ' +
      're-run — GitHub\'s own App-name uniqueness protects against a duplicate on retry.'
    );
  }
}

/**
 * The only two shapes `runGate2` itself produces — narrower than the full
 * {@link AgentApplyOutcome} union so callers can narrow on `status ===
 * 'failed'` without a cast. `recoverable` (groundnuty/macf#1063) is `true`
 * ONLY on the `validateInstall`/`validateReuse`-rejection branch of
 * {@link runGate2} — never on a `waitForAppInstallation` throw (a poll
 * timeout, a JWT/network failure) — see `AgentApplyDeps.allowInstallRetry`'s
 * doc for why that specific branch, and only that one, is treated as
 * fixable by revisiting the SAME install page.
 */
type Gate2Outcome =
  | { readonly role: string; readonly status: 'resumed-install'; readonly appId: string; readonly installId: string }
  | {
      readonly role: string;
      readonly status: 'failed';
      readonly reason: string;
      readonly recoverable?: boolean;
      /** The plain-language dialogue text (groundnuty/macf#1063) — see {@link InstallRejection}'s doc. Present only when the rejecting hook supplied one; the retry dialogue falls back to `reason` otherwise. */
      readonly retryInstruction?: string;
      /** The specific `owner/repo`(s) the rejecting hook found missing (groundnuty/macf#1176) — see {@link InstallRejection}'s doc. Present only when the rejecting hook supplied one; a retry-reopen's copyable repo block falls back to the identity's full required set otherwise. */
      readonly missingRepos?: readonly string[];
    };

/** The hook shape shared by `validateInstall`/`validateReuse` — {@link runGate2}'s `validate` param is typed against this rather than either field name so it can stand in for either. */
type ValidateInstallHook = (install: ConfirmedInstall, keyPath: string) => InstallRejection | undefined | Promise<InstallRejection | undefined>;

/**
 * Runs the gate-2 poll. Cleanup of `keyPath` (when it's a scratch file this
 * module owns) is the CALLER's job — see call sites.
 *
 * `validate` (groundnuty/macf#1063) defaults to `deps.validateInstall` —
 * every pre-#1063 call site omits it and gets EXACTLY the prior behavior.
 * {@link retryRecoverableGate2Rejection}'s reuse-confirmed retry passes
 * `deps.validateReuse` explicitly instead, so a re-check after reopening the
 * page re-runs the SAME hook that rejected in the first place, never
 * silently substituting `validateInstall` for a caller that (today,
 * theoretically) wires the two differently.
 */
async function runGate2(
  role: string,
  appId: string,
  keyPath: string,
  expected: ExpectedIdentity,
  deps: AgentApplyDeps,
  validate: ValidateInstallHook | undefined = deps.validateInstall,
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
    // runner-ops's repository_selection !== 'selected', or — macf#1012 —
    // the registry repo isn't reachable by this install). `await`ed
    // unconditionally: `validateInstall` may return sync or async (see its
    // doc), and `await` on a plain value resolves immediately.
    const rejection = await validate?.(install, keyPath);
    if (rejection !== undefined) {
      // groundnuty/macf#1063 — `recoverable: true` ONLY here: the App, its
      // key, and a live install are already confirmed good by this point;
      // what's wrong is scoped to install SCOPE, fixable by revisiting the
      // SAME page (see `AgentApplyDeps.allowInstallRetry`'s doc).
      const { message, retryInstruction, missingRepos } = rejectionParts(rejection);
      return {
        role,
        status: 'failed',
        reason: `consent gate 2 (install) rejected: ${message}`,
        recoverable: true,
        ...(retryInstruction !== undefined ? { retryInstruction } : {}),
        ...(missingRepos !== undefined ? { missingRepos } : {}),
      };
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

/**
 * The two repo-selection sentences — "choose Only select repositories" +
 * "select exactly: <repos>" — exported (groundnuty/macf#1173) so this is
 * the ONE authored copy for every surface that says it, not just the live
 * gate 2 pair: `gate2DefaultInstructionLines` below (terminal + served
 * interstitial) AND `bootstrap-apply.ts`'s `--dry-run`/pre-approval preview,
 * which — before this export existed — hand-typed its OWN one-line
 * paraphrase of the same two facts ("NEVER" instead of "NOT", combined into
 * a single sentence). That preview line was a fifth independently-authored
 * copy of this exact instruction, found during this issue's own
 * enumeration requirement; it now renders these two lines verbatim instead
 * of restating them.
 */
export function gate2RepoSelectionInstructionLines(repos: readonly string[]): readonly [string, string] {
  return [
    'on the page that opens, choose "Only select repositories" — NOT "All repositories".',
    `select exactly: ${repos.length > 0 ? repos.join(', ') : '(no repos declared in the fleet manifest — verify before installing)'}`,
  ];
}

/**
 * The bare repository name GitHub's OWN "Only select repositories" picker
 * expects typed into its search box (groundnuty/macf#1176) — NOT
 * `owner/repo`. The account is already fixed by the point this picker
 * appears (the operator chose it, or it's implied by the App), so the
 * picker searches by name alone within that account; typing `owner/repo`
 * there would not match. Verified against GitHub's own docs ("you type the
 * name of each repository you'd like to give the app access to") + this
 * codebase's own already-confirmed precedent for the same shape
 * (`observer.ts::listRunnerGroupsVisibleToRepo`'s `visible_to_repository`
 * query param — "bare repo name, no `owner/` prefix — the org is already
 * the path segment"). **Not verified against the live install page itself**
 * — no browser is available in this environment to confirm the picker's
 * exact filter behavior; if a future live gate shows this wrong, the
 * account name is ALSO stated once in `gate2RepoSelectionInstructionLines`'s
 * prose (a `messageLines` entry, so both surfaces carry it) as a
 * lower-cost mitigation than getting the bare-vs-qualified call wrong
 * silently.
 */
export function bareRepoName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

/** {@link bareRepoName} applied to a whole list — the copyable-block payload (groundnuty/macf#1176). */
export function bareRepoNames(repos: readonly string[]): readonly string[] {
  return repos.map(bareRepoName);
}

/**
 * The default, first-gate instruction body (groundnuty/macf#952) — every
 * pre-#1063 call site (no `opts.instructionLines` override) gets exactly
 * this, byte-identical to before that field existed. Pulled out to a named
 * function (groundnuty/macf#1173) purely so {@link runGate2WithInterstitial}
 * can compute it ONCE, before either consumer (the terminal's
 * `instructionLines` and the interstitial's `messageLines`) reads it — see
 * that function's own doc for why "compute once, thread twice" is the whole
 * fix.
 */
function gate2DefaultInstructionLines(repos: readonly string[], whyText: string, installUrl: string): readonly string[] {
  return [
    ...gate2RepoSelectionInstructionLines(repos),
    whyText,
    `GitHub's install page: ${installUrl}`,
  ];
}

/**
 * `opts.instructionLines`/`waitLabel`/`gateLabelSuffix` (groundnuty/macf#1063)
 * let {@link retryRecoverableGate2Rejection} drive a REOPEN of this exact
 * function with retry-specific wording, without a second gate
 * implementation — every pre-#1063 call site omits all three and gets
 * {@link gate2DefaultInstructionLines}'s "choose Only select repositories"
 * instructions, `'Install'` wait-label, and un-suffixed gate label,
 * byte-identical.
 *
 * **groundnuty/macf#1173 — `messageLines` is computed ONCE, right here, and
 * handed to BOTH the terminal (`announceAndOpenGate`'s `instructionLines`)
 * and the served interstitial (`InstallInterstitialOptions.messageLines`).**
 * Before this fix, the interstitial (`manifest-flow-server.ts::
 * renderInstallInterstitial`) built its OWN text from `repos`/`whyText`,
 * independently of whatever `opts.instructionLines` this function was
 * given — so a resumed gate's narrowed terminal instruction
 * (`gate2ResumedInstructionLines`) or a retry's
 * (`gate2RetryInstructionLines`) never reached the page the operator was
 * actually looking at, which kept showing the full original repo list. The
 * operator's own ruling: same words, not "consistent" words — so this
 * function no longer derives two texts from the same facts; it derives ONE
 * text and renders it twice.
 */
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
  opts: {
    readonly caveat?: string;
    readonly instructionLines?: readonly string[];
    readonly waitLabel?: string;
    readonly gateLabelSuffix?: string;
    /**
     * Awaited AFTER the browser opens and BEFORE `runGate2` polls/validates
     * (groundnuty/macf#1063 — the operator needs a genuine window to act,
     * not merely to read). Every pre-#1063 call site (the FIRST, normal
     * gate-2 attempt) omits this: on that path `runGate2`'s own
     * `waitForAppInstallation` poll already blocks for real (the App isn't
     * installed yet, so the poll waits until it is). {@link retryRecoverableGate2Rejection}
     * supplies it ONLY on a reopen — there, the App is ALREADY installed
     * (that's WHY the rejection was recoverable), so `waitForAppInstallation`
     * would resolve on its very FIRST poll with no wait at all; without this
     * hook, `validate` would re-run before the operator had any chance to
     * act, burning the whole retry budget in milliseconds. See
     * `AgentApplyDeps.waitForOperatorFix`'s doc for the production wiring.
     */
    readonly postOpenWait?: () => Promise<void>;
    /**
     * groundnuty/macf#1176 — the copyable-block repo set, ALREADY `owner/repo`
     * form (bared just below, alongside `repos`' own default). Omitted by
     * every call site except {@link retryRecoverableGate2Rejection}'s
     * reopen, which passes `current.missingRepos` when the rejecting hook
     * supplied one (narrows the block to only what's still missing) —
     * falling back to the full `repos` set otherwise, same as every other
     * call site. Never invented by parsing `instructionLines`' prose.
     */
    readonly repoNamesOverride?: readonly string[];
  },
  validate?: ValidateInstallHook,
): Promise<Gate2Outcome> {
  // groundnuty/macf#1173 — computed ONCE, before either consumer below
  // reads it. `opts.instructionLines` (set by the resumed-gate preflight or
  // a retry reopen) wins when supplied; the ordinary first-attempt default
  // otherwise. Whichever it is, this exact array is what BOTH the terminal
  // and the served page show — see this function's own doc.
  const messageLines = opts.instructionLines ?? gate2DefaultInstructionLines(repos, whyText, installUrl);
  // groundnuty/macf#1176 — the copyable payload, computed ONCE alongside
  // `messageLines` for the SAME reason (one array, two renderers, never
  // re-derived per surface). `bareRepoNames` because the picker itself
  // takes bare names — see that function's doc.
  const repoNames = bareRepoNames(opts.repoNamesOverride ?? repos);
  const page = await startInterstitialOrFallback(deps, role, {
    role,
    appName: appSlug,
    installUrl,
    messageLines,
    repoNames,
    // The install page is always the SECOND (and last) of the two gates —
    // literal `2`, not derived from `GATE_TOTAL` (which happens to equal 2
    // today but means "how many gates total," not "which gate this is").
    gateNumber: 2,
    gateTotal: GATE_TOTAL,
  });
  try {
    await announceAndOpenGate(
      deps,
      role,
      `consent gate ${String(GATE_TOTAL)} of ${String(GATE_TOTAL)} (App install page)${opts.gateLabelSuffix ?? ''}`,
      page.url,
      opts.waitLabel ?? 'Install',
      {
        fatal: false,
        caveat: opts.caveat,
        instructionLines: messageLines,
        repoNames,
      },
    );
    await opts.postOpenWait?.();
    return await runGate2(role, appId, keyPath, expected, deps, validate);
  } finally {
    try {
      await page.close();
    } catch (err) {
      // Never let a close-failure mask the real gate-2 result computed above.
      deps.log(`Role "${role}": closing the local install-instruction page failed (${errMessage(err)}) — harmless, the page is one-shot.`);
    }
  }
}

/**
 * Bounds how many times {@link retryRecoverableGate2Rejection} reopens the
 * install page after the FIRST recoverable rejection (groundnuty/macf#1063
 * requirement 3 — "an operator who cannot get it after N tries needs a
 * different message, not a loop"). Small on purpose: each attempt is a full
 * operator round-trip (read the reason, go fix it on GitHub, come back) —
 * this is not a network-flake retry budget.
 */
const MAX_GATE2_REOPEN_ATTEMPTS = 2;

/**
 * The retry-attempt instruction lines (groundnuty/macf#1063 requirement 2 —
 * "say exactly what to click" — and requirement 6, "no internal references
 * in user-facing text").
 *
 * **`retryInstruction`, when the rejecting hook supplied one, is what's
 * shown — never `reason`.** `reason` is a technical string built for
 * `Gate2Outcome.reason`/`AgentApplyOutcome.reason` (the CLI's `--json`/log
 * surface); today's one real caller
 * (`registry-repo-coverage.ts::registryRepoNotInstalledReason`) names the
 * `GET /repos/…/installation` endpoint AND cites `groundnuty/macf#999`/
 * `#1012` by number — exactly the "read a 404 to figure out what to click"
 * shape and the internal-reference shape this issue's requirements 2 and 6
 * both name. `retryInstruction` (`registry-repo-coverage.ts::
 * registryRepoRetryInstruction`) is the SAME fact in plain words: the App
 * handle, the repo, "tick it under Repository access, click Save" — no HTTP
 * verbs, no issue numbers. A bare-string rejection (no cleaner alternative
 * supplied — e.g. `apply-runner-ops.ts::validateRunnerOpsInstall`, which
 * this issue doesn't touch) falls back to `reason`, preserving exactly the
 * pre-widening dialogue for every caller that hasn't opted in.
 */
function gate2RetryInstructionLines(reason: string, retryInstruction: string | undefined): readonly string[] {
  return [
    retryInstruction ?? reason,
    'Reopening the install page — fix it there (or via its "Configure" link if it lands on the App\'s settings ' +
      'page instead), then click "Save". I will re-check automatically once you do.',
  ];
}

/**
 * The "no edge back to the gate" fix (groundnuty/macf#1063) — the operator's
 * own words: *"it has to have a verify step, and then report to the user
 * that he made a mistake and tell him to redo it, and present him with the
 * dialogue again."* Wraps an ALREADY-COMPUTED `outcome` (either `runGate2`'s
 * fresh result, or a hand-built one on the `reuse-confirmed` path — see that
 * call site) and, while it is a RECOVERABLE rejection AND
 * `deps.allowInstallRetry` is set, reopens the SAME gate-2 UX
 * ({@link runGate2WithInterstitial} — never a second gate path) up to
 * {@link MAX_GATE2_REOPEN_ATTEMPTS} times.
 *
 * A no-op (returns `outcome` unchanged) for every shape this issue does NOT
 * touch: a success, a NON-recoverable failure (`recoverable` unset — a gate-1
 * failure, a `waitForAppInstallation` throw, `unconfirmable`/`skip-unverified`/
 * `drift`, all resolved before this is ever called), or `deps.allowInstallRetry
 * !== true` (every pre-#1063 caller/test, and every `--yes` run — see
 * `AgentApplyDeps.allowInstallRetry`'s doc). This is what makes "recoverable
 * vs not" (requirement 4) and "`--yes` never gains a loop" (requirement 5)
 * hold simultaneously: both are the SAME early-return, not two separate
 * checks that could drift apart.
 *
 * `validate`, when given, is threaded straight through to every reopened
 * `runGate2WithInterstitial` call — the reuse-confirmed call site passes
 * `deps.validateReuse` so a retry re-runs the check that actually rejected
 * it; the create/resume-install call sites omit it, so `runGate2`'s own
 * `deps.validateInstall` default applies on every reopened attempt too.
 */
async function retryRecoverableGate2Rejection(
  role: string,
  appId: string,
  keyPath: string,
  expected: ExpectedIdentity,
  appSlug: string,
  installUrl: string,
  repos: readonly string[],
  whyText: string,
  deps: AgentApplyDeps,
  outcome: Gate2Outcome,
  validate?: ValidateInstallHook,
): Promise<Gate2Outcome> {
  if (deps.allowInstallRetry !== true) return outcome;

  const waitForFix = deps.waitForOperatorFix;
  let current = outcome;
  for (let attempt = 1; attempt <= MAX_GATE2_REOPEN_ATTEMPTS; attempt++) {
    if (!(current.status === 'failed' && current.recoverable === true)) return current;
    const gateLabel = `consent gate ${String(GATE_TOTAL)} of ${String(GATE_TOTAL)} — retry ${String(attempt)} of ${String(MAX_GATE2_REOPEN_ATTEMPTS)}`;
    current = await runGate2WithInterstitial(
      role,
      appId,
      keyPath,
      expected,
      appSlug,
      installUrl,
      repos,
      whyText,
      deps,
      {
        waitLabel: 'Save',
        gateLabelSuffix: ` — reopened after a rejection, attempt ${String(attempt)} of ${String(MAX_GATE2_REOPEN_ATTEMPTS)}`,
        instructionLines: gate2RetryInstructionLines(current.reason, current.retryInstruction),
        // groundnuty/macf#1176 — narrows the copyable block to only what
        // THIS rejection found missing, when the rejecting hook supplied a
        // structured `missingRepos` (today: `registry-repo-coverage.ts`'s
        // check). `undefined` falls back to the full `repos` set — the same
        // honest-fallback floor `messageLines`' own `retryInstruction ??
        // reason` already uses just above.
        repoNamesOverride: current.missingRepos,
        // groundnuty/macf#1063 — the operator's genuine window to act (see
        // `AgentApplyDeps.waitForOperatorFix`'s doc). `undefined` when
        // `waitForFix` is unset — `runGate2WithInterstitial`'s
        // `opts.postOpenWait?.()` treats that as "proceed immediately"
        // rather than hanging. Production ALWAYS wires `waitForOperatorFix`
        // alongside `allowInstallRetry` (`bootstrap-apply.ts`), so this
        // fallback only matters for a caller/test that opts into retries
        // without also wiring the wait.
        postOpenWait: waitForFix !== undefined ? () => waitForFix(role, gateLabel) : undefined,
      },
      validate,
    );
  }

  if (current.status === 'failed' && current.recoverable === true) {
    const reason =
      `${current.reason} Gave up after ${String(MAX_GATE2_REOPEN_ATTEMPTS)} attempt(s) to fix it via the install ` +
      'page — an operator must correct it manually on GitHub, then re-run apply.';
    deps.log(`Role "${role}": ${reason}`);
    return { ...current, reason };
  }
  return current;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
