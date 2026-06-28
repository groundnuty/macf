/**
 * Guaranteed forensic log (groundnuty/macf#642).
 *
 * The per-agent channel-server runs as the Claude TUI's MCP stdio child. Under
 * load Claude Code stops draining the stdio pipe, so stderr is an unreliable
 * failure channel — and the macf-core logger NO-OPS entirely when
 * `MACF_LOG_PATH` is unset. The net effect: the channel-server can die with no
 * trail at all.
 *
 * This module makes a file-based forensic log the always-on default — defense-
 * in-depth, never relying on `claude.sh` to have exported `MACF_LOG_PATH`. An
 * explicitly-set `MACF_LOG_PATH` still wins (back-compat); otherwise we resolve
 * a deterministic path under `$XDG_STATE_HOME` (or `$HOME/.local/state`, or the
 * OS tmpdir as a last-ditch) so a forensic trail exists regardless of the
 * launch environment.
 *
 * The safety net must never itself become the crash cause: `createForensicLogger`
 * degrades to a stderr-only logger if the file sink can't be created (e.g. an
 * unwritable state dir), reporting `fileActive: false` rather than throwing.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';

/**
 * Resolve the effective forensic-log path.
 *
 *   1. explicit, non-empty `MACF_LOG_PATH` → used as-is (back-compat).
 *   2. `$XDG_STATE_HOME/macf/<agentName>-channel.log`
 *   3. `$HOME/.local/state/macf/<agentName>-channel.log`
 *   4. `<os-tmpdir>/macf/<agentName>-channel.log` (last-ditch — always writable)
 *
 * Pure: no filesystem side effects (the caller's logger creates parent dirs).
 * `env` is injectable for tests.
 */
export function resolveForensicLogPath(opts: {
  readonly agentName: string;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const env = opts.env ?? process.env;
  const explicit = env['MACF_LOG_PATH'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const fileName = `${sanitizeAgentName(opts.agentName)}-channel.log`;
  return join(forensicStateDir(env), 'macf', fileName);
}

/**
 * The base state directory for the default forensic log, mirroring the XDG
 * Base Directory spec (`$XDG_STATE_HOME`, else `$HOME/.local/state`). Falls back
 * to the OS tmpdir so the path is always writable even in a degenerate
 * environment (no HOME — e.g. some CI / container contexts).
 */
function forensicStateDir(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg !== '') return xdg;
  const home = env['HOME'];
  if (home !== undefined && home !== '') return join(home, '.local', 'state');
  return tmpdir();
}

/**
 * Sanitize an agent name into a filesystem-safe single path segment — guards
 * against path traversal / separators in an unexpected `MACF_AGENT_NAME`.
 */
function sanitizeAgentName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' ? 'agent' : cleaned;
}

export interface ForensicLogger {
  /** The structured logger (file sink, or stderr-only if the file failed). */
  readonly logger: Logger;
  /** The resolved forensic-log path (even if the file sink failed to open). */
  readonly logPath: string;
  /** Whether the file sink is active (false → degraded to stderr-only). */
  readonly fileActive: boolean;
}

/**
 * Build the channel-server's forensic logger. Resolves the path, then attempts
 * a real file logger; on any failure to open the file sink (unwritable dir,
 * etc.) it logs a LOUD stderr warning and degrades to a stderr-only logger so
 * the server still starts and still produces *some* trail.
 */
export function createForensicLogger(opts: {
  readonly agentName: string;
  readonly debug: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): ForensicLogger {
  const logPath = resolveForensicLogPath({ agentName: opts.agentName, env: opts.env });
  try {
    // createLogger creates parent dirs + the file synchronously in its
    // constructor, so a throw here means the file sink is unusable.
    const logger = createLogger({ logPath, debug: opts.debug });
    return { logger, logPath, fileActive: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(
        `macf-channel-server: WARNING — could not open forensic log at ${logPath}: ${msg}. ` +
          'Falling back to stderr-only logging (no durable crash trail). See macf#642.\n',
      );
    } catch {
      /* nothing left — stderr itself is gone */
    }
    // Force the stderr sink on (debug:true) so the degraded logger still emits.
    return { logger: createLogger({ debug: true }), logPath, fileActive: false };
  }
}
