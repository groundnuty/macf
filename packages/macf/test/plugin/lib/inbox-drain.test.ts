import { describe, it, expect } from 'vitest';
import { drainInbox } from '../../../src/plugin/lib/inbox-drain.js';
import { createInMemoryInboxStore } from '../../../src/plugin/lib/inbox-store.js';
import type { InboxStore } from '../../../src/plugin/lib/inbox-store.js';

describe('drainInbox — DR-038 Decision 5 on-startup completeness half', () => {
  it('drains undrained inbox messages and marks each processed', async () => {
    const store = createInMemoryInboxStore();
    await store.persist({ id: 'a', payload: { hi: 1 }, receivedAt: 1000, processed: false });
    await store.persist({ id: 'b', payload: { hi: 2 }, receivedAt: 2000, processed: false });

    const drained = await drainInbox(store);

    expect(drained.map((e) => e.id).sort()).toEqual(['a', 'b']);
    // markProcessed was actually called — the store's own record now
    // reads processed:true (not just the returned snapshot).
    const entryA = await store.get('a');
    expect(entryA?.processed).toBe(true);
    const entryB = await store.get('b');
    expect(entryB?.processed).toBe(true);
  });

  it('is idempotent — re-running against the same store drains nothing new', async () => {
    const store = createInMemoryInboxStore();
    await store.persist({ id: 'a', payload: {}, receivedAt: 1000, processed: false });

    const first = await drainInbox(store);
    expect(first).toHaveLength(1);

    const second = await drainInbox(store);
    expect(second).toHaveLength(0);
  });

  it('leaves an already-processed entry (drained via a different trigger) undrained here too', async () => {
    // Models Decision 5's "dedup-by-message-id makes on-receipt and
    // on-startup safe to run overlapping": an entry the on-receipt path
    // already marked processed must not resurface via the on-startup
    // drain.
    const store = createInMemoryInboxStore();
    await store.persist({ id: 'a', payload: {}, receivedAt: 1000, processed: false });
    await store.markProcessed('a'); // simulates the on-receipt trigger having handled it

    const drained = await drainInbox(store);
    expect(drained).toHaveLength(0);
  });

  it('returns [] for an empty inbox — no drain noise', async () => {
    const store = createInMemoryInboxStore();
    const drained = await drainInbox(store);
    expect(drained).toEqual([]);
  });

  it('is driven entirely by the injected store (test swaps the driver)', async () => {
    let markedProcessed: string[] = [];
    const customStore: InboxStore = {
      persist: async () => true,
      has: async () => false,
      get: async () => undefined,
      listUndrained: async () => [
        { id: 'custom-1', payload: 'x', receivedAt: 42, processed: false },
      ],
      markProcessed: async (id: string) => {
        markedProcessed = [...markedProcessed, id];
      },
    };

    const drained = await drainInbox(customStore);

    expect(drained).toEqual([
      { id: 'custom-1', payload: 'x', receivedAt: 42, processed: false },
    ]);
    expect(markedProcessed).toEqual(['custom-1']);
  });
});

describe('createInMemoryInboxStore', () => {
  it('persist() dedups by id — returns wasNew:false on redelivery, existing entry untouched', async () => {
    const store = createInMemoryInboxStore();
    const first = await store.persist({ id: 'a', payload: { v: 1 }, receivedAt: 100, processed: false });
    expect(first).toBe(true);

    const second = await store.persist({ id: 'a', payload: { v: 2 }, receivedAt: 200, processed: false });
    expect(second).toBe(false);

    const stored = await store.get('a');
    expect(stored?.payload).toEqual({ v: 1 });
    expect(stored?.receivedAt).toBe(100);
  });

  it('markProcessed on an unknown id does not throw', async () => {
    const store = createInMemoryInboxStore();
    await expect(store.markProcessed('never-persisted')).resolves.toBeUndefined();
  });
});
