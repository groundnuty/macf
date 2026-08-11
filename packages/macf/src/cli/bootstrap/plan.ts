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

/** Presence → {verb, reason-suffix} for a pure existence-only resource (App / repo / install / CA). */
function presenceVerb(presence: Presence): { readonly verb: 'create' | 'noop'; readonly reasonSuffix: string } {
  switch (presence) {
    case 'present':
      return { verb: 'noop', reasonSuffix: 'already present' };
    case 'absent':
      return { verb: 'create', reasonSuffix: 'missing' };
    case 'unknown':
      return {
        verb: 'create',
        reasonSuffix:
          'not observable at plan time (no JWT for pre-provisioning App/install reads) — ' +
          'treated as a create-candidate, LOW CONFIDENCE',
      };
  }
}

function appItem(fleetName: string, agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const handle = deriveAppHandle(fleetName, agent.role);
  const { verb, reasonSuffix } = presenceVerb(obs?.app ?? 'unknown');
  return {
    kind: 'app',
    target: `agent:${agent.role}:app:${handle}`,
    verb,
    reason: `GitHub App "${handle}" ${reasonSuffix}`,
    confirm_required: false,
  };
}

function repoItem(agent: FleetAgent, obs: ObservedAgentState | undefined): PlanItem {
  const { verb, reasonSuffix } = presenceVerb(obs?.repo ?? 'unknown');
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
  const { verb, reasonSuffix } = presenceVerb(obs?.install ?? 'unknown');
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
  const { verb, reasonSuffix } = presenceVerb(presence);
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
  const { verb, reasonSuffix } = presenceVerb(presence);
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

  return { fleet: fleetName, items, skippedSections: computeSkippedSections(manifest) };
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
  return parts.join('\n');
}

/** Structured `--json` shape. `skipped_sections` is ALWAYS present (empty array when nothing was skipped). */
export function fleetPlanToJson(plan: FleetPlan): unknown {
  return {
    schema_version: FLEET_PLAN_JSON_SCHEMA_VERSION,
    fleet: plan.fleet,
    plan: plan.items.map((i) => ({ ...i })),
    summary: summarizePlan(plan.items),
    skipped_sections: plan.skippedSections.map((s) => ({ ...s })),
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
