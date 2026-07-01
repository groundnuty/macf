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
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildRelauncherScript,
  buildResumeNote,
  coerceReason,
  relauncherGuardLines,
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
  backedUp: { session: string; prestatePath: string }[];
}

/** A fake deps set that records every side-effecting call + its order. */
function fakeDeps(overrides: Partial<RestartSelfDeps> = {}): {
  deps: RestartSelfDeps;
  rec: Recorder;
} {
  const rec: Recorder = {
    order: [],
    written: [],
    spawned: [],
    killed: [],
    mkdirs: [],
    backedUp: [],
  };
  const deps: RestartSelfDeps = {
    now: () => FIXED_NOW,
    hasUncommittedTrackedChanges: () => true,
    hasUncommittedConfigChanges: () => false,
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
    backupTranscript: (session: string, prestatePath: string) => {
      rec.order.push('backup');
      rec.backedUp.push({ session, prestatePath });
      return null;
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
    force: false,
    ...over,
  };
}

describe('resolveSession', () => {
  it('derives <project>@<agent> when routingLabel is unset (name == label)', () => {
    expect(resolveSession(baseOpts())).toBe('macf@code-agent');
  });
  it('keys on the routing-label for a name != routing_label agent (macf#678)', () => {
    // science: agentName=macf-science-agent, routingLabel=science-agent →
    // must target macf@science-agent (what claude.sh self-wraps + the watchdog hits).
    expect(
      resolveSession(baseOpts({ agentName: 'macf-science-agent', routingLabel: 'science-agent' })),
    ).toBe('macf@science-agent');
  });
  it('prefers an explicit session override', () => {
    expect(resolveSession(baseOpts({ session: 'custom@sess' }))).toBe('custom@sess');
  });
  it('returns null when project or both name+label are missing', () => {
    expect(resolveSession(baseOpts({ project: undefined }))).toBeNull();
    expect(resolveSession(baseOpts({ agentName: '  ', routingLabel: '  ' }))).toBeNull();
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

  it('calls deps in order prepare → backup → note → spawn → kill, exactly once each', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    const code = await runRestartSelf(baseOpts({ confirm: true, reason: 'fault' }), deps);
    expect(code).toBe(0);
    // prepare(stash) → backup(transcript) → note(write) → spawn(write+spawn) → kill
    expect(rec.order).toEqual(['stash', 'backup', 'write', 'write', 'spawn', 'kill']);
    expect(rec.killed).toEqual(['macf@code-agent']);
    expect(rec.spawned).toHaveLength(1);
    expect(rec.mkdirs).toHaveLength(1);
    // transcript backup fires BEFORE the spawn/kill, keyed on the resolved session.
    expect(rec.backedUp).toHaveLength(1);
    expect(rec.backedUp[0].session).toBe('macf@code-agent');
    expect(rec.backedUp[0].prestatePath).toContain('restart-self-session-prestate.env');
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
    expect(rec.order).toEqual(['backup', 'write', 'write', 'spawn', 'kill']); // no 'stash'
    expect(rec.stashedLabel).toBeUndefined();
  });

  describe('config-surface stash-refusal guard (macf#722 Fix B)', () => {
    it('refuses (exit 1, NO stash/write/spawn/kill) when config-surface files are dirty and not forced', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { deps, rec } = fakeDeps({ hasUncommittedConfigChanges: () => true });
      const code = await runRestartSelf(baseOpts({ confirm: true }), deps);
      expect(code).toBe(1);
      expect(rec.order).toEqual([]); // nothing mutated — no stash, no spawn, no kill
      expect(errSpy.mock.calls.flat().join('\n')).toContain('uncommitted config');
      errSpy.mockRestore();
    });

    it('proceeds (stashes) despite config-dirty when `force: true` is passed', async () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { deps, rec } = fakeDeps({ hasUncommittedConfigChanges: () => true });
      const code = await runRestartSelf(baseOpts({ confirm: true, force: true }), deps);
      expect(code).toBe(0);
      expect(rec.order).toEqual(['stash', 'backup', 'write', 'write', 'spawn', 'kill']);
    });

    it('non-config uncommitted changes (config-surface clean) proceed + stash as before — unaffected by the guard', async () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { deps, rec } = fakeDeps({ hasUncommittedConfigChanges: () => false });
      const code = await runRestartSelf(baseOpts({ confirm: true }), deps);
      expect(code).toBe(0);
      expect(rec.order).toEqual(['stash', 'backup', 'write', 'write', 'spawn', 'kill']);
    });

    it('dry-run still reports the plan even when config-dirty (the guard only blocks --confirm mutation)', async () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { deps, rec } = fakeDeps({ hasUncommittedConfigChanges: () => true });
      const code = await runRestartSelf(baseOpts({ confirm: false }), deps);
      expect(code).toBe(0);
      expect(rec.order).toEqual([]);
      const out = logSpy.mock.calls.flat().join('\n');
      expect(out).toContain('DRY-RUN');
    });
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

  it('writes a 0755 relauncher that sources the host-prelude + relaunches into a fresh detached tmux session (macf#711)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, rec } = fakeDeps();
    await runRestartSelf(baseOpts({ confirm: true }), deps);
    const relaunch = rec.written.find((w) => w.path.endsWith('restart-self-relauncher.sh'));
    expect(relaunch).toBeDefined();
    expect(relaunch!.mode).toBe(0o755);
    expect(relaunch!.content).toContain('host-prelude.sh');
    expect(relaunch!.content).toContain('if [ -f "$PRELUDE" ]; then');
    expect(relaunch!.content).toContain('tmux has-session');
    // macf#711 fix: relaunch via a FRESH detached tmux session, not a bare
    // `exec ./claude.sh` (which relies on claude.sh's own self-wrap — defeated
    // by inherited-but-stale $TMUX / no controlling terminal from a detached spawn).
    expect(relaunch!.content).toContain('exec tmux new-session -d -s "$SESSION"');
    expect(relaunch!.content).toContain('MACF_NO_TMUX_WRAP=1 exec');
    expect(relaunch!.content).not.toMatch(/^exec \.\/claude\.sh$/m);
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
  const relauncher = (): string =>
    buildRelauncherScript({
      workspaceDir: '/ws',
      session: 'macf@code-agent',
      iso: FIXED_NOW.toISOString(),
      prestatePath: '/ws/.claude/.macf/restart-self-session-prestate.env',
      guardLogPath: '/ws/.claude/.macf/restart-self-guard.log',
    });

  it('uses absolute, shell-quoted paths + the ~30s session-death poll', () => {
    const s = relauncher();
    expect(s).toContain("WORKSPACE='/ws'");
    expect(s).toContain("SESSION='macf@code-agent'");
    expect(s).toContain('/ws/.claude/.macf/host-prelude.sh');
    expect(s).toContain('seq 1 60');
    expect(s.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('embeds the pre-state + guard-log paths and the assert-survived watcher', () => {
    const s = relauncher();
    expect(s).toContain("PRESTATE='/ws/.claude/.macf/restart-self-session-prestate.env'");
    expect(s).toContain("GUARD_LOG='/ws/.claude/.macf/restart-self-guard.log'");
    // The watcher subshell is spawned (detached) BEFORE the exec so it survives it.
    expect(s).toContain('assert_session_live "$SESSION" >>"$GUARD_LOG" 2>&1');
    expect(s).toContain('assert_transcript_survived >>"$GUARD_LOG" 2>&1');
    expect(s).toContain('if [ -f "$PRESTATE" ]; then');
    expect(s).toContain('session_survived()');
    expect(s).toContain('session_post_state()');
    // The guard watcher precedes the exec (must not run after exec replaces us).
    expect(s.indexOf('assert_session_live "$SESSION"')).toBeLessThan(
      s.indexOf('exec tmux new-session -d -s "$SESSION"'),
    );
  });

  it('the session-liveness guard fails LOUD (durable alert banner) when no session comes up (macf#711 AC#2)', () => {
    const s = relauncher();
    expect(s).toContain('assert_session_live() {');
    expect(s).toContain('SESSION-GUARD ALERT');
    expect(s).toContain('The relaunch did NOT bring up a live tmux session');
    expect(s).toContain('The agent is DOWN');
    // Fail-open: it reports, but never aborts / blocks the relaunch itself.
    expect(s.indexOf('assert_session_live "$SESSION"')).toBeLessThan(
      s.indexOf('exec tmux new-session -d -s "$SESSION"'),
    );
  });

  it('relaunches via a fresh detached tmux session with MACF_NO_TMUX_WRAP=1 for the inner claude.sh (macf#711)', () => {
    const s = relauncher();
    expect(s).toContain('exec tmux new-session -d -s "$SESSION" -c "$WORKSPACE"');
    expect(s).toContain('MACF_NO_TMUX_WRAP=1 exec');
    expect(s).toContain('$WORKSPACE/claude.sh');
    // The old bare-exec form must be fully gone — that was the bug.
    expect(s).not.toMatch(/^exec \.\/claude\.sh$/m);
  });

  it('waits for the relaunch to come live before comparing (avoids the re-open race)', () => {
    const s = relauncher();
    expect(s).toContain('MACF_RESTART_LIVE_TIMEOUT');
    expect(s).toContain('-gt "${pre_mtime:-0}"'); // mtime-advancing liveness poll
    // cross-platform stat for both mtime (%Y/%m) and size (%s/%z)
    expect(s).toContain('stat -c%Y');
    expect(s).toContain('stat -f%m');
    expect(s).toContain('stat -c%s');
    expect(s).toContain('stat -f%z');
  });
});

describe('resolveIdentity', () => {
  it('prefers env over config; routingLabel defaults to agentName when MACF_ROUTING_LABEL unset', () => {
    const id = resolveIdentity('/proj', {
      MACF_WORKSPACE_DIR: '/env-ws',
      MACF_PROJECT: 'envproj',
      MACF_AGENT_NAME: 'envagent',
    } as NodeJS.ProcessEnv);
    expect(id).toEqual({
      workspaceDir: '/env-ws',
      project: 'envproj',
      agentName: 'envagent',
      routingLabel: 'envagent',
    });
  });

  it('resolves routingLabel from MACF_ROUTING_LABEL for a name != routing_label agent (macf#678)', () => {
    const id = resolveIdentity('/proj', {
      MACF_PROJECT: 'macf',
      MACF_AGENT_NAME: 'macf-science-agent',
      MACF_ROUTING_LABEL: 'science-agent',
    } as NodeJS.ProcessEnv);
    expect(id.agentName).toBe('macf-science-agent');
    expect(id.routingLabel).toBe('science-agent');
  });

  it('falls back to projectDir for the workspace when env is unset', () => {
    const id = resolveIdentity('/proj', {} as NodeJS.ProcessEnv);
    expect(id.workspaceDir).toBe('/proj');
  });
});

/**
 * The assert-survived guard is generated SHELL (it runs in the detached
 * relauncher, where TS can't). Lift the VM reference's 6 unit-tested guard cases
 * (fleet/upgrade.sh) by executing the ACTUAL generated `session_survived` through
 * bash with the `MACF_TEST_SESSION` seam — the shipped code is the code tested.
 */
describe('relauncher session_survived — 6 guard cases (macf#685)', () => {
  // Drive session_survived("/x", "u1 100") with MACF_TEST_SESSION per case.
  const PRE = 'u1 100';
  function run(seam: string): { exit: number; out: string } {
    const script = [
      'set -uo pipefail',
      ...relauncherGuardLines(),
      'if session_survived "/x" "$1"; then echo "RESULT:survive"; else echo "RESULT:halt"; fi',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script, 'bash', PRE], {
      env: { ...process.env, MACF_TEST_SESSION: seam },
      encoding: 'utf-8',
    });
    return { exit: r.status ?? -1, out: r.stdout + r.stderr };
  }

  it('1. same uuid, grew → survive', () => {
    expect(run('u1,200').out).toContain('RESULT:survive');
  });
  it('2. same uuid, same size → survive', () => {
    expect(run('u1,100').out).toContain('RESULT:survive');
  });
  it('3. same uuid, SHRANK → halt', () => {
    const r = run('u1,50');
    expect(r.out).toContain('RESULT:halt');
    expect(r.out).toContain('SHRANK');
  });
  it('4. transcript GONE → halt', () => {
    const r = run('');
    expect(r.out).toContain('RESULT:halt');
    expect(r.out).toContain('no active transcript');
  });
  it('5. uuid changed but grew → survive + note', () => {
    const r = run('u2,300');
    expect(r.out).toContain('RESULT:survive');
    expect(r.out).toContain('uuid changed u1 -> u2');
  });
  it('6. uuid changed AND shrank → halt', () => {
    expect(run('u2,40').out).toContain('RESULT:halt');
  });

  it('missing pre-state → guard skipped (survive)', () => {
    const script = [
      'set -uo pipefail',
      ...relauncherGuardLines(),
      'if session_survived "/x" ""; then echo "RESULT:survive"; else echo "RESULT:halt"; fi',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      env: { ...process.env, MACF_TEST_SESSION: 'u1,50' },
      encoding: 'utf-8',
    });
    expect(r.stdout).toContain('RESULT:survive');
    expect(r.stdout).toContain('no pre-state');
  });
});

/**
 * assert_session_live (macf#711 AC#1/#2) — drive the ACTUAL generated guard
 * through bash with the `MACF_TEST_TMUX_UP` seam, so no real tmux server is
 * needed in CI (same seam-pattern as `MACF_TEST_SESSION` above). Bounds are
 * tightened via MACF_RESTART_LIVE_TIMEOUT/INTERVAL so the "never comes up"
 * case doesn't block the test suite for the production 120s default.
 */
describe('relauncher assert_session_live (macf#711)', () => {
  function run(tmuxUp: '0' | '1'): { exit: number; out: string } {
    const script = [
      'set -uo pipefail',
      'LIVE_TIMEOUT=1',
      'LIVE_INTERVAL=0.2',
      ...relauncherGuardLines(),
      'if assert_session_live "macf@test-agent"; then echo "RESULT:live"; else echo "RESULT:down"; fi',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      env: { ...process.env, MACF_TEST_TMUX_UP: tmuxUp },
      encoding: 'utf-8',
    });
    return { exit: r.status ?? -1, out: r.stdout + r.stderr };
  }

  it('session came up → live, no alert', () => {
    const r = run('1');
    expect(r.out).toContain('RESULT:live');
    expect(r.out).toContain('[session-guard] OK');
    expect(r.out).not.toContain('SESSION-GUARD ALERT');
  });

  it('session never came up → down, LOUD durable alert banner (AC#2)', () => {
    const r = run('0');
    expect(r.out).toContain('RESULT:down');
    expect(r.out).toContain('SESSION-GUARD ALERT');
    expect(r.out).toContain('did NOT bring up a live tmux session');
    expect(r.out).toContain('The agent is DOWN');
    expect(r.out).toContain('macf@test-agent');
  });

  it('is fail-open — a down result returns non-zero but the calling script keeps running (never aborts the relaunch)', () => {
    const script = [
      'set -uo pipefail',
      'LIVE_TIMEOUT=1',
      'LIVE_INTERVAL=0.2',
      ...relauncherGuardLines(),
      'assert_session_live "macf@test-agent" || true',
      'echo "REACHED-AFTER-GUARD"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      env: { ...process.env, MACF_TEST_TMUX_UP: '0' },
      encoding: 'utf-8',
    });
    expect(r.stdout + r.stderr).toContain('REACHED-AFTER-GUARD');
  });
});
