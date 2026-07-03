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
  ROLL_TOUCHED_CONFIG_PATTERNS,
  type FleetDriver,
  type FleetState,
  type WorkspaceRecord,
  type HealthResponse,
  type UpgradeEvent,
  type VerifyGreenOptions,
  type VerifyGreenResult,
} from '../src/index.js';

// --- ROLL_TOUCHED_CONFIG_PATTERNS (DR-040 Decision 6, macf#698) -------------
//
// Pins the meaningful config-surface UNION (macf#725: the macf-update
// overwrite set ∪ the operator-evolution files) so a future edit to the
// constant is a deliberate, reviewed change rather than a silent drift. The
// `.claude/**` wildcard was the ONLY bug (it swept in runtime logs / scratch);
// this pins that it's gone while the meaningful members — including the
// operator-evolution `CLAUDE.md` / `env.local.*` half that must NOT be
// silently stashed by restart-self's excludeConfigSurface — are preserved.
// The real git-backed matching behavior (a dirty .claude/audit.log NOT
// flagged; a dirty claude.sh / .claude/settings.json / .claude/rules/** /
// .claude/scripts/** / managed .claude/.macf/env.* / CLAUDE.md IS flagged) is
// exercised against a REAL git repo in packages/macf's
// `test/cli/fleet/vm-driver.test.ts` ("createVmExecSeams — real git" suite) —
// this test only pins the array CONTENT.

describe('ROLL_TOUCHED_CONFIG_PATTERNS (DR-040 Decision 6, macf#698)', () => {
  it('is the meaningful union — managed overwrite set ∪ operator-evolution files; no .claude/** wildcard', () => {
    expect(ROLL_TOUCHED_CONFIG_PATTERNS).toEqual([
      // (a) the exact macf-update overwrite set:
      'claude.sh',
      '.claude/rules/**',
      '.claude/scripts/**',
      '.claude/settings.json',
      '.claude/.macf/env._helpers',
      '.claude/.macf/env.identity',
      '.claude/.macf/env.github',
      '.claude/.macf/env.certs',
      '.claude/.macf/env.registry',
      '.claude/.macf/host-prelude.sh',
      // (b) operator-evolution files kept per macf#725 (must-not-silently-stash):
      'CLAUDE.md',
      'env.local.*',
    ]);
    // The wildcard that swept in runtime logs / scratch is GONE (macf#698)...
    expect(ROLL_TOUCHED_CONFIG_PATTERNS).not.toContain('.claude/**');
    // ...but the operator-evolution union half is PRESERVED (macf#725).
    expect(ROLL_TOUCHED_CONFIG_PATTERNS).toContain('CLAUDE.md');
    expect(ROLL_TOUCHED_CONFIG_PATTERNS).toContain('env.local.*');
  });
});

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
  classifyDirtyConfig: string[];
  autoResolveCanonical: { agent: string; files: readonly string[] }[];
  upgrade: string[];
  restart: string[];
  restartLeaveUncommitted: string[];
  listModifiedFiles: string[];
  /** DR-040 Decision 4 (macf#752) — maintenance-lock SET-side call log. */
  acquireLock: { agent: string; target: string }[];
  releaseLock: string[];
  startHeartbeat: string[];
  stopHeartbeat: string[];
  /** macf#755 branch-gate call logs — which agents had their branch checked. */
  currentBranch: string[];
  canonicalBranch: string[];
  /** A single ordered event log across ALL verbs (tagged `"<verb>:<agent>"`), for sequencing assertions. */
  order: string[];
}

/**
 * A recording fake driver. `busy(agent, callIdx)` decides isBusy per call.
 * `dirtyConfigFiles(agent)` returns the pre-flight GENUINE-DELTA files (still
 * objects; defaults none) and `alreadyCanonicalFiles(agent)` returns the
 * ALREADY-CANONICAL files (auto-resolved/committed; defaults none) — the two
 * tiers `classifyDirtyConfig` splits into (DR-040 Decision 3 / macf#698 R1).
 * A STATIC predicate; use `makeTransactionalDriver` below when a test needs
 * `upgrade()` to actually COUPLE into post-upgrade state (macf#725 — this
 * static fake can't surface the #722/#725 mid-transaction bug class, since
 * its dirty-check never reacts to `upgrade` having run).
 */
function makeDriver(opts: {
  state: FleetState;
  workspaces: readonly WorkspaceRecord[];
  busy?: (agent: string, callIdx: number) => boolean;
  /** Agents' pre-flight GENUINE-DELTA files (still objects); defaults to none. */
  dirtyConfigFiles?: (agent: string) => readonly string[];
  /** Agents' pre-flight ALREADY-CANONICAL files (auto-resolved); defaults to none. */
  alreadyCanonicalFiles?: (agent: string) => readonly string[];
  /** Modified-files list `listModifiedFiles` reports post-upgrade; defaults to none. */
  modifiedFiles?: (agent: string) => readonly string[];
  /** Per-agent CURRENT branch (macf#755); defaults to `'main'` for every agent (on-canonical). */
  branch?: (agent: string) => string | null;
  /** Per-agent CANONICAL branch (macf#755); defaults to `'main'` for every agent. */
  canonicalBranchOf?: (agent: string) => string;
}): { driver: FleetDriver; calls: DriverCalls } {
  const calls: DriverCalls = {
    probe: 0,
    discover: 0,
    isBusy: [],
    classifyDirtyConfig: [],
    autoResolveCanonical: [],
    upgrade: [],
    restart: [],
    restartLeaveUncommitted: [],
    listModifiedFiles: [],
    acquireLock: [],
    releaseLock: [],
    startHeartbeat: [],
    stopHeartbeat: [],
    currentBranch: [],
    canonicalBranch: [],
    order: [],
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
    isConfigDirty: async (agent) =>
      ((opts.dirtyConfigFiles?.(agent)?.length ?? 0) + (opts.alreadyCanonicalFiles?.(agent)?.length ?? 0)) > 0,
    listDirtyConfig: async (agent) => [
      ...(opts.alreadyCanonicalFiles?.(agent) ?? []),
      ...(opts.dirtyConfigFiles?.(agent) ?? []),
    ],
    currentBranch: async (agent) => {
      calls.currentBranch.push(agent);
      return opts.branch ? opts.branch(agent) : 'main';
    },
    canonicalBranch: async (agent) => {
      calls.canonicalBranch.push(agent);
      return opts.canonicalBranchOf ? opts.canonicalBranchOf(agent) : 'main';
    },
    classifyDirtyConfig: async (agent) => {
      calls.classifyDirtyConfig.push(agent);
      return {
        alreadyCanonical: opts.alreadyCanonicalFiles ? opts.alreadyCanonicalFiles(agent) : [],
        genuineDelta: opts.dirtyConfigFiles ? opts.dirtyConfigFiles(agent) : [],
      };
    },
    autoResolveCanonical: async (agent, files) => {
      calls.autoResolveCanonical.push({ agent, files });
    },
    capturePane: async () => null,
    upgrade: async (agent) => {
      calls.upgrade.push(agent);
      calls.order.push(`upgrade:${agent}`);
    },
    restart: async (agent, restartOpts) => {
      calls.restart.push(agent);
      calls.order.push(`restart:${agent}`);
      if (restartOpts?.leaveConfigUncommitted) calls.restartLeaveUncommitted.push(agent);
    },
    inject: async () => {},
    launch: async () => {},
    acquireLock: async (agent, target) => {
      calls.acquireLock.push({ agent, target });
      calls.order.push(`acquireLock:${agent}`);
    },
    releaseLock: async (agent) => {
      calls.releaseLock.push(agent);
      calls.order.push(`releaseLock:${agent}`);
    },
    startHeartbeat: (agent) => {
      calls.startHeartbeat.push(agent);
      calls.order.push(`startHeartbeat:${agent}`);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        calls.stopHeartbeat.push(agent);
        calls.order.push(`stopHeartbeat:${agent}`);
      };
    },
    listModifiedFiles: async (agent) => {
      calls.listModifiedFiles.push(agent);
      return opts.modifiedFiles ? opts.modifiedFiles(agent) : [];
    },
  };
  return { driver, calls };
}

/**
 * A REAL coupled fake (macf#725) — `upgrade()` actually DIRTIES the
 * workspace's config surface, and `restart()` THROWS unless told
 * `leaveConfigUncommitted: true`. This is what proves the transactional fix:
 * a static `dirtyConfigFiles` predicate (as in `makeDriver`) can report
 * "clean" pre-flight and never react to `upgrade` having run, which is
 * EXACTLY the shape that let the macf#722 bug (upgrade dirties → restart
 * refuses, aborting mid-transaction) hide from the original test suite.
 */
function makeTransactionalDriver(opts: {
  state: FleetState;
  workspaces: readonly WorkspaceRecord[];
  /** Agents whose config surface is dirty BEFORE any roll touches them. */
  preDirty?: ReadonlySet<string>;
  /** Files `upgrade()` regenerates (becomes the post-upgrade dirty/modified set). */
  regeneratedFiles?: readonly string[];
}): { driver: FleetDriver; calls: DriverCalls } {
  const calls: DriverCalls = {
    probe: 0,
    discover: 0,
    isBusy: [],
    classifyDirtyConfig: [],
    autoResolveCanonical: [],
    upgrade: [],
    restart: [],
    restartLeaveUncommitted: [],
    listModifiedFiles: [],
    acquireLock: [],
    releaseLock: [],
    startHeartbeat: [],
    stopHeartbeat: [],
    currentBranch: [],
    canonicalBranch: [],
    order: [],
  };
  const regenerated = opts.regeneratedFiles ?? ['.claude/rules/coordination.md'];
  // COUPLED STATE: which agents currently have dirty config — starts as
  // `preDirty`, and `upgrade()` ADDS the agent (real `macf update` always
  // dirties the managed surface). `restart()` reads this SAME state to decide
  // whether it would need to refuse/stash — proving the two verbs are talking
  // to the same underlying workspace, not independent static predicates.
  // Everything this fake reports dirty is treated as GENUINE-DELTA (never
  // already-canonical) — these tests exercise the transactional coupling,
  // not the DR-040 tiering (that's `makeDriver`'s job via `alreadyCanonicalFiles`).
  const dirty = new Set(opts.preDirty ?? []);
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
      calls.isBusy.push(agent);
      return false;
    },
    isConfigDirty: async (agent) => dirty.has(agent),
    listDirtyConfig: async (agent) => (dirty.has(agent) ? regenerated : []),
    currentBranch: async (agent) => {
      calls.currentBranch.push(agent);
      return 'main';
    },
    canonicalBranch: async (agent) => {
      calls.canonicalBranch.push(agent);
      return 'main';
    },
    classifyDirtyConfig: async (agent) => {
      calls.classifyDirtyConfig.push(agent);
      return { alreadyCanonical: [], genuineDelta: dirty.has(agent) ? regenerated : [] };
    },
    autoResolveCanonical: async (agent, files) => {
      calls.autoResolveCanonical.push({ agent, files });
    },
    capturePane: async () => null,
    upgrade: async (agent) => {
      calls.upgrade.push(agent);
      // REAL `macf update` semantics: upgrading ALWAYS dirties the managed
      // config surface (it just regenerated `.claude/**` etc).
      dirty.add(agent);
    },
    restart: async (agent, restartOpts) => {
      calls.restart.push(agent);
      if (restartOpts?.leaveConfigUncommitted) {
        calls.restartLeaveUncommitted.push(agent);
        // Leaves the config surface uncommitted — dirty state persists (this
        // IS the intended post-roll state the relaunched agent should see).
        return;
      }
      // STANDALONE semantics (macf#722 Fix B): refuses outright when the
      // config surface is dirty and it was NOT told to leave it uncommitted.
      if (dirty.has(agent)) {
        throw new Error(`restart-self would refuse: uncommitted config surface for ${agent}`);
      }
    },
    inject: async () => {},
    launch: async () => {},
    acquireLock: async (agent, target) => {
      calls.acquireLock.push({ agent, target });
      calls.order.push(`acquireLock:${agent}`);
    },
    releaseLock: async (agent) => {
      calls.releaseLock.push(agent);
      calls.order.push(`releaseLock:${agent}`);
    },
    startHeartbeat: (agent) => {
      calls.startHeartbeat.push(agent);
      calls.order.push(`startHeartbeat:${agent}`);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        calls.stopHeartbeat.push(agent);
        calls.order.push(`stopHeartbeat:${agent}`);
      };
    },
    listModifiedFiles: async (agent) => {
      calls.listModifiedFiles.push(agent);
      return dirty.has(agent) ? regenerated : [];
    },
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

  it('rolls behind agents in order: upgrade → restart(leaveConfigUncommitted) → verify-green, all green', async () => {
    const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
    const { verifyGreen, seen } = makeVerify();
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
    });
    expect(calls.upgrade).toEqual(['a1', 'a2']);
    expect(calls.restart).toEqual(['a1', 'a2']);
    // EVERY roll-transaction restart leaves the config surface uncommitted —
    // this is unconditional (not gated on --force), unlike the pre-flight gate.
    expect(calls.restartLeaveUncommitted).toEqual(['a1', 'a2']);
    expect(seen).toEqual(['a1', 'a2']);
    expect(res.halted).toBe(false);
    expect(res.upgraded).toBe(2);
    expect(res.results.map((r) => r.outcome)).toEqual(['upgraded', 'upgraded']);
    // DR-040 Decision 4 (macf#752) — every clean-green roll acquires +
    // releases the maintenance lock exactly once per agent.
    expect(calls.acquireLock).toEqual([
      { agent: 'a1', target: '0.2.41' },
      { agent: 'a2', target: '0.2.41' },
    ]);
    expect(calls.releaseLock).toEqual(['a1', 'a2']);
  });

  it('config-dirty PRE-FLIGHT gate: OBJECTS with the file list + message BEFORE any mutation, and continues (macf#725)', async () => {
    const dirtyFiles = ['.claude/rules/coordination.md', 'CLAUDE.md'];
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      dirtyConfigFiles: (agent) => (agent === 'a1' ? dirtyFiles : []),
    });
    const { verifyGreen } = makeVerify();
    const events: UpgradeEvent[] = [];
    const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
      onEvent: (ev) => events.push(ev),
    });
    // a1 never touched — no upgrade/restart/isBusy call at all for a1.
    expect(calls.classifyDirtyConfig).toEqual(['a1', 'a2']);
    expect(calls.upgrade).toEqual(['a2']);
    expect(calls.restart).toEqual(['a2']);
    expect(calls.isBusy).toEqual(['a2']); // a1's busy-gate never even runs
    // a1 was pre-flight-gated BEFORE entering the transaction — the
    // maintenance lock is never touched for it (macf#752).
    expect(calls.acquireLock.map((c) => c.agent)).toEqual(['a2']);
    expect(res.halted).toBe(false);
    expect(res.configDirtySkipped).toBe(1);
    expect(res.upgraded).toBe(1);
    expect(res.results.map((r) => [r.agent, r.outcome])).toEqual([
      ['a1', 'config-dirty-skipped'],
      ['a2', 'upgraded'],
    ]);
    // The result's `detail` carries the full agent-directed message.
    expect(res.results[0]!.detail).toContain('a1');
    expect(res.results[0]!.detail).toContain(dirtyFiles[0]!);
    expect(res.results[0]!.detail).toContain('commit');
    // The onEvent carries the exact file list + message separately (macf#725).
    const skipEvent = events.find((e) => e.kind === 'config-dirty-skip');
    expect(skipEvent).toMatchObject({ kind: 'config-dirty-skip', agent: 'a1', files: dirtyFiles });
    expect(skipEvent && 'message' in skipEvent ? skipEvent.message : '').toContain('a1');
  });

  it('--force bypasses the config-dirty OBJECT gate AND leaves the (pre-existing dirty) config surface uncommitted, not stashed', async () => {
    const { driver, calls } = makeDriver({
      state: mkState([]),
      workspaces: [],
      dirtyConfigFiles: () => ['CLAUDE.md'],
    });
    const { verifyGreen } = makeVerify();
    const res = await rollFleet(
      twoBehind,
      { targetVersion: '0.2.41', verifyTimeoutMs: 1000, force: true },
      { driver, verifyGreen, ...noWait },
    );
    expect(res.configDirtySkipped).toBe(0);
    expect(res.configAutoResolved).toBe(0);
    // --force bypasses the gate ENTIRELY (DR-040 Decision 3 / macf#698 R1) —
    // classifyDirtyConfig / autoResolveCanonical are never even called.
    expect(calls.classifyDirtyConfig).toEqual([]);
    expect(calls.autoResolveCanonical).toEqual([]);
    expect(calls.upgrade).toEqual(['a1', 'a2']);
    expect(calls.restart).toEqual(['a1', 'a2']);
    // both agents' restart was told to leave the (dirty) config surface uncommitted.
    expect(calls.restartLeaveUncommitted).toEqual(['a1', 'a2']);
    expect(res.halted).toBe(false);
  });

  describe('branch-gate (macf#755) — the FIRST pre-flight gate', () => {
    it('on-canonical: proceeds into the normal gate chain (config-dirty, then busy, then the transaction)', async () => {
      const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(calls.currentBranch).toEqual(['a1', 'a2']);
      expect(calls.canonicalBranch).toEqual(['a1', 'a2']);
      expect(calls.classifyDirtyConfig).toEqual(['a1', 'a2']);
      expect(calls.upgrade).toEqual(['a1', 'a2']);
      expect(res.branchSkipped).toBe(0);
      expect(res.upgraded).toBe(2);
    });

    it('off-canonical: OBJECTS (branch-skipped) BEFORE any mutation — classifyDirtyConfig/isBusy/upgrade/restart NEVER called for that agent', async () => {
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        branch: (agent) => (agent === 'a1' ? 'feat/some-branch' : 'main'),
      });
      const { verifyGreen } = makeVerify();
      const events: UpgradeEvent[] = [];
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
        onEvent: (ev) => events.push(ev),
      });
      // a1 never touched at all — no classifyDirtyConfig/isBusy/upgrade/restart/lock call.
      expect(calls.classifyDirtyConfig).toEqual(['a2']);
      expect(calls.isBusy).toEqual(['a2']);
      expect(calls.upgrade).toEqual(['a2']);
      expect(calls.restart).toEqual(['a2']);
      expect(calls.acquireLock.map((c) => c.agent)).toEqual(['a2']);
      expect(res.halted).toBe(false);
      expect(res.branchSkipped).toBe(1);
      expect(res.upgraded).toBe(1);
      expect(res.results.map((r) => [r.agent, r.outcome])).toEqual([
        ['a1', 'branch-skipped'],
        ['a2', 'upgraded'],
      ]);
      expect(res.results[0]!.detail).toContain('a1');
      expect(res.results[0]!.detail).toContain('feat/some-branch');
      expect(res.results[0]!.detail).toContain('main');
      const skipEvent = events.find((e) => e.kind === 'branch-skip');
      expect(skipEvent).toMatchObject({
        kind: 'branch-skip',
        agent: 'a1',
        current: 'feat/some-branch',
        canonical: 'main',
      });
    });

    it('detached HEAD / unresolvable branch (currentBranch → null) is treated as non-canonical → OBJECTS', async () => {
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        branch: (agent) => (agent === 'a1' ? null : 'main'),
      });
      const { verifyGreen } = makeVerify();
      const events: UpgradeEvent[] = [];
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
        onEvent: (ev) => events.push(ev),
      });
      expect(calls.upgrade).toEqual(['a2']);
      expect(res.branchSkipped).toBe(1);
      expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'branch-skipped' });
      expect(res.results[0]!.detail).toContain('detached HEAD');
      const skipEvent = events.find((e) => e.kind === 'branch-skip');
      expect(skipEvent).toMatchObject({ kind: 'branch-skip', agent: 'a1', current: null, canonical: 'main' });
    });

    it('--force bypasses the branch-gate ENTIRELY — currentBranch/canonicalBranch never even called', async () => {
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        branch: () => 'feat/some-branch',
      });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet(
        twoBehind,
        { targetVersion: '0.2.41', verifyTimeoutMs: 1000, force: true },
        { driver, verifyGreen, ...noWait },
      );
      expect(calls.currentBranch).toEqual([]);
      expect(calls.canonicalBranch).toEqual([]);
      expect(res.branchSkipped).toBe(0);
      expect(calls.upgrade).toEqual(['a1', 'a2']);
      expect(res.halted).toBe(false);
    });

    it('precedes the config-dirty gate: a dirty-AND-off-branch agent reports branch-skip, NOT config-dirty-skip', async () => {
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        branch: (agent) => (agent === 'a1' ? 'feat/some-branch' : 'main'),
        dirtyConfigFiles: (agent) => (agent === 'a1' ? ['CLAUDE.md'] : []),
      });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      // classifyDirtyConfig is never called for a1 — the branch-gate short-circuits first.
      expect(calls.classifyDirtyConfig).toEqual(['a2']);
      expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'branch-skipped' });
      expect(res.branchSkipped).toBe(1);
      expect(res.configDirtySkipped).toBe(0);
    });
  });

  describe('tier-first auto-resolve (DR-040 Decision 3, macf#698 R1)', () => {
    it('an agent whose ENTIRE dirty set is already-canonical: auto-resolved (committed), NOT objected, roll PROCEEDS into the transaction', async () => {
      const canonicalFiles = ['.claude/rules/coordination.md', '.claude/.macf/env.identity'];
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        alreadyCanonicalFiles: (agent) => (agent === 'a1' ? canonicalFiles : []),
      });
      const { verifyGreen } = makeVerify();
      const events: UpgradeEvent[] = [];
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
        onEvent: (ev) => events.push(ev),
      });
      expect(calls.classifyDirtyConfig).toEqual(['a1', 'a2']);
      expect(calls.autoResolveCanonical).toEqual([{ agent: 'a1', files: canonicalFiles }]);
      // NOT objected — a1 proceeds through the FULL transaction like a clean agent.
      expect(calls.upgrade).toEqual(['a1', 'a2']);
      expect(calls.restart).toEqual(['a1', 'a2']);
      expect(res.halted).toBe(false);
      expect(res.configDirtySkipped).toBe(0);
      expect(res.configAutoResolved).toBe(1);
      expect(res.upgraded).toBe(2);
      expect(res.results.map((r) => [r.agent, r.outcome])).toEqual([
        ['a1', 'upgraded'],
        ['a2', 'upgraded'],
      ]);
      // The auto-resolved files are annotated on a1's (upgraded) result.
      expect(res.results[0]!.autoResolvedFiles).toEqual(canonicalFiles);
      expect(res.results[1]!.autoResolvedFiles).toBeUndefined();
      const autoResolvedEvent = events.find((e) => e.kind === 'config-auto-resolved');
      expect(autoResolvedEvent).toMatchObject({ kind: 'config-auto-resolved', agent: 'a1', files: canonicalFiles });
      // Fired BEFORE the transaction started for a1.
      const a1RollStartIdx = events.findIndex((e) => e.kind === 'roll-start' && e.agent === 'a1');
      const autoResolvedIdx = events.findIndex((e) => e.kind === 'config-auto-resolved');
      expect(autoResolvedIdx).toBeGreaterThanOrEqual(0);
      expect(autoResolvedIdx).toBeLessThan(a1RollStartIdx);
    });

    it('a MIXED dirty set: auto-resolves the already-canonical subset AND objects on the genuine-delta subset only — upgrade NOT called', async () => {
      const canonical = ['.claude/scripts/macf-gh-token.sh'];
      const genuine = ['CLAUDE.md'];
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        alreadyCanonicalFiles: (agent) => (agent === 'a1' ? canonical : []),
        dirtyConfigFiles: (agent) => (agent === 'a1' ? genuine : []),
      });
      const { verifyGreen } = makeVerify();
      const events: UpgradeEvent[] = [];
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
        onEvent: (ev) => events.push(ev),
      });
      // Auto-resolve STILL runs on the canonical subset...
      expect(calls.autoResolveCanonical).toEqual([{ agent: 'a1', files: canonical }]);
      // ...but a1 is objected on (never upgraded/restarted) because genuine-delta remains.
      expect(calls.upgrade).toEqual(['a2']);
      expect(calls.restart).toEqual(['a2']);
      expect(res.configAutoResolved).toBe(1);
      expect(res.configDirtySkipped).toBe(1);
      expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'config-dirty-skipped' });
      expect(res.results[0]!.autoResolvedFiles).toEqual(canonical);
      // The OBJECT message + config-dirty-skip event carry ONLY the genuine-delta
      // files — the auto-resolved noise is never re-surfaced as something to inspect.
      expect(res.results[0]!.detail).toContain(genuine[0]!);
      expect(res.results[0]!.detail).not.toContain(canonical[0]!);
      const skipEvent = events.find((e) => e.kind === 'config-dirty-skip');
      expect(skipEvent).toMatchObject({ kind: 'config-dirty-skip', agent: 'a1', files: genuine });
    });

    it('both tiers empty (nothing dirty): proceeds normally, no auto-resolve, no object', async () => {
      const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(calls.autoResolveCanonical).toEqual([]);
      expect(res.configAutoResolved).toBe(0);
      expect(res.configDirtySkipped).toBe(0);
      expect(res.upgraded).toBe(2);
      expect(calls.upgrade).toEqual(['a1', 'a2']);
    });
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
    // a1 was busy-gated BEFORE entering the transaction — never locked (macf#752).
    expect(calls.acquireLock.map((c) => c.agent)).toEqual(['a2']);
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
    // DR-040 Decision 3/4 (macf#752) — HALT stops the heartbeat but LEAVES
    // the lock in place; it is never released on a halted roll.
    expect(calls.stopHeartbeat).toEqual(['a1']);
    expect(calls.releaseLock).toEqual([]);
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

  it('post-upgrade: reports the modified-files list + message once green (macf#725)', async () => {
    const modified = ['.claude/rules/coordination.md', '.claude/.macf/env.identity'];
    const { driver } = makeDriver({
      state: mkState([]),
      workspaces: [],
      modifiedFiles: (agent) => (agent === 'a1' ? modified : []),
    });
    const { verifyGreen } = makeVerify();
    const events: UpgradeEvent[] = [];
    const res = await rollFleet([twoBehind[0]!], { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
      driver,
      verifyGreen,
      ...noWait,
      onEvent: (ev) => events.push(ev),
    });
    expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'upgraded' });
    expect(res.results[0]!.detail).toContain('a1');
    expect(res.results[0]!.detail).toContain(modified[0]!);
    // The steady-state clause (macf#725): the message must direct the agent to
    // COMMIT the regen (not just review it), so the next roll's pre-flight
    // doesn't re-flag it as uncommitted.
    expect(res.results[0]!.detail).toContain('commit them');
    expect(res.results[0]!.detail).toContain("next upgrade's pre-flight");
    const upgradedEvent = events.find((e) => e.kind === 'upgraded');
    expect(upgradedEvent).toMatchObject({ kind: 'upgraded', agent: 'a1', version: '0.2.41', modifiedFiles: modified });
    expect(upgradedEvent && 'message' in upgradedEvent ? upgradedEvent.message : '').toContain('a1');
    expect(upgradedEvent && 'message' in upgradedEvent ? upgradedEvent.message : '').toContain('commit them');
  });

  describe('transactional coupling (macf#725 — REAL coupled fake, not a static predicate)', () => {
    it('clean pre-flight: upgrade dirties the workspace, restart is told to leave it uncommitted (NOT stash, NOT refuse)', async () => {
      const { driver, calls } = makeTransactionalDriver({ state: mkState([]), workspaces: [] });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet([twoBehind[0]!], { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      // Pre-flight saw CLEAN (preDirty is empty) — entered the transaction.
      expect(calls.classifyDirtyConfig).toEqual(['a1']);
      expect(calls.upgrade).toEqual(['a1']); // this is what DIRTIES the workspace
      // restart() was called with leaveConfigUncommitted — did NOT throw despite
      // the workspace now being dirty (proving the fake's restart() actually
      // reacts to upgrade()'s side effect, not a static "always ok" stub).
      expect(calls.restart).toEqual(['a1']);
      expect(calls.restartLeaveUncommitted).toEqual(['a1']);
      expect(res.halted).toBe(false);
      expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'upgraded' });
    });

    it('a pre-flight-dirty agent is OBJECTED on and NEVER reaches upgrade/restart at all', async () => {
      const { driver, calls } = makeTransactionalDriver({
        state: mkState([]),
        workspaces: [],
        preDirty: new Set(['a1']),
      });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet([twoBehind[0]!], { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(calls.classifyDirtyConfig).toEqual(['a1']);
      expect(calls.upgrade).toEqual([]); // NOTHING mutated
      expect(calls.restart).toEqual([]);
      expect(res.results[0]).toMatchObject({ agent: 'a1', outcome: 'config-dirty-skipped' });
      expect(res.configDirtySkipped).toBe(1);
    });

    it('reproduces + proves the macf#722 bug is CLOSED: without leaveConfigUncommitted, restart would have refused mid-transaction', async () => {
      // Sanity-check the fake's own coupling: if rollFleet had (incorrectly,
      // pre-macf#725) called restart WITHOUT leaveConfigUncommitted after an
      // upgrade, the transactional fake throws — this is the exact mid-transaction
      // abort shape macf#722/#725 fixed. Exercise the fake directly to pin it.
      const { driver } = makeTransactionalDriver({ state: mkState([]), workspaces: [] });
      await driver.upgrade('a1'); // dirties the workspace, as real `macf update` does
      await expect(driver.restart('a1')).rejects.toThrow(/would refuse/);
      // But WITH leaveConfigUncommitted (what rollFleet actually does), it's fine:
      await expect(driver.restart('a1', { leaveConfigUncommitted: true })).resolves.toBeUndefined();
    });
  });

  describe('maintenance lock (DR-040 Decision 4, macf-devops-toolkit#158/#159, macf#752)', () => {
    it('acquires BEFORE upgrade, keeps the heartbeat running through upgrade+restart, and releases ONLY on GREEN', async () => {
      const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
      const { verifyGreen } = makeVerify();
      await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(calls.acquireLock).toEqual([
        { agent: 'a1', target: '0.2.41' },
        { agent: 'a2', target: '0.2.41' },
      ]);
      expect(calls.releaseLock).toEqual(['a1', 'a2']);
      // Exact per-agent ordering: acquire → start-heartbeat → upgrade →
      // restart → stop-heartbeat → release, for EACH agent in turn.
      expect(calls.order).toEqual([
        'acquireLock:a1',
        'startHeartbeat:a1',
        'upgrade:a1',
        'restart:a1',
        'stopHeartbeat:a1',
        'releaseLock:a1',
        'acquireLock:a2',
        'startHeartbeat:a2',
        'upgrade:a2',
        'restart:a2',
        'stopHeartbeat:a2',
        'releaseLock:a2',
      ]);
    });

    it('HALT stops the heartbeat but LEAVES the lock in place (DR-040 Decision 3) — releaseLock is never called for the halted agent', async () => {
      const { driver, calls } = makeDriver({ state: mkState([]), workspaces: [] });
      const { verifyGreen } = makeVerify({
        a1: { ok: false, reason: 'unreachable', lastVersion: null },
      });
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(res.halted).toBe(true);
      expect(calls.acquireLock).toEqual([{ agent: 'a1', target: '0.2.41' }]);
      expect(calls.startHeartbeat).toEqual(['a1']);
      expect(calls.stopHeartbeat).toEqual(['a1']); // the background loop IS stopped...
      expect(calls.releaseLock).toEqual([]); // ...but the lock itself is NOT released
      expect(calls.order).toEqual(['acquireLock:a1', 'startHeartbeat:a1', 'upgrade:a1', 'restart:a1', 'stopHeartbeat:a1']);
      // a2 was never reached at all — no lock activity for it either.
      expect(calls.acquireLock.some((c) => c.agent === 'a2')).toBe(false);
    });

    it('config-dirty-skip and busy-skip never touch the maintenance lock (the agent was never mutated)', async () => {
      const { driver, calls } = makeDriver({
        state: mkState([]),
        workspaces: [],
        dirtyConfigFiles: (agent) => (agent === 'a1' ? ['CLAUDE.md'] : []),
        busy: (agent) => agent === 'a2',
      });
      const { verifyGreen } = makeVerify();
      const res = await rollFleet(twoBehind, { targetVersion: '0.2.41', verifyTimeoutMs: 1000 }, {
        driver,
        verifyGreen,
        ...noWait,
      });
      expect(res.results.map((r) => r.outcome)).toEqual(['config-dirty-skipped', 'busy-skipped']);
      expect(calls.acquireLock).toEqual([]);
      expect(calls.startHeartbeat).toEqual([]);
      expect(calls.releaseLock).toEqual([]);
    });
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
    // DR-040 Decision 4 (macf#752) — dry-run never calls `rollFleet` at all,
    // so the maintenance lock is never touched.
    expect(calls.acquireLock).toEqual([]);
    expect(calls.startHeartbeat).toEqual([]);
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
