import type { Registry } from '@groundnuty/macf-core';
import type { HttpsServer, HealthState, Logger } from '@groundnuty/macf-core';

/**
 * Registers SIGTERM, SIGINT, SIGHUP, and MCP-stdin-close handlers that clean
 * up the agent's registry variable and stop the HTTPS server.
 *
 * The channel-server runs as the Claude TUI's MCP stdio child. A normal TUI
 * exit (`/exit`, or SIGTERM-to-the-TUI) does NOT deliver a SIGTERM/SIGINT to
 * this process — it only sees its stdin reach EOF as the parent goes away.
 * So the stdin `'end'`/`'close'` wiring (macf#627) is the graceful-deregister
 * trigger on a normal TUI exit; the signal handlers cover direct kills; the
 * DR-031 TTL heartbeat (#589) remains the backstop for hard kills (SIGKILL /
 * OOM / power loss) where no handler runs at all.
 *
 * macf#1035: `#627`'s stdin wiring was verified live to NOT actually
 * deregister, despite passing every existing (mocked-`process.exit`) unit
 * test. Root-caused to two independent, additive defects, both fixed here:
 *
 * 1. **Once-guard stale-value race (this file).** The previous guard was a
 *    `shuttingDown` boolean + a `lastResult` snapshot updated only when the
 *    WINNING invocation finished. Node's stdin 'end' is ALWAYS immediately
 *    followed by 'close' (`autoDestroy`/`emitClose` default `true` — verified
 *    empirically via a real child-process repro, not a rare race), and both
 *    are wired to the same handler. The 'close'-triggered second call saw
 *    `shuttingDown === true` and returned `lastResult` — which was still its
 *    *initial* value (`true`), because the first (real) call was still
 *    awaiting the async registry delete. That spurious `true` needs only one
 *    microtask hop to resolve, so its `process.exit(0)` always won the race
 *    against the real cleanup's multi-await chain (a genuine network round
 *    trip) and killed the process mid-deregister — on every graceful exit,
 *    not occasionally. Existing tests never caught this because they mock
 *    `process.exit`, so the abandoned real cleanup kept running silently in
 *    the background instead of being cut off (see `cleanupPromise` below for
 *    the fix: memoize the in-flight PROMISE, not a boolean-plus-snapshot).
 * 2. **SIGHUP was unhandled (fixed by the new `process.on('SIGHUP', ...)`
 *    below).** Verified live via a tmux-topology repro matching how
 *    `claude.sh` actually launches agents (DR-013 tmux self-wrap execs into
 *    `claude`, which spawns the channel-server as a non-detached child —
 *    same session/process group as the pty): tearing down the pane after the
 *    simulated TUI process exits (tmux's default `remain-on-exit off`
 *    destroys the pty) delivers SIGHUP to the still-running channel-server
 *    child. SIGHUP's default disposition is immediate termination with NO
 *    handler run — worse than defect 1, since it skips the graceful path
 *    (and the stdin 'end' event) entirely rather than merely racing it.
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

  // macf#1035: memoize the IN-FLIGHT PROMISE, not a `shuttingDown` boolean +
  // `lastResult` snapshot. The old shape returned `lastResult`'s stale
  // default (`true`) to any trigger that arrived while the winning trigger's
  // cleanup was still in flight (see the module docblock for the verified
  // 'end'-then-'close' race). Sharing the actual promise means every caller
  // — however many triggers land in the same tick — awaits the SAME real
  // outcome; none can observe a not-yet-updated placeholder.
  let cleanupPromise: Promise<boolean> | undefined;

  async function runCleanup(trigger?: string): Promise<boolean> {
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
    return ok;
  }

  // macf#1035: the exported `cleanup` is now a thin memoizing wrapper. The
  // FIRST call assigns `cleanupPromise` synchronously (before `runCleanup`'s
  // first `await` — `??=` and the assignment inside it happen in the same
  // synchronous tick, so no second caller can ever race the assignment
  // itself) and every subsequent call — regardless of trigger — returns that
  // SAME promise. Only the winning trigger's value is ever passed to
  // `runCleanup` (matches the pre-#1035 "trigger recorded once" contract);
  // later triggers are ignored for logging purposes but correctly await the
  // real, shared outcome instead of a stale placeholder.
  function cleanup(trigger?: string): Promise<boolean> {
    cleanupPromise ??= runCleanup(trigger);
    return cleanupPromise;
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
  // macf#1035: tmux teardown after a TUI `/exit` closes the pane's pty and
  // delivers SIGHUP to the channel-server child (spawned by Claude Code
  // without setsid/detach, so it shares the pty's foreground process group)
  // — verified live via a tmux-topology repro. SIGHUP's default disposition
  // is immediate, unconditional termination; without a handler the process
  // dies before the stdin 'end' event below ever fires. This process has no
  // useful existence without its parent TUI, so treating a hangup exactly
  // like SIGTERM/SIGINT (graceful deregister, then exit) is the correct
  // response, not merely a defensive one.
  process.on('SIGHUP', handlerFor('SIGHUP'));

  // macf#627: a normal Claude-TUI exit does NOT signal this MCP-stdio child —
  // it only sees stdin reach EOF ('end') / be destroyed ('close') as the parent
  // departs. Wire the SAME deregister handler to both events so a graceful TUI
  // exit deregisters rather than stranding the registry slot until the DR-031
  // TTL backstop (#589). `cleanup()`'s once-guard (memoized promise, set
  // synchronously before any await — macf#1035) makes a stdin-close racing a
  // SIGTERM — or 'end' then 'close' — run the deregister exactly once, and
  // every racing trigger awaits the SAME real completion rather than a stale
  // placeholder. The child lingers ~8s after TUI exit
  // (devops-observed), ample for the async deregister: the in-flight `cleanup()`
  // promise plus the still-bound HTTPS server keep the event loop alive, and we
  // exit only from `cleanup()`'s `.then()` — never mid-deregister.
  const stdin = config.stdin ?? process.stdin;
  const stdinCloseHandler = handlerFor('mcp-stdin-close');
  stdin.on('end', stdinCloseHandler);
  stdin.on('close', stdinCloseHandler);

  return cleanup;
}
