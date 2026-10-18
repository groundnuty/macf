import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@groundnuty/macf-core';

export type ChannelRegistration =
  | { readonly state: 'registered'; readonly logFile: string }
  | { readonly state: 'skipped'; readonly logFile: string }
  | { readonly state: 'unknown'; readonly reason: string };

export interface RegistrationFs {
  readdirSync(path: string): string[];
  statSync(path: string): { mtimeMs: number; isFile(): boolean };
  readFileSync(path: string, enc: 'utf-8'): string;
  realpathSync(path: string): string;
}

export interface ReadChannelRegistrationOpts {
  readonly candidateDirs: readonly string[];
  readonly homeDir: string;
  /**
   * When this server PROCESS started. Evidence must be strictly newer: Claude Code
   * cannot register a connection before the process exists, and a previous
   * process's line in the same session (a reconnect) is always older.
   */
  readonly serverStartedAtMs: number;
  /** This server's Claude Code session id (CLAUDE_CODE_SESSION_ID). */
  readonly sessionId: string | undefined;
  readonly fs?: RegistrationFs;
}

const REGISTERED = 'Channel notifications registered';
const SKIPPED = 'Channel notifications skipped';

/** Claude Code names its per-project cache dir by replacing `/` and `.` with `-`. */
export function encodeWorkspace(path: string): string {
  return path.replace(/[/.]/g, '-');
}

function unknown(reason: string): ChannelRegistration {
  return { state: 'unknown', reason };
}

/**
 * Read Claude Code's own MCP log lines and report whether this server's own
 * connection registered the channel. The session id (CLAUDE_CODE_SESSION_ID)
 * identifies this server's Claude Code process, so another session in the same
 * workspace cannot answer for it. The line timestamp excludes an earlier launch
 * of a resumed session, which keeps its session id. Looks only in dirs derived
 * from this workspace's identity. Never throws.
 */
export function readChannelRegistration(opts: ReadChannelRegistrationOpts): ChannelRegistration {
  if (opts.sessionId === undefined || opts.sessionId === '') return unknown('no CLAUDE_CODE_SESSION_ID');
  const fs: RegistrationFs = opts.fs ?? nodeFs;
  try {
    const paths = new Set<string>();
    for (const dir of opts.candidateDirs) {
      paths.add(dir);
      try {
        paths.add(fs.realpathSync(dir));
      } catch {
        // path may not resolve; the plain form is still a candidate
      }
    }
    const since = opts.serverStartedAtMs;
    let sawDir = false;
    let best: { ts: number; state: 'registered' | 'skipped'; file: string } | undefined;
    for (const p of paths) {
      const logDir = join(opts.homeDir, '.cache', 'claude-cli-nodejs', encodeWorkspace(p), 'mcp-logs-macf-agent');
      let names: string[];
      try {
        names = fs.readdirSync(logDir);
      } catch {
        continue;
      }
      sawDir = true;
      for (const name of names) {
        const file = join(logDir, name);
        let text: string;
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || st.mtimeMs < since) continue;
          text = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const hit = latestCountingLine(text, opts.sessionId, since);
        if (hit !== undefined && (best === undefined || hit.ts >= best.ts)) best = { ...hit, file };
      }
    }
    if (!sawDir) return unknown('no mcp-logs-macf-agent dir for this workspace');
    if (best === undefined) return unknown('no registration line for this session since server start');
    return { state: best.state, logFile: best.file };
  } catch (err) {
    return unknown(`registration read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function latestCountingLine(
  text: string,
  sessionId: string,
  since: number,
): { ts: number; state: 'registered' | 'skipped' } | undefined {
  let best: { ts: number; state: 'registered' | 'skipped' } | undefined;
  for (const raw of text.split('\n')) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof line !== 'object' || line === null) continue;
    const l = line as { sessionId?: unknown; timestamp?: unknown; debug?: unknown };
    if (l.sessionId !== sessionId || typeof l.debug !== 'string' || typeof l.timestamp !== 'string') continue;
    const ts = Date.parse(l.timestamp);
    if (Number.isNaN(ts) || ts < since) continue;
    const state = l.debug.startsWith(REGISTERED) ? 'registered' : l.debug.startsWith(SKIPPED) ? 'skipped' : undefined;
    if (state !== undefined && (best === undefined || ts >= best.ts)) best = { ts, state };
  }
  return best;
}

export interface WakeRouterOpts {
  readonly read: () => ChannelRegistration;
  readonly logger: Logger;
}

/**
 * Deliver the wake copy by exactly one path. Registered channel: send no tmux
 * copy. Anything else: type it. `registered` is latched; other states are
 * re-read on the next call.
 */
export function createWakeRouter(opts: WakeRouterOpts): (wake: () => void) => void {
  let latched: ChannelRegistration | undefined;
  return (wake) => {
    const reg = latched ?? opts.read();
    if (reg.state === 'registered') {
      latched = reg;
      opts.logger.info('delivery_path', { path: 'channel', evidence: 'registered', log_file: reg.logFile });
      return;
    }
    opts.logger.info('delivery_path', {
      path: 'tmux_wake',
      evidence: reg.state,
      ...(reg.state === 'unknown' ? { reason: reg.reason } : {}),
    });
    wake();
  };
}
