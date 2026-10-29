/**
 * groundnuty/macf#1525 item 1 — an agent whose channel server is gone must say
 * so loudly. Two new checks in `check-channel-alive.sh`:
 *   (A) the settings check: `macf-agent` disabled/not enabled in
 *       `.claude/settings.json` + `.claude/settings.local.json`;
 *   (B) no live server_started pid past a grace period.
 * The pre-existing behaviour is covered by check-channel-alive.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-channel-alive.sh');
const DEAD_PID = 2147480000;
const SETTINGS_ALARM = "MACF: this agent's channel server is turned off in Claude Code settings";
const NOLIVE_ALARM = 'MACF: this agent has no running channel server';
const UNCHECKED = 'MACF: could not check whether this agent';

let live: { pid: number; stop: () => void };
beforeAll(() => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', '--', 'macf-channel-server-marker'], {
    stdio: 'ignore',
  });
  live = { pid: child.pid as number, stop: () => child.kill('SIGKILL') };
});
afterAll(() => live?.stop());

type Json = Record<string, unknown> | string;

interface Opts {
  readonly settings?: Json;
  readonly settingsLocal?: Json;
  /** pid in the server_started line; undefined → no channel.log written. */
  readonly serverPid?: number;
  readonly event?: 'SessionStart' | 'UserPromptSubmit';
  /** Seed this session's start stamp this many seconds ago. */
  readonly sessionAgeSecs?: number;
  readonly alarmStampSecsAgo?: number;
  readonly sessionId?: string;
  /** Run twice in the same workspace; returns the second run. */
  readonly runs?: number;
  readonly noNode?: boolean;
  /** Write this as ~/.claude/settings.json (the user layer). */
  readonly userSettings?: Json;
  /** Known identity (MACF_PROJECT/MACF_AGENT_NAME) whose channel.log does not exist. */
  readonly identityNoLog?: boolean;
}

function run(opts: Opts): { stdout: string; ws: string } {
  const home = mkdtempSync(join(tmpdir(), 'macf-deaf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'macf-deaf-ws-'));
  const macfDir = join(ws, '.claude', '.macf');
  mkdirSync(macfDir, { recursive: true });
  const put = (name: string, v: Json | undefined): void => {
    if (v === undefined) return;
    writeFileSync(join(ws, '.claude', name), typeof v === 'string' ? v : JSON.stringify(v));
  };
  put('settings.json', opts.settings);
  put('settings.local.json', opts.settingsLocal);
  if (opts.userSettings !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(opts.userSettings));
  }

  const sid = opts.sessionId ?? 'sess-1';
  const now = Math.floor(Date.now() / 1000);
  if (opts.sessionAgeSecs !== undefined) {
    writeFileSync(join(macfDir, `.channel-alive-session-${sid}`), String(now - opts.sessionAgeSecs));
  }
  if (opts.alarmStampSecsAgo !== undefined) {
    writeFileSync(join(macfDir, '.channel-alive-nolive-last-alarm'), String(now - opts.alarmStampSecsAgo));
  }

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    CLAUDE_PROJECT_DIR: ws,
    MACF_CHANNEL_ALIVE_RETRY_DELAY_SECS: '0',
  };
  if (opts.noNode) {
    // A PATH holding the coreutils the hook needs but no node binary.
    const bin = mkdtempSync(join(tmpdir(), 'macf-deaf-bin-'));
    for (const name of ['bash', 'sh', 'cat', 'sed', 'grep', 'tail', 'date', 'mkdir', 'tr', 'find', 'rm', 'mktemp', 'ls']) {
      const resolved = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout.trim();
      if (resolved) symlinkSync(resolved, join(bin, name));
    }
    env['PATH'] = bin;
    const probe = spawnSync(join(bin, 'bash'), ['-c', 'command -v node'], { env: { PATH: bin }, encoding: 'utf-8' });
    if (probe.stdout.trim()) throw new Error('node still resolvable; cannot simulate its absence');
  }
  if (opts.identityNoLog) {
    env['MACF_PROJECT'] = 'p';
    env['MACF_AGENT_NAME'] = 'a';
  }
  if (opts.serverPid !== undefined) {
    const dir = join(home, '.local', 'state', 'macf', 'p@a');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'channel.log');
    writeFileSync(
      log,
      JSON.stringify({
        ts: '2026-10-01T09:00:00.000Z', level: 'info', event: 'server_started',
        port: 8801, host: '127.0.0.1', agent: 'a', type: 'permanent', instance_id: 'i',
        pid: opts.serverPid, version: '0.2.77',
      }) + '\n',
    );
    env['MACF_LOG_PATH'] = log;
  }

  const input = JSON.stringify({ session_id: sid, hook_event_name: opts.event ?? 'UserPromptSubmit' });
  let stdout = '';
  for (let i = 0; i < (opts.runs ?? 1); i++) {
    const r = spawnSync('bash', [HOOK_SCRIPT], { input, env, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    stdout = r.stdout;
  }
  rmSync(home, { recursive: true, force: true });
  return { stdout, ws };
}

const clean = (ws: string): void => rmSync(ws, { recursive: true, force: true });

// The real shape from the incident: the template-rewritten settings.json lacks
// macf-agent, and settings.local.json carries it in disabledMcpjsonServers.
const REWRITTEN = { enabledMcpjsonServers: ['other-server'], hooks: {} };
const DISABLED_LOCAL = { disabledMcpjsonServers: ['macf-agent'] };
const HEALTHY = { enabledMcpjsonServers: ['macf-agent'] };

describe('settings check (#1525)', () => {
  it('the real shape: rewritten settings.json + disabled settings.local.json → alarm with the fix', () => {
    const { stdout, ws } = run({ settings: REWRITTEN, settingsLocal: DISABLED_LOCAL });
    clean(ws);
    expect(stdout).toContain(SETTINGS_ALARM);
    expect(stdout).toContain('Fix: remove "macf-agent" from disabledMcpjsonServers in .claude/settings.local.json');
    expect(stdout).toContain('Tell the operator now.');
  });

  it('alarms on SessionStart too', () => {
    const { stdout, ws } = run({ settings: REWRITTEN, settingsLocal: DISABLED_LOCAL, event: 'SessionStart' });
    clean(ws);
    expect(stdout).toContain(SETTINGS_ALARM);
  });

  it('disabled-only: enabled in settings.json but disabled in settings.local.json → alarm', () => {
    const { stdout, ws } = run({ settings: HEALTHY, settingsLocal: DISABLED_LOCAL });
    clean(ws);
    expect(stdout).toContain(SETTINGS_ALARM);
  });

  it('not-enabled-only: in neither enabled list, nothing disabled → alarm', () => {
    const { stdout, ws } = run({ settings: REWRITTEN, settingsLocal: {} });
    clean(ws);
    expect(stdout).toContain(SETTINGS_ALARM);
  });

  it('enabled only in settings.local.json → quiet', () => {
    const { stdout, ws } = run({ settings: {}, settingsLocal: HEALTHY });
    clean(ws);
    expect(stdout).not.toContain('MACF:');
  });

  it('enableAllProjectMcpServers: true in either layer → quiet', () => {
    const a = run({ settings: { enableAllProjectMcpServers: true }, settingsLocal: {} });
    clean(a.ws);
    const b = run({ settings: {}, settingsLocal: { enableAllProjectMcpServers: true } });
    clean(b.ws);
    expect(a.stdout).not.toContain('MACF:');
    expect(b.stdout).not.toContain('MACF:');
  });

  it('a healthy pair emits nothing', () => {
    const { stdout, ws } = run({ settings: HEALTHY, settingsLocal: {}, serverPid: live.pid });
    clean(ws);
    expect(stdout).toBe('');
  });

  it('unparseable JSON → "could not check", once per session, never silence', () => {
    const first = run({ settings: '{ not json', settingsLocal: {}, runs: 1 });
    clean(first.ws);
    expect(first.stdout).toContain(UNCHECKED);
    const twice = run({ settings: '{ not json', settingsLocal: {}, runs: 2 });
    clean(twice.ws);
    expect(twice.stdout).not.toContain(UNCHECKED);
  });

  it('node missing → "could not check"', () => {
    const { stdout, ws } = run({ settings: HEALTHY, settingsLocal: {}, noNode: true, serverPid: live.pid });
    clean(ws);
    expect(stdout).toContain(UNCHECKED);
  });

  it('an approval in the user layer (~/.claude/settings.json) counts → quiet', () => {
    const { stdout, ws } = run({ settings: REWRITTEN, settingsLocal: {}, userSettings: HEALTHY });
    clean(ws);
    expect(stdout).not.toContain(SETTINGS_ALARM);
  });

  it('enableAllProjectMcpServers follows precedence: a project false overrides a user true → alarm', () => {
    const { stdout, ws } = run({
      settings: { enabledMcpjsonServers: ['other'], enableAllProjectMcpServers: false },
      settingsLocal: {},
      userSettings: { enableAllProjectMcpServers: true },
    });
    clean(ws);
    expect(stdout).toContain(SETTINGS_ALARM);
  });

  it('enableAllProjectMcpServers: a local true overrides a project false → quiet', () => {
    const { stdout, ws } = run({
      settings: { enableAllProjectMcpServers: false },
      settingsLocal: { enableAllProjectMcpServers: true },
    });
    clean(ws);
    expect(stdout).not.toContain(SETTINGS_ALARM);
  });

  it('never edits settings', () => {
    const { ws } = run({ settings: REWRITTEN, settingsLocal: DISABLED_LOCAL });
    
    const after = readFileSync(join(ws, '.claude', 'settings.local.json'), 'utf-8');
    clean(ws);
    expect(JSON.parse(after)).toEqual(DISABLED_LOCAL);
  });
});

describe('no running channel server past the grace period (#1525)', () => {
  it('dead server_started pid past 120 s → alarm', () => {
    const { stdout, ws } = run({ settings: HEALTHY, serverPid: DEAD_PID, sessionAgeSecs: 600 });
    clean(ws);
    expect(stdout).toContain(NOLIVE_ALARM);
    expect(stdout).toContain('last one exited 2026-10-01T09:00:00.000Z');
    expect(stdout).toContain('relaunch with ./claude.sh');
  });

  it('a known agent with no channel.log at all past 120 s → alarm (a server that never started)', () => {
    const { stdout, ws } = run({ settings: HEALTHY, identityNoLog: true, sessionAgeSecs: 600 });
    clean(ws);
    expect(stdout).toContain(NOLIVE_ALARM);
    expect(stdout).toContain('none has started for this agent');
  });

  it('a known agent with no channel.log within the grace period → quiet', () => {
    const { stdout, ws } = run({ settings: HEALTHY, identityNoLog: true, sessionAgeSecs: 30 });
    clean(ws);
    expect(stdout).toBe('');
  });

  it('dead pid within the grace period → quiet', () => {
    const { stdout, ws } = run({ settings: HEALTHY, serverPid: DEAD_PID, sessionAgeSecs: 30 });
    clean(ws);
    expect(stdout).toBe('');
  });

  it('SessionStart never alarms for liveness (the session just began)', () => {
    const { stdout, ws } = run({ settings: HEALTHY, serverPid: DEAD_PID, event: 'SessionStart' });
    clean(ws);
    expect(stdout).toBe('');
  });

  it('a session with no stamp starts its grace window now → quiet', () => {
    const { stdout, ws } = run({ settings: HEALTHY, serverPid: DEAD_PID });
    clean(ws);
    expect(stdout).toBe('');
  });

  it('a live pid past the grace period → no alarm', () => {
    const { stdout, ws } = run({ settings: HEALTHY, serverPid: live.pid, sessionAgeSecs: 600 });
    clean(ws);
    expect(stdout).not.toContain(NOLIVE_ALARM);
  });

  it('throttle: a second alarm within 10 minutes is suppressed; one past 10 minutes fires', () => {
    const within = run({ settings: HEALTHY, serverPid: DEAD_PID, sessionAgeSecs: 600, alarmStampSecsAgo: 120 });
    clean(within.ws);
    expect(within.stdout).not.toContain(NOLIVE_ALARM);
    const past = run({ settings: HEALTHY, serverPid: DEAD_PID, sessionAgeSecs: 600, alarmStampSecsAgo: 700 });
    expect(existsSync(join(past.ws, '.claude', '.macf', '.channel-alive-nolive-last-alarm'))).toBe(true);
    clean(past.ws);
    expect(past.stdout).toContain(NOLIVE_ALARM);
  });
});
