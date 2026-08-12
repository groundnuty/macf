/**
 * Tests for `apply-routing.ts` — `MACF_ROUTING_RUNS_ON` create-only write,
 * DR-043 Amendment D phase 2 (groundnuty/macf#838, macf#854's routing gap).
 * Fully offline: `checkRepoPresence`/`createRepoVariable` are hand-scripted
 * fakes, no real `gh`.
 */
import { describe, it, expect } from 'vitest';
import { publishRoutingRunsOn, ROUTING_RUNS_ON_VAR } from '../../../src/cli/bootstrap/apply-routing.js';
import type { RoutingApplyDeps } from '../../../src/cli/bootstrap/apply-routing.js';

function depsWith(overrides: Partial<RoutingApplyDeps> = {}): RoutingApplyDeps {
  return {
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    ...overrides,
  };
}

describe('ROUTING_RUNS_ON_VAR', () => {
  it('is the exact var name the v3 router / observer.ts read', () => {
    expect(ROUTING_RUNS_ON_VAR).toBe('MACF_ROUTING_RUNS_ON');
  });
});

describe('publishRoutingRunsOn', () => {
  it('writes the SAME value to every repo, using the correct var name', async () => {
    const writes: Array<{ repo: string; name: string; value: string }> = [];
    const deps = depsWith({
      createRepoVariable: async (repo, name, value) => {
        writes.push({ repo, name, value });
        return 'created';
      },
    });
    const result = await publishRoutingRunsOn('self-hosted', ['a/b', 'c/d'], deps);
    expect(result).toEqual({ 'a/b': { status: 'created' }, 'c/d': { status: 'created' } });
    expect(writes).toEqual([
      { repo: 'a/b', name: 'MACF_ROUTING_RUNS_ON', value: 'self-hosted' },
      { repo: 'c/d', name: 'MACF_ROUTING_RUNS_ON', value: 'self-hosted' },
    ]);
  });

  it('a repo where the var is ALREADY PRESENT is left untouched — create is never attempted (create-only)', async () => {
    let createCalled = false;
    const deps = depsWith({
      checkRepoPresence: async () => 'present',
      createRepoVariable: async () => { createCalled = true; return 'created'; },
    });
    const result = await publishRoutingRunsOn('self-hosted', ['a/b'], deps);
    expect(result['a/b']).toEqual({ status: 'already-present' });
    expect(createCalled).toBe(false);
  });

  it('a race (absent-then-exists) is FAILED, never silently accepted as success', async () => {
    const deps = depsWith({ checkRepoPresence: async () => 'absent', createRepoVariable: async () => 'exists' });
    const result = await publishRoutingRunsOn('self-hosted', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('failed');
  });

  it('one repo failing does not block the others', async () => {
    const deps = depsWith({
      createRepoVariable: async (repo) => {
        if (repo === 'fails/x') throw new Error('boom');
        return 'created';
      },
    });
    const result = await publishRoutingRunsOn('self-hosted', ['fails/x', 'ok/y'], deps);
    expect(result['fails/x']?.status).toBe('failed');
    expect(result['ok/y']).toEqual({ status: 'created' });
  });

  it('an empty repo list produces an empty map (routing.runner declared but no confirmed repo exists yet)', async () => {
    expect(await publishRoutingRunsOn('self-hosted', [], depsWith())).toEqual({});
  });
});
