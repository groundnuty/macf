/**
 * DR-038 Decision 5 follow-on (groundnuty/macf#744) — the live, in-process
 * RE-FIRE logic for the receiver-side inbox's orphan class: an entry that
 * `inbox.accept()` persisted (`wasNew: true`) but whose `onNotify` call threw
 * BEFORE `inbox.markProcessed()` ran (see `https.ts`'s on-receipt wiring
 * around the `/notify` + `message/send` recv edges). The sender's own retry
 * dedups the same message-id (Decision 1) and never re-fires `onNotify` for
 * it, so absent this driver the entry sits `processed:false` for the rest of
 * the channel-server's process lifetime — recoverable only by the SEPARATE,
 * short-lived plugin SessionStart `startup_check` drain (Decision 5's
 * "on-startup" trigger), which runs against a FRESH, empty in-memory store
 * and therefore can never see THIS process's own orphans (only a future
 * process's, and only once a durable store driver — DR-008 — lands).
 *
 * `inbox-ticker.ts` drives this function periodically over the channel-
 * server's OWN lifetime, so a transient `onNotify` failure (the common case
 * — a momentarily-unavailable mcp_push / tmux-wake) self-recovers within the
 * SAME process, well before any restart or plugin-drain would ever see it.
 *
 * Kept as a standalone module — not folded into `inbox.ts` — so `inbox.ts`
 * stays the primitive-only persist/dedup/drain-read module. Mirrors the
 * `outbox.ts` / `outbox-ticker.ts` split: `outbox.ts` doesn't know about
 * ticking, `outbox-ticker.ts` doesn't know about persistence. Here,
 * `inbox.ts` doesn't know about re-firing `onNotify` or attempt-bookkeeping;
 * `inbox-ticker.ts` doesn't know about any of THIS module's drive logic.
 *
 * Four contract constraints (science-blessed, groundnuty/macf#744):
 *
 *   1. Grace-before-drain — an entry younger than `graceMs` is left alone;
 *      it may still be genuinely mid-flight in the ORIGINAL
 *      accept()→onNotify()→markProcessed() sequence, not yet an orphan.
 *   2. `markProcessed` ONLY on a successful re-fire — never mark-then-fire.
 *      Marking before a confirmed onNotify success would reintroduce the
 *      persist-then-ACK silent-drop shape, inverted (silent-fallback-
 *      hazards.md). A failed re-fire leaves the entry exactly as undrained
 *      as it was, for a later tick (or eventual give-up, #3) to see.
 *   3. Bounded push-retries — `maxAttempts` OR `ttlMs` (whichever comes
 *      first) caps how many times a persistently-failing entry gets
 *      re-fired. Attempt counts are tracked in a `Map` keyed by entry id,
 *      driver-locally — NEVER added to the frozen `InboxEntry` /
 *      `InboxStore` `@groundnuty/macf-core` schema (devops's disk-spool
 *      driver depends on that exact contract). Once given up, the entry is
 *      left `processed:false` forever — there is no delete/dead-letter
 *      primitive on `InboxStore` — this driver simply stops re-firing it.
 *      The FUTURE plugin startup-drain's surface-as-text path (Decision 5's
 *      other trigger) is the intended eventual consumer of a given-up
 *      entry, once it too can see this process's store (post-DR-008).
 *   4. Drainer ownership / no double-surface — this driver ONLY re-fires
 *      `onNotify` + marks-on-success, or gives up silently. It NEVER
 *      surfaces anything as text itself; that split keeps it composable
 *      with the plugin's (future) startup-drain without either one
 *      duplicating the other's job.
 */
import type { Logger, NotifyPayload } from '@groundnuty/macf-core';
import type { Inbox } from './inbox.js';

/**
 * Grace window before an undrained entry is considered a genuine orphan
 * (constraint 1). Deliberately >= the ticker's own tick interval — the
 * accept()→onNotify()→markProcessed() sequence on the ORIGINAL receive path
 * completes in well under a second in practice, so an interval comfortably
 * larger than one tick cycle can never mistake a mid-flight entry for an
 * orphan.
 */
export const DEFAULT_INBOX_DRAIN_GRACE_MS = 30_000;

/**
 * Attempt cap (constraint 3). Small + finite — unlike the outbox's
 * wall-clock-only retry budget (Decision 4 explicitly rejects an attempt
 * count there, because restart gaps make attempt-count meaningless across
 * process lifetimes), THIS driver's retries are only ever in-process (a
 * fresh process gets a fresh, empty attempts `Map` + — today — a fresh,
 * empty in-memory inbox), so a small attempt cap is the right complementary
 * bound to the TTL below: it stops hammering a persistently-broken
 * `onNotify` path quickly, without waiting a full day to give up.
 */
export const DEFAULT_INBOX_MAX_ATTEMPTS = 5;

/**
 * Wall-clock TTL (constraint 3), mirroring the outbox's `DEFAULT_TTL_MS`
 * (`outbox.ts`) — same 24h budget, same rationale (an 8h-class outage fits
 * comfortably; anything longer legitimately downgrades to the give-up path).
 */
export const DEFAULT_INBOX_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-tick counters, mainly for test assertions + operator diagnostics. */
export interface InboxDriveSummary {
  /** Entries whose `onNotify` was actually invoked this tick. */
  readonly attempted: number;
  /** Entries successfully re-fired + marked processed this tick. */
  readonly drained: number;
  /** `onNotify` invocations that threw this tick (entry stays undrained). */
  readonly failed: number;
  /**
   * Entries in the exhausted (attempts-cap OR TTL) state as of this tick —
   * counted whether they crossed the threshold just now or were already
   * past it. There is no store-side "remove" primitive to stop re-counting
   * them; skipping the re-fire (constraint 3/4), not the counting, is what
   * matters.
   */
  readonly gaveUp: number;
}

export interface InboxDriveDeps {
  readonly inbox: Inbox;
  /**
   * The SAME callback passed to `createHttpsServer` — re-invoked verbatim
   * for an orphaned entry. The cast from `InboxEntry.payload` (`unknown` at
   * the store layer by design — see `@groundnuty/macf-core`'s
   * `delivery/store.ts`) to `NotifyPayload` is sound here because every
   * entry this driver ever sees was itself persisted from an already-
   * `NotifyPayloadSchema`-validated payload at the ORIGINAL `inbox.accept()`
   * call site (`https.ts`'s `/notify` + `message/send` recv edges) — nothing
   * else ever calls `accept()`.
   */
  readonly onNotify: (payload: NotifyPayload) => Promise<void>;
  /**
   * Per-entry-id attempt counter, owned + persisted ACROSS calls by the
   * CALLER (`inbox-ticker.ts` in production; a test file directly) — kept
   * entirely out of the store (constraint 3: never touches the frozen
   * `InboxEntry` schema). Pass the SAME `Map` on every `driveInboxOnce` call
   * for the cap to actually accumulate across ticks.
   */
  readonly attempts: Map<string, number>;
  readonly logger?: Logger;
  /** Injectable epoch-ms clock (testing). Default `Date.now`. */
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly maxAttempts?: number;
  readonly ttlMs?: number;
}

/**
 * Drive one orphan-drain tick: for every undrained inbox entry, either skip
 * it (too young — constraint 1; or already exhausted — constraint 3), give
 * it up (TTL exceeded — constraint 3), or re-fire `onNotify` (success →
 * `markProcessed`, constraint 2; failure → bump the attempt counter,
 * constraint 3). Callable directly by tests with an explicit `now` + a
 * fresh `attempts` Map, or wrapped in `inbox-ticker.ts`'s periodic timer.
 */
export async function driveInboxOnce(deps: InboxDriveDeps): Promise<InboxDriveSummary> {
  const { inbox, onNotify, attempts, logger } = deps;
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_INBOX_DRAIN_GRACE_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_INBOX_MAX_ATTEMPTS;
  const ttlMs = deps.ttlMs ?? DEFAULT_INBOX_TTL_MS;
  const t = now();

  const undrained = await inbox.undrained();
  let attempted = 0;
  let drained = 0;
  let failed = 0;
  let gaveUp = 0;

  for (const entry of undrained) {
    const priorAttempts = attempts.get(entry.id) ?? 0;

    // Constraint 3 (already exhausted): don't re-evaluate age at all once
    // capped — permanently given-up for THIS driver; only the future
    // surface-as-text path (constraint 4) is left to deal with it.
    if (priorAttempts >= maxAttempts) {
      gaveUp++;
      continue;
    }

    const age = t - entry.receivedAt;

    // Constraint 3 (TTL): checked before the grace window — an entry old
    // enough to exceed the TTL is never "too young to be an orphan"; TTL
    // (default 24h) is always far larger than the grace window (default
    // 30s), so the two checks never actually compete in practice.
    if (age > ttlMs) {
      attempts.set(entry.id, maxAttempts); // pin capped so future ticks short-circuit above
      gaveUp++;
      logger?.warn('inbox_drain_gave_up', {
        id: entry.id,
        reason: 'ttl_exceeded',
        age_ms: age,
        ttl_ms: ttlMs,
      });
      continue;
    }

    // Constraint 1 (grace-before-drain): too young to be a genuine orphan —
    // may still be mid-flight in the ORIGINAL accept()→onNotify()→
    // markProcessed() sequence. Leave it for a later tick.
    if (age < graceMs) {
      continue;
    }

    attempted++;
    try {
      // See InboxDriveDeps.onNotify's doc comment for why this cast is sound.
      await onNotify(entry.payload as NotifyPayload);
      // Constraint 2: markProcessed ONLY after a confirmed onNotify success.
      await inbox.markProcessed(entry.id);
      attempts.delete(entry.id);
      drained++;
    } catch (err) {
      failed++;
      const nextAttempts = priorAttempts + 1;
      attempts.set(entry.id, nextAttempts);
      logger?.warn('inbox_drain_refire_failed', {
        id: entry.id,
        attempt: nextAttempts,
        max_attempts: maxAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      if (nextAttempts >= maxAttempts) {
        gaveUp++;
        logger?.warn('inbox_drain_gave_up', {
          id: entry.id,
          reason: 'max_attempts_exceeded',
          attempts: nextAttempts,
        });
      }
    }
  }

  return { attempted, drained, failed, gaveUp };
}
