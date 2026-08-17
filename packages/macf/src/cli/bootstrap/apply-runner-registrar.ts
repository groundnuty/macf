/**
 * The runner-registrar App — a SECOND, minimal GitHub App per fleet whose
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
 * registrar` — that exists for exactly one purpose and carries exactly the
 * three permissions that purpose needs.
 *
 * **This module supplies the PURE pieces** (permission set, manifest
 * builder, handle derivation, post-install validation, the name-length
 * pre-flight). The ORCHESTRATION — when in the run this App gets created,
 * how its credential folds into the SAME batched vault write as the fleet's
 * agents, when its recovery artifact gets deleted — lives in `apply-fleet.ts`
 * (its own module doc's "Recovery-artifact lifecycle" section already
 * documents that ownership split for the CA/routing-client ceremonies; the
 * runner-registrar follows the identical shape, reusing `apply-agent.ts`'s
 * `applyIdentity` primitive rather than a parallel gate-1/gate-2
 * implementation — see that module's `IdentityRequest` doc).
 */
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { GitHubAppManifest } from './app-manifest.js';
import { buildAppManifest } from './app-manifest.js';
import type { ConfirmedInstall } from './identity-confirm.js';
import type { IdentityRequest } from './apply-agent.js';

/** The reserved `role` this App is derived + recorded under — never declared in `fleet.yaml`'s `agents[]` (that array is coordination agents only; `FleetManifestSchema` has no knowledge of this role at all). */
export const RUNNER_REGISTRAR_ROLE = 'runner-registrar';

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
export const RUNNER_REGISTRAR_PERMISSIONS: Readonly<Record<string, string>> = {
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
export const RUNNER_REGISTRAR_EVENTS: readonly string[] = [];

/** `deriveAppHandle(fleetName, RUNNER_REGISTRAR_ROLE)` — the ONLY place this App's handle is computed (mirrors `fleet-manifest.ts::deriveAppHandle`'s own "handle derivation, never declaration" discipline; macf#791). */
export function deriveRunnerRegistrarHandle(fleetName: string): string {
  return deriveAppHandle(fleetName, RUNNER_REGISTRAR_ROLE);
}

/**
 * The {@link IdentityRequest} `apply-agent.ts::applyIdentity` needs to drive
 * this App through confirm-before-create → gate 1 → gate 2 — the SAME
 * primitive every coordination agent uses, differently configured (narrower
 * permissions, no events, a homepage that isn't a per-agent repo since this
 * App has none).
 */
export function runnerRegistrarIdentityRequest(homepageUrl?: string): IdentityRequest {
  return {
    role: RUNNER_REGISTRAR_ROLE,
    homepageUrl,
    permissions: RUNNER_REGISTRAR_PERMISSIONS,
    events: RUNNER_REGISTRAR_EVENTS,
  };
}

/**
 * The exact App-manifest document that would be (or was) submitted for the
 * runner-registrar — reuses `app-manifest.ts::buildAppManifest`'s existing
 * parameterization (macf#943 task requirement: "a second, differently-
 * configured use of that path — not a parallel implementation"). Used by
 * `commands/bootstrap-apply.ts`'s dry-run "Apps that would be created"
 * render, the same call site that already renders every agent's manifest.
 */
export function buildRunnerRegistrarManifest(fleetName: string, redirectUrl: string, homepageUrl?: string): GitHubAppManifest {
  return buildAppManifest({
    fleetName,
    role: RUNNER_REGISTRAR_ROLE,
    redirectUrl,
    homepageUrl,
    permissions: RUNNER_REGISTRAR_PERMISSIONS,
    events: RUNNER_REGISTRAR_EVENTS,
  });
}

/**
 * Post-gate-2 verify-then-refuse for `repository_selection` (groundnuty/
 * macf#943). **GitHub's App-manifest JSON has no field to FORCE the
 * installed repo scope at creation time** — `repository_selection` is an
 * INSTALLATION-time choice the operator makes by clicking "Only select
 * repositories" (vs "All repositories") on the gate-2 install page; there is
 * no API parameter this tool can set ahead of that click. "Scope it at
 * creation; do not create broad-then-narrow" (the task brief) is therefore
 * honored the only way GitHub's API surface allows: the gate-2 announce
 * message (see `apply-fleet.ts`'s call site) tells the operator explicitly
 * to select "Only select repositories" and pick this fleet's repos, and THIS
 * function asserts the resulting fact and refuses the identity apply outright
 * if it doesn't hold — never silently accepting an `'all'`-scoped install as
 * if it were fine. Wired via `AgentApplyDeps.validateInstall`
 * (`apply-agent.ts`'s gate-2 runner calls it right after
 * `waitForAppInstallation` resolves, before reporting success).
 *
 * Rejects anything that ISN'T the exact string `'selected'` — not merely
 * "not `'all'`" — so a body that omits `repository_selection` entirely (which
 * real `GET /app/installations` responses do not do, but a malformed/future
 * API shape could) fails closed rather than silently passing.
 *
 * **What this does NOT verify:** that the *specific* repos selected are
 * exactly this fleet's declared set (vs. some OTHER subset). Confirming that
 * needs `GET /installation/repositories` under an installation token — a
 * second live call this increment does not make (flagged as a design
 * question in the implementation report, not decided here).
 */
export function validateRunnerRegistrarInstall(install: ConfirmedInstall): string | undefined {
  if (install.repositorySelection === 'selected') return undefined;
  return (
    'repository_selection must be "selected" (scoped to this fleet\'s repos only) — observed ' +
    `"${install.repositorySelection ?? '(not reported by GitHub)'}" . GitHub's App-manifest flow has no field to ` +
    'force this at creation time; the operator must open the install page, choose "Only select repositories," ' +
    'and pick exactly this fleet\'s declared repos — never "All repositories" (administration:write on every ' +
    "repo this App can see is blast-radius the fleet does not need). Correct the installation's repository " +
    'access on GitHub, then re-run apply.'
  );
}

// --- Name-length pre-flight (groundnuty/macf#943) ---

/**
 * GitHub App names are globally unique and capped at 34 characters (verified
 * against the App-creation form's `maxlength` + observed rejection on a
 * longer submission). `macf-experiment-runner-registrar` is 32 — the
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
 * PLUS the runner-registrar's. Pure; zero I/O. Exported so both call sites
 * that need the identical list (`commands/bootstrap-apply.ts`'s CLI-level
 * refusal, `apply-fleet.ts`'s own top-of-function refusal — see
 * `checkAppNameLengths`'s doc for why BOTH exist) derive it from one place,
 * never two independently hand-rolled lists that could drift.
 */
export function plannedAppNames(manifest: FleetManifest): readonly string[] {
  const fleetName = manifest.metadata.name;
  return [...manifest.agents.map((a: FleetAgent) => deriveAppHandle(fleetName, a.role)), deriveRunnerRegistrarHandle(fleetName)];
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
