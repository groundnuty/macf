/**
 * Lead-only channel server (#1525).
 *
 * `.mcp.json` mounts the channel server for every `claude` process whose cwd
 * is the workspace, including agent-team teammates. Only the lead should run
 * one. The launcher writes its own pid to `.claude/.macf/lead-claude.pid`
 * right before `exec claude`; a server that is positively NOT a descendant of
 * that pid is a teammate's and skips.
 *
 * Any doubt means "run": a missing file, a dead lead, a lead pid that is not
 * a claude/launcher process, or unreadable ancestry all return `run`.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const LEAD_PID_RELATIVE_PATH = join('.claude', '.macf', 'lead-claude.pid');
export const MAX_ANCESTOR_DEPTH = 8;

export interface ProcInfo {
  readonly ppid: number;
  readonly comm: string;
}

export interface LeadCheckDeps {
  readonly readFile: (path: string) => string;
  /** Returns null when the process does not exist or cannot be read. */
  readonly lookup: (pid: number) => ProcInfo | null;
  readonly selfPid: number;
}

export type LeadCheckResult =
  | { readonly action: 'run'; readonly reason: string }
  | { readonly action: 'skip'; readonly leadPid: number; readonly ancestors: readonly number[] };

// The lead pid is claude itself, or the launcher shell when claude runs as its child.
const LEAD_COMM = /^(claude|node|bash|sh|zsh|dash)$|^\d+\.\d+\.\d+/;

export function checkIsLead(workspaceDir: string | undefined, deps: LeadCheckDeps): LeadCheckResult {
  if (workspaceDir === undefined || workspaceDir === '') {
    return { action: 'run', reason: 'workspace_dir_unknown' };
  }
  let leadPid: number;
  try {
    const raw = deps.readFile(join(workspaceDir, LEAD_PID_RELATIVE_PATH)).trim();
    if (!/^\d+$/.test(raw)) return { action: 'run', reason: 'pid_file_malformed' };
    leadPid = Number(raw);
  } catch {
    return { action: 'run', reason: 'pid_file_unreadable' };
  }
  if (leadPid <= 0) return { action: 'run', reason: 'pid_file_malformed' };
  if (leadPid === deps.selfPid) return { action: 'run', reason: 'self_is_lead' };

  const lead = safeLookup(deps, leadPid);
  if (lead === null) return { action: 'run', reason: 'lead_dead' };
  if (!LEAD_COMM.test(lead.comm)) return { action: 'run', reason: 'lead_not_claude' };

  const ancestors: number[] = [];
  let pid = deps.selfPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const info = safeLookup(deps, pid);
    if (info === null) return { action: 'run', reason: 'ancestry_unreadable' };
    if (info.ppid <= 1) {
      // Reached init: a complete chain that never met the lead.
      return { action: 'skip', leadPid, ancestors };
    }
    ancestors.push(info.ppid);
    if (info.ppid === leadPid) return { action: 'run', reason: 'lead_is_ancestor' };
    pid = info.ppid;
  }
  // Chain longer than the cap and the lead not found: not conclusive.
  return { action: 'run', reason: 'ancestry_too_deep' };
}

function safeLookup(deps: LeadCheckDeps, pid: number): ProcInfo | null {
  try {
    return deps.lookup(pid);
  } catch {
    return null;
  }
}

/** Production process lookup: /proc on Linux, `ps` elsewhere. */
export function systemLookup(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid ..." — comm may contain spaces/parens.
    const close = stat.lastIndexOf(')');
    const open = stat.indexOf('(');
    if (open < 0 || close < open) return null;
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    if (!Number.isInteger(ppid)) return null;
    return { ppid, comm: stat.slice(open + 1, close) };
  } catch {
    // fall through to ps
  }
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = /^(\d+)\s+(.+)$/.exec(out);
    if (m === null) return null;
    const base = (m[2] ?? '').split('/').pop() ?? '';
    return { ppid: Number(m[1]), comm: base };
  } catch {
    return null;
  }
}

export const systemLeadCheckDeps = (): LeadCheckDeps => ({
  readFile: (p) => readFileSync(p, 'utf8'),
  lookup: systemLookup,
  selfPid: process.pid,
});
