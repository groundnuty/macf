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
 * `versions:` (§D6 GitOps steering) is WIRED as of this change: once
 * declared, `computePlan` emits a `version` item per agent (deployed macf
 * CLI version) and an `actions_pin` item per agent repo (the macf-actions
 * router pin committed to that repo's `agent-router.yml`) — see
 * `macfVersionItem` / `actionsVersionItem` below. Both are pure
 * value-comparisons against `ObservedState`, same three-verb shape as every
 * other item in this file; `apply` has NO code path for either kind
 * (`planItemApplyCoverage`'s `'version'` / `'actions_pin'` cases) — the
 * remedy is a DIFFERENT command per kind (`macf fleet upgrade` for the macf
 * CLI version; `macf repo-init --actions-version <pin> --force` for the
 * router pin — verified independently, NOT the same command, despite DR-043
 * §D6's prose naming `macf fleet upgrade` generically for "a mismatch").
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
import { deriveAppHandle } from './fleet-manifest.js';
import { formatTable } from '../commands/ps.js';
import type { VaultAgentObservation, VaultCaObservation } from './vault-read.js';
import { countVaultAgentPresence, countVaultCaPresence } from './vault-read.js';

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
  /** Secret-name → fingerprint, sourced from `fleet.lock` (never a secret value). */
  readonly fingerprints: Readonly<Record<string, string>>;
  /**
   * The agent's deployed macf CLI version — DR-043 §D6. Sourced from
   * `fleet.lock` ONLY ({@link readFleetLock}'s `deployed_version` field);
   * `undefined` when the lock has no entry, or the entry has never recorded
   * one. **Honest limitation, not a hidden one:** no code path in this
   * repo currently WRITES `deployed_version` into `fleet.lock` (verified —
   * `apply-fleet.ts` never sets it), and this Mac-side, GitHub-only tool has
   * no mTLS path to an agent's live `/health.version` (that read belongs to
   * `macf fleet upgrade`'s VM-side operational plane, DR-037/§D4) — so this
   * field is realistically `undefined` for most fleets until a future
   * increment wires a genuine write-back. `undefined` here MUST read as
   * `unknown`, never as "matches" or "differs" — see `plan.ts`'s
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
   * Vault-derived per-project CA key/cert presence (DR-043 Amendment D phase
   * 3) — same undefined-vs-observed convention as {@link ObservedAgentState.vault}.
   */
  readonly vaultCa?: VaultCaObservation;
  /** The `MACF_ROUTING_RUNS_ON` value observed on a caller repo, if any. */
  readonly routingRunsOn?: string;
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
  | 'agent'
  | 'control_repo'
  | 'version'
  | 'actions_pin';
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
 */
export const APPLY_UNIMPLEMENTED_REASONS = {
  routing:
    'apply writes MACF_ROUTING_RUNS_ON when the variable is ABSENT (create-only, macf#838 Amendment D phase 2) ' +
    'but does NOT overwrite a PRESENT-but-diverging value — the task\'s create-only posture ("never silently ' +
    'overwrite") leaves this specific update un-actioned. Set the registry variable manually to the declared ' +
    'value, or re-run apply once a future increment adds confirmed per-item updates; nothing above was changed ' +
    'for this item.',
  // DR-043 §D6 — apply provisions identity/repo/CA/routing-wiring; it never
  // touches deployed SOFTWARE versions, by design (§D4: that is the
  // OPERATIONAL plane, VM-side/agent-privileged, a different tool). This
  // holds for BOTH the 'create' (unknown-degrade) and 'update' (confirmed
  // drift) verbs this kind can emit — there is no create-a-version
  // primitive either.
  version:
    'apply provisions identity/repo/CA/routing wiring; it deliberately never rolls the deployed macf CLI ' +
    'version (§D4 — the operational plane is `macf fleet upgrade`, VM-side, agent-privileged, gated by ' +
    'DR-037\'s verify-green outcome). Run "macf fleet upgrade" (optionally --target <version>) to converge; ' +
    'nothing above was changed for this item.',
  // Deliberately a DIFFERENT remedy than `version` above — `macf fleet
  // upgrade` / `macf update` never touch a repo's committed
  // `.github/workflows/agent-router.yml` (verified: neither reads nor
  // writes that path). Only `macf repo-init --actions-version ... --force`
  // regenerates it (repo-init.ts's "--force only controls the workflow
  // file" contract) — naming the WRONG remedy here would send the operator
  // to a command that cannot fix this resource.
  actionsPin:
    'apply provisions identity/repo/CA/routing wiring; it does not rewrite an existing repo\'s committed ' +
    '"agent-router.yml" — that file is only regenerated by `macf repo-init --actions-version <pin> --force`, ' +
    'not by `macf fleet upgrade` / `macf update` (neither touches that path). Run "macf repo-init ' +
    '--actions-version <pin> --force" on the drifted repo to converge; nothing above was changed for this item.',
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
    case 'routing':
      // macf#838 Amendment D phase 2: apply-fleet.ts writes
      // MACF_ROUTING_RUNS_ON when absent (create). It does NOT overwrite a
      // present-but-diverging value — the task's create-only posture forces
      // `update` to stay un-actioned (see APPLY_UNIMPLEMENTED_REASONS.routing).
      // By this point in the switch `item.verb` is guaranteed to be
      // 'create' or 'update' (noop/report-extra returned above), so this is
      // exhaustive over the two remaining verbs.
      return item.verb === 'create' ? 'implemented' : 'not_implemented';
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
    case 'version':
    case 'actions_pin':
      // DR-043 §D6 — apply NEVER acts on either kind, regardless of verb:
      // 'create' here is the unobservable-degrade candidate (see
      // `macfVersionItem` / `actionsVersionItem`), and there is no
      // create-a-version / create-a-router-pin primitive either. Unlike
      // 'routing' above, this is a WHOLE-KIND gap, not a create-vs-update
      // split — both remaining verbs (noop/report-extra already returned
      // above) stay `not_implemented`.
      return 'not_implemented';
  }
}

function unimplementedReasonFor(kind: PlanItemKind): string {
  switch (kind) {
    case 'routing':
      return APPLY_UNIMPLEMENTED_REASONS.routing;
    case 'version':
      return APPLY_UNIMPLEMENTED_REASONS.version;
    case 'actions_pin':
      return APPLY_UNIMPLEMENTED_REASONS.actionsPin;
    case 'app':
    case 'install':
    case 'secret_fingerprint':
    case 'agent':
    case 'repo':
    case 'ca':
    case 'control_repo':
      // Unreachable: `planItemApplyCoverage` never returns 'not_implemented'
      // for these kinds (see its switch above — 'repo' joined this group in
      // macf#857 / DR-043 Amendment F, 'ca' in macf#838 Amendment D phase
      // 2, 'control_repo' in macf#867 / DR-043 Amendment G). Kept exhaustive
      // so a NEW `PlanItemKind` added later is a compile error here, not a
      // silent "apply covers everything" false-negative.
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
  identity:
    'not confirmable at plan time (no App JWT — the PEM lives in the vault; ' +
    'a vault-aware confirm runs during apply, DR-043 Amendment A)',
  repo: 'could not be read (auth / network / insufficient scope) — existence unconfirmed',
  variable: 'could not be read (auth / network / insufficient scope) — existence unconfirmed',
  // DR-043 §D6 — deliberately NOT the same cause as `identity` above (no
  // JWT is not why this is unknown) nor `variable` (this isn't a failed
  // GitHub API read either, most of the time): `fleet.lock` simply has never
  // had a `deployed_version` recorded for this agent, because no code path
  // in this repo writes one yet (verified — see `ObservedAgentState.deployedVersion`'s
  // doc). Naming the real cause matters the same way it did for
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

function routingItem(fleetName: string, desiredRunsOn: string, observedRunsOn: string | undefined): PlanItem {
  const target = `routing:${fleetName}:runner`;
  if (observedRunsOn === undefined) {
    return {
      kind: 'routing',
      target,
      verb: 'create',
      reason: 'MACF_ROUTING_RUNS_ON not observable at plan time — treated as a create-candidate',
      confirm_required: false,
    };
  }
  if (observedRunsOn === desiredRunsOn) {
    return {
      kind: 'routing',
      target,
      verb: 'noop',
      reason: `MACF_ROUTING_RUNS_ON already "${desiredRunsOn}"`,
      confirm_required: false,
    };
  }
  return {
    kind: 'routing',
    target,
    verb: 'update',
    reason: `MACF_ROUTING_RUNS_ON observed "${observedRunsOn}" but manifest declares "${desiredRunsOn}"`,
    confirm_required: true,
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
 *     `apply` never actions this verb (`planItemApplyCoverage`'s `'version'`
 *     case) — the reason text NAMES the actual remedy (`macf fleet upgrade`)
 *     so re-running `plan` after editing `versions.macf` doesn't leave the
 *     operator guessing what converges it.
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
      'run "macf fleet upgrade" to converge (DR-037 operational plane, §D4); apply does not roll fleets',
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
 * The remedy NAMED in the `update` reason is deliberately DIFFERENT from
 * `macfVersionItem`'s: `macf fleet upgrade` / `macf update` never touch a
 * repo's committed `agent-router.yml` (verified — neither reads nor writes
 * that path); only `macf repo-init --actions-version <pin> --force`
 * regenerates it. DR-043 §D6's prose names `macf fleet upgrade` generically
 * for "a mismatch" against either `versions.*` field — that reads correctly
 * for `versions.macf` but not for `versions.actions`, so this reason text
 * intentionally diverges from the DR's prose rather than repeating a remedy
 * that would send the operator to the wrong command.
 */
function actionsVersionItem(agent: FleetAgent, desired: string, obs: ObservedAgentState | undefined): PlanItem {
  const target = `repo:${agent.repo}:version:actions`;
  const observed = obs?.actionsPin;
  if (observed === undefined) {
    return {
      kind: 'actions_pin',
      target,
      verb: 'create',
      reason:
        `macf-actions router pin on "${agent.repo}" ${UNKNOWN_REASONS.actionsPin} — ` +
        'not drift, not a match — LOW CONFIDENCE',
      confirm_required: false,
    };
  }
  if (observed === desired) {
    return {
      kind: 'actions_pin',
      target,
      verb: 'noop',
      reason: `macf-actions router pin on "${agent.repo}" already "${desired}"`,
      confirm_required: false,
    };
  }
  return {
    kind: 'actions_pin',
    target,
    verb: 'update',
    reason:
      `macf-actions router pin on "${agent.repo}" observed "${observed}" but manifest declares "${desired}" — ` +
      `run "macf repo-init --actions-version ${desired} --force" on that repo to converge; ` +
      'apply does not rewrite agent-router.yml',
    confirm_required: true,
  };
}

/**
 * The pure §D3 three-verb reconcile. Deterministic ordering: the
 * control-repo-archived item FIRST when applicable (DR-043 Amendment G —
 * mirrors `apply-fleet.ts`'s own "control repo is step 0, before any
 * per-agent processing" ordering), then per-agent items (app, repo, install,
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

  for (const agent of manifest.agents) {
    const obs = observed.agents[agent.role];
    items.push(appItem(fleetName, agent, obs));
    items.push(repoItem(agent, obs));
    items.push(installItem(fleetName, agent, obs));
    items.push(secretFingerprintItem(agent, obs));
  }

  items.push(caRegistryItem(seg, observed.caRegistry, observed.vaultCa));
  for (const agent of manifest.agents) {
    items.push(caRepoItem(seg, agent.repo, observed.caRepos[agent.repo] ?? 'unknown'));
  }

  if (manifest.routing?.runner) {
    items.push(routingItem(fleetName, manifest.routing.runner.runs_on, observed.routingRunsOn));
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
      items.push(actionsVersionItem(agent, desiredActions, obs));
    }
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

  return {
    fleet: fleetName,
    items,
    skippedSections: computeSkippedSections(manifest),
    unimplementedByApply: computeUnimplementedByApply(items),
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
  return parts.join('\n');
}

/** Structured `--json` shape. `skipped_sections` + `unimplemented_by_apply` are ALWAYS present (empty array when nothing applies). */
export function fleetPlanToJson(plan: FleetPlan): unknown {
  return {
    schema_version: FLEET_PLAN_JSON_SCHEMA_VERSION,
    fleet: plan.fleet,
    plan: plan.items.map((i) => ({ ...i })),
    summary: summarizePlan(plan.items),
    skipped_sections: plan.skippedSections.map((s) => ({ ...s })),
    unimplemented_by_apply: plan.unimplementedByApply.map((i) => ({ ...i })),
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
