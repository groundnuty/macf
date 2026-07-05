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
  resolveGuestProbeCaBundle,
} from '@groundnuty/macf-core';
import type { AgentInfo, GuestBinding, HealthResponse, Logger } from '@groundnuty/macf-core';
import { formatTable } from './ps.js';
import {
  loadGuestBindings,
  loadFederatedCas,
  gatherGuestStatuses,
  formatGuestBlock,
  guestStatusesToJson,
  type GuestProbeFn,
  type GuestResolveFn,
  type GuestStatus,
} from './fleet-guests.js';
import { rawField, formatUptime, formatRunState, formatOtel } from './health-fields.js';
import type { AgentRunState, AgentOtelReport } from './health-fields.js';

// Re-exported so existing `from './fleet.js'` imports (incl. tests) keep
// working unchanged after the DR-030 `/health` field renderers moved to
// `health-fields.ts` (groundnuty/macf#794) to be shared with `fleet-guests.ts`.
export { rawField, formatUptime, formatRunState, formatOtel };
export type { AgentRunState, AgentOtelReport };

/** No-op logger for the guest-probe trust-bundle resolution below — a
 * misconfigured federated project degrades that ONE guest to offline
 * (caught at the call site); there's no operator-facing sink to log to
 * mid-`fleet status` render. */
const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

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
 * Render the framework-version self-report (`/health.version` — the
 * channel-server's OWN package version, macf#682). Read DEFENSIVELY: `version`
 * is a long-established REQUIRED field, but a body from an agent old enough to
 * predate it degrades to `?` (unknown) rather than crashing the roster.
 */
export function formatVersion(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : '?';
}

const HEADERS = [
  'NAME',
  'HOST:PORT',
  'STATUS',
  'VERSION',
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
      return [s.name, where, 'offline', '—', '—', '—', '—', '—', '—'];
    }
    const h = s.health;
    return [
      s.name,
      where,
      'online',
      formatVersion(rawField(h, 'version')),
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
 * any present `state`/`otel`/future fields pass through untouched. Guests
 * (DR-036 Amendment A) are a SEPARATE array — external, unsupervised (each
 * carries `supervised: false`) — never folded into `agents` (the members).
 *
 * `version` is surfaced as a TOP-LEVEL per-agent field (in addition to living
 * inside `health`) so the fleet-upgrade orchestrator (DR-007, macf#682) can read
 * `agents[].version` directly without reaching into the raw body. `null` when the
 * agent is offline or its `/health` predates the field.
 */
export function fleetStatusToJson(
  statuses: readonly FleetAgentStatus[],
  guests: readonly GuestStatus[] = [],
): unknown {
  return {
    agents: statuses.map((s) => {
      const version = rawField(s.health, 'version');
      return {
        name: s.name,
        host: s.host,
        port: s.port,
        status: s.online ? 'online' : 'offline',
        version: typeof version === 'string' && version.length > 0 ? version : null,
        health: s.health,
      };
    }),
    guests: guestStatusesToJson(guests),
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
  /**
   * Consumer-local cross-fleet guest bindings (DR-036 Amendment A). Optional —
   * defaults to none, so a fleet with no `.github/macf-fleet.json` guests renders
   * exactly as before.
   */
  readonly loadGuests?: () => readonly GuestBinding[];
  /** Resolve a guest's registry slot from the shared scope (keyed on home project). */
  readonly resolveGuest?: GuestResolveFn;
  /** mTLS `/health` probe for a `route` guest (reuses the members probe by default). */
  readonly guestProbe?: GuestProbeFn;
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
  const probe: FleetProbeFn = (host, port) =>
    pingAgentHealth({ host, port, caCertPem, certPath, keyPath });

  // DR-041 Amendment B (groundnuty/macf#794): a federation-aware guest probe.
  // `client` above is the SAME shared-registry `GitHubVariablesClient` already
  // built for this project's own `<PROJECT>_CA_CERT` read — a federated
  // fleet's CA variable lives in that SAME registry namespace (DR-006 shared
  // profile scope), so no separate client is needed (mirrors
  // `macf-channel-server/src/server.ts`'s `varsClient` reuse). `federated_cas`
  // is loaded ONCE per `fleet status` invocation, not per-guest.
  const federatedCaProjects = loadFederatedCas(projectDir);
  const guestProbe: GuestProbeFn = async (homeProject, host, port) => {
    let guestCaCertPem: string;
    try {
      guestCaCertPem = await resolveGuestProbeCaBundle(
        caCertPem,
        homeProject,
        federatedCaProjects,
        client,
        SILENT_LOGGER,
      );
    } catch {
      // A misconfigured DECLARED federated project must never crash the whole
      // roster — degrade THIS guest to offline (mirrors `resolveGuestStatus`'s
      // own `.catch(() => null)` around the probe call; this belt-and-braces
      // catch covers the bundle-resolution step specifically).
      return null;
    }
    return pingAgentHealth({ host, port, caCertPem: guestCaCertPem, certPath, keyPath });
  };

  return {
    ok: true,
    deps: {
      project: config.project,
      listPeers: () => registry.list(''),
      probe,
      loadGuests: () => loadGuestBindings(projectDir),
      // Resolve a guest cross-project within the SAME registry scope (DR-006
      // profile scope; macf#621 cross-scope) by keying a registry on the guest's
      // HOME project and reading its slot. Local-registry mode has no shared
      // cross-project scope, so a guest resolves only if it lives in this file.
      resolveGuest: (homeProject, name) =>
        createRegistryFromConfig(config.registry, homeProject, token).get(name),
      guestProbe,
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

  // Guests (DR-036 Amendment A) — external, unsupervised collaborators the
  // consumer DEPENDS on. Resolved from the shared registry scope; NEVER added to
  // the members list nor to any supervision path.
  const guestBindings = resolved.loadGuests ? resolved.loadGuests() : [];
  // Fall back to the members probe, adapted to `GuestProbeFn`'s 3-arg shape
  // (ignoring `homeProject`) — pre-#794 behavior for callers that don't wire
  // a federation-aware `guestProbe` explicitly.
  const guestProbeFallback: GuestProbeFn = (_homeProject, host, port) => resolved.probe(host, port);
  const guests =
    guestBindings.length > 0 && resolved.resolveGuest
      ? await gatherGuestStatuses(
          guestBindings,
          resolved.resolveGuest,
          resolved.guestProbe ?? guestProbeFallback,
        )
      : [];

  if (opts.json) {
    console.log(JSON.stringify(fleetStatusToJson(statuses, guests), null, 2));
    return 0;
  }

  const header = `macf fleet${resolved.project ? ` — ${resolved.project}` : ''}`;
  if (statuses.length === 0 && guests.length === 0) {
    console.log(`${header}\n\nNo agents registered in the registry.`);
    return 0;
  }
  console.log(`${header}\n`);
  if (statuses.length > 0) {
    console.log(formatFleetTable(statuses, now));
  } else {
    console.log('No agents registered in the registry.');
  }
  if (guests.length > 0) {
    console.log('');
    console.log(formatGuestBlock(guests, now));
  }
  return 0;
}
