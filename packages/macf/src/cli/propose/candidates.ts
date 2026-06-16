/**
 * Pure candidate-proposal pipeline for the auditor Plan membrane
 * (groundnuty/macf#503, DR-026 G1). This is the Analyze→Plan half of the
 * MAPE-K loop: turn F4's reflection signals into RATIFIABLE proposals.
 *
 * Everything here is deterministic CODE scaffolding. The LLM judgment (is this a
 * real rule? is the text precise? is the tier right?) is NOT encoded — the code
 * assembles the AGENT-AUTHORED signal content (`signal`/`proposed_tier`/
 * `rationale` from `rule_evolution_signals`) into structured proposals and
 * applies three LOAD-BEARING, mechanical safety gates:
 *
 *   GATE 1 — N>1 = distinct AGENTS, not occurrences. A candidate is promotable
 *     only if it recurs across ≥ threshold DISTINCT `agent.name`s. Five hits from
 *     ONE agent is N=1 → HELD (reflection ≠ verification). We count the set of
 *     distinct agent names, never raw occurrences.
 *
 *   GATE 3 — no-auto-drop on invariant-touch. Step 4 SURFACES which protected
 *     invariants a candidate touches + flags apparent-relaxations HIGH-RISK, but
 *     NEVER drops/rejects in code. The amendment clause lets the auditor PROPOSE
 *     an operator-ratified amendment, so auto-dropping would foreclose that path.
 *     (GATE 2 — dry-run-by-default — lives in the orchestrator/command + writer
 *     seam, not here.)
 *
 * The tier-router (step 3) groups by the `proposed_tier` HINT and marks
 * `universal` candidates NEEDS-CONFIRMATION (never auto-route a universal
 * promotion — it affects every deployment). The hint is a hint, not a decision.
 */
import type { ReflectionRecord, RuleEvolutionSignal } from '@groundnuty/macf-core';
import {
  invariantsTouched,
  readsAsRelaxation,
  type InvariantTouch,
  type ProtectedInvariant,
} from './invariants.js';

/** Default distinct-agent threshold for promotion (configurable). */
export const DEFAULT_MIN_AGENTS = 2;

/** Tier values that must never auto-route (affect every deployment). */
const UNIVERSAL_TIERS = new Set(['universal', 'canonical']);

/**
 * The router routing decision for a candidate, derived from its `proposed_tier`
 * HINT. `needs-confirmation` is the universal/canonical case (never auto-route);
 * `project-draft` is the local-project-rule case; `review` is anything else (an
 * unrecognised tier hint still surfaces, routed for plain operator review).
 */
export type RouteDecision = 'needs-confirmation' | 'project-draft' | 'review';

/** A fully-assembled, ratifiable candidate proposal (a survivor of GATE 1). */
export interface ProposalCandidate {
  /** Dedup handle: the signal `key` when present, else the signal text. */
  readonly handle: string;
  /** Whether the grouping used an explicit `key` (vs falling back to text). */
  readonly hasKey: boolean;
  /** The agent-authored proposed tier HINT (verbatim). */
  readonly proposedTier: string;
  /** Representative agent-authored signal text. */
  readonly signal: string;
  /** All distinct agent-authored rationales contributing this candidate. */
  readonly rationales: readonly string[];
  /** Distinct agent names that corroborated this candidate (GATE 1 unit). */
  readonly corroboratingAgents: readonly string[];
  /** Distinct-agent count == corroboratingAgents.length (the GATE-1 number). */
  readonly distinctAgents: number;
  /** Raw occurrence count (records carrying this signal) — informational only. */
  readonly occurrences: number;
  /** Router decision from the tier hint. */
  readonly route: RouteDecision;
  /** Protected invariants this candidate plausibly touches (SURFACED, GATE 3). */
  readonly invariantTouches: readonly InvariantTouch[];
  /** True when the text reads like a relaxation → HIGH-RISK flag (GATE 3). */
  readonly highRisk: boolean;
}

/** A candidate HELD below the distinct-agent threshold (reported, not dropped). */
export interface HeldCandidate {
  readonly handle: string;
  readonly hasKey: boolean;
  readonly proposedTier: string;
  readonly signal: string;
  readonly distinctAgents: number;
  readonly occurrences: number;
  /** Why it was held — always the N<threshold reason for v1. */
  readonly reason: string;
}

/** The full pipeline output: survivors + held + the threshold used. */
export interface CandidateSet {
  readonly minAgents: number;
  readonly promoted: readonly ProposalCandidate[];
  readonly held: readonly HeldCandidate[];
}

/** Internal accumulator while grouping signals by (tier, handle). */
interface SignalGroup {
  handle: string;
  hasKey: boolean;
  proposedTier: string;
  signal: string;
  /** Distinct agent names (the GATE-1 set). */
  readonly agents: Set<string>;
  /** Distinct rationales (deduped, insertion-ordered). */
  readonly rationales: string[];
  /** Raw occurrence count. */
  occurrences: number;
}

/** Group key: same handle proposed at two tiers → two distinct candidates. */
function groupKey(tier: string, handle: string): string {
  return JSON.stringify([tier, handle]);
}

/**
 * Group all reflection rule-evolution signals by (proposed_tier, handle),
 * accumulating the SET OF DISTINCT AGENT NAMES (not occurrences) for GATE 1.
 *
 * This is the load-bearing distinction from F4's `aggregateSignals`, which
 * counts occurrences. Five signals from one agent collapse to a single-agent
 * set here; five from five agents collapse to a five-agent set.
 */
function groupSignals(records: readonly ReflectionRecord[]): SignalGroup[] {
  const byKey = new Map<string, SignalGroup>();
  for (const rec of records) {
    const agentName = rec.agent.name;
    for (const sig of rec.rule_evolution_signals as readonly RuleEvolutionSignal[]) {
      const hasKey = typeof sig.key === 'string' && sig.key.length > 0;
      const handle = hasKey ? sig.key! : sig.signal;
      const k = groupKey(sig.proposed_tier, handle);
      let g = byKey.get(k);
      if (!g) {
        g = {
          handle,
          hasKey,
          proposedTier: sig.proposed_tier,
          signal: sig.signal,
          agents: new Set<string>(),
          rationales: [],
          occurrences: 0,
        };
        byKey.set(k, g);
      }
      g.agents.add(agentName);
      g.occurrences += 1;
      const rationale = sig.rationale.trim();
      if (rationale.length > 0 && !g.rationales.includes(rationale)) {
        g.rationales.push(rationale);
      }
    }
  }
  return [...byKey.values()];
}

/** Route a candidate from its tier hint (universal/canonical never auto-route). */
export function routeForTier(proposedTier: string): RouteDecision {
  const tier = proposedTier.trim().toLowerCase();
  if (UNIVERSAL_TIERS.has(tier)) return 'needs-confirmation';
  if (tier === 'project') return 'project-draft';
  return 'review';
}

/**
 * Run the full candidate pipeline over the reflection records.
 *
 * Steps (DR-026 G1 §The command):
 *   1. Aggregate signals (distinct-agent grouping).
 *   2. GATE 1 — keep candidates with distinctAgents ≥ minAgents; the rest go to
 *      `held` (visible, never silently dropped).
 *   3. Tier-router — universal/canonical → needs-confirmation; project → draft.
 *   4. Subordination-check — surface touched invariants + HIGH-RISK relaxation
 *      flag. NEVER drops (GATE 3).
 */
export function buildCandidates(
  records: readonly ReflectionRecord[],
  invariants: readonly ProtectedInvariant[],
  minAgents: number = DEFAULT_MIN_AGENTS,
): CandidateSet {
  const threshold = Number.isFinite(minAgents) && minAgents >= 1 ? Math.floor(minAgents) : DEFAULT_MIN_AGENTS;
  const groups = groupSignals(records);

  const promoted: ProposalCandidate[] = [];
  const held: HeldCandidate[] = [];

  for (const g of groups) {
    const distinctAgents = g.agents.size;
    if (distinctAgents < threshold) {
      held.push({
        handle: g.handle,
        hasKey: g.hasKey,
        proposedTier: g.proposedTier,
        signal: g.signal,
        distinctAgents,
        occurrences: g.occurrences,
        reason: `N=${distinctAgents} distinct agent(s) < threshold ${threshold} (reflection ≠ verification)`,
      });
      continue;
    }

    // Step 4 — subordination-check surfacing (GATE 3: surface, never drop).
    const candidateText = [g.signal, ...g.rationales].join('\n');
    const touches = invariantsTouched(candidateText, invariants);
    const highRisk = readsAsRelaxation(candidateText) && touches.length > 0;

    promoted.push({
      handle: g.handle,
      hasKey: g.hasKey,
      proposedTier: g.proposedTier,
      signal: g.signal,
      rationales: g.rationales,
      corroboratingAgents: [...g.agents].sort(),
      distinctAgents,
      occurrences: g.occurrences,
      route: routeForTier(g.proposedTier),
      invariantTouches: touches,
      highRisk,
    });
  }

  // Strongest corroboration first, then high-risk surfaced near the top so the
  // operator sees the constitutional-scrutiny candidates early.
  promoted.sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) ||
      b.distinctAgents - a.distinctAgents ||
      a.proposedTier.localeCompare(b.proposedTier) ||
      a.handle.localeCompare(b.handle),
  );
  held.sort(
    (a, b) =>
      b.distinctAgents - a.distinctAgents ||
      a.proposedTier.localeCompare(b.proposedTier) ||
      a.handle.localeCompare(b.handle),
  );

  return { minAgents: threshold, promoted, held };
}
