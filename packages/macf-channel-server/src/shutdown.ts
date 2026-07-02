import type { Registry } from '@groundnuty/macf-core';
import type { HttpsServer, HealthState, Logger } from '@groundnuty/macf-core';

/**
 * Registers SIGTERM, SIGINT, and MCP-stdin-close handlers that clean up
 * the agent's registry variable and stop the HTTPS server.
 *
 * The channel-server runs as the Claude TUI's MCP stdio child. A normal TUI
 * exit (`/exit`, or SIGTERM-to-the-TUI) does NOT deliver a SIGTERM/SIGINT to
 * this process — it only sees its stdin reach EOF as the parent goes away.
 * So the stdin `'end'`/`'close'` wiring (macf#627) is the graceful-deregister
 * trigger on a normal TUI exit; the signal handlers cover direct kills; the
 * DR-031 TTL heartbeat (#589) remains the backstop for hard kills (SIGKILL /
 * OOM / power loss) where no handler runs at all.
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
  /**
   * DR-038 Slice B (groundnuty/macf#704): the outbox retry-drive ticker, if
   * any. On shutdown its `stop()` is called (best-effort) to clear the
   * periodic `driveOnce()` interval — mirrors the registry-heartbeat /
   * otel-probe cleanup above.
   */
  readonly outboxTicker?: { readonly stop: () => void };
  /**
   * DR-038 Decision 5 follow-on (groundnuty/macf#744): the inbox orphan-
   * drain ticker, if any. On shutdown its `stop()` is called (best-effort)
   * to clear the periodic `driveInboxOnce()` interval — mirrors the
   * `outboxTicker` cleanup above.
   */
  readonly inboxTicker?: { readonly stop: () => void };
  /**
   * The MCP stdio transport's input stream — defaults to `process.stdin`,
   * injectable for tests. On a normal Claude-TUI exit this stream reaches EOF
   * (`'end'`) / is destroyed (`'close'`); those events are wired to the same
   * deregister handler so a graceful TUI exit deregisters instead of leaving a
   * stale slot until the DR-031 TTL backstop (macf#627). We listen on
   * `process.stdin` directly rather than the MCP transport's `onclose`: the
   * SDK's `StdioServerTransport` only attaches `'data'`/`'error'` listeners and
   * fires `onclose` solely on an explicit `transport.close()`, so it never
   * surfaces stdin EOF.
   */
  readonly stdin?: Pick<NodeJS.ReadStream, 'on'>;
}): (trigger?: string) => Promise<boolean> {
  const { agentName, registry, instanceId, httpsServer, healthState, registryHeartbeat, outboxTicker, inboxTicker, logger } = config;
  let shuttingDown = false;
  let lastResult = true;

  async function cleanup(trigger?: string): Promise<boolean> {
    if (shuttingDown) return lastResult;
    shuttingDown = true;

    logger.info('shutdown_start', {
      agent: agentName,
      ...(trigger !== undefined ? { trigger } : {}),
    });
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

    // DR-038 Slice B: clear the outbox retry-drive interval (groundnuty/macf#704).
    // Same best-effort posture as the registry-heartbeat clear above.
    try {
      outboxTicker?.stop?.();
    } catch {
      // ignore — unref()'d interval; a missed clear can't pin exit
    }

    // DR-038 Decision 5 follow-on: clear the inbox orphan-drain interval
    // (groundnuty/macf#744). Same best-effort posture as the outbox-ticker
    // clear above.
    try {
      inboxTicker?.stop?.();
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
  // silently absorbing it into a clean exit (#103 R2). The `trigger` is
  // recorded once (in `shutdown_start`) by whichever path wins the once-guard.
  const handlerFor = (trigger: string) => (): void => {
    cleanup(trigger).then(
      ok => process.exit(ok ? 0 : 1),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', handlerFor('SIGTERM'));
  process.on('SIGINT', handlerFor('SIGINT'));

  // macf#627: a normal Claude-TUI exit does NOT signal this MCP-stdio child —
  // it only sees stdin reach EOF ('end') / be destroyed ('close') as the parent
  // departs. Wire the SAME deregister handler to both events so a graceful TUI
  // exit deregisters rather than stranding the registry slot until the DR-031
  // TTL backstop (#589). `cleanup()`'s once-guard (set synchronously before any
  // await) makes a stdin-close racing a SIGTERM — or 'end' then 'close' — run
  // the deregister exactly once. The child lingers ~8s after TUI exit
  // (devops-observed), ample for the async deregister: the in-flight `cleanup()`
  // promise plus the still-bound HTTPS server keep the event loop alive, and we
  // exit only from `cleanup()`'s `.then()` — never mid-deregister.
  const stdin = config.stdin ?? process.stdin;
  const stdinCloseHandler = handlerFor('mcp-stdin-close');
  stdin.on('end', stdinCloseHandler);
  stdin.on('close', stdinCloseHandler);

  return cleanup;
}
