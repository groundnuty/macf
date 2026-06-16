/**
 * Tests for the pure candidate pipeline (macf#503, DR-026 G1).
 *
 * Covers the two CODE-side load-bearing gates + the tier-router + malformed
 * resilience:
 *   GATE 1 — N>1 = distinct AGENTS, not occurrences (the whole safety model).
 *   GATE 3 — no-auto-drop on invariant-touch (surface + HIGH-RISK, never drop).
 *   Tier-router — universal/canonical → NEEDS-CONFIRMATION (no auto-route).
 *
 * (GATE 2 — dry-run-by-default — is exercised in run.test.ts against the
 * writer seam.)
 */
import { describe, it, expect } from 'vitest';
import {
  buildCandidates,
  routeForTier,
  DEFAULT_MIN_AGENTS,
} from '../../../src/cli/propose/candidates.js';
import { parseInvariants } from '../../../src/cli/propose/invariants.js';
import type { ReflectionRecord, RuleEvolutionSignal } from '@groundnuty/macf-core';

// A small, real-shaped slice of protected-invariants.md so the subordination
// check has something to match against (avoids depending on the on-disk file).
const INVARIANTS_MD = `# Protected invariants

## The invariants

1. **Reporter-owns-closure accountability.** The agent who opened an issue owns its closure.
2. **Identity ↔ attribution.** Every agent action is attributed to that agent's bot.
3. **No-self-merge / LGTM gate.** No PR merges without a non-author APPROVED review.
8. **Auditor never-acts.** The auditor proposes only; it cannot merge or close.

## Amending this set

1. A PR editing this file.
`;

const INVARIANTS = parseInvariants(INVARIANTS_MD);

function rec(
  agentName: string,
  signals: readonly RuleEvolutionSignal[],
  overrides: Partial<ReflectionRecord> = {},
): ReflectionRecord {
  return {
    schema_version: '1.0',
    kind: 'macf.reflection',
    agent: { name: agentName, role: agentName, login: `${agentName}[bot]` },
    project: 'macf',
    session_id: `s-${Math.random()}`,
    timestamp: '2026-06-16T04:00:00Z',
    trigger: 'pre-compact',
    compaction_type: 'auto',
    observed_patterns: [],
    breaches: [],
    rule_evolution_signals: signals,
    unresolved: [],
    synthesis: '',
    ...overrides,
  };
}

function sig(
  signal: string,
  proposed_tier: string,
  key?: string,
  rationale = 'because',
): RuleEvolutionSignal {
  return key ? { signal, proposed_tier, rationale, key } : { signal, proposed_tier, rationale };
}

describe('GATE 1 — N>1 means distinct AGENTS, not occurrences', () => {
  it('HOLDS a signal repeated 5× by ONE agent (N=1, not N=5)', () => {
    // Same agent, same key, five separate reflection records.
    const records = Array.from({ length: 5 }, (_, i) =>
      rec('code-agent', [sig('promote single-agent insight', 'project', 'solo-key')], {
        session_id: `s${i}`,
      }),
    );
    const out = buildCandidates(records, INVARIANTS, 2);

    expect(out.promoted).toHaveLength(0);
    expect(out.held).toHaveLength(1);
    const held = out.held[0]!;
    expect(held.handle).toBe('solo-key');
    expect(held.distinctAgents).toBe(1); // one distinct agent...
    expect(held.occurrences).toBe(5); // ...despite 5 occurrences
    expect(held.reason).toMatch(/N=1 distinct agent/);
  });

  it('PROMOTES a signal seen by 2 distinct agents (N=2 >= threshold 2)', () => {
    const records = [
      rec('code-agent', [sig('promote corroborated insight', 'project', 'corr-key')]),
      rec('science-agent', [sig('promote corroborated insight', 'project', 'corr-key')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);

    expect(out.held).toHaveLength(0);
    expect(out.promoted).toHaveLength(1);
    const c = out.promoted[0]!;
    expect(c.distinctAgents).toBe(2);
    expect(c.corroboratingAgents).toEqual(['code-agent', 'science-agent']);
    expect(c.occurrences).toBe(2);
  });

  it('does NOT double-count the same agent appearing twice', () => {
    const records = [
      rec('code-agent', [sig('dup-agent', 'project', 'k')]),
      rec('code-agent', [sig('dup-agent', 'project', 'k')]), // same agent again
      rec('science-agent', [sig('dup-agent', 'project', 'k')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0]!.distinctAgents).toBe(2); // code-agent + science-agent
    expect(out.promoted[0]!.occurrences).toBe(3); // three records
  });

  it('--min-agents 3 raises the bar: 2 distinct agents → HELD', () => {
    const records = [
      rec('code-agent', [sig('two-agent insight', 'project', 'two-key')]),
      rec('science-agent', [sig('two-agent insight', 'project', 'two-key')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 3);
    expect(out.minAgents).toBe(3);
    expect(out.promoted).toHaveLength(0);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]!.distinctAgents).toBe(2);
  });

  it('defaults the threshold to DEFAULT_MIN_AGENTS (2)', () => {
    const out = buildCandidates([rec('a', [sig('x', 'project', 'k')])], INVARIANTS);
    expect(out.minAgents).toBe(DEFAULT_MIN_AGENTS);
  });

  it('groups signals without a key by their text', () => {
    const records = [
      rec('code-agent', [sig('keyless signal text', 'project')]),
      rec('science-agent', [sig('keyless signal text', 'project')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0]!.hasKey).toBe(false);
    expect(out.promoted[0]!.handle).toBe('keyless signal text');
  });
});

describe('GATE 3 — no-auto-drop on invariant-touch', () => {
  it('SURFACES a touched invariant + flags HIGH-RISK on a relaxation, never drops', () => {
    const records = [
      rec('code-agent', [
        sig(
          'Allow a PR to self-merge without a non-author approved review',
          'project',
          'relax-lgtm',
          'reviews slow us down, relax the LGTM gate',
        ),
      ]),
      rec('science-agent', [
        sig(
          'Allow a PR to self-merge without a non-author approved review',
          'project',
          'relax-lgtm',
          'drop the approval requirement',
        ),
      ]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);

    // It is PRESENT (promoted), not dropped.
    expect(out.promoted).toHaveLength(1);
    const c = out.promoted[0]!;
    // It TOUCHES the LGTM-gate invariant (#3).
    expect(c.invariantTouches.some((t) => t.index === 3)).toBe(true);
    // It reads as a relaxation → HIGH-RISK.
    expect(c.highRisk).toBe(true);
  });

  it('a non-relaxation touch is surfaced but NOT HIGH-RISK', () => {
    const records = [
      rec('code-agent', [
        sig('Add a reminder to refresh the bot token before each gh call', 'project', 'tok', 'attribution hygiene'),
      ]),
      rec('science-agent', [
        sig('Add a reminder to refresh the bot token before each gh call', 'project', 'tok', 'attribution hygiene'),
      ]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    const c = out.promoted[0]!;
    // Touches the identity/attribution invariant (#2) via "token"/"attribution".
    expect(c.invariantTouches.some((t) => t.index === 2)).toBe(true);
    expect(c.highRisk).toBe(false); // additive, not a relaxation
  });

  it('a candidate touching NO invariant is promoted with empty touch set', () => {
    const records = [
      rec('code-agent', [sig('use ripgrep over find for speed', 'project', 'rg')]),
      rec('science-agent', [sig('use ripgrep over find for speed', 'project', 'rg')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    const c = out.promoted[0]!;
    expect(c.invariantTouches).toHaveLength(0);
    expect(c.highRisk).toBe(false);
  });
});

describe('tier-router', () => {
  it('routes universal + canonical to needs-confirmation (never auto-route)', () => {
    expect(routeForTier('universal')).toBe('needs-confirmation');
    expect(routeForTier('canonical')).toBe('needs-confirmation');
    expect(routeForTier('UNIVERSAL')).toBe('needs-confirmation');
  });

  it('routes project to a project-rule draft', () => {
    expect(routeForTier('project')).toBe('project-draft');
  });

  it('routes an unrecognised tier hint to plain review', () => {
    expect(routeForTier('whatever')).toBe('review');
  });

  it('marks a promoted universal candidate NEEDS-CONFIRMATION', () => {
    const records = [
      rec('code-agent', [sig('promote to universal', 'universal', 'u-key')]),
      rec('science-agent', [sig('promote to universal', 'universal', 'u-key')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    expect(out.promoted[0]!.route).toBe('needs-confirmation');
  });

  it('keeps the same handle at two tiers as two distinct candidates', () => {
    const records = [
      rec('code-agent', [sig('s', 'canonical', 'k')]),
      rec('science-agent', [sig('s', 'canonical', 'k')]),
      rec('code-agent', [sig('s', 'project', 'k')]),
      rec('science-agent', [sig('s', 'project', 'k')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    expect(out.promoted).toHaveLength(2);
    const tiers = out.promoted.map((c) => c.proposedTier).sort();
    expect(tiers).toEqual(['canonical', 'project']);
  });
});

describe('aggregation hygiene', () => {
  it('dedups distinct rationales while preserving them', () => {
    const records = [
      rec('code-agent', [sig('s', 'project', 'k', 'reason A')]),
      rec('code-agent', [sig('s', 'project', 'k', 'reason A')]), // dup rationale
      rec('science-agent', [sig('s', 'project', 'k', 'reason B')]),
    ];
    const out = buildCandidates(records, INVARIANTS, 2);
    expect(out.promoted[0]!.rationales.sort()).toEqual(['reason A', 'reason B']);
  });

  it('handles records with empty rule_evolution_signals (mechanical-only)', () => {
    const out = buildCandidates([rec('code-agent', [])], INVARIANTS, 2);
    expect(out.promoted).toHaveLength(0);
    expect(out.held).toHaveLength(0);
  });
});
