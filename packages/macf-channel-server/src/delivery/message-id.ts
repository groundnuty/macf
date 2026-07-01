/**
 * DR-038 Decision 2 — the message-id contract for the effectively-once
 * delivery layer.
 *
 * A UUIDv4, minted ONCE at outbox-enqueue, persisted with the entry BEFORE
 * the first send, and reused VERBATIM on every retry — including across a
 * sender restart (the id is stable because it's persisted, never
 * regenerated). This is the whole receiver-side dedup key (Decision 1):
 * `InboxStore.persist()` dedups by this id, which is what makes
 * `message/send` safe to retry without the operation itself being
 * idempotent.
 *
 * NOT a content-hash of the payload: two legitimately-identical messages
 * (a peer sending "ping" twice, deliberately) would wrongly dedup-collide to
 * one under a content-hash scheme. NOT a ULID: its only edge over UUIDv4 is
 * a lexicographic time-ordering hint, but DR-038 explicitly scopes
 * guaranteed ordering OUT of this delivery layer (see the DR's "Boundaries"
 * section), and both `OutboxEntry` and `InboxEntry` already carry their own
 * timestamp field for drain-ordering — so the id itself needn't encode time.
 */
import { randomUUID } from 'node:crypto';

/**
 * Mint a fresh message-id for a NEW outbox entry. Call this exactly ONCE per
 * logical message, at enqueue time — never again for the same message on
 * retry (the persisted id is what gets reused). `randomUUID()` is Node's
 * CSPRNG-backed UUIDv4 generator (no weak-PRNG concern; matches the
 * `no-weak-prng` invariant already enforced elsewhere in this package, e.g.
 * `notify-peer.ts` / `https.ts`).
 */
export function mintMessageId(): string {
  return randomUUID();
}
