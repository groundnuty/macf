/**
 * Tests for the DR-038 Decision 4 outbox retry-drive ticker
 * (`delivery/outbox-ticker.ts`, groundnuty/macf#704).
 *
 * Mirrors `alive-ticker.test.ts`'s exact shape (fake timers, unref()
 * assertion, idempotent start/stop) — this ticker is the mechanism that
 * drives `Outbox.driveOnce()` periodically over the channel-server's
 * lifetime, the same architectural role `createAliveTicker` /
 * `createRegistryHeartbeat` fill for their own concerns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createOutboxTicker,
  DEFAULT_OUTBOX_TICK_INTERVAL_MS,
} from '../../src/delivery/outbox-ticker.js';
import type { Outbox, OutboxDriveSummary } from '../../src/delivery/outbox.js';
import type { Logger } from '@groundnuty/macf-core';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeOutbox(driveOnce: (now?: number) => Promise<OutboxDriveSummary>): Outbox {
  return {
    enqueue: vi.fn(async () => 'fake-id'),
    driveOnce,
  };
}

const emptySummary: OutboxDriveSummary = { attempted: 0, acked: 0, failed: 0, deadLettered: 0 };

describe('createOutboxTicker', () => {
  it('exposes the default 30-second cadence', () => {
    expect(DEFAULT_OUTBOX_TICK_INTERVAL_MS).toBe(30_000);
  });

  describe('interval lifecycle (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() calls driveOnce() on each interval; stop() clears it', async () => {
      const driveOnce = vi.fn(async () => emptySummary);
      const ticker = createOutboxTicker({
        outbox: fakeOutbox(driveOnce),
        logger: mockLogger(),
        intervalMs: 30_000,
      });

      ticker.start();
      // No immediate tick from start() itself — one interval must elapse.
      expect(driveOnce).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(driveOnce).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90_000); // three more ticks
      expect(driveOnce).toHaveBeenCalledTimes(4);

      ticker.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(driveOnce).toHaveBeenCalledTimes(4); // no further ticks after stop
    });

    it('start() is idempotent — a second call does not create a second interval', async () => {
      const driveOnce = vi.fn(async () => emptySummary);
      const ticker = createOutboxTicker({
        outbox: fakeOutbox(driveOnce),
        logger: mockLogger(),
        intervalMs: 30_000,
      });

      ticker.start();
      ticker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(driveOnce).toHaveBeenCalledTimes(1); // single interval, not doubled

      ticker.stop();
    });

    it('stop() is idempotent and safe before start()', () => {
      const ticker = createOutboxTicker({
        outbox: fakeOutbox(async () => emptySummary),
        logger: mockLogger(),
        intervalMs: 30_000,
      });
      expect(() => {
        ticker.stop();
        ticker.stop();
      }).not.toThrow();
    });

    it('logs a summary only when something happened (attempted or dead-lettered > 0)', async () => {
      const logger = mockLogger();
      const driveOnce = vi.fn(async () => emptySummary); // nothing due
      const ticker = createOutboxTicker({ outbox: fakeOutbox(driveOnce), logger, intervalMs: 30_000 });

      ticker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.info).not.toHaveBeenCalledWith('outbox_drive_tick', expect.anything());

      ticker.stop();
    });

    it('logs a summary when a tick attempted or dead-lettered an entry', async () => {
      const logger = mockLogger();
      const driveOnce = vi.fn(async () => ({ attempted: 1, acked: 1, failed: 0, deadLettered: 0 }));
      const ticker = createOutboxTicker({ outbox: fakeOutbox(driveOnce), logger, intervalMs: 30_000 });

      ticker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.info).toHaveBeenCalledWith(
        'outbox_drive_tick',
        expect.objectContaining({ attempted: 1, acked: 1 }),
      );

      ticker.stop();
    });

    it('a driveOnce rejection does not let the tick escape (best-effort, never crashes)', async () => {
      const logger = mockLogger();
      const driveOnce = vi.fn(async () => {
        throw new Error('store I/O error');
      });
      const ticker = createOutboxTicker({ outbox: fakeOutbox(driveOnce), logger, intervalMs: 30_000 });

      ticker.start();
      await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        'outbox_drive_tick_failed',
        expect.objectContaining({ error: expect.stringContaining('store I/O error') }),
      );

      ticker.stop();
    });

    it('tickNow() drives immediately, outside the interval schedule', async () => {
      const driveOnce = vi.fn(async () => emptySummary);
      const ticker = createOutboxTicker({ outbox: fakeOutbox(driveOnce), logger: mockLogger(), intervalMs: 30_000 });

      await ticker.tickNow();
      expect(driveOnce).toHaveBeenCalledTimes(1);
      // The interval hasn't started at all — tickNow is independent of start().
      await vi.advanceTimersByTimeAsync(30_000);
      expect(driveOnce).toHaveBeenCalledTimes(1);
    });
  });

  it('unref()s its timer so it cannot pin the event loop open', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const ticker = createOutboxTicker({
      outbox: fakeOutbox(async () => emptySummary),
      logger: mockLogger(),
      intervalMs: 30_000,
    });
    ticker.start();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    setIntervalSpy.mockRestore();
    vi.useRealTimers();
  });
});
