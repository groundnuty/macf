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
  readonly serverStartedAtMs: number;
  readonly fs?: RegistrationFs;
}

const REGISTERED = 'Channel notifications registered';
const SKIPPED = 'Channel notifications skipped';
const MTIME_SLACK_MS = 5000;

/** Claude Code names its per-project cache dir by replacing `/` and `.` with `-`. */
export function encodeWorkspace(path: string): string {
  return path.replace(/[/.]/g, '-');
}

function unknown(reason: string): ChannelRegistration {
  return { state: 'unknown', reason };
}

/**
 * Read Claude Code's own MCP log for this session and report whether the
 * channel was registered. Looks only in dirs derived from this workspace's
 * identity, never in other projects' dirs. Never throws.
 */
export function readChannelRegistration(opts: ReadChannelRegistrationOpts): ChannelRegistration {
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
    let newest: { file: string; mtimeMs: number } | undefined;
    let sawDir = false;
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
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) continue;
          if (newest === undefined || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
        } catch {
          // unreadable entry; skip
        }
      }
    }
    if (!sawDir) return unknown('no mcp-logs-macf-agent dir for this workspace');
    if (newest === undefined) return unknown('mcp log dir has no files');
    if (newest.mtimeMs < opts.serverStartedAtMs - MTIME_SLACK_MS) {
      return unknown('newest mcp log is older than this server start');
    }
    let text: string;
    try {
      text = fs.readFileSync(newest.file, 'utf-8');
    } catch {
      return unknown('mcp log unreadable');
    }
    const reg = text.lastIndexOf(REGISTERED);
    const skip = text.lastIndexOf(SKIPPED);
    if (reg === -1 && skip === -1) return unknown('mcp log has no channel registration marker');
    return reg > skip
      ? { state: 'registered', logFile: newest.file }
      : { state: 'skipped', logFile: newest.file };
  } catch (err) {
    return unknown(`registration read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
