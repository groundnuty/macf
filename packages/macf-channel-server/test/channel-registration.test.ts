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
const read = (dirs: string[] = [WS]) =>
  readChannelRegistration({ candidateDirs: dirs, homeDir: home, serverStartedAtMs: START });

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
  it('registered', () => {
    const f = writeLog(WS, 'x Channel notifications registered y', START + 1000);
    expect(read()).toEqual({ state: 'registered', logFile: f });
  });
  it('skipped', () => {
    writeLog(WS, 'Channel notifications skipped: not in list', START + 1000);
    expect(read().state).toBe('skipped');
  });
  it('last marker wins', () => {
    writeLog(WS, 'Channel notifications skipped\nChannel notifications registered', START + 1000);
    expect(read().state).toBe('registered');
    writeLog(WS, 'Channel notifications registered\nChannel notifications skipped', START + 1000);
    expect(read().state).toBe('skipped');
  });
  it('unknown: missing dir', () => {
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no mcp-logs') });
  });
  it('unknown: no marker', () => {
    writeLog(WS, 'nothing here', START + 1000);
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no channel registration marker') });
  });
  it('unknown: stale file from a previous session', () => {
    writeLog(WS, 'Channel notifications registered', START - 60_000);
    expect(read()).toMatchObject({ state: 'unknown', reason: expect.stringContaining('older') });
  });
  it('unknown: unreadable file, never throws', () => {
    writeLog(WS, 'Channel notifications registered', START + 1000);
    const fs: RegistrationFs = {
      ...(nodeFs as unknown as RegistrationFs),
      readdirSync: nodeFs.readdirSync as unknown as RegistrationFs['readdirSync'],
      statSync: nodeFs.statSync as unknown as RegistrationFs['statSync'],
      realpathSync: nodeFs.realpathSync as unknown as RegistrationFs['realpathSync'],
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    const r = readChannelRegistration({ candidateDirs: [WS], homeDir: home, serverStartedAtMs: START, fs });
    expect(r).toMatchObject({ state: 'unknown', reason: 'mcp log unreadable' });
  });
  it('never reads another project dir (decoy says registered)', () => {
    writeLog('/other/project', 'Channel notifications registered', START + 1000);
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
