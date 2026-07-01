/**
 * Over-register loop — groundnuty/macf#702.
 *
 * The load-bearing fix for the register-race abort that bricked devops for 8h
 * (2026-07-01). A relaunch must CLAIM its own agent-identity slot even when a
 * stale / same / older entry is present (over-register, last-writer-wins), and
 * must YIELD (clean stand-down, NOT abort-to-dead) ONLY to a genuinely newer +
 * live instance.
 *
 * The registry-CAS half of the fix (read-after-write lag must not masquerade
 * as a lost race) is covered in macf-core/test/registry/register-conditional.
 * These tests cover the SERVER half: the claim-vs-yield classification loop.
 * `classify` is injected as a stub so the loop's branching is exercised
 * without a live `/health` mTLS probe.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentInfo, Registry, RegisterResult, Logger } from '@groundnuty/macf-core';
import { registerWithTakeover } from '../src/register-with-takeover.js';
import { RegisterRaceError } from '../src/collision.js';
import type { CollisionResult } from '../src/collision.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A registry whose `registerConditional` is a scriptable queue of results. */
function scriptedRegistry(results: RegisterResult[]): {
  registry: Registry;
  calls: Array<{ expected: AgentInfo | null }>;
} {
  const calls: Array<{ expected: AgentInfo | null }> = [];
  let i = 0;
  const registry: Registry = {
    register: vi.fn(),
    registerConditional: vi.fn(async (_name: string, _info: AgentInfo, expected: AgentInfo | null) => {
      calls.push({ expected });
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return r;
    }),
    deregisterConditional: vi.fn(),
    heartbeatConditional: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
  return { registry, calls };
}

const certPaths = {
  caCertPath: '/fake/ca.pem',
  agentCertPath: '/fake/agent.pem',
  agentKeyPath: '/fake/agent-key.pem',
};

const INCOMING = '0.2.45';

// This instance's fresh registration (the relaunch trying to claim the slot).
const ME: AgentInfo = {
  host: '100.86.5.117',
  port: 9486,
  type: 'permanent',
  instance_id: 'newnew',
  started: '2026-07-01T02:15:22Z',
};

// The exact devops shape: a prior instance that exited WITHOUT deregistering,
// leaving a stale/dead entry the collision check decided to take over.
const STALE: AgentInfo = {
  host: '100.86.5.117',
  port: 9486,
  type: 'permanent',
  instance_id: '23a35e',
  started: '2026-07-01T01:00:00Z',
};

// A genuinely different, newer, LIVE instance that legitimately owns the slot.
const NEWER_LIVE: AgentInfo = {
  host: '100.86.5.117',
  port: 9500,
  type: 'permanent',
  instance_id: 'winner',
  started: '2026-07-01T02:15:30Z',
};

const takeoverOf = (previous: AgentInfo): CollisionResult => ({ action: 'takeover', previous });
const registerFresh: CollisionResult = { action: 'register' };

describe('registerWithTakeover (macf#702 over-register)', () => {
  it('claims immediately when registerConditional succeeds (takeover of the stale entry)', async () => {
    const { registry, calls } = scriptedRegistry([
      { ok: true, reason: 'claimed', current: ME },
    ]);
    const classify = vi.fn();

    await expect(
      registerWithTakeover({
        registry,
        routingLabel: 'devops-agent',
        agentInfo: ME,
        collisionResult: takeoverOf(STALE),
        certPaths,
        incomingVersion: INCOMING,
        logger: mockLogger(),
        classify,
      }),
    ).resolves.toBeUndefined();

    // First (and only) write uses expected = the stale takeover target.
    expect(calls).toHaveLength(1);
    expect(calls[0].expected).toEqual(STALE);
    // A clean claim never needs to re-classify.
    expect(classify).not.toHaveBeenCalled();
  });

  it('DEVOPS REGRESSION: a stale/same current is FORCED (retry), never aborts — comes up on the second claim', async () => {
    // First registerConditional loses to `current == STALE` (the very entry we
    // decided to take over — a lagging/racing observation). Pre-#702 this
    // threw AGENT_REGISTER_RACE and the agent stayed DOWN. Post-#702 we
    // re-classify STALE (→ takeover, it's dead), FORCE the claim with
    // expected=STALE, and the retry succeeds.
    const { registry, calls } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: STALE },
      { ok: true, reason: 'claimed', current: ME },
    ]);
    // classify says STALE is dead → takeover (force the claim).
    const classify = vi.fn().mockResolvedValue(takeoverOf(STALE));

    await expect(
      registerWithTakeover({
        registry,
        routingLabel: 'devops-agent',
        agentInfo: ME,
        collisionResult: takeoverOf(STALE),
        certPaths,
        incomingVersion: INCOMING,
        logger: mockLogger(),
        classify,
      }),
    ).resolves.toBeUndefined();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // The forced retry writes with expected = the re-classified STALE current.
    expect(calls[1].expected).toEqual(STALE);
  });

  it('over-registers a stale/older current: re-classifies → takeover → retry claims', async () => {
    const { registry, calls } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: STALE },
      { ok: true, reason: 'claimed', current: ME },
    ]);
    const classify = vi.fn().mockResolvedValue(takeoverOf(STALE));

    await registerWithTakeover({
      registry,
      routingLabel: 'devops-agent',
      agentInfo: ME,
      collisionResult: registerFresh, // even a fresh-register that races a stale writer
      certPaths,
      incomingVersion: INCOMING,
      logger: mockLogger(),
      classify,
    });

    expect(calls[0].expected).toBeNull(); // fresh register: expected-absent
    expect(calls[1].expected).toEqual(STALE); // forced takeover against the racer
  });

  it('YIELDS (clean stand-down) to a genuinely newer LIVE instance — throws RegisterRaceError, never crash-loops', async () => {
    const { registry } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: NEWER_LIVE },
    ]);
    // classify says NEWER_LIVE is a live same/newer peer → abort (yield).
    const classify = vi.fn().mockResolvedValue({ action: 'abort', existing: NEWER_LIVE } as CollisionResult);

    await expect(
      registerWithTakeover({
        registry,
        routingLabel: 'devops-agent',
        agentInfo: ME,
        collisionResult: takeoverOf(STALE),
        certPaths,
        incomingVersion: INCOMING,
        logger: mockLogger(),
        classify,
      }),
    ).rejects.toBeInstanceOf(RegisterRaceError);

    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('retries against expected-absent when the slot was emptied in the window (current === null)', async () => {
    const { registry, calls } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: null },
      { ok: true, reason: 'claimed', current: ME },
    ]);
    const classify = vi.fn(); // never called — a null current isn't classified

    await registerWithTakeover({
      registry,
      routingLabel: 'devops-agent',
      agentInfo: ME,
      collisionResult: takeoverOf(STALE),
      certPaths,
      incomingVersion: INCOMING,
      logger: mockLogger(),
      classify,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(calls[1].expected).toBeNull(); // retried against expected-absent
  });

  it('bounds retries: a pathologically flapping stale slot yields after maxRetries instead of looping forever', async () => {
    // Every registerConditional loses to a stale current; classify always says
    // takeover (force). Without a bound this loops forever — with maxRetries it
    // yields (throws) after the budget.
    const { registry } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: STALE },
    ]);
    const classify = vi.fn().mockResolvedValue(takeoverOf(STALE));

    await expect(
      registerWithTakeover({
        registry,
        routingLabel: 'devops-agent',
        agentInfo: ME,
        collisionResult: takeoverOf(STALE),
        certPaths,
        incomingVersion: INCOMING,
        logger: mockLogger(),
        classify,
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(RegisterRaceError);

    // attempt 0,1,2 force-retry (classify called), attempt 3 hits the bound.
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('TWO CONCURRENT FRESH claims — the loser YIELDS to the winner (live), never aborts-to-dead', async () => {
    // Model this instance as the LOSER of a two-fresh-launch race: its fresh
    // register (expected=null) loses to the winner's already-written entry
    // (NEWER_LIVE, a live peer). classifyPeer says the live winner → abort →
    // this loser yields (clean stand-down), NOT a crash-abort-to-dead. The
    // WINNER's own registerConditional would return ok:true (claimed) — proven
    // by the local-backend concurrent test in macf-core; here we assert the
    // loser's half: it stands down cleanly.
    const { registry } = scriptedRegistry([
      { ok: false, reason: 'lost-to-newer', current: NEWER_LIVE },
    ]);
    const classify = vi.fn().mockResolvedValue({ action: 'abort', existing: NEWER_LIVE } as CollisionResult);

    await expect(
      registerWithTakeover({
        registry,
        routingLabel: 'devops-agent',
        agentInfo: ME,
        collisionResult: registerFresh, // fresh launch, expected-absent
        certPaths,
        incomingVersion: INCOMING,
        logger: mockLogger(),
        classify,
      }),
    ).rejects.toBeInstanceOf(RegisterRaceError);
  });

  it('DEREGISTER SKIPPED (ungraceful death): a relaunch still claims cleanly against the never-deregistered stale slot', async () => {
    // Simulate #586 deregister never having run: the stale slot is simply
    // present. Correctness must NOT depend on deregister — the relaunch claims
    // regardless. The collision check decided takeover; the CAS claims on the
    // first shot (no lag/race).
    const { registry, calls } = scriptedRegistry([
      { ok: true, reason: 'claimed', current: ME },
    ]);

    await registerWithTakeover({
      registry,
      routingLabel: 'devops-agent',
      agentInfo: ME,
      collisionResult: takeoverOf(STALE),
      certPaths,
      incomingVersion: INCOMING,
      logger: mockLogger(),
      classify: vi.fn(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].expected).toEqual(STALE);
  });
});
