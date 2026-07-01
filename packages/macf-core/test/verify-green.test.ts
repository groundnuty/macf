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
});
