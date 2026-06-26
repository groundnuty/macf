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
  readonly httpsServer: HttpsServer;
  readonly logger: Logger;
  /**
   * The health-state holder, if any. On shutdown its `dispose()` is called
   * (best-effort) to clear the DR-030 OTLP-reachability probe interval.
   */
  readonly healthState?: HealthState;
}): () => Promise<boolean> {
  const { agentName, registry, httpsServer, healthState, logger } = config;
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

    try {
      await registry.remove(agentName);
      logger.info('shutdown_deregistered', { agent: agentName });
    } catch (err) {
      logger.error('shutdown_deregister_failed', {
        agent: agentName,
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
