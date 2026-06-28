/**
 * Tests for the guaranteed forensic-log resolution + resilient logger
 * (groundnuty/macf#642).
 *
 * The channel-server can die silently when `MACF_LOG_PATH` is unset (the
 * macf-core logger no-ops). `resolveForensicLogPath` gives the channel-server a
 * deterministic default file under `$XDG_STATE_HOME` / `$HOME/.local/state` so a
 * forensic trail always exists — defense-in-depth, never relying on the
 * launcher. `createForensicLogger` wires that path into a real file logger but
 * degrades to a stderr-only logger if the file sink can't be created (the safety
 * net must never itself become the crash cause).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveForensicLogPath, createForensicLogger } from '../src/forensic-log.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-forensic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('resolveForensicLogPath', () => {
  it('returns an explicit MACF_LOG_PATH unchanged (back-compat — explicit wins)', () => {
    const path = resolveForensicLogPath({
      agentName: 'macf-code-agent',
      env: { MACF_LOG_PATH: '/var/log/macf/explicit.log' },
    });
    expect(path).toBe('/var/log/macf/explicit.log');
  });

  it('treats an empty MACF_LOG_PATH as unset and falls back to the default', () => {
    const path = resolveForensicLogPath({
      agentName: 'macf-code-agent',
      env: { MACF_LOG_PATH: '', XDG_STATE_HOME: '/xdg/state' },
    });
    expect(path).toBe('/xdg/state/macf/macf-code-agent-channel.log');
  });

  it('defaults under $XDG_STATE_HOME/macf/<agentName>-channel.log when set', () => {
    const path = resolveForensicLogPath({
      agentName: 'macf-science-agent',
      env: { XDG_STATE_HOME: '/home/u/.local/state' },
    });
    expect(path).toBe('/home/u/.local/state/macf/macf-science-agent-channel.log');
  });

  it('defaults under $HOME/.local/state/macf when XDG_STATE_HOME is unset', () => {
    const path = resolveForensicLogPath({
      agentName: 'macf-code-agent',
      env: { HOME: '/home/u' },
    });
    expect(path).toBe('/home/u/.local/state/macf/macf-code-agent-channel.log');
  });

  it('falls back to the OS tmpdir when neither XDG_STATE_HOME nor HOME is set', () => {
    const path = resolveForensicLogPath({ agentName: 'macf-code-agent', env: {} });
    expect(path).toBe(join(tmpdir(), 'macf', 'macf-code-agent-channel.log'));
  });

  it('sanitizes path separators in the agent name into a single safe segment (no traversal)', () => {
    const path = resolveForensicLogPath({
      agentName: '../../etc/passwd',
      env: { XDG_STATE_HOME: '/xdg/state' },
    });
    // Separators become `_`, so the name collapses into ONE filename segment
    // under .../macf/ — no `/` survives, so traversal is impossible. Dots are
    // retained (legal in filenames; `-channel.log` is always appended so the
    // segment can never be exactly `.`/`..`).
    expect(path).toBe('/xdg/state/macf/.._.._etc_passwd-channel.log');
    const segment = path.slice('/xdg/state/macf/'.length);
    expect(segment).not.toContain('/');
  });

  it('uses a placeholder when the agent name is empty after sanitizing', () => {
    const path = resolveForensicLogPath({ agentName: '', env: { XDG_STATE_HOME: '/xdg/state' } });
    expect(path).toBe('/xdg/state/macf/agent-channel.log');
  });
});

describe('createForensicLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates a file logger at the resolved path and reports fileActive=true', () => {
    const logPath = join(dir, 'state', 'macf', 'macf-code-agent-channel.log');
    const result = createForensicLogger({
      agentName: 'macf-code-agent',
      debug: false,
      env: { XDG_STATE_HOME: join(dir, 'state') },
    });

    expect(result.logPath).toBe(logPath);
    expect(result.fileActive).toBe(true);

    result.logger.info('probe', { k: 'v' });
    expect(existsSync(logPath)).toBe(true);
    const line = readFileSync(logPath, 'utf-8').trim();
    expect(JSON.parse(line).event).toBe('probe');
  });

  it('honors an explicit MACF_LOG_PATH', () => {
    const logPath = join(dir, 'explicit.log');
    const result = createForensicLogger({
      agentName: 'macf-code-agent',
      debug: false,
      env: { MACF_LOG_PATH: logPath },
    });
    expect(result.logPath).toBe(logPath);
    expect(result.fileActive).toBe(true);
  });

  it('degrades to a stderr-only logger (fileActive=false) when the file sink cannot be created', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Point the forensic dir at a path whose parent is a FILE, so mkdir -p throws.
    const fileNotDir = join(dir, 'iam-a-file');
    mkdirSync(dir, { recursive: true });
    // create a regular file where a directory is expected
    writeFileSync(fileNotDir, 'x');

    const result = createForensicLogger({
      agentName: 'macf-code-agent',
      debug: false,
      env: { MACF_LOG_PATH: join(fileNotDir, 'nested', 'channel.log') },
    });

    expect(result.fileActive).toBe(false);
    // The logger still works (stderr sink) and never throws.
    expect(() => result.logger.error('still_alive', {})).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
