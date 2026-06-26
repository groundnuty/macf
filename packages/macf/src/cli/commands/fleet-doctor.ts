/**
 * `macf fleet doctor` — NON-INVASIVE mesh-interconnect test (DR-030 phase-1
 * increment 1d, macf#568).
 *
 * For the current project's registry, run a two-tier delivery ladder per agent:
 *
 *   1. REACHABLE — the agent's registry `host:port` answers an mTLS `/health`
 *      ping (reuses `pingAgentHealth`, the same probe `macf fleet status` uses).
 *   2. ACCEPTED  — an mTLS `/notify` POST carrying a DIAGNOSTIC payload is ACK'd
 *      by the server's receive path. The diagnostic body short-circuits to an
 *      ACK BEFORE any MCP push, and the ACK echoes back the correlation token we
 *      sent. "Accepted" is green iff HTTP 200 AND `ack === true` AND the echoed
 *      `correlation_token` matches what we sent (the echo proves a real
 *      round-trip, not a coincidental 200).
 *
 * HONESTY (DR-030 §3, rendered LOUDLY in the output legend): these NON-invasive
 * checks prove the protocol REACHES THE SERVER (mTLS auth + body parse) ONLY —
 * they do NOT prove DELIVERY TO THE AGENT (the MCP-push → agent-reads gap is not
 * exercised). Real mesh delivery needs `--inject` (a later DR-030 increment);
 * routing-plane delivery needs an e2e run.
 *
 * Reuses `macf fleet status`'s plumbing: the registry list
 * (`createRegistryFromConfig`), the mTLS `/health` probe (`pingAgentHealth`),
 * the CA-cert read (`createClientFromConfig`), and the `formatTable` renderer
 * (shared with `macf ps` / `macf fleet status`). The diagnostic POST mirrors
 * `pingAgentHealth`'s mTLS request shape. Registry + both mTLS calls are
 * injectable (`FleetDoctorDeps`) so tests run fully offline.
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
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

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The diagnostic `/notify` ACK body (the wire contract a SIBLING increment adds
 * server-side; pinned here EXACTLY). The server short-circuits a `diagnostic:
 * true` payload to this ACK before any MCP push and echoes the token back.
 */
export interface DiagnosticAckBody {
  readonly ack?: boolean;
  readonly agent?: string;
  readonly instance_id?: string;
  readonly correlation_token?: string;
}

/** Raw result of the diagnostic POST — what the server returned (or why not). */
export interface DiagnosticAck {
  /** HTTP status, or null when no response arrived (refused / timeout / cert). */
  readonly status: number | null;
  /** Parsed ACK body, or null on non-JSON / no response. */
  readonly body: DiagnosticAckBody | null;
  /** Short failure reason for diagnostics, when not a clean ACK. */
  readonly error?: string;
}

/** Probe a single endpoint's `/health`; null on any failure. Injectable for tests. */
export type FleetProbeFn = (host: string, port: number) => Promise<HealthResponse | null>;

/** POST the diagnostic `/notify` and collect the ACK. Injectable for tests. */
export type FleetDiagnosticFn = (
  host: string,
  port: number,
  correlationToken: string,
) => Promise<DiagnosticAck>;

/** One agent's two-tier ladder result. */
export interface FleetDoctorResult {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** mTLS `/health` answered. */
  readonly reachable: boolean;
  /**
   * Diagnostic `/notify` ACK'd (200 + ack + token-echo match). `null` when NOT
   * attempted (agent unreachable — the ladder stops at tier 1).
   */
  readonly accepted: boolean | null;
  /** `agent` (routing label) echoed by the ACK, when present. */
  readonly ackAgent?: string;
  /** `instance_id` echoed by the ACK, when present. */
  readonly instanceId?: string;
  /** Why the Accepted tier was not green, when attempted-but-failed. */
  readonly acceptError?: string;
}

/**
 * Accepted = HTTP 200 AND `ack === true` AND the echoed `correlation_token`
 * matches what we sent. The token echo is the load-bearing check — it proves
 * the 200 is a real round-trip of OUR request, not a coincidental success.
 */
export function isAccepted(sentToken: string, ack: DiagnosticAck): boolean {
  return ack.status === 200 && ack.body?.ack === true && ack.body?.correlation_token === sentToken;
}

/** Human-readable reason the Accepted tier failed (used in `--json`/diagnostics). */
export function acceptFailureReason(sentToken: string, ack: DiagnosticAck): string {
  if (ack.error) return ack.error;
  if (ack.status === null) return 'no response';
  if (ack.status !== 200) return `http ${ack.status}`;
  if (ack.body?.ack !== true) return 'ack not true';
  if (ack.body?.correlation_token !== sentToken) return 'correlation_token mismatch';
  return 'unknown';
}

/**
 * Run the two-tier ladder per peer: probe `/health`, then (only if reachable)
 * POST the diagnostic `/notify`. PURE w.r.t. `probe`/`diagnose`/`genToken` —
 * tests inject fakes so nothing hits the network.
 */
export async function gatherFleetDoctor(
  peers: readonly { readonly name: string; readonly info: AgentInfo }[],
  probe: FleetProbeFn,
  diagnose: FleetDiagnosticFn,
  genToken: () => string = randomUUID,
): Promise<readonly FleetDoctorResult[]> {
  const out: FleetDoctorResult[] = [];
  for (const peer of peers) {
    const { host, port } = peer.info;
    const health = await probe(host, port);
    if (health === null) {
      // Tier 1 failed → ladder stops; Accepted is N/A (not attempted).
      out.push({ name: peer.name, host, port, reachable: false, accepted: null });
      continue;
    }
    const token = genToken();
    const ack = await diagnose(host, port, token);
    const accepted = isAccepted(token, ack);
    out.push({
      name: peer.name,
      host,
      port,
      reachable: true,
      accepted,
      ackAgent: ack.body?.agent,
      instanceId: ack.body?.instance_id,
      acceptError: accepted ? undefined : acceptFailureReason(token, ack),
    });
  }
  return out;
}

const HEADERS = ['NAME', 'HOST:PORT', 'REACHABLE', 'ACCEPTED'] as const;

/** ✓ / ✗ for a boolean reachability flag. */
export function reachableGlyph(reachable: boolean): string {
  return reachable ? '✓' : '✗';
}

/** ✓ / ✗ / — for the tri-state Accepted (null = not attempted). */
export function acceptedGlyph(accepted: boolean | null): string {
  if (accepted === null) return '—';
  return accepted ? '✓' : '✗';
}

/** Build one display row per agent (pure — exported for tests). */
export function buildDoctorRows(
  results: readonly FleetDoctorResult[],
): readonly (readonly string[])[] {
  return results.map((r) => [
    r.name,
    `${r.host}:${r.port}`,
    reachableGlyph(r.reachable),
    acceptedGlyph(r.accepted),
  ]);
}

/** Full rendered table (pure — exported for tests). */
export function formatDoctorTable(results: readonly FleetDoctorResult[]): string {
  return formatTable(HEADERS, buildDoctorRows(results));
}

/** Mesh verdict: all-green → HEALTHY, any-fail → DEGRADED, no agents → EMPTY. */
export type MeshVerdict = 'HEALTHY' | 'DEGRADED' | 'EMPTY';

/** Reachable AND Accepted both green. */
function isFullyOk(r: FleetDoctorResult): boolean {
  return r.reachable && r.accepted === true;
}

export function meshVerdict(results: readonly FleetDoctorResult[]): MeshVerdict {
  if (results.length === 0) return 'EMPTY';
  return results.every(isFullyOk) ? 'HEALTHY' : 'DEGRADED';
}

/** `3/4 agents reachable + accepting; mesh interconnect: DEGRADED`. */
export function summaryLine(results: readonly FleetDoctorResult[]): string {
  const total = results.length;
  const ok = results.filter(isFullyOk).length;
  return `${ok}/${total} agents reachable + accepting; mesh interconnect: ${meshVerdict(results)}`;
}

/**
 * The honesty footnote — non-invasive checks prove protocol-to-server ONLY.
 * Kept as a single block so it renders identically in the table output and is
 * carried verbatim in the `--json` `disclaimer` field.
 */
export const HONESTY_LEGEND = [
  'Legend: REACHABLE = mTLS /health answered.  ACCEPTED = diagnostic /notify ACK (HTTP 200 + ack + token echo).',
  'NOTE: these non-invasive checks prove the protocol REACHES THE SERVER (mTLS auth + parse) ONLY —',
  '      NOT delivery to the agent (the MCP-push → agent-reads gap is not exercised). Actual mesh',
  '      delivery needs `macf fleet doctor --inject` (a later DR-030 increment); routing-plane',
  '      delivery needs an e2e run.',
].join('\n');

const HONESTY_DISCLAIMER =
  'Non-invasive checks prove protocol-to-server (mTLS auth + parse) ONLY, NOT delivery to the ' +
  'agent (MCP-push → agent-reads gap). Mesh delivery needs --inject (later increment); ' +
  'routing-plane delivery needs e2e.';

/**
 * Structured `--json` shape for automation. THIS IS THE INPUT CONTRACT the
 * DR-031 watchdog consumes — keep it clean + stable. `accepted` is tri-state
 * (`true`/`false`/`null`); `summary.verdict` is the machine-readable health.
 *
 * `schema_version` is the HARD version contract (DR-006 watchdog request,
 * macf-devops-toolkit#115): a consumer asserts `schema_version === <known>`
 * and refuses an unknown value, so it fails LOUD on ANY breaking change —
 * not just a renamed key (which a presence-check catches) but a same-name
 * SEMANTIC change (e.g. `accepted` going tri-state-bool → string-enum) that
 * would otherwise parse clean and silently misread (the Instance-13-adjacent
 * silent-fallback at the supervisor's own input). BUMP this on any breaking
 * change (rename / removal / semantic shift); additive-optional fields do NOT
 * bump it.
 */
export const FLEET_DOCTOR_JSON_SCHEMA_VERSION = 1;

export function fleetDoctorToJson(
  results: readonly FleetDoctorResult[],
  project?: string,
): unknown {
  return {
    schema_version: FLEET_DOCTOR_JSON_SCHEMA_VERSION,
    project: project ?? null,
    summary: {
      total: results.length,
      reachable: results.filter((r) => r.reachable).length,
      accepting: results.filter(isFullyOk).length,
      verdict: meshVerdict(results),
    },
    agents: results.map((r) => ({
      name: r.name,
      host: r.host,
      port: r.port,
      reachable: r.reachable,
      accepted: r.accepted,
      ack_agent: r.ackAgent ?? null,
      instance_id: r.instanceId ?? null,
      accept_error: r.acceptError ?? null,
    })),
    disclaimer: HONESTY_DISCLAIMER,
  };
}

/**
 * The real mTLS diagnostic POST. Mirrors `pingAgentHealth`'s request shape
 * (same CA + client cert/key, `rejectUnauthorized`, timeout) but POSTs the
 * diagnostic body to `/notify`. Resolves with a `DiagnosticAck` describing the
 * outcome; never throws (failures become `{ status: null, error }`).
 */
export async function postDiagnosticNotify(config: {
  readonly host: string;
  readonly port: number;
  readonly caCertPem: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly correlationToken: string;
  readonly timeoutMs?: number;
}): Promise<DiagnosticAck> {
  const {
    host,
    port,
    caCertPem,
    certPath,
    keyPath,
    correlationToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = config;

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    return { status: null, body: null, error: 'client cert/key missing' };
  }

  const payload = JSON.stringify({
    type: 'mention',
    diagnostic: true,
    correlation_token: correlationToken,
  });

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'POST',
        path: '/notify',
        ca: Buffer.from(caCertPem),
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        rejectUnauthorized: true,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? null;
          let body: DiagnosticAckBody | null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as DiagnosticAckBody;
          } catch {
            body = null;
          }
          resolve({ status, body, error: body ? undefined : 'non-JSON response' });
        });
      },
    );
    req.on('error', (e) => resolve({ status: null, body: null, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: null, body: null, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

/** Options for `runFleetDoctor`. */
export interface RunFleetDoctorOptions {
  /** Emit the structured per-agent result as JSON instead of a table. */
  readonly json?: boolean;
}

/** Injectable seam so tests drive the command without touching the registry/network. */
export interface FleetDoctorDeps {
  readonly listPeers: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  readonly probe: FleetProbeFn;
  readonly diagnose: FleetDiagnosticFn;
  readonly genToken?: () => string;
  readonly project?: string;
}

/** Wire the registry + both mTLS calls from a project's config. */
async function resolveDepsFromRegistry(
  projectDir: string,
): Promise<{ readonly ok: true; readonly deps: FleetDoctorDeps } | { readonly ok: false; readonly code: number }> {
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
      diagnose: (host, port, correlationToken) =>
        postDiagnosticNotify({ host, port, caCertPem, certPath, keyPath, correlationToken }),
    },
  };
}

/**
 * `macf fleet doctor` entry point. Returns the shell exit code — 1 when the
 * mesh is DEGRADED (any agent unreachable or not-accepting), 0 when HEALTHY or
 * when no agents are registered (matching the `macf doctor` "non-zero on
 * problem" convention). The `--json` body still prints to stdout regardless of
 * exit code; the watchdog reads `summary.verdict` from it. `deps` is injected
 * by tests; production resolves it from the project's registry config.
 */
export async function runFleetDoctor(
  projectDir: string,
  opts: RunFleetDoctorOptions = {},
  deps?: FleetDoctorDeps,
): Promise<number> {
  let resolved = deps;
  if (!resolved) {
    const r = await resolveDepsFromRegistry(projectDir);
    if (!r.ok) return r.code;
    resolved = r.deps;
  }

  const peers = await resolved.listPeers();
  const results = await gatherFleetDoctor(peers, resolved.probe, resolved.diagnose, resolved.genToken);

  if (opts.json) {
    console.log(JSON.stringify(fleetDoctorToJson(results, resolved.project), null, 2));
    return meshVerdict(results) === 'DEGRADED' ? 1 : 0;
  }

  const header = `macf fleet doctor${resolved.project ? ` — ${resolved.project}` : ''}`;
  if (results.length === 0) {
    console.log(`${header}\n\nNo agents registered in the registry.`);
    return 0;
  }

  console.log(`${header}\n`);
  console.log(formatDoctorTable(results));
  console.log('');
  console.log(summaryLine(results));
  console.log('');
  console.log(HONESTY_LEGEND);
  return meshVerdict(results) === 'DEGRADED' ? 1 : 0;
}
