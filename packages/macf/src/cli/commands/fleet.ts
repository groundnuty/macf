/**
 * `macf fleet status` — the everyday fleet roster + LIVE health view
 * (DR-030 phase-1 increment C, macf#568).
 *
 * For the current project's registry, list every registered agent and show, per
 * agent: NAME, HOST:PORT (from the registry), STATUS (online/offline via the
 * mTLS `/health` ping), UPTIME, plus the self-report fields PRESENT on the
 * `/health` body — `instance_id`, `cert_expiry` (warn <30d / crit <7d), and, IF
 * PRESENT, `state` (idle/busy, optionally "busy 18m on turn 7") and `otel`
 * (endpoint reachability).
 *
 * The `/health` schema is being extended in a sibling DR-030 increment (adding
 * `state` + `otel`, DR-030 §5). This command reads the body DEFENSIVELY — via a
 * loosely-typed view + presence checks — so it renders whatever fields exist and
 * NEVER hard-depends on `state`/`otel` being in the `HealthResponse` type yet.
 * `state` is tolerated as either a plain string (`"idle"|"busy"`, DR-030 §5) or
 * an object (`{ status, turn_number, elapsed_ms }`, the richer self-report).
 *
 * This is the NON-invasive "Reachable + self-reports" view ONLY: it does NOT
 * implement the diagnostic / `--inject` / Accepted→Processed delivery checks —
 * those are later DR-030 increments.
 *
 * Reuses the building blocks of `macf status` / `macf registry prune`: the mTLS
 * `/health` ping (`pingAgentHealth`), the registry list
 * (`createRegistryFromConfig`), the CA-cert read (`createClientFromConfig`), and
 * the `formatTable` renderer (shared with `macf ps`).
 */
import {
  readAgentConfig,
  tokenSourceFromConfig,
  agentCertPath,
  agentKeyPath,
} from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import {
  createRegistryFromConfig,
  generateToken,
  pingAgentHealth,
  toVariableSegment,
} from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import { formatTable } from './ps.js';

/**
 * DR-030 sibling-increment `/health.state` object self-report — read
 * DEFENSIVELY (NOT yet in the `HealthResponse` type). All fields optional; the
 * field may also arrive as a plain `"idle"|"busy"` string (DR-030 §5).
 */
export interface AgentRunState {
  readonly status?: string;
  readonly turn_number?: number;
  readonly elapsed_ms?: number;
}

/** DR-030 sibling-increment `/health.otel` self-report — read DEFENSIVELY. */
export interface AgentOtelReport {
  readonly endpoint_reachable?: boolean;
}

/** One agent's roster + reachability + raw self-report body. */
export interface FleetAgentStatus {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly online: boolean;
  /** Raw `/health` body (incl. any defensively-read `state`/`otel`), or null when offline. */
  readonly health: HealthResponse | null;
}

/** Probe a single endpoint's `/health`; null on any failure. Injectable for tests. */
export type FleetProbeFn = (host: string, port: number) => Promise<HealthResponse | null>;

/** Read an arbitrary (possibly not-yet-typed) field off a `/health` body. */
function rawField(health: HealthResponse | null, key: string): unknown {
  return health ? (health as unknown as Record<string, unknown>)[key] : undefined;
}

/**
 * Probe one peer, treating a REJECTED probe the SAME as a `null` resolution.
 * `pingAgentHealth` is documented to resolve `null` on any failure, but a
 * TRANSIENT fault can still reject the promise (a network error surfacing as
 * `fetch failed`, or a synchronous `readFileSync` throw inside the probe when
 * the cert file blinks out between the `existsSync` check and the read). A
 * rejection here must mark only THAT peer unreachable — never abort the whole
 * roster (macf#609). Mirrors `macf fleet doctor`'s per-peer failure isolation.
 */
async function safeProbe(
  probe: FleetProbeFn,
  host: string,
  port: number,
): Promise<HealthResponse | null> {
  try {
    return await probe(host, port);
  } catch {
    return null;
  }
}

/**
 * Probe every peer once and collect roster + reachability + raw body. PURE
 * w.r.t. `probe` — tests inject a fake so nothing hits the network. Each peer's
 * probe is isolated (`safeProbe`): a single rejected/timed-out `/health` probe
 * degrades that one peer to offline and the join still resolves with the full
 * roster — it does NOT reject and abort the command (macf#609).
 */
export async function gatherFleetStatus(
  peers: readonly { readonly name: string; readonly info: AgentInfo }[],
  probe: FleetProbeFn,
): Promise<readonly FleetAgentStatus[]> {
  const settled = await Promise.allSettled(
    peers.map((peer) => safeProbe(probe, peer.info.host, peer.info.port)),
  );
  return peers.map((peer, i) => {
    const r = settled[i]!;
    // safeProbe never rejects, so `rejected` is a belt-and-braces guard: any
    // future probe-path that throws still degrades to offline, never aborts.
    const health = r.status === 'fulfilled' ? r.value : null;
    return {
      name: peer.name,
      host: peer.info.host,
      port: peer.info.port,
      online: health !== null,
      health,
    };
  });
}

/** Human-readable elapsed from whole seconds: `45s` / `18m` / `2h5m`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/** Whole days from `now` (ms) until an ISO timestamp; negative when past. */
export function daysUntil(isoDate: string, now: number): number {
  const ms = new Date(isoDate).getTime() - now;
  return Math.floor(ms / 86_400_000);
}

/**
 * Render `cert_expiry` with a severity marker: crit (`✗`) when <7d / already
 * expired, warn (`⚠`) when <30d. An expired leaf = silent off-channels
 * (DR-030 §5), so it earns the loudest marker.
 */
export function formatCertExpiry(certExpiry: string | null | undefined, now: number): string {
  if (!certExpiry) return '—';
  const d = daysUntil(certExpiry, now);
  if (Number.isNaN(d)) return '—';
  if (d < 0) return `expired ${-d}d ago ✗`;
  if (d < 7) return `${d}d ✗`;
  if (d < 30) return `${d}d ⚠`;
  return `${d}d`;
}

/**
 * Render the `state` self-report. Tolerates the field being absent, a plain
 * `"idle"|"busy"` string (DR-030 §5), or a `{ status, turn_number, elapsed_ms }`
 * object (rendered like `busy 18m on turn 7`).
 */
export function formatRunState(raw: unknown): string {
  if (raw == null) return '—';
  if (typeof raw === 'string') return raw || '—';
  if (typeof raw === 'object') {
    const s = raw as AgentRunState;
    const parts: string[] = [];
    if (typeof s.status === 'string' && s.status) parts.push(s.status);
    if (typeof s.elapsed_ms === 'number') parts.push(formatUptime(Math.floor(s.elapsed_ms / 1000)));
    if (typeof s.turn_number === 'number') parts.push(`on turn ${s.turn_number}`);
    return parts.length ? parts.join(' ') : '—';
  }
  return '—';
}

/** Render the `otel` self-report's `endpoint_reachable` flag. */
export function formatOtel(raw: unknown): string {
  if (raw == null || typeof raw !== 'object') return '—';
  const o = raw as AgentOtelReport;
  if (typeof o.endpoint_reachable !== 'boolean') return '—';
  return o.endpoint_reachable ? 'reachable' : 'unreachable ✗';
}

const HEADERS = [
  'NAME',
  'HOST:PORT',
  'STATUS',
  'UPTIME',
  'STATE',
  'OTEL',
  'INSTANCE',
  'CERT-EXPIRY',
] as const;

/** Build one display row per agent (pure — exported for tests). */
export function buildFleetRows(
  statuses: readonly FleetAgentStatus[],
  now: number,
): readonly (readonly string[])[] {
  return statuses.map((s) => {
    const where = `${s.host}:${s.port}`;
    if (!s.online || !s.health) {
      return [s.name, where, 'offline', '—', '—', '—', '—', '—'];
    }
    const h = s.health;
    return [
      s.name,
      where,
      'online',
      formatUptime(h.uptime_seconds),
      formatRunState(rawField(h, 'state')),
      formatOtel(rawField(h, 'otel')),
      h.instance_id ?? '—',
      formatCertExpiry(h.cert_expiry, now),
    ];
  });
}

/** Full rendered table for a fleet status list (pure — exported for tests). */
export function formatFleetTable(statuses: readonly FleetAgentStatus[], now: number): string {
  return formatTable(HEADERS, buildFleetRows(statuses, now));
}

/**
 * Structured `--json` shape for automation. Carries the RAW `/health` body so
 * any present `state`/`otel`/future fields pass through untouched.
 */
export function fleetStatusToJson(statuses: readonly FleetAgentStatus[]): unknown {
  return {
    agents: statuses.map((s) => ({
      name: s.name,
      host: s.host,
      port: s.port,
      status: s.online ? 'online' : 'offline',
      health: s.health,
    })),
  };
}

/** Options for `runFleetStatus`. */
export interface RunFleetStatusOptions {
  /** Emit the structured data as JSON instead of a table. */
  readonly json?: boolean;
  /** Clock for cert-expiry math (defaults to `Date.now()`; injected in tests). */
  readonly now?: number;
}

/** Injectable seam so tests drive the command without touching the registry/network. */
export interface FleetStatusDeps {
  readonly listPeers: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  readonly probe: FleetProbeFn;
  readonly project?: string;
}

/** Wire the registry + mTLS probe from a project's config. */
async function resolveDepsFromRegistry(
  projectDir: string,
): Promise<{ readonly ok: true; readonly deps: FleetStatusDeps } | { readonly ok: false; readonly code: number }> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return { ok: false, code: 1 };
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caCertPem = await client.readVariable(`${toVariableSegment(config.project)}_CA_CERT`);
  if (!caCertPem) {
    console.error('CA certificate not found in registry. Run `macf certs init` first.');
    return { ok: false, code: 1 };
  }

  const certPath = agentCertPath(projectDir);
  const keyPath = agentKeyPath(projectDir);
  return {
    ok: true,
    deps: {
      project: config.project,
      listPeers: () => registry.list(''),
      probe: (host, port) => pingAgentHealth({ host, port, caCertPem, certPath, keyPath }),
    },
  };
}

/**
 * `macf fleet status` entry point. Returns the shell exit code. `deps` is
 * injected by tests; production resolves it from the project's registry config.
 */
export async function runFleetStatus(
  projectDir: string,
  opts: RunFleetStatusOptions = {},
  deps?: FleetStatusDeps,
): Promise<number> {
  let resolved = deps;
  if (!resolved) {
    const r = await resolveDepsFromRegistry(projectDir);
    if (!r.ok) return r.code;
    resolved = r.deps;
  }

  const peers = await resolved.listPeers();
  const statuses = await gatherFleetStatus(peers, resolved.probe);
  const now = opts.now ?? Date.now();

  if (opts.json) {
    console.log(JSON.stringify(fleetStatusToJson(statuses), null, 2));
    return 0;
  }

  const header = `macf fleet${resolved.project ? ` — ${resolved.project}` : ''}`;
  if (statuses.length === 0) {
    console.log(`${header}\n\nNo agents registered in the registry.`);
    return 0;
  }
  console.log(`${header}\n`);
  console.log(formatFleetTable(statuses, now));
  return 0;
}
