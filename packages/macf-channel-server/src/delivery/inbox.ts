/**
 * DR-038 Decisions 1, 3, 5 — the receiver-side effectively-once logic:
 * persist-THEN-ack ordering (Decision 3), and the store-backed primitives
 * the inbox drain (Decision 5) needs.
 *
 * Runtime-agnostic over an injected `InboxStore` (the pluggable driver,
 * `store.ts`). The drain TRIGGER itself — hooking `accept` into the HTTP
 * `/notify` / `message/send` handler (on-receipt), and hooking `undrained`
 * + `markProcessed` into the plugin's SessionStart `startup_check`
 * (on-startup) — is a follow-on slice. This module provides the store-
 * backed primitives both triggers call into, with the dedup-by-id property
 * that makes the two triggers safe to run overlapping (Decision 5: "no
 * periodic drain is needed if receipt + startup cover it").
 */
import type { InboxStore, InboxEntry } from './store.js';

export interface InboxAcceptResult {
  /**
   * `true` when this `id` was genuinely new — now durably persisted for
   * the first time. `false` when it was a redelivery: the existing
   * persisted entry is left untouched (idempotent no-op per Decision 1's
   * "idempotent receipt").
   */
  readonly wasNew: boolean;
}

export interface InboxDeps {
  readonly store: InboxStore;
  /** Injectable epoch-ms clock (testing). Default `Date.now`. */
  readonly now?: () => number;
}

export interface Inbox {
  /**
   * Persist-THEN-ack (DR-038 Decision 3). The caller — the HTTP handler at
   * the `/notify` or `message/send` boundary — MUST `await` this and
   * return its HTTP 200 only AFTER it resolves. Returning 200 before this
   * resolves would make the ACK mean "received" instead of "durably
   * yours," reproducing the exact silent-fallback shape (success at the
   * boundary, semantic durability absent — see `silent-fallback-hazards.md`)
   * Decision 3 exists to avoid.
   *
   * A re-delivered `id` dedups here (`wasNew: false`) rather than
   * re-persisting or re-processing — the caller still returns 200 per
   * Decision 3 ("a lost-in-transit 200 is safe: the sender re-sends the
   * same id → the receiver dedups... → re-returns 200. Idempotent by
   * construction.").
   */
  readonly accept: (id: string, payload: unknown) => Promise<InboxAcceptResult>;

  /**
   * Persisted-but-not-processed entries — DR-038 Decision 5's drain input,
   * read by both the on-receipt and on-startup triggers.
   */
  readonly undrained: () => Promise<InboxEntry[]>;

  /** Mark an entry processed once the drain has handled it — won't be re-drained. */
  readonly markProcessed: (id: string) => Promise<void>;
}

export function createInbox(deps: InboxDeps): Inbox {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  return {
    async accept(id: string, payload: unknown): Promise<InboxAcceptResult> {
      const entry: InboxEntry = {
        id,
        payload,
        receivedAt: now(),
        processed: false,
      };
      const wasNew = await store.persist(entry);
      return { wasNew };
    },
    undrained: (): Promise<InboxEntry[]> => store.listUndrained(),
    markProcessed: (id: string): Promise<void> => store.markProcessed(id),
  };
}
