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
 *
 * **A poll's duration must be justified by an expectation, not a constant
 * (macf#972).** A repo CREATED THIS RUN cannot yet have a runner registered
 * to it by anything `apply` itself does — nothing provisions one in-band
 * (macf#943, the runner-provisioning call, is unbuilt) — so polling the full
 * deploy window for it waits on a step nobody was asked to perform: two live
 * provisions both polled 600s and then reported the same honest skip they
 * would have reported immediately. {@link publishTrustedActorsGated}'s
 * OPTIONAL `justCreatedRepos` param (DR-043 Amendment I2) marks exactly
 * those repos; for one, it performs ONE immediate `checkRunnerUsableByRepo`
 * call — never the retry-with-sleep loop {@link pollForUsableRunner} owns —
 * so a runner that is ALREADY usable at t=0 (e.g. an org-wide runner group
 * with "All repositories" visibility, registered before this run) still
 * gets its var written, but an absent runner is reported at once with the
 * SAME {@link runnerTokenPollExhaustedReason} text `apply` has always shown,
 * just without the wait. A repo that PRE-EXISTED this run keeps polling
 * exactly as before — a runner may legitimately be registering to it. This
 * is the interim behaviour the issue asks for independently of macf#943,
 * which removes the operator from the loop entirely by having `apply` make
 * the provisioning call itself (at which point a fresh repo's poll becomes
 * justified again — see {@link publishTrustedActorsGated}'s doc).
 * {@link RunnerTokenPollOptions}'s new `onProgress`/`now`/`sleepFn` fields
 * (all optional, defaulting to today's un-instrumented real-clock behavior)
 * let a long poll narrate itself — macf#972 requirement 3: silence after a
 * burst of browser consent-gate clicks reads as a hang.
 *
 * **A declared runner is REQUIRED, never a silent hosted-runner fallback
 * (groundnuty/macf#993).** The operator's ruling, verbatim: "When we specify
 * that the runner has to be our runner that we create, it should be
 * impossible and forbidden to fall back to the metered hosted runners...
 * the failure of our runner should be loud, and the lack of it being
 * provisioned at this stage should block everything else." Before macf#993,
 * a per-repo "no usable runner confirmed" outcome from
 * {@link publishTrustedActorsGated} — whether via {@link pollForUsableRunner}
 * exhausting its window OR the macf#972 fast path finding none at t=0 — was
 * `'skipped'`, the SAME "honest incomplete, does not fail the run" status
 * `ensure-variable.ts` uses for benign steady states elsewhere in this
 * codebase. That let a live two-agent fleet run finish reporting the routing
 * gap in one transcript line while every OTHER step read green, and exit 0
 * — the fleet then billed github-hosted Actions minutes indefinitely with no
 * further signal. `publishTrustedActorsGated` now reports that SAME outcome
 * as `'failed'` instead (the reason TEXT is UNCHANGED —
 * {@link runnerTokenPollExhaustedReason} / {@link runnerJustCreatedRepoReason}
 * already named the billing consequence — only the status tag flips). No
 * OTHER file needed a code change for this: `commands/bootstrap-apply.ts::applyExitCode`'s
 * `routingBad` check already treats ANY `'failed'` routing leg as
 * run-failing, and `result.routing` is populated ONLY when
 * `routing.runner.runs_on === 'self-hosted'` was declared (see
 * `apply-fleet.ts`'s call site) — so a fleet that never declares a runner is
 * structurally unreachable here and stays exit-0, unaffected. The ungated
 * {@link publishTrustedActors} (superseded as the production entrypoint by
 * macf#929, retained only as a direct-unit-tested building block — see its
 * own doc) is NOT part of this change; it keeps reporting `'skipped'` for the
 * same shape, since it is never reached from `apply` at all.
 *
 * **A confirmed 403 fails FAST, not after the full poll window
 * (groundnuty/macf#1054, DR-044 Decision 6).** Observed twice on the live
 * fleet: an AGENT installation token (lacking `administration: read` — that
 * scope is FLEET authority under DR-044, "the apply runs with operator
 * authority," not agent authority) makes `observer.ts::listRepoScopedRunners`
 * 403 on EVERY poll tick — the runner itself was healthy the whole time
 * (`status=online busy=false`), but the caller was never entitled to see it,
 * so the poll burned the entire 600s budget waiting for a precondition that
 * cannot change mid-poll. `checkRunnerUsableByRepo` now threads a confirmed
 * repo-scoped 403 through as `RunnerUsability.permissionDenied` (see that
 * field's doc in `observer.ts`); {@link pollForUsableRunner} exits on the
 * VERY FIRST check when it sees that flag (before ever calling `sleepFn`),
 * and {@link publishTrustedActorsGated} reports the outcome via the NEW
 * {@link runnerPermissionDeniedReason} — never {@link runnerTokenPollExhaustedReason}
 * (which would falsely claim a wait happened) — naming the 403 + the
 * DR-044 fleet-authority cause explicitly. A genuine "registered but not yet
 * online" `'unknown'`/`'absent'` (network hiccup, transient `gh` failure, a
 * runner mid-registration) carries NO `permissionDenied` flag and keeps
 * polling to the full budget exactly as before — this fix narrows ONLY the
 * confirmed-403 shape, per DR-044 Decision 6's floor: the operator's own
 * runner-missing ruling (macf#993, above) is unchanged and still fires loud
 * for a genuinely-absent runner.
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
 * The reason text for a runner-registration token WAS supplied but
 * {@link pollForUsableRunner}'s bounded window expired before `repo` became
 * usable (macf#929 requirement 6) — an honest incomplete outcome: the
 * operator declared intent AND gave `apply` a way to wait, but the runner
 * genuinely hasn't shown up yet. Extends `noRunnerRegisteredReason`'s
 * absent/unknown honest-unknown discrimination + macf#924's org-admin
 * handover verbatim-append + macf#934's capability-detail verbatim-append
 * (all still apply — polling doesn't change WHY a runner is unusable, only
 * WHETHER `apply` waited for it) with the token-specific framing + the
 * concrete re-run remedy.
 *
 * **Status note (groundnuty/macf#993):** {@link publishTrustedActorsGated}
 * pairs this text with `status: 'failed'`, not `'skipped'` — a declared
 * runner is REQUIRED, so "no usable runner confirmed" now fails the run
 * (see this module's top-level doc, "A declared runner is REQUIRED"
 * section). This function's TEXT is unchanged; only the caller's status tag
 * changed.
 */
/**
 * The reason text for the macf#972 FAST PATH — a repo created in THIS run,
 * where no poll was performed because none could succeed.
 *
 * Deliberately NOT {@link runnerTokenPollExhaustedReason}: that text says
 * "within the Ns poll window", which on this path would assert a wait that
 * never happened. A message describing work the program did not do is the
 * same dishonesty this catalog exists to prevent, so the elapsed claim is
 * dropped and the CAUSE is named instead. The remedy clause is kept
 * verbatim — operators and macf#932's pre-flight both reference it.
 *
 * **Status note (groundnuty/macf#993):** same status change as
 * {@link runnerTokenPollExhaustedReason} above — `'failed'`, not
 * `'skipped'`. This function's TEXT is unchanged.
 */
/**
 * The reason text for the groundnuty/macf#1054 FAST-FAIL path — a CONFIRMED
 * HTTP 403 on the repo-scoped runner list (`usability.permissionDenied ===
 * true`), observed on the runner's OWN check or on the caller's very first
 * poll iteration. Deliberately NOT {@link runnerTokenPollExhaustedReason}:
 * that text asserts "within the Ns poll window" — a wait that, on THIS path,
 * never happened (or ran for a single, sub-second check) — see
 * {@link runnerJustCreatedRepoReason}'s doc for the same "a message
 * describing work the program did not do is the same dishonesty this catalog
 * exists to prevent" reasoning this function follows for the SAME class of
 * lie, one gate over.
 *
 * DR-044 Decision 6 ("fail as fast as possible, with the cleanest reasons to
 * act on") is why this fails immediately instead of retrying: a permission
 * gap cannot resolve itself by waiting — the caller is not entitled to look,
 * a fact that does not change between one poll tick and the next. DR-044
 * also names listing a repo's registered runners as **fleet authority**, not
 * agent authority — the operator's own words on groundnuty/macf#1054: "the
 * apply runs with operator authority." The remedy clause says exactly that,
 * distinct from {@link runnerTokenPollExhaustedReason}'s "register a runner
 * and re-run" (there is no runner to register here — the runner is fine;
 * the CALLER cannot see it).
 *
 * **Status note (groundnuty/macf#993, unchanged by this function):**
 * {@link publishTrustedActorsGated} pairs this text with `status: 'failed'`,
 * same bar as every other non-present routing outcome — a declared runner is
 * REQUIRED, so an unconfirmable one still fails the run. Only the TIMING and
 * the WORDING change here, never the severity.
 */
export function runnerPermissionDeniedReason(repo: string, usability: RunnerUsability): string {
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `role/repo "${repo}": a runner registration token was supplied (macf#929) but the repo-scoped runner list was ` +
    'refused outright (HTTP 403) — failing immediately, WITHOUT retrying, because a permission gap cannot resolve ' +
    'itself given more time (DR-044 Decision 6, groundnuty/macf#1054). MACF_TRUSTED_ACTORS was NOT written. ' +
    "Listing a repo's registered runners is FLEET authority, not agent authority (DR-044) — re-run " +
    '`macf bootstrap apply` with a runner-registration token (and, if this run used the agent identity\'s own ' +
    'installation token for the underlying `gh` auth, with an identity holding "administration: read" on this ' +
    `repo).${detailSuffix}${handoverSuffix}`
  );
}

export function runnerJustCreatedRepoReason(repo: string, usability: RunnerUsability): string {
  const cause =
    usability.presence === 'unknown'
      ? 'could not confirm whether a self-hosted runner is registered (auth / network / insufficient scope)'
      : 'no usable self-hosted runner is registered yet — this repo was created during THIS run, so none can have registered on its own';
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `role/repo "${repo}": a runner registration token was supplied (macf#929) but ${cause} — ` +
    'MACF_TRUSTED_ACTORS was NOT written; this repo routes on hosted runners (billed on private repos) ' +
    'until a runner is confirmed. Register a runner for this repo, then re-run `macf bootstrap apply`.' +
    `${detailSuffix}${handoverSuffix}`
  );
}

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
  /**
   * How often (of ELAPSED wait time) {@link pollForUsableRunner} calls
   * {@link onProgress} while it waits — macf#972 requirement 3. Default 30s,
   * matching the issue's own "any poll longer than ~30s" threshold. Never
   * fires for a poll that resolves (or was never entered — see
   * `publishTrustedActorsGated`'s `justCreatedRepos` fast path) before the
   * first interval elapses.
   */
  readonly progressIntervalMs?: number;
  /**
   * Called with `(repo, elapsedMs, totalMs)` roughly every
   * {@link progressIntervalMs} while a poll waits — macf#972: a silent
   * multi-minute wait after a burst of browser consent-gate clicks reads as
   * a hang ("I'm not sure what we are waiting on ... I see no pop-ups and
   * have nothing to click," the operator's own words on the issue). Never
   * called for the immediate single-check fast path (nothing to narrate — it
   * never waits). `undefined` (the default) narrates nothing, matching
   * every poll's behavior before macf#972.
   */
  readonly onProgress?: (repo: string, elapsedMs: number, totalMs: number) => void;
  /** Injectable clock — default `Date.now`. Test-only; production never overrides this. */
  readonly now?: () => number;
  /** Injectable wait primitive — default a real `setTimeout`-based sleep. Test-only; production never overrides this. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/** Default poll budget for a single repo when {@link publishTrustedActorsGated} doesn't override it — see {@link RunnerTokenPollOptions}'s doc. */
export const DEFAULT_RUNNER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Default poll interval — see {@link RunnerTokenPollOptions}'s doc. */
export const DEFAULT_RUNNER_POLL_INTERVAL_MS = 3_000;
/** Default progress-narration interval (macf#972 requirement 3: "~30s") — see {@link RunnerTokenPollOptions.progressIntervalMs}'s doc. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The macf#972-requirement-3 progress line — "nothing for you to do" is
 * deliberate, not filler: the wait follows a burst of browser consent-gate
 * clicks, so an unexplained silent stretch reads as a hang (the operator's
 * own words on the issue: "I'm not sure what we are waiting on, I see no
 * pop-ups and have nothing to click"). Shared by every {@link onProgress}
 * caller (production wiring lives at `apply-fleet.ts`'s
 * `publishTrustedActorsGated` call site) so the wording is authored ONCE.
 */
export function formatRunnerPollProgress(repo: string, elapsedMs: number, totalMs: number): string {
  return (
    `waiting for a usable self-hosted runner for "${repo}" … ${String(Math.round(elapsedMs / 1000))}s/` +
    `${String(Math.round(totalMs / 1000))}s elapsed; nothing for you to do`
  );
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
 *
 * **macf#972 — narrates itself past `progressIntervalMs` of ELAPSED wait.**
 * `opts.now`/`opts.sleepFn` default to the real clock/`setTimeout`-sleep
 * (unchanged behavior for every existing caller that doesn't set them);
 * tests inject a fake pair to assert progress fires without a real wait.
 * `onProgress` fires at most once per interval, only ahead of a `sleep` —
 * never on the call that's about to return (a poll that resolves or expires
 * inside its first interval narrates nothing, matching this function's
 * pre-macf#972 silent behavior for a short poll).
 *
 * **groundnuty/macf#1054 — fails FAST on a confirmed permission denial,
 * never retries it.** A `usability.permissionDenied === true` result (see
 * `observer.ts::RunnerUsability.permissionDenied`'s doc) exits the loop on
 * THIS SAME check, before the `remaining <= 0` budget test and before EVER
 * calling `sleepFn` — a 403 "I am not entitled to look" cannot resolve into
 * "now I can" by waiting, so retrying it for the full `timeoutMs` budget
 * would only ever reproduce the same 403 on every tick (DR-044 Decision 6:
 * "fail as fast as possible, with the cleanest reasons to act on"). A
 * genuinely absent/unregistering runner (`presence` `'unknown'`/`'absent'`
 * WITHOUT `permissionDenied`) is UNCHANGED — it keeps polling to the full
 * budget exactly as before this fix; only the confirmed-403 shape short-
 * circuits.
 */
export async function pollForUsableRunner(
  repo: string,
  checkRunnerUsableByRepo: (repo: string) => Promise<RunnerUsability>,
  opts: RunnerTokenPollOptions = {},
): Promise<RunnerUsability> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const progressIntervalMs = opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const nowFn = opts.now ?? Date.now;
  const sleepFn = opts.sleepFn ?? sleep;
  const start = nowFn();
  const deadline = start + timeoutMs;
  let lastProgressAt = start;
  for (;;) {
    const usability = await checkRunnerUsableByRepo(repo);
    if (usability.presence === 'present') return usability;
    // groundnuty/macf#1054 — a confirmed 403 is "not entitled to look," never
    // "not there yet." Return on the FIRST check; never reaches `sleepFn`.
    if (usability.permissionDenied === true) return usability;
    const elapsedNow = nowFn();
    const remaining = deadline - elapsedNow;
    if (remaining <= 0) return usability;
    if (opts.onProgress !== undefined && elapsedNow - lastProgressAt >= progressIntervalMs) {
      opts.onProgress(repo, elapsedNow - start, timeoutMs);
      lastProgressAt = elapsedNow;
    }
    await sleepFn(Math.min(pollIntervalMs, remaining));
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
 *   `'failed'` with {@link runnerTokenPollExhaustedReason} (groundnuty/macf#993
 *   — a declared runner is REQUIRED, so an unconfirmed runner now FAILS the
 *   run, same bar as the missing-token refusal below; the reason text is the
 *   SAME honest-incomplete wording used before this change, only the status
 *   tag flipped); a throwing check is ALSO `'failed'` (wiring bug, isolated
 *   to that repo — mirrors `publishTrustedActors`).
 *
 * **`justCreatedRepos` (macf#972, DR-043 Amendment I2) — a poll must be
 * justified by an expectation, not a constant.** For a repo in this
 * OPTIONAL set, the shared deadline above is never consulted for a retry
 * loop: this function calls `deps.checkRunnerUsableByRepo(repo)` DIRECTLY,
 * exactly ONCE, never through {@link pollForUsableRunner} (zero `sleep`s,
 * zero retries — the decisive difference from the poll path). A repo NOT in
 * the set (or when the param is omitted entirely — every existing caller)
 * polls exactly as before; `undefined` is the historical, fully-backward-
 * compatible default. The single check is still a LIVE read, not an assumed
 * absence: an org-wide runner group ("All repositories" visibility)
 * registered before this run IS usable at t=0 for a brand-new repo, and
 * that case still writes the var — only the RETRY LOOP is skipped, never
 * the one-shot presence read. When the single check finds no usable runner,
 * the outcome is `'failed'` (groundnuty/macf#993) with
 * {@link runnerTokenPollExhaustedReason} called with the SAME configured
 * `timeoutMs` the poll path would have used — byte-identical text to what a
 * full 600s poll would have produced, per the issue's hard constraint that
 * only the TIMING changes, never the message. See
 * `apply-fleet.ts`'s call site for how `justCreatedRepos` is populated
 * (`ensureAgentRepo`'s per-repo `status === 'created'`).
 *
 * NEVER throws.
 */
export async function publishTrustedActorsGated(
  value: string,
  repos: readonly string[],
  deps: RoutingApplyDeps,
  runnerToken: string | undefined,
  pollOptions: RunnerTokenPollOptions = {},
  justCreatedRepos?: ReadonlySet<string>,
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  if (runnerToken === undefined || runnerToken.length === 0) {
    return failedOutcomesFor(repos, noRunnerTokenReason());
  }

  const timeoutMs = pollOptions.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = pollOptions.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const nowFn = pollOptions.now ?? Date.now;
  const deadline = nowFn() + timeoutMs;

  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const remaining = Math.max(0, deadline - nowFn());
    // macf#972 — "poll only when a runner is plausibly imminent": a repo
    // CREATED THIS RUN cannot yet have a runner registered by anything
    // `apply` itself does (macf#943, the provisioning call, is unbuilt), so
    // waiting the full deploy window for one waits on a step nobody was
    // asked to perform. A repo that PRE-EXISTED this run may legitimately be
    // mid-registration — it still gets the real poll.
    const pollJustified = justCreatedRepos?.has(repo) !== true;
    let usability: RunnerUsability;
    try {
      usability = pollJustified
        ? await pollForUsableRunner(repo, deps.checkRunnerUsableByRepo, {
            timeoutMs: remaining,
            pollIntervalMs,
            progressIntervalMs: pollOptions.progressIntervalMs,
            onProgress: pollOptions.onProgress,
            now: pollOptions.now,
            sleepFn: pollOptions.sleepFn,
          })
        : await deps.checkRunnerUsableByRepo(repo);
    } catch (err) {
      out[repo] = { status: 'failed', reason: `runner-usability check threw for "${repo}" — ${errMessage(err)}` };
      continue;
    }
    if (usability.presence !== 'present') {
      // groundnuty/macf#993 — the operator's ruling: a declared runner is
      // REQUIRED, never a silent hosted-runner fallback. `'failed'`, not
      // `'skipped'` — this is the ONE line that makes the whole run
      // non-zero-exit via `commands/bootstrap-apply.ts::applyExitCode`'s
      // existing `routingBad` check (already `.some((leg) => leg.status ===
      // 'failed')`, unchanged). The reason TEXT is untouched for the two
      // pre-existing branches — only the status tag flips.
      //
      // groundnuty/macf#1054 — `permissionDenied` wins over BOTH existing
      // branches, regardless of `pollJustified`: a confirmed 403 asserts NO
      // wait happened (or, on the poll path, that the wait was cut short on
      // the very first check — see `pollForUsableRunner`'s doc), so neither
      // `runnerTokenPollExhaustedReason` ("within the Ns poll window") nor
      // `runnerJustCreatedRepoReason`'s generic "could not confirm" framing
      // is honest here; `runnerPermissionDeniedReason` names the 403 + DR-044
      // cause explicitly on EITHER path.
      out[repo] = {
        status: 'failed',
        reason:
          usability.permissionDenied === true
            ? runnerPermissionDeniedReason(repo, usability)
            : pollJustified
              ? runnerTokenPollExhaustedReason(repo, usability, timeoutMs)
              : runnerJustCreatedRepoReason(repo, usability),
      };
      continue;
    }
    out[repo] = await writeTrustedActorsVar(repo, value, deps);
  }
  return out;
}
