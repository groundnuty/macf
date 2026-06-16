/**
 * Tests for the pure aggregation + digest builder (macf#502, DR-026 F4).
 *
 * Fixture-driven: canned issues/PRs + reflection records → assert the digest
 * contains the expected stale-issue / PR-state / aggregated-signal lines, and
 * that the clock is injected (deterministic `generated-at`).
 */
import { describe, it, expect } from 'vitest';
import {
  buildDigest,
  computeStaleIssues,
  computePrBuckets,
  aggregateSignals,
  type DigestInput,
} from '../../../src/cli/monitor/digest.js';
import type { MonitorIssue, MonitorPR } from '../../../src/cli/monitor/github-reader.js';
import type { ReflectionRecord } from '@groundnuty/macf-core';

// Fixed "now" so age math + the header timestamp are deterministic.
const NOW_MS = Date.parse('2026-06-16T12:00:00Z');
const fixedClock = () => NOW_MS;

function daysAgo(n: number): string {
  return new Date(NOW_MS - n * 24 * 60 * 60 * 1000).toISOString();
}

const ISSUES: MonitorIssue[] = [
  { number: 439, title: 'TOCTOU', createdAt: daysAgo(40), labels: ['code-agent', 'backlog'] },
  { number: 224, title: 'NPM_TOKEN rotation', createdAt: daysAgo(51), labels: ['science-agent'] },
  { number: 600, title: 'fresh issue', createdAt: daysAgo(2), labels: ['code-agent'] },
  { number: 601, title: 'unlabeled stale', createdAt: daysAgo(30), labels: [] },
];

const PRS: MonitorPR[] = [
  { number: 520, title: 'awaiting', createdAt: daysAgo(1), reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', isDraft: false },
  { number: 511, title: 'approved', createdAt: daysAgo(2), reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', isDraft: false },
  { number: 519, title: 'changes', createdAt: daysAgo(3), reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', isDraft: false },
  { number: 530, title: 'wip', createdAt: daysAgo(1), reviewDecision: null, mergeStateStatus: 'BLOCKED', isDraft: true },
  { number: 531, title: 'null-decision', createdAt: daysAgo(1), reviewDecision: null, mergeStateStatus: 'UNKNOWN', isDraft: false },
];

function record(overrides: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return {
    schema_version: '1.0',
    kind: 'macf.reflection',
    agent: { name: 'code-agent', role: 'code-agent', login: 'macf-code-agent[bot]' },
    project: 'macf',
    session_id: 's1',
    timestamp: '2026-06-16T04:00:00Z',
    trigger: 'pre-compact',
    compaction_type: 'auto',
    observed_patterns: [],
    breaches: [],
    rule_evolution_signals: [],
    unresolved: [],
    synthesis: '',
    ...overrides,
  };
}

const REFLECTIONS: ReflectionRecord[] = [
  record({
    agent: { name: 'code-agent', role: 'code-agent', login: 'a' },
    rule_evolution_signals: [
      { signal: 'send≠receipt last-mile gap', proposed_tier: 'canonical', rationale: 'r', key: 'send-neq-receipt' },
    ],
    breaches: [{ rule: 'token-hygiene', what: 'used bare token', ref: '#1' }],
    unresolved: ['flaky e2e'],
  }),
  record({
    agent: { name: 'science-agent', role: 'science-agent', login: 'b' },
    rule_evolution_signals: [
      // Same key from a DIFFERENT agent → should dedup to count 2.
      { signal: 'last-mile delivery gap', proposed_tier: 'canonical', rationale: 'r2', key: 'send-neq-receipt' },
      { signal: 'worktree-or-die', proposed_tier: 'project', rationale: 'r3' },
    ],
    unresolved: ['npm token', 'tempo verify'],
  }),
];

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    project: 'macf',
    repo: 'groundnuty/macf',
    sinceDays: 14,
    issues: ISSUES,
    prs: PRS,
    reflections: REFLECTIONS,
    reflectionsSkipped: 1,
    reflectionFiles: 2,
    projectRulesCount: 0,
    now: fixedClock,
    ...overrides,
  };
}

describe('computeStaleIssues', () => {
  it('flags only issues older than the threshold, grouped owner resolved', () => {
    const stale = computeStaleIssues(ISSUES, 14, NOW_MS);
    const numbers = stale.map((s) => s.number);
    expect(numbers).toContain(439);
    expect(numbers).toContain(224);
    expect(numbers).toContain(601);
    expect(numbers).not.toContain(600); // 2 days — fresh
  });

  it('sorts oldest-first and assigns owner from the -agent label', () => {
    const stale = computeStaleIssues(ISSUES, 14, NOW_MS);
    expect(stale[0]!.number).toBe(224); // 51d, oldest
    expect(stale.find((s) => s.number === 439)!.owner).toBe('code-agent');
    expect(stale.find((s) => s.number === 601)!.owner).toBe('unassigned');
  });
});

describe('computePrBuckets', () => {
  it('buckets PRs by required action', () => {
    const b = computePrBuckets(PRS);
    expect(b.approvedUnmerged.map((p) => p.number)).toEqual([511]);
    expect(b.changesRequested.map((p) => p.number)).toEqual([519]);
    expect(b.drafts.map((p) => p.number)).toEqual([530]);
    // REVIEW_REQUIRED and null both fall into awaiting-review.
    expect(b.awaitingReview.map((p) => p.number).sort()).toEqual([520, 531]);
  });
});

describe('aggregateSignals', () => {
  it('dedups by key across agents and counts corroboration', () => {
    const agg = aggregateSignals(REFLECTIONS);
    const sendNeq = agg.find((a) => a.handle === 'send-neq-receipt');
    expect(sendNeq).toBeDefined();
    expect(sendNeq!.count).toBe(2); // two agents, same key
    expect(sendNeq!.hasKey).toBe(true);
    expect(sendNeq!.proposedTier).toBe('canonical');

    const worktree = agg.find((a) => a.signal === 'worktree-or-die');
    expect(worktree!.count).toBe(1);
    expect(worktree!.hasKey).toBe(false);
  });

  it('counts DISTINCT AGENTS not occurrences — 5 hits from ONE agent is ×1 (macf#514)', () => {
    const sameAgent = Array.from({ length: 5 }, () =>
      record({
        agent: { name: 'code-agent', role: 'code-agent', login: 'a' },
        rule_evolution_signals: [
          { signal: 'solo signal', proposed_tier: 'project', rationale: 'r', key: 'solo' },
        ],
      }),
    );
    const agg = aggregateSignals(sameAgent);
    const solo = agg.find((a) => a.handle === 'solo');
    expect(solo).toBeDefined();
    expect(solo!.count).toBe(1); // ONE distinct agent — NOT 5 (the mislabel bug)
    expect(solo!.occurrences).toBe(5); // raw record count, informational only
    // And the digest must not imply corroboration it never measured:
    const md = buildDigest(input({ reflections: sameAgent }));
    expect(md).not.toMatch(/×\d+ agents/);
  });

  it('keeps same key at different tiers as distinct candidates', () => {
    const recs: ReflectionRecord[] = [
      record({ rule_evolution_signals: [{ signal: 's', proposed_tier: 'canonical', rationale: 'r', key: 'k' }] }),
      record({ rule_evolution_signals: [{ signal: 's', proposed_tier: 'project', rationale: 'r', key: 'k' }] }),
    ];
    const agg = aggregateSignals(recs);
    expect(agg).toHaveLength(2);
  });
});

describe('buildDigest', () => {
  it('renders all sections with expected lines and a deterministic timestamp', () => {
    const md = buildDigest(input());

    // Header + injected clock → deterministic generated-at
    expect(md).toContain('# Protocol-Health Digest — macf');
    expect(md).toContain('Generated at: 2026-06-16T12:00:00Z');
    expect(md).toContain('Repo: `groundnuty/macf`');

    // Stale issues, grouped by owner
    expect(md).toContain('## Stale issues');
    expect(md).toContain('### code-agent');
    expect(md).toContain('#439 — TOCTOU (40d open)');
    expect(md).toContain('### science-agent');
    expect(md).toContain('#224 — NPM_TOKEN rotation (51d open)');
    expect(md).toContain('### unassigned');
    expect(md).not.toContain('#600'); // fresh issue not stale

    // PR buckets
    expect(md).toContain('## PRs awaiting action');
    expect(md).toContain('### Approved, unmerged');
    expect(md).toContain('#511 — approved');
    expect(md).toContain('### Changes requested');
    expect(md).toContain('#519 — changes');

    // Aggregated reflection signals (deduped, corroboration-annotated)
    expect(md).toContain('## Aggregated reflection signals');
    expect(md).toContain('### proposed_tier: canonical');
    expect(md).toMatch(/\[key: `send-neq-receipt`\].*\(×2 agents\)/);
    expect(md).toContain('### proposed_tier: project');

    // Summary counts
    expect(md).toContain('Open issues: 4 (stale: 3)');
    expect(md).toContain('approved-unmerged: 1');
    expect(md).toContain('skipped malformed lines: 1');
    expect(md).toContain('breaches: 1 | unresolved: 3');
    expect(md).toContain('Project-tier rules present: 0');

    // Read-only / gated note is present (reporting, not proposing)
    expect(md).toContain('DR-026 G1');
    expect(md).toContain('No issues were created, commented on, closed, or merged');
  });

  it('renders empty-state placeholders when there is nothing to report', () => {
    const md = buildDigest(input({ issues: [], prs: [], reflections: [], reflectionsSkipped: 0, reflectionFiles: 0 }));
    expect(md).toContain('_No open issues older than 14 days._');
    expect(md).toContain('_No rule-evolution signals in the reflection ledgers._');
    expect(md).toContain('Open issues: 0 (stale: 0)');
  });

  it('is deterministic for a fixed clock + inputs (snapshot-stable)', () => {
    expect(buildDigest(input())).toEqual(buildDigest(input()));
  });
});
