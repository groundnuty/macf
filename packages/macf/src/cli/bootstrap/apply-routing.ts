/**
 * `MACF_ROUTING_RUNS_ON` write — DR-043 §D1 / Amendment D phase 2 (groundnuty/
 * macf#838), retiring the `plan.ts::APPLY_UNIMPLEMENTED_REASONS.routing`
 * create-verb gap (macf#854): "apply has no routing-provisioning step at
 * all."
 *
 * §D1: "`runs_on` → `MACF_ROUTING_RUNS_ON` var on every caller repo." Per
 * `observer.ts::githubRegistryObserver`'s doc, EVERY agent repo is a routing
 * caller and the `<fleet>-control` repo is NEVER one (it doesn't run
 * `agent-router.yml`) — `apply-fleet.ts` passes this function the same
 * `confirmedRepos` list (agent repos only) it builds for
 * `apply-ca.ts::publishCaCertLegs`'s repo legs, never the control repo.
 *
 * **Create-only — `update` stays un-actioned (macf#838 Phase 2b review).**
 * `plan.ts::routingItem` can emit an `update` verb when an observed value
 * DIVERGES from the manifest's declared `runs_on` (per-repo drift is
 * possible; different agent repos can independently disagree). This module
 * does NOT compare values or overwrite a present variable — it only
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

/** The GitHub Actions variable name the v3 router reads (`macf-actions`'s `route-*` jobs) — matches `observer.ts`'s read of the same name. */
export const ROUTING_RUNS_ON_VAR = 'MACF_ROUTING_RUNS_ON';

/**
 * Same repo-write shape `apply-ca.ts::CaApplyDeps` already carries for its
 * repo legs — a `Pick`, not a fresh interface, so `apply-fleet.ts` can thread
 * ONE `trustDeps: CaApplyDeps` field through both this module and
 * `apply-ca.ts` (task requirement: reuse, no separate seam to keep in sync).
 */
export type RoutingApplyDeps = Pick<CaApplyDeps, 'checkRepoPresence' | 'createRepoVariable'>;

/**
 * Create-only write of `MACF_ROUTING_RUNS_ON=<runsOn>` to every repo in
 * `repos` (already-ensured agent repos — see module doc). NEVER throws; a
 * per-repo failure is isolated to that repo's entry in the returned map.
 */
export async function publishRoutingRunsOn(
  runsOn: string,
  repos: readonly string[],
  deps: RoutingApplyDeps,
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    out[repo] = await ensureVariableCreated(
      {
        checkPresence: () => deps.checkRepoPresence(repo, ROUTING_RUNS_ON_VAR),
        create: () => deps.createRepoVariable(repo, ROUTING_RUNS_ON_VAR, runsOn),
      },
      `routing var "${ROUTING_RUNS_ON_VAR}" on "${repo}"`,
    );
  }
  return out;
}
