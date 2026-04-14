import type { Registry } from './registry/types.js';
import type { HttpsServer, Logger } from './types.js';

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
}): () => Promise<void> {
  const { agentName, registry, httpsServer, logger } = config;
  let shuttingDown = false;

  async function cleanup(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutdown_start', { agent: agentName });

    try {
      await registry.remove(agentName);
      logger.info('shutdown_deregistered', { agent: agentName });
    } catch (err) {
      logger.error('shutdown_deregister_failed', {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await httpsServer.stop();
      logger.info('shutdown_server_stopped', { agent: agentName });
    } catch (err) {
      logger.error('shutdown_server_stop_failed', {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('shutdown_complete', { agent: agentName });
  }

  const handler = (): void => {
    cleanup().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);

  return cleanup;
}
