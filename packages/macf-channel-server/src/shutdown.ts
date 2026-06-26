import type { Registry } from '@groundnuty/macf-core';
import type { HttpsServer, HealthState, Logger } from '@groundnuty/macf-core';

/**
 * Registers SIGTERM and SIGINT handlers that clean up the agent's
 * registry variable and stop the HTTPS server.
 *
 * Returns a cleanup function that can also be called directly.
 */
export function registerShutdownHandler(config: {
  readonly agentName: string;
  readonly registry: Registry;
  /**
   * This instance's `instance_id` (the value registered into the slot). The
   * deregister is guarded on it: the registry slot is deleted ONLY when it still
   * carries this id (DR-031, groundnuty/macf#553 root-cause). If a newer instance
   * took over the slot (groundnuty/macf#424) while we ran, its id differs → we
   * leave the slot intact rather than clobbering a live newer peer's
   * registration on our own exit.
   */
  readonly instanceId: string;
  readonly httpsServer: HttpsServer;
  readonly logger: Logger;
  /**
   * The health-state holder, if any. On shutdown its `dispose()` is called
   * (best-effort) to clear the DR-030 OTLP-reachability probe interval.
   */
  readonly healthState?: HealthState;
  /**
   * The registry-heartbeat holder, if any (DR-031, groundnuty/macf#568). On
   * shutdown its `stop()` is called (best-effort) to clear the periodic
   * `last_heartbeat` re-stamp interval — mirrors the otel-probe `dispose()`.
   */
  readonly registryHeartbeat?: { readonly stop: () => void };
}): () => Promise<boolean> {
  const { agentName, registry, instanceId, httpsServer, healthState, registryHeartbeat, logger } = config;
  let shuttingDown = false;
  let lastResult = true;

  async function cleanup(): Promise<boolean> {
    if (shuttingDown) return lastResult;
    shuttingDown = true;

    logger.info('shutdown_start', { agent: agentName });
    let ok = true;

    // Release the background OTLP-reachability probe interval (DR-030). Best-
    // effort + never flips `ok`: a probe-cleanup hiccup must not mask a real
    // deregister/stop failure.
    try {
      healthState?.dispose?.();
    } catch {
      // ignore — the interval is unref()'d, so a missed clear can't pin exit
    }

    // Clear the registry-heartbeat interval (DR-031, groundnuty/macf#568). Same
    // best-effort posture as the otel probe above — the interval is unref()'d, so
    // a missed clear can't pin exit, and a hiccup must not mask a real failure.
    try {
      registryHeartbeat?.stop?.();
    } catch {
      // ignore — unref()'d interval; a missed clear can't pin exit
    }

    // Instance-id-guarded deregister (DR-031, groundnuty/macf#553 root-cause):
    // remove our registry slot ONLY if it is still ours. `deregisterConditional`
    // is contracted never to throw — a registry hiccup surfaces as reason:'error'
    // — but we still wrap it so a future contract slip can't crash shutdown.
    try {
      const result = await registry.deregisterConditional(agentName, instanceId);
      if (result.deregistered) {
        logger.info('shutdown_deregistered', { agent: agentName, instance_id: instanceId });
      } else if (result.reason === 'not-ours') {
        // A newer instance took over our slot (groundnuty/macf#424) while we ran.
        // Leaving its registration intact is CORRECT — deleting it would re-
        // introduce the missing/stale-entry bug (#553) for a live peer. Not a
        // failure: keep `ok` true.
        logger.info('shutdown_deregister_skipped', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
          detail: 'registry slot held by a different instance — not ours to delete (DR-031, #424)',
        });
      } else if (result.reason === 'absent') {
        // Slot already gone (or unreadable) — nothing to deregister. Not a failure.
        logger.info('shutdown_deregister_skipped', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
          detail: 'registry slot already empty',
        });
      } else {
        // reason === 'error': a registry read/delete failed. Surface it loud and
        // flip `ok` so external monitors (systemd, macf-actions heartbeat) see
        // the degraded exit rather than absorbing a possibly-stale slot into a
        // clean exit (#103 R2). Shutdown still proceeds — fail-open, not crash.
        logger.error('shutdown_deregister_failed', {
          agent: agentName,
          instance_id: instanceId,
          reason: result.reason,
        });
        ok = false;
      }
    } catch (err) {
      logger.error('shutdown_deregister_failed', {
        agent: agentName,
        instance_id: instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }

    try {
      await httpsServer.stop();
      logger.info('shutdown_server_stopped', { agent: agentName });
    } catch (err) {
      logger.error('shutdown_server_stop_failed', {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }

    logger.info('shutdown_complete', { agent: agentName, ok });
    lastResult = ok;
    return ok;
  }

  // Exit 1 when any cleanup step failed so external monitors (systemd,
  // macf-actions heartbeat) surface the degraded state instead of
  // silently absorbing it into a clean exit (#103 R2).
  const handler = (): void => {
    cleanup().then(
      ok => process.exit(ok ? 0 : 1),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);

  return cleanup;
}
