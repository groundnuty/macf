/**
 * The routing App — a THIRD, minimal GitHub App per fleet (alongside the
 * per-agent Apps and `runner-ops`) whose only job is minting a
 * registry-read token for `macf-actions`' `agent-router.yml` reusable
 * workflow (groundnuty/macf#1074, "the fleet's routing capability is
 * blocked").
 *
 * **Why a THIRD App, not a widened agent App or `runner-ops` reuse
 * (`@macf-science-agent[bot]`'s ruling on #1074, re-affirmed after checking
 * this exact question against the DR-035 `tools/macf-bootstrap` skill —
 * the working reference implementation for a fleet that actually routes).**
 * DR-044's own framing: the router acts on behalf of the FLEET, not of one
 * agent — and in the fleet's own control repo there is no agent whose
 * identity it could plausibly borrow. Reusing `runner-ops` is worse than it
 * looks: its ceiling is `administration: write` (repo deletion), and this
 * App's key is EXPORT-CLASS — it leaves the vault into repo secrets on
 * EVERY router-carrying repo (`apply-control-repo-init.ts::deriveRouterCarryingRepos`),
 * so reusing `runner-ops` would put repo-deletion capability behind every
 * repo secret in the fleet. So: a second (from this App's own perspective,
 * effectively a third alongside the per-agent Apps) minimal per-fleet App,
 * built the exact same SHAPE `apply-runner-ops.ts` already established for
 * the identical "narrow, export-class, one-purpose" problem — this module
 * intentionally mirrors that one's structure line-for-line where the
 * reasoning transfers.
 *
 * **Dedicated PER-FLEET, not the account-wide SHARED App the manual
 * `tools/macf-bootstrap` skill / DR-035 workflow builds.** The skill
 * detects-and-reuses ONE `macf-routing` App across every fleet on an
 * account (`SKILL.md`: "SHARED (one per registry/account, NOT per
 * project): REUSE the existing one if present... App names are GLOBALLY
 * unique, so a duplicate `macf-routing` create silently *fails*"). That
 * detect-or-create dance exists SPECIFICALLY to dodge GitHub's global
 * App-name-uniqueness collision on a fixed name (`macf-routing`) reused
 * across many fleets. Per-fleet naming (`deriveAppHandle(fleetName,
 * ROUTER_APP_ROLE)` → `<fleet>-router`, globally unique BY CONSTRUCTION —
 * same guarantee every agent App and `runner-ops` already rely on)
 * dissolves that collision hazard entirely: there is no "does this already
 * exist under some other fleet" question to ask, because no two fleets ever
 * derive the same handle. The skill's reuse machinery therefore has no
 * analogue to build here — `apply-agent.ts::confirmBeforeCreateGuard`'s
 * EXISTING "read `fleet.lock` first, only create if this FLEET has never
 * minted one" guard is the correct (and only needed) reuse story, exactly
 * as it already is for every agent App and `runner-ops`.
 *
 * **Permission derivation — read from what the router workflow actually
 * calls, per DR-044 Decision 3's binding contract for any NEW credential.**
 * `X-Accepted-Github-Permissions` (the header-based self-checking mechanism
 * DR-044 describes) is **NOT YET IMPLEMENTED** anywhere in this codebase
 * (`design/decisions/DR-044-fleet-authority.md` line 67: "carries no
 * `Asserted by:` citation... implementation follows this DR's ratification,
 * not the other way round") — so this module does NOT claim that
 * verification. What WAS done: fetched `groundnuty/macf-actions`'
 * `agent-router.yml` live off `main` (`gh api
 * repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml`)
 * and read its OWN documentation of the App it expects, verbatim:
 *
 *   - Header comment: `MACF_ROUTING_APP_ID — GitHub App ID for a
 *     variables:read-only App installed on the registry org (see §3.0.0
 *     migration for dedicated-App rationale)."`
 *   - `workflow_call.secrets.MACF_ROUTING_APP_ID`'s description: "GitHub
 *     App ID for the variables:read-only App that mints registry access
 *     tokens. Dedicated App keeps blast radius small."
 *   - The "Mint registry-read token" step's own inline comment, verbatim:
 *     *"No permission-* subsetting: `macf-routing` is already a
 *     minimum-scope App (`metadata:read` + `actions_variables:read`)."*
 *   - The ONLY live API call the minted token is ever used for: `gh api
 *     "${REG_PATH}/actions/variables/${var_name}"` — a single GET against
 *     the registry's Actions-variables endpoint. No other endpoint, no
 *     write, nothing else in the entire 1107-line workflow consumes this
 *     token.
 *
 * That is the full evidentiary basis for {@link ROUTER_APP_PERMISSIONS}
 * below: two permissions, both `read`, matching the workflow's own claim
 * about itself exactly. `actions_variables` (not an
 * `organization_actions_variables` key) is correct regardless of registry
 * scope — `registry-scope-preflight.ts::checkRegistryScopePreflight`
 * already refuses `registry: { type: 'org' }` outright (no
 * organization-scoped permission exists anywhere in this codebase's
 * manifest-building path), so every fleet that reaches this module has a
 * `profile` or `repo` registry, both of which resolve to a REPO-shaped
 * Actions-variables endpoint — the same permission key
 * `MACF_REQUIRED_PERMISSIONS` already uses for every agent App's OWN
 * (write-scoped) registry access.
 */
import type { FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { GitHubAppManifest } from './app-manifest.js';
import { buildAppManifest } from './app-manifest.js';
import type { ConfirmedInstall } from './identity-confirm.js';
import type { IdentityRequest } from './apply-agent.js';

/**
 * The reserved `role` this App is derived + recorded under — never declared
 * in `fleet.yaml`'s `agents[]` (mirrors `apply-runner-ops.ts::RUNNER_OPS_ROLE`'s
 * doc — that array is coordination agents only).
 *
 * **The 13-char budget criterion (groundnuty/macf#943's test-enforced
 * relation; groundnuty/macf#1074's ruling reaffirms it for THIS role
 * specifically): a new derived role must be no longer than the longest
 * EXISTING role, so adding a credential never lowers the maximum
 * fleet-name length.** `science-agent` (13) is today's limiter; `'router'`
 * (6) stays well under it — asserted as a relation in this module's test
 * (`expect(ROUTER_APP_ROLE.length).toBeLessThanOrEqual('science-agent'.length)`),
 * not a magic number, so a future rename fails THERE rather than silently
 * shrinking every fleet's budget. The actual name-length PRE-FLIGHT (single
 * source of truth, both call sites) lives in `apply-runner-ops.ts::
 * plannedAppNames` / `checkAppNameLengths`, extended to include
 * `deriveRouterAppHandle` — never duplicated here.
 */
export const ROUTER_APP_ROLE = 'router';

/**
 * **EXPORT-CLASS credential (groundnuty/macf#1074's binding constraint,
 * verbatim from the ruling): "Its key is export-class — it leaves the
 * vault into repo secrets on every router-carrying repo — so scope it
 * minimally BEFORE it is ever exported. The ceiling never lowers
 * afterwards."** Same one-way-ratchet posture `apply-runner-ops.ts::
 * RUNNER_OPS_PERMISSIONS` already documents for the identical reason: a
 * future capability this App's holder needs is a NEW App, never a
 * permission bump added here.
 *
 * Exactly the two permissions the router workflow's own documentation
 * claims for this App (see module doc's "Permission derivation" section
 * for the verbatim citations) — no others:
 *   - `actions_variables: read` — the ONLY live API call the minted token
 *     is ever used for (`GET {registry-api-path}/actions/variables/{name}`).
 *   - `metadata: read` — GitHub's own baseline (every App implicitly needs
 *     it; listed explicitly so the submitted manifest is self-documenting,
 *     same convention `RUNNER_OPS_PERMISSIONS` follows).
 */
export const ROUTER_APP_PERMISSIONS: Readonly<Record<string, string>> = {
  actions_variables: 'read',
  metadata: 'read',
};

/**
 * No coordination events — this App never reacts to issues/PRs/reviews (it
 * has none of the `issues`/`pull_requests`/`contents` read permissions
 * those events need). Mirrors `apply-runner-ops.ts::RUNNER_OPS_EVENTS`.
 */
export const ROUTER_APP_EVENTS: readonly string[] = [];

/** `deriveAppHandle(fleetName, ROUTER_APP_ROLE)` — the ONLY place this App's handle is computed (mirrors `deriveRunnerOpsHandle`'s "handle derivation, never declaration" discipline; macf#791). */
export function deriveRouterAppHandle(fleetName: string): string {
  return deriveAppHandle(fleetName, ROUTER_APP_ROLE);
}

/**
 * The {@link IdentityRequest} `apply-agent.ts::applyIdentity` needs to drive
 * this App through confirm-before-create → gate 1 → gate 2 — the SAME
 * primitive every coordination agent and `runner-ops` use, differently
 * configured (narrower permissions, no events, a homepage that isn't a
 * per-agent repo since this App has none, and — unlike every other identity
 * — an explicit `installRepos` override, since this App's correct install
 * target is the fleet's REGISTRY, not any agent's repo; see
 * `routerAppInstallRepos`/`IdentityRequest.installRepos`'s doc).
 */
export function routerAppIdentityRequest(installRepos: readonly string[], homepageUrl?: string): IdentityRequest {
  return {
    role: ROUTER_APP_ROLE,
    homepageUrl,
    permissions: ROUTER_APP_PERMISSIONS,
    events: ROUTER_APP_EVENTS,
    installRepos,
  };
}

/**
 * The exact App-manifest document that would be (or was) submitted for the
 * router App — reuses `app-manifest.ts::buildAppManifest`'s existing
 * parameterization, same as `apply-runner-ops.ts::buildRunnerOpsManifest`.
 * Used by `commands/bootstrap-apply.ts`'s dry-run "Apps that would be
 * created" render.
 */
export function buildRouterAppManifest(fleetName: string, redirectUrl: string, homepageUrl?: string): GitHubAppManifest {
  return buildAppManifest({
    fleetName,
    role: ROUTER_APP_ROLE,
    redirectUrl,
    homepageUrl,
    permissions: ROUTER_APP_PERMISSIONS,
    events: ROUTER_APP_EVENTS,
  });
}

/**
 * Where this App needs to be INSTALLED — the fleet's registry target, never
 * any agent's repo (unlike `runner-ops`, whose "every agent repo" need is
 * genuine — it mints runner-registration tokens for each one). This App
 * only ever reads Actions variables at the registry (`GET
 * {registry-api-path}/actions/variables/{name}`), so installing it on
 * agent repos would grant access this App structurally never uses, and —
 * for a `profile`-scoped registry specifically — would MISS the actual
 * target entirely (the registry lives at `<user>/<user>`, which is not
 * necessarily any agent's repo).
 *
 * `registry.type === 'org'` is unreachable here in practice —
 * `registry-scope-preflight.ts::checkRegistryScopePreflight` already
 * refuses that configuration before ANY consent gate opens — but this
 * function still resolves it honestly (empty array, "nowhere to install")
 * rather than guessing, in case a future caller reaches it before that
 * preflight runs. `registry.type === 'local'` (DR-024) has no GitHub App
 * surface at all — same empty-array honest-absence answer; `apply-fleet.ts`
 * is expected to skip this App's identity ceremony entirely for a local
 * registry (see that module's call site).
 */
export function routerAppInstallRepos(manifest: FleetManifest): readonly string[] {
  const registry = manifest.owner.registry;
  switch (registry.type) {
    case 'profile':
      return [`${registry.user}/${registry.user}`];
    case 'repo':
      return [`${registry.owner}/${registry.repo}`];
    case 'org':
    case 'local':
      return [];
  }
}

/**
 * Post-gate-2 verify-then-refuse for `repository_selection` — same
 * blast-radius discipline `apply-runner-ops.ts::validateRunnerOpsInstall`
 * applies, for the same reason (groundnuty/macf#1074's ruling: "scope it
 * minimally BEFORE it is ever exported"). This App's own permission set is
 * already narrow (`actions_variables: read` only, no `administration`), so
 * an `'all'`-scoped install is a smaller blast radius than `runner-ops`'
 * equivalent slip would be — but it is still strictly more than this App
 * ever needs (exactly one repo: the registry target), and "narrow
 * permission, broad install" is still a needless widening for an
 * export-class key. Refuses on anything that isn't exactly `'selected'`,
 * same fail-closed posture as the runner-ops sibling.
 */
export function validateRouterAppInstall(install: ConfirmedInstall): string | undefined {
  if (install.repositorySelection === 'selected') return undefined;
  return (
    'repository_selection must be "selected" (scoped to just the registry-target repo) — observed ' +
    `"${install.repositorySelection ?? '(not reported by GitHub)'}" . On the install page, choose "Only select ` +
    'repositories" and pick exactly the registry-target repo — never "All repositories" (this App\'s key is ' +
    'export-class; an unnecessarily broad install widens what every repo secret it is copied into can reach). ' +
    "Correct the installation's repository access on GitHub, then re-run apply."
  );
}
