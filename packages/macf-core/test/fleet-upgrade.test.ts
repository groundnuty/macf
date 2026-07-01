/**
 * Tests for the rolling fleet-upgrade DECISION layer (DR-037 / macf#682 Phase 2).
 * Everything is driven through a FAKE `FleetDriver` + a FAKE `verifyGreen` that
 * RECORD their calls, so the state machine is verified with NO real tmux /
 * processes / network — mirroring the acceptance intent of the devops
 * `fleet/upgrade.sh` guard cases (behind-selected / at-target-skipped / busy-skip
 * / verify-green-before-next / HALT-the-roll).
 */
import { describe, it, expect } from 'vitest';
import {
  planFleetUpgrade,
  rollFleet,
  upgradeFleets,
  type FleetDriver,
  type FleetState,
  type WorkspaceRecord,
  type HealthResponse,
  type VerifyGreenOptions,
  type VerifyGreenResult,
} from '../src/index.js';

// --- fixtures ---------------------------------------------------------------

function mkHealth(version: string): HealthResponse {
  return {
    agent: 'a',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 5,
    current_issue: null,
    version,
    last_notification: null,
  };
}

/** Build a `FleetState` from `[name, version|null, online?]` tuples. */
function mkState(rows: readonly [string, string | null, boolean?][]): FleetState {
  return {
    agents: rows.map(([name, version, online = true]) => ({
      name,
      host: 'h',
      port: 1,
      online,
      version,
      health: online && version ? mkHealth(version) : null,
    })),
  };
}

/**
 * `project` is the fleet-grouping key (macf#710) — the fixture's `fleet` param
 * feeds it directly (a distinct `registry` value is set alongside so the
 * two-fields-can-diverge shape mirrors production and any test that DOES want
 * to exercise a same-registry / different-project split can supply its own).
 */
function mkWs(agent: string, fleet: string, pin: string | null): WorkspaceRecord {
  return { agent, workspace: `/w/${agent}`, registry: fleet, project: fleet, versionPin: pin };
}

interface DriverCalls {
  probe: number;
  discover: number;
  isBusy: string[];
  isConfigDirty: string[];
  upgrade: string[];
  restart: string[];
  restartForce: string[];
}

/** A recording fake driver. `busy(agent, callIdx)` decides isBusy per call. */
function makeDriver(opts: {
  state: FleetState;
  workspaces: readonly WorkspaceRecord[];
  busy?: (agent: string, callIdx: number) => boolean;
  /** Agents whose config surface is dirty (macf#722 Fix B); defaults to none. */
  configDirty?: (agent: string) => boolean;
}): { driver: FleetDriver; calls: DriverCalls } {
  const calls: DriverCalls = {
    probe: 0,
    discover: 0,
    isBusy: [],
    isConfigDirty: [],
    upgrade: [],
    restart: [],
    restartForce: [],
  };
  const perAgent = new Map<string, number>();
  const driver: FleetDriver = {
    probe: async () => {
      calls.probe += 1;
      return opts.state;
    },
    discoverWorkspaces: () => {
      calls.discover += 1;
      return opts.workspaces;
    },
    isBusy: async (agent) => {
      const idx = perAgent.get(agent) ?? 0;
      perAgent.set(agent, idx + 1);
      calls.isBusy.push(agent);
      return opts.busy ? opts.busy(agent, idx) : false;
    },
    isConfigDirty: async (agent) => {
      calls.isConfigDirty.push(agent);
      return opts.configDirty ? opts.configDirty(agent) : false;
    },
    capturePane: async () => null,
    upgrade: async (agent) => {
      calls.upgrade.push(agent);
    },
    restart: async (agent, restartOpts) => {
      calls.restart.push(agent);
      if (restartOpts?.forceStashConfig) calls.restartForce.push(agent);
    },
    inject: async () => {},
    launch: async () => {},
  };
  return { driver, calls };
}

/** A verify-green fake keyed by agent (defaults to green on the target). */
function makeVerify(results: Record<string, VerifyGreenResult> = {}): {
  verifyGreen: (o: VerifyGreenOptions) => Promise<VerifyGreenResult>;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    verifyGreen: async (o) => {
      seen.push(o.agent);
      return results[o.agent] ?? { ok: true, version: o.targetVersion };
    },
  };
}

const noWait = { sleep: async () => {}, now: () => 0 };

// --- planFleetUpgrade -------------------------------------------------------

describe('planFleetUpgrade', () => {
  const members = [mkWs('behind', 'g', '0.2.40'), mkWs('current', 'g', '0.2.41'), mkWs('down', 'g', '0.2.39')];
  const state = mkState([
    ['behind', '0.2.40'],
    ['current', '0.2.41'],
    ['down', null, false],
  ]);

  it('classifies behind / at-target / offline against the target', () => {
    const plans = planFleetUpgrade(members, state, '0.2.41');
    expect(plans.map((p) => [p.agent, p.disposition])).toEqual([
      ['behind', 'behind'],
      ['current', 'at-target'],
      ['down', 'offline'],
    ]);
  });

  it('treats a newer-than-target running version as at-target', () => {
    const plans = planFleetUpgrade([mkWs('ahead', 'g', null)], mkState([['ahead', '0.3.0']]), '0.2.41');
    expect(plans[0]!.disposition).toBe('at-target');
  });

  it('treats an online-but-version-less agent as offline (no comparable version)', () => {
    const plans = planFleetUpgrade([mkWs('a', 'g', null)], mkState([['a', null, true]]), '0.2.41');
    expect(plans[0]!.disposition).toBe('offline');
  });

  it('carries the fleet (project, macf#710) + on-disk pin through', () => {
    const plans = planFleetUpgrade([mkWs('a', 'acme/repo', '0.2.40')], mkState([['a', '0.2.40']]), '0.2.41');
    expect(plans[0]).toMatchObject({ fleet: 'acme/repo', pinnedVersion: '0.2.40', runningVersion: '0.2.40' });
  });

  it('groups by PROJECT, not registry: two projects sharing one registry scope do NOT collide', () => {
    // The macf#710 regression shape: two workspaces share the same `registry`
    // (e.g. both `groundnuty` profile-scoped) but belong to DIFFERENT projects.
    // `planFleetUpgrade`'s `fleet` output must key on `project`, so a caller
    // filtering members by `r.project === fleet` (as `upgradeFleets` does)
    // correctly separates them into two fleets.
    const macfMember: WorkspaceRecord = {
      agent: 'code-agent',
      workspace: '/w/macf',
      registry: 'groundnuty',
      project: 'macf',
      versionPin: '0.2.40',
    };
    const icsocMember: WorkspaceRecord = {
      agent: 'icsoc-agent',
      workspace: '/w/icsoc',
      registry: 'groundnuty',
      project: 'icsoc_2026',
      versionPin: '0.2.40',
    };
    const state = mkState([
      ['code-agent', '0.2.40'],
      ['icsoc-agent', '0.2.40'],
    ]);
    const plans = planFleetUpgrade([macfMember, icsocMember], state, '0.2.41');
    expect(plans.map((p) => p.fleet)).toEqual(['macf', 'icsoc_2026']);
  });
});

// --- rollFleet --------------------------------------------------------------

describe('rollFleet', () => {
  const twoBehind = planFleetUpgrade(
    [mkWs('a1', 'g', '0.2.40'), mkWs('a2', 'g', '0.2.40')],
    mkState([
      ['a1', '0.2.40'],
      ['a2', '0.2.40'],
    ]),
    '0.2.41',
  );

  it('rolls behind agents in order: upgrade → restart → verify-green, all green', async () => {
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify();
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(calls.upgrade).toEqual(['a1', 'a2']);
    expect(calls.restart).toEqual(['a1', 'a2']);
    expect(seen).toEqual(['a1', 'a2']);
    expect(res.halted).toBe(false);
    expect(res.upgraded).toBe(2);
    expect(res.results.map((r) => r.outcome)).toEqual(['upgraded', 'upgraded']);
  });

  it('config-dirty PRE-FLIGHT gate: skips + reports BEFORE any mutation, and continues (macf#722 Fix B)', async () => {
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      configDirty: (agent) => agent === 'a1',
    });
    const { verifyGreen } = makeVerify();
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    // a1 never touched — no upgrade/restart/isBusy call at all for a1.
    expect(calls.isConfigDirty).toEqual(['a1', 'a2']);
    expect(calls.upgrade).toEqual(['a2']);
    expect(calls.restart).toEqual(['a2']);
    expect(calls.isBusy).toEqual(['a2']); // a1's busy-gate never even runs
    expect(res.halted).toBe(false);
    expect(res.configDirtySkipped).toBe(1);
    expect(res.upgraded).toBe(1);
    expect(res.results.map((r) => [r.agent, r.outcome])).toEqual([
      ['a1', 'config-dirty-skipped'],
      ['a2', 'upgraded'],
    ]);
    expect(res.results[0]!.detail).toContain('--force');
  });

  it('--force bypasses the config-dirty gate AND threads forceStashConfig into restart', async () => {
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      configDirty: () => true,
    });
    const { verifyGreen } = makeVerify();
    const res = await rollFleet(
      twoBehind,
      { targetVersion: '0.2.41', verifyTimeoutMs: 1000, force: true },
      { driver, verifyGreen, ...noWait },
    );
    expect(res.configDirtySkipped).toBe(0);
    expect(calls.upgrade).toEqual(['a1', 'a2']);
    expect(calls.restart).toEqual(['a1', 'a2']);
    // both agents' restart was told to force-stash the (dirty) config surface.
    expect(calls.restartForce).toEqual(['a1', 'a2']);
    expect(res.halted).toBe(false);
  });

  it('skips + reports a BUSY agent (never interrupts) and continues to the next', async () => {
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      busy: (agent) => agent === 'a1',
    });
    const { verifyGreen } = makeVerify();
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(calls.upgrade).toEqual(['a2']); // a1 never upgraded (busy)
    expect(res.busySkipped).toBe(1);
    expect(res.upgraded).toBe(1);
    expect(res.results.map((r) => [r.agent, r.outcome])).toEqual([
      ['a1', 'busy-skipped'],
      ['a2', 'upgraded'],
    ]);
  });

  it('--wait polls a busy agent for idle, then rolls it once idle', async () => {
    // a1 busy on the first two isBusy calls, idle thereafter.
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      busy: (agent, idx) => agent === 'a1' && idx < 2,
    });
    const { verifyGreen } = makeVerify();
    let clock = 0;
    const res = await rollFleet(
      [twoBehind[0]!],
      { targetVersion: '0.2.41', verifyTimeoutMs: 1000, wait: true, waitTimeoutMs: 100_000, waitPollMs: 10 },
      { driver, verifyGreen, sleep: async (ms) => { clock += ms; }, now: () => clock },
    );
    expect(calls.upgrade).toEqual(['a1']); // eventually rolled
    expect(res.busySkipped).toBe(0);
    expect(res.upgraded).toBe(1);
  });

  it('--wait gives up (busy-skips) when the agent never goes idle within the budget', async () => {
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [], busy: () => true });
    const { verifyGreen } = makeVerify();
    let clock = 0;
    const res = await rollFleet(
      [twoBehind[0]!],
      { targetVersion: '0.2.41', verifyTimeoutMs: 1000, wait: true, waitTimeoutMs: 50, waitPollMs: 10 },
      { driver, verifyGreen, sleep: async (ms) => { clock += ms; }, now: () => clock },
    );
    expect(calls.upgrade).toEqual([]);
    expect(res.busySkipped).toBe(1);
    expect(res.results[0]!.detail).toContain('still busy');
  });

  it('HALTS with reason bad-release when verify-green sees the agent back on the OLD (pre-upgrade) version — later agents are NOT touched', async () => {
    // a1's plan.runningVersion is '0.2.40' (the pre-upgrade pin) — verify-green
    // reporting lastVersion '0.2.40' means the restart came back on the SAME old
    // release (crash-loop / stuck-old-process), which is the confirmed-bad-release
    // signal, distinct from an unconfirmed/unknown state.
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify({
      a1: { ok: false, reason: 'wrong-version', lastVersion: '0.2.40' },
    });
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(res.halted).toBe(true);
    expect(calls.upgrade).toEqual(['a1']); // a2 never reached
    expect(calls.restart).toEqual(['a1']);
    expect(seen).toEqual(['a1']);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'halted', reason: 'bad-release' });
    expect(res.results[0]!.detail).toContain('bad-release');
  });

  it('HALTS with reason relaunch-unconfirmed when verify-green times out unreachable (down the whole grace) — later agents are NOT touched', async () => {
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify({
      a1: { ok: false, reason: 'unreachable', lastVersion: null },
    });
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(res.halted).toBe(true);
    expect(calls.upgrade).toEqual(['a1']);
    expect(seen).toEqual(['a1']);
    expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'halted', reason: 'relaunch-unconfirmed' });
    expect(res.results[0]!.detail).toContain('relaunch-unconfirmed');
  });

  it('HALTS with reason relaunch-unconfirmed when verify-green sees an UNKNOWN (neither old nor target) version — NOT bad-release', async () => {
    // a1 pre-upgrade pin/runningVersion is '0.2.40'; verify-green sees some OTHER
    // in-between version ('0.2.40-rc1' normalizes to 0.2.40.0 under compareSemver's
    // unparseable-suffix rule... use a genuinely distinct comparable version instead
    // so the case is unambiguous: neither the old pin nor the target).
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify({
      a1: { ok: false, reason: 'wrong-version', lastVersion: '0.2.39' },
    });
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(res.halted).toBe(true);
    expect(calls.upgrade).toEqual(['a1']);
    expect(seen).toEqual(['a1']);
    expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'halted', reason: 'relaunch-unconfirmed' });
  });

  it('slow-but-fine relaunch: verify-green confirms green WITHIN the grace after early down/unknown polls — CONTINUES', async () => {
    // Models the spurious-halt root cause: early polls during relaunch see the
    // agent down/unreachable (old session dying, new one not up yet), but the
    // REAL verifyGreen (macf-core) already polls-with-retry internally — this
    // test asserts rollFleet just trusts whatever terminal result verifyGreen
    // returns (ok:true) and continues, regardless of how many polls it took.
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify({
      a1: { ok: true, version: '0.2.41' },
    });
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(res.halted).toBe(false);
    expect(calls.upgrade).toEqual(['a1', 'a2']);
    expect(seen).toEqual(['a1', 'a2']);
    expect(res.results.map((r) => r.outcome)).toEqual(['upgraded', 'upgraded']);
  });

  it('ignores non-behind plans (at-target / offline) — no driver mutations', async () => {
    const plans = planFleetUpgrade(
      [mkWs('cur', 'g', null), mkWs('off', 'g', null)],
      mkState([
        ['cur', '0.2.41'],
        ['off', null, false],
      ]),
      '0.2.41',
    );
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen } = makeVerify();
    const res = await rollFleet(plans, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(calls.upgrade).toEqual([]);
    expect(calls.isBusy).toEqual([]);
    expect(res.results).toEqual([]);
  });
});

// --- upgradeFleets (multi-fleet + dry-run) ----------------------------------

describe('upgradeFleets', () => {
  const workspaces = [mkWs('a', 'fleet-1', '0.2.40'), mkWs('b', 'fleet-2', '0.2.40')];
  const state = mkState([
    ['a', '0.2.40'],
    ['b', '0.2.40'],
  ]);

  function deps(driver: FleetDriver, extra: Partial<Parameters<typeof upgradeFleets>[2]> = {}) {
    const { verifyGreen } = makeVerify();
    return { resolveDriver: async () => driver, verifyGreen, ...noWait, ...extra };
  }

  it('DRY-RUN plans without acting — no upgrade / restart / isBusy calls', async () => {
    const { driver, calls } = makeDriver({ state, workspaces });
    const report = await upgradeFleets(
      ['fleet-1'],
      { execute: false, targetVersion: '0.2.41', verifyTimeoutMs: 1000 },
      deps(driver),
    );
    expect(calls.upgrade).toEqual([]);
    expect(calls.restart).toEqual([]);
    expect(calls.isBusy).toEqual([]);
    expect(calls.probe).toBe(1); // probed to build the plan
    expect(report.halted).toBe(false);
    expect(report.fleets[0]!.plans.map((p) => p.disposition)).toEqual(['behind']);
    expect(report.fleets[0]!.rolled).toBeUndefined();
  });

  it('rolls multiple fleets serially when all succeed', async () => {
    const { driver, calls } = makeDriver({ state, workspaces });
    const report = await upgradeFleets(
      ['fleet-1', 'fleet-2'],
      { execute: true, targetVersion: '0.2.41', verifyTimeoutMs: 1000 },
      deps(driver),
    );
    expect(calls.upgrade).toEqual(['a', 'b']); // fleet-1's a, then fleet-2's b
    expect(report.halted).toBe(false);
    expect(report.fleets).toHaveLength(2);
    expect(report.fleets.every((f) => f.rolled && !f.rolled.halted)).toBe(true);
  });

  it('a HALT in fleet-1 STOPS the run — fleet-2 is never started', async () => {
    const { driver, calls } = makeDriver({ state, workspaces });
    let resolveCount = 0;
    const report = await upgradeFleets(
      ['fleet-1', 'fleet-2'],
      { execute: true, targetVersion: '0.2.41', verifyTimeoutMs: 1000 },
      deps(driver, {
        resolveDriver: async () => {
          resolveCount += 1;
          return driver;
        },
        verifyGreen: async (o) =>
          o.agent === 'a'
            ? { ok: false, reason: 'unreachable', lastVersion: null }
            : { ok: true, version: o.targetVersion },
      }),
    );
    expect(report.halted).toBe(true);
    expect(calls.upgrade).toEqual(['a']); // fleet-2's 'b' never rolled
    expect(resolveCount).toBe(1); // resolveDriver called for fleet-1 only
    expect(report.fleets).toHaveLength(1); // fleet-2 report absent (loop broke)
  });

  it('skips + reports an unresolvable fleet WITHOUT halting the run', async () => {
    const { driver, calls } = makeDriver({ state, workspaces });
    const report = await upgradeFleets(
      ['fleet-1', 'fleet-2'],
      { execute: true, targetVersion: '0.2.41', verifyTimeoutMs: 1000 },
      deps(driver, {
        resolveDriver: async (fleet: string) => (fleet === 'fleet-1' ? null : driver),
      }),
    );
    expect(report.halted).toBe(false);
    expect(report.fleets[0]).toMatchObject({ fleet: 'fleet-1', skipped: 'driver-unresolved' });
    expect(calls.upgrade).toEqual(['b']); // fleet-2 still rolled
  });
});
