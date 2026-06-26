import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { connect } from 'node:net';
import type { HealthResponse, HealthState } from '@groundnuty/macf-core';
import { readLastProcessed, type ProcessedReceipt } from './comms-ledger.js';

/** The DR-030 `/health` `state` object shape (non-null), derived from the schema. */
type TurnStateReport = NonNullable<HealthResponse['state']>;
/** The DR-030 `/health` `otel` object shape (non-null), derived from the schema. */
type OtelReport = NonNullable<HealthResponse['otel']>;

function readVersion(): string {
  const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

/**
 * Parse a leaf-cert PEM and return its `notAfter` as an ISO-8601 string, or
 * `null` if the PEM can't be parsed. DR-030 §4 per-agent `cert_expiry`
 * self-report (an expired leaf = silent off-channels; thresholds — warn <30d
 * / crit <7d — are the consumer's call). Uses `node:crypto` (zero-dep):
 * `@peculiar/x509` is only needed to *create* X.509, not to read one.
 */
export function leafCertExpiry(pem: string): string | null {
  try {
    return new X509Certificate(pem).validToDate.toISOString();
  } catch {
    return null;
  }
}

/** Read a leaf cert from disk and return its expiry; `null` if unreadable. */
function readCertExpiry(certPath: string): string | null {
  try {
    return leafCertExpiry(readFileSync(certPath, 'utf-8'));
  } catch {
    return null;
  }
}

// --- DR-030 phase-1 increment B: turn-state marker ('state') ---

/** `null` if the value isn't a non-negative integer (graceful pass-through). */
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Resolve the turn-state marker path from the environment. The marker lives at
 * `${MACF_WORKSPACE_DIR}/.macf/turn-state.json` (written by the plugin hooks of
 * a sibling increment). Returns `null` when `MACF_WORKSPACE_DIR` is unset so a
 * non-workspace launch degrades to `state: null` rather than reading from cwd.
 */
function resolveTurnStatePath(env: NodeJS.ProcessEnv): string | null {
  const ws = env['MACF_WORKSPACE_DIR'];
  return ws && ws.length > 0 ? join(ws, '.macf', 'turn-state.json') : null;
}

/** Read + JSON-parse the marker; `null` on missing/unparseable file (graceful). */
function readTurnState(path: string | null): unknown {
  if (path === null) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Map a parsed turn-state marker into the `/health` `state` object, computing
 * `elapsed_ms` against `now` (so it stays fresh through a long, e.g. 20-minute,
 * tool wait). Lenient by construction: the marker is written by an external hook,
 * so any missing/wrong-typed field degrades to `null` rather than throwing, and a
 * marker missing the required `status`/`turn_number` shape maps to `state: null`.
 *
 *   elapsed_ms = status === 'busy' ? max(0, now − started_at) : 0
 */
export function mapTurnStateMarker(raw: unknown, now: number): TurnStateReport | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  const status = m['status'];
  if (status !== 'busy' && status !== 'idle') return null;

  const turnNumber = m['turn_number'];
  if (typeof turnNumber !== 'number' || !Number.isInteger(turnNumber) || turnNumber < 0) {
    return null;
  }

  const startedAt = typeof m['started_at'] === 'number' ? m['started_at'] : null;
  const elapsed_ms =
    status === 'busy' && startedAt !== null ? Math.max(0, Math.floor(now - startedAt)) : 0;

  const phase = m['phase'] === 'thinking' || m['phase'] === 'tool' ? m['phase'] : null;

  return {
    status,
    turn_number: turnNumber,
    elapsed_ms,
    phase,
    current_tool: typeof m['current_tool'] === 'string' ? m['current_tool'] : null,
    current_command: typeof m['current_command'] === 'string' ? m['current_command'] : null,
    last_turn_duration_ms: intOrNull(m['last_turn_duration_ms']),
    tool_use_count: intOrNull(m['tool_use_count']),
    output_tokens: intOrNull(m['output_tokens']),
  };
}

// --- DR-030 phase-1 increment B: OTLP exporter self-report ('otel') ---

/**
 * Compute the static parts of the `otel` self-report from `process.env`.
 *
 * `endpoint_is_canonical` is **env-driven by design** — we deliberately do NOT
 * hardcode the monitoring-VM host in channel-server code (it would drift the day
 * the fleet's canonical endpoint moves). Instead "canonical" means "the live
 * `OTEL_EXPORTER_OTLP_ENDPOINT` equals `MACF_OTEL_ENDPOINT`", the same env that
 * `macf init`/`update` bake as the canonical default. So: false when no endpoint
 * is set, false when `MACF_OTEL_ENDPOINT` is unset (nothing to be canonical
 * against), false when they differ, true only when they're set + equal.
 */
export function computeOtelEndpointInfo(
  env: NodeJS.ProcessEnv,
): { readonly endpoint: string | null; readonly endpoint_is_canonical: boolean } {
  const raw = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const endpoint = raw !== undefined && raw.length > 0 ? raw : null;
  const canonical = env['MACF_OTEL_ENDPOINT'];
  const endpoint_is_canonical =
    endpoint !== null && canonical !== undefined && canonical.length > 0 && endpoint === canonical;
  return { endpoint, endpoint_is_canonical };
}

/** Parse `host`/`port` from an OTLP endpoint URL; `null` if unparseable. */
export function parseEndpointHostPort(
  endpoint: string,
): { readonly host: string; readonly port: number } | null {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    if (host.length === 0) return null;
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

/** Best-effort TCP-connect reachability check. Resolves false on any failure. */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export interface OtelReachabilityProbe {
  /** The cached reachability result (default `false` until the first probe completes). */
  readonly get: () => boolean;
  /** Run a single probe now and update the cache (awaitable; used by tests). */
  readonly runOnce: () => Promise<void>;
  /** Kick off an immediate probe + start the periodic interval (no-op if no endpoint). */
  readonly start: () => void;
  /** Clear the periodic interval (idempotent). */
  readonly stop: () => void;
}

/**
 * A cached, periodic OTLP-reachability probe. `getHealth()` is synchronous and
 * can't await a TCP connect, so reachability is computed out-of-band on an
 * interval and read from a cached boolean. The interval is `unref()`'d so it
 * never keeps the process alive, and is also clearable via `stop()` on shutdown.
 * The probe is injectable for testing (no real network in unit tests).
 */
export function createOtelReachabilityProbe(
  endpoint: string | null,
  opts: {
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
    readonly probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  } = {},
): OtelReachabilityProbe {
  const intervalMs = opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probe = opts.probe ?? tcpProbe;
  const target = endpoint !== null ? parseEndpointHostPort(endpoint) : null;

  let reachable = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<void> {
    if (target === null) {
      reachable = false;
      return;
    }
    try {
      reachable = await probe(target.host, target.port, timeoutMs);
    } catch {
      reachable = false;
    }
  }

  return {
    get: () => reachable,
    runOnce,
    start(): void {
      if (target === null || timer !== null) return;
      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      // Don't let the probe interval pin the event loop open on shutdown.
      timer.unref();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Optional self-report inputs for the DR-030 mesh-layer `/health` extension. */
export interface HealthStateOpts {
  /** The registration instance id (registry/health staleness disambiguator). */
  readonly instanceId?: string;
  /** Path to the agent's leaf cert, for the `cert_expiry` self-report. */
  readonly certPath?: string;
  /**
   * Path to the turn-state marker file. Defaults to
   * `${MACF_WORKSPACE_DIR}/.macf/turn-state.json`; injectable for testing.
   */
  readonly turnStatePath?: string;
  /** Injectable OTLP-reachability probe (testing — avoids real network). */
  readonly otelProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Override the OTLP-reachability probe interval (testing); default 30s. */
  readonly otelProbeIntervalMs?: number;
  /**
   * Channel-server log path (`MACF_LOG_PATH`); the turn-receipt sink lives at a
   * sibling `processed-receipts.jsonl` in the same directory. Source for the
   * DR-030 `last_processed` passive-receipt self-report (the server passes
   * `config.logPath`). When unset (and no `processedReader`), `last_processed`
   * is null — no sink to read.
   */
  readonly logPath?: string;
  /**
   * Injectable turn-receipt reader for `last_processed` (testing — avoids a real
   * on-disk receipt sink). Takes precedence over `logPath`-derived file reads
   * when set.
   */
  readonly processedReader?: () => readonly ProcessedReceipt[];
}

export function createHealthState(
  agentName: string,
  agentType: string,
  opts: HealthStateOpts = {},
): HealthState {
  const version = readVersion();
  const startTime = Date.now();
  const instanceId = opts.instanceId ?? null;
  // Read once at construction — the leaf doesn't change over a process lifetime.
  const certExpiry = opts.certPath ? readCertExpiry(opts.certPath) : null;

  // DR-030 turn-state: resolve the marker path once, but READ it fresh on every
  // getHealth() so `elapsed_ms` grows live through a long tool wait.
  const turnStatePath = opts.turnStatePath ?? resolveTurnStatePath(process.env);

  // DR-030 otel: endpoint + canonical are static for the process lifetime (OTLP
  // config doesn't change); reachability is a cached background probe since
  // getHealth() is synchronous.
  const otelInfo = computeOtelEndpointInfo(process.env);
  const otelProbe = createOtelReachabilityProbe(otelInfo.endpoint, {
    intervalMs: opts.otelProbeIntervalMs,
    probe: opts.otelProbe,
  });
  otelProbe.start();

  // DR-030 last_processed: resolve the receipt-sink source once; READ it FRESH on
  // every getHealth() so `age_ms` is current and a newly-processed turn-receipt
  // surfaces without a server restart.
  const logPath = opts.logPath;
  const processedReader = opts.processedReader;

  let currentIssue: number | null = null;
  let lastNotification: string | null = null;

  return {
    getHealth(): HealthResponse {
      const otel: OtelReport = {
        endpoint: otelInfo.endpoint,
        endpoint_is_canonical: otelInfo.endpoint_is_canonical,
        endpoint_reachable: otelProbe.get(),
      };
      return {
        agent: agentName,
        status: 'online',
        type: agentType,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        current_issue: currentIssue,
        version,
        last_notification: lastNotification,
        instance_id: instanceId,
        cert_expiry: certExpiry,
        state: mapTurnStateMarker(readTurnState(turnStatePath), Date.now()),
        otel,
        last_processed: readLastProcessed({
          logPath,
          now: Date.now(),
          readReceipts: processedReader,
        }),
      };
    },

    setCurrentIssue(issueNumber: number | null): void {
      currentIssue = issueNumber;
    },

    recordNotification(): void {
      lastNotification = new Date().toISOString();
    },

    dispose(): void {
      otelProbe.stop();
    },
  };
}
