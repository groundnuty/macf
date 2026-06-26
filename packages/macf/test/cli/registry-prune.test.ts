/**
 * Tests for `macf registry prune` liveness classification (macf#556).
 *
 * Offline + deterministic: `classifyEntries` takes an injectable probe, so
 * tests simulate refused/timeout/alive responses without real mTLS. The
 * load-bearing invariant is "never remove on a single flaky read" — a peer
 * that fails once then answers on retry must be classified `alive`.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyEntries,
  formatVerdictLine,
  type ProbeFn,
} from '../../src/cli/commands/registry-prune.js';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';

function agentInfo(host: string, port: number): AgentInfo {
  return { host, port, type: 'permanent', instance_id: 'iid', started: '2026-01-01T00:00:00Z' };
}

// DR-031 (groundnuty/macf#568) staleness fixtures. Deterministic clock + TTL so
// `isStaleEntry` is exercised offline — no real time, no fake timers.
const NOW = Date.parse('2026-06-26T12:00:00Z');
const TTL_MS = 15 * 60 * 1000; // DEFAULT_REGISTRY_TTL_MS (15 min)
const STALE_HB = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h old → past TTL → stale
const FRESH_HB = new Date(NOW - 60 * 1000).toISOString(); // 1min old → within TTL → fresh

/** AgentInfo with an optional `last_heartbeat` (omitted entirely when undefined). */
function agentInfoHb(host: string, port: number, lastHeartbeat?: string): AgentInfo {
  return {
    host,
    port,
    type: 'permanent',
    instance_id: 'iid',
    started: '2026-01-01T00:00:00Z',
    ...(lastHeartbeat !== undefined ? { last_heartbeat: lastHeartbeat } : {}),
  };
}

function health(agent: string): HealthResponse {
  return {
    agent,
    status: 'online',
    type: 'permanent',
    uptime_seconds: 10,
    current_issue: null,
    version: '0.2.37',
    last_notification: null,
  };
}

const peers = [
  { name: 'CODE_AGENT', info: agentInfo('127.0.0.1', 4001) },
  { name: 'DEAD_AGENT', info: agentInfo('127.0.0.1', 4002) },
];

describe('classifyEntries', () => {
  it('marks a responding entry alive (→ keep)', async () => {
    const probe: ProbeFn = async () => health('x');
    const results = await classifyEntries(peers, probe, { retries: 1, delayMs: 0 });
    expect(results.every((r) => r.verdict === 'alive')).toBe(true);
  });

  it('marks an always-failing entry dead only after the retry is exhausted', async () => {
    let calls = 0;
    const probe: ProbeFn = async () => {
      calls++;
      return null;
    };
    const results = await classifyEntries([peers[1]!], probe, { retries: 1, delayMs: 0 });
    expect(results[0]!.verdict).toBe('dead');
    expect(calls).toBe(2); // initial attempt + 1 retry — never a single read
  });

  it('NEVER removes on a single flaky read (fail-then-succeed → alive)', async () => {
    let calls = 0;
    const probe: ProbeFn = async () => {
      calls++;
      return calls === 1 ? null : health('flaky');
    };
    const results = await classifyEntries([peers[0]!], probe, { retries: 1, delayMs: 0 });
    expect(results[0]!.verdict).toBe('alive');
    expect(calls).toBe(2);
  });

  it('classifies a mixed set per-entry (alive kept, dead flagged)', async () => {
    const probe: ProbeFn = async (_host, port) => (port === 4001 ? health('live') : null);
    const results = await classifyEntries(peers, probe, { retries: 1, delayMs: 0 });
    const byName = Object.fromEntries(results.map((r) => [r.name, r.verdict]));
    expect(byName['CODE_AGENT']).toBe('alive');
    expect(byName['DEAD_AGENT']).toBe('dead');
  });

  it('respects a higher retry count (alive on the last allowed attempt)', async () => {
    let calls = 0;
    const probe: ProbeFn = async () => {
      calls++;
      return calls < 3 ? null : health('late');
    };
    const results = await classifyEntries([peers[0]!], probe, { retries: 2, delayMs: 0 });
    expect(results[0]!.verdict).toBe('alive');
    expect(calls).toBe(3);
  });
});

describe('classifyEntries — DR-031 heartbeat staleness (groundnuty/macf#568)', () => {
  const opts = { retries: 1, delayMs: 0, ttlMs: TTL_MS, now: NOW };
  const dead: ProbeFn = async () => null; // all probes fail
  const live: ProbeFn = async () => health('x'); // probe answers

  it('PRUNES a stale + unreachable entry (stale heartbeat reinforces dead)', async () => {
    const peers = [{ name: 'STALE_DEAD', info: agentInfoHb('127.0.0.1', 4101, STALE_HB) }];
    const results = await classifyEntries(peers, dead, opts);
    expect(results[0]!.verdict).toBe('dead');
    expect(results[0]!.reason).toBe('stale-heartbeat');
  });

  it('KEEPS a stale entry that still answers /health (a live probe ALWAYS wins)', async () => {
    const peers = [{ name: 'STALE_BUT_LIVE', info: agentInfoHb('127.0.0.1', 4102, STALE_HB) }];
    const results = await classifyEntries(peers, live, opts);
    expect(results[0]!.verdict).toBe('alive');
    expect(results[0]!.reason).toBe('responding');
  });

  it('KEEPS a fresh + unreachable entry (recent heartbeat guards a transient probe blip)', async () => {
    const peers = [{ name: 'FRESH_UNREACHABLE', info: agentInfoHb('127.0.0.1', 4103, FRESH_HB) }];
    const results = await classifyEntries(peers, dead, opts);
    expect(results[0]!.verdict).toBe('alive');
    expect(results[0]!.reason).toBe('recent-heartbeat');
  });

  it('PRUNES an unreachable entry with NO heartbeat data (legacy verdict preserved)', async () => {
    const peers = [{ name: 'NO_HB_DEAD', info: agentInfoHb('127.0.0.1', 4104) }];
    const results = await classifyEntries(peers, dead, opts);
    expect(results[0]!.verdict).toBe('dead');
    expect(results[0]!.reason).toBe('unreachable');
  });

  it('still never prunes on a single flaky read even with a stale heartbeat', async () => {
    let calls = 0;
    const flaky: ProbeFn = async () => {
      calls++;
      return calls === 1 ? null : health('flaky'); // fail once, then answer
    };
    const peers = [{ name: 'FLAKY_STALE', info: agentInfoHb('127.0.0.1', 4105, STALE_HB) }];
    const results = await classifyEntries(peers, flaky, opts);
    expect(results[0]!.verdict).toBe('alive'); // retry answered → live probe wins over stale
    expect(results[0]!.reason).toBe('responding');
    expect(calls).toBe(2);
  });
});

describe('formatVerdictLine', () => {
  it('renders keep for alive and remove for dead', () => {
    const alive = formatVerdictLine({ name: 'A', host: 'h', port: 1, verdict: 'alive', reason: 'responding' });
    const dead = formatVerdictLine({ name: 'B', host: 'h', port: 2, verdict: 'dead', reason: 'unreachable' });
    expect(alive).toMatch(/alive → keep/);
    expect(dead).toMatch(/confirmed-dead → remove/);
  });

  it('surfaces the stale-heartbeat reason on a pruned entry (DR-031)', () => {
    const stale = formatVerdictLine({ name: 'C', host: 'h', port: 3, verdict: 'dead', reason: 'stale-heartbeat' });
    expect(stale).toMatch(/heartbeat stale/);
    expect(stale).toMatch(/remove/);
  });

  it('surfaces the recent-heartbeat reason on a kept-but-unreachable entry', () => {
    const fresh = formatVerdictLine({ name: 'D', host: 'h', port: 4, verdict: 'alive', reason: 'recent-heartbeat' });
    expect(fresh).toMatch(/heartbeat fresh/);
    expect(fresh).toMatch(/keep/);
  });
});
