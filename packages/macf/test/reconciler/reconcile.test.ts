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
