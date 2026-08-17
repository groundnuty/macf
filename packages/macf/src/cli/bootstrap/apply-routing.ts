/**
 * `MACF_TRUSTED_ACTORS` write — DR-043 §D1 / Amendment D phase 2 (groundnuty/
 * macf#838), retiring the `plan.ts::APPLY_UNIMPLEMENTED_REASONS.routing`
 * create-verb gap (macf#854): "apply has no routing-provisioning step at
 * all."
 *
 * **Corrected target (macf#922).** This module used to write
 * `MACF_ROUTING_RUNS_ON` — a variable the v3 router (`macf-actions`'s
 * `agent-router.yml`) **never reads**. The router's `pick-runner` job
 * selects self-hosted-vs-hosted by comparing `github.actor` against
 * `vars.MACF_TRUSTED_ACTORS` — the ONLY `vars.MACF_*` reference anywhere in
 * that file (confirmed by a full-file grep across `main`/`v3.4.1`/`v3.4.2`).
 * `MACF_ROUTING_RUNS_ON` traces to a single v1.x SSH-routing-line commit
 * (`macf-actions` `1f782bf`, `refs/tags/v1` only) that the v3 line never
 * carried — so every prior `apply` run was writing an inert variable while
 * doing nothing to actually enable self-hosted routing, and billing the
 * operator for github-hosted Actions minutes on a private repo the whole
 * time. This module now writes the variable the router ACTUALLY reads. See
 * `router-trusted-actors-contract.test.ts` for the pinned/parsed proof.
 *
 * §D1: "`runs_on` → a routing var on every caller repo." Per
 * `observer.ts::githubRegistryObserver`'s doc, EVERY agent repo is a routing
 * caller and the `<fleet>-control` repo is NEVER one (it doesn't run
 * `agent-router.yml`) — `apply-fleet.ts` passes this function the same
 * `confirmedRepos` list (agent repos only) it builds for
 * `apply-ca.ts::publishCaCertLegs`'s repo legs, never the control repo.
 *
 * **Register-before-route (macf#922 requirement 3), corrected for the
 * org-runner-blind cost regression (macf#923/#924).** The router's own
 * `pick-runner` doc comment is explicit: "the self-hosted branch activates
 * only once the var is set AND a runner is registered." Setting
 * `MACF_TRUSTED_ACTORS` with no USABLE runner routes trust at a runner that
 * can't pick up the job — so this module checks usability PER REPO
 * (`deps.checkRunnerUsableByRepo`, `observer.ts`'s repo-scope-then-org-scope
 * resolution — see that function's doc; `macf-devops-toolkit/runner/RUNNER.md`'s
 * register-before-route ceremony being entirely operator/devops-toolkit-driven,
 * out of `apply`'s own reach) immediately before each repo's write, and
 * REFUSES to write — `EnsureVariableOutcome`'s existing `'skipped'` status,
 * with an explicit reason (including an org-admin handover when a runner
 * exists but the repo is excluded from its group) — when no usable runner is
 * confirmed registered. This is the SAME "never silently skip" surface
 * `apply-ca.ts::skippedCaPublish` / `apply-routing-client.ts::skippedRoutingClientPublish`
 * already use for "never attempted this run," so the gap renders visibly in
 * `formatApplyResult`'s routing summary (`formatVariableLegLine`'s
 * `'skipped'` branch) — including under `--yes`, which skips the
 * pre-approval plan render entirely.
 *
 * **Create-only — `update` stays un-actioned (macf#838 Phase 2b review).**
 * `plan.ts::routingItem` can emit an `update` verb when an observed value
 * DIVERGES from the manifest-derived value (per-repo drift is possible;
 * different agent repos can independently disagree, or the agent roster
 * changed since the var was last written). This module does NOT compare
 * values or overwrite a present variable — it only
 * `ensure-variable.ts::ensureVariableCreated`s (write-if-absent, never
 * touch-if-present), matching the task's hard "create-only… never silently
 * overwrite" constraint. A drifted value is therefore reported by `plan`
 * (still `confirm_required: true`) but left un-actioned by `apply` — see
 * `plan.ts::planItemApplyCoverage`'s routing case for why `update` stays
 * `not_implemented` while `create` joins the implemented group.
 *
 * **`--runner-token` — token = POLICY, detection = TIMING (macf#929).**
 * macf#922/#924 left the register-before-route gate as a single point-in-time
 * check (`publishTrustedActors`, above): usable NOW or refuse. That is
 * correct as far as it goes, but forces a two-command choreography when an
 * operator is registering a runner IN THE SAME breath as running `apply`
 * (register, THEN re-run apply once it shows up). `publishTrustedActorsGated`
 * (the NEW production entrypoint `apply-fleet.ts` actually calls) splits the
 * gate: a `--runner-token`/`MACF_BOOTSTRAP_RUNNER_TOKEN` value is a POLICY
 * precondition — declaring `routing.runner` self-hosted with no token
 * supplied REFUSES outright, `'failed'`, before any live check, same posture
 * as an unconfigured `transport.age_recipients` refusing before consent
 * gate 1 (Amendment C). A supplied token does NOT license the write by
 * itself — detection is untouched, still `checkRunnerUsableByRepo` exactly
 * as macf#927 left it — it licenses `apply` to POLL for usability across a
 * bounded deploy window instead of checking once, so the common "register a
 * runner, then apply" case is one command. See
 * {@link publishTrustedActorsGated}'s doc for the full mechanics.
 *
 * **The policy half moves earlier (macf#932).** Through macf#929,
 * `publishTrustedActorsGated`'s refusal was the ONLY place the missing-token
 * policy fired — reachable only after `applyFleet` had already driven both
 * consent gates for every agent in the fleet (six browser clicks on a
 * 3-agent fleet, plus a globally-unique-named GitHub App created before the
 * error surfaces). {@link checkRunnerTokenPreflight} duplicates ONLY the
 * policy half of the macf#929 split, called by
 * `commands/bootstrap-apply.ts::runBootstrapApply` before consent gate 1
 * ever opens. `publishTrustedActorsGated` itself is UNCHANGED and remains
 * the actual enforcement point — this is a pre-flight, not a relocation.
 */
import type { EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, failedOutcomesFor } from './ensure-variable.js';
import type { CaApplyDeps } from './apply-ca.js';
import type { RunnerUsability } from './observer.js';
import type { FleetRouting } from './fleet-manifest.js';

/** The GitHub Actions variable name the v3 router reads (`agent-router.yml`'s `pick-runner` job) — matches `observer.ts`'s read of the same name (macf#922). */
export const TRUSTED_ACTORS_VAR = 'MACF_TRUSTED_ACTORS';

/** The single register-before-route gate this module adds on top of `CaApplyDeps`'s repo-var primitives (macf#922 requirement 3, macf#924 org-scope correction). */
export interface RunnerRegistrationDeps {
  /** Live, per-repo "is a self-hosted runner REGISTERED AND USABLE" read (`observer.ts::checkRunnerUsableByRepo` — repo-scope OR org-scope-with-visibility-admitting-this-repo). NEVER throws by contract (mirrors `observer.ts`'s other `check*Presence` reads); a throwing fake is still handled defensively below. */
  readonly checkRunnerUsableByRepo: (repo: string) => Promise<RunnerUsability>;
}

/**
 * Same repo-write shape `apply-ca.ts::CaApplyDeps` already carries for its
 * repo legs — a `Pick`, not a fresh interface, so `apply-fleet.ts` can thread
 * ONE `trustDeps` field through both this module and `apply-ca.ts` (task
 * requirement: reuse, no separate seam to keep in sync) — PLUS the
 * register-before-route gate this module alone needs.
 */
export type RoutingApplyDeps = Pick<CaApplyDeps, 'checkRepoPresence' | 'createRepoVariable'> & RunnerRegistrationDeps;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why a repo's `MACF_TRUSTED_ACTORS` write was skipped for want of a
 * confirmed-registered-and-USABLE runner (macf#922 requirement 3, macf#924
 * org-scope correction) — exported so tests assert the REPORT, not just the
 * absence of a write. Distinguishes `'absent'` (confidently no usable
 * runner) from `'unknown'` (some leg of the read failed) per Amendment A4's
 * honest-unknown floor — both refuse the write, but the diagnostic should
 * never claim more confidence than it has. The original wording for both
 * branches is preserved UNCHANGED; `usability.handover` (macf#924 — an org
 * runner exists but its group excludes this repo) is appended verbatim when
 * set, naming the org-admin action rather than silently reading as an
 * ordinary absence. `usability.detail` (macf#934 — a runner WAS found but
 * fails the capability check: offline, missing a required label, or a
 * permission-denied read) is likewise appended verbatim when set — a
 * strict extension, not a rewrite, same as `handover`'s addition.
 */
export function noRunnerRegisteredReason(repo: string, usability: RunnerUsability): string {
  const cause =
    usability.presence === 'unknown'
      ? 'could not confirm whether a self-hosted runner is registered (auth / network / insufficient scope)'
      : 'no self-hosted runner is confirmed registered';
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `${cause} for "${repo}" — MACF_TRUSTED_ACTORS was NOT written; this repo continues routing on ` +
    'ubuntu-latest (billed on private repos) until a runner is registered and confirmed ' +
    `(register-before-route — macf-devops-toolkit runner/RUNNER.md §"The security model"; macf#922).${detailSuffix}${handoverSuffix}`
  );
}

/** The single per-repo create-only write, shared by {@link publishTrustedActors} (single-check, macf#922/#924) AND {@link publishTrustedActorsGated} (token-gated + polled, macf#929) — a repo that reaches this point has ALREADY been confirmed usable by whichever caller invoked it. Extracted so the real write primitives (`checkRepoPresence`/`createRepoVariable`) stay reachable from the ACTUAL production entrypoint (`publishTrustedActorsGated`, wired at `apply-fleet.ts`'s call site) rather than only from `publishTrustedActors`, which macf#929 demotes to a direct-unit-tested building block — see that function's doc. */
function writeTrustedActorsVar(repo: string, value: string, deps: RoutingApplyDeps): Promise<EnsureVariableOutcome> {
  return ensureVariableCreated(
    {
      checkPresence: () => deps.checkRepoPresence(repo, TRUSTED_ACTORS_VAR),
      create: () => deps.createRepoVariable(repo, TRUSTED_ACTORS_VAR, value),
    },
    `trusted-actors var "${TRUSTED_ACTORS_VAR}" on "${repo}"`,
  );
}

/**
 * Create-only write of `MACF_TRUSTED_ACTORS=<value>` to every repo in
 * `repos` (already-ensured agent repos — see module doc), gated per-repo on
 * a confirmed-registered-and-usable self-hosted runner via ONE live check
 * (never throws; a per-repo failure, including a throwing
 * `checkRunnerUsableByRepo`, is isolated to that repo's entry in the
 * returned map).
 *
 * **Superseded as the production entrypoint by {@link publishTrustedActorsGated}
 * (macf#929).** `apply-fleet.ts` now calls the gated function, which adds the
 * `--runner-token` policy gate + bounded poll ON TOP of this function's
 * single-check shape — see that function's doc for the full split. This
 * function is retained, UNCHANGED, as (a) the direct-unit-tested single-check
 * building block `apply-routing.test.ts` pins byte-for-byte, and (b) a
 * reusable primitive for any future caller that legitimately wants a
 * one-shot check with no token/poll semantics. It is not dead code merely
 * because it moved off the `apply` call site — `writeTrustedActorsVar` keeps
 * its write primitives on the SAME path `publishTrustedActorsGated` uses.
 */
export async function publishTrustedActors(
  value: string,
  repos: readonly string[],
  deps: RoutingApplyDeps,
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    let usability: RunnerUsability;
    try {
      usability = await deps.checkRunnerUsableByRepo(repo);
    } catch (err) {
      out[repo] = { status: 'failed', reason: `runner-usability check threw for "${repo}" — ${errMessage(err)}` };
      continue;
    }
    if (usability.presence !== 'present') {
      out[repo] = { status: 'skipped', reason: noRunnerRegisteredReason(repo, usability) };
      continue;
    }
    out[repo] = await writeTrustedActorsVar(repo, value, deps);
  }
  return out;
}

// --- macf#929 — token = POLICY, detection = TIMING ---

/** CLI flag naming the runner-registration-token gate (macf#929) — echoed ONLY by name in refusal messages, never the token value. */
export const RUNNER_TOKEN_FLAG = '--runner-token';
/** Env-var form of the same flag, matching this CLI's `MACF_BOOTSTRAP_<THING>` convention (see `commands/bootstrap-apply.ts`'s `MACF_BOOTSTRAP_VAULT_VERSION` precedent). */
export const RUNNER_TOKEN_ENV_VAR = 'MACF_BOOTSTRAP_RUNNER_TOKEN';

/**
 * The refusal `apply` shows when `manifest.routing.runner` is declared
 * `runs_on: "self-hosted"` (DR-043 Amendment H) but no runner-registration
 * token was supplied via {@link RUNNER_TOKEN_FLAG} / {@link RUNNER_TOKEN_ENV_VAR}
 * (macf#929). ONE reason for every repo — same shape as
 * `apply-ca.ts::skippedCaPublish`'s single-reason-for-all-legs precedent —
 * because the refusal is a manifest-level policy gate, not a per-repo
 * detection result. Never names a repo (nothing repo-specific to say) and
 * never echoes the token value (there is none to echo — this fires
 * precisely because the token is ABSENT).
 *
 * `'failed'`, not `'skipped'` (see `ensure-variable.ts::failedOutcomesFor`'s
 * doc): this is a REFUSAL the operator must act on, same posture as
 * `apply-fleet.ts::noRecipientPreflightFailure`'s unconfigured-age-recipient
 * pre-flight — both fire BEFORE any live check, both fail the run
 * (`commands/bootstrap-apply.ts::applyExitCode`'s `routingBad` only counts
 * `'failed'` legs), unlike an ordinary "checked and not yet usable" skip.
 */
export function noRunnerTokenReason(): string {
  return (
    'manifest declares routing.runner (runs_on: "self-hosted", DR-043 Amendment H) but no runner registration ' +
    'token was supplied — refusing to write MACF_TRUSTED_ACTORS to any repo before a runner can be confirmed ' +
    '(same posture as an unconfigured transport.age_recipients refusing before consent gate 1: writing trust ' +
    'ahead of a confirmable runner would route jobs at a self-hosted queue nothing may ever service). Supply ' +
    `one via ${RUNNER_TOKEN_FLAG} <token> (or the ${RUNNER_TOKEN_ENV_VAR} env var). Obtain a fresh registration ` +
    'token with: gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token'
  );
}

/** The exit-code-relevant refusal code {@link checkRunnerTokenPreflight} returns — distinct from `plan.ts`'s own `'vault_flags_incomplete'` (macf#913's sibling XOR refusal) so a caller/log can tell the two argument-boundary refusals apart. */
export const RUNNER_TOKEN_MISSING_CODE = 'runner_token_missing';

/**
 * The shape `commands/bootstrap-apply.ts::renderFailure` (and, structurally,
 * `plan.ts`'s own `FleetPlanFailure`) both accept. Defined LOCALLY — not
 * imported from `plan.ts` — so this module keeps ZERO runtime dependency on
 * `plan.ts` (plan.ts is being edited concurrently for a sibling issue,
 * macf#934; this module already only ever `import type`s from files that
 * type-import `plan.ts`, and this keeps it that way — see the module's
 * existing `import type { RunnerUsability } from './observer.js'` for the
 * established pattern).
 */
export interface RunnerTokenPreflightFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The macf#932 PRE-FLIGHT — refuses BEFORE consent gate 1 ever opens, not
 * merely before the LATE gate deep inside `applyFleet`'s routing block
 * ({@link publishTrustedActorsGated}, UNCHANGED — still the actual
 * enforcement point; see this module's doc, "token = POLICY, detection =
 * TIMING," macf#929). Prior to macf#932, `publishTrustedActorsGated`'s
 * refusal was the ONLY place this policy fired — reachable only after
 * `applyFleet` had already driven confirm-before-create, consent gate 1,
 * consent gate 2, and repo-init for EVERY agent in the fleet. On a 3-agent
 * fleet that is six browser clicks (two consent gates × 3 agents) spent
 * before an error knowable from the manifest alone — and gate 1 is not free
 * to retry (it creates a globally-unique-named GitHub App; a run that dies
 * past it can leave a squatted name needing `macf fleet delete-apps` to
 * clear).
 *
 * `commands/bootstrap-apply.ts::runBootstrapApply` calls this immediately
 * after parsing the manifest — mirrors `plan.ts::checkVaultFlagsComplete`'s
 * own "fires BEFORE [manifest parsing / anything else]" placement for its
 * sibling XOR refusal (same shape: refuse on an unsatisfiable configuration
 * before costing the operator anything) — before ANY observe/plan-render, so
 * an operator who forgot the flag never spends a browser click and never
 * even costs a read-only `gh` call.
 *
 * **This ADDS an early check; it does not move the authority.** Detection
 * (is a runner actually usable?) still happens exactly where macf#927/#929
 * left it — inside {@link publishTrustedActorsGated}, at write time, per
 * repo. The token STILL only decides POLICY (may `apply` attempt detection
 * at all?), never substitutes for detection itself (Amendment H.1). This
 * function duplicates ONLY the policy half of that split, earlier.
 *
 * `undefined` (no refusal — apply proceeds) when EITHER `routing.runner` is
 * not declared, OR its `runs_on` isn't `"self-hosted"` (mirrors
 * `apply-fleet.ts`'s own `manifest.routing?.runner.runs_on === 'self-hosted'`
 * gate for whether the write is even attempted — this function must never
 * drift from that condition), OR a non-empty `runnerToken` was resolved.
 * Reuses {@link noRunnerTokenReason}'s message VERBATIM — same refusal text
 * the late gate has always shown, only fired earlier — so an operator who's
 * seen this message before recognizes it instantly, and there is exactly one
 * place its wording is authored.
 *
 * Takes the ALREADY-RESOLVED `runnerToken` value (CLI flag wins over
 * {@link RUNNER_TOKEN_ENV_VAR}, resolved by the caller) rather than reading
 * `process.env` itself — keeps this a pure function callers can unit-test
 * without env stubbing, and keeps exactly ONE place (`runBootstrapApply`)
 * responsible for the flag-then-env precedence.
 */
export function checkRunnerTokenPreflight(
  routing: FleetRouting | undefined,
  runnerToken: string | undefined,
): RunnerTokenPreflightFailure | undefined {
  if (routing?.runner === undefined || routing.runner.runs_on !== 'self-hosted') return undefined;
  if (runnerToken !== undefined && runnerToken.length > 0) return undefined;
  return { code: RUNNER_TOKEN_MISSING_CODE, message: noRunnerTokenReason() };
}

/**
 * The `'skipped'` (not `'failed'` — see {@link noRunnerTokenReason}'s doc for
 * the exit-code-relevant distinction) reason when a runner-registration
 * token WAS supplied but {@link pollForUsableRunner}'s bounded window expired
 * before `repo` became usable (macf#929 requirement 6) — an honest
 * incomplete, not a policy refusal: the operator declared intent AND gave
 * `apply` a way to wait, but the runner genuinely hasn't shown up yet.
 * Extends `noRunnerRegisteredReason`'s absent/unknown honest-unknown
 * discrimination + macf#924's org-admin handover verbatim-append + macf#934's
 * capability-detail verbatim-append (all still apply — polling doesn't
 * change WHY a runner is unusable, only WHETHER `apply` waited for it) with
 * the token-specific framing + the concrete re-run remedy.
 */
export function runnerTokenPollExhaustedReason(repo: string, usability: RunnerUsability, timeoutMs: number): string {
  const cause =
    usability.presence === 'unknown'
      ? 'could not confirm whether a self-hosted runner is registered (auth / network / insufficient scope)'
      : 'no usable self-hosted runner became visible';
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `role/repo "${repo}": a runner registration token was supplied (macf#929) but ${cause} within the ` +
    `${String(Math.round(timeoutMs / 1000))}s poll window — MACF_TRUSTED_ACTORS was NOT written; this repo ` +
    'routes on hosted runners (billed on private repos) until a runner is confirmed. Re-run `macf bootstrap ' +
    `apply\` once it is registered.${detailSuffix}${handoverSuffix}`
  );
}

/** Bounded-poll options for {@link pollForUsableRunner} / {@link publishTrustedActorsGated} — mirrors `identity-confirm.ts::WaitForAppInstallationOptions`'s `timeoutMs`/`pollIntervalMs` pair (macf#929: "reuse the shape," not a new polling pattern). */
export interface RunnerTokenPollOptions {
  /** Overall budget for THIS poll call. Default 10 min — same default `waitForAppInstallation` uses for its own consent-gate-2 deploy window. */
  readonly timeoutMs?: number;
  /** Delay between polls. Default 3s — same default `waitForAppInstallation` uses. */
  readonly pollIntervalMs?: number;
}

/** Default poll budget for a single repo when {@link publishTrustedActorsGated} doesn't override it — see {@link RunnerTokenPollOptions}'s doc. */
export const DEFAULT_RUNNER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Default poll interval — see {@link RunnerTokenPollOptions}'s doc. */
export const DEFAULT_RUNNER_POLL_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll `checkRunnerUsableByRepo(repo)` until it reports `presence: 'present'`
 * or `timeoutMs` elapses — the SAME shape `identity-confirm.ts::waitForAppInstallation`
 * uses for consent gate 2 (check immediately, then on `pollIntervalMs`,
 * NEVER busy-spin; macf#929 deliberately reuses this shape rather than
 * inventing a new one).
 *
 * **Unlike `waitForAppInstallation`, this NEVER throws on timeout** — it
 * returns the LAST observed `RunnerUsability` instead. `checkRunnerUsableByRepo`
 * itself is documented NEVER-throws (`observer.ts`'s doc); a caller-supplied
 * fake that throws anyway propagates here uncaught, matching
 * `publishTrustedActors`'s existing "a throwing check is a wiring bug,
 * `'failed'`, never `'skipped'`" contract — `publishTrustedActorsGated`
 * catches it at the call site, exactly where `publishTrustedActors` does.
 */
export async function pollForUsableRunner(
  repo: string,
  checkRunnerUsableByRepo: (repo: string) => Promise<RunnerUsability>,
  opts: RunnerTokenPollOptions = {},
): Promise<RunnerUsability> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const usability = await checkRunnerUsableByRepo(repo);
    if (usability.presence === 'present') return usability;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return usability;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * The macf#929 production entrypoint — `apply-fleet.ts`'s ACTUAL call site
 * (supersedes `publishTrustedActors`, see that function's doc). Splits the
 * register-before-route gate into a POLICY half and a TIMING half:
 *
 * - **POLICY (`runnerToken`):** `undefined`/empty → refuse EVERY repo in
 *   `repos` outright, `'failed'`, ZERO I/O (`checkRunnerUsableByRepo` is
 *   never called — see {@link noRunnerTokenReason}'s doc for why this is
 *   unconditional: a supplied token is required whenever `routing.runner`
 *   is declared self-hosted, independent of whether a runner ALREADY
 *   happens to be usable this instant — same "declared intent requires the
 *   matching precondition, regardless of current state" posture Amendment C
 *   applies to `age_recipients`). The token itself is NEVER read past this
 *   presence check — it licenses ATTEMPTING detection, never substitutes
 *   for it (macf#929 requirement 4: "detection stays exactly as macf#927
 *   left it").
 * - **TIMING (poll):** token present → bound ONE shared deadline across ALL
 *   of `repos` (computed once, `Math.max(0, deadline - now)` threaded into
 *   each repo's {@link pollForUsableRunner} call) rather than a fresh full
 *   budget per repo — a fleet that never confirms costs one window total,
 *   not `repos.length` windows. A repo confirmed usable is written via
 *   {@link writeTrustedActorsVar}; a repo whose poll expires unconfirmed is
 *   `'skipped'` with {@link runnerTokenPollExhaustedReason} (honest
 *   incomplete, does NOT fail the run); a throwing check is `'failed'`
 *   (wiring bug, isolated to that repo — mirrors `publishTrustedActors`).
 *
 * NEVER throws.
 */
export async function publishTrustedActorsGated(
  value: string,
  repos: readonly string[],
  deps: RoutingApplyDeps,
  runnerToken: string | undefined,
  pollOptions: RunnerTokenPollOptions = {},
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  if (runnerToken === undefined || runnerToken.length === 0) {
    return failedOutcomesFor(repos, noRunnerTokenReason());
  }

  const timeoutMs = pollOptions.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = pollOptions.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const remaining = Math.max(0, deadline - Date.now());
    let usability: RunnerUsability;
    try {
      usability = await pollForUsableRunner(repo, deps.checkRunnerUsableByRepo, { timeoutMs: remaining, pollIntervalMs });
    } catch (err) {
      out[repo] = { status: 'failed', reason: `runner-usability check threw for "${repo}" — ${errMessage(err)}` };
      continue;
    }
    if (usability.presence !== 'present') {
      out[repo] = { status: 'skipped', reason: runnerTokenPollExhaustedReason(repo, usability, timeoutMs) };
      continue;
    }
    out[repo] = await writeTrustedActorsVar(repo, value, deps);
  }
  return out;
}
