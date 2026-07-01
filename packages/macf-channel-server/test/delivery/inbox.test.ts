import { describe, it, expect } from 'vitest';
import { createInMemoryInboxStore } from '../../src/delivery/in-memory-store.js';
import { createInbox } from '../../src/delivery/inbox.js';

describe('createInbox — persist-then-ACK ordering (DR-038 Decision 3)', () => {
  it('by the time accept() resolves, the entry is already durably persisted', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store, now: () => 1234 });

    // The caller's contract: await accept() BEFORE returning HTTP 200. Model
    // that here — assert the store already has the entry the instant
    // accept()'s promise settles (i.e. the persist genuinely happened
    // before the "ACK" the caller is about to return).
    await inbox.accept('msg-1', { hello: 'world' });

    expect(await store.has('msg-1')).toBe(true);
    const entry = await store.get('msg-1');
    expect(entry).toEqual({
      id: 'msg-1',
      payload: { hello: 'world' },
      receivedAt: 1234,
      processed: false,
    });
  });

  it('accept() returns wasNew:true for a genuinely new message-id', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store });
    const result = await inbox.accept('msg-1', { a: 1 });
    expect(result.wasNew).toBe(true);
  });
});

describe('createInbox — dedup by message-id (DR-038 Decisions 1 + 3)', () => {
  it('re-accepting the same id is a no-op: wasNew:false, original entry untouched', async () => {
    const store = createInMemoryInboxStore();
    let clock = 1000;
    const inbox = createInbox({ store, now: () => clock });

    const first = await inbox.accept('msg-1', { v: 1 });
    expect(first.wasNew).toBe(true);

    clock = 9999; // a redelivery arriving "later" — must not overwrite receivedAt/payload
    const second = await inbox.accept('msg-1', { v: 2 });
    expect(second.wasNew).toBe(false);

    const stored = await store.get('msg-1');
    expect(stored?.receivedAt).toBe(1000);
    expect(stored?.payload).toEqual({ v: 1 });
  });

  it('a message is processed exactly once even if accepted twice before drain', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store });

    await inbox.accept('msg-1', { v: 1 });
    await inbox.accept('msg-1', { v: 1 }); // redelivery, still undrained

    const undrainedBefore = await inbox.undrained();
    expect(undrainedBefore.map((e) => e.id)).toEqual(['msg-1']);

    await inbox.markProcessed('msg-1');

    // A THIRD redelivery after processing must still dedup (not resurrect
    // the entry into the undrained set) — the id stays seen forever.
    const third = await inbox.accept('msg-1', { v: 1 });
    expect(third.wasNew).toBe(false);

    const undrainedAfter = await inbox.undrained();
    expect(undrainedAfter).toHaveLength(0);
  });
});

describe('createInbox — undrained() + markProcessed()', () => {
  it('undrained lists persisted-but-not-processed entries, across multiple ids', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store });

    await inbox.accept('a', { n: 1 });
    await inbox.accept('b', { n: 2 });
    await inbox.accept('c', { n: 3 });
    await inbox.markProcessed('b');

    const undrained = await inbox.undrained();
    expect(undrained.map((e) => e.id).sort()).toEqual(['a', 'c']);
  });

  it('markProcessed on an unknown id does not throw', async () => {
    const store = createInMemoryInboxStore();
    const inbox = createInbox({ store });
    await expect(inbox.markProcessed('never-accepted')).resolves.toBeUndefined();
  });
});
