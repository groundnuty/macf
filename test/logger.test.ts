import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../src/logger.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('createLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON lines to log file', () => {
    const logPath = join(dir, 'test.log');
    const logger = createLogger({ logPath });

    logger.info('server_started', { port: 8847 });
    logger.warn('cert_expiring', { days: 7 });
    logger.error('connection_failed', { reason: 'timeout' });

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const first = JSON.parse(lines[0]!);
    expect(first.level).toBe('info');
    expect(first.event).toBe('server_started');
    expect(first.port).toBe(8847);
    expect(first.ts).toBeDefined();

    const second = JSON.parse(lines[1]!);
    expect(second.level).toBe('warn');

    const third = JSON.parse(lines[2]!);
    expect(third.level).toBe('error');
    expect(third.reason).toBe('timeout');
  });

  it('creates log file if it does not exist', () => {
    const logPath = join(dir, 'new.log');
    expect(existsSync(logPath)).toBe(false);

    createLogger({ logPath });
    expect(existsSync(logPath)).toBe(true);
  });

  it('creates nested directories for log file', () => {
    const logPath = join(dir, 'nested', 'deep', 'test.log');
    createLogger({ logPath });
    expect(existsSync(logPath)).toBe(true);
  });

  it('echoes to stderr in debug mode', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createLogger({ debug: true });

    logger.info('test_event', { key: 'value' });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.event).toBe('test_event');
    expect(parsed.key).toBe('value');

    stderrSpy.mockRestore();
  });

  it('does not echo to stderr when debug is false', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createLogger({ logPath: join(dir, 'quiet.log') });

    logger.info('silent_event');

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('works with no logPath and no debug (no-op logger)', () => {
    const logger = createLogger({});
    // Should not throw
    logger.info('event');
    logger.warn('event');
    logger.error('event');
  });

  it('includes ISO timestamp in log entries', () => {
    const logPath = join(dir, 'ts.log');
    const logger = createLogger({ logPath });

    logger.info('check_ts');

    const line = readFileSync(logPath, 'utf-8').trim();
    const entry = JSON.parse(line);
    // ISO 8601 format check
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });
});
