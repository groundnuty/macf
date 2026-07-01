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
import { describe, it, expect } from 'vitest';
import { FleetDriverError, planFleetUpgrade } from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse, WorkspaceRecord } from '@groundnuty/macf-core';
import {
  createVmDriver,
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
