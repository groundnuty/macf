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
 * `apply-ca.ts::skippedCaPublish` / `apply-routing-secrets.ts::skippedRoutingSecretsPublish`
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
 * precondition on WAITING, never on USING what is already there — declaring
 * `routing.runner` self-hosted with no token supplied does NOT refuse
 * outright before any live check (see the groundnuty/macf#1195 paragraph
 * below — that was this function's ORIGINAL, now-corrected shape). A
 * supplied token does NOT license the write by itself — detection is
 * untouched, still `checkRunnerUsableByRepo` exactly as macf#927 left it —
 * it licenses `apply` to POLL for usability across a bounded deploy window
 * instead of checking once, so the common "register a runner, then apply"
 * case is one command. See {@link publishTrustedActorsGated}'s doc for the
 * full mechanics.
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
 * **groundnuty/macf#1209 — the pre-flight no longer ABORTS.** It still fires
 * at the same place, still WARNS with the same message, but the caller now
 * falls through into `applyFleet` regardless — see
 * {@link checkRunnerTokenPreflight}'s own doc for why "refuse before gate 1"
 * and "abort the whole run" turned out to be two different things this
 * function had conflated.
 *
 * **A poll's duration must be justified by an expectation, not a constant
 * (macf#972).** Originally: a repo CREATED THIS RUN cannot yet have a runner
 * registered to it by anything `apply` itself does — nothing provisioned one
 * in-band (macf#943's runner-provisioning call was unbuilt at the time) — so
 * polling the full deploy window for it waited on a step nobody was asked to
 * perform: two live provisions both polled 600s and then reported the same
 * honest skip they would have reported immediately. {@link publishTrustedActorsGated}'s
 * OPTIONAL `justCreatedRepos` param (DR-043 Amendment I2) marks exactly
 * those repos; for one, it performs ONE immediate `checkRunnerUsableByRepo`
 * call — never the retry-with-sleep loop {@link pollForUsableRunner} owns —
 * so a runner that is ALREADY usable at t=0 (e.g. an org-wide runner group
 * with "All repositories" visibility, registered before this run) still
 * gets its var written, but an absent runner is reported at once with the
 * SAME {@link runnerTokenPollExhaustedReason} text `apply` has always shown,
 * just without the wait. A repo that PRE-EXISTED this run keeps polling
 * exactly as before — a runner may legitimately be registering to it.
 *
 * **`macf#943` landed the provisioning call, and `apply-fleet.ts` corrects
 * `justCreatedRepos` accordingly, right at its call site.** A repo that is
 * BOTH created this run AND successfully told to provision (the contract
 * returned `'ok'`) is removed from the set passed in here — it rejoins the
 * full poll, because a runner may genuinely be mid-registration for it now.
 * Only a repo that is created this run AND never successfully provisioned
 * (endpoint unconfigured, unreachable, contract/cluster error) keeps the
 * fast single-check path THIS function still owns — the premise "nothing in
 * this run provisions one" no longer holds unconditionally, but it still
 * holds for exactly that narrower case, which is what `justCreatedRepos`
 * continues to mean from this function's point of view: "no provisioning
 * attempt this caller knows succeeded for this repo."
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
 *
 * **A confirmed zero-runners-anywhere read ALSO fails FAST — the third state
 * a bare `presence: 'absent'` could not see (groundnuty/macf#943, operator
 * ruling: "the apply should fail loudly").** Measured live: adding an agent
 * to an existing fleet, `apply` reached the runner gate for a repo with
 * ZERO runners registered at either scope and polled the full 600s budget
 * anyway — the SAME shape macf#1054 fixed for a 403, one state over. A
 * confirmed 403 means "not entitled to look"; this is "looked, and there is
 * genuinely nothing there, at either scope" — `checkRunnerUsableByRepo` now
 * threads that confirmation through as `RunnerUsability.neverRegistered`
 * (see that field's doc in `observer.ts` for exactly what "confirmed" +
 * "both scopes" require — the distinction from a merely-repo-scope-empty
 * read that macf#924's org-scope leg or the excluded-group `handover` case
 * would otherwise wrongly collapse into "nothing here"). {@link
 * pollForUsableRunner} exits on the SAME first check as `permissionDenied`,
 * before `sleepFn`; {@link publishTrustedActorsGated} reports it via the NEW
 * {@link runnerNeverRegisteredReason} — plain user-facing wording, no
 * internal issue/DR references (groundnuty/macf#1061) — on the ordinary
 * poll path only; the `justCreatedRepos` fast path keeps its OWN, more
 * specific "created during THIS run" text even when `neverRegistered` is
 * ALSO true. A repo with SOMETHING registered (found-but-not-yet-online,
 * found-but-excluded) never sets the flag and keeps polling to the full
 * budget exactly as before — this fix narrows ONLY the confirmed-zero shape.
 *
 * **No grace window, deliberately.** A runner an operator is registering
 * BY HAND at the exact moment `apply` runs can, in principle, still be
 * mid-registration on the FIRST check — GitHub's runner list is empty until
 * the registration call lands, not merely until the runner goes online — so
 * this fix CAN reject a genuine race, not only a permanently-empty repo.
 * Accepted anyway: the decisive test for this fix requires `sleepFn` is
 * NEVER invoked on a confirmed-zero read (the same bar `permissionDenied`
 * already set), a few seconds of registration lag racing a 3s poll interval
 * is a narrow window, and the remedy is one more `apply` run — no different
 * from re-running today after registering a runner that missed the window
 * entirely. A retry-budget for this ONE case would reintroduce exactly the
 * "wait for something that might not be worth waiting for" shape this issue
 * exists to remove, for a race this narrow.
 *
 * **The missing-token refusal must OBSERVE before it refuses
 * (groundnuty/macf#1195).** Through #1195, {@link publishTrustedActorsGated}'s
 * missing-token branch was a BLANKET refusal — `runnerToken === undefined`
 * short-circuited straight to `failedOutcomesFor(repos, noRunnerTokenReason())`
 * with `checkRunnerUsableByRepo` never called at all, even though
 * `RoutingApplyDeps` has carried that exact live-observation seam since
 * macf#922. Live-verified regression: a fleet (`macf-trial`) whose runners
 * were confirmed registered and available (`GET /runners/... → ok=true,
 * available=1`, moments earlier, via `#943`'s own provisioning call) still
 * had `MACF_TRUSTED_ACTORS` refused on every repo, purely because
 * `--runner-token` was absent — the operator's own framing: "the runners
 * exist. Nothing looked." The token was never load-bearing for USE, only
 * for REGISTRATION (macf#929's "token = POLICY, detection = TIMING" split
 * already said this in words; the code didn't act on it for the
 * runner-ALREADY-usable case).
 *
 * **The fix:** the missing-token branch now performs exactly ONE
 * `checkRunnerUsableByRepo` read per repo — the SAME seam every other path
 * in this module already uses, never a second query path — and writes the
 * var for any repo confirmed `presence: 'present'`. A repo NOT confirmed
 * present still refuses (`'failed'`, macf#993's bar unchanged), but the
 * refusal reason now names the OBSERVED cause (confirmed-absent /
 * could-not-confirm / created-this-run-so-none-could-have-registered — see
 * {@link noUsableRunnerWithoutTokenReason}) rather than the flag alone.
 * Deliberately NO poll in this branch even for a repo that IS usable-soon:
 * {@link pollForUsableRunner}'s retry loop exists to give a runner time to
 * finish REGISTERING, and only a supplied token licenses `apply` to wait for
 * that (macf#929) — a single immediate read is the honest amount of work to
 * do when nothing authorized a wait. `justCreatedRepos` is threaded into the
 * message choice ONLY (never into a retry decision) — see
 * `apply-fleet.ts`'s call site, which passes the SAME
 * `justCreatedReposStillFast` set regardless of whether a token was
 * resolved.
 */
import type { EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated } from './ensure-variable.js';
import type { CaApplyDeps } from './apply-ca.js';
import type { RunnerUsability } from './observer.js';
import type { FleetRouting } from './fleet-manifest.js';
import type { RunnerPlatformStatusResult } from './runner-platform.js';

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
    `(register-before-route — see macf-devops-toolkit's runner/RUNNER.md §"The security model").${detailSuffix}${handoverSuffix}`
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
 * The EARLY WARNING {@link checkRunnerTokenPreflight} shows — before ANY
 * live check is even possible (it fires before `apply` has observed a
 * single repo) — when `manifest.routing.runner` is declared
 * `runs_on: "self-hosted"` (DR-043 Amendment H) but no runner-registration
 * token was supplied via {@link RUNNER_TOKEN_FLAG} / {@link RUNNER_TOKEN_ENV_VAR}
 * (macf#929). ONE reason for every repo — same shape as
 * `apply-ca.ts::skippedCaPublish`'s single-reason-for-all-legs precedent —
 * because this is a manifest-level heads-up, not a per-repo detection
 * result. Never names a repo (nothing repo-specific to say this early) and
 * never echoes the token value (there is none to echo — this fires
 * precisely because the token is ABSENT).
 *
 * **Does NOT claim the write will actually be refused (corrected
 * groundnuty/macf#1195).** Through #1195, this text doubled as
 * {@link publishTrustedActorsGated}'s own unconditional no-token refusal, so
 * "refusing to write... to any repo" was accurate for every caller. Now that
 * the write-time gate consults live presence first (a repo with an
 * ALREADY-usable runner proceeds without a token — see
 * {@link noUsableRunnerWithoutTokenReason}), a token-absent manifest is only
 * a REQUIREMENT-FOR-REGISTERING-A-NEW-RUNNER, not a guaranteed refusal —
 * this text is worded to say exactly that, since the actual per-repo
 * outcome isn't knowable yet at this point in the flow (before `observe`
 * has even run).
 */
export function noRunnerTokenReason(): string {
  return (
    'manifest declares routing.runner (runs_on: "self-hosted") but no runner registration ' +
    'token was supplied — apply cannot REGISTER a new runner without one. A repo whose runner is ALREADY ' +
    'confirmed usable still proceeds without a token; a repo with no usable runner yet will have its ' +
    'MACF_TRUSTED_ACTORS write refused until a runner is registered directly (no token needed for that) or a ' +
    'token is supplied so this run can confirm/wait for one. Supply one via ' +
    `${RUNNER_TOKEN_FLAG} <token> (or the ${RUNNER_TOKEN_ENV_VAR} env var). Obtain a fresh registration ` +
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
 * The macf#932 PRE-FLIGHT — WARNS as early as possible, before consent gate 1
 * ever opens, not merely before the LATE gate deep inside `applyFleet`'s
 * routing block ({@link publishTrustedActorsGated}, UNCHANGED — still the
 * ONLY enforcement point; see this module's doc, "token = POLICY, detection =
 * TIMING," macf#929).
 *
 * **groundnuty/macf#1209 — this function's CALLER no longer aborts the run
 * on a non-`undefined` result.** Through #1209, `runBootstrapApply` treated
 * this as a run-aborting refusal — reachable only after `applyFleet` had
 * already driven confirm-before-create, consent gate 1, consent gate 2, and
 * repo-init for EVERY agent in the fleet (on a 3-agent fleet, six browser
 * clicks spent before an error knowable from the manifest alone), which
 * sounds like a saving — except aborting BEFORE `applyFleet` runs at all
 * ALSO discards every leg that never depended on this token: routing
 * secrets, CA legs, repo-init, vault composition. Observed live on
 * `macf-trial`: a router credential had just been merged into the vault
 * (an operator-authorised one-time decrypt) and never got published, because
 * this refusal aborted the entire run before ever reaching it. A preflight
 * that aborts the run must gate only what actually depends on the missing
 * input — this one now WARNS (`console.error`, this function's message
 * VERBATIM) and lets `runBootstrapApply` fall through to `applyFleet`
 * regardless.
 *
 * `commands/bootstrap-apply.ts::runBootstrapApply` calls this immediately
 * after parsing the manifest, before ANY observe/plan-render, so an operator
 * who forgot the flag sees the warning before spending a browser click — the
 * ONLY thing #1209 changes is that the run no longer stops there. (Contrast
 * `plan.ts::checkVaultFlagsComplete`'s sibling XOR refusal, which DOES still
 * abort the whole run — that check gates an unsatisfiable ARGUMENT PAIR with
 * no narrower dependent subset to defer to, not a declared-but-absent
 * optional credential with its own already-scoped late gate. See
 * `runBootstrapApply`'s #1209 comment for the full audit.)
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
 * Reuses {@link noRunnerTokenReason}'s message VERBATIM — exactly ONE place
 * this early-warning text is authored, so an operator who's seen it before
 * recognizes it instantly. **Not, post-groundnuty/macf#1195, the SAME text
 * the late gate's own refusal shows** — the late gate
 * ({@link publishTrustedActorsGated}) now speaks per-repo, evidenced by a
 * live check ({@link noUsableRunnerWithoutTokenReason} /
 * {@link runnerTokenPollExhaustedReason} / sibling reason functions), because
 * by the time it runs it KNOWS what this pre-flight cannot yet know.
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
    `role/repo "${repo}": a runner registration token was supplied but the repo-scoped runner list was ` +
    'refused outright (HTTP 403) — failing immediately, WITHOUT retrying, because a permission gap cannot resolve ' +
    'itself given more time. MACF_TRUSTED_ACTORS was NOT written. ' +
    "Listing a repo's registered runners is FLEET authority, not agent authority — re-run " +
    '`macf bootstrap apply` with a runner-registration token (and, if this run used the agent identity\'s own ' +
    'installation token for the underlying `gh` auth, with an identity holding "administration: read" on this ' +
    `repo).${detailSuffix}${handoverSuffix}`
  );
}

/**
 * The reason text for the groundnuty/macf#943 FAST-FAIL path — a CONFIRMED
 * zero-runners-anywhere read (`usability.neverRegistered === true`), the
 * third state a bare `presence: 'absent'` could not distinguish from
 * "something is registering" before this fix. Sibling of
 * {@link runnerPermissionDeniedReason}: SAME "no wait happened, don't claim
 * one" discipline ({@link runnerJustCreatedRepoReason}'s doc explains why a
 * message describing work the program did not do is the dishonesty this
 * catalog exists to prevent) — this text never mentions a poll window
 * either, because {@link pollForUsableRunner} exits before ever waiting.
 *
 * **User-facing text — plain words, no internal issue/DR references
 * (groundnuty/macf#1061).** Every OTHER reason function in this module still
 * predates that ruling; this one is written to it directly, since it is new.
 *
 * **Status note (groundnuty/macf#993, unchanged by this function):**
 * {@link publishTrustedActorsGated} pairs this text with `status: 'failed'`,
 * same bar as every other non-present routing outcome.
 */
export function runnerNeverRegisteredReason(repo: string, usability: RunnerUsability): string {
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `role/repo "${repo}": no runner is registered for this repository, at either the repo or the organization ` +
    'level, and this tool does not provision one for you yet. MACF_TRUSTED_ACTORS was NOT written; this repo ' +
    'continues routing on ubuntu-latest (billed on private repos). Register a self-hosted runner for this repo ' +
    "(or the organization), or change `runs_on` in the fleet manifest, then re-run `macf bootstrap apply`." +
    `${detailSuffix}${handoverSuffix}`
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
    `role/repo "${repo}": a runner registration token was supplied but ${cause} — ` +
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
    `role/repo "${repo}": a runner registration token was supplied but ${cause} within the ` +
    `${String(Math.round(timeoutMs / 1000))}s poll window — MACF_TRUSTED_ACTORS was NOT written; this repo ` +
    'routes on hosted runners (billed on private repos) until a runner is confirmed. Re-run `macf bootstrap ' +
    `apply\` once it is registered.${detailSuffix}${handoverSuffix}`
  );
}

/**
 * The reason text for the groundnuty/macf#1195 NO-TOKEN branch of
 * {@link publishTrustedActorsGated} — `repo` was checked exactly ONCE (never
 * polled: no token means nothing licenses a wait, see this module's
 * top-level #1195 paragraph) and the read did NOT confirm a usable runner.
 *
 * Three distinct causes, each worded differently so the operator never reads
 * more confidence than `apply` actually has:
 *
 * - `usability.presence === 'unknown'` — the read itself failed (auth /
 *   network / insufficient scope); same "could not confirm" framing every
 *   other reason function in this module uses for the identical state.
 * - `justCreated === true` (this repo is in the caller's `justCreatedRepos`
 *   set) — a repo minted THIS run cannot have a runner registered to it by
 *   anything that happened before this run (`apply-routing.ts:91-93`,
 *   macf#972) — that is NOT evidence the fleet has no runner, only that
 *   THIS repo is too new to have one yet, so the wording says exactly that
 *   rather than the plain "confirmed absent" claim.
 * - otherwise — an ordinary confirmed-absent read on a pre-existing repo.
 *
 * Every branch names {@link RUNNER_TOKEN_FLAG} / {@link RUNNER_TOKEN_ENV_VAR}
 * / the `gh api` registration-token command (same remedy
 * {@link noRunnerTokenReason} already names) ALONGSIDE the direct-register
 * remedy — a repo with no usable runner and no token has two honest paths
 * forward: register a runner and re-run with no token needed, or supply a
 * token now so THIS run can confirm/wait for one. Never claims a poll
 * happened (no "within the Ns poll window" language) — that would describe
 * work this branch did not do, the same dishonesty
 * {@link runnerJustCreatedRepoReason}'s doc names for the sibling
 * fast-path case.
 */
export function noUsableRunnerWithoutTokenReason(repo: string, usability: RunnerUsability, justCreated: boolean): string {
  const cause =
    usability.presence === 'unknown'
      ? 'could not confirm whether a self-hosted runner is registered (auth / network / insufficient scope)'
      : justCreated
        ? 'no self-hosted runner is registered yet — this repo was created during THIS run, so none can have registered on its own'
        : 'no self-hosted runner is confirmed registered';
  const detailSuffix = usability.detail !== undefined ? ` ${usability.detail}` : '';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `role/repo "${repo}": no runner registration token was supplied and ${cause} — MACF_TRUSTED_ACTORS was NOT ` +
    'written; this repo continues routing on ubuntu-latest (billed on private repos). Register a self-hosted ' +
    'runner for this repo (or the organization) and re-run `macf bootstrap apply` — no token is needed once a ' +
    `runner is visible — or supply one now via ${RUNNER_TOKEN_FLAG} <token> (or the ${RUNNER_TOKEN_ENV_VAR} env ` +
    'var) so this run can confirm/wait for it. Obtain a fresh registration token with: gh api -X POST ' +
    `/orgs/<org>/actions/runners/registration-token --jq .token.${detailSuffix}${handoverSuffix}`
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
   *
   * A 4th, OPTIONAL `platformStatus` param (groundnuty/macf#1212) is passed
   * ONLY by `publishTrustedActorsForProvisioned` — the runner-platform's own
   * advisory status read for the SAME progress tick (see that function's
   * doc). {@link pollForUsableRunner}'s own call sites never pass it
   * (they have no platform-status seam); a caller that ignores the 4th arg
   * — every pre-#1212 implementation — is unaffected.
   */
  readonly onProgress?: (repo: string, elapsedMs: number, totalMs: number, platformStatus?: RunnerPlatformStatusResult) => void;
  /** Injectable clock — default `Date.now`. Test-only; production never overrides this. */
  readonly now?: () => number;
  /** Injectable wait primitive — default a real `setTimeout`-based sleep. Test-only; production never overrides this. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /**
   * groundnuty/macf#943 — suppresses {@link pollForUsableRunner}'s
   * `neverRegistered` fast-exit for ONE call. Set (per-repo, by
   * `publishTrustedActorsGated`'s new `justProvisionedRepos` param) when
   * THIS run's `provisionRunner` call for this repo returned `'ok'` — a
   * confirmed-zero read at t=0 is then EXPECTED (the contract's own
   * documented ~15s registration lag), not evidence the repo will never have
   * a runner. `permissionDenied`'s fast-exit is UNCHANGED by this flag — a
   * 403 is an authorization fact, orthogonal to provisioning timing. Default
   * `false`/unset (every pre-existing caller): the fast-exit fires exactly
   * as before this option existed.
   */
  readonly suppressNeverRegisteredFastExit?: boolean;
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
 *
 * **groundnuty/macf#943 — fails FAST on a confirmed zero-runners-anywhere
 * read too, the SAME shape one gate over — UNLESS this run just told the
 * runner-provisioning contract to provision one for this repo.** A
 * `usability.neverRegistered === true` result (see `observer.ts::
 * RunnerUsability.neverRegistered`'s doc) exits the loop on THIS SAME check,
 * before `sleepFn`, for the SAME reason `permissionDenied` does: a
 * confirmed-empty runner registry cannot populate itself by being polled
 * again on the SAME cadence this tool controls — ordinarily, nothing `apply`
 * does provisions a runner in-band.
 *
 * **That premise is conditionally false as of `#943`'s provisioning call.**
 * `opts.suppressNeverRegisteredFastExit` (set by `publishTrustedActorsGated`
 * when THIS repo's `provisionRunner` call returned `'ok'` THIS run) disables
 * the fast-exit for that ONE call: a confirmed-zero read immediately after a
 * successful provision is the EXPECTED shape (the contract's own documented
 * ~15s Kubernetes-to-GitHub registration lag), not evidence of a permanently
 * empty repo, so the poll falls through to the ordinary retry-with-sleep
 * path instead — giving that lag genuine time to resolve. A repo this run
 * did NOT successfully provision (endpoint unconfigured, unreachable,
 * contract/cluster error, or a pre-existing repo whose confirmed-zero read
 * really does mean "nothing is coming") keeps the UNCHANGED fast-exit. A
 * repo with SOMETHING registered (found-but-not-yet-online, found-but-
 * excluded-from-a-visible-group) never sets `neverRegistered` and keeps
 * polling exactly as before, independent of this flag.
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
    // groundnuty/macf#943 — a CONFIRMED zero-runners-anywhere read is not
    // "not there yet" either, ORDINARILY; it is "nothing here, and nothing
    // in `apply` creates one." Same fail-fast shape as `permissionDenied`
    // immediately above, on the SAME first check, before `sleepFn` — a
    // confirmed-empty registry cannot populate itself between one poll tick
    // and the next by the mere act of asking again. A repo that HAS
    // something registered (offline, still registering, excluded from a
    // group) never sets this flag — see `RunnerUsability.neverRegistered`'s
    // doc — so that case is UNCHANGED and keeps polling to the full budget
    // exactly as before this fix.
    //
    // `suppressNeverRegisteredFastExit` (see that option's doc) disables
    // exactly this exit for a repo THIS run's provisioning call reported
    // `'ok'` for — "nothing in apply creates one" is conditionally false now,
    // and a confirmed-zero read moments after a successful provision is the
    // ~15s registration lag the contract itself documents, not a permanent
    // fact.
    if (usability.neverRegistered === true && opts.suppressNeverRegisteredFastExit !== true) return usability;
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
 * The groundnuty/macf#1195 no-token branch of {@link publishTrustedActorsGated}
 * — extracted so the token-supplied poll path above stays exactly the shape
 * macf#929 left it (no branching added to that loop), and so this function's
 * own single-check contract is independently readable/testable.
 *
 * Per repo: ONE `checkRunnerUsableByRepo` read, never
 * {@link pollForUsableRunner} — no token means nothing licenses a wait (see
 * this module's top-level #1195 paragraph for the full "why"). `'present'`
 * writes the var via {@link writeTrustedActorsVar}, the SAME write primitive
 * every other caller in this module uses. Anything else is `'failed'` with
 * {@link noUsableRunnerWithoutTokenReason} — `justCreatedRepos` is consulted
 * ONLY to pick accurate wording (a repo minted this run isn't "confirmed
 * absent" evidence, macf#972), never to change WHETHER this function checks
 * or waits — every repo in `repos` gets the identical single-check
 * treatment regardless of that set's membership.
 *
 * A throwing `checkRunnerUsableByRepo` is `'failed'` (a wiring bug), isolated
 * to that repo's entry — mirrors {@link publishTrustedActors} and the
 * token-supplied path's own per-repo try/catch.
 *
 * NEVER throws.
 */
async function publishTrustedActorsWithoutToken(
  value: string,
  repos: readonly string[],
  deps: RoutingApplyDeps,
  justCreatedRepos: ReadonlySet<string> | undefined,
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
    if (usability.presence === 'present') {
      out[repo] = await writeTrustedActorsVar(repo, value, deps);
      continue;
    }
    out[repo] = {
      status: 'failed',
      reason: noUsableRunnerWithoutTokenReason(repo, usability, justCreatedRepos?.has(repo) === true),
    };
  }
  return out;
}

/**
 * The macf#929 production entrypoint — `apply-fleet.ts`'s ACTUAL call site
 * (supersedes `publishTrustedActors`, see that function's doc). Splits the
 * register-before-route gate into a POLICY half and a TIMING half:
 *
 * - **POLICY (`runnerToken`):** `undefined`/empty → **does NOT refuse
 *   outright** (corrected groundnuty/macf#1195 — see this module's
 *   top-level #1195 paragraph for the live-observed regression this fixes).
 *   Each repo gets exactly ONE `checkRunnerUsableByRepo` read (never a
 *   poll — see below); `presence: 'present'` writes the var exactly as the
 *   token-supplied path does, because a token was never needed to USE an
 *   already-usable runner, only to REGISTER a new one (macf#929's "token =
 *   POLICY, detection = TIMING" split, taken to its actual conclusion). A
 *   repo NOT confirmed present still refuses, `'failed'`
 *   ({@link noUsableRunnerWithoutTokenReason}, distinguishing confirmed-
 *   absent / could-not-confirm / created-this-run so the message never
 *   overclaims). The token itself is NEVER read past this per-repo check
 *   when present — it licenses WAITING (the poll below), never USING,
 *   which is why its absence no longer forecloses a repo whose runner is
 *   already there (macf#929 requirement 4: "detection stays exactly as
 *   macf#927 left it" — this fix is exactly that promise, finally applied
 *   to the no-token branch too).
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
 * **`justProvisionedRepos` (groundnuty/macf#943, DR-043 Amendment I2) —
 * disables `pollForUsableRunner`'s `neverRegistered` fast-exit for a repo
 * THIS run's `runner-platform.ts::provisionRunner` call reported `'ok'`
 * for.** Independent of `justCreatedRepos` above (a repo can be BOTH
 * pre-existing and freshly provisioned, or newly created and freshly
 * provisioned — the two sets are not required to be disjoint or related):
 * whichever repos land in the poll path (`!justCreatedRepos.has(repo)`), a
 * confirmed-zero read on the very first check would otherwise fast-exit
 * before the runner platform's own documented ~15s Kubernetes-to-GitHub
 * registration lag has any chance to resolve — turning a successful
 * provision into an immediate, guaranteed failure. See
 * {@link RunnerTokenPollOptions.suppressNeverRegisteredFastExit}'s doc for
 * the mechanism. `undefined` (every pre-#943 caller) behaves identically to
 * before — the fast-exit fires unconditionally, matching macf#943's OWN
 * original (now-corrected) behavior for a poll this option didn't exist to
 * qualify.
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
  justProvisionedRepos?: ReadonlySet<string>,
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  if (runnerToken === undefined || runnerToken.length === 0) {
    // groundnuty/macf#1195 — no token no longer means "refuse without
    // looking." See `publishTrustedActorsWithoutToken`'s doc + this
    // function's own #1195 POLICY bullet above.
    return publishTrustedActorsWithoutToken(value, repos, deps, justCreatedRepos);
  }

  const timeoutMs = pollOptions.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = pollOptions.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const nowFn = pollOptions.now ?? Date.now;
  const deadline = nowFn() + timeoutMs;

  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const remaining = Math.max(0, deadline - nowFn());
    // macf#972 — "poll only when a runner is plausibly imminent": a repo
    // CREATED THIS RUN and NOT successfully provisioned THIS RUN cannot
    // plausibly have a runner registered yet, so waiting the full deploy
    // window for one waits on a step nobody was asked to perform. A repo
    // that PRE-EXISTED this run, OR was successfully provisioned THIS run
    // (macf#943 — see `justProvisionedRepos`'s doc), may legitimately be
    // mid-registration — it still gets the real poll.
    const pollJustified = justCreatedRepos?.has(repo) !== true;
    const justProvisioned = justProvisionedRepos?.has(repo) === true;
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
            suppressNeverRegisteredFastExit: justProvisioned,
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
      //
      // groundnuty/macf#943 — `neverRegistered` wins over the ORDINARY
      // poll-exhausted branch ONLY when `pollJustified === true` AND this
      // repo was NOT `justProvisioned`: on that combination
      // `pollForUsableRunner` exits on the FIRST check for this flag (see
      // its doc), so `runnerTokenPollExhaustedReason`'s "within the Ns poll
      // window" claim would be dishonest — no wait happened. A `justProvisioned`
      // repo took the OPPOSITE path (`suppressNeverRegisteredFastExit`
      // disabled the fast-exit, so a `neverRegistered` result here means the
      // poll genuinely WAITED the full budget and the runner still never
      // registered) — `runnerTokenPollExhaustedReason` is the HONEST framing
      // for that case, not `runnerNeverRegisteredReason` (whose "this tool
      // does not provision one for you yet" clause would be false: it just
      // tried). The `justCreatedRepos` fast path (`!pollJustified`)
      // deliberately keeps its OWN `runnerJustCreatedRepoReason` even when
      // `neverRegistered` is ALSO true (it almost always is, for a repo this
      // run itself created and never successfully provisioned) — that text
      // already explains WHY zero is expected ("created during THIS run")
      // more precisely than the generic never-registered wording would, and
      // downgrading it would lose that specificity for no gain.
      out[repo] = {
        status: 'failed',
        reason:
          usability.permissionDenied === true
            ? runnerPermissionDeniedReason(repo, usability)
            : pollJustified
              ? usability.neverRegistered === true && !justProvisioned
                ? runnerNeverRegisteredReason(repo, usability)
                : runnerTokenPollExhaustedReason(repo, usability, timeoutMs)
              : runnerJustCreatedRepoReason(repo, usability),
      };
      continue;
    }
    out[repo] = await writeTrustedActorsVar(repo, value, deps);
  }
  return out;
}

// --- groundnuty/macf#1212 — apply requested this runner; it waits ---
//
// **Operator ruling, overriding #929/#1195's "token licenses waiting"
// split for exactly this case.** #1195 (immediately above) is unchanged and
// correct for a repo `apply` did NOT provision this run — no token still
// means one honest immediate check, never a wait, because nothing this run
// did licenses one. A repo THIS run successfully told `runner-platform.ts::
// provisionRunner` to create is different: `apply` itself is the reason a
// runner may be mid-registration, so whether `--runner-token` was ALSO
// supplied is irrelevant to whether `apply` waits for something it itself
// asked for. `apply-fleet.ts`'s call site routes exactly this set of repos
// here — and ONLY this set; every other repo still goes through
// {@link publishTrustedActorsGated} untouched, so the #929/#1195 dispatch
// for the ordinary (not-provisioned-this-run) case is byte-unchanged.
//
// **Readiness stays GitHub-side, deliberately** — this function polls
// `deps.checkRunnerUsableByRepo` (the SAME `observer.ts` seam every other
// path in this module already uses) to decide when to write the var, never
// the runner-platform's own `available` count. `runner-platform.ts`'s own
// header warns why: "a pod can be running while GitHub has no usable runner
// registered... confirm against GitHub before you route." The platform's
// `GET /runners/{owner}/{repo}` read (`checkRunnerPlatformStatus`, injected
// optionally) is consulted ONLY for (a) progress narration content — the
// operator's own ruling: "the runner's actual state... GET /runners/…
// returns available; show it" — and (b) a narrow terminal fast-exit when
// the platform reports a confirmed, non-recoverable failure
// (`RunnerPlatformStatusResult.status === 'failed'`, e.g.
// `FailedUpdateRegistrationToken` — "this is not a startup delay; polling
// will not clear it"). Any OTHER platform read (unreachable/not-configured/
// unparseable, surfaced as `'unknown'`, or a `'starting'`/`'ready'` read
// that simply hasn't caught up with GitHub yet) never ends the wait early —
// an unrecognized or advisory-only shape can only ever cost a bounded wait
// and an honest `'pending'`, never fabricate a `'failed'` the GitHub-side
// check didn't itself confirm.
//
// **`'pending'`, never `'failed'`, on timeout — the heart of the ruling.**
// The operator's own words: "we cannot report an error... because it
// sounds like the user's problem." A repo whose runner this run legitimately
// requested and is still converging is NOT the same fact as macf#993's "a
// declared runner is REQUIRED and none was ever registered" — so this
// function's timeout branch produces `EnsureVariableOutcome`'s NEW
// `'pending'` status (see that type's doc), which `applyExitCode`
// (`bootstrap-apply.ts`) does not treat as a run-failing outcome, matching
// `#1210`'s "gates only runner-dependent work" scoping: nothing about a
// pending routing-var write aborts CA/routing-secrets/repo-init/vault legs,
// and nothing about it fails the run outright either — only the ONE write
// this repo's runner licenses stays undone, honestly reported.
//
// **One shared deadline across every repo passed in**, same pattern
// {@link publishTrustedActorsGated}'s token-supplied branch already
// established: `repos.length` repos share ONE bounded budget, not
// `repos.length` independent windows — a multi-agent fleet's worst case
// stays one wait, not N.

/** The text {@link publishTrustedActorsForProvisioned} shows while it waits — the operator's own requirement ("the runner's actual state... GET /runners/… returns available; show it"), not a content-free elapsed-time-only line. `platformStatus === undefined` (endpoint not configured, or the injected check wasn't supplied) degrades to naming that honestly rather than inventing a number. */
export function formatProvisionedRunnerWaitProgress(repo: string, elapsedMs: number, totalMs: number, platformStatus?: RunnerPlatformStatusResult): string {
  const state =
    platformStatus === undefined
      ? 'no runner-platform status available'
      : platformStatus.status === 'ready' || platformStatus.status === 'starting'
        ? `runner platform reports ${String(platformStatus.available)} available`
        : platformStatus.status === 'failed'
          ? `runner platform reports a failure: ${platformStatus.reason}`
          : `runner platform status unknown — ${platformStatus.reason}`;
  return (
    `waiting for the runner requested THIS run to become usable for "${repo}" … ` +
    `${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(totalMs / 1000))}s elapsed; ${state}`
  );
}

/** The `'pending'` reason text for a repo `apply` provisioned this run whose bounded wait expired before GitHub confirmed a usable runner — honest incomplete, not a failure (see this section's doc, "the heart of the ruling"). States the elapsed/budget the operator's requirement calls for ("on timeout... report pending with the elapsed budget and what to do"). */
export function runnerStillProvisioningReason(repo: string, elapsedMs: number, timeoutMs: number): string {
  return (
    `role/repo "${repo}": a self-hosted runner was requested for this repo THIS run and has not yet become ` +
    `usable to GitHub within the ${String(Math.round(elapsedMs / 1000))}s this run waited (budget ` +
    `${String(Math.round(timeoutMs / 1000))}s) — MACF_TRUSTED_ACTORS was NOT written; this repo continues ` +
    'routing on ubuntu-latest (billed on private repos) in the meantime. This is expected provisioning ' +
    'latency, not a failure — re-run `macf bootstrap apply` once the runner is up, or `macf bootstrap status` ' +
    'to check progress without re-provisioning anything.'
  );
}

/** The `'failed'` reason text for a repo whose runner-platform status read confirmed a TERMINAL failure (`RunnerPlatformStatusResult.status === 'failed'`) during the wait — a genuine problem, distinct from `'pending'` (see this section's doc). Never claims a wait ran the full budget: this path exits on the FIRST platform read that confirms the failure. */
export function runnerProvisioningTerminalFailureReason(repo: string, failure: { readonly reason: string; readonly message: string }): string {
  return (
    `role/repo "${repo}": the runner-provisioning platform reports a TERMINAL failure for this repo's runner — ` +
    `${failure.reason} (${failure.message}). This is not a startup delay; polling will not clear it. ` +
    'MACF_TRUSTED_ACTORS was NOT written; this repo continues routing on ubuntu-latest (billed on private ' +
    'repos) until the underlying provisioning problem is fixed (commonly: the fleet\'s GitHub App is not ' +
    'installed on the repo owner, so no registration token can be minted) and `macf bootstrap apply` is re-run.'
  );
}

/** {@link publishTrustedActorsForProvisioned}'s deps — the SAME `RoutingApplyDeps` write/readiness seam every other publisher in this module uses, plus the OPTIONAL, advisory-only platform-status read (see this section's doc for why it's optional and never the readiness gate). */
export type ProvisionedRunnerWaitDeps = RoutingApplyDeps & {
  readonly checkRunnerPlatformStatus?: (repo: string) => Promise<RunnerPlatformStatusResult>;
};

/**
 * The macf#1212 production entrypoint for repos `apply` successfully told
 * `runner-platform.ts::provisionRunner` to create THIS run — see this
 * section's top-of-block doc for the full "why unconditional, why
 * GitHub-side readiness, why `'pending'` not `'failed'`" narrative.
 * `apply-fleet.ts`'s call site passes ONLY `provisionedNowRepos`; every
 * other confirmed repo goes through {@link publishTrustedActorsGated}
 * unchanged, so the two functions never poll the SAME repo twice.
 *
 * Per repo, in order, sharing ONE deadline across `repos`:
 *   1. `deps.checkRunnerUsableByRepo(repo)` — `'present'` writes the var via
 *      {@link writeTrustedActorsVar} and moves to the next repo with ZERO
 *      sleep (the macf#1212 decisive-pair case 2: a runner already usable
 *      on entry, whether a genuinely fresh run or a re-run observing a
 *      PRIOR run's provisioning having since landed, waits not at all —
 *      indistinguishable in code from case 1, which IS the resume property
 *      the issue names as the point of the whole exercise).
 *   2. `deps.checkRunnerPlatformStatus?.(repo)` (if supplied) — a
 *      `'failed'` result exits immediately with
 *      {@link runnerProvisioningTerminalFailureReason}, NEVER waiting out
 *      the remaining budget for a state the platform itself says polling
 *      cannot clear. Any other result is advisory-only (progress content).
 *   3. Budget exhausted → {@link runnerStillProvisioningReason}, status
 *      `'pending'`.
 *   4. Otherwise sleep `pollIntervalMs` (capped by remaining budget) and
 *      repeat.
 *
 * A throwing `checkRunnerUsableByRepo`/`checkRunnerPlatformStatus` is
 * `'failed'` (a wiring bug, isolated to that repo's entry) — mirrors every
 * other publisher in this module. NEVER throws.
 */
export async function publishTrustedActorsForProvisioned(
  value: string,
  repos: readonly string[],
  deps: ProvisionedRunnerWaitDeps,
  pollOptions: RunnerTokenPollOptions = {},
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  const timeoutMs = pollOptions.timeoutMs ?? DEFAULT_RUNNER_POLL_TIMEOUT_MS;
  const pollIntervalMs = pollOptions.pollIntervalMs ?? DEFAULT_RUNNER_POLL_INTERVAL_MS;
  const progressIntervalMs = pollOptions.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const nowFn = pollOptions.now ?? Date.now;
  const sleepFn = pollOptions.sleepFn ?? sleep;
  const deadline = nowFn() + timeoutMs;

  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const start = nowFn();
    let lastProgressAt = start;
    try {
      for (;;) {
        const usability = await deps.checkRunnerUsableByRepo(repo);
        if (usability.presence === 'present') {
          out[repo] = await writeTrustedActorsVar(repo, value, deps);
          break;
        }
        let platformStatus: RunnerPlatformStatusResult | undefined;
        if (deps.checkRunnerPlatformStatus !== undefined) {
          platformStatus = await deps.checkRunnerPlatformStatus(repo);
          if (platformStatus.status === 'failed') {
            out[repo] = { status: 'failed', reason: runnerProvisioningTerminalFailureReason(repo, platformStatus) };
            break;
          }
        }
        const elapsedNow = nowFn();
        const remaining = deadline - elapsedNow;
        if (remaining <= 0) {
          out[repo] = { status: 'pending', reason: runnerStillProvisioningReason(repo, elapsedNow - start, timeoutMs) };
          break;
        }
        if (pollOptions.onProgress !== undefined && elapsedNow - lastProgressAt >= progressIntervalMs) {
          pollOptions.onProgress(repo, elapsedNow - start, timeoutMs, platformStatus);
          lastProgressAt = elapsedNow;
        }
        await sleepFn(Math.min(pollIntervalMs, remaining));
      }
    } catch (err) {
      out[repo] = { status: 'failed', reason: `runner-usability/platform-status check threw for "${repo}" — ${errMessage(err)}` };
    }
  }
  return out;
}
