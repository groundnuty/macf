/**
 * DR-038 Decision 6 — the pluggable store-DRIVER seam. `outbox.ts` / `inbox.ts`
 * (the runtime-agnostic effectively-once logic) depend only on the
 * `OutboxStore` / `InboxStore` interfaces (hoisted to `@groundnuty/macf-core`,
 * `delivery/store.ts` — macf#741); THIS module is the one place `server.ts`
 * decides which concrete driver backs those interfaces.
 *
 * Today there is exactly one driver: the in-memory reference (`in-memory-store.ts`).
 * That is a PLACEHOLDER, not the DR-038 durability guarantee — see the loud
 * warning in `createDefaultDeliveryStores` below. The devops-owned DR-008 VM
 * disk-spool driver (and, later, a K8s PVC/broker driver) is expected to ship
 * a sibling factory with the exact same `DeliveryStores` return shape; wiring
 * it in is then a ONE-LINE swap of which factory `server.ts` calls — no change
 * to `outbox.ts`, `inbox.ts`, the notify-peer sender wiring, or the `/notify` /
 * `message/send` receiver wiring, all of which only ever see the `OutboxStore`
 * / `InboxStore` interface.
 */
import type { Logger, OutboxStore, InboxStore } from '@groundnuty/macf-core';
import { createInMemoryOutboxStore, createInMemoryInboxStore } from './in-memory-store.js';

export interface DeliveryStores {
  readonly outboxStore: OutboxStore;
  readonly inboxStore: InboxStore;
}

/** A driver factory — the swap point for a future DR-008 disk/K8s driver. */
export type DeliveryStoreFactory = (logger?: Logger) => DeliveryStores;

/**
 * The reference in-memory driver — `server.ts`'s DEFAULT until a durable
 * driver lands.
 *
 * ⚠️ LOUD, DELIBERATE FLAG: this is NOT durable across a process crash. Every
 * queued outbox entry and every undrained inbox entry lives only in this
 * process's heap — a crash (the exact failure mode DR-038 exists to fix, per
 * its "Live-validated, not hypothetical" motivation: the devops 8h outage +
 * code-agent's #702 channel-server death) loses the lot, silently, with no
 * on-disk trace. The WIRING in this slice (persist-then-send, persist-then-
 * ACK, retry/backoff/TTL, dead-letter) is fully correct and exercised end-to-
 * end by this slice's tests — what's missing is durability of the persist
 * step itself, which requires swapping this factory for the devops-owned
 * DR-008 disk-spool driver (or a K8s PVC/broker driver) once it lands. Until
 * then, effectively-once degrades to "effectively-once for the lifetime of
 * one process" — still strictly better than today's fire-and-forget (no
 * retry at all across even a single-attempt transient failure), but NOT the
 * full restart-survival guarantee DR-038 Decision 4 describes.
 */
export function createDefaultDeliveryStores(logger?: Logger): DeliveryStores {
  logger?.warn('delivery_store_in_memory_placeholder', {
    detail:
      'DR-038 effectively-once delivery is wired against the IN-MEMORY reference ' +
      'store driver — a process crash loses every queued outbox entry and every ' +
      'undrained inbox entry (the exact failure DR-038 exists to fix). The retry/' +
      'dedup LOGIC is correct; durability across a crash requires the DR-008 ' +
      'disk-spool driver (devops-owned), not yet wired in. See delivery/driver.ts.',
  });
  return {
    outboxStore: createInMemoryOutboxStore(),
    inboxStore: createInMemoryInboxStore(),
  };
}
