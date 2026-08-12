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
 * `versions:` (§D6 GitOps steering) and `collaborators:` (§D3 day-2
 * catalog) are PARSED by the schema but their reconcile logic is deferred
 * past Slice 1a. To avoid the silent-fallback shape where an operator who
 * declares a collaborator sees a "clean" plan and reasonably assumes it was
 * reconciled, `computePlan` surfaces every declared-but-deferred section
 * explicitly via `FleetPlan.skippedSections` — never silent.
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
  readonly deployedVersion?: string;
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
  /** The `MACF_ROUTING_RUNS_ON` value observed on a caller repo, if any. */
  readonly routingRunsOn?: string;
}

/** Produces an `ObservedState` for a manifest. Implemented by `observer.ts`'s `githubRegistryObserver`; faked in tests. */
export type FleetObserverFn = (manifest: FleetManifest) => Promise<ObservedState>;

// --- Plan ---

export type PlanItemKind = 'app' | 'repo' | 'install' | 'secret_fingerprint' | 'ca' | 'routing' | 'agent';
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

/** The reason text for each declared-but-deferred section (Slice 1a; see module doc). */
export const SKIPPED_SECTION_REASONS = {
  collaborators: 'reconcile not implemented in v1 — see #838 follow-ups',
  versions: 'fleet-upgrade steering is day-2 — see #838',
} as const;

/**
 * Surface every declared-but-deferred manifest section, loudly. Only fires
 * when the section is actually DECLARED (present) — `versions` is an object
 * (declared = key present) — AND, for array sections, non-empty. An absent
 * or empty section stays silent (nothing was promised, so nothing to warn
 * about not having reconciled).
 */
function computeSkippedSections(manifest: FleetManifest): readonly SkippedSection[] {
  const out: SkippedSection[] = [];
  if (manifest.collaborators !== undefined && manifest.collaborators.length > 0) {
    out.push({ section: 'collaborators', reason: SKIPPED_SECTION_REASONS.collaborators });
  }
  if (manifest.versions !== undefined) {
    out.push({ section: 'versions', reason: SKIPPED_SECTION_REASONS.versions });
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

/** The reason text for each kind `apply` cannot action yet (macf#854). Keyed by kind, not by item, so this stays the ONE place to update when a future increment wires the CA or routing orchestrator step. */
export const APPLY_UNIMPLEMENTED_REASONS = {
  ca:
    'apply has no CA-provisioning step — no orchestrator step in apply-fleet.ts writes this variable at all ' +
    '(macf#854). Provision it manually (mint/publish the CA cert to this GitHub Variable) or re-run apply once a ' +
    'future increment adds the step; nothing above was created or changed for this item.',
  routing:
    'apply has no routing-provisioning step — no orchestrator step in apply-fleet.ts writes MACF_ROUTING_RUNS_ON ' +
    'at all (macf#854). Set the registry variable manually or re-run apply once a future increment adds the step; ' +
    'nothing above was created or changed for this item.',
  repoCreate:
    'apply does not create repositories — repo-init (workflow + agent-config.json) only runs against an ' +
    'ALREADY-EXISTING repo and fails loud (a plain `git clone` error) if it is missing (macf#854 §2, ' +
    'apply-repo-init.ts). Create the repo manually (e.g. from `defaults.role_template`) and re-run apply.',
} as const;

/**
 * THE single source of truth for "does `apply` actually do this" — every
 * renderer (plan text, plan `--json`, apply's final summary, apply
 * `--json`) derives from THIS function; none of them hand-roll their own
 * "is this kind implemented" guess. When a future increment wires the CA or
 * routing orchestrator step into `apply-fleet.ts`, flipping the matching
 * arm below is the ONLY change needed for every one of those renderers to
 * pick it up (macf#854).
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
      // presenceVerb only ever produces 'create' or 'noop' for a repo item
      // (a pure existence check) — 'noop' is filtered above, so the only
      // verb reaching here is 'create'. apply-repo-init.ts's module doc:
      // repo CREATION is explicitly out of scope this increment.
      return item.verb === 'create' ? 'not_implemented' : 'implemented';
    case 'ca':
    case 'routing':
      // No CA or routing orchestrator step exists in apply-fleet.ts at all
      // (macf#854) — every create/update item of these two kinds is
      // unconditionally un-actioned today, regardless of verb.
      return 'not_implemented';
  }
}

function unimplementedReasonFor(kind: PlanItemKind): string {
  switch (kind) {
    case 'ca':
      return APPLY_UNIMPLEMENTED_REASONS.ca;
    case 'routing':
      return APPLY_UNIMPLEMENTED_REASONS.routing;
    case 'repo':
      return APPLY_UNIMPLEMENTED_REASONS.repoCreate;
    case 'app':
    case 'install':
    case 'secret_fingerprint':
    case 'agent':
      // Unreachable: `planItemApplyCoverage` never returns 'not_implemented'
      // for these kinds (see its switch above). Kept exhaustive so a NEW
      // `PlanItemKind` added later is a compile error here, not a silent
      // "apply covers everything" false-negative.
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

function secretFingerprintItem(agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const fingerprints = obs?.fingerprints ?? {};
  const count = Object.keys(fingerprints).length;
  if (count === 0) {
    return {
      kind: 'secret_fingerprint',
      target: `agent:${agent.role}:secrets`,
      verb: 'create',
      reason: 'no fingerprints recorded in fleet.lock — agent has not been provisioned yet',
      confirm_required: false,
    };
  }
  return {
    kind: 'secret_fingerprint',
    target: `agent:${agent.role}:secrets`,
    verb: 'noop',
    reason:
      `${String(count)} fingerprint(s) recorded in fleet.lock. Live-registry fingerprint drift-detection ` +
      '(re-materialize-from-vault on clobber) is a Slice-2 concern — not exercised by plan-only Slice 1a.',
    confirm_required: false,
  };
}

/** The registry-scope CA plan item — one of the two DR two-place-rule legs (macf#806). */
function caRegistryItem(seg: string, presence: Presence): PlanItem {
  const varName = `${seg}_CA_CERT`;
  const { verb, reasonSuffix } = presenceVerb(presence, UNKNOWN_REASONS.variable);
  return {
    kind: 'ca',
    target: `ca:registry:${varName}`,
    verb,
    reason: `registry CA var "${varName}" ${reasonSuffix}`,
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
 * The pure §D3 three-verb reconcile. Deterministic ordering: per-agent items
 * (app, repo, install, secret_fingerprint) in manifest `agents[]` order, then
 * the CA items (registry, then one per agent repo in manifest order — a MACF
 * fleet always needs a CA, so these are UNCONDITIONAL as of macf#839 review
 * nit 5, not gated on `trust:` being declared), then the routing item (only
 * when `routing.runner` is declared), then report-extra items for any
 * observed agent NOT in the manifest, sorted by role for determinism.
 *
 * NEVER emits a delete/prune verb (§D3 "play it safe" — Design invariant 4).
 */
export function computePlan(manifest: FleetManifest, observed: ObservedState): FleetPlan {
  const fleetName = manifest.metadata.name;
  const seg = toVariableSegment(fleetName);
  const items: PlanItem[] = [];

  for (const agent of manifest.agents) {
    const obs = observed.agents[agent.role];
    items.push(appItem(fleetName, agent, obs));
    items.push(repoItem(agent, obs));
    items.push(installItem(fleetName, agent, obs));
    items.push(secretFingerprintItem(agent, obs));
  }

  items.push(caRegistryItem(seg, observed.caRegistry));
  for (const agent of manifest.agents) {
    items.push(caRepoItem(seg, agent.repo, observed.caRepos[agent.repo] ?? 'unknown'));
  }

  if (manifest.routing?.runner) {
    items.push(routingItem(fleetName, manifest.routing.runner.runs_on, observed.routingRunsOn));
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
