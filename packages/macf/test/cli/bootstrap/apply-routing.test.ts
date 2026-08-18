/**
 * Tests for `apply-routing.ts` — `MACF_TRUSTED_ACTORS` create-only write,
 * DR-043 Amendment D phase 2 (groundnuty/macf#838, macf#854's routing gap),
 * corrected to the router's actually-read variable + register-before-route
 * gated by macf#922, itself corrected for the org-runner-blind cost
 * regression by macf#924. Fully offline: `checkRepoPresence`/
 * `createRepoVariable`/`checkRunnerUsableByRepo` are hand-scripted fakes, no
 * real `gh`.
 */
import { describe, it, expect } from 'vitest';
import {
  checkRunnerTokenPreflight,
  formatRunnerPollProgress,
  noRunnerRegisteredReason,
  noRunnerTokenReason,
  pollForUsableRunner,
  publishTrustedActors,
  publishTrustedActorsGated,
  runnerTokenPollExhaustedReason,
  RUNNER_TOKEN_ENV_VAR,
  RUNNER_TOKEN_FLAG,
  RUNNER_TOKEN_MISSING_CODE,
  TRUSTED_ACTORS_VAR,
} from '../../../src/cli/bootstrap/apply-routing.js';
import type { RoutingApplyDeps } from '../../../src/cli/bootstrap/apply-routing.js';
import type { RunnerUsability } from '../../../src/cli/bootstrap/observer.js';

function depsWith(overrides: Partial<RoutingApplyDeps> = {}): RoutingApplyDeps {
  return {
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    checkRunnerUsableByRepo: async () => ({ presence: 'present' }),
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
      checkRunnerUsableByRepo: async () => ({ presence: 'absent' }),
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
    const deps = depsWith({ checkRunnerUsableByRepo: async () => ({ presence: 'unknown' }) });
    const result = await publishTrustedActors('a-code-agent[bot]', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('skipped');
    expect((result['a/b'] as { reason: string }).reason).toMatch(/could not confirm whether a self-hosted runner is registered/);
  });

  it('a THROWING checkRunnerUsableByRepo resolves to "failed" (a wiring bug), not "skipped" (a legitimate absence)', async () => {
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        throw new Error('gh: rate limited');
      },
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['a/b'], deps);
    expect(result['a/b']?.status).toBe('failed');
    expect((result['a/b'] as { reason: string }).reason).toContain('rate limited');
  });

  it('registration is checked PER REPO — one repo registered and one not both get their own correct outcome', async () => {
    const deps = depsWith({
      checkRunnerUsableByRepo: async (repo) => ({ presence: repo === 'registered/x' ? 'present' : 'absent' }),
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['registered/x', 'unregistered/y'], deps);
    expect(result['registered/x']).toEqual({ status: 'created' });
    expect(result['unregistered/y']?.status).toBe('skipped');
  });

  // --- macf#924 — org-admin handover surfaces through the write-gate report ---

  it('an "excluded from the org runner group" outcome carries the handover into the skip reason', async () => {
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => ({
        presence: 'absent',
        handover: 'An org-level self-hosted runner IS registered in "groundnuty", but its runner group excludes "groundnuty/x".',
      }),
    });
    const result = await publishTrustedActors('a-code-agent[bot]', ['groundnuty/x'], deps);
    expect(result['groundnuty/x']?.status).toBe('skipped');
    const reason = (result['groundnuty/x'] as { reason: string }).reason;
    expect(reason).toMatch(/no self-hosted runner is confirmed registered/);
    expect(reason).toMatch(/its runner group excludes "groundnuty\/x"/);
  });
});

describe('noRunnerRegisteredReason', () => {
  it('names the repo + the billing consequence + the register-before-route remedy', () => {
    const reason = noRunnerRegisteredReason('groundnuty/x', { presence: 'absent' });
    expect(reason).toContain('groundnuty/x');
    expect(reason).toMatch(/billed on private repos/);
    expect(reason).toMatch(/register-before-route/);
    expect(reason).not.toMatch(/could not confirm/);
  });

  it('distinguishes the "unknown" cause from the "absent" cause — never overclaims confidence', () => {
    const reason = noRunnerRegisteredReason('groundnuty/x', { presence: 'unknown' });
    expect(reason).toMatch(/could not confirm whether a self-hosted runner is registered/);
  });

  it('macf#924 — appends the org-admin handover verbatim when present, without dropping the original wording', () => {
    const usability: RunnerUsability = {
      presence: 'absent',
      handover: 'An org admin must add "groundnuty/x" to runner group X at https://example.invalid/.',
    };
    const reason = noRunnerRegisteredReason('groundnuty/x', usability);
    expect(reason).toMatch(/no self-hosted runner is confirmed registered/);
    expect(reason).toContain('An org admin must add "groundnuty/x" to runner group X at https://example.invalid/.');
  });

  it('macf#934 — appends the capability detail verbatim when present, without dropping the original wording', () => {
    const usability: RunnerUsability = {
      presence: 'absent',
      detail: 'a runner registered for "groundnuty/x" carries the required labels but is offline (status="offline").',
    };
    const reason = noRunnerRegisteredReason('groundnuty/x', usability);
    expect(reason).toMatch(/no self-hosted runner is confirmed registered/);
    expect(reason).toContain('carries the required labels but is offline (status="offline")');
  });

  it('macf#934 — appends BOTH detail and handover, detail first, when both are present', () => {
    const usability: RunnerUsability = {
      presence: 'absent',
      detail: 'a runner registered for "groundnuty/x" is online but not carrying required label(s) "macf-vm" (carries: self-hosted).',
      handover: 'An org admin must add "groundnuty/x" at https://example.invalid/.',
    };
    const reason = noRunnerRegisteredReason('groundnuty/x', usability);
    const detailIdx = reason.indexOf('not carrying required label');
    const handoverIdx = reason.indexOf('An org admin must add');
    expect(detailIdx).toBeGreaterThan(-1);
    expect(handoverIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeLessThan(handoverIdx);
  });
});

// --- macf#929 — token = POLICY, detection = TIMING ---

describe('noRunnerTokenReason', () => {
  it('names the flag, the env var, and the gh-api registration-token command — never a token VALUE (there is none to echo)', () => {
    const reason = noRunnerTokenReason();
    expect(reason).toContain(RUNNER_TOKEN_FLAG);
    expect(reason).toContain(RUNNER_TOKEN_ENV_VAR);
    expect(reason).toContain('gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token');
  });
});

describe('runnerTokenPollExhaustedReason', () => {
  it('names the repo, the poll window (seconds), and the re-run remedy — distinct wording from noRunnerRegisteredReason', () => {
    const reason = runnerTokenPollExhaustedReason('groundnuty/x', { presence: 'absent' }, 600_000);
    expect(reason).toContain('groundnuty/x');
    expect(reason).toContain('600s poll window');
    expect(reason).toMatch(/no usable self-hosted runner became visible/);
    expect(reason).toMatch(/macf bootstrap apply/);
  });

  it('distinguishes the "unknown" cause from the "absent" cause, same as noRunnerRegisteredReason', () => {
    const reason = runnerTokenPollExhaustedReason('groundnuty/x', { presence: 'unknown' }, 60_000);
    expect(reason).toMatch(/could not confirm whether a self-hosted runner is registered/);
  });

  it('appends the macf#924 org-admin handover verbatim when present', () => {
    const usability: RunnerUsability = { presence: 'absent', handover: 'An org admin must add "groundnuty/x" at https://example.invalid/.' };
    const reason = runnerTokenPollExhaustedReason('groundnuty/x', usability, 60_000);
    expect(reason).toContain('An org admin must add "groundnuty/x" at https://example.invalid/.');
  });

  it('appends the macf#934 capability detail verbatim when present', () => {
    const usability: RunnerUsability = {
      presence: 'absent',
      detail: 'a runner registered for "groundnuty/x" carries the required labels but is offline (status="offline").',
    };
    const reason = runnerTokenPollExhaustedReason('groundnuty/x', usability, 60_000);
    expect(reason).toContain('carries the required labels but is offline (status="offline")');
  });
});

describe('publishTrustedActorsGated (macf#929)', () => {
  it('no token supplied -> refuses EVERY repo outright ("failed"), ZERO I/O — the token gate fires before any live check', async () => {
    let checkCalled = false;
    let createCalled = false;
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        checkCalled = true;
        return { presence: 'present' };
      },
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b', 'c/d'], deps, undefined);
    expect(result['a/b']?.status).toBe('failed');
    expect(result['c/d']?.status).toBe('failed');
    const reason = (result['a/b'] as { reason: string }).reason;
    expect(reason).toContain(RUNNER_TOKEN_FLAG);
    expect(reason).toContain(RUNNER_TOKEN_ENV_VAR);
    expect(reason).toContain('gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token');
    expect(checkCalled).toBe(false);
    expect(createCalled).toBe(false);
  });

  it('an empty-string token is treated the same as no token — refuses (an empty flag value is not a supplied token)', async () => {
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], depsWith(), '');
    expect(result['a/b']?.status).toBe('failed');
  });

  it('an empty repo list with no token produces an empty map — no repos to refuse (mirrors publishTrustedActors\' own empty-list case)', async () => {
    expect(await publishTrustedActorsGated('self-hosted', [], depsWith(), undefined)).toEqual({});
  });

  it('token supplied + a usable runner IS confirmed -> writes MACF_TRUSTED_ACTORS, same shape publishTrustedActors\' write path uses', async () => {
    const writes: Array<{ repo: string; name: string; value: string }> = [];
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => ({ presence: 'present' }),
      createRepoVariable: async (repo, name, value) => {
        writes.push({ repo, name, value });
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('a-code-agent[bot]', ['a/b'], deps, 'ghr-sentinel-token');
    expect(result).toEqual({ 'a/b': { status: 'created' } });
    expect(writes).toEqual([{ repo: 'a/b', name: 'MACF_TRUSTED_ACTORS', value: 'a-code-agent[bot]' }]);
  });

  it('a repo where the var is ALREADY PRESENT is left untouched even with a token supplied (create-only is unaffected by the gate)', async () => {
    let createCalled = false;
    const deps = depsWith({
      checkRepoPresence: async () => 'present',
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token');
    expect(result['a/b']).toEqual({ status: 'already-present' });
    expect(createCalled).toBe(false);
  });

  it('token supplied but the runner NEVER appears within the poll window -> NOT written; a poll-exhausted "skipped" (not "failed") is reported, and the write seam is never invoked', async () => {
    let createCalled = false;
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => ({ presence: 'absent' }),
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', { timeoutMs: 0 });
    expect(result['a/b']?.status).toBe('skipped');
    const reason = (result['a/b'] as { reason: string }).reason;
    expect(reason).toContain('a runner registration token was supplied');
    expect(reason).toMatch(/no usable self-hosted runner became visible/);
    expect(reason).toContain('MACF_TRUSTED_ACTORS was NOT written');
    expect(createCalled).toBe(false);
  });

  it('poll succeeds when the runner appears MID-WINDOW — the fake reports absent twice then present; no real wall-clock wait (pollIntervalMs 0)', async () => {
    let calls = 0;
    const writes: string[] = [];
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        calls += 1;
        return calls < 3 ? { presence: 'absent' } : { presence: 'present' };
      },
      createRepoVariable: async (repo) => {
        writes.push(repo);
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', { timeoutMs: 60_000, pollIntervalMs: 0 });
    expect(result['a/b']).toEqual({ status: 'created' });
    expect(calls).toBe(3);
    expect(writes).toEqual(['a/b']);
  });

  it('a THROWING checkRunnerUsableByRepo (with a token supplied) resolves to "failed" (a wiring bug), not "skipped" — mirrors publishTrustedActors', async () => {
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        throw new Error('gh: rate limited');
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', { timeoutMs: 0 });
    expect(result['a/b']?.status).toBe('failed');
    expect((result['a/b'] as { reason: string }).reason).toContain('rate limited');
  });

  it('one repo failing does not block the others (per-repo isolation, mirrors publishTrustedActors)', async () => {
    const deps = depsWith({
      createRepoVariable: async (repo) => {
        if (repo === 'fails/x') throw new Error('boom');
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['fails/x', 'ok/y'], deps, 'ghr-sentinel-token');
    expect(result['fails/x']?.status).toBe('failed');
    expect(result['ok/y']).toEqual({ status: 'created' });
  });

  it('the token VALUE itself never appears anywhere in the returned outcome map — reasons name the FLAG/ENV-VAR NAMES, never the token', async () => {
    const SECRET = 'ghr-super-secret-should-never-leak';
    const refused = await publishTrustedActorsGated('self-hosted', ['a/b'], depsWith(), undefined);
    expect(JSON.stringify(refused)).not.toContain(SECRET);

    const exhausted = await publishTrustedActorsGated(
      'self-hosted',
      ['a/b'],
      depsWith({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
      SECRET,
      { timeoutMs: 0 },
    );
    expect(JSON.stringify(exhausted)).not.toContain(SECRET);

    const written = await publishTrustedActorsGated('self-hosted', ['a/b'], depsWith(), SECRET);
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });
});

// --- macf#972 — a poll must be justified by an expectation, not a constant ---

describe('publishTrustedActorsGated — justCreatedRepos (macf#972)', () => {
  it('DECISIVE: repo created this run + no runner -> immediate skip, ZERO poll iterations (checkRunnerUsableByRepo called exactly once, sleepFn never invoked)', async () => {
    let checkCalls = 0;
    let sleepCalls = 0;
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        checkCalls += 1;
        return { presence: 'absent' };
      },
    });
    const result = await publishTrustedActorsGated(
      'self-hosted',
      ['a/b'],
      deps,
      'ghr-sentinel-token',
      // A real 10-minute default budget (timeoutMs left UNSET, same as
      // production) AND a sleepFn that would fail the test if ever called —
      // if the fast path fell through to the real poll, this test would
      // either hang or throw, not silently pass.
      {
        sleepFn: async (ms) => {
          sleepCalls += 1;
          throw new Error(`sleepFn must never be called on the fast path (asked to sleep ${String(ms)}ms)`);
        },
      },
      new Set(['a/b']),
    );
    expect(result['a/b']?.status).toBe('skipped');
    // Exactly ONE call — a single LIVE check still runs (see the sibling
    // "runner already usable" test below for why zero checks would be
    // wrong), but the retry-with-sleep LOOP is never entered: that's the
    // "zero poll iterations" this test decides.
    expect(checkCalls).toBe(1);
    expect(sleepCalls).toBe(0);
  });

  it('the fast-path skip reason is BYTE-IDENTICAL to what a full-window poll-exhausted reason says — same message, only the timing changes', async () => {
    const deps = depsWith({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) });
    // Neither call overrides `timeoutMs` — both use the SAME default 600s
    // budget the message names. The "polled" comparison fast-forwards via an
    // injected clock (pollIntervalMs 60s, `now`/`sleepFn` faked) so the test
    // doesn't really wait 10 real minutes to exhaust the same window the
    // fast path skips instantly.
    const fast = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', {}, new Set(['a/b']));
    let clock = 0;
    const polled = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', {
      pollIntervalMs: 60_000,
      now: () => clock,
      sleepFn: async (ms) => {
        clock += ms;
      },
    });
    expect((fast['a/b'] as { reason: string }).reason).toBe((polled['a/b'] as { reason: string }).reason);
    expect((fast['a/b'] as { reason: string }).reason).toMatch(/no usable self-hosted runner became visible/);
    expect((fast['a/b'] as { reason: string }).reason).toContain('600s poll window'); // the CONFIGURED (default) budget, not the ~0ms actually spent
  });

  it('repo created this run, but a runner IS already usable at t=0 (e.g. an org-wide runner group) -> still writes, same as today', async () => {
    let checkCalls = 0;
    const writes: string[] = [];
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        checkCalls += 1;
        return { presence: 'present' };
      },
      createRepoVariable: async (repo) => {
        writes.push(repo);
        return 'created';
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', {}, new Set(['a/b']));
    expect(result['a/b']).toEqual({ status: 'created' });
    expect(checkCalls).toBe(1);
    expect(writes).toEqual(['a/b']);
  });

  it('a repo NOT in justCreatedRepos keeps polling exactly as before, even when OTHER repos in the same call are just-created', async () => {
    let preExistingCalls = 0;
    let freshCalls = 0;
    const deps = depsWith({
      checkRunnerUsableByRepo: async (repo) => {
        if (repo === 'pre-existing/x') {
          preExistingCalls += 1;
          return preExistingCalls < 3 ? { presence: 'absent' } : { presence: 'present' };
        }
        freshCalls += 1;
        return { presence: 'absent' };
      },
    });
    const result = await publishTrustedActorsGated(
      'self-hosted',
      ['pre-existing/x', 'fresh/y'],
      deps,
      'ghr-sentinel-token',
      { timeoutMs: 60_000, pollIntervalMs: 0 },
      new Set(['fresh/y']),
    );
    expect(result['pre-existing/x']).toEqual({ status: 'created' });
    expect(preExistingCalls).toBe(3); // genuinely polled (mid-window recovery)
    expect(result['fresh/y']?.status).toBe('skipped');
    expect(freshCalls).toBe(1); // fast path — one check, no retries
  });

  it('undefined justCreatedRepos (the param omitted entirely) preserves EVERY existing caller\'s behavior — full poll, no fast path', async () => {
    let calls = 0;
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        calls += 1;
        return calls < 3 ? { presence: 'absent' } : { presence: 'present' };
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', { timeoutMs: 60_000, pollIntervalMs: 0 });
    expect(result['a/b']).toEqual({ status: 'created' });
    expect(calls).toBe(3);
  });

  it('a THROWING checkRunnerUsableByRepo on the fast path resolves to "failed" (a wiring bug), not "skipped" — mirrors the polled path', async () => {
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => {
        throw new Error('gh: rate limited');
      },
    });
    const result = await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', {}, new Set(['a/b']));
    expect(result['a/b']?.status).toBe('failed');
    expect((result['a/b'] as { reason: string }).reason).toContain('rate limited');
  });

  it('register-before-route holds on the fast path too — the create-only write seam is never invoked when no runner is usable', async () => {
    let createCalled = false;
    const deps = depsWith({
      checkRunnerUsableByRepo: async () => ({ presence: 'absent' }),
      createRepoVariable: async () => {
        createCalled = true;
        return 'created';
      },
    });
    await publishTrustedActorsGated('self-hosted', ['a/b'], deps, 'ghr-sentinel-token', {}, new Set(['a/b']));
    expect(createCalled).toBe(false);
  });
});

describe('pollForUsableRunner — progress narration (macf#972)', () => {
  it('emits onProgress once elapsed crosses progressIntervalMs, with the repo name + elapsed/total in ms', async () => {
    let clock = 0;
    const progressCalls: Array<{ repo: string; elapsedMs: number; totalMs: number }> = [];
    let checkCalls = 0;
    const usability = await pollForUsableRunner(
      'a/b',
      async () => {
        checkCalls += 1;
        return { presence: 'absent' };
      },
      {
        timeoutMs: 90_000,
        pollIntervalMs: 10_000,
        progressIntervalMs: 30_000,
        now: () => clock,
        sleepFn: async (ms) => {
          clock += ms;
        },
        onProgress: (repo, elapsedMs, totalMs) => {
          progressCalls.push({ repo, elapsedMs, totalMs });
        },
      },
    );
    expect(usability).toEqual({ presence: 'absent' }); // exhausted
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[0]).toEqual({ repo: 'a/b', elapsedMs: 30_000, totalMs: 90_000 });
    expect(checkCalls).toBeGreaterThan(1); // a genuine multi-iteration poll, not the fast path
  });

  it('a poll that resolves (or expires) within its FIRST interval never fires onProgress — matches pre-macf#972 silent behavior for a short poll', async () => {
    const progressCalls: unknown[] = [];
    await pollForUsableRunner('a/b', async () => ({ presence: 'absent' }), {
      timeoutMs: 0,
      onProgress: (repo, elapsedMs, totalMs) => {
        progressCalls.push({ repo, elapsedMs, totalMs });
      },
    });
    expect(progressCalls).toEqual([]);
  });

  it('no onProgress supplied -> no crash, identical result to today (default is silent)', async () => {
    let calls = 0;
    const usability = await pollForUsableRunner(
      'a/b',
      async () => {
        calls += 1;
        return calls < 2 ? { presence: 'absent' } : { presence: 'present' };
      },
      { timeoutMs: 60_000, pollIntervalMs: 0 },
    );
    expect(usability).toEqual({ presence: 'present' });
  });
});

describe('formatRunnerPollProgress (macf#972)', () => {
  it('names the repo + rounds elapsed/total to whole seconds + the "nothing for you to do" clause', () => {
    const line = formatRunnerPollProgress('groundnuty/x', 120_000, 600_000);
    expect(line).toContain('groundnuty/x');
    expect(line).toContain('120s/600s elapsed');
    expect(line).toContain('nothing for you to do');
  });
});

// --- macf#932 — the CLI-level pre-flight, fired BEFORE consent gate 1 ---

describe('checkRunnerTokenPreflight (macf#932)', () => {
  it('undefined (proceeds) when routing.runner is not declared at all', () => {
    expect(checkRunnerTokenPreflight(undefined, undefined)).toBeUndefined();
  });

  it('undefined (proceeds) when runs_on is declared but is NOT "self-hosted" — no write is ever a candidate, so no token is needed', () => {
    expect(checkRunnerTokenPreflight({ runner: { runs_on: 'ubuntu-latest', warm: 1 } }, undefined)).toBeUndefined();
  });

  it('undefined (proceeds) when a non-empty token IS resolved', () => {
    expect(checkRunnerTokenPreflight({ runner: { runs_on: 'self-hosted', warm: 1 } }, 'ghr-sentinel-token')).toBeUndefined();
  });

  it('refuses when self-hosted is declared and no token was resolved (undefined)', () => {
    const failure = checkRunnerTokenPreflight({ runner: { runs_on: 'self-hosted', warm: 1 } }, undefined);
    expect(failure?.code).toBe(RUNNER_TOKEN_MISSING_CODE);
    // Reuses noRunnerTokenReason() VERBATIM — same message the late gate
    // (publishTrustedActorsGated) has always shown, only fired earlier.
    expect(failure?.message).toBe(noRunnerTokenReason());
  });

  it('refuses on an empty-string token too — matches publishTrustedActorsGated\'s own empty-is-no-token rule', () => {
    const failure = checkRunnerTokenPreflight({ runner: { runs_on: 'self-hosted', warm: 1 } }, '');
    expect(failure?.code).toBe(RUNNER_TOKEN_MISSING_CODE);
    expect(failure?.message).toBe(noRunnerTokenReason());
  });

  it('the refusal message names the flag, the env var, and the gh-api command — never a token VALUE', () => {
    const failure = checkRunnerTokenPreflight({ runner: { runs_on: 'self-hosted', warm: 1 } }, undefined);
    expect(failure?.message).toContain(RUNNER_TOKEN_FLAG);
    expect(failure?.message).toContain(RUNNER_TOKEN_ENV_VAR);
    expect(failure?.message).toContain('gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token');
  });
});
