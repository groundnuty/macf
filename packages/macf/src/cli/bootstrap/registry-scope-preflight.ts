/**
 * `registry: { type: org }` pre-flight (groundnuty/macf#999) — refuses an
 * unsatisfiable manifest configuration BEFORE it costs anything, mirroring
 * macf#932's shape (`apply-routing.ts::checkRunnerTokenPreflight`) and
 * macf#943's shape (`apply-runner-ops.ts::checkAppNameLengths`): a pure,
 * manifest-only check callable before ANY observe/plan-render/consent-gate
 * work.
 *
 * **What is verified, and what this check does NOT assert.** A live
 * two-agent `macf-experiment` fleet provisioned cleanly and then could not
 * read its own registry entry (`GET /orgs/{org}/actions/variables/{name}` →
 * 403 `Resource not accessible by integration`). #999's own thread carries
 * an unresolved dispute about WHY: one framing blames the installations'
 * `repository_selection` (`'selected'` vs `'all'`); a review comment on the
 * same thread disputes that and points instead at the App's PERMISSION set.
 * This module does not take a side on that dispute — it doesn't need to,
 * because a narrower, independently-verified fact is sufficient on its own:
 *
 *   `packages/macf/src/cli/commands/doctor.ts`'s `MACF_REQUIRED_PERMISSIONS`
 *   — the DR-019 set `app-manifest.ts::buildAppManifest` derives EVERY
 *   ordinary agent App's `default_permissions` from — contains exactly one
 *   Variables-shaped entry (`actions_variables`, repo-scoped) and NO
 *   organization-scoped permission key at all. Nothing in `fleet.yaml`, in
 *   `buildAppManifest`, or anywhere else in this codebase's manifest-building
 *   path offers a way to REQUEST an organization-level permission for an
 *   ordinary agent App. That is directly readable from source, not inferred
 *   from a live 403 — see this file's test for the literal assertion against
 *   `MACF_REQUIRED_PERMISSIONS`.
 *
 * Given that, `registry: { type: org }` is unsatisfiable **today**,
 * independent of install scope: even the broadest possible install
 * (`repository_selection: 'all'`, which macf#950/#951 already refuse for
 * unrelated blast-radius reasons — see `apply-runner-ops.ts::validateRunnerOpsInstall`,
 * a DIFFERENT check, for a DIFFERENT App, left untouched by this file) would
 * not help, because the permission this tool's manifest requests never
 * covers the organization resource in the first place. The install-scope
 * question the thread argues about is consequently moot for THIS check —
 * this module refuses on the permission gap alone, and deliberately says
 * nothing about scope.
 *
 * **Why this can only ever be a manifest-derived check, never a live probe,
 * at this call site.** The result-invariant a reviewer on #999 asked for
 * ("can this App actually read the variable it will need?") is real and
 * more precise than a manifest-pattern check — but it is not COMPUTABLE
 * before consent gate 1: there is no App and no installation yet, so there
 * is no JWT to mint and nothing to probe (`identity-confirm.ts`'s
 * `ConfirmedInstall.repositorySelection` — the one field that WOULD carry
 * scope — is populated only from a POST-gate-2 `GET /app/installations`
 * read; see that module's doc). A pre-gate-1 refusal is necessarily a
 * manifest-only fact, not a live result-invariant; the result-invariant
 * probe belongs post-gate-2 (first registry write/read) or at agent
 * runtime, and is complementary to this pre-flight, not a replacement for
 * it — closing the "green run, dead fleet" gap this pre-flight targets does
 * not require deciding the scope question, only detecting the permission
 * gap that is true regardless of how that question resolves.
 *
 * **What is explicitly OUT of scope (groundnuty/macf#999 requirement 2).**
 * Which resolution the framework adopts — repo-scoping the registry onto
 * the control repo, requesting a wider permission set, or declaring org
 * scope unsupported outright — is a design decision for DR-006/DR-043, not
 * encoded here. This module only refuses; it does not choose a fix. A
 * future change that resolves #999 requirement 2 will need to touch (or
 * delete) {@link checkRegistryScopePreflight} explicitly — this check does
 * NOT auto-lift itself if, say, an organization-scoped permission key is
 * added to `MACF_REQUIRED_PERMISSIONS` for some unrelated reason; the
 * install-scope side of the dispute would still be unresolved, and a
 * silently-self-modifying refusal is its own silent-fallback hazard.
 */
import { MACF_REQUIRED_PERMISSIONS } from '../commands/doctor.js';
import type { FleetOwner } from './fleet-manifest.js';

/** Distinct from `RUNNER_TOKEN_MISSING_CODE` / `'app_name_too_long'` / `'vault_flags_incomplete'` — lets a caller/log tell this argument-boundary refusal apart from its siblings. */
export const REGISTRY_SCOPE_UNSATISFIABLE_CODE = 'registry_scope_unsatisfiable';

/** The shape `commands/bootstrap-apply.ts::renderFailure` and `plan.ts`'s own `FleetPlanFailure` both accept — see `apply-routing.ts::RunnerTokenPreflightFailure`'s doc for why this is defined locally rather than imported from either. */
export interface RegistryScopeConflict {
  readonly code: typeof REGISTRY_SCOPE_UNSATISFIABLE_CODE;
  readonly message: string;
}

/**
 * `true` when the App-manifest permission set this tool builds for an
 * ordinary agent carries ANY organization-scoped permission key
 * (`organization_*` — GitHub's own naming convention for the organization
 * permission namespace, e.g. `organization_secrets`, `organization_administration`).
 * Extracted as its own function (rather than inlined into
 * {@link checkRegistryScopePreflight}) so a future permission-set change is
 * a one-line diff to re-derive this from, and so the check's test can pin
 * today's answer (`false`) directly against the real constant instead of a
 * hand-copied fixture that could drift from it.
 */
function agentManifestHasOrgPermission(): boolean {
  return MACF_REQUIRED_PERMISSIONS.some((p) => p.name.startsWith('organization_'));
}

/**
 * The macf#999 pre-flight. `undefined` (no refusal) for every registry type
 * except `'org'`; also `undefined` for `'org'` in the (today, unreachable)
 * case where {@link agentManifestHasOrgPermission} becomes `true` — see this
 * module's doc for why that is a deliberate non-auto-lifting design, not an
 * oversight. Pure; zero I/O; safe to call before ANY provisioning step —
 * same "assert the gate seam is never invoked" contract
 * `checkAppNameLengths`'s doc establishes.
 */
export function checkRegistryScopePreflight(owner: FleetOwner): RegistryScopeConflict | undefined {
  if (owner.registry.type !== 'org') return undefined;
  if (agentManifestHasOrgPermission()) return undefined;
  return { code: REGISTRY_SCOPE_UNSATISFIABLE_CODE, message: registryScopeUnsatisfiableReason(owner.registry.org) };
}

/**
 * The refusal text — see this module's doc for exactly what is and is not
 * asserted. Deliberately silent on install scope (disputed, unverified, and
 * irrelevant to the permission gap this fires on) and deliberately does NOT
 * say "org scope is unsupported" (that would pre-empt #999 requirement 2,
 * a design decision this module does not make).
 */
export function registryScopeUnsatisfiableReason(org: string): string {
  return (
    `registry: { type: org, org: "${org}" } is unsatisfiable with this tool's current provisioning: every ` +
    'ordinary agent App\'s manifest derives its permissions solely from MACF_REQUIRED_PERMISSIONS (DR-019, ' +
    'packages/macf/src/cli/commands/doctor.ts), which contains no organization-scoped permission — so no App ' +
    '`macf bootstrap` provisions can read GET /orgs/{org}/actions/variables/{name}, independent of install scope. ' +
    'registry: { type: profile, user: <account> } works today (DR-006) — the substrate fleet uses it. The ' +
    'resolution (repo-scoping the registry onto the control repo, widening the permission set, or declaring org ' +
    'scope unsupported) is open — see groundnuty/macf#999. Refusing before any consent gate opens; nothing on ' +
    'GitHub was touched.'
  );
}
