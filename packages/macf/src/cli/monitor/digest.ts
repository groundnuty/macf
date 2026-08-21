/**
 * Aggregation + protocol-health digest builder for the auditor Monitor
 * (groundnuty/macf#502, DR-026 F4).
 *
 * This module is PURE: it takes already-read inputs (issues, PRs, reflection
 * records) plus an injected clock and produces a Markdown digest string. No I/O,
 * no `gh`, no `Date.now()` — the clock is injected so the `generated-at` header
 * is deterministic under test.
 *
 * The digest is REPORTING ONLY. It surfaces drift, stale state, and candidate
 * rule-evolution signals to the operator. It does NOT propose or actuate
 * anything — the Analyze→Plan→propose half of the MAPE-K loop is gated behind a
 * separate ratification issue (DR-026 G1) and is explicitly out of scope here.
 */
import type { ReflectionRecord, RuleEvolutionSignal } from '@groundnuty/macf-core';
import type { MonitorIssue, MonitorPR } from './github-reader.js';

/** Injectable clock — production passes `Date.now`; tests pass a fixed fn. */
export type Clock = () => number;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Assignment-label heuristic: labels ending in `-agent` are who-owns-it. */
function isAssignmentLabel(label: string): boolean {
  return label.endsWith('-agent');
}

export interface DigestInput {
  readonly project: string;
  readonly repo: string;
  /** Stale threshold in days (open issue older than this is flagged). */
  readonly sinceDays: number;
  readonly issues: readonly MonitorIssue[];
  readonly prs: readonly MonitorPR[];
  readonly reflections: readonly ReflectionRecord[];
  /** Count of reflection JSONL lines skipped as malformed (surfaced). */
  readonly reflectionsSkipped: number;
  /** Number of reflection ledger files read. */
  readonly reflectionFiles: number;
  /** Count of project-tier rule docs present (`.claude/rules/project/*.md`). */
  readonly projectRulesCount: number;
  /** Injected clock for the deterministic `generated-at` header. */
  readonly now: Clock;
}

/** A stale open issue with its computed age + owning assignment label. */
export interface StaleIssue {
  readonly number: number;
  readonly title: string;
  readonly ageDays: number;
  /** First `-agent` label found, or `unassigned`. */
  readonly owner: string;
}

/** PRs grouped by the action the operator/reviewer needs to take. */
export interface PrBuckets {
  readonly awaitingReview: readonly MonitorPR[];
  readonly approvedUnmerged: readonly MonitorPR[];
  readonly changesRequested: readonly MonitorPR[];
  readonly drafts: readonly MonitorPR[];
}

/** One aggregated rule-evolution signal, deduped across agents by `key`. */
export interface AggregatedSignal {
  /** The dedup handle (`key`) or, when absent, the signal text itself. */
  readonly handle: string;
  readonly proposedTier: string;
  readonly signal: string;
  /** Distinct AGENTS that raised this signal — the cross-agent corroboration
   *  count (NOT raw occurrences: five hits from ONE agent count as one). */
  readonly count: number;
  /** Raw record count carrying this signal (informational; ≥ count). */
  readonly occurrences: number;
  /** Whether the grouping used an explicit `key` (vs. falling back to text). */
  readonly hasKey: boolean;
}

function ageInDays(createdAtIso: string, nowMs: number): number {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return 0;
  return Math.floor((nowMs - created) / DAY_MS);
}

/** Compute the stale-issue set: open issues older than `sinceDays`. */
export function computeStaleIssues(
  issues: readonly MonitorIssue[],
  sinceDays: number,
  nowMs: number,
): readonly StaleIssue[] {
  const stale: StaleIssue[] = [];
  for (const issue of issues) {
    const ageDays = ageInDays(issue.createdAt, nowMs);
    if (ageDays <= sinceDays) continue;
    const owner = issue.labels.find(isAssignmentLabel) ?? 'unassigned';
    stale.push({ number: issue.number, title: issue.title, ageDays, owner });
  }
  // Oldest first — the operator's attention should go to the longest-stalled.
  return stale.sort((a, b) => b.ageDays - a.ageDays);
}

/** Bucket open PRs by the action they need. */
export function computePrBuckets(prs: readonly MonitorPR[]): PrBuckets {
  const awaitingReview: MonitorPR[] = [];
  const approvedUnmerged: MonitorPR[] = [];
  const changesRequested: MonitorPR[] = [];
  const drafts: MonitorPR[] = [];

  for (const pr of prs) {
    if (pr.isDraft) {
      drafts.push(pr);
      continue;
    }
    switch (pr.reviewDecision) {
      case 'APPROVED':
        approvedUnmerged.push(pr);
        break;
      case 'CHANGES_REQUESTED':
        changesRequested.push(pr);
        break;
      // REVIEW_REQUIRED, null, or any other state → still needs a review.
      default:
        awaitingReview.push(pr);
        break;
    }
  }
  return { awaitingReview, approvedUnmerged, changesRequested, drafts };
}

/**
 * Aggregate rule-evolution signals across every reflection record, grouped by
 * (proposed_tier, dedup-handle). The dedup handle is the signal's `key` when
 * present (the cross-agent dedup handle per the F2 schema) and the signal text
 * otherwise. `count` is the number of DISTINCT AGENTS that raised the signal —
 * the cross-agent corroboration count, NOT raw occurrences (five hits from one
 * agent count as one). This is the occurrence-vs-distinct-agent distinction the
 * auditor's N>1 promotion gate hinges on (macf#503/#514); the digest's "×N
 * agents" label must reflect distinct agents, not it would imply a corroboration
 * it never measured. `occurrences` keeps the raw record count for context.
 */
export function aggregateSignals(
  records: readonly ReflectionRecord[],
): readonly AggregatedSignal[] {
  interface Group {
    handle: string;
    proposedTier: string;
    signal: string;
    /** Distinct agent names (the corroboration unit). */
    readonly agents: Set<string>;
    /** Raw record count. */
    occurrences: number;
    hasKey: boolean;
  }
  const byHandle = new Map<string, Group>();

  for (const rec of records) {
    const agentName = rec.agent.name;
    for (const sig of rec.rule_evolution_signals as readonly RuleEvolutionSignal[]) {
      const hasKey = typeof sig.key === 'string' && sig.key.length > 0;
      const handle = hasKey ? sig.key! : sig.signal;
      // Tier is part of the grouping key so the same handle proposed at two
      // tiers shows up as two distinct candidate signals.
      const mapKey = JSON.stringify([sig.proposed_tier, handle]);
      const existing = byHandle.get(mapKey);
      if (existing) {
        existing.agents.add(agentName);
        existing.occurrences += 1;
      } else {
        byHandle.set(mapKey, {
          handle,
          proposedTier: sig.proposed_tier,
          signal: sig.signal,
          agents: new Set([agentName]),
          occurrences: 1,
          hasKey,
        });
      }
    }
  }

  // Strongest cross-agent corroboration (distinct agents) first, then by tier.
  return [...byHandle.values()]
    .map((g) => ({
      handle: g.handle,
      proposedTier: g.proposedTier,
      signal: g.signal,
      count: g.agents.size,
      occurrences: g.occurrences,
      hasKey: g.hasKey,
    }))
    .sort((a, b) => b.count - a.count || a.proposedTier.localeCompare(b.proposedTier));
}

function countBreaches(records: readonly ReflectionRecord[]): number {
  return records.reduce((n, r) => n + r.breaches.length, 0);
}

function countUnresolved(records: readonly ReflectionRecord[]): number {
  return records.reduce((n, r) => n + r.unresolved.length, 0);
}

/** ISO8601 UTC, seconds precision (matches the reflection schema's timestamp). */
function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the full Markdown protocol-health digest.
 *
 * Sections: header → Stale issues → PRs awaiting action → Aggregated reflection
 * signals → Summary. Drift / stale state / candidate signals are SURFACED, not
 * acted on; a one-line note records that proposing/actuation is gated (G1).
 */
export function buildDigest(input: DigestInput): string {
  const nowMs = input.now();
  const stale = computeStaleIssues(input.issues, input.sinceDays, nowMs);
  const buckets = computePrBuckets(input.prs);
  const signals = aggregateSignals(input.reflections);
  const breachCount = countBreaches(input.reflections);
  const unresolvedCount = countUnresolved(input.reflections);

  const lines: string[] = [];

  // --- Header ---
  lines.push(`# Protocol-Health Digest — ${input.project}`);
  lines.push('');
  lines.push(`- Repo: \`${input.repo}\``);
  lines.push(`- Generated at: ${isoUtc(nowMs)}`);
  lines.push(`- Stale threshold: ${input.sinceDays} days`);
  lines.push(
    `- Read-only auditor. Drift + candidate signals below are ` +
    `**surfaced, not acted on** — proposing/actuation is gated.`,
  );
  lines.push('');

  // --- Stale issues ---
  lines.push('## Stale issues');
  lines.push('');
  if (stale.length === 0) {
    lines.push(`_No open issues older than ${input.sinceDays} days._`);
  } else {
    const byOwner = new Map<string, StaleIssue[]>();
    for (const s of stale) {
      const arr = byOwner.get(s.owner) ?? [];
      arr.push(s);
      byOwner.set(s.owner, arr);
    }
    for (const owner of [...byOwner.keys()].sort()) {
      lines.push(`### ${owner}`);
      lines.push('');
      for (const s of byOwner.get(owner)!) {
        lines.push(`- #${s.number} — ${s.title} (${s.ageDays}d open)`);
      }
      lines.push('');
    }
    // Trailing blank from the loop is fine; normalize below.
  }
  lines.push('');

  // --- PRs awaiting action ---
  lines.push('## PRs awaiting action');
  lines.push('');
  const prSection = (heading: string, prs: readonly MonitorPR[]): void => {
    lines.push(`### ${heading}`);
    lines.push('');
    if (prs.length === 0) {
      lines.push('_none_');
    } else {
      for (const pr of prs) {
        lines.push(`- #${pr.number} — ${pr.title}`);
      }
    }
    lines.push('');
  };
  prSection('Awaiting review', buckets.awaitingReview);
  prSection('Approved, unmerged', buckets.approvedUnmerged);
  prSection('Changes requested', buckets.changesRequested);
  if (buckets.drafts.length > 0) {
    prSection('Drafts', buckets.drafts);
  }

  // --- Aggregated reflection signals ---
  lines.push('## Aggregated reflection signals');
  lines.push('');
  lines.push(
    `_Candidate rule-evolution signals harvested from F2 reflections — ` +
    `surfaced for operator awareness, not proposed (G1)._`,
  );
  lines.push('');
  if (signals.length === 0) {
    lines.push('_No rule-evolution signals in the reflection ledgers._');
    lines.push('');
  } else {
    const byTier = new Map<string, AggregatedSignal[]>();
    for (const sig of signals) {
      const arr = byTier.get(sig.proposedTier) ?? [];
      arr.push(sig);
      byTier.set(sig.proposedTier, arr);
    }
    for (const tier of [...byTier.keys()].sort()) {
      lines.push(`### proposed_tier: ${tier}`);
      lines.push('');
      for (const sig of byTier.get(tier)!) {
        const dedup = sig.hasKey
          ? ` [key: \`${sig.handle}\`]`
          : '';
        const corroboration = sig.count > 1 ? ` (×${sig.count} agents)` : '';
        lines.push(`- ${sig.signal}${dedup}${corroboration}`);
      }
      lines.push('');
    }
  }

  // --- Summary ---
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Open issues: ${input.issues.length} (stale: ${stale.length})`);
  lines.push(
    `- Open PRs: ${input.prs.length} ` +
    `(awaiting review: ${buckets.awaitingReview.length}, ` +
    `approved-unmerged: ${buckets.approvedUnmerged.length}, ` +
    `changes-requested: ${buckets.changesRequested.length})`,
  );
  lines.push(
    `- Reflection records: ${input.reflections.length} ` +
    `across ${input.reflectionFiles} ledger file(s) ` +
    `(skipped malformed lines: ${input.reflectionsSkipped})`,
  );
  lines.push(
    `- Candidate signals: ${signals.length} | ` +
    `breaches: ${breachCount} | unresolved: ${unresolvedCount}`,
  );
  lines.push(`- Project-tier rules present: ${input.projectRulesCount}`);
  lines.push('');
  lines.push(
    `> This is a read-only protocol-health report. No issues were created, ` +
    `commented on, closed, or merged. Proposing rule changes / actuation is a ` +
    `separate, ratification-gated step.`,
  );

  // Collapse any accidental 3+ blank-line runs to a single blank line.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
