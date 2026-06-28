/**
 * Periodic "alive" tick (groundnuty/macf#642).
 *
 * Writes a heartbeat line to the forensic log every 60s. The point is NOT the
 * line itself but its absence: when the channel-server dies a SILENT death — an
 * OOM-kill, SIGKILL, or power loss where no crash handler or shutdown handler
 * ever runs — the forensic log simply stops. The last `alive` line then bounds
 * the death to a ≤60s window, the difference between "we know roughly when it
 * died" and "no signal at all".
 *
 * Lifecycle MIRRORS `createRegistryHeartbeat` / `createOtelReachabilityProbe`:
 * an `unref()`'d `setInterval` that can never pin the event loop open, plus an
 * idempotent `stop()`. The tick is wrapped best-effort so a logger throw (disk
 * full) can never escape and crash the process via an uncaught timer exception.
 */
import type { Logger } from '@groundnuty/macf-core';
import type { LifecycleTracker } from './lifecycle.js';

export const DEFAULT_ALIVE_TICK_INTERVAL_MS = 60_000;

export interface AliveTicker {
  /** Start the periodic tick (no-op if already started). */
  readonly start: () => void;
  /** Clear the interval (idempotent; safe before start). */
  readonly stop: () => void;
}

export function createAliveTicker(opts: {
  readonly logger: Logger;
  readonly lifecycle: Pick<LifecycleTracker, 'snapshot'>;
  /** Cadence in ms; default 60s. */
  readonly intervalMs?: number;
}): AliveTicker {
  const { logger, lifecycle } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_ALIVE_TICK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    try {
      const snap = lifecycle.snapshot();
      logger.info('alive', {
        phase: snap.phase,
        uptime_ms: snap.uptime_ms,
        pid: process.pid,
      });
    } catch {
      // Best-effort: a logger throw (e.g. disk full) must never escape a timer
      // callback and become an uncaughtException. The next tick retries.
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(tick, intervalMs);
      // Never let the alive-tick interval keep the process alive.
      timer.unref();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
