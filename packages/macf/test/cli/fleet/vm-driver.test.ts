/**
 * Tests for the VM `FleetDriver` (DR-037 Decision 3). Every side effect is a
 * fake seam that RECORDS its call, so the orchestration is verified without real
 * tmux / processes / network. The load-bearing cases:
 *   - probe: registry roster → FleetState, version pulled up, offline handled.
 *   - discoverWorkspaces: passes the scan through.
 *   - isBusy: capture-pane content-DIFF gate (busy on change, idle on same, dead
 *     → not busy, unreadable-live-pane → conservatively busy).
 *   - upgrade: `macf update --yes` in the target workspace; unknown agent throws.
 *   - restart: alive → `macf restart-self --confirm`; dead → launch.
 *   - inject: canonical submit into the derived session; no-project → throws.
 *   - launch: spawn ./claude.sh detached in the workspace.
 *   - resolveTarget: <project>@<routing-label> derivation + routing-label fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetDriverError, planFleetUpgrade } from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse, WorkspaceRecord } from '@groundnuty/macf-core';
import {
  createVmDriver,
  createVmExecSeams,
  resolveTarget,
  type VmDriverSeams,
  type WorkspaceIdentity,
} from '../../../src/cli/fleet/vm-driver.js';
import { gatherFleetStatus } from '../../../src/cli/commands/fleet.js';

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

function mkInfo(host: string, port: number): AgentInfo {
  return { host, port, type: 'permanent', instance_id: 'i', started: '2026-07-01T00:00:00Z' };
}

const WS_CODE: WorkspaceRecord = {
  agent: 'code-agent',
  workspace: '/w/macf',
  registry: 'groundnuty',
  project: 'macf',
  versionPin: '0.2.41',
};
const WS_SCIENCE: WorkspaceRecord = {
  agent: 'science-agent',
  workspace: '/w/science',
  registry: 'groundnuty',
  project: 'macf',
  versionPin: '0.2.41',
};

interface Recorder {
  readonly execs: { bin: string; args: readonly string[]; cwd: string }[];
  readonly spawns: { bin: string; args: readonly string[]; cwd: string }[];
  readonly submits: { session: string; text: string }[];
  readonly sleeps: number[];
  readonly captured: string[];
}

/** Per-call capturePane return values (drained in order; repeats last). */
interface SeamOverrides {
  readonly workspaces?: readonly WorkspaceRecord[];
  readonly config?: (dir: string) => WorkspaceIdentity | null;
  readonly liveSessions?: ReadonlySet<string>;
  readonly paneReads?: readonly (string | null)[];
  readonly peers?: readonly { readonly name: string; readonly info: AgentInfo }[];
  readonly health?: (host: string, port: number) => Promise<HealthResponse | null>;
  readonly configDirtyWorkspaces?: ReadonlySet<string>;
  /** Per-workspace dirty-config file lists for `listDirtyConfig` (macf#725). */
  readonly dirtyConfigFiles?: ReadonlyMap<string, readonly string[]>;
  /** Per-workspace modified-file lists for `listModifiedFiles` (macf#725). */
  readonly modifiedFiles?: ReadonlyMap<string, readonly string[]>;
}

function fakeSeams(o: SeamOverrides = {}): { seams: VmDriverSeams; rec: Recorder } {
  const rec: Recorder = { execs: [], spawns: [], submits: [], sleeps: [], captured: [] };
  const paneQueue = [...(o.paneReads ?? [])];
  const live = o.liveSessions ?? new Set<string>();
  const dirtyWorkspaces = o.configDirtyWorkspaces ?? new Set<string>();
  const seams: VmDriverSeams = {
    listPeers: async () => o.peers ?? [],
    probeHealth: o.health ?? (async () => null),
    discover: () => o.workspaces ?? [WS_CODE, WS_SCIENCE],
    readConfig:
      o.config ??
      ((dir: string) =>
        dir === '/w/macf'
          ? { project: 'macf', routingLabel: 'code-agent' }
          : dir === '/w/science'
            ? { project: 'macf', routingLabel: 'science-agent' }
            : null),
    hasSession: (s: string) => live.has(s),
    capturePane: (s: string) => {
      const v = paneQueue.length > 0 ? paneQueue.shift()! : 'idle-frame';
      rec.captured.push(`${s}:${v}`);
      return v;
    },
    submit: (session, text) => void rec.submits.push({ session, text }),
    exec: (bin, args, cwd) => void rec.execs.push({ bin, args, cwd }),
    spawnDetached: (bin, args, cwd) => void rec.spawns.push({ bin, args, cwd }),
    sleep: async (ms) => void rec.sleeps.push(ms),
    isConfigDirty: (workspaceDir: string) => dirtyWorkspaces.has(workspaceDir),
    listDirtyConfig: (workspaceDir: string) => o.dirtyConfigFiles?.get(workspaceDir) ?? [],
    listModifiedFiles: (workspaceDir: string) => o.modifiedFiles?.get(workspaceDir) ?? [],
  };
  return { seams, rec };
}

const OPTS = { workspaceDir: '/w/macf', busyWindowMs: 1500 };

// --- resolveTarget ----------------------------------------------------------

describe('resolveTarget', () => {
  it('derives <project>@<routing-label> from discovery + config', () => {
    const { seams } = fakeSeams();
    expect(resolveTarget(seams, 'code-agent')).toEqual({
      workspace: '/w/macf',
      session: 'macf@code-agent',
    });
    expect(resolveTarget(seams, 'science-agent')).toEqual({
      workspace: '/w/science',
      session: 'macf@science-agent',
    });
  });

  it('returns null when no discovered workspace matches the routing label', () => {
    const { seams } = fakeSeams();
    expect(resolveTarget(seams, 'ghost')).toBeNull();
  });

  it('falls back to the record agent when config has no routing label', () => {
    const { seams } = fakeSeams({ config: () => ({ project: 'macf' }) });
    expect(resolveTarget(seams, 'code-agent')).toEqual({
      workspace: '/w/macf',
      session: 'macf@code-agent',
    });
  });

  it('yields a null session when the workspace config has no project', () => {
    const { seams } = fakeSeams({ config: () => ({ routingLabel: 'code-agent' }) });
    expect(resolveTarget(seams, 'code-agent')).toEqual({ workspace: '/w/macf', session: null });
  });
});

// --- probe ------------------------------------------------------------------

describe('probe', () => {
  it('builds a FleetState with version pulled up + offline peers handled', async () => {
    const { seams } = fakeSeams({
      peers: [
        { name: 'code-agent', info: mkInfo('h1', 4000) },
        { name: 'science-agent', info: mkInfo('h2', 4001) },
      ],
      health: async (host) => (host === 'h1' ? mkHealth('0.2.41') : null),
    });
    const driver = createVmDriver(OPTS, seams);
    const state = await driver.probe();
    expect(state.agents).toEqual([
      {
        name: 'code-agent',
        host: 'h1',
        port: 4000,
        online: true,
        version: '0.2.41',
        health: mkHealth('0.2.41'),
      },
      { name: 'science-agent', host: 'h2', port: 4001, online: false, version: null, health: null },
    ]);
  });

  it('normalizes the registry-listed SCREAMING_SNAKE name back to the routing label (macf#708)', async () => {
    // The real GitHub-Variables registry lists agents by their variable SEGMENT
    // (`CODE_AGENT`, `SCIENCE_AGENT`) — the form `registry.list('')` returns via
    // `v.name.slice(prefix.length)`. The `FleetAgentState.name` contract is the
    // kebab routing label, and every decision-layer join keys on it that way. The
    // driver MUST normalize, or every join misses (the #708 false-negative).
    const { seams } = fakeSeams({
      peers: [
        { name: 'CODE_AGENT', info: mkInfo('h1', 4000) },
        { name: 'SCIENCE_AGENT', info: mkInfo('h2', 4001) },
      ],
      health: async () => mkHealth('0.2.44'),
    });
    const state = await createVmDriver(OPTS, seams).probe();
    expect(state.agents.map((a) => a.name)).toEqual(['code-agent', 'science-agent']);
    expect(state.agents.every((a) => a.online)).toBe(true);
  });
});

// --- probe/fleet-status parity (macf#708 regression) ------------------------

describe('probe ↔ fleet status liveness parity', () => {
  // The #708 bug: `fleet upgrade`/`reconcile` cross-match `driver.probe()`'s
  // agents (by name) against discovered `WorkspaceRecord`s (routing labels) to
  // classify liveness, while `fleet status` renders `gatherFleetStatus` rows
  // directly and never cross-matches. When the registry lists names as
  // SCREAMING_SNAKE, the un-normalized join missed EVERY agent → alive agents
  // classified `offline` and the whole roll skipped. This asserts the two views
  // agree on the ONLINE set for the SAME registry roster — they cannot diverge.
  it('classifies the same alive set as fleet status (the alive-→-offline guard)', async () => {
    // Registry roster in the REAL screaming-snake form + a genuinely-down member.
    const peers = [
      { name: 'AUDITOR_AGENT', info: mkInfo('h1', 8920) },
      { name: 'CODE_AGENT', info: mkInfo('h2', 8921) }, // genuinely down (#702)
      { name: 'DEVOPS_AGENT', info: mkInfo('h3', 8922) },
      { name: 'SCIENCE_AGENT', info: mkInfo('h4', 8923) },
    ];
    const health = async (host: string): Promise<HealthResponse | null> =>
      host === 'h2' ? null : mkHealth('0.2.44');

    // The `fleet status` view: gatherFleetStatus rows directly (its ONLINE set).
    const statuses = await gatherFleetStatus(peers, health);
    const statusOnline = new Set(
      statuses.filter((s) => s.online).map((s) => s.name), // AUDITOR_AGENT, ...
    );

    // The `fleet upgrade` view: driver.probe() → planFleetUpgrade joined against
    // discovered members (routing labels). Members mirror the live substrate.
    const members: readonly WorkspaceRecord[] = [
      { agent: 'auditor-agent', workspace: '/w/auditor', registry: 'groundnuty', project: 'macf', versionPin: '0.2.44' },
      { agent: 'code-agent', workspace: '/w/macf', registry: 'groundnuty', project: 'macf', versionPin: '0.2.44' },
      { agent: 'devops-agent', workspace: '/w/devops', registry: 'groundnuty', project: 'macf', versionPin: '0.2.44' },
      { agent: 'science-agent', workspace: '/w/science', registry: 'groundnuty', project: 'macf', versionPin: '0.2.44' },
    ];
    const { seams } = fakeSeams({ workspaces: members, peers, health });
    const state = await createVmDriver(OPTS, seams).probe();
    // Target ABOVE the running version so a matched-online agent is `behind`
    // (a real roll candidate) — never conflated with `offline`.
    const plans = planFleetUpgrade(members, state, '0.2.99');
    const planOnline = new Set(
      plans.filter((p) => p.disposition !== 'offline').map((p) => p.agent),
    );

    // Parity: the two ONLINE sets are the SAME agents (modulo name form).
    // Before the fix, planOnline was EMPTY (every join missed) while
    // statusOnline had 3 — the exact alive-classified-offline divergence.
    expect([...planOnline].sort()).toEqual(['auditor-agent', 'devops-agent', 'science-agent']);
    expect([...statusOnline].map((n) => n.toLowerCase().replace(/_/g, '-')).sort()).toEqual([
      'auditor-agent',
      'devops-agent',
      'science-agent',
    ]);
    // And the genuinely-down agent is offline in BOTH views.
    expect(plans.find((p) => p.agent === 'code-agent')!.disposition).toBe('offline');
    expect(statuses.find((s) => s.name === 'CODE_AGENT')!.online).toBe(false);
    // Every alive member is a real roll candidate now (the roll is no longer a no-op).
    expect(plans.filter((p) => p.disposition === 'behind').map((p) => p.agent).sort()).toEqual([
      'auditor-agent',
      'devops-agent',
      'science-agent',
    ]);
  });
});

// --- discoverWorkspaces -----------------------------------------------------

describe('discoverWorkspaces', () => {
  it('passes the scan result through', () => {
    const { seams } = fakeSeams({ workspaces: [WS_CODE] });
    expect(createVmDriver(OPTS, seams).discoverWorkspaces()).toEqual([WS_CODE]);
  });
});

// --- isBusy -----------------------------------------------------------------

describe('isBusy', () => {
  it('is busy when the pane content changes across the window', async () => {
    const { seams, rec } = fakeSeams({
      liveSessions: new Set(['macf@code-agent']),
      paneReads: ['frame-A', 'frame-B'],
    });
    expect(await createVmDriver(OPTS, seams).isBusy('code-agent')).toBe(true);
    expect(rec.sleeps).toEqual([1500]); // waited the busy window between captures
  });

  it('is idle when the pane content is unchanged', async () => {
    const { seams } = fakeSeams({
      liveSessions: new Set(['macf@code-agent']),
      paneReads: ['same-frame', 'same-frame'],
    });
    expect(await createVmDriver(OPTS, seams).isBusy('code-agent')).toBe(false);
  });

  it('is not busy when the session is dead (safe to launch)', async () => {
    const { seams } = fakeSeams({ liveSessions: new Set() });
    expect(await createVmDriver(OPTS, seams).isBusy('code-agent')).toBe(false);
  });

  it('is not busy when the agent is unknown', async () => {
    const { seams } = fakeSeams();
    expect(await createVmDriver(OPTS, seams).isBusy('ghost')).toBe(false);
  });

  it('is conservatively busy when a LIVE pane is unreadable', async () => {
    const { seams } = fakeSeams({
      liveSessions: new Set(['macf@code-agent']),
      paneReads: [null, null],
    });
    expect(await createVmDriver(OPTS, seams).isBusy('code-agent')).toBe(true);
  });
});

// --- isConfigDirty (macf#722 Fix B) ------------------------------------------

describe('isConfigDirty', () => {
  it('is dirty when the workspace seam reports uncommitted config-surface changes', async () => {
    const { seams } = fakeSeams({ configDirtyWorkspaces: new Set(['/w/macf']) });
    expect(await createVmDriver(OPTS, seams).isConfigDirty('code-agent')).toBe(true);
  });

  it('is clean when the workspace seam reports no config-surface changes', async () => {
    const { seams } = fakeSeams();
    expect(await createVmDriver(OPTS, seams).isConfigDirty('code-agent')).toBe(false);
  });

  it('is clean (false) when the agent is unknown — nothing to check', async () => {
    const { seams } = fakeSeams({ configDirtyWorkspaces: new Set(['/w/macf']) });
    expect(await createVmDriver(OPTS, seams).isConfigDirty('ghost')).toBe(false);
  });

  it('checks the RESOLVED agent workspace, not the driver`s own workspace', async () => {
    const { seams } = fakeSeams({ configDirtyWorkspaces: new Set(['/w/science']) });
    // driver bound to /w/macf (OPTS.workspaceDir), but the agent under test is
    // science-agent, whose OWN workspace (/w/science) is the dirty one.
    expect(await createVmDriver(OPTS, seams).isConfigDirty('code-agent')).toBe(false);
    expect(await createVmDriver(OPTS, seams).isConfigDirty('science-agent')).toBe(true);
  });
});

// --- listDirtyConfig (macf#725) ----------------------------------------------

describe('listDirtyConfig', () => {
  it('returns the dirty-file list reported by the workspace seam', async () => {
    const files = ['.claude/rules/coordination.md', 'CLAUDE.md'];
    const { seams } = fakeSeams({ dirtyConfigFiles: new Map([['/w/macf', files]]) });
    expect(await createVmDriver(OPTS, seams).listDirtyConfig('code-agent')).toEqual(files);
  });

  it('returns an empty list when clean', async () => {
    const { seams } = fakeSeams();
    expect(await createVmDriver(OPTS, seams).listDirtyConfig('code-agent')).toEqual([]);
  });

  it('returns an empty list when the agent is unknown — nothing to check', async () => {
    const { seams } = fakeSeams({ dirtyConfigFiles: new Map([['/w/macf', ['CLAUDE.md']]]) });
    expect(await createVmDriver(OPTS, seams).listDirtyConfig('ghost')).toEqual([]);
  });

  it('checks the RESOLVED agent workspace, not the driver`s own workspace', async () => {
    const { seams } = fakeSeams({ dirtyConfigFiles: new Map([['/w/science', ['CLAUDE.md']]]) });
    expect(await createVmDriver(OPTS, seams).listDirtyConfig('code-agent')).toEqual([]);
    expect(await createVmDriver(OPTS, seams).listDirtyConfig('science-agent')).toEqual(['CLAUDE.md']);
  });
});

// --- listModifiedFiles (macf#725) --------------------------------------------

describe('listModifiedFiles', () => {
  it('returns the modified-file list reported by the workspace seam', async () => {
    const files = ['.claude/.macf/env.identity', '.claude/rules/coordination.md'];
    const { seams } = fakeSeams({ modifiedFiles: new Map([['/w/science', files]]) });
    expect(await createVmDriver(OPTS, seams).listModifiedFiles('science-agent')).toEqual(files);
  });

  it('returns an empty list when nothing changed', async () => {
    const { seams } = fakeSeams();
    expect(await createVmDriver(OPTS, seams).listModifiedFiles('code-agent')).toEqual([]);
  });

  it('returns an empty list when the agent is unknown', async () => {
    const { seams } = fakeSeams({ modifiedFiles: new Map([['/w/macf', ['CLAUDE.md']]]) });
    expect(await createVmDriver(OPTS, seams).listModifiedFiles('ghost')).toEqual([]);
  });
});

// --- capturePane ------------------------------------------------------------

describe('capturePane', () => {
  it('returns the live session pane content (for stall-signature matching)', async () => {
    const { seams } = fakeSeams({
      liveSessions: new Set(['macf@code-agent']),
      paneReads: ['❯ Rate limited · idle'],
    });
    expect(await createVmDriver(OPTS, seams).capturePane('code-agent')).toBe('❯ Rate limited · idle');
  });

  it('returns null when the session is dead / gone (resume skips it)', async () => {
    const { seams } = fakeSeams({ liveSessions: new Set() });
    expect(await createVmDriver(OPTS, seams).capturePane('code-agent')).toBeNull();
  });

  it('returns null when the agent is unknown', async () => {
    const { seams } = fakeSeams();
    expect(await createVmDriver(OPTS, seams).capturePane('ghost')).toBeNull();
  });
});

// --- upgrade ----------------------------------------------------------------

describe('upgrade', () => {
  it('runs `macf update --yes` in the target workspace', async () => {
    const { seams, rec } = fakeSeams();
    await createVmDriver(OPTS, seams).upgrade('science-agent');
    expect(rec.execs).toEqual([{ bin: 'macf', args: ['update', '--yes'], cwd: '/w/science' }]);
  });

  it('honours a custom macf binary', async () => {
    const { seams, rec } = fakeSeams();
    await createVmDriver({ ...OPTS, macfBin: '/opt/macf' }, seams).upgrade('code-agent');
    expect(rec.execs[0]!.bin).toBe('/opt/macf');
  });

  it('throws FleetDriverError for an unknown agent', async () => {
    const { seams } = fakeSeams();
    await expect(createVmDriver(OPTS, seams).upgrade('ghost')).rejects.toBeInstanceOf(
      FleetDriverError,
    );
  });
});

// --- restart ----------------------------------------------------------------

describe('restart', () => {
  it('runs graceful `macf restart-self --confirm` when the session is alive', async () => {
    const { seams, rec } = fakeSeams({ liveSessions: new Set(['macf@code-agent']) });
    await createVmDriver(OPTS, seams).restart('code-agent');
    expect(rec.execs).toEqual([
      { bin: 'macf', args: ['restart-self', '--confirm', '--reason', 'fault'], cwd: '/w/macf' },
    ]);
    expect(rec.spawns).toEqual([]);
  });

  it('cold-launches when the agent is dead (restart == launch)', async () => {
    const { seams, rec } = fakeSeams({ liveSessions: new Set() });
    await createVmDriver(OPTS, seams).restart('code-agent');
    expect(rec.execs).toEqual([]);
    expect(rec.spawns).toEqual([{ bin: '/w/macf/claude.sh', args: [], cwd: '/w/macf' }]);
  });

  it('threads leaveConfigUncommitted through as --leave-config-uncommitted (macf#725)', async () => {
    const { seams, rec } = fakeSeams({ liveSessions: new Set(['macf@code-agent']) });
    await createVmDriver(OPTS, seams).restart('code-agent', { leaveConfigUncommitted: true });
    expect(rec.execs).toEqual([
      {
        bin: 'macf',
        args: ['restart-self', '--confirm', '--reason', 'fault', '--leave-config-uncommitted'],
        cwd: '/w/macf',
      },
    ]);
  });

  it('omits --leave-config-uncommitted when not requested', async () => {
    const { seams, rec } = fakeSeams({ liveSessions: new Set(['macf@code-agent']) });
    await createVmDriver(OPTS, seams).restart('code-agent', {});
    expect(rec.execs).toEqual([
      { bin: 'macf', args: ['restart-self', '--confirm', '--reason', 'fault'], cwd: '/w/macf' },
    ]);
  });

  it('throws FleetDriverError for an unknown agent', async () => {
    const { seams } = fakeSeams();
    await expect(createVmDriver(OPTS, seams).restart('ghost')).rejects.toBeInstanceOf(
      FleetDriverError,
    );
  });
});

// --- inject -----------------------------------------------------------------

describe('inject', () => {
  it('submits the text into the derived session', async () => {
    const { seams, rec } = fakeSeams();
    await createVmDriver(OPTS, seams).inject('code-agent', 'fleet-doctor probe, no action needed');
    expect(rec.submits).toEqual([
      { session: 'macf@code-agent', text: 'fleet-doctor probe, no action needed' },
    ]);
  });

  it('throws when the session cannot be derived (no project in config)', async () => {
    const { seams } = fakeSeams({ config: () => ({ routingLabel: 'code-agent' }) });
    await expect(createVmDriver(OPTS, seams).inject('code-agent', 'hi')).rejects.toBeInstanceOf(
      FleetDriverError,
    );
  });

  it('throws FleetDriverError for an unknown agent', async () => {
    const { seams } = fakeSeams();
    await expect(createVmDriver(OPTS, seams).inject('ghost', 'hi')).rejects.toBeInstanceOf(
      FleetDriverError,
    );
  });
});

// --- launch -----------------------------------------------------------------

describe('launch', () => {
  it('spawns the workspace launcher detached', async () => {
    const { seams, rec } = fakeSeams();
    await createVmDriver(OPTS, seams).launch('science-agent');
    expect(rec.spawns).toEqual([{ bin: '/w/science/claude.sh', args: [], cwd: '/w/science' }]);
  });

  it('honours a custom launcher basename', async () => {
    const { seams, rec } = fakeSeams();
    await createVmDriver({ ...OPTS, launcher: 'run.sh' }, seams).launch('code-agent');
    expect(rec.spawns[0]!.bin).toBe('/w/macf/run.sh');
  });

  it('throws FleetDriverError for an unknown agent', async () => {
    const { seams } = fakeSeams();
    await expect(createVmDriver(OPTS, seams).launch('ghost')).rejects.toBeInstanceOf(
      FleetDriverError,
    );
  });
});

// --- createVmExecSeams — REAL git (macf#698, DR-040 Decision 6) ------------
//
// Unlike the fakeSeams-driven suites above (which verify createVmDriver's
// orchestration against an INJECTED isConfigDirty/listDirtyConfig), these
// tests exercise the REAL git-backed implementation createVmExecSeams wires
// up — the actual `git status --porcelain -- <ROLL_TOUCHED_CONFIG_PATTERNS>`
// invocation BOTH isConfigDirty AND listDirtyConfig share (same pattern
// array, same git call). This is the load-bearing regression coverage for
// the false-positive fix:
//   - a dirty runtime file (e.g. `.claude/audit.log` — the exact shape that
//     blocked devops's v0.2.48 fleet upgrade, PR #748) must NOT be flagged by
//     either function (that's the operator's complaint + the fix), while
//   - a dirty file on the MEANINGFUL union (the macf-update overwrite set ∪
//     the operator-evolution files `CLAUDE.md` / `env.local.*` kept per
//     macf#725) MUST be — proving the gate (isConfigDirty) and the displayed
//     list (listDirtyConfig) are narrowed IDENTICALLY, since they already
//     shared the same pathspec-filtered git status call before this fix.
// CLAUDE.md is TRACKED operator-evolution: dropping it would make
// restart-self's excludeConfigSurface stash it away on relaunch (silent
// pre-reconcile loss), so it stays in the pattern AND legitimately warrants a
// gate objection — the opposite of audit.log.

describe('createVmExecSeams — real git (macf#698, DR-040 Decision 6)', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  /** Init a real git repo at a temp dir with an initial commit of `files`. */
  function initRepo(files: Readonly<Record<string, string>>): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vmdriver-configdirty-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    return dir;
  }

  it('a dirty non-canonical .claude/ runtime file (audit.log) is NOT flagged — the macf#698 false-positive regression', () => {
    repo = initRepo({
      '.claude/audit.log': 'TIMESTAMP\tUSER\t?\n',
      'claude.sh': '#!/usr/bin/env bash\necho hi\n',
    });
    // Dirty the runtime log — the exact shape of the devops incident: a
    // custom ConfigChange hook keeps appending to a force-tracked audit.log.
    writeFileSync(join(repo, '.claude/audit.log'), 'TIMESTAMP\tUSER\t?\nMORE\n');

    const seams = createVmExecSeams(repo);
    expect(seams.isConfigDirty(repo)).toBe(false);
    expect(seams.listDirtyConfig(repo)).toEqual([]);
  });

  it.each([
    // (a) the exact macf-update overwrite set:
    ['claude.sh'],
    ['.claude/settings.json'],
    ['.claude/rules/coordination.md'],
    ['.claude/scripts/macf-gh-token.sh'],
    ['.claude/.macf/env.identity'],
    ['.claude/.macf/host-prelude.sh'],
    // (b) the operator-evolution union half (macf#725), meaningful ≠ audit.log:
    ['CLAUDE.md'], // TRACKED — dirty CLAUDE.md IS flagged (must-not-silently-stash)
    ['env.local.host'], // bare `env.local.*` pathspec matches top-level, when TRACKED
  ])('a dirty file ON the meaningful union (%s) IS flagged, in BOTH the gate and the display', (rel) => {
    repo = initRepo({
      '.claude/audit.log': 'unrelated\n',
      'claude.sh': '#!/usr/bin/env bash\necho hi\n',
      '.claude/settings.json': '{}\n',
      '.claude/rules/coordination.md': '# coordination\n',
      '.claude/scripts/macf-gh-token.sh': '#!/usr/bin/env bash\n',
      '.claude/.macf/env.identity': 'export MACF_AGENT_NAME=code-agent\n',
      '.claude/.macf/host-prelude.sh': '# host prelude\n',
      'CLAUDE.md': '# workbench doc\n',
      'env.local.host': 'export FOO=bar\n',
    });
    writeFileSync(join(repo, rel), 'DIRTIED\n');

    const seams = createVmExecSeams(repo);
    expect(seams.isConfigDirty(repo)).toBe(true);
    expect(seams.listDirtyConfig(repo)).toEqual([rel]);
  });

  it('a dirty non-canonical .claude/ scratch file (foo.log) is NOT flagged — the wildcard was the only bug', () => {
    // A second non-audit.log runtime-file case: agent scratch / arbitrary log
    // under .claude/. Confirms the fix generalizes beyond audit.log to the
    // whole "runtime files macf update never writes" class.
    repo = initRepo({
      '.claude/foo.log': 'scratch\n',
      '.claude/notes.txt': 'agent scratch\n',
      'claude.sh': '#!/usr/bin/env bash\necho hi\n',
    });
    writeFileSync(join(repo, '.claude/foo.log'), 'scratch\nmore\n');
    writeFileSync(join(repo, '.claude/notes.txt'), 'agent scratch\nedited\n');

    const seams = createVmExecSeams(repo);
    expect(seams.isConfigDirty(repo)).toBe(false);
    expect(seams.listDirtyConfig(repo)).toEqual([]);
  });
});
