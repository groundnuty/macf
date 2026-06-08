/**
 * Unit tests for the route-receipt reconciler's pure drop-detection logic
 * (groundnuty/macf#444 Option D, piece 4). The I/O (GitHub run-log + Tempo
 * fetchers) + incident open/self-close are exercised by the workflow; this
 * pins the load-bearing join + threshold semantics.
 */
import { describe, it, expect } from 'vitest';
import { reconcile, receiptKey, type DeliveredRoute, type ProcessedReceipt } from '../../src/reconciler/reconcile.js';

const MIN = 60_000;
const NOW = 1_780_000_000_000;
const THRESHOLD = 15 * MIN;

function delivered(runId: string, agent: string, ageMin: number): DeliveredRoute {
  return { runId, agent, deliveredAtMs: NOW - ageMin * MIN };
}
function processed(runId: string, agent: string): ProcessedReceipt {
  return { runId, agent };
}
const opts = { nowMs: NOW, openThresholdMs: THRESHOLD };

describe('receiptKey', () => {
  it('joins on runId:agent', () => {
    expect(receiptKey({ runId: '42', agent: 'code-agent' })).toBe('42:code-agent');
  });
});

describe('reconcile', () => {
  it('a delivered route WITH a matching receipt is not a drop', () => {
    const r = reconcile([delivered('1', 'code-agent', 30)], [processed('1', 'code-agent')], opts);
    expect(r.drops).toHaveLength(0);
    expect(r.inFlight).toHaveLength(0);
  });

  it('a delivered route with NO receipt, older than the threshold, IS a drop', () => {
    const r = reconcile([delivered('1', 'code-agent', 30)], [], opts);
    expect(r.drops.map((d) => d.runId)).toEqual(['1']);
    expect(r.inFlight).toHaveLength(0);
  });

  it('a delivered route with no receipt but YOUNGER than the threshold is in-flight, NOT a drop (busy agent may process late)', () => {
    const r = reconcile([delivered('1', 'code-agent', 5)], [], opts); // 5 min < 15 min
    expect(r.drops).toHaveLength(0);
    expect(r.inFlight.map((d) => d.runId)).toEqual(['1']);
  });

  it('a late receipt resolves a would-be drop (self-close path): old + unmatched-then-matched ⇒ not a drop', () => {
    // Same route, now 30 min old, but the late turn_processed span has landed.
    const r = reconcile([delivered('1', 'science-agent', 30)], [processed('1', 'science-agent')], opts);
    expect(r.drops).toHaveLength(0);
  });

  it('join is agent-scoped — one run delivering to multiple agents (route-by-mention) is matched per agent', () => {
    // run 7 delivered to code-agent (processed) + science-agent (NOT processed), both old.
    const r = reconcile(
      [delivered('7', 'code-agent', 30), delivered('7', 'science-agent', 30)],
      [processed('7', 'code-agent')],
      opts,
    );
    expect(r.drops.map((d) => `${d.runId}:${d.agent}`)).toEqual(['7:science-agent']);
  });

  it('a receipt for a DIFFERENT agent does not satisfy another agent on the same run', () => {
    const r = reconcile([delivered('7', 'devops-agent', 30)], [processed('7', 'code-agent')], opts);
    expect(r.drops.map((d) => d.agent)).toEqual(['devops-agent']);
  });

  it('exactly at the threshold is still in-flight (strictly-greater is a drop)', () => {
    const atThreshold: DeliveredRoute = { runId: '1', agent: 'code-agent', deliveredAtMs: NOW - THRESHOLD };
    const r = reconcile([atThreshold], [], opts);
    expect(r.drops).toHaveLength(0);
    expect(r.inFlight).toHaveLength(1);
  });

  it('empty delivered ⇒ no drops (workflow self-closes any open incident)', () => {
    const r = reconcile([], [processed('1', 'code-agent')], opts);
    expect(r.drops).toHaveLength(0);
    expect(r.deliveredCount).toBe(0);
  });

  it('reports diagnostic counts', () => {
    const r = reconcile(
      [delivered('1', 'code-agent', 30), delivered('2', 'science-agent', 5)],
      [processed('1', 'code-agent'), processed('9', 'devops-agent')],
      opts,
    );
    expect(r.deliveredCount).toBe(2);
    expect(r.processedCount).toBe(2);
    expect(r.drops).toHaveLength(0); // run1 matched; run2 in-flight (young)
    expect(r.inFlight.map((d) => d.runId)).toEqual(['2']);
  });
});

describe('reconcile — RECONCILER_SINCE deployment-boundary cutoff (macf#444)', () => {
  const CUTOFF = NOW - 20 * MIN; // receipt mechanism went live 20 min ago

  it('a pre-cutoff route with no receipt is NOT a drop (predates the receipt mechanism)', () => {
    // delivered 30 min ago = before the 20-min cutoff → out of scope entirely
    const r = reconcile([delivered('1', 'code-agent', 30)], [], { ...opts, sinceMs: CUTOFF });
    expect(r.drops).toHaveLength(0);
    expect(r.inFlight).toHaveLength(0);
    expect(r.deliveredCount).toBe(0); // excluded from scope, not just un-dropped
  });

  it('a post-cutoff route with no receipt, older than threshold, IS still a drop', () => {
    // delivered 18 min ago = after the cutoff AND past the 15-min threshold
    const r = reconcile([delivered('2', 'code-agent', 18)], [], { ...opts, sinceMs: CUTOFF });
    expect(r.drops.map((d) => d.runId)).toEqual(['2']);
    expect(r.deliveredCount).toBe(1);
  });

  it('mixed: pre-cutoff routes are silently out of scope; only post-cutoff unmatched are judged', () => {
    const r = reconcile(
      [delivered('old', 'code-agent', 40), delivered('new', 'code-agent', 18)],
      [],
      { ...opts, sinceMs: CUTOFF },
    );
    expect(r.drops.map((d) => d.runId)).toEqual(['new']);
    expect(r.deliveredCount).toBe(1); // 'old' excluded
  });

  it('without sinceMs, ALL routes are judged (backward-compat — no cutoff)', () => {
    const r = reconcile([delivered('old', 'code-agent', 40)], [], opts);
    expect(r.drops.map((d) => d.runId)).toEqual(['old']);
    expect(r.deliveredCount).toBe(1);
  });
});

describe('reconcile — macf#479 coalesced-turn suppression (sibling-delivery-receipted)', () => {
  // openThreshold 15min, proximity 5min. A "drop" is age > 15min + unmatched.
  const opts479 = { nowMs: NOW, openThresholdMs: 15 * MIN, proximityMs: 5 * MIN };
  const sibling = (runId: string, agent: string, afterMs: number, baseAgeMin: number): DeliveredRoute =>
    ({ runId, agent, deliveredAtMs: NOW - baseAgeMin * MIN + afterMs });
  const receipt = (runId: string, agent: string): ProcessedReceipt => ({ runId, agent });

  it('SUPPRESSES a would-be drop when a receipted sibling (same agent, within ±proximity) exists', () => {
    const A = delivered('A', 'code-agent', 40); // past threshold, unreceipted
    const B = sibling('B', 'code-agent', 2 * MIN, 40); // +2min, receipted
    const r = reconcile([A, B], [receipt('B', 'code-agent')], opts479);
    expect(r.drops).toEqual([]); // A suppressed; B receipted
    expect(r.suppressed.map((s) => s.route.runId)).toEqual(['A']);
    expect(r.suppressed[0]!.siblingRunId).toBe('B');
    expect(r.suppressed[0]!.deltaMs).toBe(2 * MIN);
  });

  it('FLAGS a lone unreceipted drop (no sibling at all)', () => {
    const r = reconcile([delivered('A', 'code-agent', 40)], [], opts479);
    expect(r.drops.map((d) => d.runId)).toEqual(['A']);
    expect(r.suppressed).toEqual([]);
  });

  it('FLAGS the RC-bound case — a sibling exists but is itself UNreceipted (all tmux pings drop)', () => {
    // RC-bound: agent alive on the RC-SDK, but its routed/tmux deliveries all
    // drop → no routed receipt for ANY sibling → no benign sibling → real drop.
    const A = delivered('A', 'code-agent', 40);
    const B = sibling('B', 'code-agent', 2 * MIN, 40);
    const r = reconcile([A, B], [], opts479); // neither receipted
    expect(r.drops.map((d) => d.runId).sort()).toEqual(['A', 'B']);
    expect(r.suppressed).toEqual([]);
  });

  it('does NOT suppress when the receipted sibling is OUTSIDE the proximity window', () => {
    const A = delivered('A', 'code-agent', 40);
    const B = sibling('B', 'code-agent', 10 * MIN, 40); // +10min > 5min proximity
    const r = reconcile([A, B], [receipt('B', 'code-agent')], opts479);
    expect(r.drops.map((d) => d.runId)).toEqual(['A']);
    expect(r.suppressed).toEqual([]);
  });

  it('does NOT suppress when the receipted sibling is a DIFFERENT agent', () => {
    const A = delivered('A', 'code-agent', 40);
    const B = sibling('B', 'science-agent', 2 * MIN, 40);
    const r = reconcile([A, B], [receipt('B', 'science-agent')], opts479);
    expect(r.drops.map((d) => d.runId)).toEqual(['A']);
    expect(r.suppressed).toEqual([]);
  });

  it('proximityMs unset/0 disables suppression (backward-compat)', () => {
    const A = delivered('A', 'code-agent', 40);
    const B = sibling('B', 'code-agent', 2 * MIN, 40);
    const r = reconcile([A, B], [receipt('B', 'code-agent')], { nowMs: NOW, openThresholdMs: 15 * MIN });
    expect(r.drops.map((d) => d.runId)).toEqual(['A']); // not suppressed — gate off
    expect(r.suppressed).toEqual([]);
  });

  it('a young unmatched delivery is in-flight, never suppressed (suppression only applies past threshold)', () => {
    const A = delivered('A', 'code-agent', 5); // 5min < 15min → in-flight
    const B = sibling('B', 'code-agent', 1 * MIN, 5);
    const r = reconcile([A, B], [receipt('B', 'code-agent')], opts479);
    expect(r.inFlight.map((d) => d.runId)).toEqual(['A']);
    expect(r.drops).toEqual([]);
    expect(r.suppressed).toEqual([]);
  });

  it('live run-27131994218 fixture: the coalesced FYI drop is suppressed by its receipted sibling', () => {
    // 27131251619 (code-agent, 10:22:07Z) dropped; sibling 27131237992
    // (code-agent, ~22s later) was receipted → suppressed, not a drop.
    const base = NOW - 40 * MIN;
    const A: DeliveredRoute = { runId: '27131251619', agent: 'code-agent', deliveredAtMs: base };
    const B: DeliveredRoute = { runId: '27131237992', agent: 'code-agent', deliveredAtMs: base + 22_000 };
    const r = reconcile([A, B], [receipt('27131237992', 'code-agent')], opts479);
    expect(r.drops).toEqual([]);
    expect(r.suppressed.map((s) => s.route.runId)).toEqual(['27131251619']);
    expect(r.suppressed[0]!.siblingRunId).toBe('27131237992');
  });
});
