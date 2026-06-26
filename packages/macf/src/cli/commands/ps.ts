/**
 * `macf ps` — list every MACF `claude` / channel-server process, keyed by its
 * own `readlink /proc/<pid>/cwd` + per-process environment (macf#556).
 *
 * The whole point is multi-tenant correctness: one row per process, each keyed
 * by its OWN cwd + agent identity — NEVER `pgrep … | head -1` (which grabs an
 * arbitrary one of several and misdiagnoses siblings). The scan itself lives in
 * `proc-scan.ts` behind an injectable `ProcReader` so it's testable with
 * synthetic `/proc` data; this command is the thin presentation layer.
 *
 * Linux `/proc` only — degrades with a clear message where `/proc` is absent
 * (e.g. macOS).
 */
import { defaultProcReader, scanMacfProcesses } from '../proc-scan.js';
import type { MacfProcess, ProcReader } from '../proc-scan.js';

const HEADERS = [
  'PID',
  'KIND',
  'WORKSPACE',
  'AGENT',
  'MACF_PORT',
  'OTEL_ENDPOINT',
  'CWD',
] as const;

/** Build one display row per process (pure — exported for tests). */
export function buildPsRows(procs: readonly MacfProcess[]): readonly (readonly string[])[] {
  return procs.map((p) => [
    p.pid,
    p.kind,
    p.cwdBasename ?? '—',
    p.agentIdentity ?? '—',
    p.port ?? '—',
    p.otelEndpoint ?? '(none)',
    p.cwd ?? '—',
  ]);
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

/** Full rendered table for a process list (pure — exported for tests). */
export function formatPsTable(procs: readonly MacfProcess[]): string {
  return formatTable(HEADERS, buildPsRows(procs));
}

/**
 * `macf ps` entry point. Returns the shell exit code. The reader is injectable
 * for tests; production uses the real `/proc` reader.
 */
export function runPs(reader: ProcReader = defaultProcReader): number {
  if (!reader.available()) {
    console.log('macf ps: process introspection is Linux-only (no /proc on this host).');
    console.log(
      '  It reads /proc/<pid>/{cwd,environ,cmdline}; on macOS/other platforms there is nothing to scan.',
    );
    return 0;
  }

  const procs = scanMacfProcesses(reader);
  if (procs.length === 0) {
    console.log('No MACF claude / channel-server processes found.');
    return 0;
  }

  console.log(formatPsTable(procs));
  return 0;
}
