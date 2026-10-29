/**
 * Is this fleet's watchdog cron installed on this host? One verdict line for
 * `macf fleet deploy` and `macf fleet doctor` (#1525).
 *
 * Ownership is decided by `fleet-install-cron.ts`'s own `isOwnedLine` and
 * `watchdogMarker`, so install and check cannot disagree about whose line it is.
 */
import { execFileSync } from 'node:child_process';
import {
  isOwnedLine,
  watchdogMarker,
  cronScriptPath,
  createRealDeps,
} from '../commands/fleet-install-cron.js';

export type WatchdogStatus =
  | { readonly kind: 'installed'; readonly schedule: string; readonly mode: 'report-only' | 'acting' | 'mode unknown' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string };

export type CrontabRead =
  | { readonly kind: 'ok'; readonly content: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

export interface WatchdogStatusDeps {
  /** `crontab -l`: an empty crontab is `ok` with '', a failure to ask is `unreadable`. */
  readonly readCrontab: () => CrontabRead;
  /** The per-fleet cron script's content, or null when it cannot be read. */
  readonly readScript: (path: string) => string | null;
  /** Directory holding the per-fleet scripts. */
  readonly scriptDir: () => string;
}

export interface WatchdogFleet {
  readonly owner: string;
  readonly project: string;
  readonly workspaceDir: string;
}

function scheduleOf(line: string): string {
  return line.trim().split(/\s+/).slice(0, 5).join(' ');
}

function modeOf(script: string | null): 'report-only' | 'acting' | 'mode unknown' {
  if (script === null) return 'mode unknown';
  return /\bfleet reconcile\b[^\n]*\s--execute\b/.test(script) ? 'acting' : 'report-only';
}

export function checkWatchdog(fleet: WatchdogFleet, deps: WatchdogStatusDeps): WatchdogStatus {
  const read = deps.readCrontab();
  if (read.kind === 'unreadable') return { kind: 'unreadable', reason: read.reason };
  const marker = watchdogMarker(fleet.owner, fleet.project);
  // A commented-out line is a disabled watchdog: cron never runs it.
  const line = read.content
    .split('\n')
    .find((l) => !l.trimStart().startsWith('#') && isOwnedLine(l, marker, fleet.workspaceDir));
  if (line === undefined) return { kind: 'missing' };
  const script = deps.readScript(cronScriptPath(deps.scriptDir(), fleet.owner, fleet.project));
  return { kind: 'installed', schedule: scheduleOf(line), mode: modeOf(script) };
}

export function watchdogVerdictLine(status: WatchdogStatus): string {
  switch (status.kind) {
    case 'installed':
      return `Watchdog: installed (${status.schedule}, ${status.mode}).`;
    case 'missing':
      return (
        'Watchdog: NOT installed for this fleet on this host, so a crashed or stuck agent is not ' +
        'restarted or reported. Install it: macf fleet install-cron (runbook §3.6).'
      );
    case 'unreadable':
      return `Watchdog: could not check (${status.reason}).`;
  }
}

export function realWatchdogDeps(workspaceDir: string): WatchdogStatusDeps {
  const real = createRealDeps(workspaceDir);
  return {
    readCrontab: () => {
      try {
        const content = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { kind: 'ok', content };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
        if (e.code === 'ENOENT') return { kind: 'unreadable', reason: 'crontab not found on PATH' };
        const stderr = String(e.stderr ?? '');
        if (/no crontab for/i.test(stderr)) return { kind: 'ok', content: '' };
        return { kind: 'unreadable', reason: (stderr.trim() || e.message).split('\n')[0] ?? 'crontab -l failed' };
      }
    },
    readScript: real.readScript,
    scriptDir: real.scriptDir,
  };
}
