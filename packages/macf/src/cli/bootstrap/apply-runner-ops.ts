/**
 * The runner-ops App — a SECOND, minimal GitHub App per fleet whose
 * only job is minting self-hosted-runner registration tokens (groundnuty/
 * macf#943, operator-settled design — DR-043 amendment still being drafted;
 * this module implements exactly the settled brief, no invented shape).
 *
 * **Why a second App, not a widened agent App.** DR-019's permission set has
 * no `administration` at all. Widening DR-019 to add it was REJECTED
 * outright: `administration:write` on an installation token grants
 * `DELETE /repos/{owner}/{repo}` (verified against GitHub's REST permissions
 * reference) — every agent App in every fleet would gain the power to delete
 * its own repositories, with the key materialized on the agent's VM at
 * launch. That is flatly against the operator's standing directive that repo
 * deletion must never be easy, and against Amendment G's teardown-ladder
 * design (deletion is a deliberate, measured-cost operator act, never an
 * ambient capability). So this is a NEW, NARROW identity — `<fleet>-runner-
 * runner-ops credential` — that exists for exactly one purpose and carries exactly the
 * three permissions that purpose needs.
 *
 * **This module supplies the PURE pieces** (permission set, manifest
 * builder, handle derivation, the name-length pre-flight). Post-install
 * `repository_selection` validation moved to the shared `install-scope.ts`
 * (groundnuty/macf#1128 — every App type uses the SAME check now, not a
 * runner-ops-specific copy). The ORCHESTRATION — when in the run this App gets created,
 * how its credential folds into the SAME batched vault write as the fleet's
 * agents, when its recovery artifact gets deleted — lives in `apply-fleet.ts`
 * (its own module doc's "Recovery-artifact lifecycle" section already
 * documents that ownership split for the CA/routing-client ceremonies; the
 * runner-ops follows the identical shape, reusing `apply-agent.ts`'s
 * `applyIdentity` primitive rather than a parallel gate-1/gate-2
 * implementation — see that module's `IdentityRequest` doc).
 */
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { GitHubAppManifest } from './app-manifest.js';
import { buildAppManifest } from './app-manifest.js';
import type { AgentApplyOutcome, IdentityRequest } from './apply-agent.js';
import { deriveRouterAppHandle } from './apply-router-app.js';

/** The reserved `role` this App is derived + recorded under — never declared in `fleet.yaml`'s `agents[]` (that array is coordination agents only; `FleetManifestSchema` has no knowledge of this role at all). */
export const RUNNER_OPS_ROLE = 'runner-ops';

/**
 * Whether THIS fleet actually needs a runner-ops App (groundnuty/macf#1083).
 * Its sole purpose is minting self-hosted-runner registration tokens — a
 * fleet that never declares `routing.runner.runs_on: self-hosted` has
 * nothing for it to do, so minting one anyway is an unrequested
 * `administration:write` credential (DR-019 quarantines that permission from
 * every agent App for exactly this reason) plus 2 spent operator
 * consent-gate clicks nobody asked for.
 *
 * Mirrors the EXACT condition `apply-fleet.ts`'s `routing`-var-write gate
 * (macf#922) and `plan.ts`'s `routingItem` already use for "does this
 * fleet's runner class require the self-hosted machinery" — one predicate,
 * reused at both call sites, never a second hand-rolled copy that could
 * drift from it. An undeclared `routing:` section and a declared-but-not-
 * `"self-hosted"` one are the SAME "no" answer here (`FleetRoutingSchema`'s
 * `runner.runs_on` is a free string in v0 — anything other than the literal
 * `"self-hosted"`, including a future non-self-hosted value, means "no
 * runner-ops needed").
 */
export function runnerOpsNeeded(manifest: FleetManifest): boolean {
  return manifest.routing?.runner !== undefined && manifest.routing.runner.runs_on === 'self-hosted';
}

/**
 * The runner-ops App's apply-time / plan-time outcome — {@link
 * AgentApplyOutcome} extended with ONE status only this credential can reach:
 * `'not-needed'` (groundnuty/macf#1083). Every OTHER identity (coordination
 * agents, the router App — `apply-router-app.ts`) always attempts creation
 * because its capability is unconditionally required by the fleet that
 * declared it; runner-ops is the first CONDITIONALLY-required identity, so
 * its outcome type is the one place a "correctly, deliberately never
 * attempted" status belongs. Widening the shared `AgentApplyOutcome` union
 * instead would force every OTHER identity's exhaustive `switch` (routing
 * agents, the router App, `apply-agent.ts` itself) to account for a status
 * they can never reach.
 */
export type RunnerOpsApplyOutcome = AgentApplyOutcome | { readonly role: string; readonly status: 'not-needed'; readonly reason: string };

/**
 * **EXPORT-CLASS credential, ONE-WAY-RATCHET permission set (groundnuty/
 * macf#943's binding constraint).** This key eventually leaves the fleet's
 * normal trust boundary entirely — it is handed to the runner platform and
 * stored in a cluster Secret, readable by more parties than an agent App's
 * key ever is (an agent's key stays on that one agent's VM). Given that wider
 * exposure, this permission set must NEVER GROW: a future capability this
 * App's holder needs is a NEW App (its own narrow permission review), never a
 * permission bump added here. Widening this constant IS the violation the
 * ratchet exists to prevent — treat any PR touching this value as a design
 * question for the operator, not a routine permission tweak.
 *
 * Exactly the three permissions groundnuty/macf#943 specifies, no others:
 *   - `administration: write` — mints runner registration tokens
 *     (`POST /repos/{owner}/{repo}/actions/runners/registration-token` and
 *     the org-level equivalent both require this).
 *   - `actions: read` — read runner/workflow state.
 *   - `metadata: read` — GitHub's own baseline (every App implicitly needs
 *     it; listed explicitly here so the manifest sent is self-documenting
 *     rather than relying on an implicit grant).
 */
export const RUNNER_OPS_PERMISSIONS: Readonly<Record<string, string>> = {
  administration: 'write',
  actions: 'read',
  metadata: 'read',
};

/**
 * No coordination events — this App never reacts to issues/PRs/reviews (it
 * has none of the `issues`/`pull_requests`/`contents` read permissions those
 * events need; declaring them would be a manifest inconsistency for an App
 * that never coordinates).
 */
export const RUNNER_OPS_EVENTS: readonly string[] = [];

/** `deriveAppHandle(fleetName, RUNNER_OPS_ROLE)` — the ONLY place this App's handle is computed (mirrors `fleet-manifest.ts::deriveAppHandle`'s own "handle derivation, never declaration" discipline; macf#791). */
export function deriveRunnerOpsHandle(fleetName: string): string {
  return deriveAppHandle(fleetName, RUNNER_OPS_ROLE);
}

/**
 * The {@link IdentityRequest} `apply-agent.ts::applyIdentity` needs to drive
 * this App through confirm-before-create → gate 1 → gate 2 — the SAME
 * primitive every coordination agent uses, differently configured (narrower
 * permissions, no events, a homepage that isn't a per-agent repo since this
 * App has none).
 */
export function runnerOpsIdentityRequest(homepageUrl?: string): IdentityRequest {
  return {
    role: RUNNER_OPS_ROLE,
    homepageUrl,
    permissions: RUNNER_OPS_PERMISSIONS,
    events: RUNNER_OPS_EVENTS,
  };
}

/**
 * The exact App-manifest document that would be (or was) submitted for the
 * runner-ops — reuses `app-manifest.ts::buildAppManifest`'s existing
 * parameterization (macf#943 task requirement: "a second, differently-
 * configured use of that path — not a parallel implementation"). Used by
 * `commands/bootstrap-apply.ts`'s dry-run "Apps that would be created"
 * render, the same call site that already renders every agent's manifest.
 */
export function buildRunnerOpsManifest(fleetName: string, redirectUrl: string, homepageUrl?: string): GitHubAppManifest {
  return buildAppManifest({
    fleetName,
    role: RUNNER_OPS_ROLE,
    redirectUrl,
    homepageUrl,
    permissions: RUNNER_OPS_PERMISSIONS,
    events: RUNNER_OPS_EVENTS,
  });
}

/**
 * Post-gate-2 verify-then-refuse for `repository_selection` (groundnuty/
 * macf#943; generalized to every App type by groundnuty/macf#1128) —
 * **GitHub's App-manifest JSON has no field to FORCE the installed repo
 * scope at creation time**, so this can only ever be enforced by checking
 * the RESULT after the fact. The check itself, its message, and its
 * `AgentApplyDeps.validateInstall` closure builder now live in
 * `install-scope.ts` (`validateInstallRepositoryScope` /
 * `buildInstallScopeValidator`) — this App was the ONLY one this refusal
 * was wired to before #1128 generalized it to agent Apps and the router App
 * too. `apply-fleet.ts` wires `buildInstallScopeValidator(deriveRunnerOpsHandle(...))`
 * directly onto this identity's `validateInstall`; there is no
 * runner-ops-specific function here anymore.
 */

// --- Name-length pre-flight (groundnuty/macf#943) ---

/**
 * GitHub App names are globally unique and capped at 34 characters (verified
 * against the App-creation form's `maxlength` + observed rejection on a
 * longer submission). `macf-experiment-runner-ops` is 32 — the
 * documented live-fleet example that motivated this check (a slightly
 * longer fleet name would have exceeded it).
 */
export const GITHUB_APP_NAME_MAX_LENGTH = 34;

export interface AppNameLengthViolation {
  readonly name: string;
  readonly length: number;
}

export type AppNameLengthCheck = { readonly ok: true } | { readonly ok: false; readonly violations: readonly AppNameLengthViolation[]; readonly reason: string };

/**
 * Every App name THIS run would need — every declared agent's derived handle
 * PLUS the runner-ops's PLUS the router App's (groundnuty/macf#1074).
 * Pure; zero I/O. Exported so both call sites that need the identical list
 * (`commands/bootstrap-apply.ts`'s CLI-level refusal, `apply-fleet.ts`'s own
 * top-of-function refusal — see `checkAppNameLengths`'s doc for why BOTH
 * exist) derive it from one place, never two independently hand-rolled
 * lists that could drift.
 *
 * groundnuty/macf#1082 — the router handle now depends on
 * `manifest.transport.router_app_scope`: `'shared'` (default, including a
 * hand-built manifest that predates this field) resolves to the OWNER-KEYED
 * handle (`manifest.owner.account`, groundnuty/macf#1088 — this is what
 * makes the budget check below meaningful: a long owner account name is
 * exactly the case this pre-flight exists to catch, per #1090's carried-over
 * criterion, rather than a hazard this check is blind to); `'per-fleet'`
 * keeps the pre-#1082 fleet-derived handle this check was originally built
 * for.
 */
export function plannedAppNames(manifest: FleetManifest): readonly string[] {
  const fleetName = manifest.metadata.name;
  const routerScope = manifest.transport.router_app_scope === 'per-fleet' ? 'per-fleet' : 'shared';
  return [
    ...manifest.agents.map((a: FleetAgent) => deriveAppHandle(fleetName, a.role)),
    deriveRunnerOpsHandle(fleetName),
    deriveRouterAppHandle(fleetName, manifest.owner.account, routerScope),
  ];
}

/**
 * Refuse BEFORE consent gate 1 opens for ANY role, for the whole run, if any
 * planned App name exceeds GitHub's 34-char cap (groundnuty/macf#943).
 * Discovering this AT gate 1 wastes an operator click, AND — the sharper
 * reason this is a pre-flight, not a per-role runtime check — GitHub's
 * App-manifest flow reserves the submitted `name` globally the moment the
 * form POSTs, so a failed/abandoned attempt still SQUATS the too-long name
 * (or whatever disambiguated variant GitHub assigns), fouling a later retry
 * with a corrected name.
 *
 * Pure; zero I/O; safe to call before ANY provisioning step — this is what
 * lets a caller assert "the gate seam is never invoked" for a violating
 * manifest (see `apply-fleet.ts`'s call site, first statement in
 * `applyFleet`, before even the control-repo step).
 */
export function checkAppNameLengths(manifest: FleetManifest): AppNameLengthCheck {
  const violations: AppNameLengthViolation[] = [];
  for (const name of plannedAppNames(manifest)) {
    if (name.length > GITHUB_APP_NAME_MAX_LENGTH) violations.push({ name, length: name.length });
  }
  if (violations.length === 0) return { ok: true };
  const detail = violations
    .map((v) => `"${v.name}" (${String(v.length)} chars, ${String(v.length - GITHUB_APP_NAME_MAX_LENGTH)} over the limit)`)
    .join(', ');
  return {
    ok: false,
    violations,
    reason:
      `${String(violations.length)} planned GitHub App name(s) exceed the ${String(GITHUB_APP_NAME_MAX_LENGTH)}-char ` +
      `limit: ${detail}. Shorten metadata.name and/or the offending agents[].role in fleet.yaml — App names are ` +
      'globally unique, so even a failed create at gate 1 would squat the name for a later retry. Refusing before ' +
      'any consent gate opens; nothing on GitHub was touched.',
  };
}
