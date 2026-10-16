/**
 * Programmatic prompt injection into a running Claude Code TUI via the
 * canonical `tmux-send-to-claude.sh` helper — "sidecar wake" sibling to
 * the MCP notification push.
 *
 * Background (macf#185):
 *
 *   Phase 7's mTLS /notify delivery works end-to-end: routing Action
 *   mTLS-POSTs to a peer agent's channel server, server receives the
 *   payload, pushes it through the MCP channel. But Claude Code's
 *   running TUI never sees the notification as a new prompt — the MCP
 *   push deposits data into the channel-server-observable state,
 *   doesn't interrupt the running session with a fresh prompt.
 *
 *   Users expected /notify to "wake the agent to work on the new
 *   thing." What actually happened: the /notify was queue-deposit, not
 *   wake. Agents only processed new work when the human operator
 *   manually ran `tmux-send-to-claude.sh` (or killed + relaunched the
 *   TUI so the SessionStart auto-pickup hook fired).
 *
 * Fix shape (this module):
 *
 *   Extend the `onNotify` callback chain with a second step — after
 *   the MCP push completes, shell out to `tmux-send-to-claude.sh` with
 *   a human-readable prompt synthesized from the NotifyPayload. The
 *   running Claude TUI receives the prompt text in its input buffer
 *   just as if the operator had typed it, and processes it as the
 *   next turn.
 *
 * Target discovery:
 *
 *   1. Explicit via `MACF_TMUX_SESSION` / `MACF_TMUX_WINDOW` env
 *      (sourced from `macf-agent.json`'s `tmux_session` /
 *      `tmux_window` fields, emitted by `claude.sh`). Operator-
 *      declared target.
 *   2. Auto-detect from `TMUX` env + `tmux display-message -p`. Works
 *      when the server was launched from within a tmux pane (the
 *      canonical MACF launch pattern: `tmux new -d -s cv-architect
 *      './claude.sh'`). Zero-config for this case.
 *   3. Neither available → no-op, return `false`. /notify's 200
 *      response reflects "accepted into MCP", not "delivered to
 *      human TUI" — operators without tmux get the MCP notification
 *      in the channel-server state + the old manual-check UX.
 *
 * Fail-silent policy:
 *
 *   Every error path (missing helper script, tmux not installed, pane
 *   gone, exit-code-nonzero) logs at debug level + returns `false`.
 *   Never throws. /notify's contract with the caller is unaffected —
 *   we return 200 regardless of wake-path outcome.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { Logger } from '@groundnuty/macf-core';
import { getTracer, SpanNames, Attr } from './tracing.js';

export interface WakeOptions {
  /** Workspace root for locating `.claude/scripts/tmux-send-to-claude.sh`. */
  readonly workspaceDir: string;
  /** Explicit tmux session name (e.g. "cv-project"). Optional. */
  readonly session?: string;
  /** Explicit tmux window index/name (e.g. "0", "cv-architect"). Optional. */
  readonly window?: string;
  /** Debug logger. Info/warn events on success paths; debug on skips. */
  readonly logger: Logger;
}

/**
 * Build the `tmux-send-to-claude.sh` target argument from explicit env
 * + auto-detection fallback. Returns the target string to pass as the
 * script's first arg, or `null` if no target resolvable.
 *
 * Priority order:
 *
 *   1. Explicit `session` + optional `window`
 *       → `"session:window"` / `"session"`
 *   2. `$TMUX_PANE` set (e.g. `%87`)
 *       → that pane ID — deterministic per-pane identity, inherited
 *         by every child of the pane. This is the ground truth when
 *         the server was launched inside a tmux pane: no matter how
 *         many sessions/windows exist or whether `display-message`
 *         would resolve ambiguously, `$TMUX_PANE` points at exactly
 *         the pane our process belongs to. See macf#189 sub-item 3 —
 *         the bilateral e2e demo exposed the ambiguity of
 *         `display-message` on a shared tmux socket with multiple
 *         windows; wake landed on the wrong pane.
 *   3. `$TMUX` set (generic tmux presence)
 *       → fall back to `tmux display-message -p '...'` for the
 *         common case where `$TMUX_PANE` isn't exported (older tmux
 *         or non-interactive invocations).
 *   4. None of the above
 *       → null (wake path no-ops; log "no_target" skip).
 *
 * Exported for unit tests.
 */
export function resolveTmuxTarget(opts: {
  readonly session?: string;
  readonly window?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | null {
  const env = opts.env ?? process.env;
  if (opts.session !== undefined && opts.session !== '') {
    const target = opts.window !== undefined && opts.window !== ''
      ? `${opts.session}:${opts.window}`
      : opts.session;
    return target;
  }

  // TMUX_PANE is the most deterministic auto-detect: tmux sets it
  // per-pane (e.g. `%87`) and every child process of the pane
  // inherits it. A pane ID is a valid `tmux -t` target, so we can
  // pass it straight through to the helper.
  const pane = env['TMUX_PANE'];
  if (pane !== undefined && pane !== '') return pane;

  // Fall back to display-message when $TMUX is set but $TMUX_PANE
  // isn't (older tmux versions or unusual launch paths).
  if (!env['TMUX']) return null;
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '#{session_name}:#{window_index}'], {
      encoding: 'utf-8',
      // Tight timeout — tmux display-message is instant locally.
      timeout: 2000,
    });
    const target = out.trim();
    // display-message returns ":0" or similar when no session context
    // is available; guard against those degenerate cases.
    if (target === '' || target.startsWith(':')) return null;
    return target;
  } catch {
    return null;
  }
}

const WAKE_TIMEOUT_MS = 10_000;

interface HelperResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Run the helper without blocking the event loop (macf#1491). Resolves
 * (never rejects) with a spawnSync-shaped result so the logging below is
 * unchanged. A timeout kills the child and reports an ETIMEDOUT error.
 */
/** `spawn`, or the Error it throws synchronously (e.g. for a NUL in an argument). */
function trySpawn(scriptPath: string, args: readonly string[]) {
  try {
    return spawn(scriptPath, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function runHelper(scriptPath: string, args: readonly string[]): Promise<HelperResult> {
  return new Promise((resolve) => {
    const child = trySpawn(scriptPath, args);
    if (child instanceof Error) {
      // Resolve as a failed run so the wake never rejects.
      resolve({ error: child, status: null, stderr: '' });
      return;
    }
    let stderr = '';
    let settled = false;
    const done = (r: HelperResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stderr.destroy();
      done({ error: new Error(`spawn ${scriptPath} ETIMEDOUT`), status: null, stderr });
    }, WAKE_TIMEOUT_MS);
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', (error) => { done({ error, status: null, stderr }); });
    child.on('close', (status) => { done({ status, stderr }); });
  });
}

// Per-target tail of pending wakes: two notifications for one pane never
// type into it at once, and run in arrival order.
const wakeQueues = new Map<string, Promise<unknown>>();

function enqueueWake<T>(target: string, task: () => Promise<T>): Promise<T> {
  const prev = wakeQueues.get(target) ?? Promise.resolve();
  const run = prev.then(task);
  const tail = run.then(() => undefined, () => undefined);
  wakeQueues.set(target, tail);
  void tail.then(() => { if (wakeQueues.get(target) === tail) wakeQueues.delete(target); });
  return run;
}

/**
 * Wake a running Claude Code TUI by injecting a prompt via the
 * canonical tmux helper. Resolves `true` when the helper ran
 * successfully, `false` on any no-op or error path. Never rejects.
 *
 * Async (macf#1491): the helper sleeps and verifies for 3-10 s, and a
 * blocking spawn froze /notify, /health and the MCP stdio connection for
 * that long. Callers that do not need the outcome should not await it.
 *
 * `prompt` is text-only — becomes the TUI's next input. Newlines,
 * quotes, shell-metacharacters are all safe because we pass the
 * prompt as a separate argv to the helper (no shell interpolation).
 */
export function wakeViaTmux(prompt: string, opts: WakeOptions): Promise<boolean> {
  const tracer = getTracer();
  // Span attached to whatever parent is active at call time (typically
  // macf.server.notify_received); it ends when the wake finishes.
  return tracer.startActiveSpan(
    SpanNames.TmuxWakeDeliver,
    { kind: SpanKind.INTERNAL },
    async (span: Span): Promise<boolean> => {
      try {
        const scriptPath = join(opts.workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
        if (!existsSync(scriptPath)) {
          opts.logger.info('tmux_wake_skipped', {
            reason: 'helper_missing',
            path: scriptPath,
          });
          span.setAttribute(Attr.WakeOutcome, 'helper_missing');
          return false;
        }

        const target = resolveTmuxTarget({ session: opts.session, window: opts.window });
        if (target === null) {
          opts.logger.info('tmux_wake_skipped', {
            reason: 'no_target',
            detail: 'MACF_TMUX_SESSION unset and $TMUX auto-detect unavailable',
          });
          span.setAttribute(Attr.WakeOutcome, 'no_target');
          return false;
        }
        span.setAttribute(Attr.TmuxTarget, target);

        const result = await enqueueWake(target, () => runHelper(scriptPath, [target, prompt]));

        if (result.error !== undefined) {
          opts.logger.warn('tmux_wake_failed', {
            reason: 'spawn_error',
            error: result.error.message,
          });
          span.setAttribute(Attr.WakeOutcome, 'spawn_error');
          span.recordException(result.error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
          return false;
        }
        if (result.status !== 0) {
          opts.logger.warn('tmux_wake_failed', {
            reason: 'nonzero_exit',
            status: result.status,
            stderr: result.stderr.slice(0, 200),
          });
          span.setAttribute(Attr.WakeOutcome, 'nonzero_exit');
          span.setStatus({ code: SpanStatusCode.ERROR, message: `exit ${String(result.status)}` });
          return false;
        }

        opts.logger.info('tmux_wake_delivered', {
          target,
          prompt_length: prompt.length,
        });
        span.setAttribute(Attr.WakeOutcome, 'delivered');
        span.setStatus({ code: SpanStatusCode.OK });
        return true;
      } catch (error) {
        // Never reject: the server calls this with `void`, so a rejection would be unhandled.
        const err = error instanceof Error ? error : new Error(String(error));
        opts.logger.warn('tmux_wake_failed', { reason: 'spawn_error', error: err.message });
        span.setAttribute(Attr.WakeOutcome, 'spawn_error');
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        return false;
      } finally {
        span.end();
      }
    },
  );
}
