/**
 * `macf ps` — the host-operational plane (DR-037 Decision 1/4): every MACF agent
 * on THIS box, ALIVE or DEAD, at what version.
 *
 * Two sources, unioned:
 *  - the running `claude` / channel-server processes, each keyed by its OWN
 *    `readlink /proc/<pid>/cwd` + per-process environment (macf#556) — NEVER
 *    `pgrep … | head -1` (which misdiagnoses siblings). Behind an injectable
 *    `ProcReader` (Linux `/proc` or the macOS `ps`/`lsof` variant).
 *  - the discovered workspaces (`discoverWorkspaces`, DR-037 Decision 4) — the
 *    registry-free `.macf/`-marker filesystem scan that reveals DEAD agents (a
 *    stopped agent has a workspace but no process).
 *
 * A workspace with a matching live process (cwd == canonical workspace path) is
 * ALIVE; a workspace with none is DEAD, its version read from its ON-DISK pin
 * (DR-037 Decision 5 — legible with no process running). The whole scan is
 * network-free (no registry, no mTLS).
 */
import { basename } from 'node:path';
import type { WorkspaceRecord } from '@groundnuty/macf-core';
import { defaultProcReader, scanMacfProcesses } from '../proc-scan.js';
import type { MacfProcess, MacfProcessKind, ProcReader } from '../proc-scan.js';
import { darwinProcReader } from '../proc-scan-darwin.js';
import { discoverWorkspaces } from '../discovery.js';

const HEADERS = [
  'STATUS',
  'PID',
  'KIND',
  'WORKSPACE',
  'AGENT',
  'VERSION',
  'PIN',
  'MACF_PORT',
  'OTEL_ENDPOINT',
  'CWD',
] as const;

/**
 * One `macf ps` row — a running process (alive) OR a discovered-but-not-running
 * workspace (dead). `version` is the RUNNING framework version (from the live
 * process's on-disk package, alive-only); `pinnedVersion` is the workspace's
 * on-disk pin (both alive + dead), so a mid-upgrade "pinned X, running Y" state
 * is legible (DR-037 Decision 5).
 */
export interface PsEntry {
  readonly alive: boolean;
  readonly pid: string | null;
  readonly kind: MacfProcessKind | null;
  /** Canonical absolute workspace path (nulls only for an unmatched process). */
  readonly workspacePath: string | null;
  readonly workspaceName: string | null;
  readonly agent: string | null;
  readonly version: string | null;
  readonly pinnedVersion: string | null;
  readonly registry: string | null;
  readonly port: string | null;
  readonly otelEndpoint: string | null;
  readonly cwd: string | null;
}

/**
 * Union the running processes with the discovered workspaces into alive/dead
 * entries (pure — exported for tests). One entry per running process (preserves
 * the macf#556 per-process visibility); one entry per workspace that has NO
 * matching live process. Matching is by exact canonical-path equality — both a
 * process's `readlink` cwd and a workspace's realpath are canonical, so a
 * symlinked repo root doesn't break the match.
 */
export function buildPsEntries(
  procs: readonly MacfProcess[],
  workspaces: readonly WorkspaceRecord[],
): readonly PsEntry[] {
  const byPath = new Map<string, WorkspaceRecord>();
  for (const w of workspaces) byPath.set(w.workspace, w);

  const matched = new Set<string>();
  const entries: PsEntry[] = [];

  for (const p of procs) {
    const ws = p.cwd ? byPath.get(p.cwd) ?? null : null;
    if (ws) matched.add(ws.workspace);
    entries.push({
      alive: true,
      pid: p.pid,
      kind: p.kind,
      workspacePath: ws?.workspace ?? p.cwd,
      workspaceName: ws ? basename(ws.workspace) : p.cwdBasename,
      // Prefer the process's own env-sourced identity (macf#556); fall back to
      // the workspace's routing label (the macOS path, where environ is unread).
      agent: p.agentIdentity ?? ws?.agent ?? null,
      version: p.version,
      pinnedVersion: ws?.versionPin ?? null,
      registry: ws?.registry ?? null,
      port: p.port,
      otelEndpoint: p.otelEndpoint,
      cwd: p.cwd,
    });
  }

  for (const w of workspaces) {
    if (matched.has(w.workspace)) continue;
    entries.push({
      alive: false,
      pid: null,
      kind: null,
      workspacePath: w.workspace,
      workspaceName: basename(w.workspace),
      agent: w.agent,
      version: null,
      pinnedVersion: w.versionPin,
      registry: w.registry,
      port: null,
      otelEndpoint: null,
      cwd: null,
    });
  }

  return [...entries].sort(compareEntries);
}

/** Stable ordering: workspace path (nulls last) → alive-before-dead → kind → pid. */
function compareEntries(a: PsEntry, b: PsEntry): number {
  const pa = a.workspacePath ?? '￿';
  const pb = b.workspacePath ?? '￿';
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  const ka = a.kind ?? '';
  const kb = b.kind ?? '';
  if (ka !== kb) return ka < kb ? -1 : 1;
  return Number(a.pid ?? 0) - Number(b.pid ?? 0);
}

/** Build one display row per entry (pure — exported for tests). */
export function buildPsRows(entries: readonly PsEntry[]): readonly (readonly string[])[] {
  return entries.map((e) => [
    e.alive ? 'alive' : 'dead',
    e.pid ?? '—',
    e.kind ?? '—',
    e.workspaceName ?? '—',
    e.agent ?? '—',
    e.version ?? '—',
    e.pinnedVersion ?? '—',
    e.port ?? '—',
    e.otelEndpoint ?? '(none)',
    e.cwd ?? e.workspacePath ?? '—',
  ]);
}

/**
 * Structured `--json` shape for automation (macf#682 + #141). `available`
 * distinguishes "no supported process source on this host" from "nothing found";
 * each entry carries `alive` so the fleet-upgrade orchestrator can enumerate dead
 * agents (their version resolves from `pinned_version`).
 */
export function psToJson(entries: readonly PsEntry[], available: boolean): unknown {
  return {
    available,
    processes: entries.map((e) => ({
      alive: e.alive,
      pid: e.pid,
      kind: e.kind,
      workspace: e.workspaceName,
      workspace_path: e.workspacePath,
      agent: e.agent,
      version: e.version,
      pinned_version: e.pinnedVersion,
      registry: e.registry,
      port: e.port,
      otel_endpoint: e.otelEndpoint,
      cwd: e.cwd,
    })),
  };
}

/** Options for `runPs`. */
export interface RunPsOptions {
  /** Emit the structured entry list as JSON instead of a table. */
  readonly json?: boolean;
}

/**
 * Render `headers` + `rows` as a left-aligned, dynamically-sized table.
 * Column widths flex to the longest cell so long values (cwd, OTEL endpoint)
 * never break the alignment of the earlier columns.
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 0),
  );
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}

/** Full rendered table for an entry list (pure — exported for tests). */
export function formatPsTable(entries: readonly PsEntry[]): string {
  return formatTable(HEADERS, buildPsRows(entries));
}

/**
 * Select the process reader for this host: the macOS `ps`/`lsof` reader on
 * darwin, else the Linux `/proc` reader (whose `available()` is false off-Linux,
 * covering other platforms). Injectable via `runPs`'s first argument for tests.
 */
export function selectProcReader(): ProcReader {
  return process.platform === 'darwin' ? darwinProcReader : defaultProcReader;
}

/**
 * `macf ps` entry point. Returns the shell exit code. Both sources are
 * injectable for tests; production uses the platform process reader + the real
 * workspace scan. The workspace scan runs even when process introspection is
 * unavailable (it's filesystem-portable) — so an unsupported host still lists
 * its workspaces (all as dead, since liveness can't be confirmed).
 */
export function runPs(
  reader: ProcReader = selectProcReader(),
  opts: RunPsOptions = {},
  discover: () => readonly WorkspaceRecord[] = () => discoverWorkspaces(),
): number {
  const available = reader.available();
  const procs = available ? scanMacfProcesses(reader) : [];
  const workspaces = discover();
  const entries = buildPsEntries(procs, workspaces);

  // JSON always emits valid, machine-consumable output — even off-/proc or with
  // zero matches — so the fleet-upgrade orchestrator never has to parse prose.
  if (opts.json) {
    console.log(JSON.stringify(psToJson(entries, available), null, 2));
    return 0;
  }

  if (entries.length === 0) {
    if (available) {
      console.log('No MACF claude / channel-server processes or workspaces found.');
    } else {
      console.log(
        'macf ps: no supported process source on this host (no /proc, not macOS) and no workspaces discovered.',
      );
    }
    return 0;
  }

  console.log(formatPsTable(entries));
  if (!available) {
    console.log('');
    console.log(
      'note: process introspection unavailable on this host — rows reflect the workspace scan only (liveness unconfirmed).',
    );
  }
  return 0;
}
