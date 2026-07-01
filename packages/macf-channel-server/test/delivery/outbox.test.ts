import { describe, it, expect, vi } from 'vitest';
import { createInMemoryOutboxStore } from '../../src/delivery/in-memory-store.js';
import { createOutbox, computeBackoffMs } from '../../src/delivery/outbox.js';
import type { OutboxSendFn } from '../../src/delivery/outbox.js';
import type { OutboxEntry } from '../../src/delivery/store.js';

describe('computeBackoffMs', () => {
  it('doubles from the base on each successive attemptCount', () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(3)).toBe(8000);
  });

  it('caps at the default 5-minute ceiling', () => {
    // 2^8 * 1000 = 256_000 < 300_000 (not yet capped)
    expect(computeBackoffMs(8)).toBe(256_000);
    // 2^9 * 1000 = 512_000 > 300_000 → capped
    expect(computeBackoffMs(9)).toBe(300_000);
    expect(computeBackoffMs(20)).toBe(300_000);
  });

  it('honors custom base/cap overrides', () => {
    expect(computeBackoffMs(0, 500, 2000)).toBe(500);
    expect(computeBackoffMs(4, 500, 2000)).toBe(2000); // 500*16=8000 → capped to 2000
  });
});

describe('createOutbox — persist-then-send (DR-038 Decision 1)', () => {
  it('the entry is already durably in the store by the time send is invoked', async () => {
    const store = createInMemoryOutboxStore();
    const calls: string[] = [];
    const originalEnqueue = store.enqueue.bind(store);
    store.enqueue = async (entry: OutboxEntry): Promise<void> => {
      calls.push('store.enqueue');
      return originalEnqueue(entry);
    };

    const send: OutboxSendFn = async (_target, id) => {
      calls.push('send');
      // The whole point of persist-then-send: by the time `send` fires, the
      // entry is already readable back out of the store.
      const pending = await store.listPending();
      expect(pending.some((e) => e.id === id)).toBe(true);
      return { ack: true };
    };

    const outbox = createOutbox({ store, send, now: () => 1000 });
    await outbox.enqueue('science-agent', { hi: true });
    await outbox.driveOnce(1000);

    expect(calls).toEqual(['store.enqueue', 'send']);
  });
});

describe('createOutbox — ack path', () => {
  it('ack:true removes the entry from the outbox', async () => {
    const store = createInMemoryOutboxStore();
    const send: OutboxSendFn = async () => ({ ack: true });
    const outbox = createOutbox({ store, send, now: () => 1000 });

    await outbox.enqueue('target-a', { x: 1 });
    const summary = await outbox.driveOnce(1000);

    expect(summary).toEqual({ attempted: 1, acked: 1, failed: 0, deadLettered: 0 });
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe('createOutbox — retry + backoff + id stability (DR-038 Decision 2)', () => {
  it('a failed send reschedules with exponential backoff and reuses the SAME message-id', async () => {
    const store = createInMemoryOutboxStore();
    const seenIds = new Set<string>();
    const send: OutboxSendFn = async (_target, id) => {
      seenIds.add(id);
      return { ack: false };
    };

    const outbox = createOutbox({ store, send, now: () => 0 });
    const id = await outbox.enqueue('target-a', { x: 1 });

    await outbox.driveOnce(0); // attempt #1 fails → backoff(0) = 1000ms
    let [entry] = await store.listPending();
    expect(entry?.id).toBe(id);
    expect(entry?.attemptCount).toBe(1);
    expect(entry?.nextAttemptAt).toBe(1000);

    // Not due yet at t=500 — must not re-attempt.
    await outbox.driveOnce(500);
    expect(seenIds.size).toBe(1);

    await outbox.driveOnce(1000); // attempt #2 fails → backoff(1) = 2000ms → next = 3000
    [entry] = await store.listPending();
    expect(entry?.attemptCount).toBe(2);
    expect(entry?.nextAttemptAt).toBe(3000);
    expect(entry?.id).toBe(id);

    // Only ever ONE distinct id seen across every attempt.
    expect(seenIds.size).toBe(1);
    expect([...seenIds][0]).toBe(id);
  });

  it('a thrown/rejected send is treated as a delivery failure, not a crash', async () => {
    const store = createInMemoryOutboxStore();
    const send: OutboxSendFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const outbox = createOutbox({ store, send, now: () => 0 });

    await outbox.enqueue('target-a', {});
    const summary = await outbox.driveOnce(0);

    expect(summary.failed).toBe(1);
    const [entry] = await store.listPending();
    expect(entry?.attemptCount).toBe(1);
  });

  it('does not attempt a send before nextAttemptAt is due', async () => {
    const store = createInMemoryOutboxStore();
    let calls = 0;
    const send: OutboxSendFn = async () => {
      calls++;
      return { ack: true };
    };
    const outbox = createOutbox({ store, send, now: () => 1000 });

    await outbox.enqueue('target-a', {}); // enqueuedAt = nextAttemptAt = 1000
    const summary = await outbox.driveOnce(500); // before the entry is due

    expect(summary).toEqual({ attempted: 0, acked: 0, failed: 0, deadLettered: 0 });
    expect(calls).toBe(0);
  });
});

describe('createOutbox — TTL expiry + dead-letter (DR-038 Decision 4)', () => {
  it('TTL-expiry dead-letters the entry (removed from pending) and fires onDeadLetter — without attempting another send', async () => {
    const store = createInMemoryOutboxStore();
    let sendCalls = 0;
    const send: OutboxSendFn = async () => {
      sendCalls++;
      return { ack: false };
    };
    const deadLettered: OutboxEntry[] = [];
    const outbox = createOutbox({
      store,
      send,
      now: () => 0,
      ttlMs: 5000,
      onDeadLetter: async (entry) => {
        deadLettered.push(entry);
      },
    });

    await outbox.enqueue('target-a', { x: 1 }); // enqueuedAt = 0
    const summary = await outbox.driveOnce(6000); // past the 5s TTL

    expect(summary.deadLettered).toBe(1);
    expect(summary.attempted).toBe(0); // no send attempted once TTL has expired
    expect(sendCalls).toBe(0);
    expect(await store.listPending()).toHaveLength(0);
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]?.target).toBe('target-a');
  });

  it('an onDeadLetter callback that throws is caught + logged, never aborting the tick', async () => {
    const store = createInMemoryOutboxStore();
    const send: OutboxSendFn = async () => ({ ack: false });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const outbox = createOutbox({
      store,
      send,
      now: () => 0,
      ttlMs: 1000,
      onDeadLetter: () => {
        throw new Error('escalation transport down');
      },
      logger,
    });

    await outbox.enqueue('target-a', {});
    const summary = await outbox.driveOnce(2000);

    expect(summary.deadLettered).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'outbox_dead_letter_callback_failed',
      expect.objectContaining({ id: expect.any(String), target: 'target-a' }),
    );
  });
});

describe('createOutbox — restart-survival (DR-038 Decision 4)', () => {
  it('a fresh Outbox instance over the SAME store resumes retrying a pending entry', async () => {
    const store = createInMemoryOutboxStore();

    // "Before restart": one Outbox instance, one failed attempt.
    const failingSend: OutboxSendFn = async () => ({ ack: false });
    const outboxBeforeRestart = createOutbox({ store, send: failingSend, now: () => 0 });
    const id = await outboxBeforeRestart.enqueue('target-a', { a: 1 });
    await outboxBeforeRestart.driveOnce(0); // fails → reschedule to t=1000

    // "After restart": a BRAND NEW Outbox instance (fresh closures/state,
    // as a relaunched process would construct) over the exact same
    // persisted store — nothing about the retry loop's in-memory state
    // carries over; only the store does.
    const ackedIds: string[] = [];
    const ackingSend: OutboxSendFn = async (_target, sendId) => {
      ackedIds.push(sendId);
      return { ack: true };
    };
    const outboxAfterRestart = createOutbox({ store, send: ackingSend, now: () => 1000 });
    const summary = await outboxAfterRestart.driveOnce(1000);

    expect(summary.acked).toBe(1);
    expect(ackedIds).toEqual([id]);
    expect(await store.listPending()).toHaveLength(0);
  });
});
