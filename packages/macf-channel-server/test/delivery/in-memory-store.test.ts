import { describe, it, expect } from 'vitest';
import {
  createInMemoryOutboxStore,
  createInMemoryInboxStore,
} from '../../src/delivery/in-memory-store.js';
import type { OutboxEntry, InboxEntry } from '@groundnuty/macf-core';

function outboxEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'msg-1',
    target: 'science-agent',
    payload: { hello: 'world' },
    enqueuedAt: 1000,
    nextAttemptAt: 1000,
    attemptCount: 0,
    ...overrides,
  };
}

function inboxEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'msg-1',
    payload: { hello: 'world' },
    receivedAt: 1000,
    processed: false,
    ...overrides,
  };
}

describe('createInMemoryOutboxStore', () => {
  it('enqueue then listPending returns the entry', async () => {
    const store = createInMemoryOutboxStore();
    await store.enqueue(outboxEntry());
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(outboxEntry());
  });

  it('listPending returns a copy — mutating it does not affect the store', async () => {
    const store = createInMemoryOutboxStore();
    await store.enqueue(outboxEntry());
    const pending = await store.listPending();
    // @ts-expect-error -- deliberately mutating a readonly field to prove isolation
    pending[0].attemptCount = 999;
    const pendingAgain = await store.listPending();
    expect(pendingAgain[0]?.attemptCount).toBe(0);
  });

  it('reschedule bumps nextAttemptAt + attemptCount in place', async () => {
    const store = createInMemoryOutboxStore();
    await store.enqueue(outboxEntry());
    await store.reschedule('msg-1', 5000, 1);
    const [entry] = await store.listPending();
    expect(entry?.nextAttemptAt).toBe(5000);
    expect(entry?.attemptCount).toBe(1);
  });

  it('reschedule on an unknown id is a no-op', async () => {
    const store = createInMemoryOutboxStore();
    await expect(store.reschedule('nope', 1, 1)).resolves.toBeUndefined();
    expect(await store.listPending()).toHaveLength(0);
  });

  it('markAcked removes the entry', async () => {
    const store = createInMemoryOutboxStore();
    await store.enqueue(outboxEntry());
    await store.markAcked('msg-1');
    expect(await store.listPending()).toHaveLength(0);
  });

  it('deadLetter removes the entry', async () => {
    const store = createInMemoryOutboxStore();
    await store.enqueue(outboxEntry());
    await store.deadLetter('msg-1');
    expect(await store.listPending()).toHaveLength(0);
  });

  it('two independent stores do not share state', async () => {
    const a = createInMemoryOutboxStore();
    const b = createInMemoryOutboxStore();
    await a.enqueue(outboxEntry());
    expect(await a.listPending()).toHaveLength(1);
    expect(await b.listPending()).toHaveLength(0);
  });
});

describe('createInMemoryInboxStore', () => {
  it('persist on a new id returns wasNew=true and stores the entry', async () => {
    const store = createInMemoryInboxStore();
    const wasNew = await store.persist(inboxEntry());
    expect(wasNew).toBe(true);
    expect(await store.has('msg-1')).toBe(true);
    expect(await store.get('msg-1')).toEqual(inboxEntry());
  });

  it('persist on an already-present id is a dedup no-op: returns wasNew=false, entry untouched', async () => {
    const store = createInMemoryInboxStore();
    await store.persist(inboxEntry({ receivedAt: 1000, payload: { v: 1 } }));
    const wasNew = await store.persist(inboxEntry({ receivedAt: 9999, payload: { v: 2 } }));
    expect(wasNew).toBe(false);
    const stored = await store.get('msg-1');
    // The ORIGINAL persisted values survive — a redelivery must not clobber
    // the first-persisted entry (DR-038 Decision 1's idempotent receipt).
    expect(stored?.receivedAt).toBe(1000);
    expect(stored?.payload).toEqual({ v: 1 });
  });

  it('has()/get() on an unknown id', async () => {
    const store = createInMemoryInboxStore();
    expect(await store.has('nope')).toBe(false);
    expect(await store.get('nope')).toBeUndefined();
  });

  it('listUndrained returns only unprocessed entries', async () => {
    const store = createInMemoryInboxStore();
    await store.persist(inboxEntry({ id: 'a', processed: false }));
    await store.persist(inboxEntry({ id: 'b', processed: false }));
    await store.markProcessed('a');
    const undrained = await store.listUndrained();
    expect(undrained.map((e) => e.id)).toEqual(['b']);
  });

  it('markProcessed on an unknown id is a no-op', async () => {
    const store = createInMemoryInboxStore();
    await expect(store.markProcessed('nope')).resolves.toBeUndefined();
  });

  it('get() returns a copy — mutating it does not affect the store', async () => {
    const store = createInMemoryInboxStore();
    await store.persist(inboxEntry());
    const entry = await store.get('msg-1');
    // @ts-expect-error -- deliberately mutating a readonly field to prove isolation
    entry.processed = true;
    expect((await store.get('msg-1'))?.processed).toBe(false);
  });
});
