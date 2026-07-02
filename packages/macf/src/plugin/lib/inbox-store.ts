/**
 * DR-038 Decision 5/6 — the plugin-side `InboxStore` contract the
 * on-startup drain (`inbox-drain.ts`) consumes.
 *
 * `InboxStore` / `InboxEntry` are now imported directly from
 * `@groundnuty/macf-core` (macf#741/#745 hoisted the ONE shared definition
 * there from `packages/macf-channel-server/src/delivery/store.ts`, since
 * this package, `macf-channel-server`, AND devops's future disk-spool
 * driver in a THIRD repo — `macf-devops-toolkit`, which cannot depend on
 * either monorepo package directly — all need it). This file previously
 * carried a structurally-compatible LOCAL MIRROR of those types (authored
 * before the hoist landed, when `macf-core` didn't yet export them); that
 * mirror is retired now that the shared definition exists. Only the
 * IMPLEMENTATIONS live here — `createInMemoryInboxStore` (the reference
 * driver) + `getInboxStore` (the decision/driver-split factory) — which
 * now implement the `@groundnuty/macf-core` `InboxStore` contract instead
 * of the local one. `inbox-drain.ts`'s call sites are unaffected (field
 * names/signatures are identical; this file still re-exports the types
 * under the same names).
 */
import type { InboxStore, InboxEntry } from '@groundnuty/macf-core';

export type { InboxStore, InboxEntry };

/**
 * Reference in-memory `InboxStore` — mirrors
 * `packages/macf-channel-server/src/delivery/in-memory-store.ts`'s
 * `createInMemoryInboxStore` field-for-field.
 *
 * NOT durable across process boundaries: `macf-plugin-cli.ts` (the
 * `/macf-issues` skill's backing process) is a fresh short-lived process
 * per invocation, so a store created here is ALWAYS empty in practice —
 * there is no real cross-process persistence until devops's disk-backed
 * driver (DR-008) lands. Kept as (a) the reference shape exercised by this
 * slice's tests, and (b) the structural placeholder `getInboxStore()`
 * returns today, so the on-startup drain wiring exists and is exercised
 * end-to-end even though it can't yet observe messages written by a
 * different process (the running channel-server).
 */
export function createInMemoryInboxStore(): InboxStore {
  const entries = new Map<string, InboxEntry>();

  return {
    async persist(entry: InboxEntry): Promise<boolean> {
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

/**
 * Decision/driver-split factory (mirrors `registry-config.ts`'s
 * `getRegistryConfig()` + `createRegistryFromConfig()` pattern used
 * elsewhere in this package). Currently ALWAYS returns a fresh in-memory
 * store — a DELIBERATE PLACEHOLDER pending devops's disk-backed driver
 * (DR-008). Swap point: once that driver exists, this function should
 * branch on an env var (analogous to `MACF_REGISTRY_TYPE` /
 * `MACF_REGISTRY_PATH`) and return a disk-backed instance instead; no call
 * site outside this function needs to change.
 *
 * Flagged prominently: without the disk driver, `/macf-issues` running in
 * a fresh process every invocation means this always starts empty, so the
 * on-startup drain wiring in this slice is exercised by its unit tests
 * (which inject a pre-seeded store directly) but will not observe real
 * cross-process inbox traffic until the durable driver lands.
 */
export function getInboxStore(_env: NodeJS.ProcessEnv = process.env): InboxStore {
  return createInMemoryInboxStore();
}
