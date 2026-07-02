/**
 * DR-038 Decision 6 — the pluggable store INTERFACE for the effectively-once
 * delivery layer. This is the BINDING contract: a driver (in-memory here for
 * tests/reference, a VM disk-spool driver + a K8s PVC/broker driver owned by
 * devops per DR-008) implements `OutboxStore` / `InboxStore` against whatever
 * durable substrate it has. The concrete on-disk layout (filenames, jsonl vs.
 * broker topic, etc.) is explicitly NOT part of this contract — DR-038
 * Decision 6 is emphatic that the interface, not the file shape, is binding.
 *
 * HOISTED HERE (macf#741 follow-up to #738/#742) from
 * `packages/macf-channel-server/src/delivery/store.ts` so ONE definition
 * serves all three consumers that need it: `macf-channel-server` (the
 * sender/receiver runtime, `outbox.ts` / `inbox.ts` / `in-memory-store.ts`),
 * `macf` (the plugin's on-startup inbox drain, `plugin/lib/inbox-store.ts`),
 * and devops's disk-spool driver (DR-008), which lives in a THIRD repo
 * (`macf-devops-toolkit`) that cannot depend on either monorepo package
 * directly — `@groundnuty/macf-core` (npm-published, already a dependency of
 * both `macf` and `macf-channel-server`) is the one home reachable by all
 * three. `macf-channel-server`'s local `delivery/store.ts` (the prior home
 * of this contract) is removed; every consumer there now imports these
 * types directly from `@groundnuty/macf-core`.
 *
 * Both interfaces are `Promise`-returning uniformly, even though the
 * reference in-memory driver (`in-memory-store.ts`) and a likely disk-spool
 * driver could be synchronous under the hood (comms-ledger.ts's
 * `appendFileSync` precedent). This is a DELIBERATE GUESS beyond what
 * DR-038's Decision 6 sketch pins (which shows bare `void` / `Message[]`
 * returns) — flagged for science's review: the devops K8s PVC/broker driver
 * (DR-008) is plausibly async (network I/O), and a uniform async contract
 * means the runtime-agnostic `outbox.ts` / `inbox.ts` logic in this slice
 * never needs to special-case a driver's sync-vs-async shape. If the review
 * decides all drivers are sync-capable, this can be narrowed later without
 * changing call sites (an async fn can always wrap a sync value).
 *
 * `payload` is intentionally `unknown` at the store layer — the store's job
 * is durable persistence + dedup, not payload semantics. The effectively-once
 * logic (`outbox.ts` / `inbox.ts`) is equally payload-agnostic; only the
 * eventual wiring slice (notify_peer / `/notify`) will narrow `payload` to a
 * concrete `NotifyPayload`-shaped type.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Outbox entry — the sender-side persisted record (DR-038 Decisions 1, 2, 4).
// ---------------------------------------------------------------------------

export const OutboxEntrySchema = z.object({
  /**
   * UUIDv4 message-id, minted ONCE at enqueue (DR-038 Decision 2) via
   * `mintMessageId()` (`message-id.ts`). Persisted verbatim; NEVER
   * regenerated on retry — that stability is the whole receiver-side dedup
   * key (Decision 1).
   */
  id: z.string().min(1),
  /**
   * Driver-agnostic routing target identifier (e.g. an agent/routing-label,
   * or a target URL — whatever the caller's `send` seam expects as its
   * first argument). Opaque to the store.
   */
  target: z.string().min(1),
  /** Opaque message payload. JSON-serializable is assumed but not enforced here. */
  payload: z.unknown(),
  /** Epoch-ms at first enqueue. Used for wall-clock TTL expiry (Decision 4). */
  enqueuedAt: z.number(),
  /** Epoch-ms of the next scheduled attempt (immediate on first enqueue). */
  nextAttemptAt: z.number(),
  /** Count of send attempts made so far (0 before the first attempt). */
  attemptCount: z.number().int().nonnegative(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

// ---------------------------------------------------------------------------
// Inbox entry — the receiver-side persisted record (DR-038 Decisions 1, 3).
// ---------------------------------------------------------------------------

export const InboxEntrySchema = z.object({
  /** The sender's message-id — the dedup key (DR-038 Decisions 1, 2). */
  id: z.string().min(1),
  /** Opaque message payload, as durably received. */
  payload: z.unknown(),
  /** Epoch-ms at receipt (persist time, i.e. before ACK — Decision 3). */
  receivedAt: z.number(),
  /** Has the drain processed this entry yet? (Decision 5). */
  processed: z.boolean(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

// ---------------------------------------------------------------------------
// OutboxStore — the sender-side pluggable driver interface.
// ---------------------------------------------------------------------------

export interface OutboxStore {
  /**
   * Persist a NEW entry BEFORE the first send attempt (persist-then-send,
   * DR-038 Decision 1). Callers mint the id via `mintMessageId()` and set
   * `attemptCount: 0` before calling this — `enqueue` is insert-only, not an
   * upsert; retry-state mutations go through `reschedule` (below).
   */
  enqueue(entry: OutboxEntry): Promise<void>;

  /**
   * All entries not yet acked or dead-lettered — i.e. everything still
   * awaiting delivery, regardless of whether they're currently due. This is
   * what gets re-read on sender startup (Decision 4's restart-survival) — a
   * fresh `outbox.ts` instance over the SAME store sees every entry a prior
   * process instance hadn't finished with. The retry loop (`outbox.ts`)
   * filters this list by `nextAttemptAt <= now` itself; the store does not
   * do due-filtering (mirrors DR-038 Decision 6's `pending(): Message[]`
   * sketch, which returns the undelivered set, not just the due subset).
   */
  listPending(): Promise<OutboxEntry[]>;

  /**
   * Reschedule an entry after a failed/timed-out send attempt: bump
   * `nextAttemptAt` (per the backoff schedule) and `attemptCount`. This is
   * an ADDITION beyond DR-038 Decision 6's sketch (which shows only
   * `enqueue` / `pending` / `markAcked` / `deadLetter`) — flagged for
   * review: the retry loop needs SOME way to durably persist backoff state
   * so a restart resumes the correct schedule rather than restarting
   * backoff from attempt 0 (which would race through TTL faster than
   * intended after a crash-loop). `reschedule` is the minimal mutate-in-
   * place primitive for that; it does not change the entry's identity, so
   * a driver can implement it as "load, patch two fields, re-persist"
   * against any single-entry-addressable substrate.
   */
  reschedule(id: string, nextAttemptAt: number, attemptCount: number): Promise<void>;

  /** Durable-ACK path (HTTP 200 received) → remove the entry (Decision 3). */
  markAcked(id: string): Promise<void>;

  /**
   * TTL-expiry path → remove from the live pending set (Decision 4). The
   * GitHub-issue escalation itself is explicitly NOT a store concern (DR-038
   * Decision 4: "a decision-layer action... NOT a store-driver method") —
   * this method only handles the store-side bookkeeping; the caller
   * (`outbox.ts`) separately invokes an `onDeadLetter` callback for the
   * decision-layer escalation, wired by a later slice.
   */
  deadLetter(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InboxStore — the receiver-side pluggable driver interface.
// ---------------------------------------------------------------------------

export interface InboxStore {
  /**
   * Atomically dedup-and-persist. Returns `wasNew: true` when this `id`
   * wasn't already present (a genuinely new message, now durably persisted);
   * `false` when it was already present (a redelivery — no-op, existing
   * entry left untouched). MUST be a single atomic operation — DR-038
   * Decision 6 is explicit that a separate `has()` + `persist()` would
   * reopen the check-then-act TOCTOU this primitive exists to close.
   */
  persist(entry: InboxEntry): Promise<boolean>;

  /** Existence check by id (task-specified addition beyond the DR-038 sketch). */
  has(id: string): Promise<boolean>;

  /** Fetch by id, or `undefined` if absent (task-specified addition). */
  get(id: string): Promise<InboxEntry | undefined>;

  /**
   * Persisted-but-not-yet-processed entries — drained on-receipt AND
   * on-startup (DR-038 Decision 5). Dedup-by-id makes the two triggers
   * safe to overlap.
   */
  listUndrained(): Promise<InboxEntry[]>;

  /**
   * Mark an entry processed — it won't be re-drained.
   *
   * Forward-note (DR-038 / macf#741): today's plugin drain calls this
   * BEFORE surfacing the entry to the operator/agent (mark-then-surface),
   * against an in-memory reference store where the distinction is moot. Once
   * a durable driver lands, revisit the ordering to surface-then-mark
   * instead, so a crash between the two steps can't silently drop a message
   * that was marked processed but never actually surfaced.
   */
  markProcessed(id: string): Promise<void>;
}
