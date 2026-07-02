/**
 * DR-038 Decision 5 follow-on (groundnuty/macf#744) — the mechanism that
 * DRIVES `inbox-drain-driver.ts`'s `driveInboxOnce()` periodically over the
 * channel-server's lifetime, so the receiver's own in-process inbox orphans
 * (an entry whose original `onNotify` threw between `inbox.accept()` and
 * `inbox.markProcessed()`) get re-fired without waiting for a restart or the
 * plugin's separate, short-lived startup-drain (which can't see this
 * process's own in-memory orphans).
 *
 * Exact same lifecycle shape as `outbox-ticker.ts` (`start()` / `stop()` /
 * `tickNow()`, unref()'d interval, tick body never throws past the timer) —
 * intentionally, so the two DR-038 tickers read as one family in
 * `server.ts` + `shutdown.ts`.
 *
 * `server.ts` calls `tickNow()` once at startup (mirroring the outbox
 * ticker's own startup tick) BEFORE starting the recurring interval, so any
 * orphan already undrained when this process comes up gets an immediate
 * first re-fire attempt rather than waiting a full tick interval.
 */
import type { Logger, NotifyPayload } from '@groundnuty/macf-core';
import type { Inbox } from './inbox.js';
import {
  driveInboxOnce,
  DEFAULT_INBOX_DRAIN_GRACE_MS,
  DEFAULT_INBOX_MAX_ATTEMPTS,
  DEFAULT_INBOX_TTL_MS,
} from './inbox-drain-driver.js';

/** Default retry-drive cadence. Same cadence as the outbox ticker. */
export const DEFAULT_INBOX_TICK_INTERVAL_MS = 30_000;

export interface InboxTicker {
  /** Start the periodic drive tick (no-op if already started). */
  readonly start: () => void;
  /** Clear the interval (idempotent; safe before start). */
  readonly stop: () => void;
  /** Fire one drive tick immediately, outside the interval schedule. */
  readonly tickNow: () => Promise<void>;
}

export function createInboxTicker(opts: {
  readonly inbox: Inbox;
  /** The SAME `onNotify` callback passed to `createHttpsServer`. */
  readonly onNotify: (payload: NotifyPayload) => Promise<void>;
  readonly logger: Logger;
  /** Cadence in ms; default 30s. */
  readonly intervalMs?: number;
  readonly graceMs?: number;
  readonly maxAttempts?: number;
  readonly ttlMs?: number;
  /** Injectable epoch-ms clock (testing). Default `Date.now`. */
  readonly now?: () => number;
}): InboxTicker {
  const { inbox, onNotify, logger } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INBOX_TICK_INTERVAL_MS;
  const graceMs = opts.graceMs ?? DEFAULT_INBOX_DRAIN_GRACE_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_INBOX_MAX_ATTEMPTS;
  const ttlMs = opts.ttlMs ?? DEFAULT_INBOX_TTL_MS;
  const now = opts.now ?? Date.now;
  // Process-lifetime attempt counter (DR-038 Decision 5 follow-on constraint
  // 3) — never persisted, never touches the InboxStore/InboxEntry schema,
  // reset to empty on every fresh process. This IS the "driver-locally"
  // bookkeeping the design calls for: the ticker owns the one long-lived Map
  // instance and hands it to `driveInboxOnce` unchanged on every tick so
  // attempt counts actually accumulate across ticks.
  const attempts = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tickNow(): Promise<void> {
    try {
      const summary = await driveInboxOnce({
        inbox,
        onNotify,
        attempts,
        logger,
        now,
        graceMs,
        maxAttempts,
        ttlMs,
      });
      if (summary.attempted > 0 || summary.gaveUp > 0) {
        logger.info('inbox_drain_tick', {
          attempted: summary.attempted,
          drained: summary.drained,
          failed: summary.failed,
          gave_up: summary.gaveUp,
        });
      }
    } catch (err) {
      // Best-effort: a driveInboxOnce failure (store I/O error, etc.) must
      // never escape a timer callback and become an uncaughtException — same
      // posture as outbox-ticker.ts's tick(). The next tick retries.
      logger.warn('inbox_drain_tick_failed', {
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
      // Never let the drain-drive interval keep the process alive.
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
