import { describe, it, expect } from 'vitest';
import { checkIsLead, type ProcInfo, type LeadCheckDeps } from '../src/lead-check.js';

const WS = '/ws';
const PIDFILE = '/ws/.claude/.macf/lead-claude.pid';

function deps(table: Record<number, ProcInfo>, files: Record<string, string>, selfPid: number): LeadCheckDeps {
  return {
    selfPid,
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    lookup: (pid) => table[pid] ?? null,
  };
}

// 100 = lead claude, 200 = lead's mcp child chain, 300 = teammate claude
const table: Record<number, ProcInfo> = {
  100: { ppid: 50, comm: 'claude' },
  50: { ppid: 1, comm: 'tmux: server' },
  150: { ppid: 100, comm: 'npm' },
  200: { ppid: 150, comm: 'node' },
  300: { ppid: 50, comm: 'claude' },
  350: { ppid: 300, comm: 'npm' },
  400: { ppid: 350, comm: 'node' },
};

describe('checkIsLead', () => {
  it('runs when the lead pid is an ancestor', () => {
    const r = checkIsLead(WS, deps(table, { [PIDFILE]: '100\n' }, 200));
    expect(r).toEqual({ action: 'run', reason: 'lead_is_ancestor' });
  });

  it('skips when the lead is alive, is claude, and is not an ancestor', () => {
    const r = checkIsLead(WS, deps(table, { [PIDFILE]: '100\n' }, 400));
    expect(r.action).toBe('skip');
    if (r.action === 'skip') {
      expect(r.leadPid).toBe(100);
      expect(r.ancestors).toEqual([350, 300, 50]);
    }
  });

  it('runs when there is no pid file', () => {
    expect(checkIsLead(WS, deps(table, {}, 400))).toEqual({ action: 'run', reason: 'pid_file_unreadable' });
  });

  it('runs when the pid file is malformed', () => {
    expect(checkIsLead(WS, deps(table, { [PIDFILE]: 'abc' }, 400)).action).toBe('run');
  });

  it('runs when the lead is dead', () => {
    const r = checkIsLead(WS, deps(table, { [PIDFILE]: '999' }, 400));
    expect(r).toEqual({ action: 'run', reason: 'lead_dead' });
  });

  it('runs when the lead pid is not a claude process', () => {
    const t = { ...table, 100: { ppid: 50, comm: 'vim' } };
    const r = checkIsLead(WS, deps(t, { [PIDFILE]: '100' }, 400));
    expect(r).toEqual({ action: 'run', reason: 'lead_not_claude' });
  });

  it('runs when ancestry is unreadable', () => {
    const t = { ...table };
    delete t[350];
    const r = checkIsLead(WS, deps(t, { [PIDFILE]: '100' }, 400));
    expect(r).toEqual({ action: 'run', reason: 'ancestry_unreadable' });
  });

  it('runs when the workspace dir is unknown', () => {
    expect(checkIsLead(undefined, deps(table, { [PIDFILE]: '100' }, 400)).action).toBe('run');
  });

  it('runs when a lookup throws', () => {
    const d: LeadCheckDeps = { ...deps(table, { [PIDFILE]: '100' }, 400), lookup: () => { throw new Error('x'); } };
    expect(checkIsLead(WS, d).action).toBe('run');
  });
});
