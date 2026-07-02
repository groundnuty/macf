/**
 * Tests for the DR-038 Decision 5 follow-on live inbox orphan-drain logic
 * (`delivery/inbox-drain-driver.ts`, groundnuty/macf#744).
 *
 * Exercises the 4 science-blessed contract constraints directly against
 * `driveInboxOnce()`, using the reference in-memory `InboxStore` + a fake
 * `onNotify` the tests control.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInMemoryInboxStore } from '../../src/delivery/in-memory-store.js';
import { createInbox } from '../../src/delivery/inbox.js';
import {
  driveInboxOnce,
  DEFAULT_INBOX_DRAIN_GRACE_MS,
  DEFAULT_INBOX_MAX_ATTEMPTS,
  DEFAULT_INBOX_TTL_MS,
} from '../../src/delivery/inbox-drain-driver.js';
import type { NotifyPayload, Logger } from '@groundnuty/macf-core';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const payload: NotifyPayload = { type: 'mention', message: 'hello' };

describe('driveInboxOnce — defaults', () => {
  it('exposes the documented default grace/attempts/ttl', () => {
    expect(DEFAULT_INBOX_DRAIN_GRACE_MS).toBe(30_000);
    expect(DEFAULT_INBOX_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_INBOX_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('driveInboxOnce — constraint 1: grace-before-drain', () => {
  it('does not re-fire an entry younger than the grace window', async () => {
    const store = createInMemoryInboxStore();
    let clock = 1_000;
    const inbox = createInbox({ store, now: () => clock });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {});
    clock = 1_000 + 5_000; // only 5s old — well under the 30s default grace

    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts: new Map(),
      now: () => clock,
    });

    expect(onNotify).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 0, drained: 0, failed: 0, gaveUp: 0 });
    expect(await inbox.undrained()).toHaveLength(1); // still sitting, untouched
  });

  it('re-fires an entry once it is older than the grace window', async () => {
    const store = createInMemoryInboxStore();
    let clock = 1_000;
    const inbox = createInbox({ store, now: () => clock });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {});
    clock = 1_000 + 31_000; // past the 30s default grace

    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts: new Map(),
      now: () => clock,
    });

    expect(onNotify).toHaveBeenCalledExactlyOnceWith(payload);
    expect(summary).toEqual({ attempted: 1, drained: 1, failed: 0, gaveUp: 0 });
  });
});

describe('driveInboxOnce — constraint 2: markProcessed ONLY on success', () => {
  it('onNotify success -> markProcessed called, entry drained', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {});
    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts: new Map(),
      now: () => 1_000_000, // comfortably past grace
    });

    expect(summary).toEqual({ attempted: 1, drained: 1, failed: 0, gaveUp: 0 });
    expect(await inbox.undrained()).toHaveLength(0);
    expect(await store.get('msg-1')).toMatchObject({ processed: true });
  });

  it('onNotify throws -> markProcessed NOT called, entry stays undrained', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {
      throw new Error('mcp push failed');
    });
    const attempts = new Map<string, number>();
    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts,
      now: () => 1_000_000,
    });

    expect(summary).toEqual({ attempted: 1, drained: 0, failed: 1, gaveUp: 0 });
    expect(await inbox.undrained()).toHaveLength(1);
    expect(await store.get('msg-1')).toMatchObject({ processed: false });
    expect(attempts.get('msg-1')).toBe(1);
  });

  it('a driveInboxOnce call never throws even when onNotify rejects', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);
    const onNotify = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      driveInboxOnce({ inbox, onNotify, attempts: new Map(), now: () => 1_000_000, logger: mockLogger() }),
    ).resolves.toEqual({ attempted: 1, drained: 0, failed: 1, gaveUp: 0 });
  });
});

describe('driveInboxOnce — constraint 3: bounded push-retries (attempt cap)', () => {
  it('gives up after maxAttempts failures — no longer re-fired, stays undrained', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {
      throw new Error('persistently broken');
    });
    const attempts = new Map<string, number>();
    const maxAttempts = 3;
    const t = 1_000_000;

    // Drive 3 failing ticks — each should invoke onNotify and fail.
    for (let i = 0; i < maxAttempts; i++) {
      const summary = await driveInboxOnce({ inbox, onNotify, attempts, maxAttempts, now: () => t });
      expect(summary.attempted).toBe(1);
      expect(summary.failed).toBe(1);
    }
    expect(onNotify).toHaveBeenCalledTimes(maxAttempts);
    expect(attempts.get('msg-1')).toBe(maxAttempts);

    // A 4th tick must NOT re-fire onNotify at all — the entry is given up.
    const summary4 = await driveInboxOnce({ inbox, onNotify, attempts, maxAttempts, now: () => t });
    expect(onNotify).toHaveBeenCalledTimes(maxAttempts); // unchanged
    expect(summary4).toEqual({ attempted: 0, drained: 0, failed: 0, gaveUp: 1 });

    // The entry is still undrained (left for the future surface-as-text path).
    expect(await inbox.undrained()).toHaveLength(1);
    expect(await store.get('msg-1')).toMatchObject({ processed: false });
  });
});

describe('driveInboxOnce — constraint 3: bounded push-retries (TTL)', () => {
  it('gives up once the entry exceeds the TTL, without attempting onNotify', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {});
    const ttlMs = 1_000;
    const logger = mockLogger();

    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts: new Map(),
      ttlMs,
      now: () => 5_000, // well past the 1s TTL
      logger,
    });

    expect(onNotify).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 0, drained: 0, failed: 0, gaveUp: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      'inbox_drain_gave_up',
      expect.objectContaining({ id: 'msg-1', reason: 'ttl_exceeded' }),
    );
    expect(await inbox.undrained()).toHaveLength(1); // still undrained
  });

  it('a TTL-given-up entry is never re-attempted on a later tick', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('msg-1', payload);

    const onNotify = vi.fn(async () => {});
    const attempts = new Map<string, number>();
    const ttlMs = 1_000;

    await driveInboxOnce({ inbox, onNotify, attempts, ttlMs, now: () => 5_000 });
    const second = await driveInboxOnce({ inbox, onNotify, attempts, ttlMs, now: () => 10_000 });

    expect(onNotify).not.toHaveBeenCalled();
    expect(second).toEqual({ attempted: 0, drained: 0, failed: 0, gaveUp: 1 });
  });
});

describe('driveInboxOnce — constraint 4: ownership split (never surfaces-as-text)', () => {
  it('a given-up entry remains undrained and untouched for the future text-surfacing path', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('orphan-1', payload);

    const onNotify = vi.fn(async () => {
      throw new Error('down');
    });
    const attempts = new Map<string, number>();
    const maxAttempts = 1;

    // One failure immediately exhausts the (deliberately tiny) cap.
    await driveInboxOnce({ inbox, onNotify, attempts, maxAttempts, now: () => 1_000_000 });
    await driveInboxOnce({ inbox, onNotify, attempts, maxAttempts, now: () => 2_000_000 });
    await driveInboxOnce({ inbox, onNotify, attempts, maxAttempts, now: () => 3_000_000 });

    // Never called more than the cap allows — the driver gave up silently,
    // it did not itself surface the entry as text anywhere.
    expect(onNotify).toHaveBeenCalledTimes(maxAttempts);

    const undrained = await inbox.undrained();
    expect(undrained.map((e) => e.id)).toEqual(['orphan-1']);
    expect(undrained[0]?.processed).toBe(false);
  });

  it('an already given-up entry does not block a fresh entry in the SAME tick', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('given-up', payload);
    await inbox.accept('fresh', payload);

    const maxAttempts = 3;
    const attempts = new Map<string, number>([['given-up', maxAttempts]]); // pre-exhausted

    const onNotify = vi.fn(async () => {});
    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts,
      maxAttempts,
      now: () => 1_000_000,
    });

    // Only the fresh entry was re-fired; the given-up one was skipped
    // silently and counted, not re-attempted.
    expect(onNotify).toHaveBeenCalledExactlyOnceWith(payload);
    expect(summary).toEqual({ attempted: 1, drained: 1, failed: 0, gaveUp: 1 });

    const undrained = await inbox.undrained();
    expect(undrained.map((e) => e.id)).toEqual(['given-up']);
  });
});

describe('driveInboxOnce — multiple undrained entries in one tick', () => {
  it('processes each entry independently within a single call', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 0 });
    await inbox.accept('a', payload);
    await inbox.accept('b', payload);

    let callCount = 0;
    const onNotify = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('first fails');
    });

    const summary = await driveInboxOnce({
      inbox,
      onNotify,
      attempts: new Map(),
      now: () => 1_000_000,
    });

    expect(summary.attempted).toBe(2);
    expect(summary.drained).toBe(1);
    expect(summary.failed).toBe(1);
    const undrained = await inbox.undrained();
    expect(undrained).toHaveLength(1);
  });
});
