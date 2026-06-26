/**
 * Tests for `macf restart-self` — DR-031 piece 3 (be-replaceable verb).
 *
 * The orchestrator `runRestartSelf` is exercised with FAKE deps so nothing
 * stashes / kills / spawns for real. The load-bearing cases:
 *   - DRY-RUN by default (and explicit --dry-run): NO stash/kill/spawn, exit 0,
 *     a plan is emitted.
 *   - --confirm: deps fire in the exact order prepare → note → spawn → kill,
 *     each exactly once.
 *   - stash ONLY when the tree is dirty; label format `macf-restart-self/<ts>/<reason>`.
 *   - RESUME-note content carries reason / branch / HEAD / stash-ref.
 *   - relauncher script sources the host-prelude conditionally + execs claude.sh.
 *   - refuses cleanly when the session name can't be resolved.
 *   - --json emits the versioned state-record.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildRelauncherScript,
  buildResumeNote,
  coerceReason,
  resolveIdentity,
  resolveSession,
  runRestartSelf,
  stashLabel,
  RESTART_SELF_JSON_SCHEMA_VERSION,
  type RestartSelfDeps,
  type RunRestartSelfOptions,
  type StashResult,
} from '../../src/cli/commands/restart-self.js';

const FIXED_NOW = new Date('2026-06-27T12:00:00.000Z');

interface Recorder {
  readonly order: string[];
  stashedLabel?: string;
  written: { path: string; content: string; mode?: number }[];
  spawned: { path: string; args: readonly string[] }[];
  killed: string[];
  mkdirs: string[];
}

/** A fake deps set that records every side-effecting call + its order. */
function fakeDeps(overrides: Partial<RestartSelfDeps> = {}): {
  deps: RestartSelfDeps;
  rec: Recorder;
} {
  const rec: Recorder = { order: [], written: [], spawned: [], killed: [], mkdirs: [] };
  const deps: RestartSelfDeps = {
    now: () => FIXED_NOW,
    hasUncommittedTrackedChanges: () => true,
    currentBranch: () => 'feat/596-restart-self',
    headSha: () => 'abc1234def5678',
    stash: (label: string): StashResult => {
      rec.order.push('stash');
      rec.stashedLabel = label;
      return { stashed: true, ref: 'deadbeefcafe' };
    },
    mkdirp: (path: string) => {
      rec.mkdirs.push(path);
    },
    writeFile: (path: string, content: string, mode?: number) => {
      rec.order.push('write');
      rec.written.push({ path, content, mode });
    },
    spawnDetached: (path: string, args: readonly string[]) => {
      rec.order.push('spawn');
      rec.spawned.push({ path, args });
    },
    killSession: (session: string) => {
      rec.order.push('kill');
      rec.killed.push(session);
    },
    ...overrides,
  };
  return { deps, rec };
}

function baseOpts(over: Partial<RunRestartSelfOptions> = {}): RunRestartSelfOptions {
  return {
    workspaceDir: '/ws',
    project: 'macf',
    agentName: 'code-agent',
    reason: 'manual',
    confirm: false,
    dryRun: false,
    json: false,
    ...over,
  };
}

describe('resolveSession', () => {
  it('derives <project>@<agent>', () => {
    expect(resolveSession(baseOpts())).toBe('macf@code-agent');
  });
  it('prefers an explicit session override', () => {
    expect(resolveSession(baseOpts({ session: 'custom@sess' }))).toBe('custom@sess');
  });
  it('returns null when project or agent is missing', () => {
    expect(resolveSession(baseOpts({ project: undefined }))).toBeNull();
    expect(resolveSession(baseOpts({ agentName: '  ' }))).toBeNull();
  });
});

describe('coerceReason', () => {
  it('passes known reasons through', () => {
    expect(coerceReason('fault')).toBe('fault');
    expect(coerceReason('upgrade')).toBe('upgrade');
    expect(coerceReason('manual')).toBe('manual');
  });
  it('defaults unknown / undefined to manual', () => {
    expect(coerceReason('bogus')).toBe('manual');
    expect(coerceReason(undefined)).toBe('manual');
  });
});

describe('stashLabel', () => {
  it('formats macf-restart-self/<ts>/<reason>', () => {
    expect(stashLabel('2026-06-27T12:00:00.000Z', 'fault')).toBe(
      'macf-restart-self/2026-06-27T12:00:00.000Z/fault',
    );
  });
});

describe('runRestartSelf — dry-run (default + explicit)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => logSpy?.mockRestore());

  it('default (no --confirm): NO stash/kill/spawn, exit 0, emits a plan', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    const code = await runRestartSelf(baseOpts({ confirm: false }), deps);
    expect(code).toBe(0);
    expect(rec.order).toEqual([]); // nothing mutated
    expect(rec.killed).toEqual([]);
    expect(rec.spawned).toEqual([]);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('DRY-RUN');
    expect(out).toContain('macf@code-agent');
  });

  it('explicit --dry-run wins even with --confirm', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    const code = await runRestartSelf(baseOpts({ confirm: true, dryRun: true }), deps);
    expect(code).toBe(0);
    expect(rec.order).toEqual([]);
  });
});

describe('runRestartSelf — confirm path', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => logSpy?.mockRestore());

  it('calls deps in order prepare → note → spawn → kill, exactly once each', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    const code = await runRestartSelf(baseOpts({ confirm: true, reason: 'fault' }), deps);
    expect(code).toBe(0);
    // prepare(stash) → note(write) → spawn(write+spawn) → kill
    expect(rec.order).toEqual(['stash', 'write', 'write', 'spawn', 'kill']);
    expect(rec.killed).toEqual(['macf@code-agent']);
    expect(rec.spawned).toHaveLength(1);
    expect(rec.mkdirs).toHaveLength(1);
  });

  it('stashes only when dirty; label is macf-restart-self/<ts>/<reason>', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: true, reason: 'upgrade' }), deps);
    expect(rec.stashedLabel).toBe('macf-restart-self/2026-06-27T12:00:00.000Z/upgrade');
  });

  it('does NOT stash when the tree is clean (no stash in the call order)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps({ hasUncommittedTrackedChanges: () => false });
    await runRestartSelf(baseOpts({ confirm: true }), deps);
    expect(rec.order).toEqual(['write', 'write', 'spawn', 'kill']); // no 'stash'
    expect(rec.stashedLabel).toBeUndefined();
  });

  it('writes the RESUME-note with reason / branch / HEAD / stash-ref', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: true, reason: 'fault' }), deps);
    const note = rec.written.find((w) => w.path.endsWith('RESUME-restart-self.md'));
    expect(note).toBeDefined();
    expect(note!.content).toContain('Reason: fault');
    expect(note!.content).toContain('Branch: feat/596-restart-self');
    expect(note!.content).toContain('HEAD: abc1234def5678');
    expect(note!.content).toContain('Stash: deadbeefcafe');
  });

  it('writes a 0755 relauncher that sources the host-prelude + execs claude.sh', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: true }), deps);
    const relaunch = rec.written.find((w) => w.path.endsWith('restart-self-relauncher.sh'));
    expect(relaunch).toBeDefined();
    expect(relaunch!.mode).toBe(0o755);
    expect(relaunch!.content).toContain('host-prelude.sh');
    expect(relaunch!.content).toContain('if [ -f "$PRELUDE" ]; then');
    expect(relaunch!.content).toContain('exec ./claude.sh');
    expect(relaunch!.content).toContain('tmux has-session');
  });

  it('refuses cleanly (exit 1) when the session cannot be resolved', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    const code = await runRestartSelf(baseOpts({ confirm: true, project: undefined }), deps);
    expect(code).toBe(1);
    expect(rec.order).toEqual([]); // nothing happened
    expect(errSpy.mock.calls.flat().join('\n')).toContain('cannot resolve the tmux session');
    errSpy.mockRestore();
  });

  it('emits the versioned JSON state-record under --json', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: true, reason: 'fault', json: true }), deps);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed).toMatchObject({
      schema_version: RESTART_SELF_JSON_SCHEMA_VERSION,
      dry_run: false,
      reason: 'fault',
      session: 'macf@code-agent',
      stash_ref: 'deadbeefcafe',
      killed: true,
    });
    expect(parsed.resume_note_path).toContain('RESUME-restart-self.md');
    expect(parsed.relauncher_path).toContain('restart-self-relauncher.sh');
  });

  it('JSON dry-run reports dry_run:true, killed:false, stash_ref:null', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: false, json: true }), deps);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed).toMatchObject({ dry_run: true, killed: false, stash_ref: null });
  });
});

describe('buildResumeNote', () => {
  it('says "nothing was stashed" when stashRef is null', () => {
    const note = buildResumeNote({
      reason: 'manual',
      iso: FIXED_NOW.toISOString(),
      branch: 'main',
      head: 'sha',
      stashRef: null,
    });
    expect(note).toContain('Stash: none');
    expect(note).toContain('Nothing was stashed');
  });
});

describe('buildRelauncherScript', () => {
  it('uses absolute, shell-quoted paths + the ~30s session-death poll', () => {
    const s = buildRelauncherScript({
      workspaceDir: '/ws',
      session: 'macf@code-agent',
      iso: FIXED_NOW.toISOString(),
    });
    expect(s).toContain("WORKSPACE='/ws'");
    expect(s).toContain("SESSION='macf@code-agent'");
    expect(s).toContain('/ws/.claude/.macf/host-prelude.sh');
    expect(s).toContain('seq 1 60');
    expect(s.startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});

describe('resolveIdentity', () => {
  it('prefers env over config', () => {
    const id = resolveIdentity('/proj', {
      MACF_WORKSPACE_DIR: '/env-ws',
      MACF_PROJECT: 'envproj',
      MACF_AGENT_NAME: 'envagent',
    } as NodeJS.ProcessEnv);
    expect(id).toEqual({ workspaceDir: '/env-ws', project: 'envproj', agentName: 'envagent' });
  });

  it('falls back to projectDir for the workspace when env is unset', () => {
    const id = resolveIdentity('/proj', {} as NodeJS.ProcessEnv);
    expect(id.workspaceDir).toBe('/proj');
  });
});
