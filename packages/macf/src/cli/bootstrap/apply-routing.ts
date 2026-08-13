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
 */
import type { EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated } from './ensure-variable.js';
import type { CaApplyDeps } from './apply-ca.js';
import type { RunnerUsability } from './observer.js';

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
 * ordinary absence.
 */
export function noRunnerRegisteredReason(repo: string, usability: RunnerUsability): string {
  const cause =
    usability.presence === 'unknown'
      ? 'could not confirm whether a self-hosted runner is registered (auth / network / insufficient scope)'
      : 'no self-hosted runner is confirmed registered';
  const handoverSuffix = usability.handover !== undefined ? ` ${usability.handover}` : '';
  return (
    `${cause} for "${repo}" — MACF_TRUSTED_ACTORS was NOT written; this repo continues routing on ` +
    'ubuntu-latest (billed on private repos) until a runner is registered and confirmed ' +
    `(register-before-route — macf-devops-toolkit runner/RUNNER.md §"The security model"; macf#922).${handoverSuffix}`
  );
}

/**
 * Create-only write of `MACF_TRUSTED_ACTORS=<value>` to every repo in
 * `repos` (already-ensured agent repos — see module doc), gated per-repo on
 * a confirmed-registered-and-usable self-hosted runner. NEVER throws; a
 * per-repo failure (including a throwing `checkRunnerUsableByRepo`) is
 * isolated to that repo's entry in the returned map.
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
    out[repo] = await ensureVariableCreated(
      {
        checkPresence: () => deps.checkRepoPresence(repo, TRUSTED_ACTORS_VAR),
        create: () => deps.createRepoVariable(repo, TRUSTED_ACTORS_VAR, value),
      },
      `trusted-actors var "${TRUSTED_ACTORS_VAR}" on "${repo}"`,
    );
  }
  return out;
}
