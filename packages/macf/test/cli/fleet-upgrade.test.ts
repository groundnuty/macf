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
  FleetPlanReport,
  FleetRollResult,
  FleetUpgradeReport,
} from '@groundnuty/macf-core';
import {
  runFleetUpgrade,
  resolveTargetVersion,
  selectFleets,
  formatPlanTable,
  fleetUpgradeExitCode,
  isMixedVersionRoll,
  rollLeftAgentBehind,
  buildCliFetchLatest,
  type FleetUpgradeDeps,
} from '../../src/cli/commands/fleet-upgrade.js';
import { NO_MANIFEST_VERSION } from '../../src/cli/bootstrap/version-target.js';
import type { FetchResult } from '../../src/cli/version-resolver.js';

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
  opts: {
    base: string;
    target: string;
    flipOnRestart?: boolean;
    /**
     * Per-agent LAUNCH PIN (macf#899); defaults to `null` (honest-unknown)
     * for every agent — preserves the PRE-macf#899 conservative
     * `bad-release` classification for tests that don't configure a pin.
     */
    launchPin?: (agent: string) => string | null;
    /** Busy-gate override (macf#1146's decisive pair); defaults to never-busy. */
    isBusy?: (agent: string) => Promise<boolean>;
  },
): { driver: FleetDriver; calls: Calls; workspaces: readonly WorkspaceRecord[] } {
  const calls: Calls = { upgrade: [], restart: [] };
  const restarted = new Set<string>();
  const flip = opts.flipOnRestart ?? true;
  const workspaces = agents.map((a) => mkWs(a.name, a.registry, opts.base));
  const driver: FleetDriver = {
    probe: async () =>
      mkState(agents.map((a) => [a.name, flip && restarted.has(a.name) ? opts.target : opts.base])),
    discoverWorkspaces: () => workspaces,
    isBusy: opts.isBusy ?? (async () => false),
    isConfigDirty: async () => false,
    listDirtyConfig: async () => [],
    currentBranch: async () => 'main',
    canonicalBranch: async () => 'main',
    classifyDirtyConfig: async () => ({ alreadyCanonical: [], genuineDelta: [] }),
    autoResolveCanonical: async () => {},
    capturePane: async () => null,
    upgrade: async (a) => { calls.upgrade.push(a); },
    restart: async (a) => {
      calls.restart.push(a);
      restarted.add(a);
    },
    inject: async () => {},
    launch: async () => {},
    listModifiedFiles: async () => [],
    readVersionPin: async (a) => (opts.launchPin ? opts.launchPin(a) : null),
    acquireLock: async () => {},
    releaseLock: async () => {},
    startHeartbeat: () => () => {},
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

// --- resolveTargetVersion (DR-043 Amendment L, macf#1045) -------------------
//
// The manifest-authoritative target-resolution rule now lives in
// `bootstrap/version-target.ts`; `commands/fleet-upgrade.ts` re-exports it
// unchanged (see that module's doc). `NO_MANIFEST_VERSION` models the
// standalone `macf fleet upgrade` call with no `-f/--file` — the ONLY
// reachable `fetchLatest` path (L2.5).

describe('resolveTargetVersion', () => {
  it('uses an explicit --target (stripping a leading v) over npm-latest — no manifest given', async () => {
    const r = await resolveTargetVersion('v0.2.40', NO_MANIFEST_VERSION, async () => '0.2.41');
    expect(r).toEqual({ kind: 'resolved', target: '0.2.40' });
  });

  it('no manifest given, no --target: falls back to npm-latest (fleet upgrade standalone unchanged — L2.5)', async () => {
    const r = await resolveTargetVersion(undefined, NO_MANIFEST_VERSION, async () => '0.2.41');
    expect(r).toEqual({ kind: 'resolved', target: '0.2.41' });
  });

  it('errors when neither --target nor npm-latest resolves (no manifest given)', async () => {
    const r = await resolveTargetVersion(undefined, NO_MANIFEST_VERSION, async () => null);
    expect(r.kind).toBe('error');
  });

  // --- Decisive test #1 (Amendment L3 / L2.3) — the manifest pins a version
  // OLDER than npm-latest; the reconcile must target the PIN, and the
  // network path must be NEVER ENTERED — not merely that the right target
  // happened to win (`assert-the-wrong-path.md`).
  it('DECISIVE — manifest pins 0.2.55 while npm-latest is 0.2.57: resolves to 0.2.55 AND fetchLatest is NEVER invoked', async () => {
    const fetchLatest = async (): Promise<string | null> => {
      throw new Error('fetchLatest must not be called when versions.macf is declared (DR-043 Amendment L3)');
    };
    const r = await resolveTargetVersion(undefined, { given: true, macf: '0.2.55' }, fetchLatest);
    expect(r).toEqual({ kind: 'resolved', target: '0.2.55' });
  });

  // --- Decisive test #2 (Amendment L2.4) — a manifest WAS given but
  // declares no versions: section at all: "no opinion", not "latest" — and
  // the network path is likewise never entered.
  it('DECISIVE — manifest given but versions.macf absent: no-opinion, NOT latest, AND fetchLatest is NEVER invoked', async () => {
    const fetchLatest = async (): Promise<string | null> => {
      throw new Error('fetchLatest must not be called when a manifest was given but declares no versions.macf');
    };
    const r = await resolveTargetVersion(undefined, { given: true, macf: undefined }, fetchLatest);
    expect(r.kind).toBe('no-opinion');
  });

  it('--target still overrides an authoritative manifest version (L2.3\'s own escape hatch)', async () => {
    const fetchLatest = async (): Promise<string | null> => {
      throw new Error('fetchLatest must not be called when --target is given');
    };
    const r = await resolveTargetVersion('0.2.99', { given: true, macf: '0.2.55' }, fetchLatest);
    expect(r).toEqual({ kind: 'resolved', target: '0.2.99' });
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
      runningInstanceId: null,
      pinnedVersion: '0.2.40',
      disposition: (['behind', 'at-target', 'offline'] as const)[i]!,
    }));
    const table = formatPlanTable(plans, '0.2.41');
    expect(table).toContain('UPGRADE 0.2.40→0.2.41');
    expect(table).toContain('OK (at target)');
    expect(table).toContain('UNREACHABLE');
    // #721: the per-line PLAN cell must NOT carry the present-tense-reading
    // "(busy-gated at execute)" parenthetical — it misreads as "agent is busy".
    expect(table).not.toContain('busy-gated');
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
    const out = lines.join('\n');
    expect(out).toContain('dry-run');
    // #721: the busy-gate is explained ONCE as a future-conditional footer
    // (mechanism + --wait), not repeated per-line as present-tense state.
    expect(out).toContain('rolls only when idle');
    expect(out).toContain('--wait');
    expect(out).not.toContain('busy-gated');
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

  // --- DR-043 §D6 write-back wiring (macf#907) -------------------------------
  //
  // The heavy call-gating coverage (which dispositions call it, which don't,
  // non-fatal-on-reject) lives in macf-core's `fleet-upgrade.test.ts`. This
  // file only verifies the RESOLVE + wiring seam: `FleetUpgradeDeps.recordDeployedVersion`
  // reaches `upgradeFleets`, and a failure renders through `emit()`.

  it('--execute threads FleetUpgradeDeps.recordDeployedVersion through to a confirmed-green agent', async () => {
    const { driver, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const recorded: { agent: string; fleet: string; version: string }[] = [];
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      recordDeployedVersion: async (agent, fleet, version) => { recorded.push({ agent, fleet, version }); },
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    expect(recorded).toEqual([{ agent: 'a', fleet: 'fleet-1', version: '0.2.41' }]);
  });

  it('omitted recordDeployedVersion (no -f/--file given) is unchanged pre-macf#907 behavior — no crash, no write attempted', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      // recordDeployedVersion deliberately absent.
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    expect(calls.upgrade).toEqual(['a']);
  });

  it('a rejected recordDeployedVersion renders LOUD via emit() but does not change the exit code', async () => {
    const { driver, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      recordDeployedVersion: async () => { throw new Error('control repo unreachable'); },
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0); // non-fatal — the roll still succeeded
    const out = lines.join('\n');
    expect(out).toContain('deployed_version write FAILED');
    expect(out).toContain('control repo unreachable');
  });

  it('re-resolves the FRESH endpoint on each verify-green poll after a restart-self port churn (macf#722 Fix A)', async () => {
    // Models the real restart-self behavior: the agent relaunches on a NEW
    // port. The wiring under test is `runFleetUpgrade`'s `probe` closure,
    // which must call `current.probe()` fresh EACH poll (not resolve the
    // endpoint once up front) so it sees the roster's updated port and keeps
    // seeing the (still-online) agent rather than treating the port-flip as
    // an unreachable/offline agent.
    const restarted = new Set<string>();
    let pollsAfterRestart = 0;
    const driver: FleetDriver = {
      probe: async () => {
        if (restarted.has('a')) pollsAfterRestart += 1;
        // Pre-restart: port 4000, version 0.2.40 (old). Post-restart: port
        // CHANGES to 5000 (the restart-self relaunch churn) AND the version
        // flips to target — but only after a couple of polls (modeling
        // registry-propagation lag), so a naive "resolve once" probe would
        // keep querying the DEAD port 4000 and see nothing.
        const port = restarted.has('a') ? 5000 : 4000;
        const version = restarted.has('a') && pollsAfterRestart >= 2 ? '0.2.41' : '0.2.40';
        return {
          agents: [{ name: 'a', host: 'h', port, online: true, version, health: mkHealth(version) }],
        };
      },
      discoverWorkspaces: () => [mkWs('a', 'fleet-1', '0.2.40')],
      isBusy: async () => false,
      isConfigDirty: async () => false,
      listDirtyConfig: async () => [],
      currentBranch: async () => 'main',
      canonicalBranch: async () => 'main',
      classifyDirtyConfig: async () => ({ alreadyCanonical: [], genuineDelta: [] }),
      autoResolveCanonical: async () => {},
      capturePane: async () => null,
      upgrade: async () => {},
      restart: async () => {
        restarted.add('a');
      },
      inject: async () => {},
      launch: async () => {},
      listModifiedFiles: async () => [],
      readVersionPin: async () => null,
      acquireLock: async () => {},
      releaseLock: async () => {},
      startHeartbeat: () => () => {},
    };
    const { deps } = makeDeps({
      discover: () => [mkWs('a', 'fleet-1', '0.2.40')],
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', { execute: true, verifyTimeoutSec: 5 }, deps);
    expect(code).toBe(0);
    expect(pollsAfterRestart).toBeGreaterThanOrEqual(2); // actually polled past the port churn
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

  it('stale-pin (macf#899): agent comes back OLD but its own launch pin never asked for the target — SKIPS, does NOT halt, is MIXED (exit 2, macf#1146)', async () => {
    // Same shape as the 0.2.56-roll incident this issue fixes: the process
    // is reachable at the old version, but the LAUNCHER's own pin still
    // asks for the OLD version too — the release itself was never asked to
    // roll on this workspace, so it must not be blamed / halted for it.
    // Pre-macf#1146 this asserted `code === 0` — "not a halt" was conflated
    // with "success"; the agent above is verifiably still on the old pin,
    // which is exactly the mixed-version state #1146 reports as silently
    // green. It is a skip, not a halt, so it is `2` (MIXED), not `1`.
    const { driver, calls, workspaces } = makeDriver([AGENTS[0]!], {
      base: '0.2.40',
      target: '0.2.41',
      flipOnRestart: false,
      launchPin: () => '0.2.40',
    });
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', { execute: true, verifyTimeoutSec: 0 }, deps);
    expect(code).toBe(2); // stale-pin is a skip, not a halt, but IS mixed (macf#1146)
    expect(calls.upgrade).toEqual(['a']);
    expect(calls.restart).toEqual(['a']);
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
        isConfigDirty: async () => false,
        listDirtyConfig: async () => [],
        currentBranch: async () => 'main',
        canonicalBranch: async () => 'main',
        classifyDirtyConfig: async () => ({ alreadyCanonical: [], genuineDelta: [] }),
        autoResolveCanonical: async () => {},
        capturePane: async () => null,
        upgrade: async (a) => { calls.upgrade.push(a); },
        restart: async (a) => { calls.restart.push(a); restarted.add(a); },
        inject: async () => {},
        launch: async () => {},
        listModifiedFiles: async () => [],
        readVersionPin: async () => null,
        acquireLock: async () => {},
        releaseLock: async () => {},
        startHeartbeat: () => () => {},
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

// --- DR-043 Amendment L, end-to-end through the REAL roll (macf#1045) ------
//
// The pure `resolveTargetVersion` tests above prove the resolution RULE in
// isolation; this proves it through `runFleetUpgrade` itself — the same
// entry point `apply-version.ts` calls (DR-043 Amendment L2) — with the
// REAL driver fixtures from `runFleetUpgrade`'s own describe block above.
// One test proves all three properties the amendment names: delegation is
// real (the roll actually upgrades the pinned-behind agent), the target
// came from the manifest (not from npm), and the network path was
// structurally never entered (the throwing fake fires if it is).

describe('DR-043 Amendment L — manifest-authoritative target, end-to-end through runFleetUpgrade (macf#1045)', () => {
  const AGENTS = [{ name: 'a', registry: 'fleet-1' }] as const;

  it('DECISIVE — manifest pins 0.2.55 (npm-latest would be 0.2.57): the roll targets 0.2.55 AND fetchLatest is never invoked', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.55' });
    const throwingFetchLatest = async (): Promise<string | null> => {
      throw new Error('fetchLatest must not be called — DR-043 Amendment L3, versions.macf is declared');
    };
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      fetchLatest: throwingFetchLatest,
      manifestVersion: { given: true, macf: '0.2.55' },
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    // Delegation is real — the agent actually rolled, to the MANIFEST's version.
    expect(calls.upgrade).toEqual(['a']);
    expect(calls.restart).toEqual(['a']);
    expect(lines.join('\n')).toContain('target macf@0.2.55');
  });

  it('a manifest given but declaring no versions.macf: no version action, no fetch, no roll attempted', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.55' });
    const throwingFetchLatest = async (): Promise<string | null> => {
      throw new Error('fetchLatest must not be called — a manifest was given, even without versions.macf');
    };
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      fetchLatest: throwingFetchLatest,
      manifestVersion: { given: true, macf: undefined },
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0); // no-opinion is not an error
    expect(calls.upgrade).toEqual([]); // nothing rolled — no target was ever resolved
    expect(calls.restart).toEqual([]);
    expect(lines.join('\n')).toMatch(/no opinion/);
  });

  it('omitted manifestVersion (no -f/--file at all): standalone behaviour is byte-identical — npm-latest via fetchLatest', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
      fetchLatest: async () => '0.2.41',
      // manifestVersion deliberately omitted — defaults to NO_MANIFEST_VERSION.
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    expect(calls.upgrade).toEqual(['a']);
  });
});

// --- Mixed-version roll exit code + banner (macf#1146) ----------------------
//
// Before this fix, `renderReport` looked ONLY at `report.halted` — every one
// of the 5 per-agent skip outcomes (`busy-skipped` / `config-dirty-skipped` /
// `branch-skipped` / `stale-pin-skipped` / `not-yet-serving-skipped`) AND a
// whole fleet's driver-unresolved skip rendered success-shaped lines and
// still returned exit 0. Per `assert-the-wrong-path.md`, a single "one
// skipped agent → non-zero" assertion is satisfied by a command that always
// returns non-zero — so each cause is asserted SEPARATELY below, plus the
// decisive pair (mixed vs. fully-green) end-to-end through `runFleetUpgrade`
// with real driver fixtures so the rendered banner text is proven too, not
// just the numeric code.

/** A fully-green `FleetRollResult` (every counter zero, not halted). Override to model one specific outcome. */
function mkRolled(over: Partial<FleetRollResult> = {}): FleetRollResult {
  return {
    results: [],
    halted: false,
    upgraded: 1,
    busySkipped: 0,
    configDirtySkipped: 0,
    configAutoResolved: 0,
    branchSkipped: 0,
    stalePinSkipped: 0,
    notYetServingSkipped: 0,
    ...over,
  };
}

function mkFleetReport(over: Partial<FleetPlanReport> = {}): FleetPlanReport {
  return { fleet: 'g', plans: [], ...over };
}

function mkReport(fleets: readonly FleetPlanReport[], halted = false): FleetUpgradeReport {
  return { target: '0.2.99', fleets, halted };
}

describe('fleetUpgradeExitCode / isMixedVersionRoll (macf#1146) — pure decision, one skip cause at a time', () => {
  it('fully green (no skips, not halted) → 0', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled() })]);
    expect(isMixedVersionRoll(report)).toBe(false);
    expect(fleetUpgradeExitCode(report)).toBe(0);
  });

  it('halted → 1 (UNCHANGED pre-#1146 meaning), regardless of skip counts on the SAME fleet', () => {
    const report = mkReport(
      [mkFleetReport({ rolled: mkRolled({ halted: true, busySkipped: 3 }) })],
      true,
    );
    expect(fleetUpgradeExitCode(report)).toBe(1);
  });

  it('busySkipped > 0, not halted → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ busySkipped: 1 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ busySkipped: 1 }))).toBe(true);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('configDirtySkipped > 0, not halted → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ configDirtySkipped: 1 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ configDirtySkipped: 1 }))).toBe(true);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('branchSkipped > 0, not halted → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ branchSkipped: 1 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ branchSkipped: 1 }))).toBe(true);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('stalePinSkipped > 0, not halted → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ stalePinSkipped: 1 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ stalePinSkipped: 1 }))).toBe(true);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('notYetServingSkipped > 0, not halted → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ notYetServingSkipped: 1 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ notYetServingSkipped: 1 }))).toBe(true);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('configAutoResolved alone (no other skip) → 0 — an auto-resolved file is NOT a left-behind agent', () => {
    const report = mkReport([mkFleetReport({ rolled: mkRolled({ configAutoResolved: 2 }) })]);
    expect(rollLeftAgentBehind(mkRolled({ configAutoResolved: 2 }))).toBe(false);
    expect(isMixedVersionRoll(report)).toBe(false);
    expect(fleetUpgradeExitCode(report)).toBe(0);
  });

  it('a whole fleet SKIPPED (driver-unresolved, no rolled result at all) → 2 (MIXED)', () => {
    const report = mkReport([mkFleetReport({ skipped: 'driver-unresolved' })]);
    expect(isMixedVersionRoll(report)).toBe(true);
    expect(fleetUpgradeExitCode(report)).toBe(2);
  });

  it('DECISIVE — one fleet HALTED + a SEPARATE fleet merely skipped → 1, not 2 (halt takes priority over mixed)', () => {
    const report = mkReport(
      [
        mkFleetReport({ fleet: 'a', rolled: mkRolled({ halted: true }) }),
        mkFleetReport({ fleet: 'b', rolled: mkRolled({ busySkipped: 1 }) }),
      ],
      true,
    );
    expect(fleetUpgradeExitCode(report)).toBe(1);
  });
});

describe('runFleetUpgrade — the decisive pair (macf#1146): mixed vs. fully-green, end-to-end through real driver fixtures', () => {
  const AGENTS = [{ name: 'a', registry: 'fleet-1' }] as const;

  it('DECISIVE (1/2) — one busy-skipped agent, no halt → non-zero exit AND the banner names the mixed state', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, {
      base: '0.2.40',
      target: '0.2.41',
      isBusy: async () => true,
    });
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(2);
    expect(calls.upgrade).toEqual([]); // busy-gated — never even entered the transaction
    const out = lines.join('\n');
    expect(out).toContain('MIXED VERSION FLEET');
    expect(out).toContain('busy-skipped');
  });

  it('DECISIVE (2/2) — a fully-green roll → exit 0, no MIXED banner', async () => {
    const { driver, calls, workspaces } = makeDriver(AGENTS, { base: '0.2.40', target: '0.2.41' });
    const { deps, lines } = makeDeps({
      discover: () => workspaces,
      defaultFleet: 'fleet-1',
      resolveDriver: async () => driver,
    });
    const code = await runFleetUpgrade('/proj', { execute: true }, deps);
    expect(code).toBe(0);
    expect(calls.upgrade).toEqual(['a']);
    expect(lines.join('\n')).not.toContain('MIXED VERSION FLEET');
  });
});

/**
 * `buildCliFetchLatest` (macf#777) — the npm-latest lookup wired into
 * `resolveTargetVersion`'s L2.5 no-manifest path. Before this build, a
 * failed fetch collapsed EVERY cause (network outage, rate-limit, 404,
 * malformed response) into the same generic downstream
 * "could not resolve npm-latest target" — `fetchLatestCliVersion()` already
 * discriminated the cause, but this call site discarded it. These tests
 * assert the discrimination now reaches the operator via `log`, BEFORE
 * `resolveTargetVersion`'s generic message, without changing the return
 * value (`string | null` — control flow untouched, per "diagnosis and
 * reporting, not changing what upgrade does on failure").
 */
describe('buildCliFetchLatest (macf#777)', () => {
  it('a successful fetch returns the value and logs NOTHING — no diagnostic noise on the happy path', async () => {
    const log = vi.fn();
    const fetchLatest = buildCliFetchLatest(
      async (): Promise<FetchResult> => ({ status: 'ok', value: '0.2.99' }),
      log,
    );
    expect(await fetchLatest()).toBe('0.2.99');
    expect(log).not.toHaveBeenCalled();
  });

  it('DECISIVE — a genuine network failure logs the host+cause, names checking connectivity, NOT GH_TOKEN', async () => {
    const log = vi.fn();
    const fetchLatest = buildCliFetchLatest(
      async (): Promise<FetchResult> => ({
        status: 'network_error', value: null, detail: 'registry.npmjs.org: ENOTFOUND',
      }),
      log,
    );
    expect(await fetchLatest()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]![0] as string;
    expect(message).toContain('registry.npmjs.org');
    expect(message).toContain('ENOTFOUND');
    expect(message).not.toContain('GH_TOKEN');
  });

  it('DECISIVE — a rate-limit/auth failure logs the GH_TOKEN remedy, NOT a network cause', async () => {
    const log = vi.fn();
    const fetchLatest = buildCliFetchLatest(
      async (): Promise<FetchResult> => ({
        status: 'rate_limited', value: null, detail: 'registry.npmjs.org',
      }),
      log,
    );
    expect(await fetchLatest()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]![0] as string;
    expect(message).toContain('GH_TOKEN');
    expect(message).not.toContain('ENOTFOUND');
    expect(message).not.toContain('ECONNREFUSED');
  });

  it('DECISIVE — the two failure messages are genuinely different strings, not a shared generic one', async () => {
    const networkLog = vi.fn();
    await buildCliFetchLatest(
      async (): Promise<FetchResult> => ({
        status: 'network_error', value: null, detail: 'registry.npmjs.org: ENOTFOUND',
      }),
      networkLog,
    )();
    const rateLimitedLog = vi.fn();
    await buildCliFetchLatest(
      async (): Promise<FetchResult> => ({ status: 'rate_limited', value: null, detail: 'registry.npmjs.org' }),
      rateLimitedLog,
    )();
    expect(networkLog.mock.calls[0]![0]).not.toBe(rateLimitedLog.mock.calls[0]![0]);
  });

});
