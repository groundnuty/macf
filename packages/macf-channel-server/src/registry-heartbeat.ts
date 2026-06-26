import type { Registry, Logger } from '@groundnuty/macf-core';
import { DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS } from '@groundnuty/macf-core';

/**
 * Periodic registry heartbeat (DR-031, groundnuty/macf#568).
 *
 * The live channel-server instance re-stamps `last_heartbeat` on its OWN registry
 * slot on a coarse interval so a reader can TTL-judge an aged-out entry dead. This
 * is the backstop for the UNGRACEFUL death (kill -9 / OOM / power loss) that never
 * runs the graceful-deregister (#586) shutdown handler — together they close the
 * stale-registration class.
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
}): RegistryHeartbeat {
  const { registry, agentName, instanceId, logger } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? ((): string => new Date().toISOString());
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<void> {
    try {
      const result = await registry.heartbeatConditional(agentName, instanceId, now());
      if (result.beat) {
        logger.info('registry_heartbeat', { agent: agentName, instance_id: instanceId });
      } else if (result.reason === 'not-ours') {
        // A newer instance (groundnuty/macf#424) took over our slot — leave it
        // alone (it heartbeats its own entry). Not a failure.
        logger.info('registry_heartbeat_skipped', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
          detail: 'registry slot held by a different instance — not ours to re-stamp (DR-031, #424)',
        });
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
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
