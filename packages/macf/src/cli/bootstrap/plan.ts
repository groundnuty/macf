/**
 * `macf bootstrap plan` — the READ-ONLY three-verb reconciler (DR-043 §D3,
 * Slice 1a of groundnuty/macf#838).
 *
 * `computePlan` is the pure, fully-tested core: given a desired-state
 * `FleetManifest` (§D1) and an `ObservedState` (whatever `macf bootstrap`
 * could determine about what already exists), it emits exactly one
 * {@link PlanItem} per desired resource:
 *
 *   - **create**   — the resource is missing (or its presence can't be
 *                    confirmed at plan time — degrade to a LOW-CONFIDENCE
 *                    create-candidate rather than silently skip it).
 *   - **update**   — the resource exists but its observed value diverges
 *                    from the manifest's declared value. ALWAYS
 *                    `confirm_required: true` — `apply` must never silently
 *                    mutate (§D3).
 *   - **noop**     — observed matches desired.
 *   - **report-extra** — observed but NOT declared in the manifest AND not
 *                    recorded in `fleet.lock` — not ours to judge, so it is
 *                    reported, never touched (§D3 "play it safe").
 *   - **delete**   — observed but NOT declared in the manifest, AND `fleet.lock`
 *                    records THIS TOOL as the one that provisioned it (DR-043
 *                    Amendment P3, row 4, groundnuty/macf#1229): a negative
 *                    diff on a CHEAP-TO-REVIVE resource class (variables,
 *                    secrets). A statement of intent, covered by the SAME
 *                    plan-approval consent `update` already uses
 *                    (`confirm_required: true`) — but this change wires the
 *                    COMPUTATION only; `apply` has no code path for `delete`
 *                    yet (see `planItemApplyCoverage` + `unimplementedByApply`
 *                    — deliberately unwired, a future increment's job).
 *   - **orphan**    — the SAME "ours, no longer declared, recorded in
 *                    fleet.lock" fact as `delete`, but on an EXPENSIVE-TO-REVIVE
 *                    resource class (repos, Apps — un-archive/recreate loses
 *                    history, or the App's key was emitted once and is
 *                    unrecoverable). An INSTRUCTION TO THE OPERATOR — "we made
 *                    this, the manifest no longer wants it, and I will not
 *                    touch it" — never a statement of intent. `apply` MUST
 *                    NEVER act on an `orphan` item, under any flag, ever (see
 *                    `planItemApplyCoverage`'s `orphan` arm, which is
 *                    `'implemented'` for exactly this reason: "apply
 *                    correctly does nothing" IS the designed behavior, not a
 *                    gap).
 *
 *                    Both verbs are gated on `fleet.lock` membership, which is
 *                    the WHOLE safety property row 4 rests on: a resource NOT
 *                    recorded in the lock might be anything on GitHub with a
 *                    matching name — never provably ours — so it stays
 *                    `report-extra`/untouched exactly as before this change
 *                    (the no-prune decision `report-extra` already embodied is
 *                    preserved exactly, not relaxed).
 *
 * `collaborators:` (§D3 day-2 catalog) is PARSED by the schema but its
 * reconcile logic is deferred past Slice 1a. To avoid the silent-fallback
 * shape where an operator who declares a collaborator sees a "clean" plan
 * and reasonably assumes it was reconciled, `computePlan` surfaces every
 * declared-but-deferred section explicitly via `FleetPlan.skippedSections`
 * — never silent.
 *
 * `versions:` (§D6 GitOps steering) is WIRED: once declared, `computePlan`
 * emits a `version` item per agent (deployed macf CLI version) and an
 * `actions_pin` item per ROUTER-CARRYING repo — every agent's repo AND the
 * control repo (`fleet-manifest.ts::routerCarryingRepos`, groundnuty/macf#1072
 * — the control repo has carried a committed `agent-router.yml` since
 * `#1070`) — see `macfVersionItem` / `actionsVersionItem` below. Both are
 * pure value-comparisons against `ObservedState`, same three-verb shape as
 * every other item in this file.
 *
 * **Both `version` AND `actions_pin` have a real `apply` code path.**
 * `apply`'s version-reconcile phase (`apply-version.ts`) CALLS the `macf
 * fleet upgrade` roll machinery (delegation, never reimplementation —
 * DR-043 Amendment L2) for a diverging `versions.macf` (groundnuty/macf#1045).
 * `apply-fleet.ts`'s `resolveActionsPinReconcile` call sites do the SAME for
 * a diverging `versions.actions` — force-rewriting the committed
 * `agent-router.yml` by delegating to `commands/repo-init.ts::repoInit`
 * (Amendment L extended, groundnuty/macf#1072). Both kinds are
 * `'implemented'` in `planItemApplyCoverage`.
 *
 * A SIBLING gap surfaced on the first real provision (groundnuty/macf#854):
 * `skippedSections` covers whole MANIFEST SECTIONS apply never reconciles,
 * but individual `create`/`update` {@link PlanItem}s can ALSO have no `apply`
 * code path (the CA vars, `MACF_ROUTING_RUNS_ON`, repo creation) without any
 * section being "skipped" — `plan` listed them as ordinary `create` items,
 * `apply` silently never attempted 3 of them. `FleetPlan.unimplementedByApply`
 * (via {@link planItemApplyCoverage}, the single source of truth for "does
 * apply actually do this") closes that gap the same way `skippedSections`
 * closes the section-level one — see the "Apply coverage" section below.
 */
import { toVariableSegment } from '@groundnuty/macf-core';
import type { FleetAgent, FleetLock, FleetManifest } from './fleet-manifest.js';
import { buildTrustedActorsValue, deriveAppHandle, routerCarryingRepos } from './fleet-manifest.js';
import { formatTable } from '../commands/ps.js';
import type { VaultAgentObservation, VaultCaObservation, VaultRecipientsObservation, VaultRouterAppObservation, VaultTsOauthObservation } from './vault-read.js';
import { countVaultAgentPresence, countVaultCaPresence } from './vault-read.js';
// macf#932 — reuse the SAME flag/env-var name constants `apply`'s own
// pre-flight refusal names, rather than re-typing them here (this is a
// value import, not `import type`; `apply-routing.ts` only ever `import
// type`s from files that in turn `import type` this module, so this stays
// a one-directional runtime dependency — see `apply-routing.ts::
// checkRunnerTokenPreflight`'s doc).
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from './apply-routing.js';
// groundnuty/macf#1186 — same one-directional-runtime-dependency shape as
// the `RUNNER_TOKEN_ENV_VAR`/`RUNNER_TOKEN_FLAG` import immediately above:
// `apply-routing-secrets.ts` only ever `import type`s `Presence` from THIS
// module, so a value import going the other way here creates no runtime
// cycle (only a type-level one, which TS resolves fine).
import { TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_CLIENT_ID_FLAG, TS_OAUTH_SECRET_ENV_VAR, TS_OAUTH_SECRET_FLAG } from './apply-routing-secrets.js';
import { RUNNER_OPS_ROLE, deriveRunnerOpsHandle, runnerOpsNeeded } from './apply-runner-ops.js';
// groundnuty/macf#1105 — same one-directional-runtime-dependency shape as
// the `apply-runner-ops.js` import immediately above (that module ITSELF
// value-imports `deriveRouterAppHandle` from here, so the chain already
// exists and compiles); `apply-router-app.ts` only ever `import type`s
// `Presence` from `plan.js`, never a value, so this stays acyclic at runtime.
import type { RouterAppScope } from './apply-router-app.js';
import { ROUTER_APP_ROLE, deriveRouterAppHandle } from './apply-router-app.js';
// groundnuty/macf#999 — the SAME pure pre-flight `commands/bootstrap-apply.ts`
// refuses `apply` on; `plan` never refuses (it is read-only end to end — see
// this module's own `checkVaultFlagsComplete` doc for the contrast), it
// states the SAME fact as a loud banner instead (requirement 3: "plan states
// it"). One check function, two renderings — never two independently
// hand-authored copies of the underlying fact that could drift.
import type { RegistryRepoScopeNotice, RegistryScopeConflict } from './registry-scope-preflight.js';
import { checkRegistryRepoScopeNotice, checkRegistryScopePreflight } from './registry-scope-preflight.js';
import { validateInstallRepositoryScope } from './install-scope.js';
// groundnuty/macf#1211 — `runner-platform.ts` has no import of THIS module
// (`plan.js`) at all, so this is acyclic at runtime; `describeRunnerPlatformEndpointResolution`
// is the ONE shared renderer `apply-fleet.ts`'s log line and this module's
// `runnerPlatformItem` both call, so the two surfaces never describe the
// same resolved value in two independently-drifting sentences.
import { describeRunnerPlatformEndpointResolution, type RunnerPlatformEndpointResolution } from './runner-platform.js';
// groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — row 3 of the
// reconciler verb matrix (`update` never COMPUTED for a REUSED resource).
// `install-scope-coverage.ts` value-imports `type { Presence }` from THIS
// module already; a type-only import back is acyclic at runtime — same
// one-directional-runtime-dependency shape this file documents repeatedly
// for `apply-routing.js`/`apply-router-app.js`/`runner-platform.js` above.
import type { InstallScopeCoverageEntry } from './install-scope-coverage.js';
// groundnuty/macf#1281 — reuses `app-identity-removal.ts`'s OWN
// org/user-branching App-Advanced-tab URL (the exact convention this issue's
// AC says to read first, not reinvent) for a row-4 App-orphan item's
// "delete it yourself here" link. `app-identity-removal.ts` only ever
// `import type`s from THIS module (`Presence`, transitively via `observer.js`
// too — see that file's own imports), so this is the SAME
// one-directional-runtime-dependency shape this file documents repeatedly
// above (`apply-routing.js`/`apply-router-app.js`/`runner-platform.js`):
// acyclic at runtime.
import { appSettingsAdvancedUrl } from './app-identity-removal.js';

// --- Observed state (the reconcile input; populated by an observer, consumed as data) ---

/** Tri-state existence signal — `'unknown'` means "not observable at plan time," NOT "absent." */
export type Presence = 'present' | 'absent' | 'unknown';

/** One agent's observed provisioning state. */
export interface ObservedAgentState {
  readonly app: Presence;
  readonly appId?: string;
  readonly install: Presence;
  readonly installId?: string;
  readonly repo: Presence;
  /**
   * WHY this agent's `repo` — and, by construction, its `caRepos`/
   * `routingClientRepos` entries too — read `'unknown'` instead of a
   * committed value, set ONLY when that downgrade happened (groundnuty/macf#1026).
   * GitHub returns HTTP 404 identically for "doesn't exist" and "exists but
   * this token isn't entitled to see it" (the SAME ambiguity #969 established
   * for `GET /apps/{slug}` — Amendment A's honest-unknown floor: the API can
   * confirm present, never prove absent). `githubRegistryObserver` therefore
   * only trusts a repo-scoped 404 as confident `'absent'` once THIS run has
   * independently proven the caller can see the parent repo (a `'present'`
   * repo-existence read) — see `observer.ts::resolveAgentRepoState`.
   * `undefined` when `repo` is `'present'` (nothing to explain) or when the
   * downgrade never applied (e.g. `repo` was never even read, the vault-free
   * default).
   */
  readonly repoVisibilityReason?: string;
  /** Secret-name → fingerprint, sourced from `fleet.lock` (never a secret value). */
  readonly fingerprints: Readonly<Record<string, string>>;
  /**
   * The agent's deployed macf CLI version — DR-043 §D6. Sourced from
   * `fleet.lock` ONLY ({@link readFleetLock}'s `deployed_version` field);
   * `undefined` when the lock has no entry, or the entry has never recorded
   * one. This Mac-side, GitHub-only tool still has no mTLS path to an
   * agent's live `/health.version` (that read belongs to `macf fleet
   * upgrade`'s VM-side operational plane, DR-037/§D4) — `deployedVersion`
   * is a LOCK read, never a live one, by design.
   *
   * **The write path exists as of macf#907**: `macf fleet upgrade`'s
   * `rollFleet` (`@groundnuty/macf-core`'s `fleet-upgrade.ts`) records a
   * CONFIRMED verify-green into the control repo's `fleet.lock` via
   * `fleet-lock-recorder.ts`, opt-in behind `fleet upgrade`'s `-f, --file
   * <fleet.yaml>` flag. `undefined` here can therefore mean either "never
   * rolled with `-f`/deployed_version-write-back enabled" or "this `plan`
   * run's `--file` points at a checkout whose `fleet.lock` predates the
   * roll" ({@link readFleetLock} reads the manifest's OWN directory, a
   * residual pre-Amendment-F local read — see that function's doc; it
   * reflects the control repo's committed state only once that local
   * checkout has been `git pull`ed). Either way, `undefined` here MUST
   * read as `unknown`, never as "matches" or "differs" — see `plan.ts`'s
   * `UNKNOWN_REASONS.deployedVersion` and Amendment A's honest-unknown floor.
   */
  readonly deployedVersion?: string;
  /**
   * The repo's committed macf-actions router pin — DR-043 §D6, the OTHER
   * `versions:` field (`versions.actions`). Sourced from a LIVE read of
   * `.github/workflows/agent-router.yml`'s `uses: groundnuty/macf-actions/
   * ...@<pin>` line (`observer.ts::readCallerActionsPin`) — unlike
   * `deployedVersion`, this one genuinely IS live-observable from this tool
   * (a repo-contents read, no VM/mTLS involved). `undefined` on ANY read
   * failure (file absent, no macf-actions `uses:` line, auth/network) —
   * same "collapse absent + unreadable into one signal" posture
   * `readRepoVariable` already establishes for this file's other value
   * reads.
   */
  readonly actionsPin?: string;
  /**
   * Vault-derived secret-field presence for this agent (DR-043 Amendment D
   * phase 3, `vault-read.ts::queryVaultAgentPresence`) — `undefined` when
   * `plan` ran without vault access (the phase-2 default; NOT evidence the
   * vault lacks this agent's secrets, just "not asked this run"). Populated
   * by `observer.ts::vaultAwareObserver`; `githubRegistryObserver` never
   * sets it.
   */
  readonly vault?: VaultAgentObservation;
  /**
   * DR-043 Amendment G correction (groundnuty/macf#1034) — this agent repo's
   * `archived` bit, the per-agent sibling of `ObservedState.controlRepoArchived`'s
   * convention: only meaningful when `repo === 'present'`; `undefined` when
   * `repo` isn't `'present'` (nothing to explain) or the archived bit itself
   * couldn't be read. A STANDALONE read (`observer.ts::checkRepoArchivedState`,
   * the SAME function `plan.ts`'s control-repo observation already uses) —
   * deliberately NOT threaded through `resolveAgentRepoState` (macf#1026),
   * which serves the unrelated CA/routing-client presence trio.
   */
  readonly archived?: boolean;
  /**
   * This agent App's OBSERVED `repository_selection` (groundnuty/macf#1128)
   * — the already-provisioned-fleet sibling of `install-scope.ts`'s
   * apply-time `validateInstall` refusal: that guard only fires for a role
   * `apply` is CREATING or resuming right now; a fleet that reached the bad
   * `"all"`-scoped state BEFORE #1128 shipped (or was provisioned by a run
   * that skipped the gate some other way) would sit there undetected
   * forever without a read that can observe an ALREADY-installed App's
   * scope. Sourced from a live `GET /orgs/{org}/installations` read
   * (`observer.ts::listOrgInstallRepositorySelections`) — org-owned fleets
   * ONLY; `undefined` for a personal-account-owned fleet (no ambient-auth
   * listing endpoint exists there — same limitation
   * `app-presence.ts::resolveAppPresence`'s own predicted-slug fallback
   * has for this exact field) AND whenever the listing call itself
   * couldn't be read. `undefined` therefore means "not observable this
   * way," NEVER "confirmed selected" — `computePlan`'s `installScopeDrift`
   * only warns when this field IS populated and is NOT `'selected'`;
   * `undefined` never producing a warning is the honest-unknown floor
   * (Amendment A4), not a false-clean read.
   */
  readonly installRepositorySelection?: string;
}

/**
 * Everything `macf bootstrap plan` could determine about the fleet's current
 * state. Deliberately data-only (no I/O) so `computePlan` stays pure and
 * every test constructs one by hand — no network, no `gh` shell-outs.
 *
 * The CA is observed at BOTH place-types the DR two-place rule requires
 * (macf#806, until macf-actions#66 collapses it to one): the **registry**
 * (profile/org/repo scope per `owner.registry`) AND a **per-repo** copy on
 * EVERY agent repo. A single "representative" read (the Slice-1a-original
 * shape) cannot reproduce the #806 drift class — a per-repo var absent while
 * the registry + other repos have it — so both legs are carried separately
 * (macf#839 review [BLOCKING] 3).
 */
export interface ObservedState {
  readonly lock: FleetLock | null;
  /** Keyed by the manifest's per-agent `role` field. */
  readonly agents: Readonly<Record<string, ObservedAgentState>>;
  /** Registry-scope `<SEG>_CA_CERT` presence. */
  readonly caRegistry: Presence;
  /** Per-agent-repo `<SEG>_CA_CERT` presence, keyed by `agent.repo`. */
  readonly caRepos: Readonly<Record<string, Presence>>;
  /**
   * Per-agent-repo `ROUTING_CLIENT_CERT` secret presence (groundnuty/macf#920
   * gap 2), keyed by `agent.repo`. A proxy for "has this repo received its
   * routing-client identity" — checks `ROUTING_CLIENT_CERT` only (not also
   * `ROUTING_CLIENT_KEY`), same one-representative-var simplicity `caRepos`
   * already applies to the CA leg. Sourced from `observer.ts::checkRepoSecretPresence`
   * — the SAME read `apply-fleet.ts`'s routing-client publish step uses (via
   * `RoutingClientApplyDeps.checkRepoSecretPresence`), so plan and apply agree
   * on presence by construction. Optional (like `routingTrustedActors`/`vaultCa`
   * above) so every pre-#920 hand-built `ObservedState` test fixture keeps
   * compiling — `routingClientItem` treats an absent entry the same as an
   * explicit `'unknown'` (see `computePlan`'s call site).
   */
  readonly routingClientRepos?: Readonly<Record<string, Presence>>;
  /**
   * Vault-derived per-project CA key/cert presence (DR-043 Amendment D phase
   * 3) — same undefined-vs-observed convention as {@link ObservedAgentState.vault}.
   */
  readonly vaultCa?: VaultCaObservation;
  /**
   * The vault's age-header recipient-STANZA-COUNT fact (DR-043 §D5 recipient
   * reconciliation, groundnuty/macf#957) — `undefined` when this run had no
   * vault access at all (the vault-free default; NOT evidence of a recipient
   * mismatch, just "not asked this run" — same convention as `vaultCa`
   * above). Populated by `observer.ts::vaultAwareObserver`.
   */
  readonly vaultRecipients?: VaultRecipientsObservation;
  /** The `MACF_TRUSTED_ACTORS` value observed on a caller repo, if any (macf#922 — was `MACF_ROUTING_RUNS_ON`, a variable the v3 router never reads; see `apply-routing.ts`'s doc). */
  readonly routingTrustedActors?: string;
  /**
   * Register-before-route gate (macf#922, corrected for the org-runner-blind
   * cost regression by macf#924) — whether a self-hosted runner is
   * CONFIRMED REGISTERED AND USABLE by the representative caller repo
   * (repo-scoped OR org-scoped-with-visibility-admitting-this-repo — see
   * `observer.ts::checkRunnerUsableByRepo`). This is what lets `routingItem`
   * state the runner CLASS the fleet will actually route on (self-hosted
   * vs. github-hosted-and-billed) — a `runs_on: self-hosted` manifest
   * declaration alone is aspirational; the router only self-hosts once BOTH
   * the trust var is set AND a runner is registered.
   */
  readonly routingRunnerRegistered?: Presence;
  /**
   * Org-admin handover message (macf#924) — set only when an org-level
   * runner IS registered but its group's repository-access list excludes
   * the representative caller repo (`routingRunnerRegistered` will be
   * `'absent'` or `'unknown'` in that case, never `'present'`). Names the
   * manual org-admin action; this tool never performs it itself. See
   * `observer.ts::RunnerUsability.handover`'s doc for the full outcome
   * matrix.
   */
  readonly routingRunnerHandover?: string;
  /**
   * Capability diagnostic (macf#934) — set when a runner (repo- or
   * org-scoped) WAS found but fails the register-before-route CAPABILITY
   * check (offline, or online-but-missing-a-required-label), or when the
   * repo-scoped read was a confirmed permission-denied (403). Distinct from
   * `routingRunnerHandover` (a GROUP-VISIBILITY org-admin action); this is a
   * plain explanation with no action implied beyond "check the runner." See
   * `observer.ts::RunnerUsability.detail`'s doc for the full outcome matrix.
   */
  readonly routingRunnerDetail?: string;
  /**
   * groundnuty/macf#1211 — the RAW registry-scope `MACF_RUNNER_PLATFORM_ENDPOINT`
   * variable value (before precedence is applied against env/manifest),
   * `undefined` when this run never attempted the read (a hosted-runner
   * fleet, or `routing.runner` undeclared — see `observer.ts::githubRegistryObserver`'s
   * gate). Exists as its OWN field, separate from {@link runnerPlatformEndpoint}
   * below, so `commands/bootstrap-apply.ts` can thread the RAW scope value
   * into `apply-fleet.ts`'s own resolution (`FleetApplyDeps.
   * observedRunnerPlatformEndpointScope`) without `apply`'s precedence
   * order being polluted by a value plan-time already resolved through a
   * DIFFERENT tier (e.g. env) — see that field's own doc for why conflating
   * the two would misreport provenance in `apply`'s log line.
   */
  readonly runnerPlatformScopeVariable?: string;
  /**
   * groundnuty/macf#1211 — the FULLY-RESOLVED runner-provisioning-contract
   * endpoint (flag/env/scope/manifest precedence already applied), ready to
   * render directly in {@link runnerPlatformItem}'s plan-item reason.
   * `undefined` under the SAME gate {@link runnerPlatformScopeVariable} uses
   * (never attempted this run) — `computePlan`'s call site treats an
   * `undefined` here as `{ value: undefined, source: 'none' }`, the same
   * honest "nothing resolved" state a live read that found nothing would
   * also produce, so a caller that never populates this field (every
   * pre-#1211 `ObservedState` test fixture) keeps compiling and reads as
   * "not configured" — never a false "resolved."
   */
  readonly runnerPlatformEndpoint?: RunnerPlatformEndpointResolution;
  /**
   * DR-043 Amendment G (groundnuty/macf#867) — the `<fleet>-control` repo's
   * own presence. REQUIRED, not optional: an unobservable read must render
   * as honest-`unknown` (Amendment A4), never silently default to "not
   * archived" — an optional field defaulting that way would make an
   * unconfirmed archive state look identical to a confirmed-live fleet.
   */
  readonly controlRepoPresence: Presence;
  /** Only meaningful when `controlRepoPresence === 'present'` — same convention as `control-repo.ts`'s `ControlRepoMeta.archived`. `undefined` when the archived bit itself couldn't be read. */
  readonly controlRepoArchived?: boolean;
  /**
   * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
   * — the control repo's committed macf-actions router pin, the per-repo
   * sibling of {@link ObservedAgentState.actionsPin} (same live read,
   * `observer.ts::readCallerActionsPin`, targeted at the control repo's
   * full name rather than an agent's). The control repo has carried a
   * committed `agent-router.yml` since `#1070`
   * (`apply-control-repo-init.ts`), so it is a router-carrying repo just
   * like every agent repo — see `fleet-manifest.ts::routerCarryingRepos`.
   * `undefined` on ANY read failure (same "collapse absent + unreadable
   * into one signal" posture `actionsPin` already establishes).
   */
  readonly controlRepoActionsPin?: string;
  /**
   * groundnuty/macf#1105 — the router App's presence in THIS fleet's own
   * vault. `undefined` when this run had no vault access at all (the
   * vault-free default; NOT evidence the vault lacks the router App, just
   * "not asked this run"), same convention as {@link vaultCa}/
   * {@link vaultRecipients} above. Populated by `observer.ts::vaultAwareObserver`;
   * `githubRegistryObserver` never sets it. See `routerAppItem`'s doc for why
   * this field — not just `lock` — drives the router-App plan item's
   * presence: a SHARED-scope vault-reuse never writes a `fleet.lock` entry.
   */
  readonly vaultRouterApp?: VaultRouterAppObservation;
  /**
   * groundnuty/macf#1109 — the operator-supplied Tailscale OAuth pair's
   * presence in THIS fleet's own vault, the fleet-level sibling of
   * {@link vaultRouterApp} for the OTHER read-only-vault routing secret.
   * `undefined` when this run had no vault access at all (same
   * "not asked this run" convention every other optional vault-derived
   * field above uses). Populated by `observer.ts::vaultAwareObserver`;
   * `githubRegistryObserver` never sets it. See {@link tsOauthItem}'s doc.
   */
  readonly vaultTsOauth?: VaultTsOauthObservation;
}

/** Produces an `ObservedState` for a manifest. Implemented by `observer.ts`'s `githubRegistryObserver`; faked in tests. */
export type FleetObserverFn = (manifest: FleetManifest) => Promise<ObservedState>;

// --- Plan ---

export type PlanItemKind =
  | 'app'
  | 'repo'
  | 'install'
  | 'secret_fingerprint'
  | 'ca'
  | 'routing'
  | 'runner_warm'
  | 'agent'
  | 'control_repo'
  /** DR-043 Amendment G correction (groundnuty/macf#1034) — an agent repo observed ARCHIVED; the per-agent sibling of `'control_repo'`. See {@link agentRepoArchivedItem}'s doc. */
  | 'agent_repo_archived'
  | 'version'
  | 'actions_pin'
  | 'labels'
  | 'routing_client'
  | 'runner_ops'
  | 'vault_recipients'
  /** groundnuty/macf#1105 — the routing App (`apply-router-app.ts`), a fleet-level identity like `'runner_ops'`, but UNCONDITIONAL: `apply-fleet.ts` reaches its ceremony for every fleet (`routerAppScope === 'shared'` is the schema default). See {@link routerAppItem}'s doc. */
  | 'router_app'
  /** groundnuty/macf#1109 — the operator-supplied Tailscale OAuth pair (`TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`), a fleet-level, read-only-vault credential like `'router_app'`'s own App id/key, but never minted — see {@link tsOauthItem}'s doc. */
  | 'ts_oauth'
  /** groundnuty/macf#1211 — the runner-provisioning contract's endpoint resolution (flag/env/scope/manifest precedence), a fleet-level notice like `'runner_warm'` but with its OWN gate (`runs_on === 'self-hosted'`, not merely `routing.runner` declared — see {@link runnerPlatformItem}'s doc). */
  | 'runner_platform'
  /**
   * groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — row 3 of
   * the reconciler verb matrix: does a REUSED fleet-level App's (`runner_ops`
   * / `router_app`) `selected` install set still COVER every repo the
   * manifest currently declares? Distinct from `'install'` (existence only)
   * and from `install-scope.ts`'s `installScopeDrift` (the install's MODE —
   * `'selected'` vs `'all'` — a different question that module's own doc
   * explicitly forbids conflating with this one). Produced ONLY by
   * {@link installScopeCoverageItem} from already-computed
   * `InstallScopeCoverageEntry` data (the live per-repo JWT probe happens in
   * the CALLER — `commands/bootstrap.ts`, when `--vault`/`--identity-key`
   * are given — before `computePlan` ever sees it; `computePlan` itself
   * stays I/O-free). NEVER emitted by `computePlan`'s own per-agent/
   * fleet-level item construction the way every other kind is — see
   * `computePlan`'s `installScopeCoverage` parameter doc.
   */
  | 'install_scope';
/**
 * `'write-always'` (groundnuty/macf#926) — a distinct verb from `'create'`
 * for the two kinds (`labelsItem`/`runnerWarmItem`) that have NO live
 * comparison against reality at all: they always emit the identical verb
 * regardless of what `computePlan` observed, because nothing was ever read.
 * `'create'` claims "checked, and it's missing" — a claim `'write-always'`
 * does NOT make; it says only "apply attempts this write every run, whether
 * or not it was needed." Conflating the two hides a real gap: a live
 * fault-injection sweep (2026-08 fleet drift exercise) found `plan` caught a
 * deleted `MACF_TRUSTED_ACTORS` var (`routing`, `noop → update`) and a
 * downgraded router pin (`actions_pin`, `noop → update`) but MISSED a
 * deleted repo label — because `labelsItem` was `'create'` unconditionally,
 * so a `plan` run against a REPO WITH THE LABEL ALREADY DELETED reads
 * identically to one against a repo that never had it. A plan-item kind
 * whose verb never varies with reality carries zero signal while LOOKING
 * covered. See `plan-item-write-always.test.ts` for the fixture-driven
 * proof (both directions: `labels`/`runner_warm` never reach `'noop'` even
 * under a fixture where everything ELSE reads `'noop'`; every other kind
 * DOES reach both `'noop'` and a real action verb under some fixture).
 *
 * `'delete'` / `'orphan'` (groundnuty/macf#1229, DR-043 Amendment P3, row 4
 * of the reconciler verb matrix) — see this module's own top-of-file doc for
 * the full contract. In one line: both mean "not declared, but `fleet.lock`
 * says this tool made it" — `'delete'` for cheap-to-revive classes
 * (variables, secrets), `'orphan'` for expensive-to-revive ones (repos,
 * Apps). `'orphan'` is NEVER actioned by `apply`, by design, under any flag —
 * it is an instruction to the operator, not a statement of intent.
 */
export type PlanVerb = 'create' | 'update' | 'noop' | 'report-extra' | 'write-always' | 'delete' | 'orphan';

export interface PlanItem {
  readonly kind: PlanItemKind;
  readonly target: string;
  readonly verb: PlanVerb;
  readonly reason: string;
  /**
   * `update` is ALWAYS `true` (§D3: confirm-then-update, never silent).
   * `delete` is ALSO always `true` (groundnuty/macf#1229 — a negative diff is
   * at least as consequential as a divergent update; a silent-by-default
   * delete-verb is not this change's decision to make quietly, and a future
   * apply-side deletion increment inherits the confirm rail rather than
   * having to add it). Every other verb — INCLUDING `orphan` (never actioned,
   * nothing to confirm about an action `apply` will take) and `write-always`
   * (groundnuty/macf#926 — an unconditional write is not a drift-confirmation)
   * — is always `false`.
   */
  readonly confirm_required: boolean;
}

export interface SkippedSection {
  readonly section: string;
  readonly reason: string;
}

export interface FleetPlan {
  readonly fleet: string;
  readonly items: readonly PlanItem[];
  readonly skippedSections: readonly SkippedSection[];
  /**
   * The subset of `items` that call for action (`create`/`update`/`delete` —
   * `delete` joined this set groundnuty/macf#1229, DR-043 Amendment P3 row 4;
   * `orphan` deliberately does NOT, see `planItemApplyCoverage`'s `orphan`
   * arm) but `apply` has no code path for yet — groundnuty/macf#854 ("plan
   * emitted 7 create items; apply delivered 3, failed 1 loudly, silently
   * skipped 3"). Computed via {@link planItemApplyCoverage}, the single
   * source of truth for "does apply actually do this" — see that function's
   * doc. ALWAYS present (empty array when apply can action everything the
   * plan lists).
   */
  readonly unimplementedByApply: readonly UnimplementedApplyItem[];
  /**
   * groundnuty/macf#999 — 0 or 1 entries: `owner.registry` is singular per
   * fleet (DR-006), so there is at most one conflict to report. ALWAYS
   * present (empty array — same "always present, empty when nothing
   * applies" convention as {@link skippedSections} /
   * {@link unimplementedByApply}) on the `FleetPlan` TYPE; the `--json`
   * serialization deliberately deviates from that convention — see
   * `fleetPlanToJson`'s doc for why.
   */
  readonly registryScopeIssues: readonly RegistryScopeConflict[];
  /**
   * groundnuty/macf#1012 — 0 or 1 entries: `owner.registry` is singular per
   * fleet (DR-006), so there is at most one notice to report. ALWAYS present
   * on the `FleetPlan` TYPE (same "always present, empty when nothing
   * applies" convention as {@link registryScopeIssues}); the `--json`
   * serialization deliberately deviates from that convention for the SAME
   * reason `registryScopeIssues`'s own `fleetPlanToJson` doc gives — see
   * that function's doc.
   */
  readonly registryRepoScopeNotices: readonly RegistryRepoScopeNotice[];
  /**
   * groundnuty/macf#1128 — already-provisioned-fleet install-scope drift:
   * one entry per declared agent whose OBSERVED `repository_selection` is
   * populated (a live org-installations read succeeded) AND is NOT
   * `'selected'`. Zero-to-N entries (unlike `registryScopeIssues`/
   * `registryRepoScopeNotices`, which cap at one — a fleet can have
   * multiple agent Apps, each independently mis-scoped). ALWAYS present
   * (empty array when nothing applies — same convention as
   * {@link skippedSections} / {@link unimplementedByApply}); the `--json`
   * serialization omits the key entirely when empty, matching
   * `registryScopeIssues`'s own documented reason (byte-identical output
   * for a fleet with nothing to report).
   */
  readonly installScopeDrift: readonly InstallScopeDrift[];
  /**
   * groundnuty/macf#1162 — the STANDING notice for a scope-level (owner-
   * account-shared) credential this fleet holds a LOCAL COPY of rather
   * than one it minted itself (today: only the router App's cross-fleet
   * `'vault-reused'` outcome — see `fleet-manifest.ts::ScopeCredentialMarkerSchema`'s
   * doc). Zero-to-N entries; today effectively 0-or-1 (one router role),
   * same "cap follows the underlying fact, not an arbitrary limit" shape
   * `installScopeDrift` already establishes. ALWAYS present on the TYPE
   * (empty array when nothing applies); `--json` omits the key when empty,
   * same convention every sibling notice array above follows.
   *
   * **Sourced from the MANIFEST declaration union the LOCK marker, not the
   * lock alone** (`scopeCredentialNotices`'s doc) — this is what makes
   * "surfaced on every run" true by construction: a fleet that has
   * DECLARED `transport.router_app_origin_fleet` but hasn't `apply`'d yet
   * (or applied without `--vault`, so `apply` never reached the
   * `'vault-reused'` branch) still sees the notice, rather than reading
   * silent until the marker happens to land in `fleet.lock`.
   */
  readonly scopeCredentials: readonly ScopeCredentialNotice[];
}

/**
 * One scope-credential notice (groundnuty/macf#1162) — `message` is built
 * ONCE here (not re-derived per renderer) so `formatScopeCredentialLines`
 * and `fleetPlanToJson` never drift into two independently-worded copies
 * of the same fact, same "one wording, reused" discipline
 * `InstallScopeDrift.message` already establishes.
 */
export interface ScopeCredentialNotice {
  readonly role: string;
  /** `undefined` when neither the manifest nor `fleet.lock` names a source — the marker still renders, honestly incomplete, never silently absent. */
  readonly originFleet?: string;
  readonly message: string;
}

/**
 * One already-provisioned agent App whose observed install scope is wrong
 * (groundnuty/macf#1128). `message` is built from the SAME shared function
 * `apply`'s post-gate-2 refusal uses (`install-scope.ts::
 * validateInstallRepositoryScope`) — one wording, reused, never a second
 * copy drafted for the plan-time surface.
 */
export interface InstallScopeDrift {
  readonly role: string;
  readonly appHandle: string;
  readonly observed: string;
  readonly message: string;
}

/**
 * The reason text for each declared-but-deferred section (Slice 1a; see
 * module doc). `versions` is GONE from this map (DR-043 §D6 is wired as of
 * this change, not deferred) — `collaborators` is the sole remaining member.
 */
export const SKIPPED_SECTION_REASONS = {
  collaborators: 'reconcile not implemented in v1',
} as const;

/**
 * Surface every declared-but-deferred manifest section, loudly. Only fires
 * when the section is actually DECLARED (present) AND, for array sections,
 * non-empty. An absent or empty section stays silent (nothing was promised,
 * so nothing to warn about not having reconciled).
 */
function computeSkippedSections(manifest: FleetManifest): readonly SkippedSection[] {
  const out: SkippedSection[] = [];
  if (manifest.collaborators !== undefined && manifest.collaborators.length > 0) {
    out.push({ section: 'collaborators', reason: SKIPPED_SECTION_REASONS.collaborators });
  }
  return out;
}

// --- Apply coverage (groundnuty/macf#854) ---
//
// `computePlan` above is honest about what's OBSERVED vs DESIRED. It says
// nothing about what `apply` (a DIFFERENT module, `apply-fleet.ts`) is
// actually capable of DOING about a divergence — and as of Slice 2b
// increment 5a, `apply` has no CA or routing orchestrator step at all, and
// never creates a repo (it only runs repo-init config-work against one that
// already exists — `apply-repo-init.ts`'s module doc). The first real
// provision (macf#854) hit this the hard way: `plan` listed 7 `create`
// items, `apply` delivered 3, failed 1 loudly, and SILENTLY skipped the
// other 3 (the registry CA var, the per-repo CA var, the routing var) — with
// no line anywhere saying so. DR-035 §4's whole safety model rests on the
// operator scrutinizing ONE plan before approving; a plan that lists items
// `apply` will never attempt manufactures false confidence, which is worse
// than no gate.
//
// The fix is NOT to make apply refuse (that blocks all provisioning until
// the CA/routing ceremony exists) — it's to make the gap IMPOSSIBLE to miss,
// at both read points: the plan the operator approves, and the summary after
// the run (which is the ONLY output under `--yes`, where no one reads the
// pre-approval plan at all).

/**
 * Whether `apply` has an actual, wired code path for a {@link PlanItem} that
 * calls for action. `noop` / `report-extra` items never call for action —
 * there is nothing for apply to "do," so they are trivially `'implemented'`
 * regardless of kind: the operator must be able to tell "apply won't do
 * this" (a real gap) from "nothing to do" (no gap at all) — see the section
 * doc above.
 */
export type ApplyCoverage = 'implemented' | 'not_implemented';

export interface UnimplementedApplyItem {
  readonly kind: PlanItemKind;
  readonly target: string;
  readonly verb: PlanVerb;
  /** Why `apply` has no code path for this item — distinct from `PlanItem.reason`, which explains the observed/desired divergence, not apply's coverage of it. */
  readonly reason: string;
}

/**
 * The reason text for each kind/verb pair `apply` still cannot action.
 * Keyed by kind, not by item, so this stays the ONE place to update when a
 * future increment wires the remaining routing-update orchestrator step.
 *
 * `repoCreate` is GONE (macf#857, DR-043 Amendment F) — `apply-repo-init.ts`
 * ::`ensureAgentRepo` now creates a missing agent repo from
 * `defaults.role_template` (or blank, for `provenance: 'mirror'`) BEFORE
 * either consent gate opens for that agent. `'repo'` moved into
 * {@link planItemApplyCoverage}'s always-`'implemented'` group below.
 *
 * `ca` is ALSO GONE (macf#838 Amendment D phase 2) — `apply-fleet.ts` now
 * runs the CA ceremony (`apply-ca.ts::resolveCaCert` + `publishCaCertLegs`)
 * for every fleet, mint-or-reuse, two-place-published (macf#806). `'ca'`
 * items never emit an `update` verb (`presenceVerb` — pure existence check),
 * so the kind joined the always-`'implemented'` group entirely — same shape
 * as `'repo'`'s own history above.
 *
 * `version` is ALSO GONE (macf#1045, DR-043 Amendment L) — `apply-version.ts`
 * now calls the `macf fleet upgrade` roll machinery (delegation, never
 * reimplementation) for a diverging `versions.macf`, for BOTH verbs this
 * kind can emit ('create'/unknown-degrade included — the roll's own live
 * probe resolves what the Mac-side plan could only guess at). `'version'`
 * moved into {@link planItemApplyCoverage}'s always-`'implemented'` group.
 *
 * `actions_pin` (the OTHER `versions:` field, `versions.actions`) is ALSO
 * GONE (macf#1072, DR-043 Amendment L extended) — `apply-fleet.ts` now
 * force-rewrites a diverging `agent-router.yml` (per-agent AND control
 * repo — `resolveActionsPinReconcile`), delegating to the SAME
 * `commands/repo-init.ts::repoInit` primitive that already wrote a
 * FRESHLY-CREATED repo's workflow, never a second writer. `'actions_pin'`
 * moved into {@link planItemApplyCoverage}'s always-`'implemented'` group
 * too — no reason string remains here for it.
 *
 * `runner_warm` is ALSO GONE (groundnuty/macf#943, DR-043 Amendment I2) —
 * `apply-fleet.ts` now calls the runner-provisioning contract
 * (`runner-platform.ts::provisionRunner`) with `repo`/`labels`/`warm` for
 * every confirmed self-hosted-runner repo, every run, non-fatally. `'runner_warm'`
 * moved into {@link planItemApplyCoverage}'s always-`'implemented'` group —
 * same "the code path exists" meaning `'version'`/`'actions_pin'` above
 * already established, not a guarantee the live call succeeds (a contract
 * failure is reported via `FleetApplyResult.runnerProvision`, non-fatally).
 */
export const APPLY_UNIMPLEMENTED_REASONS = {
  routing:
    'apply writes MACF_TRUSTED_ACTORS when the variable is ABSENT (create-only) but does NOT overwrite a PRESENT-but-' +
    'diverging value — the task\'s create-only posture ("never silently overwrite") leaves this specific update ' +
    'un-actioned. Set the repo variable manually to the declared value, or re-run apply once a future increment ' +
    'adds confirmed per-item updates; nothing above was changed for this item.',
  // groundnuty/macf#1229 / DR-043 Amendment P3 — row 4's `delete` verb, for
  // EVERY kind it can appear on (variables via `routing`, secrets via
  // `secret_fingerprint`): plan computes the negative diff, but this change
  // deliberately does not wire apply's deletion path (plan-side computation
  // only — see `planItemApplyCoverage`'s `delete` arm). One shared reason
  // text, not one per kind, because the fact is verb-level ("apply doesn't
  // delete yet"), not kind-level.
  rowFourDelete:
    'plan has computed this as a negative diff (fleet.lock records this tool as the one that provisioned it, and ' +
    "it is no longer declared) but apply's deletion path is deliberately left unwired in this change — plan " +
    'computes the diff, nothing removes it automatically yet. Remove it by hand, or wait for a future increment ' +
    'that wires confirmed per-item deletes; nothing above was changed for this item.',
} as const;

/**
 * THE single source of truth for "does `apply` actually do this" — every
 * renderer (plan text, plan `--json`, apply's final summary, apply
 * `--json`) derives from THIS function; none of them hand-roll their own
 * "is this kind implemented" guess. When a future increment wires confirmed
 * per-item routing updates into `apply-fleet.ts`, flipping the matching arm
 * below is the ONLY change needed for every one of those renderers to pick
 * it up (macf#854).
 */
export function planItemApplyCoverage(item: PlanItem): ApplyCoverage {
  // Nothing calls for action → nothing for apply to have a code path for.
  // `'orphan'` joins this group DELIBERATELY — not because apply lacks a
  // code path for it, but because apply must NEVER have one (DR-043
  // Amendment P3: "an instruction to the operator... I will not touch it").
  // Reporting `'not_implemented'` here would render a false "NOT IMPLEMENTED
  // BY APPLY" warning about a verb this tool is never meant to action.
  if (item.verb === 'noop' || item.verb === 'report-extra' || item.verb === 'orphan') return 'implemented';

  // groundnuty/macf#1229 / DR-043 Amendment P3 — row 4's OTHER verb,
  // `'delete'`, DOES call for real action (a statement of intent under the
  // existing plan-approval consent) but THIS change deliberately does not
  // wire apply's execution path for it — plan-side computation only; an
  // apply that starts deleting resources is a separate change with its own
  // review. One line here, not scattered into individual `kind` arms below
  // (which would require every present-and-future delete-eligible kind to
  // remember to say so), so a future deletion-wiring increment flips exactly
  // this line and nothing else.
  if (item.verb === 'delete') return 'not_implemented';
  switch (item.kind) {
    case 'app':
    case 'install':
    case 'secret_fingerprint':
      // apply-agent.ts's gate 1 / gate 2 / vault-write.ts's secret handling.
      return 'implemented';
    case 'agent':
      // Always `report-extra` in practice (computePlan never emits an
      // `agent` item with any other verb) — handled above already; kept
      // here so this switch stays exhaustive over PlanItemKind rather than
      // relying on that invariant silently.
      return 'implemented';
    case 'repo':
    case 'ca':
      // macf#857 (DR-043 Amendment F) / macf#838 Amendment D phase 2:
      // apply-fleet.ts now calls apply-repo-init.ts's `ensureAgentRepo` /
      // apply-ca.ts's CA ceremony for every agent — a `create` verb here IS
      // actioned. Both kinds' items are produced by `presenceVerb`, a pure
      // existence check that only ever emits 'create' or 'noop' — so this
      // arm's only live input is 'create'; 'noop' is filtered above.
      return 'implemented';
    case 'version':
      // DR-043 Amendment L (macf#1045) — `apply-version.ts` now calls the
      // `macf fleet upgrade` roll machinery (delegation, never
      // reimplementation) for a diverging `versions.macf`, unconditionally
      // whenever `versions:` is declared — for BOTH verbs this kind can
      // emit. 'create' (the unobservable-degrade candidate — see
      // `macfVersionItem`'s doc) is included: the roll's own LIVE probe
      // resolves what the Mac-side plan could only guess at from
      // `fleet.lock`, so there is no honest reason to withhold the attempt
      // just because the Mac-side plan-time confidence was low. Unlike
      // `'actions_pin'` below (still a different, un-called command), this
      // kind left the not_implemented group entirely.
      return 'implemented';
    case 'labels':
      // groundnuty/macf#920 gap 1 — `apply-repo-init.ts::applyRepoInitForAgent`
      // attempts label creation on EVERY repo-init run (reused/resumed-install/
      // created), unconditionally. `labelsItem` only ever emits 'create'
      // (`presenceVerb` is never called for this kind — see its own doc), so
      // this arm's only live input is 'create'.
      return 'implemented';
    case 'routing_client':
      // groundnuty/macf#920 gap 2 — apply-fleet.ts's routing-client ceremony
      // publishes create-only when a mint succeeded. Produced by
      // `presenceVerb`, same 'create'-or-'noop'-only shape as 'ca'.
      return 'implemented';
    case 'runner_ops':
      // groundnuty/macf#943 — apply-fleet.ts drives this identity through
      // the exact same gate 1/gate 2 primitive as an 'app'/'install' item
      // (this run's own applyIdentity call, right after the per-agent
      // loop). Produced by `presenceVerb`, same 'create'-or-'noop'-only
      // shape as 'ca'/'routing_client' above.
      return 'implemented';
    case 'routing':
      // macf#838 Amendment D phase 2: apply-fleet.ts writes MACF_TRUSTED_ACTORS
      // when absent (create) — macf#922 corrected the target from
      // MACF_ROUTING_RUNS_ON, a variable the v3 router never reads. It does
      // NOT overwrite a present-but-diverging value — the task's create-only
      // posture forces `update` to stay un-actioned (see
      // APPLY_UNIMPLEMENTED_REASONS.routing). By this point in the switch
      // `item.verb` is guaranteed to be 'create' or 'update' (noop/report-
      // extra returned above), so this is exhaustive over the two remaining
      // verbs. (A 'create' item can STILL be skipped at apply time for want
      // of a confirmed-registered runner — that is a runtime, per-repo gate
      // rendered via `EnsureVariableOutcome`'s 'skipped' status in `apply`'s
      // own summary, not a plan-time apply-coverage gap; see
      // `apply-routing.ts`'s doc.)
      return item.verb === 'create' ? 'implemented' : 'not_implemented';
    case 'runner_warm':
      // groundnuty/macf#942 (DR-043 Amendment I) declared the field;
      // groundnuty/macf#943 wired the enforcement — `apply-fleet.ts` now
      // calls the runner-provisioning contract (`runner-platform.ts::
      // provisionRunner`) with `repo`/`labels`/`warm` for every confirmed
      // self-hosted-runner repo, unconditionally, every run (the contract's
      // own idempotency promise — see that module's doc). "Implemented" here
      // means "apply has a real code path that acts on this," the SAME
      // meaning `'version'`/`'actions_pin'` above already established for
      // this group — not "the contract is guaranteed to honor it" (a
      // `'cluster-problem'`/`'unreachable'` outcome is reported loudly but
      // non-fatally by `runnerProvision`, mirroring `'ca'`'s own "a create
      // verb here IS actioned" framing regardless of whether the live call
      // ultimately succeeds).
      return 'implemented';
    case 'control_repo':
      // DR-043 Amendment G (macf#867): the ONLY verb `controlRepoItem` ever
      // emits is `update` (fired only when archived === true), and
      // `apply-fleet.ts::provisionControlRepo` DOES action it — un-archives
      // on the SAME plan-approve-once confirmation this whole render is
      // building toward (`bootstrap-apply.ts`'s `resolveMutateDeps` sets
      // `controlRepoOptions: { confirmUnarchive: true }` unconditionally
      // once the operator has approved). Unlike `routing`'s `update` case,
      // this one IS wired — `'not_implemented'` here would render a false
      // "NOT IMPLEMENTED BY APPLY" warning about the very capability this
      // increment built.
      return 'implemented';
    case 'agent_repo_archived':
      // DR-043 Amendment G correction (macf#1034) — the per-agent sibling of
      // 'control_repo' above: the ONLY verb `agentRepoArchivedItem` ever
      // emits is `update` (fired only when `obs.archived === true`), and
      // `apply-fleet.ts`'s `ensureAgentRepo` call DOES action it — un-archives
      // on the SAME plan-approve-once confirmation `'control_repo'` already
      // relies on (`bootstrap-apply.ts`'s `resolveMutateDeps` sets
      // `agentRepoOptions: { confirmUnarchive: true }` unconditionally once
      // the operator has approved). Same "this IS wired, not a gap" reasoning
      // as 'control_repo'.
      return 'implemented';
    case 'actions_pin':
      // groundnuty/macf#1072 (DR-043 Amendment L extended to
      // `versions.actions`) — `apply-fleet.ts`'s `resolveActionsPinReconcile`
      // call sites (per-agent + control repo) now force-rewrite a diverging
      // `agent-router.yml`, for BOTH verbs this kind can emit. 'create' (the
      // unobservable-degrade candidate — see `actionsVersionItem`'s doc) is
      // included, same "the attempt resolves what the Mac-side plan could
      // only guess at" reasoning `'version'` already established one entry
      // above this join in macf#1045 — this kind now joins that same
      // always-`'implemented'` group. "Implemented" here means "apply has
      // actual behavior for this," not "every attempt lands a change" — the
      // `vault_recipients` precedent immediately below states the same
      // distinction for its own kind.
      return 'implemented';
    case 'vault_recipients':
      // groundnuty/macf#957 — `apply-fleet.ts::reconcileVaultRecipients` has
      // a REAL code path for the only two verbs `vaultRecipientsItem` ever
      // emits ('update' either direction; 'noop' returned above already).
      // "Implemented" here means "apply has actual behavior for this," not
      // "apply always auto-fixes it": the safe direction (fewer stanzas than
      // declared) re-encrypts when `--identity-key` was given, and BOTH the
      // no-identity-key case and the unsafe shrink direction refuse loudly
      // (a real, intentional apply behavior — never a silent skip) rather
      // than falling through un-actioned.
      return 'implemented';
    case 'router_app':
      // groundnuty/macf#1105 — `apply-fleet.ts` ALREADY drives this identity
      // through the exact same `applyIdentity` gate1/gate2 primitive as an
      // 'app'/'runner_ops' item (via `resolveSharedRouterAppReuse` for
      // shared scope, or directly for per-fleet scope) — this issue is a
      // DISCLOSURE fix (plan didn't render the item apply already creates),
      // never a behavior change on apply's side. Produced by `presenceVerb`,
      // same 'create'-or-'noop'-only shape as 'ca'/'runner_ops' above.
      return 'implemented';
    case 'ts_oauth':
      // groundnuty/macf#1109 — `apply-fleet.ts` reads this fleet's vault for
      // the pair on EVERY run (unconditional, see `apply-fleet.ts`'s doc)
      // and publishes it through `publishRoutingSecrets` alongside the other
      // five secrets whenever available. `tsOauthItem` only ever emits
      // 'create' (available) or 'noop' (absent, either sub-case) — both
      // reflect exactly what `apply` does this run, so this is 'implemented'
      // unconditionally, same shape as 'router_app' immediately above.
      return 'implemented';
    case 'install_scope':
      // groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2a — the
      // widen-gate (`#1232`/`#1233`) IS apply's code path for this verb:
      // `bootstrap-apply.ts` wires `InstallScopeCoverageDeps.onDrift` into
      // its OWN `computeInstallScopeCoverage` call, which opens the install
      // page, states the exact repo set, waits, and re-checks — verified
      // live on `macf-trial` (a widened router install took a runner from
      // `available=0` to `available=1`). This item's ONLY verbs are
      // `'update'`/`'noop'` (`installScopeCoverageItem` never emits
      // anything else — a `status: 'unknown'` entry emits no item at all),
      // both real apply behavior, so this is 'implemented' unconditionally.
      return 'implemented';
    case 'runner_platform':
      // groundnuty/macf#1211 — `apply-fleet.ts` resolves this endpoint and
      // passes it straight into the SAME `provisionRunner` call
      // `'runner_warm'` above already established as 'implemented' — this
      // item's ONLY verb is `write-always` (see `runnerPlatformItem`'s doc:
      // there is no live-observable "is the endpoint correctly pointed"
      // signal to compare a resolved value against, only whether a value
      // resolved this run), same "declared/resolved, not yet independently
      // verifiable, but genuinely acted on" shape `'runner_warm'` uses.
      return 'implemented';
  }
}

/**
 * Verb-first, THEN kind — `'delete'` (groundnuty/macf#1229, row 4) reaches
 * `not_implemented` from {@link planItemApplyCoverage}'s single top-level
 * check regardless of which kind carries it, so the reason is a VERB-level
 * fact ("apply's deletion path is unwired"), checked before the per-kind
 * switch below (which stays exactly as it was — an exhaustive proof that
 * every OTHER not-yet-covered case is `'routing'`/`'update'`, never anything
 * this function should have to special-case per delete-eligible kind).
 */
function unimplementedReasonFor(item: PlanItem): string {
  if (item.verb === 'delete') return APPLY_UNIMPLEMENTED_REASONS.rowFourDelete;
  switch (item.kind) {
    case 'routing':
      return APPLY_UNIMPLEMENTED_REASONS.routing;
    case 'app':
    case 'install':
    case 'secret_fingerprint':
    case 'agent':
    case 'repo':
    case 'ca':
    case 'control_repo':
    case 'agent_repo_archived':
    case 'labels':
    case 'routing_client':
    case 'runner_ops':
    case 'runner_warm':
    case 'vault_recipients':
    case 'version':
    case 'actions_pin':
    case 'router_app':
    case 'ts_oauth':
    case 'runner_platform':
    case 'install_scope':
      // Unreachable: `planItemApplyCoverage` never returns 'not_implemented'
      // for these kinds (see its switch above — 'repo' joined this group in
      // macf#857 / DR-043 Amendment F, 'ca' in macf#838 Amendment D phase
      // 2, 'control_repo' in macf#867 / DR-043 Amendment G, 'agent_repo_archived'
      // in macf#1034 (DR-043 Amendment G correction), 'labels'/
      // 'routing_client' in groundnuty/macf#920, 'runner_ops' in
      // groundnuty/macf#943, 'vault_recipients' in groundnuty/macf#957,
      // 'version' in macf#1045 / DR-043 Amendment L, 'actions_pin' in
      // macf#1072 / DR-043 Amendment L extended, 'router_app' in
      // groundnuty/macf#1105, 'ts_oauth' in groundnuty/macf#1109, 'runner_warm'
      // ALSO joined this group in groundnuty/macf#943 — see
      // `planItemApplyCoverage`'s 'runner_warm' arm for the wiring;
      // 'runner_platform' joined it at birth in groundnuty/macf#1211, same
      // reasoning `'runner_warm'` established; 'install_scope' joined it at
      // birth in groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2a
      // — the widen-gate (`#1232`/`#1233`) is its code path).
      // Kept exhaustive so a NEW `PlanItemKind` added
      // later is a compile error here, not a silent "apply covers
      // everything" false-negative.
      return 'apply has no code path for this item (unclassified — this reason string should be unreachable)';
  }
}

/**
 * The items `computePlan` produced that call for action but `apply` cannot
 * perform yet — the honesty fix for groundnuty/macf#854. Computed once
 * inside `computePlan` so every renderer (plan text/json, apply's final
 * summary/json) agrees; see `planItemApplyCoverage`'s doc.
 */
export function computeUnimplementedByApply(items: readonly PlanItem[]): readonly UnimplementedApplyItem[] {
  const out: UnimplementedApplyItem[] = [];
  for (const item of items) {
    if (planItemApplyCoverage(item) !== 'not_implemented') continue;
    out.push({ kind: item.kind, target: item.target, verb: item.verb, reason: unimplementedReasonFor(item) });
  }
  return out;
}

/**
 * Why a given resource kind can read `unknown`. Per-kind because the causes are
 * genuinely different, and a diagnostic that names the wrong cause is a small
 * lie compounding with every run (macf#842 review): the identity plane is
 * unknown for want of an App JWT (DR-043 Amendment A), whereas a repo or
 * variable read is unknown because the read itself failed (auth / network /
 * insufficient scope) — nothing to do with JWTs.
 */
export const UNKNOWN_REASONS = {
  // macf#913 — this text previously claimed "a vault-aware confirm runs
  // during apply" unconditionally. That was false: through DR-043 Amendment
  // D phase 3, `apply` had no `--vault`/`--identity-key` flags at all (only
  // `plan` did), so NO confirm ever ran, and the operator had no way to know
  // that from this message. `apply` now DOES confirm live — but ONLY when
  // given both flags (see `commands/bootstrap-apply.ts`'s vault-aware
  // confirm-before-create wiring); the wording below states that condition
  // explicitly rather than promising a capability the operator's specific
  // invocation may not have opted into.
  identity:
    'not confirmable at plan time (no App JWT — the PEM lives in the vault). `macf bootstrap apply` confirms ' +
    'it live ONLY when invoked with BOTH --vault and --identity-key — pass both to avoid ' +
    'apply colliding with an existing App name; without them, apply treats this the same way plan does here',
  repo: 'could not be read (auth / network / insufficient scope) — existence unconfirmed',
  variable: 'could not be read (auth / network / insufficient scope) — existence unconfirmed',
  // DR-043 §D6 — deliberately NOT the same cause as `identity` above (no
  // JWT is not why this is unknown) nor `variable` (this isn't a failed
  // GitHub API read either, most of the time): `fleet.lock` simply has never
  // had a `deployed_version` recorded for this agent — either no roll has
  // run the write-back yet (`macf fleet upgrade -f <fleet.yaml>`, macf#907),
  // or this `plan` run's local checkout hasn't pulled the control repo's
  // latest committed lock (see `ObservedAgentState.deployedVersion`'s doc).
  // Naming the real cause matters the same way it did for
  // `identity`/`repo`/`variable` (macf#842 review) — a diagnostic pointing
  // at "no JWT" here would send the operator chasing the wrong fix.
  deployedVersion:
    'not recorded in fleet.lock (no prior apply/upgrade run has captured a deployed version for this agent) ' +
    'and not independently observable from this Mac-side, GitHub-only tool (no mTLS path to the agent\'s ' +
    '`/health` endpoint — that read belongs to `macf fleet upgrade`\'s VM-side operational plane)',
  actionsPin:
    'could not be read from "agent-router.yml" (missing file, no macf-actions `uses:` line, or the read ' +
    'failed — auth / network / insufficient scope)',
} as const;

/** Presence → {verb, reason-suffix} for a pure existence-only resource (App / repo / install / CA). */
function presenceVerb(
  presence: Presence,
  unknownReason: string,
): { readonly verb: 'create' | 'noop'; readonly reasonSuffix: string } {
  switch (presence) {
    case 'present':
      return { verb: 'noop', reasonSuffix: 'already present' };
    case 'absent':
      return { verb: 'create', reasonSuffix: 'missing' };
    case 'unknown':
      return {
        verb: 'create',
        reasonSuffix: `${unknownReason} — treated as a create-candidate, LOW CONFIDENCE`,
      };
  }
}

/**
 * groundnuty/macf#1281 — the exact URL a row-4 `orphan` item points the
 * operator at to delete/archive the resource BY HAND (this tool never
 * touches it — see the module-doc `orphan` entry). One dispatch point so
 * `computePlan`'s two orphan branches (`kind: 'app'` / `kind: 'repo'`) never
 * hand-roll the URL logic twice.
 *
 * **`'app'` is ALWAYS resolvable.** `owner.type` is a required manifest
 * field (never ambiguous) and {@link deriveAppHandle} is a deterministic
 * derivation from `fleetName` + `role` (both always in scope at the
 * `computePlan` call site) — so there is no `'unknown'` branch to reach
 * here. Delegates to `app-identity-removal.ts`'s {@link appSettingsAdvancedUrl}
 * — the SAME org/user-branching Advanced-tab URL that module's teardown
 * report already points an operator at for the identical "delete this App
 * by hand" reason, per this issue's own AC ("read [the convention] first;
 * do not invent a second convention").
 *
 * **`'repo'` resolves iff `lockedRepo` is given — `'unknown'` otherwise, and
 * BOTH are honest, not a gap to fill later.** Before groundnuty/macf#1296,
 * `FleetLockAgentSchema` carried no `repo` field at all, so a row-4 role
 * (by definition absent from `manifest.agents[]`) had no repo anywhere this
 * tool could read — every repo orphan was unconditionally `'unknown'`. Now
 * `fleet.lock.agents[].repo` (populated by `composeFleetLock` — see that
 * schema field's own doc) carries the value FORWARD from when the role was
 * still declared, so a lock written after this change can name it. **A lock
 * written BEFORE this change predates the field — `lockedRepo` is
 * `undefined` there, and this function returns `'unknown'`, exactly as
 * before.** The honest-unknown path does not disappear; it stops being the
 * only path. `lockedRepo` is `owner/repo` verbatim (`FleetAgent.repo`'s own
 * shape — see `apply-delete.ts::realDeleteRepoVariable`'s identical
 * `repos/${repo}` convention) — the URL is built by appending `/settings`
 * directly, never by re-deriving a name from `role` (still unsound on the
 * merits per `templates/bootstrap-spec.example.json`'s own worked example:
 * a repo name is operator-supplied free text, not derived from `role` —
 * `code-agent`'s repo is `icsoc-2026-experiment`, not
 * `icsoc-2026-code-agent`). Guessing was never acceptable; reading a value
 * this tool itself recorded is not a guess.
 */
export function orphanResourceUrl(kind: 'app' | 'repo', fleetName: string, role: string, owner: FleetManifest['owner'], lockedRepo?: string): string {
  if (kind === 'repo') return lockedRepo !== undefined ? `https://github.com/${lockedRepo}/settings` : 'unknown';
  return appSettingsAdvancedUrl(owner, deriveAppHandle(fleetName, role));
}

function appItem(fleetName: string, agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const handle = deriveAppHandle(fleetName, agent.role);
  const { verb, reasonSuffix } = presenceVerb(obs?.app ?? 'unknown', UNKNOWN_REASONS.identity);
  return {
    kind: 'app',
    target: `agent:${agent.role}:app:${handle}`,
    verb,
    reason: `GitHub App "${handle}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

function repoItem(agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const { verb, reasonSuffix } = presenceVerb(obs?.repo ?? 'unknown', UNKNOWN_REASONS.repo);
  return {
    kind: 'repo',
    target: `agent:${agent.role}:repo:${agent.repo}`,
    verb,
    reason: `repo "${agent.repo}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

/**
 * The role/status labels `repo-init` creates on `agent.repo` (groundnuty/macf#920
 * gap 1) — the labels the router dispatches on (`route-by-label`) and the
 * issue-lifecycle status labels (`in-progress`/`in-review`/`blocked`/
 * `agent-offline`). Always a LOW-CONFIDENCE `unknown`-degrade `create`
 * candidate: unlike `caRepoItem`/`routingClientItem`, this tool has no
 * cheap, single-call live read for "are all 5 labels present on this repo"
 * (it would mean N GitHub API calls per repo just for the plan preview) —
 * the same `presenceVerb(..., UNKNOWN_REASONS.variable)` degrade
 * `caRegistryItem`/`caRepoItem` use for a genuinely-unread value, applied
 * here because there IS no read at all, not because one failed. `apply`
 * always attempts label creation regardless of this item's verb (repo-init
 * runs unconditionally for `reused`/`resumed-install`/`created` — see
 * `apply-fleet.ts`'s loop) — this item exists purely so the operator sees
 * "labels" named explicitly in the pre-approval plan, not folded silently
 * into the `repo` item.
 *
 * `verb: 'write-always'`, NOT `'create'` (groundnuty/macf#926) — a live
 * fault-injection sweep against a real fleet found `plan` caught a deleted
 * `MACF_TRUSTED_ACTORS` var and a downgraded router pin as drift, but MISSED
 * a deleted repo label, because this function has NO `obs` parameter at
 * all — the verb could never legitimately vary with reality. `'create'`
 * implicitly claims "checked, and it's missing"; that claim is false here
 * on every run, whether or not the labels already exist. `'write-always'`
 * states the honest alternative instead — see `PlanVerb`'s doc.
 */
function labelsItem(agent: FleetAgent): PlanItem {
  return {
    kind: 'labels',
    target: `agent:${agent.role}:labels:${agent.repo}`,
    verb: 'write-always',
    reason:
      `role + status labels on "${agent.repo}" are not observable at plan time (no per-label API read wired) — ` +
      'apply attempts label creation unconditionally on every repo-init run, whether or not the labels already ' +
      'exist; this item cannot distinguish "missing" from "already present".',
    confirm_required: false,
  };
}

/**
 * The runner-ops App plan item (groundnuty/macf#943, conditioned per
 * groundnuty/macf#1083) — ONE item per fleet (not per agent; this App is
 * never declared in `manifest.agents[]`), so the operator sees "the extra
 * App and its two clicks" (task brief) called out explicitly rather than
 * folded silently into the per-agent `app` items above. Presence is read
 * directly off `observed.lock.agents` (no `ObservedState` field addition
 * needed — the same `fleet.lock` this function's caller already threads
 * through) since `githubRegistryObserver` only ever populates
 * `ObservedState.agents` from `manifest.agents` (never from lock-only
 * roles), so there is no risk of this role being double-counted as a
 * `report-extra` `agent` item at the bottom of `computePlan` — see that
 * function's doc.
 *
 * `absent`-vs-`unknown` mirrors `appItem`'s own convention exactly: no lock
 * entry reads as `unknown` (Amendment A4 — the lock is a HINT, never
 * authoritative for "does the App exist on GitHub"; only a live JWT check
 * could confirm `absent`, which this Mac-side, offline-safe function never
 * attempts), never a false `absent`.
 *
 * **`needed` (groundnuty/macf#1083) — this App's sole purpose is minting
 * self-hosted-runner registration tokens, so a fleet that never declares
 * `routing.runner.runs_on: self-hosted` (`runnerOpsNeeded`'s doc, the SAME
 * predicate `apply-fleet.ts` gates its own create-or-reuse ceremony on —
 * one predicate, never two that could drift) has nothing for it to do:**
 *
 *   - `!needed && !lockHasEntry` — the common hosted-runner case. Returns
 *     `undefined` (no item emitted at all) — the SAME "nothing was
 *     promised, so nothing is said" convention `computePlan`'s
 *     `routing`/`runner_warm` items already use when `routing.runner` isn't
 *     declared. This is what drops `runner_ops` out of the App-creation SET
 *     entirely (never merely out of a count) and is what lets
 *     {@link countAppsToCreate}'s click ceiling read lower for a
 *     hosted-runner fleet without any special-casing there.
 *   - `!needed && lockHasEntry` — an ORPHAN: a prior run created this App
 *     while the manifest DID declare self-hosted, and a later edit dropped
 *     that declaration. `verb: 'noop'` (apply never deletes an App — §D3
 *     Design invariant 4) but the reason says so EXPLICITLY, never silently
 *     dropped from the plan — the "do not silently ignore it" half of
 *     #1083's requirement.
 *   - `needed` — unchanged from #943's original behavior.
 */
function runnerOpsItem(fleetName: string, lockHasEntry: boolean, needed: boolean): PlanItem | undefined {
  const handle = deriveRunnerOpsHandle(fleetName);
  if (!needed) {
    if (!lockHasEntry) return undefined;
    return {
      kind: 'runner_ops',
      target: `runner_ops:app:${handle}`,
      verb: 'noop',
      reason:
        `Runner-ops GitHub App "${handle}" is recorded in fleet.lock from a prior run, but ` +
        'routing.runner.runs_on is no longer "self-hosted" — it is an ORPHAN, no longer needed by this ' +
        'manifest. apply never deletes an App (teardown is a separate, deliberate operator action); it is ' +
        'left exactly as recorded. Archive or remove it manually on GitHub if it is no longer wanted.',
      confirm_required: false,
    };
  }
  const { verb, reasonSuffix } = presenceVerb(lockHasEntry ? 'present' : 'unknown', UNKNOWN_REASONS.identity);
  return {
    kind: 'runner_ops',
    target: `runner_ops:app:${handle}`,
    verb,
    reason:
      `Runner-ops GitHub App "${handle}" ${reasonSuffix} — a SECOND, minimal App per fleet ` +
      '(administration:write / actions:read / metadata:read; the main agent App\'s permission set has no ' +
      'administration rights and is deliberately not widened to add them). Provisioning it costs 2 operator consent-gate clicks (App-manifest ' +
      'creation + install), same shape as a coordination agent App.',
    confirm_required: false,
  };
}

/**
 * groundnuty/macf#1162 — construct ONE {@link ScopeCredentialNotice} from a
 * role + an optional origin-fleet name. Exported so `computePlan`'s
 * manifest-∪-lock union (its call site, right after the `router_app` item
 * push) and any future direct caller build the EXACT same wording — one
 * function, never two independently-drafted copies of the same fact (same
 * discipline {@link InstallScopeDrift}'s shared `validateInstallRepositoryScope`
 * message-builder already establishes for its own surface).
 *
 * `originFleet: undefined` renders an HONEST "not declared" note rather
 * than omitting the notice — the marker's whole point (per
 * `fleet-manifest.ts::ScopeCredentialMarkerSchema`'s doc) is that it must
 * never read as silently indistinguishable from genuine ownership, and
 * that holds whether or not an origin was ever named.
 */
export function scopeCredentialNotice(role: string, originFleet: string | undefined): ScopeCredentialNotice {
  const origin =
    originFleet !== undefined
      ? `fleet "${originFleet}"`
      : 'an undeclared origin fleet (declare transport.router_app_origin_fleet in fleet.yaml to name it)';
  return {
    role,
    ...(originFleet !== undefined ? { originFleet } : {}),
    message:
      `"${role}" App credential is scope-level and held LOCALLY on this fleet, not minted here — copied from ` +
      `${origin}, pending a future shared-credential store. No action needed; this notice stays visible every run ` +
      'until that store exists.',
  };
}

/**
 * The router-App plan item (groundnuty/macf#1105) — ONE item per fleet, the
 * fleet-level sibling of {@link runnerOpsItem} for `apply-router-app.ts`'s
 * routing App (mints the registry-read token `agent-router.yml` needs).
 * **Unconditional**, unlike `runnerOpsItem`'s `needed` gate: `apply-fleet.ts`
 * reaches this identity's ceremony for EVERY fleet regardless of manifest
 * content (`routerAppScope === 'shared'` is the schema default, per
 * macf#1082) — verified against the real call site (`apply-fleet.ts`
 * ~line 1493 onward): no `registry.type` guard exists there today, despite
 * `apply-router-app.ts::routerAppInstallRepos`'s doc describing an
 * "apply-fleet.ts is expected to skip this App's identity ceremony entirely
 * for a local registry" behavior that is NOT actually implemented — a
 * separate, pre-existing gap this issue's own audit surfaces but does not
 * fix (fixing it would be an APPLY behavior change, out of scope for a
 * disclosure-only fix). Plan renders what apply ACTUALLY does, not what a
 * sibling doc aspires to.
 *
 * Silence here was the exact defect groundnuty/macf#1105 reported:
 * `apply-fleet.ts` carries the full router-App machinery
 * (`routerAppIdentityRequest`/`resolveSharedRouterAppReuse`/
 * `RouterAppApplyOutcome`) and reaches it on every ordinary fleet, but
 * `plan.ts` never rendered it — the operator's click-ceiling read one
 * consent gate short of what `apply` actually opens.
 *
 * **Presence resolution — two sources, lock first, matching
 * `resolveSharedRouterAppReuse`'s own vault-then-live-check order, but
 * through data this Mac-side, offline-safe function can actually read (no
 * live GitHub call, no App JWT — Amendment A's honest-unknown floor):**
 *   - `lockHasEntry` — this fleet's OWN `fleet.lock` carries a `role:
 *     'router'` entry whenever THIS fleet did the original create/reuse
 *     ceremony, for BOTH scopes (the only status that skips the lock write
 *     is `'vault-reused'` — see `apply-router-app.ts::RouterAppApplyOutcome`'s
 *     doc). Same "no lock entry reads as `unknown`" convention `appItem`
 *     already uses.
 *   - `vaultRouterApp` — THIS fleet's own vault (`--vault`/`--identity-key`,
 *     the SAME credentials `resolveSharedRouterAppReuse` itself reads at
 *     apply time) carrying `MACF_ROUTING_APP_ID`. This is the ONLY way a
 *     `'vault-reused'` outcome (shared-scope reuse of an App a DIFFERENT
 *     fleet originally created) is ever visible to a read-only tool, since
 *     that outcome deliberately never touches THIS fleet's lock — without
 *     this second source, a fleet using genuine cross-fleet shared reuse
 *     would read "create" on every single `plan` run, forever, even though
 *     `apply` mints nothing and reuses everything.
 * `lockHasEntry` wins when both are available (a lock entry is a STRONGER
 * fact — it means THIS run's own prior `apply` already confirmed the App
 * live); the vault is the fallback that makes shared-reuse visible at all;
 * neither present degrades to `'unknown'` (LOW CONFIDENCE create), the same
 * floor every other identity item in this file uses.
 *
 * **The reason text names the shared-scope refusal possibility, not just
 * "would create"** — vault-confirmed-absent in SHARED scope has TWO real
 * apply outcomes (mint, or `routerAppNameCollisionMessage`'s refusal on a
 * live name collision) that plan cannot distinguish without a live GitHub
 * call; `bound: 'maximum'` already carries this honestly at the budget
 * level, but the per-item reason should not read as a promise apply will
 * always mint.
 */
function routerAppItem(
  fleetName: string,
  ownerAccount: string,
  scope: RouterAppScope,
  lockHasEntry: boolean,
  vaultRouterApp: VaultRouterAppObservation | undefined,
): PlanItem {
  const handle = deriveRouterAppHandle(fleetName, ownerAccount, scope);
  const presence: Presence = lockHasEntry
    ? 'present'
    : vaultRouterApp?.status === 'confirmed'
      ? vaultRouterApp.present
        ? 'present'
        : 'absent'
      : 'unknown';
  const { verb, reasonSuffix } = presenceVerb(presence, UNKNOWN_REASONS.identity);
  const scopeNote =
    scope === 'shared'
      ? `a SHARED App reused across every fleet owned by "${ownerAccount}" (transport.router_app_scope: shared, ` +
        'the default). If no vault credentials for it are supplied and the name is confirmably taken on GitHub ' +
        'at apply time, apply REFUSES with a two-option instruction rather than minting a duplicate or falling ' +
        'back to per-fleet scope silently.'
      : 'a dedicated App for this fleet alone (transport.router_app_scope: per-fleet).';
  return {
    kind: 'router_app',
    target: `router_app:app:${handle}`,
    verb,
    reason:
      `Routing GitHub App "${handle}" ${reasonSuffix} — ${scopeNote} Mints the registry-read token ` +
      '"agent-router.yml" needs to route; without it the routing plane is fully wired (workflow + client-cert ' +
      'secrets) but structurally incapable of routing. Provisioning costs 2 operator consent-gate clicks ' +
      '(App-manifest creation + install), same shape as a coordination agent App.',
    confirm_required: false,
  };
}

/**
 * The Tailscale-OAuth-pair plan item (groundnuty/macf#1109) — ONE item per
 * fleet, the read-only sibling of {@link routerAppItem}: `TS_OAUTH_CLIENT_ID`/
 * `TS_OAUTH_SECRET` are Amendment C operator-supplied credentials (never
 * minted), published to every router-carrying repo through the SAME unified
 * `publishRoutingSecrets` call `routerAppItem`'s own `MACF_ROUTING_APP_*`
 * pair goes through (`apply-fleet.ts`'s doc — "not a second path"). Disclosed
 * here so the operator learns whether the run will actually publish them
 * BEFORE approving the plan, rather than from a trailing "next steps" note
 * after the fact — the groundnuty/macf#1109 defect this item closes: `apply`
 * silently asked the operator to hand-type values that were already sitting
 * in the vault it had just read.
 *
 * **Vault presence is checked UNCONDITIONALLY, regardless of
 * `transport.tailscale_oauth_required`** — mirrors the `apply-fleet.ts` fix
 * this same issue makes: the manifest flag only changes how loudly `apply`
 * treats an ABSENT vault (refuse-before-gate-1 vs. an honest not-ready-yet
 * skip); it never gates whether a PRESENT vault value gets used, and this
 * plan item must not disagree with what `apply` actually does. `verb: 'noop'`
 * for BOTH absent sub-cases (declared-and-absent, undeclared-and-absent) —
 * in neither case does THIS run write these two secrets, which is what
 * `verb` describes; the REASON text (not the verb) carries the honest
 * "routing will not function" consequence, same "verb describes apply's
 * action, reason carries nuance" split `routingItem`'s non-self-hosted noop
 * branch already establishes.
 */
/**
 * groundnuty/macf#1186 — an UNCONDITIONAL note (not a "you're missing it"
 * detection), same shape + rationale as `RUNNER_TOKEN_PLAN_NOTE` above:
 * `plan` takes no `--ts-oauth-client-id`/`--ts-oauth-secret` flags of its
 * own and never will (it cannot know whether the operator intends to
 * supply them directly to a future `apply` invocation without ever
 * exporting the env fallbacks) — so this names the ALTERNATIVE path rather
 * than guessing at its satisfaction. Appended ONLY to `tsOauthItem`'s two
 * ABSENT-from-vault branches (unconfirmable-at-plan-time and
 * confirmed-absent) — the "present in the supplied vault" branch already
 * has a satisfied answer and needs no alternative named. This is the fix
 * for the defect #1186 reports: a fresh org's cold-start plan (no
 * `--vault`/`--identity-key` given at all) previously said only "supply
 * the operator-provided values into the vault," with no way in that didn't
 * presuppose a vault already existing to write into.
 */
const TS_OAUTH_FLAG_PLAN_NOTE =
  ` Alternatively, \`macf bootstrap apply\` accepts ${TS_OAUTH_CLIENT_ID_FLAG}/${TS_OAUTH_SECRET_FLAG} (or their ` +
  `${TS_OAUTH_CLIENT_ID_ENV_VAR}/${TS_OAUTH_SECRET_ENV_VAR} env fallbacks) directly — no pre-existing vault needed ` +
  'for that path.';

function tsOauthItem(
  fleetName: string,
  tailscaleOauthRequired: boolean,
  vaultTsOauth: VaultTsOauthObservation | undefined,
): PlanItem {
  const target = `ts_oauth:fleet:${fleetName}:TS_OAUTH`;
  const requirementNote = tailscaleOauthRequired
    ? ' transport.tailscale_oauth_required is declared true on this fleet.'
    : ' transport.tailscale_oauth_required is NOT declared on this fleet, but agent-router.yml requires this pair ' +
      'unconditionally regardless of that flag — apply publishes it whenever the supplied vault has it, declared ' +
      'or not, and the flag only governs how loudly an ABSENT vault is treated.';

  if (vaultTsOauth === undefined || vaultTsOauth.status === 'unknown') {
    const unknownReason = vaultTsOauth?.status === 'unknown' ? vaultTsOauth.reason : 'no --vault/--identity-key given this run';
    return {
      kind: 'ts_oauth',
      target,
      verb: 'create',
      reason:
        `Tailscale OAuth pair (TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET) presence could not be confirmed at plan time ` +
        `(${unknownReason}) — treated as a create-candidate.${requirementNote} Routing will not function without ` +
        `this pair regardless of how apply ultimately resolves it.${TS_OAUTH_FLAG_PLAN_NOTE}`,
      confirm_required: false,
    };
  }

  if (vaultTsOauth.present) {
    return {
      kind: 'ts_oauth',
      target,
      verb: 'create',
      reason:
        'Tailscale OAuth pair (TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET) present in the supplied vault — apply WILL ' +
        'publish both to every router-carrying repo through the same unified six-secret publisher.' + requirementNote,
      confirm_required: false,
    };
  }

  return {
    kind: 'ts_oauth',
    target,
    verb: 'noop',
    reason:
      (tailscaleOauthRequired
        ? 'Tailscale OAuth pair ABSENT from the supplied vault though transport.tailscale_oauth_required is ' +
          'declared true — apply will REFUSE THE ENTIRE RUN before consent gate 1. Supply the operator-provided ' +
          'values into the vault before running apply.'
        : 'Tailscale OAuth pair ABSENT from the supplied vault (or no vault supplied) and ' +
          'transport.tailscale_oauth_required is not declared — apply will NOT publish these secrets this run. ' +
          'Routing will NOT function on this fleet until TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET are supplied — ' +
          'agent-router.yml requires this pair unconditionally; the GitHub-hosted runner cannot reach agent VMs ' +
          'without joining the tailnet through it.') + TS_OAUTH_FLAG_PLAN_NOTE,
    confirm_required: false,
  };
}

function installItem(fleetName: string, agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const handle = deriveAppHandle(fleetName, agent.role);
  const { verb, reasonSuffix } = presenceVerb(obs?.install ?? 'unknown', UNKNOWN_REASONS.identity);
  return {
    kind: 'install',
    target: `agent:${agent.role}:install:${handle}`,
    verb,
    reason: `App install for "${handle}" on "${agent.repo}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

/**
 * groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — row 3 of the
 * reconciler verb matrix: turns ONE already-computed
 * `InstallScopeCoverageEntry` (`install-scope-coverage.ts::evaluateInstallScopeCoverage`)
 * into a `PlanItem`. Before this function existed, `apply` already computed
 * and printed the correct desired repo set for `runner_ops`/`router_app`
 * (`#1225`) and already opened a widen-gate for a confirmed `'drift'`
 * (`#1232`/`#1233`, verified live on `macf-trial`) — but `plan` only ever
 * rendered the finding as a discarded coverage-warning LINE
 * (`commands/bootstrap.ts`'s `installScopeCoverageLines`), never as a
 * `PlanItem` with a `verb`. Amendment P2's framing: "the desired set is
 * computed, printed into a consent preview, and discarded." This function is
 * the fix — reusing the SAME `status`/`message` the coverage section's own
 * text rendering builds from (`installScopeCoverageDriftMessage`/
 * `installScopeCoverageUnknownMessage`), never a second copy.
 *
 * **Verb mapping — Amendment A's honest-unknown floor, same discipline
 * `macfVersionItem`/`actionsVersionItem` already establish for a value-diff
 * item, but resolved DIFFERENTLY for the unobservable case:**
 *   - `status === 'drift'` → `update`, `confirm_required: true` (§D3).
 *     `apply` DOES action this — the widen-gate IS its code path (see
 *     {@link planItemApplyCoverage}'s `'install_scope'` arm).
 *   - `status === 'covered'` → `noop` — the declared set is fully covered.
 *   - `status === 'unknown'` → **no item at all** (`undefined`), NOT
 *     `'create'`. Unlike `macfVersionItem`'s unobservable-degrade (where
 *     `'create'` is defensible because the roll machinery genuinely attempts
 *     something), `'create'` here would falsely claim "this App doesn't
 *     exist" for an App the coverage probe only reached BECAUSE it exists —
 *     and `'noop'` would falsely claim a confirmed match neither the tool
 *     nor the operator has evidence for. There is no honest verb to spend on
 *     "could not tell" in this specific case, so this function declines to
 *     manufacture one; the existing `install_scope_coverage` section
 *     (`bootstrap.ts`'s own render, unchanged by this function) still names
 *     the unverified repos in prose.
 */
function installScopeCoverageItem(entry: InstallScopeCoverageEntry): PlanItem | undefined {
  const target = `${entry.role}:install_scope:${entry.appHandle}`;
  if (entry.status === 'drift') {
    return {
      kind: 'install_scope',
      target,
      verb: 'update',
      reason: entry.message ?? `App "${entry.appHandle}" installation no longer covers every repo the manifest declares.`,
      confirm_required: true,
    };
  }
  if (entry.status === 'covered') {
    return {
      kind: 'install_scope',
      target,
      verb: 'noop',
      reason: `App "${entry.appHandle}" installation covers every repo the manifest declares (${String(entry.expectedRepos.length)} expected, 0 missing).`,
      confirm_required: false,
    };
  }
  return undefined;
}

/**
 * Render a vault-derived agent observation as a plan-reason suffix — the
 * "plan-visible" half of DR-043 Amendment D phase 3 (`vault-read.ts`'s
 * module doc: "lifts phase 2 into Amendment A's confirm tier"). Returns `''`
 * (byte-identical to before this field existed) when `vault` is `undefined`
 * — a plan run without vault access renders exactly as it always has;
 * nothing here changes `secretFingerprintItem`'s CREATE/NOOP decision, only
 * the reason TEXT, so this is purely additive over the phase-2 behavior.
 */
function formatVaultAgentSuffix(vault: VaultAgentObservation | undefined): string {
  if (vault === undefined) return '';
  if (vault.status === 'unknown') return ` [vault: unknown — ${vault.reason}]`;
  const { present, total } = countVaultAgentPresence(vault.presence);
  return ` [vault: ${String(present)}/${String(total)} secret fields present]`;
}

/** CA sibling of {@link formatVaultAgentSuffix} — same undefined-is-a-no-op contract. */
function formatVaultCaSuffix(vaultCa: VaultCaObservation | undefined): string {
  if (vaultCa === undefined) return '';
  if (vaultCa.status === 'unknown') return ` [vault: unknown — ${vaultCa.reason}]`;
  const { present, total } = countVaultCaPresence(vaultCa.presence);
  return ` [vault: ${String(present)}/${String(total)} CA fields present]`;
}

function secretFingerprintItem(agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const fingerprints = obs?.fingerprints ?? {};
  const count = Object.keys(fingerprints).length;
  const vaultSuffix = formatVaultAgentSuffix(obs?.vault);
  if (count === 0) {
    return {
      kind: 'secret_fingerprint',
      target: `agent:${agent.role}:secrets`,
      verb: 'create',
      reason: `no fingerprints recorded in fleet.lock — agent has not been provisioned yet${vaultSuffix}`,
      confirm_required: false,
    };
  }
  return {
    kind: 'secret_fingerprint',
    target: `agent:${agent.role}:secrets`,
    verb: 'noop',
    reason:
      `${String(count)} fingerprint(s) recorded in fleet.lock. Live-registry fingerprint drift-detection ` +
      `(re-materialize-from-vault on clobber) is a Slice-2 concern — not exercised by plan-only Slice 1a.${vaultSuffix}`,
    confirm_required: false,
  };
}

/** The registry-scope CA plan item — one of the two DR two-place-rule legs (macf#806). */
function caRegistryItem(seg: string, presence: Presence, vaultCa: VaultCaObservation | undefined): PlanItem {
  const varName = `${seg}_CA_CERT`;
  const { verb, reasonSuffix } = presenceVerb(presence, UNKNOWN_REASONS.variable);
  return {
    kind: 'ca',
    target: `ca:registry:${varName}`,
    verb,
    reason: `registry CA var "${varName}" ${reasonSuffix}${formatVaultCaSuffix(vaultCa)}`,
    confirm_required: false,
  };
}

/**
 * The per-agent-repo CA plan item — the other DR two-place-rule leg
 * (macf#806). One of these per agent repo is what lets the plan reproduce
 * the #806 drift class: registry + repo-A present, repo-B absent.
 */
function caRepoItem(seg: string, repo: string, presence: Presence): PlanItem {
  const varName = `${seg}_CA_CERT`;
  const { verb, reasonSuffix } = presenceVerb(presence, UNKNOWN_REASONS.variable);
  return {
    kind: 'ca',
    target: `ca:repo:${repo}:${varName}`,
    verb,
    reason: `per-repo CA var "${varName}" on "${repo}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

/**
 * The per-agent-repo routing-client secret plan item (groundnuty/macf#920
 * gap 2) — the `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` GitHub Actions
 * secrets the macf-actions router presents as its mTLS client identity when
 * POSTing to a peer agent's `/notify`. Live-observable (unlike `labelsItem`)
 * via `observer.ts::checkRepoSecretPresence` — the SAME read `apply-fleet.ts`'s
 * publish step uses, so plan and apply agree on presence by construction
 * (same discipline `caRepoItem`'s presence-source sharing already
 * establishes). Checks `ROUTING_CLIENT_CERT` only as a proxy for "this repo
 * has its routing-client identity" — see `ObservedState.routingClientRepos`'s
 * doc for why a single representative secret is enough (mirrors `caRepoItem`'s
 * own one-var-per-repo simplicity).
 */
function routingClientItem(repo: string, presence: Presence): PlanItem {
  const { verb, reasonSuffix } = presenceVerb(presence, UNKNOWN_REASONS.variable);
  return {
    kind: 'routing_client',
    target: `routing_client:repo:${repo}:ROUTING_CLIENT_CERT`,
    verb,
    reason: `routing-client secret "ROUTING_CLIENT_CERT" on "${repo}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

/**
 * macf#932 — a note (not a "you're missing it" detection): `plan` takes no
 * `--runner-token` flag of its own and never will (see this note's call
 * site's doc) — it cannot know whether the OPERATOR intends to supply one
 * directly to a future `apply` invocation without ever exporting
 * {@link RUNNER_TOKEN_ENV_VAR}. Claiming "missing" here would be FALSE in
 * exactly that case. Naming the REQUIREMENT rather than guessing at its
 * satisfaction keeps this honest while still moving the fact "apply needs
 * this to REGISTER a runner" earlier than `apply` itself shows it — see
 * `apply-routing.ts::checkRunnerTokenPreflight`'s doc for the actual
 * enforcement (which DOES know the resolved value, and DOES warn).
 *
 * **Conditional, not unconditional (corrected groundnuty/macf#1195).**
 * Through #1195, `apply`'s missing-token gate refused every repo outright
 * regardless of live runner state, so this note was true unconditionally —
 * appended in BOTH {@link runnerClassReason} branches. That premise no
 * longer holds: a runner ALREADY confirmed registered at plan time needs no
 * token at all (`apply-routing.ts::publishTrustedActorsGated`'s no-token
 * branch consults the SAME live check this function's `runnerRegistered`
 * input comes from, and proceeds on `'present'`). Appending this note to
 * the `'present'` branch would now assert a requirement that does not
 * apply — see `runnerClassReason`'s doc for where it is (and is not)
 * appended.
 */
const RUNNER_TOKEN_PLAN_NOTE =
  ` \`macf bootstrap apply\` additionally requires ${RUNNER_TOKEN_FLAG} (or ${RUNNER_TOKEN_ENV_VAR}) before it will ` +
  'attempt this write at all.';

/**
 * groundnuty/macf#993 — the operator's ruling, stated plainly BEFORE the
 * operator approves the plan (not just discovered at `apply` time): "the
 * failure of our runner should be loud, and the lack of it being
 * provisioned at this stage should block everything else." A declared
 * `routing.runner` is a REQUIREMENT, not a preference — `apply` refuses to
 * fall back to a metered hosted runner. UNCONDITIONAL (appended in BOTH
 * `runnerClassReason` branches — unlike {@link RUNNER_TOKEN_PLAN_NOTE},
 * which is now conditional post-groundnuty/macf#1195): even when a runner
 * IS confirmed registered at PLAN time, `apply` can still fail on it later
 * (the runner going offline between plan and apply) — so THIS requirement
 * is named regardless of the currently-observed registration state, not
 * only in the "absent" branch. Additive — appended alongside the existing
 * sentences above it, never a rewrite of them (see
 * `apply-routing.ts::publishTrustedActorsGated`'s doc for the actual
 * enforcement this note describes).
 */
const RUNNER_REQUIRED_FAILURE_PLAN_NOTE =
  ' A declared routing.runner is REQUIRED: if no usable runner is confirmed when `apply` runs, `apply` FAILS ' +
  '(non-zero exit) rather than silently falling back to a metered hosted runner.';

/**
 * The runner-CLASS half of {@link routingItem}'s reason (macf#922 — the plan
 * must name the billing consequence BEFORE the operator approves apply: a
 * private repo billed github-hosted draws down the account's Actions-minutes
 * quota; self-hosted is free). ALWAYS stated from a LIVE register-before-
 * route check (`runnerRegistered`, macf#924-corrected to include org-scope —
 * see `observer.ts::checkRunnerUsableByRepo`), never from the manifest's
 * aspirational `runs_on: self-hosted` declaration alone — a declaration with
 * no registered-and-usable runner still routes github-hosted today,
 * regardless of what `MACF_TRUSTED_ACTORS` ends up containing.
 *
 * `handover` (macf#924) is appended verbatim when set — the org-admin
 * action the operator needs BEFORE approving apply, surfaced at plan time
 * rather than discovered only after apply silently skips the write. `detail`
 * (macf#934 — a runner WAS found but fails the capability check: offline,
 * missing a required label, or a permission-denied read) is likewise
 * appended verbatim when set. macf#993's unconditional suffix
 * ({@link RUNNER_REQUIRED_FAILURE_PLAN_NOTE} — plan states plainly, before
 * approval, that `apply` will FAIL without a confirmed runner) appears in
 * BOTH branches. macf#932's token-requirement suffix
 * ({@link RUNNER_TOKEN_PLAN_NOTE}) appears ONLY in the non-present branch as
 * of groundnuty/macf#1195 — a runner already confirmed present needs no
 * token, so stating the requirement there would overclaim (see that
 * constant's own doc). The original wording for the no-suffix branches is
 * preserved UNCHANGED (only the suffixes are new/conditional) so this stays
 * a strict extension — same "never rewrite" discipline as `handover`'s own
 * addition.
 */
function runnerClassReason(
  runnerRegistered: Presence | undefined,
  representativeRepo: string | undefined,
  handover: string | undefined,
  detail: string | undefined,
): string {
  const repoLabel = representativeRepo ?? '(no agent repos declared)';
  if (runnerRegistered === 'present') {
    return `Runner class: self-hosted (a runner is confirmed registered on "${repoLabel}").${RUNNER_REQUIRED_FAILURE_PLAN_NOTE}`;
  }
  const cause =
    runnerRegistered === 'absent'
      ? `no self-hosted runner is confirmed registered on "${repoLabel}"`
      : `runner registration on "${repoLabel}" could not be confirmed (auth / network / insufficient scope)`;
  const detailSuffix = detail !== undefined ? ` ${detail}` : '';
  const handoverSuffix = handover !== undefined ? ` ${handover}` : '';
  return (
    `Runner class: github-hosted (billed on private repos) — ${cause} yet; MACF_TRUSTED_ACTORS will NOT be ` +
    `written by apply until one is (register-before-route).${detailSuffix}${handoverSuffix}${RUNNER_TOKEN_PLAN_NOTE}` +
    RUNNER_REQUIRED_FAILURE_PLAN_NOTE
  );
}

/**
 * The `MACF_TRUSTED_ACTORS` plan item (macf#922 — was `MACF_ROUTING_RUNS_ON`,
 * a variable the v3 router never reads; see `apply-routing.ts`'s doc). `v0`
 * supports exactly one opt-in `runs_on` value, `"self-hosted"` — any OTHER
 * declared value (including the router's own fail-safe default) needs no
 * variable written at all, so it's a `noop` with an explanatory reason, not
 * a `create`.
 */
function routingItem(
  fleetName: string,
  desiredRunsOn: string,
  desiredTrustedActors: string,
  observedTrustedActors: string | undefined,
  runnerRegistered: Presence | undefined,
  representativeRepo: string | undefined,
  runnerHandover: string | undefined,
  runnerDetail: string | undefined,
): PlanItem {
  const target = `routing:${fleetName}:runner`;

  if (desiredRunsOn !== 'self-hosted') {
    return {
      kind: 'routing',
      target,
      verb: 'noop',
      reason:
        `Runner class: github-hosted — declared runs_on "${desiredRunsOn}" is not "self-hosted", so the v3 ` +
        "router's fail-safe default applies (no MACF_TRUSTED_ACTORS write needed); nothing to reconcile.",
      confirm_required: false,
    };
  }

  const classSuffix = runnerClassReason(runnerRegistered, representativeRepo, runnerHandover, runnerDetail);

  if (observedTrustedActors === undefined) {
    return {
      kind: 'routing',
      target,
      verb: 'create',
      reason: `MACF_TRUSTED_ACTORS not observable at plan time — treated as a create-candidate. ${classSuffix}`,
      confirm_required: false,
    };
  }
  if (observedTrustedActors === desiredTrustedActors) {
    return {
      kind: 'routing',
      target,
      verb: 'noop',
      reason: `MACF_TRUSTED_ACTORS already matches the fleet's current agents. ${classSuffix}`,
      confirm_required: false,
    };
  }
  return {
    kind: 'routing',
    target,
    verb: 'update',
    reason:
      `MACF_TRUSTED_ACTORS observed "${observedTrustedActors}" but the fleet's current agents derive ` +
      `"${desiredTrustedActors}" — likely drift from an agent added/removed since the var was last written. ${classSuffix}`,
    confirm_required: true,
  };
}

/**
 * DR-043 Amendment P3 row 4 (groundnuty/macf#1229) — `routing.runner` is
 * UNDECLARED, but the variable {@link routingItem} would have written is
 * STILL observed present. Gated on `fleet.lock`: only when the
 * REPRESENTATIVE agent's role (the repo the variable lives on — same
 * derivation `computePlan`'s own call site for `routingItem` already uses)
 * is recorded in `fleet.lock.agents` — i.e. this tool provisioned that
 * identity — is the variable "ours" to call a negative diff on; otherwise
 * this stays silent (§D3 no-prune — an unrecorded fleet has no history this
 * tool can act against, same discriminator the `extraRoles` loop above
 * uses).
 *
 * `observedTrustedActors === undefined` produces NO item at all (Amendment
 * A's honest-unknown floor: unobservable is not the same as confirmed
 * present, so no delete claim is made) — this is what keeps a `plan` run
 * against a fleet that genuinely never declared routing quiet, and matches
 * `routingItem`'s OWN sibling honest-unknown handling for the
 * declared-but-unobservable case.
 *
 * **Not wired to any live read as of this change** — `githubRegistryObserver`
 * only reads `MACF_TRUSTED_ACTORS` when `routing.runner` IS declared (see
 * that function's own gate), so `observed.routingTrustedActors` is always
 * `undefined` here on a REAL `plan` run today. This function is pure and
 * fully exercised by `computePlan`'s own tests; observing the leftover
 * value live is a separate, follow-up wiring task — same "computePlan is
 * pure, live wiring is a separate caller-side concern" shape row 3's
 * `installScopeCoverage` parameter already established (see this module's
 * own doc on that parameter).
 */
function routingDroppedItem(
  fleetName: string,
  representativeRepo: string | undefined,
  representativeRole: string | undefined,
  observedTrustedActors: string | undefined,
  lock: FleetLock | null,
): PlanItem | undefined {
  if (observedTrustedActors === undefined) return undefined;
  const ownedByThisTool = representativeRole !== undefined && (lock?.agents.some((a) => a.role === representativeRole) ?? false);
  if (!ownedByThisTool) return undefined;
  return {
    kind: 'routing',
    target: `routing:${fleetName}:runner`,
    verb: 'delete',
    reason:
      `MACF_TRUSTED_ACTORS is observed present on "${representativeRepo ?? '(no agent repos declared)'}" but ` +
      'routing.runner is no longer declared — this tool wrote it (recorded in fleet.lock for ' +
      `"${representativeRole ?? '?'}") and it is a cheap-to-revive variable (a rewrite), so this plan calls for ` +
      'removing it.',
    confirm_required: true,
  };
}

/**
 * DR-043 Amendment I / groundnuty/macf#942 — the runner-provisioning
 * contract's `warm` argument, declared per-fleet (DR-009 §7.4's warm-by-
 * default, hibernate-the-dormant policy). ONE item per fleet, not per agent
 * — `warm` is a runner-class-wide posture, same "one item" shape
 * {@link routingItem} already uses for the runner's other fields — emitted
 * only when `routing.runner` is DECLARED (same "nothing was promised" gate
 * `computePlan` applies to `routingItem` itself; see the call site).
 *
 * Always `verb: 'write-always'` (groundnuty/macf#926 — was `'create'`),
 * unlike `routingItem`'s three-way compare: there is no live-observable "is
 * this runner already at the declared warm posture" signal to compare
 * against — the runner-provisioning contract that would set it, and the
 * only thing that could read it back, does not exist yet (groundnuty/macf#943).
 * `'create'` implicitly claims "checked, and it's missing"; this function
 * takes no observed-state input, so that claim can never be true or false —
 * only ever asserted. `'write-always'` states the honest alternative:
 * "declared, not comparable against reality." `apply` has NO code path for
 * this kind regardless of verb (see {@link planItemApplyCoverage}'s
 * `'runner_warm'` case + `APPLY_UNIMPLEMENTED_REASONS.runnerWarm`) — this
 * item exists so the declared value is VISIBLE in the plan and loudly
 * admitted as not-yet-enforced (groundnuty/macf#861's coverage machinery),
 * rather than silently accepted-and-ignored — exactly the #957/#958 defect
 * this issue's thread named.
 */
function runnerWarmItem(fleetName: string, desiredWarm: number): PlanItem {
  const dormantNote = desiredWarm === 0 ? ' — this fleet is declared dormant' : '';
  return {
    kind: 'runner_warm',
    target: `routing:${fleetName}:runner:warm`,
    verb: 'write-always',
    // groundnuty/macf#943 — "not yet observable" still holds (there is no
    // live read of whether a runner IS warm/dormant to compare against, so
    // this stays write-always, never create/update); "not yet enforced" does
    // NOT — apply now sends this value on every provisioning call.
    reason: `warm: ${String(desiredWarm)} declared${dormantNote} — not yet observable (no live warm/dormant signal to compare against); apply sends it on every runner-provisioning-contract call.`,
    confirm_required: false,
  };
}

/**
 * groundnuty/macf#1211 — surfaces the runner-provisioning contract's
 * endpoint resolution BEFORE the operator approves `apply`, naming which of
 * flag/env/scope/manifest supplied it (or that none did). One item per
 * fleet, same "fleet-level, not per-agent" shape {@link runnerWarmItem}
 * already uses — but a NARROWER gate than that function's own: only emitted
 * when `runs_on === 'self-hosted'` (the SAME condition
 * `apply-fleet.ts` uses to decide whether to attempt the provisioning call
 * at all — see the call site below), not merely `routing.runner` declared.
 * A `runs_on: ubuntu-latest` fleet has nothing to resolve; reporting on it
 * would name a fact apply never even looks at.
 *
 * **WARN, never REFUSE, when nothing resolves — the operator's own ruling on
 * this issue's thread.** A declared `routing.runner` with an ALREADY
 * confirmed-registered runner (groundnuty/macf#1195) needs no platform call
 * at all — the register-before-route gate (`routingItem` above) is
 * satisfied independently of this contract. A plan-time refusal here would
 * therefore punish a fleet whose runner came from anywhere else, contradicting
 * the very design #1195 established. `verb: 'write-always'` mirrors
 * {@link runnerWarmItem}'s own reasoning: there is no live-observable "is the
 * endpoint correctly pointed" signal to compare against, only whether a
 * value resolved this run.
 *
 * `resolution` defaults to `{ value: undefined, source: 'none' }` at the
 * call site when `observed.runnerPlatformEndpoint` is `undefined` — the
 * SAME state a live read that found nothing would also produce, so a plan
 * run against a fleet the observer never checked (every pre-#1211
 * `ObservedState` test fixture) reads as honest "not configured," never a
 * false "resolved."
 */
function runnerPlatformItem(fleetName: string, resolution: RunnerPlatformEndpointResolution): PlanItem {
  const skipNote =
    resolution.source === 'none'
      ? ' Runner provisioning will be SKIPPED (non-fatal) when apply runs — no runner will be created via the ' +
        'provisioning contract this way; a runner already registered by other means still satisfies routing.'
      : '';
  return {
    kind: 'runner_platform',
    target: `routing:${fleetName}:runner:platform_endpoint`,
    verb: 'write-always',
    reason: `Runner platform endpoint: ${describeRunnerPlatformEndpointResolution(resolution)}.${skipNote}`,
    confirm_required: false,
  };
}

/**
 * DR-043 Amendment G (groundnuty/macf#867) — surfaces an ARCHIVED control
 * repo as a DELIBERATE fleet state, not as drift. Fires ONLY when the repo
 * is observed present AND archived — the ordinary (non-archived, absent, or
 * unconfirmed) cases emit nothing, same "silent unless there's something to
 * say" convention `computeSkippedSections` already uses. `verb: 'update'` +
 * `confirm_required: true` is the closest existing vocabulary for "not
 * noop, needs the operator's plan-approve-once yes before apply acts" — but
 * the REASON text deliberately does NOT use "observed X but manifest
 * declares Y" phrasing (the pattern `routingItem` uses for genuine drift):
 * this isn't a mismatched VALUE, it's a state the operator set on purpose
 * via a prior `macf fleet archive`, and the wording says so explicitly so
 * it never reads as an error.
 */
export const CONTROL_REPO_ARCHIVED_REASON =
  'control repo is ARCHIVED — a DELIBERATE, reversible fleet state set by a prior ' +
  '`macf fleet archive`, NOT drift. Approving this plan authorizes `apply` to un-archive it (one API PATCH, ' +
  'zero browser consent clicks) and resume normal reconcile.';

function controlRepoItem(presence: Presence, archived: boolean | undefined): PlanItem | undefined {
  if (presence !== 'present' || archived !== true) return undefined;
  return {
    kind: 'control_repo',
    target: 'control_repo:archived',
    verb: 'update',
    reason: CONTROL_REPO_ARCHIVED_REASON,
    confirm_required: true,
  };
}

/**
 * DR-043 Amendment G correction (groundnuty/macf#1034) — the per-agent
 * sibling of {@link controlRepoItem}, same shape: fires ONLY when THIS
 * agent's repo is observed present AND archived, so the operator's ONE
 * plan-approve-once "yes" (`realConfirmPlan`'s "N update(s) requiring
 * confirmation" count, `bootstrap-apply.ts`) actually SHOWS every repo
 * `apply` is about to revive — not just the control repo. Amendment G's
 * revival clause named only the control repo; the fix corrects the clause
 * AND gives the plan-preview the same "Inventory shown + confirmed before
 * any mutation" rail the control repo already had (Amendment G's "Shared
 * rails" section) rather than reviving agent repos the operator never saw
 * counted.
 */
export const AGENT_REPO_ARCHIVED_REASON = (repo: string): string =>
  `repo "${repo}" is ARCHIVED — a DELIBERATE, reversible fleet state set by a prior ` +
  '`macf fleet archive`, NOT drift. Approving this plan authorizes `apply` to un-archive it (one API PATCH, ' +
  'zero browser consent clicks) and resume normal reconcile.';

function agentRepoArchivedItem(agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem | undefined {
  if (obs?.repo !== 'present' || obs.archived !== true) return undefined;
  return {
    kind: 'agent_repo_archived',
    target: `agent:${agent.role}:repo:${agent.repo}:archived`,
    verb: 'update',
    reason: AGENT_REPO_ARCHIVED_REASON(agent.repo),
    confirm_required: true,
  };
}

/**
 * DR-043 §D5 recipient-set reconciliation (groundnuty/macf#957) — one
 * fleet-level item comparing the vault's OBSERVED age-header recipient
 * STANZA COUNT against `transport.age_recipients.length`. Only called (see
 * `computePlan`) when `observed.vaultRecipients !== undefined` — a
 * vault-free plan run (the common default; no `--vault`/`--identity-key`
 * given) emits NO item at all for this kind, matching
 * `formatVaultAgentSuffix`'s own "undefined is a full no-op, not a degraded
 * unknown" convention, rather than `presenceVerb`'s "unknown degrades to a
 * LOW-CONFIDENCE create" convention — recipient drift can ONLY ever be
 * assessed via the vault-aware path, so "not given this run" is a much
 * weaker signal than "tried and failed," and a permanent "not observed"
 * noop line on every ordinary plan run would be pure noise.
 *
 * **Never claims a definite match it cannot establish (Amendment A4).** A
 * stanza-count MATCH is reported as a "count-only match" — `age`'s header
 * never reveals recipient IDENTITY without decrypting per-recipient-key (see
 * `vault-read.ts`'s module doc), so this is never worded as a confirmed
 * cryptographic match.
 *
 * **Never auto-shrinks (§D3 Design invariant 4 — "no delete verb," applied
 * at the vault layer).** A HIGHER stanza count than declared could mean a
 * recipient was intentionally dropped from the manifest — re-encrypting to
 * the smaller set would REVOKE that recipient's decrypt access, which
 * `apply` refuses to do automatically regardless of `--identity-key` (see
 * `apply-fleet.ts::reconcileVaultRecipients`). The reason text for that
 * direction says so explicitly, distinct from the (safe, auto-applied)
 * fewer-than-declared direction.
 */
function vaultRecipientsItem(desiredCount: number, obs: VaultRecipientsObservation): PlanItem {
  const target = 'vault:recipients';
  if (obs.status === 'no-vault') {
    return {
      kind: 'vault_recipients',
      target,
      verb: 'noop',
      reason: 'no vault.age exists yet — nothing to reconcile; the first successful apply encrypts fresh to the currently declared recipient(s).',
      confirm_required: false,
    };
  }
  if (obs.status === 'unknown') {
    return {
      kind: 'vault_recipients',
      target,
      verb: 'noop',
      reason: `vault recipient count could not be determined — ${obs.reason} — cannot confirm it matches the ${String(desiredCount)} declared recipient(s); apply re-checks independently at run time`,
      confirm_required: false,
    };
  }
  if (obs.stanzaCount === desiredCount) {
    return {
      kind: 'vault_recipients',
      target,
      verb: 'noop',
      reason:
        `vault is encrypted to ${String(obs.stanzaCount)} recipient(s), matching the ${String(desiredCount)} declared — ` +
        "count-only match (age's header never reveals recipient IDENTITY without decrypting with each recipient's own key)",
      confirm_required: false,
    };
  }
  if (obs.stanzaCount < desiredCount) {
    return {
      kind: 'vault_recipients',
      target,
      verb: 'update',
      reason:
        `vault is encrypted to ${String(obs.stanzaCount)} recipient(s), DEFINITELY fewer than the ${String(desiredCount)} ` +
        'declared in transport.age_recipients — run "macf bootstrap apply --vault <path> --identity-key <path>" to ' +
        're-encrypt to the full declared set (decrypt-then-whole-rewrite).',
      confirm_required: true,
    };
  }
  return {
    kind: 'vault_recipients',
    target,
    verb: 'update',
    reason:
      `vault is encrypted to ${String(obs.stanzaCount)} recipient(s), MORE than the ${String(desiredCount)} declared in ` +
      'transport.age_recipients — apply does NOT auto-shrink the recipient set (re-encrypting to fewer keys would ' +
      'REVOKE decrypt access for whichever recipient was dropped); reconcile transport.age_recipients or the vault manually.',
    confirm_required: true,
  };
}

/**
 * DR-043 §D6 GitOps version steering — one agent's DEPLOYED macf CLI version
 * vs the fleet manifest's declared `versions.macf`. Same inline three-way
 * shape as {@link routingItem} above (a manifest-declared string compared
 * against a maybe-absent observed string); kept as its own function rather
 * than sharing a helper with `routingItem` so each keeps its own
 * kind-specific wording without forcing an abstraction across two call
 * sites that don't otherwise need one.
 *
 * Verb mapping (Amendment A's honest-unknown floor — never conflate
 * "couldn't observe" with "matches" or "differs"):
 *   - `obs.deployedVersion` undefined → `create`, LOW-CONFIDENCE (same
 *     degrade-to-create-candidate idiom every other unobservable resource in
 *     this file uses) — explicitly NOT `noop` and NOT `update`.
 *   - equals `desired` → `noop`.
 *   - differs from `desired` → `update`, `confirm_required: true` (§D3).
 *     `apply` DOES action this verb as of macf#1045 (DR-043 Amendment L —
 *     `planItemApplyCoverage`'s `'version'` case is `'implemented'`) by
 *     calling the `macf fleet upgrade` roll machinery during the run this
 *     plan is approving — the reason text still NAMES that underlying
 *     mechanism (never claims apply won't roll fleets; that was true only
 *     pre-Amendment-L) so an operator reading the plan sees what's about to
 *     restart the agent, per Amendment L2's "make the widening visible in
 *     the plan the operator approves" requirement.
 */
function macfVersionItem(agent: FleetAgent, desired: string, obs: ObservedAgentState | undefined): PlanItem {
  const target = `agent:${agent.role}:version:macf`;
  const observed = obs?.deployedVersion;
  if (observed === undefined) {
    return {
      kind: 'version',
      target,
      verb: 'create',
      reason:
        `deployed macf version for "${agent.role}" ${UNKNOWN_REASONS.deployedVersion} — ` +
        'not drift, not a match — LOW CONFIDENCE',
      confirm_required: false,
    };
  }
  if (observed === desired) {
    return {
      kind: 'version',
      target,
      verb: 'noop',
      reason: `deployed macf version already "${desired}"`,
      confirm_required: false,
    };
  }
  return {
    kind: 'version',
    target,
    verb: 'update',
    reason:
      `deployed macf version observed "${observed}" but manifest declares "${desired}" — ` +
      'apply reconciles this by calling the "macf fleet upgrade" roll during this run ' +
      '(gated on a green post-restart health check) — this restarts the agent',
    confirm_required: true,
  };
}

/**
 * DR-043 §D6 GitOps version steering — the OTHER `versions:` field
 * (`versions.actions`): one caller repo's committed macf-actions router pin
 * (`.github/workflows/agent-router.yml`'s `uses: groundnuty/macf-actions/
 * ...@<pin>` line) vs the manifest's declared value. Per-REPO, not
 * per-fleet — "EVERY agent repo is a routing caller" per
 * `observer.ts::githubRegistryObserver`'s doc, and the DR two-place-rule
 * precedent (macf#806 / macf#839 review [BLOCKING] 3) is that a single
 * "representative" repo read hides real per-repo drift, same reasoning
 * `caRepoItem` already applies to the CA var.
 *
 * **Taking `repo: string` directly (not `agent: FleetAgent`), unlike
 * `macfVersionItem`** — groundnuty/macf#1072 extends this item's target set
 * from "every agent repo" to "every ROUTER-CARRYING repo"
 * (`fleet-manifest.ts::routerCarryingRepos`), which includes the control
 * repo — a repo with no corresponding `FleetAgent`/role. `agent.repo` was
 * the only field this function ever read from its `FleetAgent` parameter,
 * so callers now pass the repo string directly (agent callers: `agent.repo`;
 * the control-repo caller: the derived control-repo full name).
 *
 * **The remedy NAMED in the `update`/`create` reason changed under #1072**
 * (was: `macf repo-init --actions-version <pin> --force`, since `apply`
 * never rewrote `agent-router.yml`). `apply` now DOES reconcile this field
 * (`apply-fleet.ts`'s `resolveActionsPinReconcile` call sites, DR-043
 * Amendment L extended) — the reason text names that instead, mirroring
 * `macfVersionItem`'s own "apply reconciles this" phrasing. The old
 * operator-remedy command still WORKS (unchanged) as a manual escape hatch,
 * but is no longer the primary path this reason recommends.
 */
function actionsVersionItem(repo: string, desired: string, observed: string | undefined): PlanItem {
  const target = `repo:${repo}:version:actions`;
  if (observed === undefined) {
    return {
      kind: 'actions_pin',
      target,
      verb: 'create',
      reason:
        `macf-actions router pin on "${repo}" ${UNKNOWN_REASONS.actionsPin} — ` +
        'not drift, not a match — LOW CONFIDENCE',
      confirm_required: false,
    };
  }
  if (observed === desired) {
    return {
      kind: 'actions_pin',
      target,
      verb: 'noop',
      reason: `macf-actions router pin on "${repo}" already "${desired}"`,
      confirm_required: false,
    };
  }
  return {
    kind: 'actions_pin',
    target,
    verb: 'update',
    reason:
      `macf-actions router pin on "${repo}" observed "${observed}" but manifest declares "${desired}" — ` +
      'apply reconciles this by rewriting the committed agent-router.yml during this run — manual escape hatch: ' +
      `"macf repo-init --repo ${repo} --actions-version ${desired} --force"`,
    confirm_required: true,
  };
}

/**
 * The pure §D3 three-verb reconcile. Deterministic ordering: the
 * control-repo-archived item FIRST when applicable (DR-043 Amendment G —
 * mirrors `apply-fleet.ts`'s own "control repo is step 0, before any
 * per-agent processing" ordering), then the three fleet-level identities —
 * `runner_ops` (conditional on `routing.runner.runs_on: self-hosted`,
 * macf#943/#1083) then `router_app` then `ts_oauth` (both UNCONDITIONAL,
 * macf#1105 / macf#1109) — then per-agent items (app, repo, an
 * agent-repo-archived item right after `repo`
 * when applicable — macf#1034, the per-agent sibling of the
 * control-repo-archived item above — install, secret_fingerprint) in
 * manifest `agents[]` order, then the CA items
 * (registry, then one per agent repo in manifest order — a MACF fleet
 * always needs a CA, so these are UNCONDITIONAL as of macf#839 review nit 5;
 * there is no `trust:` field to gate them on — it was removed, having never
 * been consulted, groundnuty/macf#1201), then the routing item (only when
 * `routing.runner` is declared), then the §D6 version-steering items (only
 * when `versions:` is declared — one `version` + one `actions_pin` item per
 * agent, in manifest order), then report-extra items for any observed agent
 * NOT in the manifest, sorted by role for determinism.
 *
 * NEVER emits a delete/prune verb (§D3 "play it safe" — Design invariant 4).
 */
/**
 * groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — the optional
 * 3rd parameter carrying ALREADY-COMPUTED `InstallScopeCoverageEntry` data
 * (`install-scope-coverage.ts::computeInstallScopeCoverage`), so
 * `computePlan` can fold row 3 (reused-resource `update`) in without doing
 * any I/O itself. Defaults to `[]` — every pre-existing call site
 * (`commands/bootstrap-apply.ts`'s internal plan preview, and every test in
 * this package) keeps compiling and behaving byte-identically; `[]` produces
 * zero `'install_scope'` items, same as before this parameter existed.
 * `commands/bootstrap.ts` is the ONLY caller that ever passes a non-empty
 * array (only when `--vault`/`--identity-key` are BOTH given — the same
 * gate `computeInstallScopeCoverage` itself already applies). See
 * {@link installScopeCoverageItem}'s own doc for the verb mapping.
 */
export function computePlan(
  manifest: FleetManifest,
  observed: ObservedState,
  installScopeCoverage: readonly InstallScopeCoverageEntry[] = [],
): FleetPlan {
  const fleetName = manifest.metadata.name;
  const seg = toVariableSegment(fleetName);
  const items: PlanItem[] = [];

  const controlRepo = controlRepoItem(observed.controlRepoPresence, observed.controlRepoArchived);
  if (controlRepo !== undefined) items.push(controlRepo);

  // groundnuty/macf#943 — fleet-level, ordered right after the control-repo
  // item (both are "before any per-agent processing" fleet-scoped facts) and
  // before the per-agent app/repo/install items so the operator sees it near
  // the top of the plan, not buried after every agent. groundnuty/macf#1083
  // — `runnerOpsItem` returns `undefined` (no item, no click) for a
  // hosted-runner fleet with no prior lock entry; see that function's doc.
  const runnerOpsHasLockEntry = observed.lock?.agents.some((a) => a.role === RUNNER_OPS_ROLE) ?? false;
  const runnerOps = runnerOpsItem(fleetName, runnerOpsHasLockEntry, runnerOpsNeeded(manifest));
  if (runnerOps !== undefined) items.push(runnerOps);

  // groundnuty/macf#1105 — fleet-level, ordered right after `runnerOps`
  // (both are "before any per-agent processing" fleet-level identities) —
  // UNCONDITIONAL, unlike `runnerOps` above: `apply-fleet.ts` reaches this
  // App's ceremony for every fleet (see `routerAppItem`'s doc). `owner.account`
  // (never the operator's own account) is what the 'shared' scope keys on,
  // per macf#1088 — see `deriveRouterAppHandle`'s doc.
  const routerAppScope: RouterAppScope = manifest.transport.router_app_scope === 'per-fleet' ? 'per-fleet' : 'shared';
  const routerAppHasLockEntry = observed.lock?.agents.some((a) => a.role === ROUTER_APP_ROLE) ?? false;
  items.push(routerAppItem(fleetName, manifest.owner.account, routerAppScope, routerAppHasLockEntry, observed.vaultRouterApp));

  // groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — row 3,
  // ordered right after the two fleet-level App-existence items
  // (`runner_ops`/`router_app`) it is the scope-coverage FACET of. Zero
  // entries on the common vault-free `plan` run (the caller's default) —
  // see `installScopeCoverageItem`'s own doc for the verb mapping,
  // including why a `status: 'unknown'` entry emits NO item.
  for (const entry of installScopeCoverage) {
    const coverageItem = installScopeCoverageItem(entry);
    if (coverageItem !== undefined) items.push(coverageItem);
  }

  // groundnuty/macf#1109 — fleet-level, ordered right after `router_app`
  // (both are the two routing secrets `apply-fleet.ts` resolves independently
  // of the per-agent loop) — UNCONDITIONAL, unlike `runnerOps`: `apply`
  // reads this fleet's vault for TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET on every
  // run regardless of `transport.tailscale_oauth_required` (see
  // `tsOauthItem`'s doc).
  items.push(tsOauthItem(fleetName, manifest.transport.tailscale_oauth_required, observed.vaultTsOauth));

  // groundnuty/macf#1162 — the scope-credential provenance notice, sourced
  // from the MANIFEST declaration UNION the LOCK marker (never lock alone
  // — see `FleetPlan.scopeCredentials`'s doc for why: a fleet that has
  // declared `transport.router_app_origin_fleet` but hasn't `apply`'d yet,
  // or applied without `--vault`, must still see the notice). Keyed by
  // role (today only ever `router`) so a future non-router scope
  // credential reuses this same union without a second copy of it.
  const scopeCredentialOrigins = new Map<string, string | undefined>();
  for (const marker of observed.lock?.scope_credentials ?? []) {
    scopeCredentialOrigins.set(marker.role, marker.origin_fleet);
  }
  if (routerAppScope !== 'per-fleet' && manifest.transport.router_app_origin_fleet !== undefined) {
    // The manifest's declared origin is the freshest operator statement —
    // wins over whatever a PAST apply run happened to record in the lock
    // (e.g. a fleet.yaml correction after the origin was misnamed). A
    // `per-fleet`-scope fleet never gets a manifest-sourced notice here —
    // that scope genuinely mints its own dedicated App, so a stray
    // `router_app_origin_fleet` declaration on it would be a manifest
    // inconsistency this function does not amplify into a false notice.
    scopeCredentialOrigins.set(ROUTER_APP_ROLE, manifest.transport.router_app_origin_fleet);
  }
  const scopeCredentials: ScopeCredentialNotice[] = [...scopeCredentialOrigins.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, originFleet]) => scopeCredentialNotice(role, originFleet));

  for (const agent of manifest.agents) {
    const obs = observed.agents[agent.role];
    items.push(appItem(fleetName, agent, obs));
    items.push(repoItem(agent, obs));
    // DR-043 Amendment G correction (macf#1034) — right after `repoItem`
    // (both describe `agent.repo`); fires only when archived, same "silent
    // unless there's something to say" convention `controlRepoItem` uses.
    const agentRepoArchived = agentRepoArchivedItem(agent, obs);
    if (agentRepoArchived !== undefined) items.push(agentRepoArchived);
    items.push(installItem(fleetName, agent, obs));
    items.push(secretFingerprintItem(agent, obs));
    items.push(labelsItem(agent));
  }

  items.push(caRegistryItem(seg, observed.caRegistry, observed.vaultCa));
  for (const agent of manifest.agents) {
    items.push(caRepoItem(seg, agent.repo, observed.caRepos[agent.repo] ?? 'unknown'));
  }
  for (const agent of manifest.agents) {
    items.push(routingClientItem(agent.repo, observed.routingClientRepos?.[agent.repo] ?? 'unknown'));
  }
  // DR-043 §D5 recipient-set reconciliation (macf#957) — only when this run
  // actually had vault access (see `vaultRecipientsItem`'s doc for why a
  // vault-free run emits no item at all here, rather than a permanent
  // "not observed" noop).
  if (observed.vaultRecipients !== undefined) {
    items.push(vaultRecipientsItem(manifest.transport.age_recipients.length, observed.vaultRecipients));
  }

  if (manifest.routing?.runner) {
    const desiredTrustedActors = buildTrustedActorsValue(fleetName, manifest.agents);
    // Same representative-repo derivation `observer.ts::githubRegistryObserver`
    // uses for its live reads (macf#857) — recomputed here (not threaded
    // through `ObservedState`) since `computePlan` already has `manifest`.
    const representativeRepo = manifest.agents[0]?.repo;
    items.push(
      routingItem(
        fleetName,
        manifest.routing.runner.runs_on,
        desiredTrustedActors,
        observed.routingTrustedActors,
        observed.routingRunnerRegistered,
        representativeRepo,
        observed.routingRunnerHandover,
        observed.routingRunnerDetail,
      ),
    );
    items.push(runnerWarmItem(fleetName, manifest.routing.runner.warm));
    // groundnuty/macf#1211 — narrower gate than the two items above:
    // `runs_on === 'self-hosted'` (not merely `routing.runner` declared),
    // matching `apply-fleet.ts`'s own condition for attempting the
    // provisioning call. `observed.runnerPlatformEndpoint` defaults to
    // `{ value: undefined, source: 'none' }` when the observer never
    // resolved it this run (see that field's own doc) — honest "not
    // configured," never a false "resolved."
    if (manifest.routing.runner.runs_on === 'self-hosted') {
      items.push(runnerPlatformItem(fleetName, observed.runnerPlatformEndpoint ?? { value: undefined, source: 'none' }));
    }
  } else {
    // groundnuty/macf#1229 / DR-043 Amendment P3 row 4 — the concrete
    // motivating case: `routing.runner` was DROPPED from the manifest.
    // `routingDroppedItem` returns `undefined` (no item) unless BOTH the
    // variable is observed present AND the representative role is recorded
    // in `fleet.lock` — see that function's own doc for why (and why this
    // never fires on a real `plan` run yet).
    const representativeRepo = manifest.agents[0]?.repo;
    const representativeRole = manifest.agents[0]?.role;
    const droppedRouting = routingDroppedItem(fleetName, representativeRepo, representativeRole, observed.routingTrustedActors, observed.lock);
    if (droppedRouting !== undefined) items.push(droppedRouting);
  }

  // DR-043 §D6 — only emitted when `versions:` is DECLARED (an omitted
  // section stays fully silent, same "nothing was promised" gate
  // `routing.runner` uses above). Once declared, `FleetVersionsSchema`
  // (`.strict()`, both `macf` + `actions` required) guarantees both fields
  // are present — there is no partial-declaration case to special-case here.
  if (manifest.versions) {
    const { macf: desiredMacf, actions: desiredActions } = manifest.versions;
    for (const agent of manifest.agents) {
      const obs = observed.agents[agent.role];
      items.push(macfVersionItem(agent, desiredMacf, obs));
      items.push(actionsVersionItem(agent.repo, desiredActions, obs?.actionsPin));
    }
    // groundnuty/macf#1072 — the control repo is ALSO a router-carrying
    // repo (since `#1070`); its pin reconciles the same way an agent
    // repo's does. No `version`(macf) item for it though — the control
    // repo never runs a deployed macf CLI to roll (Amendment L's `macf
    // fleet upgrade` delegation is scoped to AGENT identity, DR-043 §D4);
    // only the router-pin field applies here. Derived from
    // `routerCarryingRepos(manifest)`'s LAST element — that function
    // ALWAYS appends the control repo after every agent repo (see its own
    // doc) — rather than re-deriving the name a second way, so this stays
    // in lockstep with `apply-fleet.ts`'s reconcile enumeration of the
    // SAME function.
    items.push(actionsVersionItem(routerCarryingRepos(manifest).at(-1)!, desiredActions, observed.controlRepoActionsPin));
  }

  // groundnuty/macf#1229 / DR-043 Amendment P3 — row 4 of the reconciler
  // verb matrix, for a role observed but NOT declared. Fleet-level pseudo
  // roles (`runner-ops`/`router`, `RUNNER_OPS_ROLE`/`ROUTER_APP_ROLE`) live
  // in `fleet.lock.agents` BY DESIGN (composeFleetLock records them the
  // same way a real per-manifest-agent identity is recorded — see
  // `runnerOpsItem`/`routerAppItem`'s own lock-membership checks above) but
  // are never real agent roles an operator declares under `agents[]` or that
  // `githubRegistryObserver` would ever populate into `observed.agents`
  // (that map is built ONLY from `manifest.agents`). Excluding them here
  // means a lock that legitimately carries those two roles can never
  // misread as an "orphan agent" — they already have their own dedicated
  // fleet-level plan items.
  const manifestRoles = new Set(manifest.agents.map((a) => a.role));
  const fleetLevelPseudoRoles = new Set<string>([RUNNER_OPS_ROLE, ROUTER_APP_ROLE]);
  const extraRoles = Object.keys(observed.agents)
    .filter((role) => !manifestRoles.has(role) && !fleetLevelPseudoRoles.has(role))
    .sort();
  // The row-4 discriminator, and THE WHOLE SAFETY PROPERTY this row rests
  // on: was THIS TOOL the one that provisioned `role`? `fleet.lock.agents`
  // is exactly that record (composeFleetLock never prunes it — §D3 Design
  // invariant 4). A role ABSENT from the lock might be anything on GitHub
  // with a matching name — never provably ours, so it stays `report-extra`,
  // untouched, exactly as before this change (the pre-existing no-prune
  // behavior is preserved, not relaxed). A role PRESENT in the lock is
  // ours, no longer wanted, and decomposes per resource class (Amendment
  // G's revival-cost axis) instead of one coarse whole-agent notice.
  // groundnuty/macf#1296 — a Map (not the pre-existing `lockRoles` Set)
  // because the repo-orphan branch below now needs the ENTRY, not just
  // membership: `lockEntry.repo` is what makes the URL resolvable for a
  // lock written after this change (`undefined` on any lock written before
  // it — `FleetLockAgentSchema`'s own doc).
  const lockAgentsByRole = new Map((observed.lock?.agents ?? []).map((a) => [a.role, a]));
  for (const role of extraRoles) {
    if (!lockAgentsByRole.has(role)) {
      items.push({
        kind: 'agent',
        target: `agent:${role}`,
        verb: 'report-extra',
        reason: 'observed (fleet.lock / registry) but not declared in fleet.yaml — never deleted (§D3 no-prune)',
        confirm_required: false,
      });
      continue;
    }
    const obs = observed.agents[role];
    // Apps: orphan, ALWAYS (Amendment P3 — 2 clicks AND the key is emitted
    // once, unrecoverable). `obs?.app` may also be `'absent'` (nothing to
    // orphan) or `'unknown'` (honest-unknown floor — Amendment A: the API
    // can confirm present, never prove absent; an unconfirmed presence
    // earns no claim in either direction here).
    if (obs?.app === 'present') {
      const url = orphanResourceUrl('app', fleetName, role, manifest.owner);
      items.push({
        kind: 'app',
        target: `agent:${role}:app`,
        verb: 'orphan',
        reason:
          `GitHub App for "${role}" was provisioned by this tool (recorded in fleet.lock) but "${role}" is no ` +
          'longer declared. NOTHING WAS DELETED — apply never auto-removes it, under any flag (2 clicks to ' +
          'recreate, but the private key is emitted once and unrecoverable). If it should go away, delete it ' +
          `yourself here (Settings → Advanced → "Delete GitHub App"): ${url}`,
        confirm_required: false,
      });
    }
    // Repos: orphan (un-archive is 0 clicks; recreate loses history).
    if (obs?.repo === 'present') {
      // groundnuty/macf#1296 — `lockEntry.repo` is `undefined` for any lock
      // written before this change (the field didn't exist yet); `obs?.repo
      // === 'present'` above is an independent Presence signal (observer.ts)
      // and never implies the repo NAME is known — the two must not be
      // conflated (`FleetLockAgentSchema`'s own doc: undefined is unknown,
      // never a fact derived from something else being true).
      const lockedRepo = lockAgentsByRole.get(role)?.repo;
      const url = orphanResourceUrl('repo', fleetName, role, manifest.owner, lockedRepo);
      const howToFind =
        lockedRepo !== undefined
          ? `If it should go away, archive or delete it yourself on its GitHub settings page: ${url}.`
          : `If it should go away, archive or delete it yourself on its GitHub settings page: ${url} ` +
            `(this tool cannot name that page — fleet.lock predates recording which repo a no-longer-declared ` +
            `role used; search your GitHub ${manifest.owner.type === 'org' ? `organization "${manifest.owner.account}"` : 'account'}'s ` +
            `repo list for one it created for role "${role}").`;
      items.push({
        kind: 'repo',
        target: `agent:${role}:repo`,
        verb: 'orphan',
        reason:
          `The repo for "${role}" was provisioned by this tool (recorded in fleet.lock) but "${role}" is no ` +
          'longer declared. NOTHING WAS DELETED — apply never auto-removes it, under any flag (recreating a ' +
          `repo loses its history; un-archiving is 0 clicks). ${howToFind}`,
        confirm_required: false,
      });
    }
    // Secrets: delete, with the value's source named at plan time (Amendment
    // P3 — cheap to revive: a re-supply, ~0 cost if vault-held). One item
    // per recorded fingerprint, sorted for deterministic ordering.
    for (const name of Object.keys(obs?.fingerprints ?? {}).sort()) {
      items.push({
        kind: 'secret_fingerprint',
        target: `agent:${role}:secret_fingerprint:${name}`,
        verb: 'delete',
        reason:
          `Secret "${name}" for "${role}" was provisioned by this tool (recorded in fleet.lock, fingerprint only ` +
          `— the value itself is never in this lock) but "${role}" is no longer declared — cheap to revive ` +
          '(re-supply; ~0 cost if the value is vault-held), so this plan calls for removing it.',
        confirm_required: true,
      });
    }
  }

  // groundnuty/macf#999 requirement 3 — "plan states it": the SAME pure
  // check `apply` refuses on (see `registry-scope-preflight.ts`'s doc),
  // surfaced here as data rather than a refusal — `plan` is read-only end
  // to end and never exits non-zero for a manifest fact alone (mirrors
  // `skippedSections`/`unimplementedByApply`'s own "state it, don't abort
  // the render" posture).
  const registryScopeFailure = checkRegistryScopePreflight(manifest.owner);
  // groundnuty/macf#1012 requirement 4 — the pure, manifest-only SIBLING of
  // the check above, for `registry.type === 'repo'`: a NOTICE (never a
  // refusal — `type: repo` IS satisfiable), stating that `apply` will
  // verify install coverage live, per App, post-gate-2. See
  // `registry-scope-preflight.ts::checkRegistryRepoScopeNotice`'s doc.
  const registryRepoScopeNotice = checkRegistryRepoScopeNotice(manifest.owner);

  // groundnuty/macf#1128 — already-provisioned-fleet install-scope drift:
  // for each declared agent whose OBSERVED `repository_selection` is
  // populated (a live org-installations read succeeded this run) AND is
  // NOT `'selected'`, report it. An `undefined` observation (org-listing
  // unavailable, personal-account-owned fleet, or the App simply isn't
  // installed on the org yet) produces NO entry — honest-unknown, never a
  // false-clean or false-drift verdict (Amendment A4). Reuses the SAME
  // `validateInstallRepositoryScope` `apply`'s post-gate-2 refusal builds
  // its message from — one wording, never a second copy for the plan-time
  // surface.
  const installScopeDrift: InstallScopeDrift[] = [];
  for (const agent of manifest.agents) {
    const observedSelection = observed.agents[agent.role]?.installRepositorySelection;
    if (observedSelection === undefined) continue;
    const appHandle = deriveAppHandle(fleetName, agent.role);
    const message = validateInstallRepositoryScope(observedSelection, appHandle);
    if (message === undefined) continue;
    installScopeDrift.push({ role: agent.role, appHandle, observed: observedSelection, message });
  }

  return {
    fleet: fleetName,
    items,
    skippedSections: computeSkippedSections(manifest),
    unimplementedByApply: computeUnimplementedByApply(items),
    registryScopeIssues: registryScopeFailure !== undefined ? [registryScopeFailure] : [],
    registryRepoScopeNotices: registryRepoScopeNotice !== undefined ? [registryRepoScopeNotice] : [],
    installScopeDrift,
    scopeCredentials,
  };
}

// --- Formatting (human table + --json) ---

// groundnuty/macf#1220 — `commands/bootstrap.ts` appends a top-level
// `install_scope_coverage` key beside `fleetPlanToJson`'s own output
// (same shape `advertise_host_drift` already used there, unbumped) —
// deliberately NOT bumped: a brand-new name, no existing field's meaning
// changes, no aggregate here for a new condition to silently feed. See
// `status.ts::BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION`'s sibling comment for
// the full rule (groundnuty/macf#1203).
//
// groundnuty/macf#1129 / #1229 / DR-043 Amendment P2 — the `'install_scope'`
// `PlanItemKind` added for row 3 is a NEW VALUE inside the EXISTING
// `items[].kind` string field, never a new top-level key or a changed
// field SHAPE. Also deliberately NOT bumped, for a reason verified against
// this constant's own history: `'router_app'` (#1105), `'ts_oauth'`
// (#1109), and `'runner_platform'` (#1211) all landed as new `PlanItemKind`
// values without a bump, and no production consumer in this package
// switches exhaustively on `items[].kind` (grepped: `PlanItemKind` is
// imported nowhere outside `plan.ts` and its own tests) — a generic
// `kind`/`verb`/`reason` consumer (dashboards, `--json` scripts) handles an
// unrecognized-to-it `kind` string the same way it handles any of the other
// 19. If a future consumer DOES start switching exhaustively on `kind`,
// that consumer's own addition is the one that should introduce a version
// contract for itself — this constant stays keyed to shape changes, not to
// vocabulary growth within an already-open string field.
//
// groundnuty/macf#1229 / DR-043 Amendment P3 — the SAME reasoning applies to
// `'delete'`/`'orphan'`, two NEW VALUES inside the EXISTING `items[].verb`
// string field (never a new key, never a changed field shape). Verified
// against this constant's own precedent immediately above: `'write-always'`
// (macf#926) landed the same way, unbumped. `PlanSummary` gained two new
// FIELDS (`deletes`/`orphans`, same "counted separately" shape `writeAlways`
// already established for `summarizePlan`) — additive keys on an
// already-open `summary` object, the same class of change `install_scope_coverage`'s
// own top-level addition (two paragraphs up) was unbumped for. Unbumped at
// the time — see immediately below for why THIS SAME KEY later did bump.
//
// **groundnuty/macf#1279 bumped this 1 → 2.** Unlike #1220 two paragraphs up
// (adding the brand-new `install_scope_coverage` key — unbumped, per the
// "new key, no existing field's meaning changes" rule) or #1229 immediately
// above (new `verb`/`kind` vocabulary inside an already-open string field —
// also unbumped), #1279 changes that SAME key's OWN PRESENCE CONDITION —
// the shape `FLEET_APPLY_JSON_SCHEMA_VERSION`'s own #1268 comment
// (`bootstrap-apply.ts`) bumped 2 → 3 for, and the identical fix applied to
// `plan`'s call site rather than `apply`'s. Before #1279,
// `install_scope_coverage` was present in `plan --json` output if and only
// if BOTH `--vault` and `--identity-key` were given; any other case
// (including a fleet that genuinely has fleet-level Apps to check)
// collapsed to key-absent, indistinguishable from "nothing to check." A
// `--json` consumer that gated any logic on `'install_scope_coverage' in
// json` as a proxy for "were the vault flags given" would now see that
// proxy break: the key can be present (with honest `'unknown'` entries
// naming the missing flags) on a vault-free `plan` run too, whenever the
// manifest declares a runner-ops or router-App target. Per-entry
// `status`/`message` were already `'unknown'`-capable before this bump (a
// live-probe failure or an unconfirmed-existence repo already produced it)
// — only the KEY'S PRESENCE on a vault-free run is new. `PlanSummary`'s
// `deletes`/`orphans` fields immediately above stay a DIFFERENT, still-
// unbumped case: those are new fields on an already-open object, never a
// presence-condition change to an existing one.
export const FLEET_PLAN_JSON_SCHEMA_VERSION = 2;

export interface PlanSummary {
  readonly creates: number;
  readonly updates: number;
  readonly noops: number;
  readonly extras: number;
  /**
   * groundnuty/macf#926 — items whose verb is `'write-always'` (`labels`/
   * `runner_warm`): apply attempts these on every run regardless of
   * observed state, so they are counted SEPARATELY from `creates` rather
   * than folded in — a `'write-always'` item was never verified missing,
   * unlike a genuine `'create'`. Kept out of `creates` so that count keeps
   * meaning "confirmed-or-plausibly missing," not "will be written."
   */
  readonly writeAlways: number;
  /**
   * groundnuty/macf#1229 / DR-043 Amendment P3 row 4 — items whose verb is
   * `'delete'` (a cheap-to-revive resource this tool provisioned and the
   * manifest no longer wants). Counted separately, same "don't fold a
   * distinctly-meaning verb into an existing bucket" precedent
   * `writeAlways` already set — a `delete` is neither a `create` nor an
   * `update`, and folding it into either would misstate what this plan
   * calls for.
   */
  readonly deletes: number;
  /**
   * groundnuty/macf#1229 / DR-043 Amendment P3 row 4 — items whose verb is
   * `'orphan'` (an expensive-to-revive resource in the same "ours, no
   * longer wanted" position as `deletes` above, but never actioned by
   * `apply` — an instruction to the operator, not a statement of intent).
   */
  readonly orphans: number;
}

export function summarizePlan(items: readonly PlanItem[]): PlanSummary {
  return {
    creates: items.filter((i) => i.verb === 'create').length,
    updates: items.filter((i) => i.verb === 'update').length,
    noops: items.filter((i) => i.verb === 'noop').length,
    extras: items.filter((i) => i.verb === 'report-extra').length,
    writeAlways: items.filter((i) => i.verb === 'write-always').length,
    deletes: items.filter((i) => i.verb === 'delete').length,
    orphans: items.filter((i) => i.verb === 'orphan').length,
  };
}

/** One loud line per skipped section — `<section>: SKIPPED (<reason>)`. */
export function formatSkippedLines(sections: readonly SkippedSection[]): readonly string[] {
  return sections.map((s) => `${s.section}: SKIPPED (${s.reason})`);
}

/**
 * One loud line per apply-unimplemented item — `<kind>: <target> (<verb>)
 * — NOT IMPLEMENTED BY APPLY (<reason>)`. Deliberately different wording
 * from `formatSkippedLines`'s "SKIPPED": SKIPPED means the manifest declared
 * a whole SECTION nothing reconciles at all (§D3-scale, `versions:` /
 * `collaborators:`); NOT IMPLEMENTED means THIS run's plan needs action on a
 * SPECIFIC resource that `apply` has no code for (macf#854). The operator
 * must be able to tell "apply won't do this" from "nothing to do" — see
 * `planItemApplyCoverage`'s doc.
 */
export function formatUnimplementedLines(items: readonly UnimplementedApplyItem[]): readonly string[] {
  return items.map((i) => `${i.kind}: ${i.target} (${i.verb}) — NOT IMPLEMENTED BY APPLY (${i.reason})`);
}

/**
 * groundnuty/macf#1281 — one loud line per `orphan`-verb item —
 * `<kind>: <target> — <reason>`. `reason` already carries the "NOTHING WAS
 * DELETED, delete it yourself here: <url-or-unknown>" text baked in at
 * construction time ({@link orphanResourceUrl} + `computePlan`'s row-4
 * `app`/`repo` branches), so this formatter never re-derives wording a
 * second time — same "one wording, reused" discipline
 * {@link formatUnimplementedLines} above already establishes for its own
 * per-item text.
 *
 * Shared verbatim between the `plan` surface ({@link formatPlanText} below)
 * and the `apply` surface (`bootstrap-apply.ts`'s `formatApprovalBanner`) —
 * this issue's own AC requires the SAME text on both, and importing one
 * function is what makes "same" a structural guarantee rather than two
 * independently-drifting copies.
 */
export function formatOrphanLines(items: readonly PlanItem[]): readonly string[] {
  return items.filter((i) => i.verb === 'orphan').map((i) => `${i.kind}: ${i.target} — ${i.reason}`);
}

/**
 * groundnuty/macf#999 requirement 3 — one loud line per registry-scope
 * conflict (0 or 1; see {@link FleetPlan.registryScopeIssues}'s doc). Says
 * plainly that `apply` REFUSES for this manifest — a `plan` operator must
 * not read this fleet's exit-0 render as "this will provision fine."
 */
export function formatRegistryScopeLines(issues: readonly RegistryScopeConflict[]): readonly string[] {
  return issues.map((i) => `registry: UNSATISFIABLE — \`macf bootstrap apply\` will refuse before any consent gate (${i.message})`);
}

/**
 * groundnuty/macf#1012 requirement 4 — one loud line per repo-scope notice
 * (0 or 1; see {@link FleetPlan.registryRepoScopeNotices}'s doc). Says
 * plainly that `apply` VERIFIES this live post-gate-2 — distinct wording
 * from {@link formatRegistryScopeLines}'s "UNSATISFIABLE": this is a NOTICE
 * (`type: repo` works), not a refusal.
 */
export function formatRegistryRepoScopeLines(notices: readonly RegistryRepoScopeNotice[]): readonly string[] {
  return notices.map((n) => `registry: NOTICE — ${n.message}`);
}

/** groundnuty/macf#1128 — one line per already-provisioned agent App whose observed install scope is wrong. `WARNING`, not `NOTICE` (the sibling functions above): this is a LIVE observed fact about an EXISTING install, not a manifest-derived heads-up about a future one. */
export function formatInstallScopeDriftLines(drift: readonly InstallScopeDrift[]): readonly string[] {
  return drift.map((d) => `install-scope: WARNING — ${d.message}`);
}

/**
 * groundnuty/macf#1162 — one line per {@link ScopeCredentialNotice}. `NOTICE`
 * (not `WARNING`) — this is a standing, expected-during-the-interim state,
 * never a problem to fix; the whole point of surfacing it every run is
 * visibility, not urgency (see `FleetPlan.scopeCredentials`'s doc).
 */
export function formatScopeCredentialLines(notices: readonly ScopeCredentialNotice[]): readonly string[] {
  return notices.map((n) => `scope_credential: NOTICE — ${n.message}`);
}

// --- Operator interaction budget (groundnuty/macf#880, DR-044 Decision 6) ---
//
// DR-044 §D2's operator cost model is measured in consent clicks; Amendment
// G extends that to the whole lifecycle (revival cost in clicks). Neither
// `plan` nor `apply --dry-run` told the operator the interaction budget
// up front — they discovered the click count by living it, one browser tab
// at a time. This section is a PURE PROJECTION over counts a caller
// already computed — no new observation (the #1000 golden-path rule: one
// way to answer "how many gates," not a second one that could drift from
// the first).
//
// gate1 (App creation) and gate2 (install) are counted SEPARATELY, not as
// one number doubled — they are NOT always equal. Every `'app'`-kind create
// item (or the `'runner_ops'`-kind one, macf#943 — CONDITIONAL as of
// macf#1083; `runnerOpsItem` emits no item at all, so no count, for a
// hosted-runner fleet with no prior lock entry) is ONE gate-1-then-gate-2
// pair — the common case `countAppsToCreate` covers. But
// `apply-agent.ts`'s vault-aware confirm-before-create guard can ALSO
// produce a `'resume-install'` decision (an App exists, confirmed live, with
// ZERO installs) — gate 1 is SKIPPED for that role, but gate 2 still runs
// (`apply-agent.ts::runGate2WithInterstitial`'s own doc: "Called for BOTH
// the create path and the resume-install path — every gate-2 run gets an
// interstitial, regardless of how gate 2 was reached"). A role in that state
// is EXCLUDED from `commands/bootstrap-apply.ts::filterCreationsByPreview`'s
// output (it dropped every non-`'create'` decision, correctly, for GATE 1),
// so a gate-1-only count silently underclaims gate 2 for it — the one
// direction `bound: 'maximum'` promises never happens. Callers that can see
// `'resume-install'` decisions (only `bootstrap-apply.ts`'s vault-aware
// preview can; `plan` never live-confirms) MUST fold that count into their
// gate-2 number before calling {@link operatorInteractionBudget} — see that
// function's doc.
//
// **Known residual — NOT closed by the fold-in above.** The preview that
// detects `'resume-install'` (`commands/bootstrap-apply.ts::previewIdentityDecisions`)
// loops ONLY `manifest.agents` — it structurally never considers
// `RUNNER_OPS_ROLE` (a fleet-level identity `FleetManifest.agents[]` never
// declares — `apply-runner-ops.ts`'s own doc). So a runner-ops App that
// exists live with zero installs is invisible to `countResumeInstallFlows`
// too: `bound: 'maximum'` still holds (the reported gate-2 count is a
// ceiling on what THIS preview could see), but it is not a ceiling on the
// real run's gate-2 opens in that one narrow lane. Extending the preview to
// cover `RUNNER_OPS_ROLE` is a NEW observation (a live confirm this module
// doesn't make today) — out of `commands/bootstrap-apply.ts`'s current
// preview shape, left for a future increment rather than folded in here.

/**
 * How many App-identity creations (coordination agents + the runner-ops +
 * the router App, groundnuty/macf#1105) this plan's items call for —
 * gate-1 driver in the common case where every counted role also needs
 * gate 2 (the `plan`-only vantage point: it never live-confirms, so it
 * cannot distinguish a `'resume-install'`-shaped role from a plain
 * create-candidate — see {@link operatorInteractionBudget}'s doc for the
 * richer apply-side count that CAN). Pure; zero I/O. Callers that already
 * filtered/refined a plan's items for a richer reason (e.g.
 * `commands/bootstrap-apply.ts`'s vault-aware `displayCreations`, which can
 * be LOWER than this count when a prior `fleet.lock` entry lets `apply`
 * confirm-and-reuse — macf#913/#915) should pass THEIR OWN count into
 * {@link operatorInteractionBudget} directly rather than recomputing from
 * `items` — this function is for the plain "as `computePlan` sees it" count
 * `macf bootstrap plan` renders.
 *
 * **This number is a CEILING, not a prediction** (groundnuty/macf#1129, and
 * DR-043 Amendment A). An App's existence cannot be confirmed without an App
 * JWT, so a `create` item means *"not confirmable from here"*, never *"proven
 * absent"* — and `apply` may find the App already live and do nothing. A run
 * that needs FEWER clicks than this has not falsified the count: a bound is
 * falsified by being exceeded, never by coming in under. Observed live on the
 * `macf-trial` 2→3 scale-up, where a `CREATE`-shaped preview resolved to
 * "App + install already confirmed live" and the operator clicked twice
 * rather than six times.
 *
 * So the operator-facing question is not *"did execution match the plan?"* but
 * *"did execution stay within it?"* — which is checkable, where accuracy is
 * not. `design/fleet-deployment-runbook.md` §4a states the same property for
 * the add-an-agent click formula; keep the two in step.
 */
export function countAppsToCreate(items: readonly PlanItem[]): number {
  return items.filter((i) => (i.kind === 'app' || i.kind === 'runner_ops' || i.kind === 'router_app') && i.verb === 'create').length;
}

/**
 * `'exact'` vs `'maximum'` — the honesty axis DR-043 Amendment A's floor
 * demands (`UNKNOWN_REASONS.identity`: "the API can confirm present, never
 * prove absent"). Zero gates on BOTH counts is the ONLY exact case: nothing
 * left to overstate. Any non-zero count is a CEILING, never a promise —
 * `presenceVerb`'s `'unknown'` degrade means a counted create-candidate
 * might already exist and simply be unconfirmed at this call's vantage
 * point (no local `fleet.lock` entry, no App JWT to check live);
 * `confirmBeforeCreateGuard`'s own contract (`apply-agent.ts`) requires a
 * PRIOR lock entry before it will even ATTEMPT a live re-check — a role
 * with none is a `'create'` decision regardless of `--vault`/
 * `--identity-key`, not because absence was proven. `bound` is carried as
 * an explicit field (not left for a JSON consumer to re-derive from a count
 * being zero) so a future increment that adds a genuine live-absence proof
 * doesn't silently change what today's `0` means without also changing
 * this contract.
 */
export type OperatorInteractionBound = 'exact' | 'maximum';

export interface OperatorInteractionBudget {
  readonly gate1Clicks: number;
  readonly gate2Flows: number;
  readonly bound: OperatorInteractionBound;
}

/**
 * `gate1Clicks`/`gate2Flows` → the full budget, deriving `bound` per
 * {@link OperatorInteractionBound}'s doc. Pure. `gate2Flows` defaults to
 * `gate1Clicks` — the common shape every `plan`-only caller has (it cannot
 * see `'resume-install'` decisions, so its two counts are always equal);
 * `commands/bootstrap-apply.ts`'s vault-aware call site passes both
 * explicitly, folding any `'resume-install'` roles into `gate2Flows` alone
 * (see the section doc above).
 */
export function operatorInteractionBudget(gate1Clicks: number, gate2Flows: number = gate1Clicks): OperatorInteractionBudget {
  return { gate1Clicks, gate2Flows, bound: gate1Clicks === 0 && gate2Flows === 0 ? 'exact' : 'maximum' };
}

/**
 * One human line stating the operator's consent-click budget for this run —
 * DR-044 Decision 6 ("cleanest, simplest reasons to act on"): one line, not
 * a table. Zero is stated explicitly (Amendment G's revival-cost property,
 * surfaced where the operator can see it) rather than silently omitted,
 * which would read as "unknown" instead of "free." The common
 * `gate1Clicks === gate2Flows` case (every counted role needs both gates)
 * gets the friendlier "N Apps to create" framing; the two counts DIVERGE
 * only when a vault-confirmed `'resume-install'` role adds an
 * install-only gate 2 with no matching gate 1 (see the section doc above)
 * — that shape gets its own wording naming both counts directly, since
 * "Apps to create" would misdescribe a role whose App already exists.
 */
export function formatOperatorInteractionLine(budget: OperatorInteractionBudget): string {
  const { gate1Clicks, gate2Flows, bound } = budget;
  if (gate1Clicks === 0 && gate2Flows === 0) {
    return 'Operator interaction: none — no consent gates this run.';
  }
  const qualifier = bound === 'maximum' ? 'up to ' : '';
  const ceilingNote =
    bound === 'maximum'
      ? ' This is a ceiling, not a promise — `macf bootstrap apply --vault <path> --identity-key <path>` may ' +
        'confirm some of these already exist and skip their gates.'
      : '';
  if (gate1Clicks === gate2Flows) {
    const n = gate1Clicks;
    const plural = n === 1 ? '' : 's';
    return (
      `Operator interaction: ${qualifier}${String(n)} App${plural} to create → ${qualifier}${String(n)} ` +
      `"Create GitHub App" click${plural} + ${String(n)} install flow${plural} (browser); everything else is ` +
      `automatic.${ceilingNote}`
    );
  }
  const p1 = gate1Clicks === 1 ? '' : 's';
  const p2 = gate2Flows === 1 ? '' : 's';
  const resumeOnly = gate2Flows - gate1Clicks;
  // "up to 0" reads as a contradiction (0 is 0, not a ceiling) — the
  // qualifier only makes sense prefixing a positive count, so it's applied
  // per-count here rather than once for the whole line (unlike the
  // gate1Clicks === gate2Flows branch above, where both counts are equal
  // and — by this point — always positive, since the all-zero case already
  // returned above).
  const q1 = gate1Clicks > 0 ? qualifier : '';
  const q2 = gate2Flows > 0 ? qualifier : '';
  const resumePlural = resumeOnly === 1;
  return (
    `Operator interaction: ${q1}${String(gate1Clicks)} "Create GitHub App" click${p1} + ` +
    `${q2}${String(gate2Flows)} install flow${p2} (browser) — ${String(resumeOnly)} already-created App` +
    `${resumePlural ? '' : 's'} still need${resumePlural ? 's' : ''} ${resumePlural ? 'its' : 'their'} install ` +
    `flow${resumePlural ? '' : 's'}; everything else is automatic.${ceilingNote}`
  );
}

/** `--json` shape for {@link OperatorInteractionBudget}. `gate1_clicks`/`gate2_flows` are named SEPARATELY (not one field doubled) because they can genuinely diverge (a `'resume-install'` role) — see the section doc above. */
export function operatorInteractionToJson(budget: OperatorInteractionBudget): unknown {
  return {
    gate1_clicks: budget.gate1Clicks,
    gate2_flows: budget.gate2Flows,
    bound: budget.bound,
  };
}

const PLAN_HEADERS = ['KIND', 'TARGET', 'VERB', 'CONFIRM', 'REASON'] as const;

/** Build one display row per plan item (pure — exported for tests). */
export function buildPlanRows(items: readonly PlanItem[]): readonly (readonly string[])[] {
  return items.map((i) => [i.kind, i.target, i.verb.toUpperCase(), i.confirm_required ? 'yes' : 'no', i.reason]);
}

/**
 * `4 create, 1 update (confirm-required), 3 noop, 1 report-extra (never
 * deleted), 1 delete (confirm-required, not yet actioned by apply), 1
 * orphan (never actioned by apply), 2 write-always (not comparable to
 * observed state)` (groundnuty/macf#926, comment only — the string itself
 * never cites an issue number; `delete`/`orphan` phrasing added
 * groundnuty/macf#1229, DR-043 Amendment P3 row 4).
 */
export function summaryLine(summary: PlanSummary): string {
  return (
    `${String(summary.creates)} create, ${String(summary.updates)} update (confirm-required), ` +
    `${String(summary.noops)} noop, ${String(summary.extras)} report-extra (never deleted), ` +
    `${String(summary.deletes)} delete (confirm-required, not yet actioned by apply), ` +
    `${String(summary.orphans)} orphan (never actioned by apply), ` +
    `${String(summary.writeAlways)} write-always (not comparable to observed state)`
  );
}

/** Full human-readable plan render, including the skipped-section loud lines when present. */
export function formatPlanText(plan: FleetPlan): string {
  const parts: string[] = [
    `macf bootstrap plan — ${plan.fleet}`,
    '',
    formatTable(PLAN_HEADERS, buildPlanRows(plan.items)),
    '',
    summaryLine(summarizePlan(plan.items)),
  ];
  const skipLines = formatSkippedLines(plan.skippedSections);
  if (skipLines.length > 0) {
    parts.push('', ...skipLines);
  }
  const unimplementedLines = formatUnimplementedLines(plan.unimplementedByApply);
  if (unimplementedLines.length > 0) {
    parts.push(
      '',
      `⚠ apply cannot action ${String(plan.unimplementedByApply.length)} item(s) below yet — approving this plan ` +
        'will NOT create, update, or delete them; they are NOT implemented, this is not "nothing to do":',
      ...unimplementedLines,
    );
  }
  // groundnuty/macf#1281 — the ORPHAN verb, spelled out. The table above
  // already carries this same text in each row's REASON column, but
  // `orphan` next to a resource name reads as jargon on a skim — this block
  // restates it in a loud, impossible-to-miss form, the same "table row PLUS
  // a dedicated loud block" shape `unimplementedLines` immediately above
  // already establishes for its own verb.
  const orphanLines = formatOrphanLines(plan.items);
  if (orphanLines.length > 0) {
    parts.push(
      '',
      `⚠ ${String(orphanLines.length)} resource(s) below are ORPHAN — created by this tool, no longer declared, ` +
        'and NEVER deleted by apply, under any flag. NOTHING IS DELETED for these; each line names how to ' +
        'remove it yourself, by hand, if it should go away:',
      ...orphanLines,
    );
  }
  const registryScopeLines = formatRegistryScopeLines(plan.registryScopeIssues);
  if (registryScopeLines.length > 0) {
    parts.push('', ...registryScopeLines);
  }
  const registryRepoScopeLines = formatRegistryRepoScopeLines(plan.registryRepoScopeNotices);
  if (registryRepoScopeLines.length > 0) {
    parts.push('', ...registryRepoScopeLines);
  }
  const installScopeDriftLines = formatInstallScopeDriftLines(plan.installScopeDrift);
  if (installScopeDriftLines.length > 0) {
    parts.push('', ...installScopeDriftLines);
  }
  const scopeCredentialLines = formatScopeCredentialLines(plan.scopeCredentials);
  if (scopeCredentialLines.length > 0) {
    parts.push('', ...scopeCredentialLines);
  }
  return parts.join('\n');
}

/**
 * Structured `--json` shape. `skipped_sections` + `unimplemented_by_apply`
 * are ALWAYS present (empty array when nothing applies). `registry_scope_issues`
 * (groundnuty/macf#999) deliberately does NOT follow that convention — it is
 * omitted entirely when empty, rather than an always-present `[]`, because a
 * `type: profile` fleet's `--json` output must stay byte-identical to its
 * pre-#999 shape (an unconditional new key would not be). Included only when
 * `plan.registryScopeIssues` is non-empty (`type: org`, today, always).
 * `registry_repo_scope_notice` (groundnuty/macf#1012) follows the SAME
 * omit-when-empty convention, for the SAME reason — a `type: profile`/
 * `type: org`/`type: local` fleet's `--json` output must stay byte-identical
 * to its pre-#1012 shape. Included only when `plan.registryRepoScopeNotices`
 * is non-empty (`type: repo`, today, always). `install_scope_drift`
 * (groundnuty/macf#1128) follows the SAME convention for the SAME reason —
 * a fleet with nothing observably mis-scoped (including every
 * personal-account-owned fleet, where this is never observable at all —
 * see `ObservedAgentState.installRepositorySelection`'s doc) keeps a
 * byte-identical pre-#1128 shape.
 */
export function fleetPlanToJson(plan: FleetPlan): unknown {
  return {
    schema_version: FLEET_PLAN_JSON_SCHEMA_VERSION,
    fleet: plan.fleet,
    plan: plan.items.map((i) => ({ ...i })),
    summary: summarizePlan(plan.items),
    skipped_sections: plan.skippedSections.map((s) => ({ ...s })),
    unimplemented_by_apply: plan.unimplementedByApply.map((i) => ({ ...i })),
    ...(plan.registryScopeIssues.length > 0
      ? { registry_scope_issues: plan.registryScopeIssues.map((i) => ({ ...i })) }
      : {}),
    ...(plan.registryRepoScopeNotices.length > 0
      ? { registry_repo_scope_notice: plan.registryRepoScopeNotices.map((i) => ({ ...i })) }
      : {}),
    // groundnuty/macf#1128 — omitted entirely when empty, same reason
    // `registry_scope_issues`/`registry_repo_scope_notice` do: byte-identical
    // `--json` output for a fleet with nothing to report.
    ...(plan.installScopeDrift.length > 0 ? { install_scope_drift: plan.installScopeDrift.map((i) => ({ ...i })) } : {}),
    // groundnuty/macf#1162 — SAME omitted-when-empty convention, same reason.
    ...(plan.scopeCredentials.length > 0 ? { scope_credentials: plan.scopeCredentials.map((i) => ({ ...i })) } : {}),
  };
}

export interface FleetPlanFailure {
  readonly code: string;
  readonly message: string;
}

/** The `--json` failure envelope — same `schema_version` contract as `fleetPlanToJson` (macf#830 lesson: never empty stdout under `--json`). */
export function fleetPlanFailureToJson(failure: FleetPlanFailure): unknown {
  return { schema_version: FLEET_PLAN_JSON_SCHEMA_VERSION, error: failure };
}

/**
 * The `--vault`/`--identity-key` XOR precondition — shared by BOTH `macf
 * bootstrap plan` (`commands/bootstrap.ts`) and `macf bootstrap apply`
 * (`commands/bootstrap-apply.ts`, macf#913) so the two commands can never
 * drift on this check's shape or error code. Returns a `FleetPlanFailure`
 * (code `vault_flags_incomplete`) when exactly ONE of the two flags was
 * given, `undefined` when both or neither were given (the two LEGAL states —
 * vault-aware and vault-free, respectively).
 *
 * Without this check, `--vault <path>` alone (identity-key forgotten) would
 * silently produce a byte-identical run to the vault-free default — no
 * `[vault: ...]` fact anywhere, no signal the operator's intent (vault-aware
 * observation/confirm) was never honored. That is exactly the shape this
 * file's own `skippedSections`/`unimplementedByApply` machinery exists to
 * prevent for manifest sections, and the silent-fallback class
 * `silent-fallback-hazards.md` Instance 15 documents at the launcher-flag
 * layer — a half-given CLI flag pair is the argument-boundary version of the
 * same hazard. Both commands are safe to REFUSE-at-the-boundary rather than
 * degrade-to-warn here: `plan` is read-only (never consent-gated, never
 * irreversible) and `apply` re-derives its own confirm-before-create guard
 * from this same precondition (macf#913) — in neither case does silently
 * degrading save the operator anything a loud refusal + immediate re-run
 * doesn't already give them.
 */
export function checkVaultFlagsComplete(vaultPath: string | undefined, identityKeyPath: string | undefined): FleetPlanFailure | undefined {
  if ((vaultPath === undefined) === (identityKeyPath === undefined)) return undefined;
  return {
    code: 'vault_flags_incomplete',
    message:
      '--vault and --identity-key must be given TOGETHER or not at all — ' +
      `only ${vaultPath !== undefined ? '--vault' : '--identity-key'} was given. Supply both for a ` +
      'vault-aware run, or neither for the vault-free default.',
  };
}
