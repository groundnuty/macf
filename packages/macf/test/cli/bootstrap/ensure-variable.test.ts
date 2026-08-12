/**
 * Tests for `ensure-variable.ts` — the create-only "ensure a GitHub Actions
 * variable exists" primitive, DR-043 Phase 2b (groundnuty/macf#838 Amendment
 * D phase 2, macf#854's CA/routing gap). Fully offline: `checkPresence`/
 * `create` are hand-scripted fakes, no real `gh`.
 *
 * The load-bearing property under test: the create-only guarantee does NOT
 * rest on correctly guessing the duplicate-create status code
 * (`variable-write.ts`'s 409-vs-other classifier) — see this module's doc.
 * A CONFIRMED-`absent` presence whose create attempt still reports
 * `'exists'` is ALWAYS `'failed'`; only an `'unknown'` presence accepts it.
 */
import { describe, it, expect } from 'vitest';
import { ensureVariableCreated, skippedOutcomesFor } from '../../../src/cli/bootstrap/ensure-variable.js';
import type { EnsureVariableDeps } from '../../../src/cli/bootstrap/ensure-variable.js';

function depsWith(overrides: Partial<EnsureVariableDeps> = {}): EnsureVariableDeps {
  return {
    checkPresence: async () => 'absent',
    create: async () => 'created',
    ...overrides,
  };
}

describe('ensureVariableCreated', () => {
  it('present -> already-present, create is NEVER attempted', async () => {
    let createCalled = false;
    const outcome = await ensureVariableCreated(
      depsWith({ checkPresence: async () => 'present', create: async () => { createCalled = true; return 'created'; } }),
      'x',
    );
    expect(outcome).toEqual({ status: 'already-present' });
    expect(createCalled).toBe(false);
  });

  it('absent + create succeeds -> created', async () => {
    const outcome = await ensureVariableCreated(depsWith({ checkPresence: async () => 'absent', create: async () => 'created' }), 'x');
    expect(outcome).toEqual({ status: 'created' });
  });

  it('absent + create reports "exists" -> FAILED (a race or stale read) — NEVER silently accepted', async () => {
    const outcome = await ensureVariableCreated(depsWith({ checkPresence: async () => 'absent', create: async () => 'exists' }), 'my-var');
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('my-var');
      expect(outcome.reason).toMatch(/race|stale/);
    }
  });

  it('unknown + create reports "exists" -> already-present (the ONLY softening branch — the create attempt IS the authoritative signal here)', async () => {
    const outcome = await ensureVariableCreated(depsWith({ checkPresence: async () => 'unknown', create: async () => 'exists' }), 'x');
    expect(outcome).toEqual({ status: 'already-present' });
  });

  it('unknown + create succeeds -> created', async () => {
    const outcome = await ensureVariableCreated(depsWith({ checkPresence: async () => 'unknown', create: async () => 'created' }), 'x');
    expect(outcome).toEqual({ status: 'created' });
  });

  it('checkPresence throws -> failed, never propagates', async () => {
    const outcome = await ensureVariableCreated(
      depsWith({ checkPresence: async () => { throw new Error('network down'); } }),
      'my-var',
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('my-var');
      expect(outcome.reason).toContain('network down');
    }
  });

  it('create throws (a real failure, not "exists") -> failed, never propagates', async () => {
    const outcome = await ensureVariableCreated(
      depsWith({ create: async () => { throw new Error('401 unauthorized'); } }),
      'my-var',
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('401 unauthorized');
    }
  });

  it('NEVER throws — every path above resolves, none rejects', async () => {
    await expect(
      ensureVariableCreated(depsWith({ checkPresence: async () => { throw new Error('x'); } }), 'x'),
    ).resolves.toBeDefined();
  });
});

describe('skippedOutcomesFor (pure)', () => {
  it('produces one skipped entry per repo, all sharing the same reason', () => {
    const out = skippedOutcomesFor(['a/b', 'c/d'], 'no cert resolved');
    expect(out).toEqual({
      'a/b': { status: 'skipped', reason: 'no cert resolved' },
      'c/d': { status: 'skipped', reason: 'no cert resolved' },
    });
  });

  it('produces an empty map for an empty repo list', () => {
    expect(skippedOutcomesFor([], 'x')).toEqual({});
  });
});
