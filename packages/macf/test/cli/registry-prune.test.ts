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

describe('formatVerdictLine', () => {
  it('renders keep for alive and remove for dead', () => {
    const alive = formatVerdictLine({ name: 'A', host: 'h', port: 1, verdict: 'alive' });
    const dead = formatVerdictLine({ name: 'B', host: 'h', port: 2, verdict: 'dead' });
    expect(alive).toMatch(/alive → keep/);
    expect(dead).toMatch(/confirmed-dead → remove/);
  });
});
