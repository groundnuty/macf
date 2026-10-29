/** `fleet/watchdog-status.ts` — the watchdog verdict (#1525). */
import { describe, it, expect } from 'vitest';
import { checkWatchdog, watchdogVerdictLine, type CrontabRead } from '../../src/cli/fleet/watchdog-status.js';

const fleet = { owner: 'acme', project: 'demo', workspaceDir: '/w/demo' };
const line = (m: string): string => `*/5 * * * * /bin/sh '/h/.macf/cron/acme__demo.sh' >> '/l' 2>&1 ${m}`;
const deps = (c: CrontabRead, script: string | null = null) => ({
  readCrontab: () => c,
  readScript: () => script,
  scriptDir: () => '/h/.macf/cron',
});

describe('checkWatchdog', () => {
  it('missing: empty crontab', () => {
    expect(checkWatchdog(fleet, deps({ kind: 'ok', content: '' })).kind).toBe('missing');
  });
  it('missing: the bare legacy marker of another workspace is not ours', () => {
    const c = line('# macf-watchdog (DR-006)');
    expect(checkWatchdog(fleet, deps({ kind: 'ok', content: c })).kind).toBe('missing');
  });
  it('installed: this fleet marker; mode unknown when the script is unreadable', () => {
    const c = line('# macf-watchdog (DR-006) [fleet=acme/demo]');
    expect(checkWatchdog(fleet, deps({ kind: 'ok', content: c }))).toEqual({
      kind: 'installed', schedule: '*/5 * * * *', mode: 'mode unknown',
    });
  });
  it('missing: a commented-out line for this fleet is a disabled watchdog', () => {
    const c = '# ' + line('# macf-watchdog (DR-006) [fleet=acme/demo]');
    expect(checkWatchdog(fleet, deps({ kind: 'ok', content: c })).kind).toBe('missing');
  });
  it('unreadable carries its reason into the line', () => {
    const s = checkWatchdog(fleet, deps({ kind: 'unreadable', reason: 'boom' }));
    expect(watchdogVerdictLine(s)).toBe('Watchdog: could not check (boom).');
  });
});
