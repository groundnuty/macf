/**
 * Tests for the top-level crash handlers (groundnuty/macf#642).
 *
 * `registerCrashHandlers` installs `uncaughtException` + `unhandledRejection`
 * handlers that: (a) log the full error + stack + last-known lifecycle phase to
 * the forensic file logger AND stderr (stderr is the unreliable channel under
 * load, so the file is the load-bearing trail), (b) attempt a graceful
 * deregister with a HARD TIMEOUT so the handler can never hang, then (c)
 * process.exit(1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerCrashHandlers,
  DEFAULT_CRASH_DEREGISTER_TIMEOUT_MS,
} from '../src/crash-handlers.js';
import type { Logger } from '@groundnuty/macf-core';
import type { LifecycleTracker } from '../src/lifecycle.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fixedLifecycle(phase = 'serving', uptime = 4242): Pick<LifecycleTracker, 'snapshot'> {
  return { snapshot: () => ({ phase, uptime_ms: uptime }) };
}

interface Harness {
  readonly logger: Logger;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly stderrWrite: ReturnType<typeof vi.fn>;
  readonly handlers: Map<string, (err: unknown) => void>;
  readonly cleanup: ReturnType<typeof vi.fn>;
}

function setup(over?: {
  readonly getCleanup?: () => (() => Promise<unknown>) | undefined;
  readonly deregisterTimeoutMs?: number;
  readonly logger?: Logger;
}): Harness & { readonly api: ReturnType<typeof registerCrashHandlers> } {
  const logger = over?.logger ?? mockLogger();
  const exit = vi.fn();
  const stderrWrite = vi.fn();
  const handlers = new Map<string, (err: unknown) => void>();
  const cleanup = vi.fn().mockResolvedValue(true);

  const api = registerCrashHandlers({
    logger,
    lifecycle: fixedLifecycle(),
    getCleanup: over?.getCleanup ?? ((): (() => Promise<unknown>) => cleanup),
    deregisterTimeoutMs: over?.deregisterTimeoutMs,
    exit: exit as unknown as (code: number) => void,
    stderrWrite: stderrWrite as unknown as (msg: string) => void,
    register: (event, handler) => {
      handlers.set(event, handler);
    },
  });

  return { logger, exit, stderrWrite, handlers, cleanup, api };
}

describe('registerCrashHandlers', () => {
  it('exposes a sensible default deregister timeout', () => {
    expect(DEFAULT_CRASH_DEREGISTER_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('registers both uncaughtException and unhandledRejection handlers', () => {
    const h = setup();
    expect(h.handlers.has('uncaughtException')).toBe(true);
    expect(h.handlers.has('unhandledRejection')).toBe(true);
  });

  it('logs the error + stack + lifecycle to the FILE logger on uncaughtException', async () => {
    const h = setup();
    const err = new Error('boom');
    await h.api.handle('uncaught_exception', err);

    expect(h.logger.error).toHaveBeenCalledWith(
      'uncaught_exception',
      expect.objectContaining({
        error: 'boom',
        stack: expect.stringContaining('boom'),
        lifecycle_phase: 'serving',
        uptime_ms: 4242,
      }),
    );
  });

  it('also writes a LOUD line to stderr (the file may be the only trail, or vice-versa)', async () => {
    const h = setup();
    await h.api.handle('uncaught_exception', new Error('boom'));
    expect(h.stderrWrite).toHaveBeenCalled();
    const joined = h.stderrWrite.mock.calls.map(c => String(c[0])).join('');
    expect(joined).toContain('boom');
    expect(joined.toLowerCase()).toContain('uncaught_exception');
  });

  it('attempts graceful deregister via the cleanup, then exits 1', async () => {
    const h = setup();
    await h.api.handle('uncaught_exception', new Error('boom'));
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('handles a non-Error rejection reason (string) on unhandledRejection', async () => {
    const h = setup();
    await h.api.handle('unhandled_rejection', 'plain string reason');

    expect(h.logger.error).toHaveBeenCalledWith(
      'unhandled_rejection',
      expect.objectContaining({ error: 'plain string reason' }),
    );
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('still logs + exits 1 when no cleanup is available yet (crash during early startup)', async () => {
    const h = setup({ getCleanup: () => undefined });
    await h.api.handle('uncaught_exception', new Error('early boom'));

    expect(h.logger.error).toHaveBeenCalledWith('uncaught_exception', expect.any(Object));
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 even if the file logger itself throws (stderr is the backstop)', async () => {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    const h = setup({ logger });
    await h.api.handle('uncaught_exception', new Error('boom'));

    expect(h.stderrWrite).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('does not re-run cleanup on a re-entrant crash; forces exit', async () => {
    const h = setup();
    // First crash starts handling; a synchronous re-entrant crash mid-handle.
    const first = h.api.handle('uncaught_exception', new Error('first'));
    await h.api.handle('uncaught_exception', new Error('reentrant'));
    await first;

    // cleanup ran for the first crash only.
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  describe('hard deregister timeout (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('exits 1 even when cleanup hangs past the timeout, and logs the timeout', async () => {
      const logger = mockLogger();
      // A cleanup that never resolves.
      const hangingCleanup = vi.fn(() => new Promise<unknown>(() => { /* never resolves */ }));
      const exit = vi.fn();
      const stderrWrite = vi.fn();
      const api = registerCrashHandlers({
        logger,
        lifecycle: fixedLifecycle(),
        getCleanup: () => hangingCleanup,
        deregisterTimeoutMs: 5_000,
        exit: exit as unknown as (code: number) => void,
        stderrWrite: stderrWrite as unknown as (msg: string) => void,
        register: () => { /* not used */ },
      });

      const p = api.handle('uncaught_exception', new Error('boom'));
      await vi.advanceTimersByTimeAsync(5_000);
      await p;

      expect(hangingCleanup).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'crash_cleanup_timeout',
        expect.objectContaining({ timeout_ms: 5_000 }),
      );
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
