import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '@groundnuty/macf-core';
import {
  readChannelRegistration,
  createWakeRouter,
  encodeWorkspace,
  type RegistrationFs,
} from '../src/channel-registration.js';

let home: string;
const WS = '/ws/proj.one';
const START = 1_000_000_000_000;

function logDir(ws: string): string {
  return join(home, '.cache', 'claude-cli-nodejs', encodeWorkspace(ws), 'mcp-logs-macf-agent');
}
function writeLog(ws: string, text: string, mtimeMs: number, name = 'a.jsonl'): string {
  const d = logDir(ws);
  mkdirSync(d, { recursive: true });
  const f = join(d, name);
  writeFileSync(f, text);
  utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}
const SID = 'sess-own';
function ln(debug: string, tsMs: number, sessionId = SID): string {
  return JSON.stringify({ debug, timestamp: new Date(tsMs).toISOString(), sessionId, cwd: WS });
}
const REG = 'Channel notifications registered';
const SKIP = 'Channel notifications skipped: not in list';
const read = (dirs: string[] = [WS], sessionId: string | undefined = SID) =>
  readChannelRegistration({ candidateDirs: dirs, homeDir: home, serverStartedAtMs: START, sessionId });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'macf-639-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('encodeWorkspace', () => {
  it('replaces / and . with -', () => {
    expect(encodeWorkspace('/a/b.c/d')).toBe('-a-b-c-d');
  });
});

describe('readChannelRegistration', () => {
  it('registered: matching session id, timestamp after start', () => {
    const f = writeLog(WS, ln(REG, START + 1000), START + 1000);
    expect(read()).toEqual({ state: 'registered', logFile: f });
  });
  it('skipped', () => {
    writeLog(WS, ln(SKIP, START + 1000), START + 1000);
    expect(read().state).toBe('skipped');
  });
  it('latest line wins when both markers appear', () => {
    writeLog(WS, [ln(SKIP, START + 1000), ln(REG, START + 2000)].join('\n'), START + 2000);
    expect(read().state).toBe('registered');
    writeLog(WS, [ln(REG, START + 1000), ln(SKIP, START + 2000)].join('\n'), START + 2000);
    expect(read().state).toBe('skipped');
  });
  it('unknown: another session in the same dir says registered (newest file)', () => {
    writeLog(WS, ln('unrelated', START + 1000), START + 1000, 'mine.jsonl');
    writeLog(WS, ln(REG, START + 5000, 'sess-other'), START + 5000, 'other.jsonl');
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no registration line') });
  });
  it('unknown: same session id but registration before server start (resumed session)', () => {
    writeLog(WS, ln(REG, START - 60_000), START + 1000);
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no registration line') });
  });
  it('skipped: own session skipped while another session registered', () => {
    writeLog(WS, ln(SKIP, START + 1000), START + 1000, 'mine.jsonl');
    writeLog(WS, ln(REG, START + 5000, 'sess-other'), START + 5000, 'other.jsonl');
    expect(read().state).toBe('skipped');
  });
  it('unknown without CLAUDE_CODE_SESSION_ID, and reads no files', () => {
    const boom = (): never => {
      throw new Error('fs must not be touched');
    };
    const fs: RegistrationFs = { readdirSync: boom, statSync: boom, readFileSync: boom, realpathSync: boom };
    for (const sessionId of [undefined, '']) {
      const r = readChannelRegistration({ candidateDirs: [WS], homeDir: home, serverStartedAtMs: START, sessionId, fs });
      expect(r).toEqual({ state: 'unknown', reason: 'no CLAUDE_CODE_SESSION_ID' });
    }
  });
  it('skips malformed JSON lines and bad timestamps', () => {
    const bad = JSON.stringify({ debug: REG, timestamp: 'not-a-date', sessionId: SID });
    writeLog(WS, ['{oops', bad, '', ln(REG, START + 1000)].join('\n'), START + 1000);
    expect(read().state).toBe('registered');
    writeLog(WS, ['{oops', bad].join('\n'), START + 1000);
    expect(read().state).toBe('unknown');
  });
  it('unknown: missing dir', () => {
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no mcp-logs') });
  });
  it('unknown: stale file mtime before server start', () => {
    writeLog(WS, ln(REG, START + 1000), START - 60_000);
    expect(read().state).toBe('unknown');
  });
  it('unknown: unreadable file, never throws', () => {
    writeLog(WS, ln(REG, START + 1000), START + 1000);
    const fs: RegistrationFs = {
      ...(nodeFs as unknown as RegistrationFs),
      readdirSync: nodeFs.readdirSync as unknown as RegistrationFs['readdirSync'],
      statSync: nodeFs.statSync as unknown as RegistrationFs['statSync'],
      realpathSync: nodeFs.realpathSync as unknown as RegistrationFs['realpathSync'],
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    const r = readChannelRegistration({ candidateDirs: [WS], homeDir: home, serverStartedAtMs: START, sessionId: SID, fs });
    expect(r.state).toBe('unknown');
  });
  it('never reads another project dir (decoy says registered)', () => {
    writeLog('/other/project', ln(REG, START + 1000), START + 1000);
    expect(read()).toMatchObject({ state: 'unknown' });
  });
});

function mkLogger(): Logger & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, info: vi.fn((e: string, d: Record<string, unknown> = {}) => void calls.push([e, d])), warn: vi.fn(), error: vi.fn() } as never;
}

describe('createWakeRouter', () => {
  it('registered: tmux never called, one channel delivery_path log', () => {
    const logger = mkLogger();
    const route = createWakeRouter({ logger, read: () => ({ state: 'registered', logFile: '/l' }) });
    route(() => {
      throw new Error('wakeViaTmux must not be called');
    });
    expect(logger.calls).toEqual([['delivery_path', { path: 'channel', evidence: 'registered', log_file: '/l' }]]);
  });
  it.each([
    [{ state: 'skipped', logFile: '/l' } as const, { path: 'tmux_wake', evidence: 'skipped' }],
    [{ state: 'unknown', reason: 'r' } as const, { path: 'tmux_wake', evidence: 'unknown', reason: 'r' }],
  ])('%j: tmux called exactly once', (reg, logged) => {
    const logger = mkLogger();
    const wake = vi.fn();
    createWakeRouter({ logger, read: () => reg })(wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(logger.calls).toEqual([['delivery_path', logged]]);
  });
  it('latches registered: no second read', () => {
    const rd = vi.fn(() => ({ state: 'registered', logFile: '/l' }) as const);
    const route = createWakeRouter({ logger: mkLogger(), read: rd });
    const wake = vi.fn();
    route(wake);
    route(wake);
    expect(rd).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
  });
  it('unknown then registered: tmux, then channel', () => {
    const states = [{ state: 'unknown', reason: 'r' }, { state: 'registered', logFile: '/l' }] as const;
    let i = 0;
    const route = createWakeRouter({ logger: mkLogger(), read: () => states[i++]! });
    const wake = vi.fn();
    route(wake);
    route(wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
