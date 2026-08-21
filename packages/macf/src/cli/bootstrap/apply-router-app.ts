/**
 * The routing App — a minimal GitHub App (alongside the per-agent Apps and
 * `runner-ops`) whose only job is minting a registry-read token for
 * `macf-actions`' `agent-router.yml` reusable workflow (groundnuty/macf#1074,
 * "the fleet's routing capability is blocked").
 *
 * **Scope reversed by groundnuty/macf#1082 — SHARED across fleets is now the
 * DEFAULT; per-fleet is a retained opt-in.** #1074's ruling built a dedicated
 * App minted fresh for EVERY fleet, on the reasoning that per-fleet naming
 * (globally unique by construction) dissolves the collision hazard the DR-035
 * `tools/macf-bootstrap` skill's account-wide detect-or-reuse dance exists to
 * dodge. That reasoning was sound about COLLISION but silent about COST: the
 * operator's own framing (fleets are small by design, six-to-eight agents at
 * most; a routing App is a FIXED overhead that never amortises at that scale)
 * showed the per-fleet default spent one more App-creation click-pair per
 * fleet, forever, for a capability a single read-only App already provides.
 * `@macf-science-agent[bot]`'s reversal on #1082 names the exact error: two
 * independent axes — PURPOSE (not an agent's App, not `runner-ops`) and
 * INSTANCE COUNT (one per fleet vs. one per account) — were collapsed into a
 * single "dedicated" reading. **Dedicated in purpose, shared in instance**
 * satisfies both of #1074's original rejections and is what this module now
 * builds by default, porting the DR-035 skill's detect-or-reuse mechanism
 * (the reference implementation `apply-agent.ts::confirmBeforeCreateGuard`'s
 * `fleet.lock`-keyed reuse story was never built to answer — see
 * {@link resolveSharedRouterAppReuse}'s doc for the ported mechanism itself).
 *
 * **The two scopes, both real, both tested:**
 *   - **`'shared'` (default)** — one App per account, detected via the
 *     vault first (operator-supplied credentials, Amendment C's pattern —
 *     see {@link resolveSharedRouterAppReuse}) and via a live GitHub
 *     name-presence check second; minted fresh only on the account's
 *     first-ever fleet. Fixed handle ({@link SHARED_ROUTER_APP_HANDLE}),
 *     never fleet-prefixed.
 *   - **`'per-fleet'` (opt-in, `transport.router_app_scope: per-fleet` in
 *     `fleet.yaml`)** — #1074's original mechanism, byte-identical: a fresh
 *     App minted for THIS fleet alone, `deriveAppHandle(fleetName,
 *     ROUTER_APP_ROLE)`, reused only via THIS fleet's own `fleet.lock`.
 *     Retained for an operator who wants per-fleet blast-radius isolation
 *     over the one extra click-pair it costs — a real choice someone else
 *     may make differently, not preserved-for-compatibility ceremony.
 *
 * **The security trade that makes sharing acceptable — stated once, here,
 * because it is the fact that justifies everything below.** This App's
 * permission ceiling is `{actions_variables: read, metadata: read}` —
 * read-only, over registry variables holding agent `host:port` entries and a
 * CA certificate (public material; the CA *key* is never there). Sharing an
 * App instance across fleets is acceptable ONLY when its ceiling is
 * read-only over non-secret data like this — `runner-ops`
 * (`administration: write`) and every agent App (`contents`/`issues` write,
 * identity is the point) must NEVER be shared; this module's narrow
 * permission set is what makes it the one exception.
 *
 * **The availability coupling this trade buys, recorded once here rather
 * than discovered during an outage:** one App behind every fleet means a
 * deletion or key rotation on GitHub breaks EVERY fleet's routing
 * simultaneously, not just one. Per-fleet scope trades the click-pair back
 * for isolation from exactly this failure mode — the retained opt-in above
 * is how an operator who wants that trade gets it.
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
import type { AgentApplyOutcome, IdentityRequest } from './apply-agent.js';
import type { Presence } from './plan.js';
import { appSettingsAdvancedUrl } from './app-identity-removal.js';

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

/** `transport.router_app_scope`'s parsed shape (`fleet-manifest.ts::FleetTransportSchema`) — re-exported here so callers that only need the scope type don't have to import the whole manifest module. */
export type RouterAppScope = 'shared' | 'per-fleet';

/**
 * The routing App's SHARED handle (groundnuty/macf#1082) — fixed, never
 * fleet-prefixed, matching the DR-035 `tools/macf-bootstrap` skill's
 * `macf-routing` name exactly. Deliberate interop: an operator who
 * provisioned a fleet via the skill and one via `macf bootstrap apply`
 * should find the SAME App on GitHub either way — a different constant here
 * would silently fork the ecosystem into two "shared" Apps that don't share.
 */
export const SHARED_ROUTER_APP_HANDLE = 'macf-routing';

/**
 * The router App's handle for THIS run's scope (groundnuty/macf#1082).
 * `'shared'` (default) is the fixed {@link SHARED_ROUTER_APP_HANDLE},
 * unconditionally — `fleetName` is intentionally unused on that branch (a
 * shared name cannot be fleet-derived; that is the entire point of
 * "shared"). `'per-fleet'` is `deriveAppHandle(fleetName, ROUTER_APP_ROLE)`,
 * BYTE-IDENTICAL to this function's pre-#1082 sole behavior — the ONLY place
 * this App's per-fleet handle is computed (mirrors `deriveRunnerOpsHandle`'s
 * "handle derivation, never declaration" discipline; macf#791).
 */
export function deriveRouterAppHandle(fleetName: string, scope: RouterAppScope): string {
  return scope === 'per-fleet' ? deriveAppHandle(fleetName, ROUTER_APP_ROLE) : SHARED_ROUTER_APP_HANDLE;
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
 *
 * `handleOverride` (groundnuty/macf#1082): `undefined` when omitted — every
 * pre-#1082 caller (and the `'per-fleet'` scope) keeps `applyIdentity`'s own
 * derived handle, byte-identical. Callers taking the `'shared'`-scope CREATE
 * path (only reachable through {@link resolveSharedRouterAppReuse} returning
 * `'create'`) pass {@link SHARED_ROUTER_APP_HANDLE} here so the App GitHub
 * actually creates carries the fixed, cross-fleet-recognizable name, not a
 * fleet-prefixed one.
 */
export function routerAppIdentityRequest(installRepos: readonly string[], homepageUrl?: string, handleOverride?: string): IdentityRequest {
  return {
    role: ROUTER_APP_ROLE,
    homepageUrl,
    permissions: ROUTER_APP_PERMISSIONS,
    events: ROUTER_APP_EVENTS,
    installRepos,
    handleOverride,
  };
}

/**
 * The exact App-manifest document that would be (or was) submitted for the
 * router App — reuses `app-manifest.ts::buildAppManifest`'s existing
 * parameterization, same as `apply-runner-ops.ts::buildRunnerOpsManifest`.
 * Used by `commands/bootstrap-apply.ts`'s dry-run "Apps that would be
 * created" render (today: NOT yet wired there — the router App is a known,
 * separately-tracked dry-run preview gap, unrelated to #1082's scope
 * reversal; see #1074's own closing comment).
 *
 * `scope` defaults to `'per-fleet'` (groundnuty/macf#1082) — BYTE-IDENTICAL
 * to this function's pre-#1082 sole behavior for every existing caller.
 * Passing `'shared'` submits {@link SHARED_ROUTER_APP_HANDLE} as `name`
 * instead of the fleet-derived one.
 */
export function buildRouterAppManifest(fleetName: string, redirectUrl: string, homepageUrl?: string, scope: RouterAppScope = 'per-fleet'): GitHubAppManifest {
  return buildAppManifest({
    fleetName,
    role: ROUTER_APP_ROLE,
    redirectUrl,
    homepageUrl,
    permissions: ROUTER_APP_PERMISSIONS,
    nameOverride: scope === 'shared' ? SHARED_ROUTER_APP_HANDLE : undefined,
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

// --- Shared-scope reuse decision (groundnuty/macf#1082) ---
//
// The mode is INPUT-implied, not flag-selected: what the OPERATOR put in the
// vault ahead of this run decides reuse-vs-create, mirroring
// `apply-ca.ts::resolveCaCert`'s mint-or-reuse-or-refuse shape (three
// outcomes, never throws, every failure degrades to the next-most-honest
// state) and Amendment C's operator-provided-never-tool-minted contract.
// Ported from the DR-035 `tools/macf-bootstrap` skill's detect-or-reuse
// dance (module doc) — this is the code-driven analogue of `gh api
// /apps/<slug>`-then-vault-lookup the skill runs by hand.

/** The minimal deps {@link resolveSharedRouterAppReuse} needs — both optional, both "vault-aware / collision-aware confirm is NOT engaged this run" when omitted (the same opt-in contract every other vault-restore/collision-check seam in this codebase already establishes). */
export interface SharedRouterAppReuseDeps {
  /** Same contract as {@link RouterAppVaultRestoreDeps.readVaultRouterApp} — NEVER throws, NEVER logs. */
  readonly readVaultRouterApp?: () => Promise<{ readonly appId: string; readonly appKeyPem: string } | undefined>;
  /**
   * Same SEAM `apply-agent.ts::AgentApplyDeps.checkAppNameCollision` wires
   * to `app-presence.ts::resolveAppPresenceStatus` in production — reused
   * here (via `apply-fleet.ts` passing the already-built `AgentApplyDeps`'s
   * OWN `checkAppNameCollision` through unchanged), not re-implemented, so
   * "does this App name already exist" has exactly one live answer in this
   * codebase. `owner`'s type matches `AgentApplyDeps.checkAppNameCollision`'s
   * exactly (`FleetManifest['owner']`, not a narrower structural type) so
   * that reuse is a straight pass-through with no wrapper needed.
   */
  readonly checkAppNameCollision?: (owner: FleetManifest['owner'], appSlug: string) => Promise<Presence>;
}

/**
 * The three-way decision {@link resolveSharedRouterAppReuse} returns — pure
 * data, no I/O of its own (the caller's injected deps did the I/O). Mirrors
 * `apply-ca.ts::CaResolveOutcome`'s three-state shape.
 */
export type SharedRouterAppReuseDecision =
  /** The vault already carries this App's id/key — publish those values, mint NOTHING. `appId` is non-secret (safe to log); the key stays inside the vault-restore closure, never threaded through this decision. */
  | { readonly kind: 'reuse'; readonly appId: string }
  /** No vault credentials, but the shared name is confirmably taken on GitHub — refuse with an instruction, never a silent failure and never a guessed create. */
  | { readonly kind: 'name-taken'; readonly reason: string }
  /** No vault credentials, name confirmed free (or unconfirmable — see doc) — proceed to the normal create ceremony. */
  | { readonly kind: 'create' };

/**
 * The router App's SHARED-scope instruction text (groundnuty/macf#1082) —
 * pure text builder, exported so tests assert against it directly without
 * re-deriving the wording (mirrors `app-presence.ts::appNameCollisionRefusalMessage`'s
 * precedent, which this message deliberately does NOT reuse verbatim: that
 * generic message's two remedies — delete the App, or re-run with
 * --vault/--identity-key — omit the router App's genuine THIRD option, minting
 * an isolated per-fleet App instead of fighting over the shared name).
 *
 * Names two explicit operator next steps, neither of them something this run
 * does automatically — "never mint a key the operator did not ask for" rules
 * out a silent fallback to per-fleet scope within the same run.
 */
export function routerAppNameCollisionMessage(appSlug: string, settingsUrl: string): string {
  return (
    `App "${appSlug}" already exists but is not in this fleet's vault, so its ownership cannot be proven and its ` +
    `private key cannot be recovered (GitHub has no API for that — regeneration is GUI-only; see ${settingsUrl}). ` +
    'Either put its id/key into this fleet\'s vault as MACF_ROUTING_APP_ID/MACF_ROUTING_APP_KEY_B64 and re-run ' +
    'with --vault/--identity-key so apply can reuse it, or set transport.router_app_scope: per-fleet in fleet.yaml ' +
    'so apply mints a dedicated App for this fleet alone instead of contending for the shared name.'
  );
}

/**
 * Decide reuse-vs-name-taken-vs-create for the SHARED router-App scope
 * (groundnuty/macf#1082) — called BEFORE `applyIdentity` is ever reached, so
 * a `'reuse'` decision means the mint/manifest-flow seam is invoked ZERO
 * times this run (the decisive property the vault-reuse path exists for).
 * NEVER throws — both injected deps degrade to the next state on failure,
 * same posture as every other vault-restore/collision-check closure here.
 *
 * Order matters: vault FIRST (an operator who already supplied credentials
 * should never pay for a network round-trip to confirm what they already
 * told us), name-collision SECOND (only spent when there is genuinely a
 * decision left to make).
 */
export async function resolveSharedRouterAppReuse(
  owner: FleetManifest['owner'],
  handle: string,
  deps: SharedRouterAppReuseDeps,
): Promise<SharedRouterAppReuseDecision> {
  if (deps.readVaultRouterApp !== undefined) {
    let restored: { readonly appId: string; readonly appKeyPem: string } | undefined;
    try {
      restored = await deps.readVaultRouterApp();
    } catch {
      restored = undefined;
    }
    if (restored !== undefined) {
      return { kind: 'reuse', appId: restored.appId };
    }
  }

  if (deps.checkAppNameCollision !== undefined) {
    let collision: Presence;
    try {
      collision = await deps.checkAppNameCollision(owner, handle);
    } catch {
      // Fail-open, same posture every honest-unknown read in this package
      // takes — a throwing dep is inconclusive, never a refusal.
      collision = 'unknown';
    }
    if (collision === 'present') {
      return { kind: 'name-taken', reason: routerAppNameCollisionMessage(handle, appSettingsAdvancedUrl(owner, handle)) };
    }
  }

  return { kind: 'create' };
}

// --- Publish-time resolution (groundnuty/macf#1074) ---
//
// Mirrors `apply-routing-client.ts`'s mint/vault-restore split for the
// SAME reason: a value only exists in process memory on the run that just
// created it (gate 1's `AppCredentials.pem`); any OTHER run needs to read
// it back from the vault. `MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY`'s
// two-secret bag joins `apply-routing-secrets.ts::publishRoutingSecrets`'s
// six-value assembly via this resolution, never a second publisher.

export interface RouterAppVaultRestoreDeps {
  /**
   * The vault-restore fallback for the router App's key, when this run's
   * `AgentApplyOutcome` for role `router` is `'reused'`/`'resumed-install'`
   * (no PEM in process memory — only a fresh gate-1 exchange ever produces
   * one). Mirrors `apply-routing-client.ts::RoutingClientVaultRestoreDeps.
   * readVaultRoutingClient`'s contract exactly: `undefined` (the field
   * omitted) means "vault-aware restore is NOT engaged this run" (the
   * byte-identical degrade every sibling vault-restore closure uses when
   * `--vault`/`--identity-key` weren't both supplied).
   *
   * **Contract: NEVER throws.** Any decrypt/parse failure MUST resolve to
   * `undefined` — the same honest-unknown-over-false-present floor every
   * other vault-restore closure in this codebase establishes.
   *
   * **Contract: never logs.** Returns only the id/PEM or `undefined`, never
   * a side-channel diagnostic.
   */
  readonly readVaultRouterApp?: () => Promise<{ readonly appId: string; readonly appKeyPem: string } | undefined>;
}

/** What a publish attempt has to work with for the router App's TWO secrets — mirrors `apply-routing-client.ts::RoutingClientSecretsForPublish`'s shape exactly (`'unavailable'` is an honest gap, Amendment A4, never a fabricated credential). */
export type RouterAppSecretsForPublish =
  | { readonly status: 'available'; readonly appId: string; readonly appKeyPem: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * The router App's identity outcome for THIS run — widens
 * {@link AgentApplyOutcome} with the ONE status that ceremony can never
 * produce (groundnuty/macf#1082): `'vault-reused'`, when
 * {@link resolveSharedRouterAppReuse} resolved `'reuse'` and the whole
 * `applyIdentity` ceremony was skipped outright (zero App-creation
 * attempts). Deliberately NOT folded into {@link AgentApplyOutcome} itself —
 * that union is shared by every agent + `runner-ops`, none of which have a
 * cross-fleet vault-reuse concept; widening it there would force every
 * OTHER exhaustive switch over `AgentApplyOutcome` in this codebase to
 * handle a status it can never actually see. `FleetApplyResult.routerApp`
 * is this type specifically, not `AgentApplyOutcome` — see `apply-fleet.ts`.
 *
 * No `installId` field, unlike `'reused'`/`'resumed-install'` — a
 * vault-reused App was never live-reconfirmed via GitHub this run, so there
 * is no confirmed install to record. `apply-fleet.ts` deliberately does NOT
 * write a `fleet.lock` entry for this status (see that module's call site) —
 * the vault, not the lock, is this scope's source of truth for reuse.
 */
export type RouterAppApplyOutcome = AgentApplyOutcome | { readonly role: string; readonly status: 'vault-reused'; readonly appId: string };

/**
 * Resolve the router App's id/key for THIS run's publish attempt from
 * `identity` (this run's {@link RouterAppApplyOutcome} for role `router`) —
 * never calls a mint/create seam (there is none here; App creation is
 * `applyIdentity`'s job, already run before this, or skipped entirely on
 * the `'vault-reused'` path).
 *
 * - `'created'` THIS run: the credential is in process memory
 *   (`identity.credentials.pem`) — available UNLESS `vaultWritten` is
 *   `false`, in which case this is the SAME ordering-safety refusal
 *   `apply-routing-client.ts`'s mint-gating applies to a freshly-minted
 *   routing-client key: deploying an export-class key before its ONLY
 *   canonical-vault copy is durable would recreate the #799 orphan-cert
 *   class if the vault write is later retried and this run's App entry is
 *   never recorded in `fleet.lock` (the recovery artifact softens but does
 *   not eliminate this — see `apply-agent.ts`'s "gate-1→gate-2 window" doc
 *   for why the SAME discipline applies there too).
 * - `'reused'`/`'resumed-install'`/`'vault-reused'` (groundnuty/macf#1082):
 *   no PEM in process memory — tries `deps.readVaultRouterApp` (wired only
 *   when both `--vault`/`--identity-key` were supplied); degrades to
 *   `'unavailable'` with an honest reason otherwise. `'vault-reused'` took
 *   the SAME vault read once already, in {@link resolveSharedRouterAppReuse}
 *   — re-reading it here (rather than threading the key through
 *   `FleetApplyResult`) keeps the private-key material out of the
 *   render-facing outcome type, the same posture `apply-ca.ts::resolveCaCert`
 *   already establishes for the CA key.
 * - `'skipped-unverified'`/`'drift'`/`'failed'`: unresolved this run —
 *   `'unavailable'`, carrying the identity outcome's own reason.
 */
export async function resolveRouterAppSecretsForPublish(
  identity: RouterAppApplyOutcome,
  vaultWritten: boolean,
  deps: RouterAppVaultRestoreDeps,
): Promise<RouterAppSecretsForPublish> {
  if (identity.status === 'created') {
    if (!vaultWritten) {
      return {
        status: 'unavailable',
        reason:
          'router App was freshly created this run but the batched vault write did not succeed — refusing to ' +
          'deploy its private key to any repo until it is durable. Re-run apply once the vault issue ' +
          'is fixed; the App itself already exists on GitHub and is NOT re-created on retry.',
      };
    }
    return { status: 'available', appId: identity.appId, appKeyPem: identity.credentials.pem };
  }
  if (identity.status === 'reused' || identity.status === 'resumed-install' || identity.status === 'vault-reused') {
    if (deps.readVaultRouterApp !== undefined) {
      let restored: { readonly appId: string; readonly appKeyPem: string } | undefined;
      try {
        restored = await deps.readVaultRouterApp();
      } catch {
        restored = undefined;
      }
      if (restored !== undefined) {
        return { status: 'available', appId: restored.appId, appKeyPem: restored.appKeyPem };
      }
      return {
        status: 'unavailable',
        reason:
          'router App exists on GitHub (a prior run confirmed it) but a vault-restore was attempted ' +
          '(--vault/--identity-key were both supplied) and did not yield its key — check the vault actually holds ' +
          'MACF_ROUTING_APP_ID/MACF_ROUTING_APP_KEY_B64 for this fleet.',
      };
    }
    return {
      status: 'unavailable',
      reason:
        'router App exists on GitHub (a prior run confirmed it) but its key is not in process memory this run. ' +
        'Supply both --vault and --identity-key to `macf bootstrap apply` so it can be read back from the vault ' +
        'and published to any repo that does not yet have it.',
    };
  }
  return {
    status: 'unavailable',
    reason: `router App identity is unresolved this run (${identity.status}${identity.reason !== undefined ? `: ${identity.reason}` : ''}).`,
  };
}
