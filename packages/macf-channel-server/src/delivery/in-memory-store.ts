/**
 * Reference `OutboxStore` / `InboxStore` drivers backed by an in-process
 * `Map`. NOT the real driver — the real drivers (VM disk-spool, K8s
 * PVC/broker) are devops-owned per DR-008. This is:
 *
 *   1. what the effectively-once logic (`outbox.ts` / `inbox.ts`) is
 *      exercised against in this slice's tests, and
 *   2. the reference shape a disk-backed driver mirrors — the exact same
 *      dedup-atomicity / persist-then-X ordering invariants apply, just
 *      against `fs` instead of a `Map`.
 *
 * Every method returns a fresh shallow copy of stored entries (never a live
 * reference into the internal `Map`) so a caller mutating a returned object
 * can't silently corrupt store state behind the mutate-only API surface
 * (`enqueue` / `reschedule` / `markAcked` / `deadLetter` / `persist` /
 * `markProcessed`) — consistent with this repo's "immutable interfaces"
 * convention (CLAUDE.md § Conventions).
 */
import type { OutboxStore, OutboxEntry, InboxStore, InboxEntry } from '@groundnuty/macf-core';

/** Create a fresh in-memory `OutboxStore`. Each call is an independent store. */
export function createInMemoryOutboxStore(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();

  return {
    async enqueue(entry: OutboxEntry): Promise<void> {
      entries.set(entry.id, { ...entry });
    },

    async listPending(): Promise<OutboxEntry[]> {
      return Array.from(entries.values()).map((e) => ({ ...e }));
    },

    async reschedule(id: string, nextAttemptAt: number, attemptCount: number): Promise<void> {
      const existing = entries.get(id);
      if (existing === undefined) return; // already acked/dead-lettered elsewhere — no-op
      entries.set(id, { ...existing, nextAttemptAt, attemptCount });
    },

    async markAcked(id: string): Promise<void> {
      entries.delete(id);
    },

    async deadLetter(id: string): Promise<void> {
      entries.delete(id);
    },
  };
}

/** Create a fresh in-memory `InboxStore`. Each call is an independent store. */
export function createInMemoryInboxStore(): InboxStore {
  const entries = new Map<string, InboxEntry>();

  return {
    async persist(entry: InboxEntry): Promise<boolean> {
      // Atomic dedup-and-persist: a single synchronous check + set against
      // the Map, with no `await` between them — no TOCTOU window is
      // reachable in-process. A disk-backed driver must preserve this same
      // atomicity (e.g. an exclusive-create file write) rather than a
      // separate exists-check + write.
      if (entries.has(entry.id)) return false;
      entries.set(entry.id, { ...entry });
      return true;
    },

    async has(id: string): Promise<boolean> {
      return entries.has(id);
    },

    async get(id: string): Promise<InboxEntry | undefined> {
      const existing = entries.get(id);
      return existing === undefined ? undefined : { ...existing };
    },

    async listUndrained(): Promise<InboxEntry[]> {
      return Array.from(entries.values())
        .filter((e) => !e.processed)
        .map((e) => ({ ...e }));
    },

    async markProcessed(id: string): Promise<void> {
      const existing = entries.get(id);
      if (existing === undefined) return; // unknown id — no-op
      entries.set(id, { ...existing, processed: true });
    },
  };
}
