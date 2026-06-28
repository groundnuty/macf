/**
 * Top-level crash handlers (groundnuty/macf#642).
 *
 * The channel-server previously had NO `uncaughtException` /
 * `unhandledRejection` handlers — only `shutdown.ts`'s SIGTERM/SIGINT/stdin
 * paths and the `main().catch` bootstrap guard. So an exception thrown outside
 * an awaited boundary, or a rejected promise nobody awaited, would terminate
 * the process via Node's default handler with (at best) an unformatted stderr
 * dump — and stderr is exactly the channel Claude Code stops draining under
 * load. The result: a silent death with no forensic trail.
 *
 * These handlers close that gap. On a fatal uncaught error they:
 *   1. log the full error + stack + last-known lifecycle phase to the forensic
 *      FILE logger AND stderr (belt-and-suspenders — either may be the only
 *      surviving channel),
 *   2. attempt a graceful registry deregister via the shutdown `cleanup`, but
 *      behind a HARD TIMEOUT so a wedged cleanup can never hang the handler,
 *   3. `process.exit(1)`.
 *
 * Transport-independent: nothing here assumes the MCP stdio mount — it works
 * identically for a future HTTP/SSE transport. Every dependency is injectable
 * for tests; production wires `process.on` / `process.exit` / `process.stderr`.
 */
import type { Logger } from '@groundnuty/macf-core';
import type { LifecycleTracker } from './lifecycle.js';

/**
 * Hard cap on the graceful-deregister attempt inside a crash handler. The
 * process is already dying; we give the deregister a bounded best-effort window
 * then exit regardless, so a wedged registry call can never strand the handler.
 */
export const DEFAULT_CRASH_DEREGISTER_TIMEOUT_MS = 5_000;

export type CrashKind = 'uncaught_exception' | 'unhandled_rejection';

export interface RegisterCrashHandlersDeps {
  readonly logger: Logger;
  readonly lifecycle: Pick<LifecycleTracker, 'snapshot'>;
  /**
   * Returns the shutdown `cleanup` (instance-id-guarded deregister + server
   * stop) if it has been wired yet, else `undefined`. A getter — not the
   * function directly — because a crash can fire during early startup BEFORE
   * `registerShutdownHandler` has run, in which case there is nothing to
   * deregister and the handler skips cleanup.
   */
  readonly getCleanup?: () => (() => Promise<unknown>) | undefined;
  /** Hard deregister timeout (ms); defaults to {@link DEFAULT_CRASH_DEREGISTER_TIMEOUT_MS}. */
  readonly deregisterTimeoutMs?: number;
  /** Injectable for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Injectable for tests; defaults to `process.stderr.write`. */
  readonly stderrWrite?: (msg: string) => void;
  /** Injectable for tests; defaults to `process.on`. */
  readonly register?: (
    event: 'uncaughtException' | 'unhandledRejection',
    handler: (err: unknown) => void,
  ) => void;
}

export interface CrashHandlers {
  /** The shared handler — exported so tests can drive it deterministically. */
  readonly handle: (kind: CrashKind, err: unknown) => Promise<void>;
}

export function registerCrashHandlers(deps: RegisterCrashHandlersDeps): CrashHandlers {
  const timeoutMs = deps.deregisterTimeoutMs ?? DEFAULT_CRASH_DEREGISTER_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number): void => { process.exit(code); });
  const stderrWrite =
    deps.stderrWrite ?? ((msg: string): void => { process.stderr.write(msg); });
  const register =
    deps.register ??
    ((event: 'uncaughtException' | 'unhandledRejection', handler: (err: unknown) => void): void => {
      process.on(event, handler);
    });

  let handling = false;

  function safeLogError(event: string, data: Record<string, unknown>): void {
    try {
      deps.logger.error(event, data);
    } catch {
      // The file sink itself failed (e.g. disk full) — stderr below is the
      // backstop. Never let the diagnostic emitter mask the crash.
    }
  }

  function safeStderr(msg: string): void {
    try {
      stderrWrite(msg);
    } catch {
      // Nothing left — stderr is gone too. Swallow so we still reach exit().
    }
  }

  async function runCleanupWithTimeout(cleanup: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race<
        { readonly kind: 'done' } | { readonly kind: 'failed'; readonly error: unknown } | { readonly kind: 'timeout' }
      >([
        cleanup().then(
          () => ({ kind: 'done' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs);
          timer.unref?.();
        }),
      ]);

      if (outcome.kind === 'timeout') {
        safeLogError('crash_cleanup_timeout', { timeout_ms: timeoutMs });
        safeStderr(
          `macf-channel-server: crash cleanup exceeded ${String(timeoutMs)}ms — ` +
            'exiting without a confirmed clean deregister.\n',
        );
      } else if (outcome.kind === 'failed') {
        safeLogError('crash_cleanup_failed', {
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function handle(kind: CrashKind, err: unknown): Promise<void> {
    if (handling) {
      // A crash WHILE handling a crash — don't loop or re-run cleanup; force exit.
      safeStderr(`macf-channel-server: re-entrant ${kind} during crash handling — forcing exit.\n`);
      exit(1);
      return;
    }
    handling = true;

    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? '') : '';
    const snap = deps.lifecycle.snapshot();

    // File-logger half (load-bearing — survives a non-draining stdout pipe).
    safeLogError(kind, {
      error,
      stack,
      lifecycle_phase: snap.phase,
      uptime_ms: snap.uptime_ms,
      pid: process.pid,
    });
    // stderr half (loud — the file sink may have failed; either may be the
    // only surviving channel).
    safeStderr(
      `macf-channel-server FATAL ${kind}: ${error}\n${stack}\n` +
        `  lifecycle=${snap.phase} uptime_ms=${String(snap.uptime_ms)} pid=${String(process.pid)}\n`,
    );

    // Best-effort graceful deregister, bounded by a hard timeout.
    const cleanup = deps.getCleanup?.();
    if (cleanup !== undefined) {
      await runCleanupWithTimeout(cleanup);
    }

    exit(1);
  }

  register('uncaughtException', (err: unknown) => {
    void handle('uncaught_exception', err);
  });
  register('unhandledRejection', (reason: unknown) => {
    void handle('unhandled_rejection', reason);
  });

  return { handle };
}
