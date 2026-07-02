import type { InboxEntry, InboxStore } from './inbox-store.js';

/**
 * DR-038 Decision 5 — the on-startup drain trigger ("the completeness
 * half"). Reads every persisted-but-not-yet-processed inbox entry (a
 * message that arrived while the agent was busy / relaunching, or whose
 * tmux-wake didn't land), marks each processed so a re-run of startup
 * doesn't re-surface it, and returns the drained entries for surfacing
 * into the agent's context (`format.ts`'s `formatStartupReconcile`).
 *
 * Idempotent by construction, the same invariant Slice A's on-receipt
 * trigger (`packages/macf-channel-server/src/delivery/inbox.ts`) relies
 * on: `store.listUndrained()` only returns entries with `processed:
 * false`, and this function marks each one processed before returning —
 * dedup-by-message-id makes on-receipt and on-startup safe to run
 * overlapping (DR-038 Decision 5: "no periodic drain is needed if receipt
 * + startup cover it").
 *
 * `store` is injected (not a module-level singleton) so callers — and
 * tests — control the driver. Production wiring (`macf-plugin-cli.ts`)
 * passes `getInboxStore()`'s result; tests pass a pre-seeded store
 * directly.
 */
export async function drainInbox(store: InboxStore): Promise<InboxEntry[]> {
  const undrained = await store.listUndrained();
  for (const entry of undrained) {
    await store.markProcessed(entry.id);
  }
  return undrained;
}
