/**
 * macOS process reader for `macf ps` (DR-037 Decision 3 / Phase 3).
 *
 * The `ProcReader` seam abstracts the OS-specific liveness read; Linux uses
 * `/proc` (`proc-scan.ts`), macOS uses `ps` + `lsof` here. The workspace scan
 * (`discovery.ts`) is already filesystem-portable, so only this process-match
 * layer is OS-specific — swapping the reader makes the union model (alive∪dead)
 * work identically on macOS.
 *
 * Sourcing:
 *  - `listPids` / `readCmdline` — ONE `ps -axww -o pid= -o command=` snapshot,
 *    parsed + memoised (one spawn for the whole scan, not one-per-pid).
 *  - `readCwd` — per matched pid, `lsof -a -p <pid> -d cwd -Fn` (a handful of
 *    spawns; degrades to null on failure/permission, exactly like the /proc
 *    reader's EACCES path).
 *  - `readEnviron` — NOT AVAILABLE: macOS forbids reading another process's
 *    environment without root, so this returns null. Consequence: agent
 *    identity / port / OTEL endpoint aren't sourced from proc env on macOS —
 *    but the union model recovers identity + registry + pin from the matched
 *    WORKSPACE record (matched by cwd), so alive rows are still correctly
 *    attributed. Port/OTEL remain unknown on macOS (a documented follow-up:
 *    `ps -E`/libproc self-env only; TODO(macos) full env parity).
 *  - `readPkgVersion` — filesystem read, shared with the Linux reader.
 *
 * The pure parsers (`parseMacosPsSnapshot`, `parseLsofCwd`, `macosCommandToNul`)
 * are exported + unit-tested; the reader itself shells out and is exercised only
 * on a real macOS host.
 */
import { execFileSync } from 'node:child_process';
import type { ProcReader } from './proc-scan.js';
import { readPkgVersionFs } from './proc-scan.js';

/**
 * Parse a `ps -axww -o pid= -o command=` snapshot into a pid→command map.
 * Each line is `  <pid> <command...>` (leading whitespace, pid, single space,
 * then the full argv as a space-joined command). Pure.
 */
export function parseMacosPsSnapshot(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    map.set(m[1]!, m[2]!);
  }
  return map;
}

/**
 * Parse `lsof -Fn` output for a cwd descriptor into the directory path. The `-F`
 * format is one field per line prefixed by a type char; `n<path>` carries the
 * name. We requested `-d cwd`, so the first `n` line is the cwd. Pure.
 */
export function parseLsofCwd(raw: string): string | null {
  for (const line of raw.split('\n')) {
    if (line.startsWith('n')) return line.slice(1) || null;
  }
  return null;
}

/**
 * Convert a macOS `ps` space-joined command string into the NUL-separated form
 * the shared `classifyCmdline` / `channelServerPkgRootFromCmdline` expect. A
 * best-effort split on whitespace (paths with spaces are rare in agent launch
 * commands, and channel-server detection is a substring match that survives it).
 * Pure.
 */
export function macosCommandToNul(command: string): string {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length === 0 ? '' : tokens.join('\0') + '\0';
}

/** Run a command, returning stdout or null on any failure (never throws). */
function tryExec(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Build the macOS `ProcReader`. Memoises the single `ps` snapshot on first use.
 * `available()` is true only on darwin.
 */
export function createDarwinProcReader(): ProcReader {
  let snapshot: ReadonlyMap<string, string> | null = null;
  const getSnapshot = (): ReadonlyMap<string, string> => {
    if (snapshot === null) {
      const raw = tryExec('ps', ['-axww', '-o', 'pid=', '-o', 'command=']);
      snapshot = raw ? parseMacosPsSnapshot(raw) : new Map<string, string>();
    }
    return snapshot;
  };

  return {
    available: () => process.platform === 'darwin',
    listPids: () => [...getSnapshot().keys()],
    readCwd: (pid) => {
      const raw = tryExec('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
      return raw ? parseLsofCwd(raw) : null;
    },
    readCmdline: (pid) => {
      const command = getSnapshot().get(pid);
      return command ? macosCommandToNul(command) : null;
    },
    // macOS can't read another process's environ without root — identity/port/
    // OTEL are recovered from the matched workspace record instead (see header).
    readEnviron: () => null,
    readPkgVersion: readPkgVersionFs,
  };
}

/** The macOS process reader (memoised `ps` snapshot; `lsof` cwd; no environ). */
export const darwinProcReader: ProcReader = createDarwinProcReader();
