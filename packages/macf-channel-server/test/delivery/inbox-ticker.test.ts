/**
 * Tests for the DR-038 Decision 5 follow-on inbox orphan-drain ticker
 * (`delivery/inbox-ticker.ts`, groundnuty/macf#744).
 *
 * Mirrors `outbox-ticker.test.ts`'s exact shape (fake timers, unref()
 * assertion, idempotent start/stop) — this ticker is the mechanism that
 * drives `driveInboxOnce()` periodically over the channel-server's
 * lifetime, the same architectural role `createOutboxTicker` fills for the
 * sender side.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createInboxTicker,
  DEFAULT_INBOX_TICK_INTERVAL_MS,
} from '../../src/delivery/inbox-ticker.js';
import { createInMemoryInboxStore } from '../../src/delivery/in-memory-store.js';
import { createInbox } from '../../src/delivery/inbox.js';
import type { Inbox } from '../../src/delivery/inbox.js';
import type { Logger, NotifyPayload } from '@groundnuty/macf-core';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const payload: NotifyPayload = { type: 'mention', message: 'hi' };

async function inboxWithOneUndrained(): Promise<Inbox> {
  const store = createInMemoryInboxStore();
  const inbox = createInbox({ store, now: () => 0 });
  await inbox.accept('msg-1', payload);
  return inbox;
}

describe('createInboxTicker', () => {
  it('exposes the default 30-second cadence', () => {
    expect(DEFAULT_INBOX_TICK_INTERVAL_MS).toBe(30_000);
  });

  describe('interval lifecycle (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() calls driveInboxOnce() on each interval; stop() clears it', async () => {
      const inbox = await inboxWithOneUndrained();
      const onNotify = vi.fn(async () => {});
      // Large grace so the entry is never "due" — isolates interval firing
      // from drive-logic details; assert via onNotify call COUNT per tick.
      const ticker = createInboxTicker({
        inbox,
        onNotify,
        logger: mockLogger(),
        intervalMs: 30_000,
        graceMs: 0,
        now: () => 1_000_000,
      });

      ticker.start();
      expect(onNotify).not.toHaveBeenCalled(); // no immediate tick from start()

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onNotify).toHaveBeenCalledTimes(1);

      ticker.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(onNotify).toHaveBeenCalledTimes(1); // drained, no further ticks after stop
    });

    it('start() is idempotent — a second call does not create a second interval', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const ticker = createInboxTicker({
        inbox: await inboxWithOneUndrained(),
        onNotify: vi.fn(async () => {}),
        logger: mockLogger(),
        intervalMs: 30_000,
      });

      ticker.start();
      ticker.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      ticker.stop();
      setIntervalSpy.mockRestore();
    });

    it('stop() is idempotent and safe before start()', () => {
      const ticker = createInboxTicker({
        inbox: createInbox({ store: createInMemoryInboxStore() }),
        onNotify: vi.fn(async () => {}),
        logger: mockLogger(),
        intervalMs: 30_000,
      });
      expect(() => {
        ticker.stop();
        ticker.stop();
      }).not.toThrow();
    });

    it('logs a summary only when something happened (attempted or gaveUp > 0)', async () => {
      const logger = mockLogger();
      // Nothing undrained at all -> driveInboxOnce reports all-zero.
      const inbox = createInbox({ store: createInMemoryInboxStore() });
      const ticker = createInboxTicker({
        inbox,
        onNotify: vi.fn(async () => {}),
        logger,
        intervalMs: 30_000,
      });

      ticker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.info).not.toHaveBeenCalledWith('inbox_drain_tick', expect.anything());

      ticker.stop();
    });

    it('logs a summary when a tick drained an entry', async () => {
      const logger = mockLogger();
      const inbox = await inboxWithOneUndrained();
      const ticker = createInboxTicker({
        inbox,
        onNotify: vi.fn(async () => {}),
        logger,
        intervalMs: 30_000,
        graceMs: 0,
        now: () => 1_000_000,
      });

      ticker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.info).toHaveBeenCalledWith(
        'inbox_drain_tick',
        expect.objectContaining({ attempted: 1, drained: 1 }),
      );

      ticker.stop();
    });

    it('a driveInboxOnce rejection does not let the tick escape (best-effort, never crashes)', async () => {
      const logger = mockLogger();
      const badInbox: Inbox = {
        accept: async () => ({ wasNew: true }),
        undrained: async () => {
          throw new Error('store I/O error');
        },
        markProcessed: async () => {},
      };
      const ticker = createInboxTicker({
        inbox: badInbox,
        onNotify: vi.fn(async () => {}),
        logger,
        intervalMs: 30_000,
      });

      ticker.start();
      await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        'inbox_drain_tick_failed',
        expect.objectContaining({ error: expect.stringContaining('store I/O error') }),
      );

      ticker.stop();
    });

    it('tickNow() drives immediately, outside the interval schedule', async () => {
      const inbox = await inboxWithOneUndrained();
      const onNotify = vi.fn(async () => {});
      const ticker = createInboxTicker({
        inbox,
        onNotify,
        logger: mockLogger(),
        intervalMs: 30_000,
        graceMs: 0,
        now: () => 1_000_000,
      });

      await ticker.tickNow();
      expect(onNotify).toHaveBeenCalledTimes(1);
      // The interval hasn't started at all — tickNow is independent of start().
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onNotify).toHaveBeenCalledTimes(1); // entry already drained, nothing left to fire
    });

    it('attempts accumulate across ticks (the ticker owns one long-lived Map)', async () => {
      const inbox = await inboxWithOneUndrained();
      const onNotify = vi.fn(async () => {
        throw new Error('persistently broken');
      });
      const ticker = createInboxTicker({
        inbox,
        onNotify,
        logger: mockLogger(),
        intervalMs: 30_000,
        graceMs: 0,
        maxAttempts: 2,
        now: () => 1_000_000,
      });

      await ticker.tickNow(); // attempt 1 — fails
      await ticker.tickNow(); // attempt 2 — fails, now at cap
      await ticker.tickNow(); // would be attempt 3, but capped — must NOT re-fire

      expect(onNotify).toHaveBeenCalledTimes(2);
    });
  });

  it('unref()s its timer so it cannot pin the event loop open', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const ticker = createInboxTicker({
      inbox: createInbox({ store: createInMemoryInboxStore() }),
      onNotify: vi.fn(async () => {}),
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
