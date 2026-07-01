/**
 * Tests for the `macf fleet upgrade` COMMAND layer (DR-037 / macf#682 Phase 2):
 * target resolution (--target vs npm-latest), fleet selection (default / multi-
 * select / unknown), and the end-to-end wiring through the injected decision layer
 * (dry-run plans-without-acting; execute happy-path; multi-fleet HALT stops later
 * fleets). The heavy state-machine coverage lives in macf-core's
 * `fleet-upgrade.test.ts`; here we verify the RESOLVE + RENDER + wiring seam.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  FleetDriver,
  FleetState,
  WorkspaceRecord,
  HealthResponse,
} from '@groundnuty/macf-core';
import {
  runFleetUpgrade,
  resolveTargetVersion,
  selectFleets,
  formatPlanTable,
  type FleetUpgradeDeps,
} from '../../src/cli/commands/fleet-upgrade.js';

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

/** `fleet` feeds BOTH `registry` and `project` (macf#710: `project` is the true grouping key). */
function mkWs(agent: string, fleet: string, pin: string | null): WorkspaceRecord {
  return { agent, workspace: `/w/${agent}`, registry: fleet, project: fleet, versionPin: pin };
}

interface Calls {
  upgrade: string[];
  restart: string[];
}

/**
 * An upgrade-aware fake driver. `probe()` reports `base` for un-restarted agents
 * and — when `flipOnRestart` — `target` once an agent has been restarted, modeling
 * the real upgrade so the command's REAL `verifyGreen` (wired to `probe()`) sees
 * the version flip. `flipOnRestart: false` models a bad release (never green → HALT).
 */
function makeDriver(
  agents: readonly { readonly name: string; readonly registry: string }[],
  opts: { base: string; target: string; flipOnRestart?: boolean },
): { driver: FleetDriver; calls: Calls; workspaces: readonly WorkspaceRecord[] } {
  const calls: Calls = { upgrade: [], restart: [] };
  const restarted = new Set<string>();
  const flip = opts.flipOnRestart ?? true;
  const workspaces = agents.map((a) => mkWs(a.name, a.registry, opts.base));
  const driver: FleetDriver = {
    probe: async () =>
      mkState(agents.map((a) => [a.name, flip && restarted.has(a.name) ? opts.target : opts.base])),
    discoverWorkspaces: () => workspaces,
    isBusy: async () => false,
    upgrade: async (a) => { calls.upgrade.push(a); },
    restart: async (a) => {
      calls.restart.push(a);
      restarted.add(a);
    },
    inject: async () => {},
    launch: async () => {},
  };
  return { driver, calls, workspaces };
}

/** Build injectable command deps + a captured log. */
function makeDeps(over: Partial<FleetUpgradeDeps>): { deps: FleetUpgradeDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: FleetUpgradeDeps = {
    discover: () => [],
    resolveDriver: async () => null,
    defaultFleet: null,
    fetchLatest: async () => '0.2.41',
    sleep: async () => {},
    now: () => 0,
    log: (l) => lines.push(l),
    ...over,
  };
  return { deps, lines };
}

// --- resolveTargetVersion ---------------------------------------------------

describe('resolveTargetVersion', () => {
  it('uses an explicit --target (stripping a leading v) over npm-latest', async () => {
    const r = await resolveTargetVersion('v0.2.40', async () => '0.2.41');
    expect(r).toEqual({ ok: true, target: '0.2.40' });
  });

  it('falls back to npm-latest when no --target is given', async () => {
    const r = await resolveTargetVersion(undefined, async () => '0.2.41');
    expect(r).toEqual({ ok: true, target: '0.2.41' });
  });

  it('errors when neither --target nor npm-latest resolves', async () => {
    const r = await resolveTargetVersion(undefined, async () => null);
    expect(r.ok).toBe(false);
  });
});

// --- selectFleets -----------------------------------------------------------

describe('selectFleets', () => {
  it('defaults to the project fleet when no selectors are given', () => {
    expect(selectFleets(['g', 'acme/x'], [], 'g')).toEqual({ fleets: ['g'], unknown: [] });
  });

  it('returns no fleets when the default is not present on this host', () => {
    expect(selectFleets(['acme/x'], [], 'g')).toEqual({ fleets: [], unknown: [] });
  });

  it('multi-selects in order, dedupes, and surfaces unknown selectors', () => {
    const r = selectFleets(['a', 'b', 'c'], ['b', 'a', 'a', 'zzz'], null);
    expect(r.fleets).toEqual(['b', 'a']);
    expect(r.unknown).toEqual(['zzz']);
  });
});

// --- formatPlanTable --------------------------------------------------------

describe('formatPlanTable', () => {
  it('renders behind / at-target / offline rows', () => {
    const state = mkState([
      ['a', '0.2.40'],
      ['b', '0.2.41'],
      ['c', null, false],
    ]);
    const plans = [mkWs('a', 'g', '0.2.40'), mkWs('b', 'g', '0.2.41'), mkWs('c', 'g', '0.2.39')].map((_, i) => ({
      agent: state.agents[i]!.name,
      fleet: 'g',
      runningVersion: state.agents[i]!.version,
      pinnedVersion: '0.2.40',
      disposition: (['behind', 'at-target', 'offline'] as const)[i]!,
    }));
    const table = formatPlanTable(plans, '0.2.41');
    expect(table).toContain('UPGRADE 0.2.40→0.2.41');
    expect(table).toContain('OK (at target)');
    expect(table).toContain('UNREACHABLE');
  });
});

// --- runFleetUpgrade (end-to-end through injected deps) ----------------------

describe('runFleetUpgrade', () => {
  const AGENTS = [
    { name: 'a', registry: 'fleet-1' },
    { name: 'b', registry: 'fleet-2' },
  ] as const;

  it('DRY-RUN (default) prints the plan and performs NO mutations', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', {}, deps);
    expect(code).toBe(0);
    expect(calls.upgrade).toEqual([]);
    expect(calls.restart).toEqual([]);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('--execute rolls the default fleet and reports GREEN', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    expect(calls.upgrade).toEqual(['a']); // only fleet-1's member
    expect(calls.restart).toEqual(['a']);
    expect(lines.join('\n')).toContain('EXECUTE');
  });

  it('multi-select rolls fleet-by-fleet and HALT in fleet-1 stops fleet-2 (exit 1)', async () => {
    // flipOnRestart:false → 'a' never comes up on the target → verify-green fails → HALT.
    const { driver, calls, workspaces } = makeDriver(AGENTS, {
      base: '0.2.40',
      target: '0.2.41',
      flipOnRestart: false,
    });
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade(
      '/proj',
      { execute: true, fleet: 'fleet-1,fleet-2', verifyTimeoutSec: 0 },
      deps,
    );
    expect(code).toBe(1);
    expect(calls.upgrade).toEqual(['a']); // fleet-2's 'b' never rolled
  });

  it('errors (exit 1) when no target can be resolved', async () => {
    const { driver, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      fetchLatest: async () => null,
    });
    const code = await runFleetUpgrade('/proj', {}, deps);
    expect(code).toBe(1);
  });

  it('errors (exit 1) when no fleet is selected / discovered', async () => {
    const { deps } = makeDeps({ discover: () => [], defaultFleet: null });
    const code = await runFleetUpgrade('/proj', {}, deps);
    expect(code).toBe(1);
  });

  // --- macf#710: a profile registry hosting multiple projects must split into
  // multiple fleets, each probed with a driver bound to THAT project's own CA
  // (not a sibling project's) --------------------------------------------------
  describe('multi-project discovery under one profile registry (macf#710)', () => {
    /**
     * Two workspaces sharing the SAME `registry` scope (`groundnuty` — modeling
     * a profile registry) but belonging to DIFFERENT projects (`macf` +
     * `icsoc_2026`). Before #710 these collapsed into one fleet (grouped by
     * `registry`); after #710 they must discover as TWO separate fleets.
     */
    const CROSS_PROJECT_WORKSPACES: readonly WorkspaceRecord[] = [
      { agent: 'code-agent', workspace: '/w/code-agent', registry: 'groundnuty', project: 'macf', versionPin: '0.2.40' },
      { agent: 'icsoc-agent', workspace: '/w/icsoc-agent', registry: 'groundnuty', project: 'icsoc_2026', versionPin: '0.2.40' },
    ];

    /** Build a per-project driver bound ONLY to that project's own member(s) — models `createVmDriverFromConfig`'s CA binding. */
    function makeProjectDriver(
      project: string,
      members: readonly WorkspaceRecord[],
      opts: { base: string; target: string },
    ): { driver: FleetDriver; calls: Calls } {
      const calls: Calls = { upgrade: [], restart: [] };
      const restarted = new Set<string>();
      const own = members.filter((m) => m.project === project);
      const driver: FleetDriver = {
        probe: async () =>
          mkState(own.map((m) => [m.agent, restarted.has(m.agent) ? opts.target : opts.base])),
        discoverWorkspaces: () => members, // full host scan — filtering is the CALLER's job (macf-core's upgradeFleets)
        isBusy: async () => false,
        upgrade: async (a) => { calls.upgrade.push(a); },
        restart: async (a) => { calls.restart.push(a); restarted.add(a); },
        inject: async () => {},
        launch: async () => {},
      };
      return { driver, calls };
    }

    it('discovers TWO fleets (one per project) from a single profile-registry host scan', async () => {
      const { deps, lines } = makeDeps({
        discover: () => CROSS_PROJECT_WORKSPACES,
        defaultFleet: 'macf',
        resolveDriver: async () => null, // dry-run plan doesn't need a real driver resolution to enumerate fleets
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // No selectors + defaultFleet='macf' would only plan macf; explicitly
        // select both projects to exercise the multi-fleet discovery path.
        const code = await runFleetUpgrade('/proj', { fleet: 'macf,icsoc_2026' }, deps);
        // Both fleets are recognized as PRESENT on this host — neither is
        // reported as an unknown selector (which WOULD happen if the available
        // set were still keyed by the shared registry scope 'groundnuty').
        expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('no fleet'));
        // Both fleets are reported SKIPPED (driver-unresolved) rather than
        // halted, so the run exits 0 — the load-bearing assertion is that BOTH
        // fleet identifiers were recognized + attempted, not the exit code.
        expect(code).toBe(0);
        expect(lines.join('\n')).toContain('fleet macf');
        expect(lines.join('\n')).toContain('fleet icsoc_2026');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('rolls macf with a driver scoped to ONLY macf members, never touching icsoc_2026 agents', async () => {
      const macfDriver = makeProjectDriver('macf', CROSS_PROJECT_WORKSPACES, { base: '0.2.40', target: '0.2.41' });
      const icsocDriver = makeProjectDriver('icsoc_2026', CROSS_PROJECT_WORKSPACES, { base: '0.2.40', target: '0.2.41' });
      const resolveDriver = async (fleet: string): Promise<FleetDriver | null> =>
        fleet === 'macf' ? macfDriver.driver : fleet === 'icsoc_2026' ? icsocDriver.driver : null;

      const { deps } = makeDeps({
        discover: () => CROSS_PROJECT_WORKSPACES,
        defaultFleet: 'macf',
        resolveDriver,
      });
      const code = await runFleetUpgrade(
        '/proj',
        { execute: true, fleet: 'macf,icsoc_2026' },
        deps,
      );
      expect(code).toBe(0);
      // macf's driver only ever sees/rolls 'code-agent' — never 'icsoc-agent'.
      expect(macfDriver.calls.upgrade).toEqual(['code-agent']);
      expect(macfDriver.calls.restart).toEqual(['code-agent']);
      // icsoc's driver only ever sees/rolls 'icsoc-agent' — never 'code-agent'.
      expect(icsocDriver.calls.upgrade).toEqual(['icsoc-agent']);
      expect(icsocDriver.calls.restart).toEqual(['icsoc-agent']);
    });

    it('the available-fleets list is keyed by project, not by the (shared) registry scope', async () => {
      const { deps } = makeDeps({
        discover: () => CROSS_PROJECT_WORKSPACES,
        defaultFleet: null,
        resolveDriver: async () => null,
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // 'groundnuty' is the SHARED registry scope of both fixture workspaces —
        // under the pre-#710 registry-grouping this would have been a valid
        // fleet selector. Post-#710 it must be reported UNKNOWN (the available
        // set is now ['macf', 'icsoc_2026'], never 'groundnuty').
        const code = await runFleetUpgrade('/proj', { fleet: 'groundnuty' }, deps);
        expect(code).toBe(1);
        const errText = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(errText).toContain("no fleet 'groundnuty' discovered on this host");
        expect(errText).toContain('macf');
        expect(errText).toContain('icsoc_2026');
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
