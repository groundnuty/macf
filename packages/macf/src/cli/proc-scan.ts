/**
 * Identity-scoped `/proc` scanning for MACF process diagnostics (macf#556).
 *
 * Single-tenant instruments (`pgrep claude | head -1`) are WRONG on a
 * multi-tenant host: `head -1` grabs an arbitrary one of several `claude`
 * processes, producing a "no OTEL" false negative against a sibling agent.
 * This module is correct-by-construction: it enumerates EVERY MACF process
 * and keys each one by its own `readlink /proc/<pid>/cwd` + per-process
 * environment, so the caller can disambiguate by workspace / agent identity
 * instead of picking one at random.
 *
 * Linux `/proc` only. The `ProcReader` seam keeps the scan a PURE function of
 * injectable inputs so tests feed synthetic `/proc` data (no real running
 * processes), and the real reader degrades gracefully (every read returns
 * `null` on EACCES / ESRCH races; `available()` is false off-Linux).
 */
import { readdirSync, readlinkSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The MACF process kinds this scanner recognises. */
export type MacfProcessKind = 'claude' | 'channel-server';

/** Where an agent identity was sourced from (precedence high→low). */
export type IdentitySource = 'otel' | 'env-name' | 'env-label';

/**
 * Injectable `/proc` reader. The default implementation reads the real
 * filesystem; tests pass a synthetic one. Every accessor returns `null`
 * rather than throwing so a PID vanishing mid-scan (ESRCH) or owned by
 * another user (EACCES) degrades to "unknown", not a crash.
 */
export interface ProcReader {
  /** Is `/proc`-based introspection available on this host? */
  readonly available: () => boolean;
  /** Numeric PID directory names under `/proc`. */
  readonly listPids: () => readonly string[];
  /** `readlink /proc/<pid>/cwd` — absolute path, or null. */
  readonly readCwd: (pid: string) => string | null;
  /** Raw NUL-separated `/proc/<pid>/cmdline`, or null. */
  readonly readCmdline: (pid: string) => string | null;
  /** Raw NUL-separated `/proc/<pid>/environ`, or null. */
  readonly readEnviron: (pid: string) => string | null;
  /**
   * Read `<pkgRoot>/package.json`'s `version` (the channel-server's OWN package
   * version — the SAME value it self-reports on `/health.version`, macf#682).
   * Local + zero-network by design: `macf ps` is a pure `/proc` scanner, so it
   * sources the version from the resolved-on-disk package rather than probing
   * `/health`. Optional so existing readers (and tests) that don't provide it
   * degrade the VERSION column to `—`. Returns `null` on any failure.
   */
  readonly readPkgVersion?: (pkgRoot: string) => string | null;
}

/** One discovered MACF process, keyed by its own cwd + identity. */
export interface MacfProcess {
  readonly pid: string;
  readonly kind: MacfProcessKind;
  /** Absolute cwd from `/proc/<pid>/cwd` (the disambiguation key). */
  readonly cwd: string | null;
  /** `basename(cwd)` for compact display. */
  readonly cwdBasename: string | null;
  /** Resolved agent identity (see `agentIdentityFromEnv`). */
  readonly agentIdentity: string | null;
  readonly identitySource: IdentitySource | null;
  /** `MACF_PORT` from the process environment. */
  readonly port: string | null;
  /** `OTEL_EXPORTER_OTLP_ENDPOINT` from the process environment. */
  readonly otelEndpoint: string | null;
  /**
   * The channel-server's running framework version (macf#682) — the SAME value
   * it self-reports on `/health.version`, resolved LOCALLY from the on-disk
   * `package.json` next to the running `server.js` (no network). `null` for a
   * `claude` process (the framework version is a channel-server property) and
   * whenever the package root / version can't be resolved.
   */
  readonly version: string | null;
}

/** Split a NUL-separated `/proc` blob (cmdline / environ) into tokens. */
export function splitNul(raw: string): readonly string[] {
  return raw.split('\0').filter((t) => t.length > 0);
}

/**
 * Parse a NUL-separated `/proc/<pid>/environ` blob into a key→value map.
 * Splits each entry on the FIRST `=` (values may contain `=`).
 */
export function parseEnviron(raw: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const entry of splitNul(raw)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * Parse an `OTEL_RESOURCE_ATTRIBUTES` value (`k1=v1,k2=v2`) into a map.
 * Used to recover `gen_ai.agent.name`, the OTEL-canonical agent identity.
 */
export function parseOtelResourceAttributes(value: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    attrs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return attrs;
}

/**
 * Resolve an agent identity from a process environment, in precedence order:
 *   1. `gen_ai.agent.name` inside `OTEL_RESOURCE_ATTRIBUTES` (telemetry-canonical)
 *   2. `MACF_AGENT_NAME`
 *   3. `MACF_ROUTING_LABEL`
 * Returns null when none is present.
 */
export function agentIdentityFromEnv(
  env: Readonly<Record<string, string>>,
): { readonly identity: string; readonly source: IdentitySource } | null {
  const ra = env['OTEL_RESOURCE_ATTRIBUTES'];
  if (ra) {
    const name = parseOtelResourceAttributes(ra)['gen_ai.agent.name'];
    if (name) return { identity: name, source: 'otel' };
  }
  const envName = env['MACF_AGENT_NAME'];
  if (envName) return { identity: envName, source: 'env-name' };
  const envLabel = env['MACF_ROUTING_LABEL'];
  if (envLabel) return { identity: envLabel, source: 'env-label' };
  return null;
}

/**
 * Classify a raw cmdline blob as a MACF process kind, or null if it's neither.
 * channel-server wins over claude (a server is a node process that never
 * carries a `claude` argv0). claude matches when any argv token's basename is
 * exactly `claude` (covers `claude`, `/usr/local/bin/claude`, `.../bin/claude`).
 */
export function classifyCmdline(raw: string): MacfProcessKind | null {
  const tokens = splitNul(raw);
  if (tokens.length === 0) return null;
  if (tokens.some((t) => t.includes('macf-channel-server'))) return 'channel-server';
  if (tokens.some((t) => basename(t) === 'claude')) return 'claude';
  return null;
}

/**
 * Resolve the channel-server's on-disk PACKAGE ROOT from its cmdline (macf#682),
 * so the caller can read `<root>/package.json` for the running version. The
 * server runs as `node .../@groundnuty/macf-channel-server/dist/server.js`, so
 * the package root is the token truncated at `macf-channel-server` inclusive
 * (`.../@groundnuty/macf-channel-server`). Returns `null` when no token carries
 * the marker (e.g. a `claude` process, or an unexpected launch form).
 */
export function channelServerPkgRootFromCmdline(cmdline: string): string | null {
  const marker = 'macf-channel-server';
  for (const token of splitNul(cmdline)) {
    const i = token.indexOf(marker);
    if (i >= 0) return token.slice(0, i + marker.length);
  }
  return null;
}

/**
 * Enumerate every MACF claude / channel-server process via the reader.
 * PURE w.r.t. the reader: no real-process dependency. Each process is keyed by
 * its OWN cwd + environment — never `head -1`. Returns a stable ordering
 * (by cwd, then kind, then numeric pid) for readable, diffable output.
 */
export function scanMacfProcesses(reader: ProcReader): readonly MacfProcess[] {
  if (!reader.available()) return [];
  const out: MacfProcess[] = [];
  for (const pid of reader.listPids()) {
    const cmdline = reader.readCmdline(pid);
    if (cmdline === null) continue;
    const kind = classifyCmdline(cmdline);
    if (!kind) continue;

    const cwd = reader.readCwd(pid);
    const environRaw = reader.readEnviron(pid);
    const env = environRaw ? parseEnviron(environRaw) : {};
    const id = agentIdentityFromEnv(env);

    // Version is a channel-server property (macf#682): resolve the on-disk
    // package root from its cmdline and read package.json's version. `claude`
    // rows have no framework version of their own → null.
    let version: string | null = null;
    if (kind === 'channel-server' && reader.readPkgVersion) {
      const pkgRoot = channelServerPkgRootFromCmdline(cmdline);
      version = pkgRoot ? reader.readPkgVersion(pkgRoot) : null;
    }

    out.push({
      pid,
      kind,
      cwd,
      cwdBasename: cwd ? basename(cwd) : null,
      agentIdentity: id?.identity ?? null,
      identitySource: id?.source ?? null,
      port: env['MACF_PORT'] ?? null,
      otelEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? null,
      version,
    });
  }
  return [...out].sort(compareProcesses);
}

/** Stable ordering: cwd (nulls last) → kind → numeric pid. */
function compareProcesses(a: MacfProcess, b: MacfProcess): number {
  const ca = a.cwd ?? '￿';
  const cb = b.cwd ?? '￿';
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return Number(a.pid) - Number(b.pid);
}

/**
 * Real `/proc` reader. Each accessor swallows errors → null so a PID racing
 * away mid-scan or an unreadable (other-user) process degrades gracefully.
 */
export const defaultProcReader: ProcReader = {
  available: () => process.platform === 'linux' && existsSync('/proc'),
  listPids: () => {
    try {
      return readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return [];
    }
  },
  readCwd: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  readCmdline: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    } catch {
      return null;
    }
  },
  readEnviron: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf-8');
    } catch {
      return null;
    }
  },
  readPkgVersion: (pkgRoot) => {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
        version?: unknown;
      };
      return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
    } catch {
      return null;
    }
  },
};
