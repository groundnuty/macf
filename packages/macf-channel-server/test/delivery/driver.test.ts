/**
 * Tests for the DR-038 Decision 6 store-DRIVER seam (`delivery/driver.ts`,
 * groundnuty/macf#704).
 *
 * `createDefaultDeliveryStores` is the in-memory PLACEHOLDER — these tests
 * pin (a) it returns working `OutboxStore` / `InboxStore` instances, (b) it
 * logs the loud durability-caveat warning every time it's called (never
 * silently), and (c) the `DeliveryStores` shape is generic enough that a
 * completely different (non-in-memory) driver satisfying the same
 * `OutboxStore` / `InboxStore` interfaces drops into `createOutbox` /
 * `createInbox` unchanged — proving the wiring is driver-agnostic ahead of
 * the DR-008 disk-spool driver landing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDefaultDeliveryStores } from '../../src/delivery/driver.js';
import { createOutbox } from '../../src/delivery/outbox.js';
import { createInbox } from '../../src/delivery/inbox.js';
import type { OutboxStore, InboxStore, OutboxEntry, InboxEntry, Logger } from '@groundnuty/macf-core';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createDefaultDeliveryStores', () => {
  it('returns a working OutboxStore + InboxStore pair', async () => {
    const { outboxStore, inboxStore } = createDefaultDeliveryStores();
    await outboxStore.enqueue({
      id: 'm1', target: 't', payload: {}, enqueuedAt: 0, nextAttemptAt: 0, attemptCount: 0,
    });
    expect(await outboxStore.listPending()).toHaveLength(1);

    const accept = await inboxStore.persist({ id: 'm1', payload: {}, receivedAt: 0, processed: false });
    expect(accept).toBe(true);
    expect(await inboxStore.has('m1')).toBe(true);
  });

  it('logs a loud durability-caveat warning every call (never silent)', () => {
    const logger = mockLogger();
    createDefaultDeliveryStores(logger);
    expect(logger.warn).toHaveBeenCalledWith(
      'delivery_store_in_memory_placeholder',
      expect.objectContaining({ detail: expect.stringContaining('crash') }),
    );
  });

  it('is a clean no-op (does not throw) when called with no logger', () => {
    expect(() => createDefaultDeliveryStores()).not.toThrow();
  });

  it('each call returns an INDEPENDENT store pair (no shared state leak across calls)', async () => {
    const first = createDefaultDeliveryStores();
    const second = createDefaultDeliveryStores();
    await first.outboxStore.enqueue({
      id: 'only-in-first', target: 't', payload: {}, enqueuedAt: 0, nextAttemptAt: 0, attemptCount: 0,
    });
    expect(await first.outboxStore.listPending()).toHaveLength(1);
    expect(await second.outboxStore.listPending()).toHaveLength(0);
  });
});

/**
 * A minimal, DELIBERATELY non-in-memory-shaped store pair — a plain
 * array-backed implementation distinct from `in-memory-store.ts`'s Map-
 * backed one — to prove `createOutbox` / `createInbox` depend only on the
 * `OutboxStore` / `InboxStore` interface, not on any in-memory-driver
 * implementation detail. This is the shape a future DR-008 disk-spool
 * driver satisfies too.
 */
function createArrayBackedStores(): { outboxStore: OutboxStore; inboxStore: InboxStore } {
  const outboxEntries: OutboxEntry[] = [];
  const inboxEntries: InboxEntry[] = [];
  const outboxStore: OutboxStore = {
    enqueue: async (entry) => { outboxEntries.push({ ...entry }); },
    listPending: async () => outboxEntries.map((e) => ({ ...e })),
    reschedule: async (id, nextAttemptAt, attemptCount) => {
      const idx = outboxEntries.findIndex((e) => e.id === id);
      if (idx >= 0) outboxEntries[idx] = { ...outboxEntries[idx]!, nextAttemptAt, attemptCount };
    },
    markAcked: async (id) => {
      const idx = outboxEntries.findIndex((e) => e.id === id);
      if (idx >= 0) outboxEntries.splice(idx, 1);
    },
    deadLetter: async (id) => {
      const idx = outboxEntries.findIndex((e) => e.id === id);
      if (idx >= 0) outboxEntries.splice(idx, 1);
    },
  };
  const inboxStore: InboxStore = {
    persist: async (entry) => {
      if (inboxEntries.some((e) => e.id === entry.id)) return false;
      inboxEntries.push({ ...entry });
      return true;
    },
    has: async (id) => inboxEntries.some((e) => e.id === id),
    get: async (id) => {
      const found = inboxEntries.find((e) => e.id === id);
      return found === undefined ? undefined : { ...found };
    },
    listUndrained: async () => inboxEntries.filter((e) => !e.processed).map((e) => ({ ...e })),
    markProcessed: async (id) => {
      const idx = inboxEntries.findIndex((e) => e.id === id);
      if (idx >= 0) inboxEntries[idx] = { ...inboxEntries[idx]!, processed: true };
    },
  };
  return { outboxStore, inboxStore };
}

describe('driver-agnosticism — a non-in-memory-shaped store swaps in unchanged', () => {
  it('createOutbox works identically against an array-backed OutboxStore', async () => {
    const { outboxStore } = createArrayBackedStores();
    const outbox = createOutbox({ store: outboxStore, send: async () => ({ ack: true }), now: () => 1000 });

    const id = await outbox.enqueue('target-a', { hi: true });
    const summary = await outbox.driveOnce(1000);

    expect(summary).toEqual({ attempted: 1, acked: 1, failed: 0, deadLettered: 0 });
    expect(await outboxStore.listPending()).toHaveLength(0);
    expect(typeof id).toBe('string');
  });

  it('createInbox works identically against an array-backed InboxStore (dedup preserved)', async () => {
    const { inboxStore } = createArrayBackedStores();
    const inbox = createInbox({ store: inboxStore });

    const first = await inbox.accept('m1', { x: 1 });
    const second = await inbox.accept('m1', { x: 1 }); // redelivery

    expect(first.wasNew).toBe(true);
    expect(second.wasNew).toBe(false);
    expect(await inboxStore.has('m1')).toBe(true);
  });
});
