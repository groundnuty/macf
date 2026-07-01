import type { Registry, Logger } from '@groundnuty/macf-core';
import { DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS } from '@groundnuty/macf-core';

/**
 * Periodic registry heartbeat (DR-031, groundnuty/macf#568) — also the
 * split-brain guard's DETECTION half (groundnuty/macf#702 over-register).
 *
 * The live channel-server instance re-stamps `last_heartbeat` on its OWN registry
 * slot on a coarse interval so a reader can TTL-judge an aged-out entry dead. This
 * is the backstop for the UNGRACEFUL death (kill -9 / OOM / power loss) that never
 * runs the graceful-deregister (#586) shutdown handler — together they close the
 * stale-registration class.
 *
 * **Loser-yields (macf#702 split-brain guard):** the heartbeat is
 * instance-id-guarded — when a NEWER instance over-registers the slot
 * (last-writer-wins), the older/displaced instance's next beat reads a
 * different `instance_id` and `heartbeatConditional` returns `'not-ours'`. On
 * that signal this instance is no longer the slot's owner, so it must STAND
 * DOWN — stop serving — leaving exactly one live instance registered. The
 * caller wires `onDisplaced` to the graceful-shutdown cleanup. A brief
 * two-serving window (bounded by one heartbeat cadence) is acceptable; a
 * PERMANENT split-brain is not, and this closes it without depending on the
 * displaced instance having been signalled/killed externally.
 *
 * Lifecycle MIRRORS `createOtelReachabilityProbe` (health.ts): an `unref()`'d
 * `setInterval` that never pins the event loop open, plus an explicit `stop()`
 * cleared from the shutdown handler. The write is instance-id-guarded inside
 * `Registry.heartbeatConditional` (re-stamp only if the slot is still ours) and
 * fail-open — a write failure logs + the next tick retries; it NEVER throws.
 */

/**
 * Resolve the heartbeat cadence (ms) from `MACF_REGISTRY_HEARTBEAT_INTERVAL_MS`.
 *
 *  - unset / empty    → `DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS` (5 min, enabled)
 *  - `0`              → `0` (DISABLED — `start()` becomes a no-op; operator escape)
 *  - positive integer → that value (a deliberate, COARSE override)
 *  - invalid / negative → default (a typo must not silently disable the backstop)
 */
export function resolveHeartbeatIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS;
  return n; // 0 → disabled; >0 → cadence
}

export interface RegistryHeartbeat {
  /** Run a single heartbeat now (awaitable; used by tests). Never throws. */
  readonly runOnce: () => Promise<void>;
  /**
   * Fire an immediate beat then start the periodic interval. No-op when the
   * cadence is `<= 0` (disabled) or already started. The immediate beat
   * establishes a `last_heartbeat` baseline at startup so even a death inside the
   * first interval leaves a stampable entry (the registration itself carries no
   * `last_heartbeat`); cost is one extra write PER LAUNCH, not per interval, so it
   * doesn't affect the steady-state write budget the coarse cadence protects.
   */
  readonly start: () => void;
  /** Clear the periodic interval (idempotent). */
  readonly stop: () => void;
}

export function createRegistryHeartbeat(opts: {
  readonly registry: Registry;
  /** Registry KEY = the routing-label (NOT the OTEL bot-name), per macf#538. */
  readonly agentName: string;
  /** This instance's `instance_id` — the re-stamp guard. */
  readonly instanceId: string;
  readonly logger: Logger;
  /** Cadence in ms; default 5 min. `<= 0` disables (`start()` no-ops). */
  readonly intervalMs?: number;
  /** Injectable ISO-8601 clock (testing); default `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * Split-brain guard (macf#702 loser-yields). Invoked ONCE when a beat
   * observes `'not-ours'` — a NEWER instance has over-registered the slot, so
   * THIS (older/displaced) instance must stand down. The caller wires this to
   * the graceful-shutdown cleanup so the displaced instance stops serving,
   * leaving exactly one live instance. Best-effort + fire-once: any throw from
   * the callback is swallowed (a stand-down hiccup must not crash the tick),
   * and the periodic interval is cleared so we don't re-fire it every cadence.
   * Omitted → the heartbeat only logs the displacement (pre-#702 behaviour),
   * which is what tests that don't exercise the guard use.
   */
  readonly onDisplaced?: (current: { readonly instanceId: string } | null) => void;
}): RegistryHeartbeat {
  const { registry, agentName, instanceId, logger } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? ((): string => new Date().toISOString());
  let timer: ReturnType<typeof setInterval> | null = null;
  let displacedFired = false;

  async function runOnce(): Promise<void> {
    try {
      const result = await registry.heartbeatConditional(agentName, instanceId, now());
      if (result.beat) {
        logger.info('registry_heartbeat', { agent: agentName, instance_id: instanceId });
      } else if (result.reason === 'not-ours') {
        // A NEWER instance over-registered our slot (macf#702 last-writer-wins,
        // or the #424 version takeover). We are the DISPLACED instance and must
        // stand down (loser-yields split-brain guard) — leaving it alone AND
        // stopping our own serving so only one live instance remains.
        logger.warn('registry_heartbeat_displaced', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
          detail: 'a newer instance holds the slot — standing down (macf#702 loser-yields)',
        });
        if (opts.onDisplaced !== undefined && !displacedFired) {
          displacedFired = true;
          // Clear our own interval first so we don't re-fire the stand-down
          // every cadence while shutdown is in flight.
          stopTimer();
          try {
            opts.onDisplaced(null);
          } catch (err) {
            logger.warn('registry_heartbeat_displaced_callback_failed', {
              agent: agentName,
              instance_id: instanceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else if (result.reason === 'absent') {
        logger.info('registry_heartbeat_skipped', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
          detail: 'registry slot empty/unreadable — nothing to re-stamp',
        });
      } else {
        // reason === 'error': a registry read/write failed. Fail-OPEN — log + the
        // next tick retries. A heartbeat hiccup must never crash or block.
        logger.warn('registry_heartbeat_failed', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
        });
      }
    } catch (err) {
      // heartbeatConditional is contracted never to throw, but guard defensively
      // so a future contract slip (or an injected throw) can't escape the tick.
      logger.warn('registry_heartbeat_failed', {
        agent: agentName,
        instance_id: instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    runOnce,
    start(): void {
      if (intervalMs <= 0 || timer !== null) return;
      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      // Don't let the heartbeat interval pin the event loop open on shutdown.
      timer.unref();
    },
    stop: stopTimer,
  };
}
