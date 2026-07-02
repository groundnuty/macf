/**
 * DR-038 Decision 4 — the mechanism that DRIVES the persisted outbox's retry
 * loop over the channel-server's lifetime.
 *
 * `outbox.ts`'s `driveOnce()` is a pure, callable-on-demand function; nothing
 * in Slice A ticks it periodically. Two triggers combine to give the full
 * restart-survival + eventual-retry contract:
 *
 *   1. `notify_peer`'s own enqueue path calls `driveOnce()` once immediately
 *      after enqueueing (see `notify-peer.ts`) — the reachable-peer common
 *      case is delivered inline, same UX as pre-DR-038 fire-and-forget.
 *   2. THIS periodic, unref()'d ticker — mirrors `alive-ticker.ts` /
 *      `registry-heartbeat.ts`'s exact lifecycle shape (`start()` / `stop()`,
 *      never pins the event loop, tick body never throws past the timer) —
 *      is what drives backed-off RETRIES for an unreachable peer, and
 *      eventually TTL-expiry dead-lettering, WITHOUT requiring another
 *      `notify_peer` call to happen to trigger the next attempt. Without
 *      this, a message to a peer that's down for hours would sit in the
 *      outbox forever unless some other notify_peer call happened to touch
 *      the same store and incidentally drive it — that's not a retry
 *      schedule, that's luck.
 *
 * `server.ts` also calls `tickNow()` once at startup (DR-038 Decision 4:
 * "resumed on sender startup") BEFORE starting the recurring interval, so any
 * entry already overdue when the process comes up (a message enqueued by a
 * prior process instance, surviving via a durable store driver once DR-008
 * lands) gets its first post-restart attempt immediately rather than waiting
 * a full tick interval.
 */
import type { Logger } from '@groundnuty/macf-core';
import type { Outbox } from './outbox.js';

/** Default retry-drive cadence. Deliberately coarser than the alive-ticker's
 * 60s — this is a backstop for the backoff schedule (1s..5min), not a
 * liveness signal; a shorter interval would mostly find nothing due. */
export const DEFAULT_OUTBOX_TICK_INTERVAL_MS = 30_000;

export interface OutboxTicker {
  /** Start the periodic drive tick (no-op if already started). */
  readonly start: () => void;
  /** Clear the interval (idempotent; safe before start). */
  readonly stop: () => void;
  /** Fire one drive tick immediately, outside the interval schedule. */
  readonly tickNow: () => Promise<void>;
}

export function createOutboxTicker(opts: {
  readonly outbox: Outbox;
  readonly logger: Logger;
  /** Cadence in ms; default 30s. */
  readonly intervalMs?: number;
}): OutboxTicker {
  const { outbox, logger } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_OUTBOX_TICK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tickNow(): Promise<void> {
    try {
      const summary = await outbox.driveOnce();
      if (summary.attempted > 0 || summary.deadLettered > 0) {
        logger.info('outbox_drive_tick', {
          attempted: summary.attempted,
          acked: summary.acked,
          failed: summary.failed,
          dead_lettered: summary.deadLettered,
        });
      }
    } catch (err) {
      // Best-effort: a driveOnce failure (store I/O error, etc.) must never
      // escape a timer callback and become an uncaughtException — same
      // posture as alive-ticker.ts's tick(). The next tick retries.
      logger.warn('outbox_drive_tick_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tickNow();
      }, intervalMs);
      // Never let the retry-drive interval keep the process alive.
      timer.unref();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickNow,
  };
}
