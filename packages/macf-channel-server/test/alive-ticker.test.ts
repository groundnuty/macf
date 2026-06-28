/**
 * Tests for the periodic "alive" tick (groundnuty/macf#642).
 *
 * The tick writes a heartbeat line to the forensic log every 60s so the log's
 * LAST line pinpoints the moment of a silent death (no crash handler ran — OOM,
 * SIGKILL, power loss). The timer is unref()'d so it can never pin the event
 * loop open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAliveTicker, DEFAULT_ALIVE_TICK_INTERVAL_MS } from '../src/alive-ticker.js';
import type { Logger } from '@groundnuty/macf-core';
import type { LifecycleTracker } from '../src/lifecycle.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fixedLifecycle(phase = 'serving', uptime = 1234): LifecycleTracker {
  return {
    set: vi.fn(),
    snapshot: () => ({ phase, uptime_ms: uptime }),
  };
}

describe('createAliveTicker', () => {
  it('exposes the default 60-second cadence', () => {
    expect(DEFAULT_ALIVE_TICK_INTERVAL_MS).toBe(60_000);
  });

  describe('interval lifecycle (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() logs an "alive" line on each interval with phase + uptime; stop() clears it', () => {
      const logger = mockLogger();
      const ticker = createAliveTicker({
        logger,
        lifecycle: fixedLifecycle('serving', 4242),
        intervalMs: 60_000,
      });

      ticker.start();
      // No immediate tick — the first line lands one interval in.
      expect(logger.info).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'alive',
        expect.objectContaining({ phase: 'serving', uptime_ms: 4242 }),
      );

      vi.advanceTimersByTime(180_000); // three more ticks
      expect(logger.info).toHaveBeenCalledTimes(4);

      ticker.stop();
      vi.advanceTimersByTime(600_000);
      expect(logger.info).toHaveBeenCalledTimes(4); // no further ticks after stop
    });

    it('start() is idempotent — a second call does not create a second interval', () => {
      const logger = mockLogger();
      const ticker = createAliveTicker({
        logger,
        lifecycle: fixedLifecycle(),
        intervalMs: 60_000,
      });

      ticker.start();
      ticker.start();
      vi.advanceTimersByTime(60_000);
      expect(logger.info).toHaveBeenCalledTimes(1); // single interval, not doubled

      ticker.stop();
    });

    it('stop() is idempotent and safe before start()', () => {
      const ticker = createAliveTicker({
        logger: mockLogger(),
        lifecycle: fixedLifecycle(),
        intervalMs: 60_000,
      });
      expect(() => {
        ticker.stop();
        ticker.stop();
      }).not.toThrow();
    });

    it('a thrown logger does not let the tick escape (best-effort, never crashes)', () => {
      const logger: Logger = {
        info: vi.fn(() => {
          throw new Error('disk full');
        }),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const ticker = createAliveTicker({
        logger,
        lifecycle: fixedLifecycle(),
        intervalMs: 60_000,
      });

      ticker.start();
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      ticker.stop();
    });
  });

  it('unref()s its timer so it cannot pin the event loop open', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const ticker = createAliveTicker({
      logger: mockLogger(),
      lifecycle: fixedLifecycle(),
      intervalMs: 60_000,
    });
    ticker.start();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    setIntervalSpy.mockRestore();
    vi.useRealTimers();
  });
});
