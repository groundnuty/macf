/**
 * DR-038 Decision 5/6 — the plugin-side `InboxStore` contract the
 * on-startup drain (`inbox-drain.ts`) consumes.
 *
 * This is a STRUCTURALLY-COMPATIBLE mirror of the canonical `InboxStore` /
 * `InboxEntry` defined by Slice A at
 * `packages/macf-channel-server/src/delivery/store.ts`
 * (persist / has / get / listUndrained / markProcessed) — NOT a re-export.
 *
 * Why not import it directly: `packages/macf` (this package) does not
 * currently depend on `@groundnuty/macf-channel-server` — there is no
 * existing precedent for that edge anywhere in this package (the only
 * existing references to `@groundnuty/macf-channel-server` elsewhere in
 * `packages/macf/src` are STRING literals used to launch it via `npx`, not
 * TypeScript imports), and the channel-server's public `index.ts` doesn't
 * even export the `delivery/` module today. Slice B (the on-receipt wiring,
 * same package as Slice A) hasn't landed yet either, so there is no
 * established "injected-driver seam" this slice could plug into
 * cross-package. Introducing a new tsconfig project-reference + a new
 * package.json dependency + a lockfile regen is a bigger architectural
 * call than Slice C's scoped "plugin startup-reconcile" mandate —
 * especially since devops's disk-spool driver (DR-008) lives in a THIRD
 * repo (`macf-devops-toolkit`) that cannot depend on either monorepo
 * package directly. That makes it likely the real long-term home for this
 * contract is `@groundnuty/macf-core` (npm-published, already consumed by
 * all three: macf, macf-channel-server, and — once it exists — the devops
 * driver), not a direct macf → macf-channel-server edge. That hoist
 * decision is "code + science" territory per DR-038's build-split (the
 * channel-server delivery contract + store interface), not something this
 * single slice should decide unilaterally.
 *
 * Until that lands, this file is the swap-in seam: once a shared driver
 * type exists (macf-core hoist, or a deliberate cross-package dependency),
 * replace this file's `InboxStore` type + `createInMemoryInboxStore` with
 * the shared one — `inbox-drain.ts`'s call sites don't need to change
 * (field names/signatures kept identical to Slice A's `store.ts` at
 * authoring time).
 */

export interface InboxEntry {
  /** The sender's message-id — the dedup key (DR-038 Decisions 1, 2). */
  readonly id: string;
  /** Opaque message payload, as durably received. */
  readonly payload: unknown;
  /** Epoch-ms at receipt (persist time, i.e. before ACK — Decision 3). */
  readonly receivedAt: number;
  /** Has the drain processed this entry yet? (Decision 5). */
  readonly processed: boolean;
}

export interface InboxStore {
  /** Atomically dedup-and-persist. Returns `wasNew`. */
  persist(entry: InboxEntry): Promise<boolean>;
  /** Existence check by id. */
  has(id: string): Promise<boolean>;
  /** Fetch by id, or `undefined` if absent. */
  get(id: string): Promise<InboxEntry | undefined>;
  /**
   * Persisted-but-not-yet-processed entries — drained on-receipt AND
   * on-startup (DR-038 Decision 5). Dedup-by-id makes the two triggers
   * safe to overlap.
   */
  listUndrained(): Promise<InboxEntry[]>;
  /** Mark an entry processed — it won't be re-drained. */
  markProcessed(id: string): Promise<void>;
}

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
