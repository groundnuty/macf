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
 *   - **report-extra** — observed but NOT declared in the manifest (e.g. an
 *                    agent the lock remembers but the manifest dropped).
 *                    **There is no `delete` verb** — §D3 is explicit that
 *                    agent/resource deletion is out of scope; extras are
 *                    reported, never pruned.
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
import type { VaultAgentObservation, VaultCaObservation, VaultRecipientsObservation } from './vault-read.js';
import { countVaultAgentPresence, countVaultCaPresence } from './vault-read.js';
// macf#932 — reuse the SAME flag/env-var name constants `apply`'s own
// pre-flight refusal names, rather than re-typing them here (this is a
// value import, not `import type`; `apply-routing.ts` only ever `import
// type`s from files that in turn `import type` this module, so this stays
// a one-directional runtime dependency — see `apply-routing.ts::
// checkRunnerTokenPreflight`'s doc).
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from './apply-routing.js';
import { RUNNER_OPS_ROLE, deriveRunnerOpsHandle } from './apply-runner-ops.js';
// groundnuty/macf#999 — the SAME pure pre-flight `commands/bootstrap-apply.ts`
// refuses `apply` on; `plan` never refuses (it is read-only end to end — see
// this module's own `checkVaultFlagsComplete` doc for the contrast), it
// states the SAME fact as a loud banner instead (requirement 3: "plan states
// it"). One check function, two renderings — never two independently
// hand-authored copies of the underlying fact that could drift.
import type { RegistryRepoScopeNotice, RegistryScopeConflict } from './registry-scope-preflight.js';
import { checkRegistryRepoScopeNotice, checkRegistryScopePreflight } from './registry-scope-preflight.js';

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
  | 'vault_recipients';
export type PlanVerb = 'create' | 'update' | 'noop' | 'report-extra';

export interface PlanItem {
  readonly kind: PlanItemKind;
  readonly target: string;
  readonly verb: PlanVerb;
  readonly reason: string;
  /** `update` is ALWAYS `true` (§D3: confirm-then-update, never silent). Other verbs are always `false`. */
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
   * The subset of `items` that call for action (`create`/`update`) but
   * `apply` has no code path for yet — groundnuty/macf#854 ("plan emitted 7
   * create items; apply delivered 3, failed 1 loudly, silently skipped 3").
   * Computed via {@link planItemApplyCoverage}, the single source of truth
   * for "does apply actually do this" — see that function's doc. ALWAYS
   * present (empty array when apply can action everything the plan lists).
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
}

/**
 * The reason text for each declared-but-deferred section (Slice 1a; see
 * module doc). `versions` is GONE from this map (DR-043 §D6 is wired as of
 * this change, not deferred) — `collaborators` is the sole remaining member.
 */
export const SKIPPED_SECTION_REASONS = {
  collaborators: 'reconcile not implemented in v1 — see #838 follow-ups',
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
 */
export const APPLY_UNIMPLEMENTED_REASONS = {
  routing:
    'apply writes MACF_TRUSTED_ACTORS when the variable is ABSENT (create-only, macf#838 Amendment D phase 2, ' +
    'corrected to the router\'s actually-read variable by macf#922) but does NOT overwrite a PRESENT-but-' +
    'diverging value — the task\'s create-only posture ("never silently overwrite") leaves this specific update ' +
    'un-actioned. Set the repo variable manually to the declared value, or re-run apply once a future increment ' +
    'adds confirmed per-item updates; nothing above was changed for this item.',
  // groundnuty/macf#942 (DR-043 Amendment I) — `warm` is declared + recorded
  // (FleetRoutingRunnerSchema, DR-009 §7.4) but `apply` does not yet call the
  // runner-provisioning contract (repo/labels/warm) that would establish it
  // on a live runner — that wiring is groundnuty/macf#943, still blocked.
  // This warning is expected to disappear on its own, with no second code
  // path, once #943 lands and `planItemApplyCoverage`'s 'runner_warm' arm
  // below flips to 'implemented'.
  runnerWarm:
    'apply provisions identity/repo/CA/routing wiring; it does not yet call the runner-provisioning contract ' +
    '(repo/labels/warm) that would act on a declared warm posture (groundnuty/macf#943, blocked). warm is ' +
    'recorded in the manifest and in this plan, but nothing enforces it yet — a dormant fleet (warm: 0) still ' +
    'has its runner kept warm until #943 wires the contract call; nothing above was changed for this item.',
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
  if (item.verb === 'noop' || item.verb === 'report-extra') return 'implemented';
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
      // groundnuty/macf#942 (DR-043 Amendment I) — a genuinely NEW field with
      // NO enforcement path yet: `apply` does not call the runner-
      // provisioning contract (repo/labels/warm) that would act on it — that
      // wiring is groundnuty/macf#943, still blocked. `runnerWarmItem` below
      // only ever emits 'create' (there is no live-observable "is this
      // runner already warm/dormant" signal to compare against), but this
      // stays a whole-kind gap regardless of verb, same shape as
      // 'version'/'actions_pin' above.
      return 'not_implemented';
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
  }
}

function unimplementedReasonFor(kind: PlanItemKind): string {
  switch (kind) {
    case 'routing':
      return APPLY_UNIMPLEMENTED_REASONS.routing;
    case 'runner_warm':
      return APPLY_UNIMPLEMENTED_REASONS.runnerWarm;
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
    case 'vault_recipients':
    case 'version':
    case 'actions_pin':
      // Unreachable: `planItemApplyCoverage` never returns 'not_implemented'
      // for these kinds (see its switch above — 'repo' joined this group in
      // macf#857 / DR-043 Amendment F, 'ca' in macf#838 Amendment D phase
      // 2, 'control_repo' in macf#867 / DR-043 Amendment G, 'agent_repo_archived'
      // in macf#1034 (DR-043 Amendment G correction), 'labels'/
      // 'routing_client' in groundnuty/macf#920, 'runner_ops' in
      // groundnuty/macf#943, 'vault_recipients' in groundnuty/macf#957,
      // 'version' in macf#1045 / DR-043 Amendment L, 'actions_pin' in
      // macf#1072 / DR-043 Amendment L extended).
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
    out.push({ kind: item.kind, target: item.target, verb: item.verb, reason: unimplementedReasonFor(item.kind) });
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
    'it live ONLY when invoked with BOTH --vault and --identity-key (DR-043 Amendment A) — pass both to avoid ' +
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
 */
function labelsItem(agent: FleetAgent): PlanItem {
  return {
    kind: 'labels',
    target: `agent:${agent.role}:labels:${agent.repo}`,
    verb: 'create',
    reason:
      `role + status labels on "${agent.repo}" are not observable at plan time (no per-label API read wired) — ` +
      'treated as a create-candidate, LOW CONFIDENCE. `apply` attempts label creation unconditionally on every ' +
      'repo-init run regardless of this item.',
    confirm_required: false,
  };
}

/**
 * The runner-ops App plan item (groundnuty/macf#943) — ONE item per
 * fleet (not per agent; this App is never declared in `manifest.agents[]`),
 * so the operator sees "the extra App and its two clicks" (task brief)
 * called out explicitly rather than folded silently into the per-agent `app`
 * items above. Presence is read directly off `observed.lock.agents` (no
 * `ObservedState` field addition needed — the same `fleet.lock` this
 * function's caller already threads through) since `githubRegistryObserver`
 * only ever populates `ObservedState.agents` from `manifest.agents` (never
 * from lock-only roles), so there is no risk of this role being
 * double-counted as a `report-extra` `agent` item at the bottom of
 * `computePlan` — see that function's doc.
 *
 * `absent`-vs-`unknown` mirrors `appItem`'s own convention exactly: no lock
 * entry reads as `unknown` (Amendment A4 — the lock is a HINT, never
 * authoritative for "does the App exist on GitHub"; only a live JWT check
 * could confirm `absent`, which this Mac-side, offline-safe function never
 * attempts), never a false `absent`.
 */
function runnerOpsItem(fleetName: string, lockHasEntry: boolean): PlanItem {
  const handle = deriveRunnerOpsHandle(fleetName);
  const { verb, reasonSuffix } = presenceVerb(lockHasEntry ? 'present' : 'unknown', UNKNOWN_REASONS.identity);
  return {
    kind: 'runner_ops',
    target: `runner_ops:app:${handle}`,
    verb,
    reason:
      `Runner-ops GitHub App "${handle}" ${reasonSuffix} — a SECOND, minimal App per fleet ` +
      '(administration:write / actions:read / metadata:read; DR-019 has no administration permission and ' +
      'was not widened — groundnuty/macf#943). Provisioning it costs 2 operator consent-gate clicks (App-manifest ' +
      'creation + install), same shape as a coordination agent App.',
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
 * macf#932 — an UNCONDITIONAL note (not a "you're missing it" detection):
 * `plan` takes no `--runner-token` flag of its own and never will (see this
 * note's call site's doc) — it cannot know whether the OPERATOR intends to
 * supply one directly to a future `apply` invocation without ever exporting
 * {@link RUNNER_TOKEN_ENV_VAR}. Claiming "missing" here would be FALSE in
 * exactly that case. Naming the REQUIREMENT rather than guessing at its
 * satisfaction keeps this honest while still moving the fact "apply needs
 * this" earlier than `apply` itself shows it — see
 * `apply-routing.ts::checkRunnerTokenPreflight`'s doc for the actual
 * enforcement (which DOES know the resolved value, and DOES refuse).
 */
const RUNNER_TOKEN_PLAN_NOTE =
  ` \`macf bootstrap apply\` additionally requires ${RUNNER_TOKEN_FLAG} (or ${RUNNER_TOKEN_ENV_VAR}) before it will ` +
  'attempt this write at all — macf#932.';

/**
 * groundnuty/macf#993 — the operator's ruling, stated plainly BEFORE the
 * operator approves the plan (not just discovered at `apply` time): "the
 * failure of our runner should be loud, and the lack of it being
 * provisioned at this stage should block everything else." A declared
 * `routing.runner` is a REQUIREMENT, not a preference — `apply` refuses to
 * fall back to a metered hosted runner. UNCONDITIONAL (appended in both
 * `runnerClassReason` branches, mirroring {@link RUNNER_TOKEN_PLAN_NOTE}'s
 * own unconditional design): even when a runner IS confirmed registered at
 * PLAN time, `apply` can still fail on it later (the runner going offline
 * between plan and apply, or {@link RUNNER_TOKEN_PLAN_NOTE}'s own missing-
 * token refusal) — so the requirement is named regardless of the currently-
 * observed registration state, not only in the "absent" branch. Additive —
 * appended alongside the existing sentences above it, never a rewrite of
 * them (see `apply-routing.ts::publishTrustedActorsGated`'s doc for the
 * actual enforcement this note describes).
 */
const RUNNER_REQUIRED_FAILURE_PLAN_NOTE =
  ' A declared routing.runner is REQUIRED: if no usable runner is confirmed when `apply` runs, `apply` FAILS ' +
  '(non-zero exit) rather than silently falling back to a metered hosted runner — groundnuty/macf#993.';

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
 * appended verbatim when set, and macf#932 adds a further unconditional
 * suffix ({@link RUNNER_TOKEN_PLAN_NOTE}), followed by macf#993's own
 * unconditional suffix ({@link RUNNER_REQUIRED_FAILURE_PLAN_NOTE} — plan
 * states plainly, before approval, that `apply` will FAIL without a
 * confirmed runner). The original wording for the no-suffix branches is
 * preserved UNCHANGED (only the suffixes are new) so this stays a strict
 * extension — same "never rewrite" discipline as `handover`'s own addition.
 */
function runnerClassReason(
  runnerRegistered: Presence | undefined,
  representativeRepo: string | undefined,
  handover: string | undefined,
  detail: string | undefined,
): string {
  const repoLabel = representativeRepo ?? '(no agent repos declared)';
  if (runnerRegistered === 'present') {
    return (
      `Runner class: self-hosted (a runner is confirmed registered on "${repoLabel}").` +
      `${RUNNER_TOKEN_PLAN_NOTE}${RUNNER_REQUIRED_FAILURE_PLAN_NOTE}`
    );
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
 * DR-043 Amendment I / groundnuty/macf#942 — the runner-provisioning
 * contract's `warm` argument, declared per-fleet (DR-009 §7.4's warm-by-
 * default, hibernate-the-dormant policy). ONE item per fleet, not per agent
 * — `warm` is a runner-class-wide posture, same "one item" shape
 * {@link routingItem} already uses for the runner's other fields — emitted
 * only when `routing.runner` is DECLARED (same "nothing was promised" gate
 * `computePlan` applies to `routingItem` itself; see the call site).
 *
 * Always `verb: 'create'`, unlike `routingItem`'s three-way compare: there is
 * no live-observable "is this runner already at the declared warm posture"
 * signal to compare against — the runner-provisioning contract that would
 * set it, and the only thing that could read it back, does not exist yet
 * (groundnuty/macf#943). `apply` has NO code path for this kind regardless
 * of verb (see {@link planItemApplyCoverage}'s `'runner_warm'` case +
 * `APPLY_UNIMPLEMENTED_REASONS.runnerWarm`) — this item exists so the
 * declared value is VISIBLE in the plan and loudly admitted as
 * not-yet-enforced (groundnuty/macf#861's coverage machinery), rather than
 * silently accepted-and-ignored — exactly the #957/#958 defect this issue's
 * thread named.
 */
function runnerWarmItem(fleetName: string, desiredWarm: number): PlanItem {
  const dormantNote = desiredWarm === 0 ? ' — this fleet is declared dormant' : '';
  return {
    kind: 'runner_warm',
    target: `routing:${fleetName}:runner:warm`,
    verb: 'create',
    reason: `warm: ${String(desiredWarm)} declared (DR-009 §7.4)${dormantNote} — not yet observable or enforced by apply; see the apply-coverage note below.`,
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
  'control repo is ARCHIVED (DR-043 Amendment G) — a DELIBERATE, reversible fleet state set by a prior ' +
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
  `repo "${repo}" is ARCHIVED (DR-043 Amendment G) — a DELIBERATE, reversible fleet state set by a prior ` +
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
        're-encrypt to the full declared set (decrypt-then-whole-rewrite, DR-043 Amendment D).',
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
      'apply reconciles this by calling the "macf fleet upgrade" roll during this run (DR-043 Amendment L; ' +
      'DR-037 verify-green gated, §D4) — this restarts the agent',
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
 * per-agent processing" ordering), then per-agent items (app, repo, an
 * agent-repo-archived item right after `repo` when applicable — macf#1034,
 * the per-agent sibling of the control-repo-archived item above — install,
 * secret_fingerprint) in manifest `agents[]` order, then the CA items
 * (registry, then one per agent repo in manifest order — a MACF fleet
 * always needs a CA, so these are UNCONDITIONAL as of macf#839 review nit 5,
 * not gated on `trust:` being declared), then the routing item (only when
 * `routing.runner` is declared), then the §D6 version-steering items (only
 * when `versions:` is declared — one `version` + one `actions_pin` item per
 * agent, in manifest order), then report-extra items for any observed agent
 * NOT in the manifest, sorted by role for determinism.
 *
 * NEVER emits a delete/prune verb (§D3 "play it safe" — Design invariant 4).
 */
export function computePlan(manifest: FleetManifest, observed: ObservedState): FleetPlan {
  const fleetName = manifest.metadata.name;
  const seg = toVariableSegment(fleetName);
  const items: PlanItem[] = [];

  const controlRepo = controlRepoItem(observed.controlRepoPresence, observed.controlRepoArchived);
  if (controlRepo !== undefined) items.push(controlRepo);

  // groundnuty/macf#943 — fleet-level, ordered right after the control-repo
  // item (both are "before any per-agent processing" fleet-scoped facts) and
  // before the per-agent app/repo/install items so the operator sees it near
  // the top of the plan, not buried after every agent.
  const runnerOpsHasLockEntry = observed.lock?.agents.some((a) => a.role === RUNNER_OPS_ROLE) ?? false;
  items.push(runnerOpsItem(fleetName, runnerOpsHasLockEntry));

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

  const manifestRoles = new Set(manifest.agents.map((a) => a.role));
  const extraRoles = Object.keys(observed.agents)
    .filter((role) => !manifestRoles.has(role))
    .sort();
  for (const role of extraRoles) {
    items.push({
      kind: 'agent',
      target: `agent:${role}`,
      verb: 'report-extra',
      reason: 'observed (fleet.lock / registry) but not declared in fleet.yaml — never deleted (§D3 no-prune)',
      confirm_required: false,
    });
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

  return {
    fleet: fleetName,
    items,
    skippedSections: computeSkippedSections(manifest),
    unimplementedByApply: computeUnimplementedByApply(items),
    registryScopeIssues: registryScopeFailure !== undefined ? [registryScopeFailure] : [],
    registryRepoScopeNotices: registryRepoScopeNotice !== undefined ? [registryRepoScopeNotice] : [],
  };
}

// --- Formatting (human table + --json) ---

export const FLEET_PLAN_JSON_SCHEMA_VERSION = 1;

export interface PlanSummary {
  readonly creates: number;
  readonly updates: number;
  readonly noops: number;
  readonly extras: number;
}

export function summarizePlan(items: readonly PlanItem[]): PlanSummary {
  return {
    creates: items.filter((i) => i.verb === 'create').length,
    updates: items.filter((i) => i.verb === 'update').length,
    noops: items.filter((i) => i.verb === 'noop').length,
    extras: items.filter((i) => i.verb === 'report-extra').length,
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
// item (or the unconditional `'runner_ops'`-kind one, macf#943) is ONE
// gate-1-then-gate-2 pair — the common case `countAppsToCreate` covers. But
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
 * How many App-identity creations (coordination agents + the runner-ops)
 * this plan's items call for — gate-1 driver in the common case where every
 * counted role also needs gate 2 (the `plan`-only vantage point: it never
 * live-confirms, so it cannot distinguish a `'resume-install'`-shaped role
 * from a plain create-candidate — see {@link operatorInteractionBudget}'s
 * doc for the richer apply-side count that CAN). Pure; zero I/O. Callers
 * that already filtered/refined a plan's items for a richer reason (e.g.
 * `commands/bootstrap-apply.ts`'s vault-aware `displayCreations`, which can
 * be LOWER than this count when a prior `fleet.lock` entry lets `apply`
 * confirm-and-reuse — macf#913/#915) should pass THEIR OWN count into
 * {@link operatorInteractionBudget} directly rather than recomputing from
 * `items` — this function is for the plain "as `computePlan` sees it" count
 * `macf bootstrap plan` renders.
 */
export function countAppsToCreate(items: readonly PlanItem[]): number {
  return items.filter((i) => (i.kind === 'app' || i.kind === 'runner_ops') && i.verb === 'create').length;
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
        'confirm some of these already exist and skip their gates (macf#913/#915).'
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

/** `4 create, 1 update (confirm-required), 3 noop, 1 report-extra (never deleted)`. */
export function summaryLine(summary: PlanSummary): string {
  return (
    `${String(summary.creates)} create, ${String(summary.updates)} update (confirm-required), ` +
    `${String(summary.noops)} noop, ${String(summary.extras)} report-extra (never deleted)`
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
        'will NOT create or update them; they are NOT implemented, this is not "nothing to do" (macf#854):',
      ...unimplementedLines,
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
 * is non-empty (`type: repo`, today, always).
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
      'vault-aware run (DR-043 Amendment D phase 3), or neither for the vault-free default.',
  };
}
