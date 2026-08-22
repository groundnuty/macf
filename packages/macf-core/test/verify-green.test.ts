/**
 * Tests for `verifyGreen` (DR-037 Decision 5) — the pure post-restart
 * health-and-version gate. Driven with a fake probe sequence + a VIRTUAL clock
 * (`sleep` advances it), so the timeout + poll behaviour is deterministic and no
 * test waits on real time.
 */
import { describe, it, expect } from 'vitest';
import { verifyGreen, type VerifyGreenDeps } from '../src/verify-green.js';
import type { HealthResponse } from '../src/types.js';

/** Minimal valid `/health` body carrying a version (all `verifyGreen` reads). */
function mkHealth(version: string): HealthResponse {
  return {
    agent: 'a',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 1,
    current_issue: null,
    version,
    last_notification: null,
  };
}

/** Same as `mkHealth`, plus `instance_id` (follow-up to macf#899 — DR-037 Decision 5). */
function mkHealthWithInstance(version: string, instanceId: string): HealthResponse {
  return { ...mkHealth(version), instance_id: instanceId };
}

/**
 * Build deps with a queued probe sequence + a virtual clock. Each `probe()`
 * shifts the next value off `sequence` (repeating the LAST value once drained so
 * a steady state — always-old / always-null — is easy to express). `sleep`
 * advances the clock by the slept interval; `now` reads it.
 */
function makeDeps(sequence: readonly (HealthResponse | null)[]): {
  deps: VerifyGreenDeps;
  probeCalls: () => number;
} {
  const queue = [...sequence];
  let calls = 0;
  let clock = 0;
  const deps: VerifyGreenDeps = {
    probe: async () => {
      calls += 1;
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? null);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, probeCalls: () => calls };
}

describe('verifyGreen', () => {
  it('returns ok when the first probe reports the target version', async () => {
    const { deps, probeCalls } = makeDeps([mkHealth('0.2.41')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 10_000, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: true, version: '0.2.41' });
    expect(probeCalls()).toBe(1); // no sleep/poll needed
  });

  it('goes green after endpoint churn (null probes then the target)', async () => {
    // restart-self relaunches on a NEW port → the re-resolving probe returns null
    // until the fresh endpoint is advertised, then the target version.
    const { deps, probeCalls } = makeDeps([null, null, mkHealth('0.2.41')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 10_000, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: true, version: '0.2.41' });
    expect(probeCalls()).toBe(3);
  });

  it('normalizes the version via compareSemver (leading v matches)', async () => {
    const { deps } = makeDeps([mkHealth('v0.2.41')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 1000, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: true, version: 'v0.2.41' });
  });

  it('times out as wrong-version when reachable but never at target', async () => {
    const { deps, probeCalls } = makeDeps([mkHealth('0.2.40')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 100, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: false, reason: 'wrong-version', lastVersion: '0.2.40' });
    // start(0) → probe → now0<100 sleep→50 → probe → now50<100 sleep→100 → probe → now100>=100 stop.
    expect(probeCalls()).toBe(3);
  });

  it('times out as unreachable when every probe is null', async () => {
    const { deps } = makeDeps([null]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 100, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: false, reason: 'unreachable', lastVersion: null });
  });

  it('guarantees at least one probe even with a zero timeout', async () => {
    const green = makeDeps([mkHealth('0.2.41')]);
    expect(
      await verifyGreen(
        { agent: 'x', targetVersion: '0.2.41', timeoutMs: 0, intervalMs: 50 },
        green.deps,
      ),
    ).toEqual({ ok: true, version: '0.2.41' });
    expect(green.probeCalls()).toBe(1);

    const stale = makeDeps([mkHealth('0.2.40')]);
    expect(
      await verifyGreen(
        { agent: 'x', targetVersion: '0.2.41', timeoutMs: 0, intervalMs: 50 },
        stale.deps,
      ),
    ).toEqual({ ok: false, reason: 'wrong-version', lastVersion: '0.2.40' });
    expect(stale.probeCalls()).toBe(1);
  });

  it('classifies a reachable body with no version as wrong-version, not unreachable', async () => {
    const noVersion = { ...mkHealth('0.2.41'), version: '' } as HealthResponse;
    // empty version → compareSemver treats as 0.0.0 ≠ target; body IS reachable.
    const { deps } = makeDeps([noVersion]);
    const r = await verifyGreen(
      { agent: 'x', targetVersion: '0.2.41', timeoutMs: 0, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: false, reason: 'wrong-version', lastVersion: '' });
  });

  // --- lastInstanceId (follow-up to macf#899) -------------------------------

  it('carries the LAST reachable instance_id through on a wrong-version failure', async () => {
    const { deps } = makeDeps([mkHealthWithInstance('0.2.40', 'inst-A')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 100, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({
      ok: false,
      reason: 'wrong-version',
      lastVersion: '0.2.40',
      lastInstanceId: 'inst-A',
    });
  });

  it('DECISIVE: lastInstanceId is CLEARED (not latched) once a later probe goes unreachable — an old process answering once then dying must NOT read as "still there"', async () => {
    // The advisor-caught inversion this pins: old process answers probe 1
    // (about to be killed), then goes silent — a FRESH process could have
    // started and crash-looped before ever answering /health, which is a
    // genuine bad release, not "the old process is still around." If
    // `lastInstanceId` latched the way `lastVersion` deliberately does, a
    // caller comparing it against the pre-restart id would wrongly conclude
    // "same process, not-yet-serving" for what is actually a crash-on-start
    // release — the exact silent-fallback this issue exists to prevent.
    const { deps, probeCalls } = makeDeps([mkHealthWithInstance('0.2.40', 'inst-A'), null]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 60, intervalMs: 50 },
      deps,
    );
    // `lastVersion` DOES still latch (documented, unchanged contract) —
    // reason is 'wrong-version' (reachedOnce stays true), and the stale old
    // version is still reported. `lastInstanceId`, by contrast, must be gone.
    expect(r).toEqual({ ok: false, reason: 'wrong-version', lastVersion: '0.2.40' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastInstanceId).toBeUndefined();
    expect(probeCalls()).toBeGreaterThan(1); // proves the unreachable probe(s) actually ran
  });

  it('lastInstanceId is absent (not a false null) when no reachable probe ever carried instance_id', async () => {
    // No existing test in this file populates `instance_id` — this pins that
    // the field is genuinely OMITTED (not coerced to `null`) for a body that
    // predates it, distinct from `health.instance_id === null` ("field
    // present, explicitly no value"). The 5 pre-existing `toEqual` assertions
    // above (none of which include `lastInstanceId`) already depend on this.
    const { deps } = makeDeps([mkHealth('0.2.40')]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 100, intervalMs: 50 },
      deps,
    );
    // `toEqual` treats an `undefined`-valued property as equivalent to
    // absent — this is the SAME assertion shape the 5 pre-existing tests
    // above (none of which populate `instance_id`) already depend on.
    expect(r).toEqual({ ok: false, reason: 'wrong-version', lastVersion: '0.2.40' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastInstanceId).toBeUndefined();
  });

  it('unreachable-the-whole-time never populates lastInstanceId', async () => {
    const { deps } = makeDeps([null]);
    const r = await verifyGreen(
      { agent: 'code-agent', targetVersion: '0.2.41', timeoutMs: 100, intervalMs: 50 },
      deps,
    );
    expect(r).toEqual({ ok: false, reason: 'unreachable', lastVersion: null });
  });
});
