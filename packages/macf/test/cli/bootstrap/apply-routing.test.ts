/**
 * Tests for `apply-routing.ts` — `MACF_TRUSTED_ACTORS` create-only write,
 * DR-043 Amendment D phase 2 (groundnuty/macf#838, macf#854's routing gap),
 * corrected to the router's actually-read variable + register-before-route
 * gated by macf#922. Fully offline: `checkRepoPresence`/`createRepoVariable`/
 * `checkRunnerRegistered` are hand-scripted fakes, no real `gh`.
 */
import { describe, it, expect } from 'vitest';
import { noRunnerRegisteredReason, publishTrustedActors, TRUSTED_ACTORS_VAR } from '../../../src/cli/bootstrap/apply-routing.js';
import type { RoutingApplyDeps } from '../../../src/cli/bootstrap/apply-routing.js';

function depsWith(overrides: Partial<RoutingApplyDeps> = {}): RoutingApplyDeps {
  return {
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    checkRunnerRegistered: async () => 'present',
    ...overrides,
  };
}

describe('TRUSTED_ACTORS_VAR', () => {
  it('is the exact var name the v3 router pick-runner job / observer.ts read', () => {
    expect(TRUSTED_ACTORS_VAR).toBe('MACF_TRUSTED_ACTORS');
  });
});

describe('publishTrustedActors', () => {
  it('writes the SAME value to every repo, using the correct var name — only once a runner is confirmed registered', async () => {
    const writes: Array<{ repo: string; name: string; value: string }> = [];
    const deps = depsWith({
      createRepoVariable: async (repo, name, value) => {
        writes.push({ repo, name, value });
        return 'created';
      },
    });
    const result = await publishTrustedActors('a-code-agent[bot] a-science-agent[bot]', ['a/b', 'c/d'], deps);
    expect(result).toEqual({ 'a/b': { status: 'created' }, 'c/d': { status: 'created' } });
    expect(writes).toEqual([
      { repo: 'a/b', name: 'MACF_TRUSTED_ACTORS', value: 'a-code-agent[bot] a-science-agent[bot]' },
      { repo: 'c/d', name: 'MACF_TRUSTED_ACTORS', value: 'a-code-agent[bot] a-science-agent[bot]' },
    ]);
  });

  it('a repo where the var is ALREADY PRESENT is left untouched — create is never attempted (create-only)', async () => {
    let createCalled = false;
    const deps = depsWith({
      checkRepoPresence: async () => 'present',
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    const result = await publishTrustedActors('self-hosted', ['a/b'], deps);
    expect(result['a/b']).toEqual({ status: 'already-present' });
    expect(createCalled).toBe(false);
  });

  it('a race (absent-then-exists) is FAILED, never silently accepted as success', async () => {
    const deps = depsWith({ checkRepoPresence: async () => 'absent', createRepoVariable: async () => 'exists' });
    const result = await publishTrustedActors('self-hosted', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('failed');
  });

  it('one repo failing does not block the others', async () => {
    const deps = depsWith({
      createRepoVariable: async (repo) => {
        if (repo === 'fails/x') throw new Error('boom');
        return 'created';
      },
    });
    const result = await publishTrustedActors('self-hosted', ['fails/x', 'ok/y'], deps);
    expect(result['fails/x']?.status).toBe('failed');
    expect(result['ok/y']).toEqual({ status: 'created' });
  });

  it('an empty repo list produces an empty map (routing.runner declared but no confirmed repo exists yet)', async () => {
    expect(await publishTrustedActors('self-hosted', [], depsWith())).toEqual({});
  });

  // --- macf#922 requirement 3 — register-before-route gate ---

  it('no runner registered ("absent") -> the var is NOT written; the gap is reported via a "skipped" outcome, never silent', async () => {
    let checkPresenceCalled = false;
    let createCalled = false;
    const deps = depsWith({
      checkRunnerRegistered: async () => 'absent',
      checkRepoPresence: async () => {
        checkPresenceCalled = true;
        return 'absent';
      },
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('skipped');
    expect((result['a/b'] as { reason: string }).reason).toMatch(/no self-hosted runner is confirmed registered/);
    expect((result['a/b'] as { reason: string }).reason).toContain('a/b');
    // The write path was never even probed — the gate short-circuits before
    // the create-only presence-check, not just before the create call.
    expect(checkPresenceCalled).toBe(false);
    expect(createCalled).toBe(false);
  });

  it('runner registration UNKNOWN (read failed) -> ALSO refuses the write — honest-unknown, never treated as present', async () => {
    const deps = depsWith({ checkRunnerRegistered: async () => 'unknown' });
    const result = await publishTrustedActors('a-code-agent[bot]', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('skipped');
    expect((result['a/b'] as { reason: string }).reason).toMatch(/could not confirm whether a self-hosted runner is registered/);
  });

  it('a THROWING checkRunnerRegistered resolves to "failed" (a wiring bug), not "skipped" (a legitimate absence)', async () => {
    const deps = depsWith({
      checkRunnerRegistered: async () => {
        throw new Error('gh: rate limited');
      },
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('failed');
    expect((result['a/b'] as { reason: string }).reason).toContain('rate limited');
  });

  it('registration is checked PER REPO — one repo registered and one not both get their own correct outcome', async () => {
    const deps = depsWith({
      checkRunnerRegistered: async (repo) => (repo === 'registered/x' ? 'present' : 'absent'),
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['registered/x', 'unregistered/y'], deps);
    expect(result['registered/x']).toEqual({ status: 'created' });
    expect(result['unregistered/y']?.status).toBe('skipped');
  });
});

describe('noRunnerRegisteredReason', () => {
  it('names the repo + the billing consequence + the register-before-route remedy', () => {
    const reason = noRunnerRegisteredReason('groundnuty/x', 'absent');
    expect(reason).toContain('groundnuty/x');
    expect(reason).toMatch(/billed on private repos/);
    expect(reason).toMatch(/register-before-route/);
    expect(reason).not.toMatch(/could not confirm/);
  });

  it('distinguishes the "unknown" cause from the "absent" cause — never overclaims confidence', () => {
    const reason = noRunnerRegisteredReason('groundnuty/x', 'unknown');
    expect(reason).toMatch(/could not confirm whether a self-hosted runner is registered/);
  });
});
