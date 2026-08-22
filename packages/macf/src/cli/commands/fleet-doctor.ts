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
 * HONESTY (DR-030 §3, rendered LOUDLY in the output legend): the default NON-
 * invasive checks prove the protocol REACHES THE SERVER (mTLS auth + body parse)
 * ONLY — they do NOT prove DELIVERY TO THE AGENT (the MCP-push → agent-reads gap
 * is not exercised). Real deliver→process proof needs `--inject` (the INVASIVE
 * Processed-now tier in this file — routes a real marker-bearing prompt + wakes
 * each agent + matches the echoed run_id off `/health.last_processed`);
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
import { join, resolve as resolvePath } from 'node:path';
import {
  readAgentConfig,
  tokenSourceFromConfig,
  agentCertPath,
  agentKeyPath,
  findProjectRoot,
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
import { discoverWorkspaces } from '../discovery.js';
import {
  detectRoutingLabelDriftFromManifestFile,
  hasRoutingLabelDrift,
} from '../bootstrap/routing-label-drift.js';
import type { RoutingLabelDriftEntry } from '../bootstrap/routing-label-drift.js';
import {
  postInjectNotify,
  pollLastProcessedToken,
} from './fleet-doctor-inject.js';
import type {
  FleetInjectPostFn,
  FleetInjectPollFn,
} from './fleet-doctor-inject.js';

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

// --- Processed-now inject tier (DR-030 §3, macf#568 final increment) ---
//
// THE INVASIVE delivery-proof. Unlike the non-invasive Reachable/Accepted tiers
// (which short-circuit at the server's receive path), `--inject` routes a REAL
// `/notify` `mention` whose `message` carries a `[macf-route:<run_id>:<agent>]`
// correlation marker. `formatNotifyContent` surfaces the `mention` message
// VERBATIM into the content that is BOTH MCP-pushed AND fed to `wakeViaTmux`
// (server.ts) as the prompt the agent's TUI submits as its next turn — so the
// `emit-turn-receipt.sh` UserPromptSubmit hook extracts the marker, appends a
// `{ts, run_id, agent}` local receipt, and the agent's own
// `/health.last_processed.correlation_token` (= the receipt's `run_id`, per
// comms-ledger `mapReceiptToLastProcessed`) echoes our `run_id` back. Matching
// it proves the FULL chain: deliver → MCP push → agent reads it as a TURN →
// local receipt → /health surfaces it. A timeout means processing UNCONFIRMED
// (a busy agent mid-long-turn legitimately won't process the probe in the
// window) — NOT "deaf". This is the IDLE-agent fallback; prefer the passive
// `last_processed` self-report for a busy/active agent.
//
// The mTLS POST + /health-poll I/O lives in `fleet-doctor-inject.ts` (leaf
// module); the orchestration + render stays here.

/** Tuning + injectable seams for the Processed-now inject tier. */
export interface FleetInjectConfig {
  readonly post: FleetInjectPostFn;
  readonly poll: FleetInjectPollFn;
  /** Generate a unique DIGITS-ONLY run id (marker regex requires `[0-9]+`). */
  readonly genRunId?: () => string;
  /** How many times to poll `/health` after the POST (default 7). */
  readonly maxPolls?: number;
  /** Delay between polls, ms (default 4000 → ~24s total at 7 polls). */
  readonly pollIntervalMs?: number;
  /** Injectable delay (tests pass a no-op for instant, deterministic runs). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INJECT_MAX_POLLS = 7;
const DEFAULT_INJECT_POLL_INTERVAL_MS = 4000;

/** Default digits-only run id: epoch-ms + 6 random digits → unique, `[0-9]+`. */
export function defaultRunId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Sanitize a registry name into a marker-legal agent slug. The
 * `emit-turn-receipt.sh` grep is `\[macf-route:[0-9]+:[a-z0-9-]+\]`, so an
 * UNsanitized label with an underscore/uppercase would fail the whole-marker
 * match → no receipt written → a false UNCONFIRMED. Lowercase + map any
 * out-of-class char to `-`; fall back to `agent` if the result is empty.
 */
export function sanitizeMarkerAgent(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug === '' ? 'agent' : slug;
}

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
  /**
   * Processed-now (`--inject`) tier — TRI-STATE, and ONLY populated when
   * `--inject` runs against a REACHABLE agent:
   *   - `true`  → the probe's `run_id` echoed back via `/health.last_processed`
   *               within the poll window (full deliver→process chain proven).
   *   - `false` → UNCONFIRMED: delivered but the echo didn't appear in the
   *               window (a busy agent legitimately may not process in time —
   *               NOT proof of a gap), OR the inject POST itself wasn't delivered.
   *   - `null`  → NOT attempted (agent unreachable, or `--inject` not passed).
   */
  readonly processedInject?: boolean | null;
  /** The marker `run_id` routed for this agent (diagnostics; inject mode only). */
  readonly injectRunId?: string;
  /** Why Processed was not green (unconfirmed within window / POST not delivered). */
  readonly injectError?: string;
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
 * Run the Processed-now (`--inject`) tier for ONE reachable agent: route a real
 * marker-bearing mention, then poll `/health.last_processed.correlation_token`
 * for our `run_id`. Returns the tri-state outcome + diagnostics. PURE w.r.t.
 * `inject.post`/`inject.poll`/`inject.sleep` — tests inject fakes (and a no-op
 * sleep) so nothing hits the network and there are no real waits.
 */
export async function runProcessedInject(
  peer: { readonly name: string; readonly info: AgentInfo },
  ackAgent: string | undefined,
  inject: FleetInjectConfig,
): Promise<{ readonly processedInject: boolean; readonly injectRunId: string; readonly injectError?: string }> {
  const { host, port } = peer.info;
  const runId = (inject.genRunId ?? defaultRunId)();
  const markerAgent = sanitizeMarkerAgent(ackAgent ?? peer.name);

  const post = await inject.post(host, port, runId, markerAgent);
  if (!post.delivered) {
    return { processedInject: false, injectRunId: runId, injectError: post.error ?? 'inject POST not delivered' };
  }

  const maxPolls = inject.maxPolls ?? DEFAULT_INJECT_MAX_POLLS;
  const intervalMs = inject.pollIntervalMs ?? DEFAULT_INJECT_POLL_INTERVAL_MS;
  const sleep = inject.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < maxPolls; i++) {
    const token = await inject.poll(host, port);
    if (token === runId) return { processedInject: true, injectRunId: runId };
    if (i < maxPolls - 1) await sleep(intervalMs);
  }
  return {
    processedInject: false,
    injectRunId: runId,
    injectError: `processing unconfirmed within ~${Math.round(((maxPolls - 1) * intervalMs) / 1000)}s`,
  };
}

/**
 * Run the ladder per peer: probe `/health`, then (only if reachable) POST the
 * diagnostic `/notify`. When `inject` is supplied (`--inject`), ALSO run the
 * INVASIVE Processed-now tier on each reachable agent (routes a real prompt +
 * wakes the agent). PURE w.r.t. `probe`/`diagnose`/`genToken`/`inject` — tests
 * inject fakes so nothing hits the network.
 */
export async function gatherFleetDoctor(
  peers: readonly { readonly name: string; readonly info: AgentInfo }[],
  probe: FleetProbeFn,
  diagnose: FleetDiagnosticFn,
  genToken: () => string = randomUUID,
  inject?: FleetInjectConfig,
): Promise<readonly FleetDoctorResult[]> {
  const out: FleetDoctorResult[] = [];
  for (const peer of peers) {
    const { host, port } = peer.info;
    const health = await probe(host, port);
    if (health === null) {
      // Tier 1 failed → ladder stops; Accepted + Processed are N/A (not attempted).
      out.push({
        name: peer.name,
        host,
        port,
        reachable: false,
        accepted: null,
        processedInject: inject ? null : undefined,
      });
      continue;
    }
    const token = genToken();
    const ack = await diagnose(host, port, token);
    const accepted = isAccepted(token, ack);
    const ackAgent = ack.body?.agent;
    const proc = inject ? await runProcessedInject(peer, ackAgent, inject) : undefined;
    out.push({
      name: peer.name,
      host,
      port,
      reachable: true,
      accepted,
      ackAgent,
      instanceId: ack.body?.instance_id,
      acceptError: accepted ? undefined : acceptFailureReason(token, ack),
      processedInject: proc ? proc.processedInject : undefined,
      injectRunId: proc?.injectRunId,
      injectError: proc?.injectError,
    });
  }
  return out;
}

const HEADERS = ['NAME', 'HOST:PORT', 'REACHABLE', 'ACCEPTED'] as const;
const HEADERS_INJECT = [...HEADERS, 'PROCESSED'] as const;

/** ✓ / ✗ for a boolean reachability flag. */
export function reachableGlyph(reachable: boolean): string {
  return reachable ? '✓' : '✗';
}

/** ✓ / ✗ / — for the tri-state Accepted (null = not attempted). */
export function acceptedGlyph(accepted: boolean | null): string {
  if (accepted === null) return '—';
  return accepted ? '✓' : '✗';
}

/**
 * Processed glyph (inject tier). ✓ = run_id echoed (processed end-to-end);
 * `?` = UNCONFIRMED within the window (delivered but not echoed — possibly a
 * busy agent, NOT necessarily a gap — deliberately NOT `✗`); `—` = not
 * attempted (unreachable / inject off).
 */
export function processedGlyph(processed: boolean | null | undefined): string {
  if (processed === true) return '✓';
  if (processed === false) return '?';
  return '—';
}

/**
 * Build one display row per agent (pure — exported for tests). When `inject`
 * is true, append the PROCESSED column.
 */
export function buildDoctorRows(
  results: readonly FleetDoctorResult[],
  inject = false,
): readonly (readonly string[])[] {
  return results.map((r) => {
    const base = [r.name, `${r.host}:${r.port}`, reachableGlyph(r.reachable), acceptedGlyph(r.accepted)];
    return inject ? [...base, processedGlyph(r.processedInject)] : base;
  });
}

/** Full rendered table (pure — exported for tests). */
export function formatDoctorTable(results: readonly FleetDoctorResult[], inject = false): string {
  return formatTable(inject ? HEADERS_INJECT : HEADERS, buildDoctorRows(results, inject));
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
  '      delivery needs `macf fleet doctor --inject` (INVASIVE — wakes each agent); routing-plane',
  '      delivery needs an e2e run.',
].join('\n');

const HONESTY_DISCLAIMER =
  'Non-invasive checks prove protocol-to-server (mTLS auth + parse) ONLY, NOT delivery to the ' +
  'agent (MCP-push → agent-reads gap). Mesh delivery needs --inject (later increment); ' +
  'routing-plane delivery needs e2e.';

/**
 * The `--inject` Processed-tier legend. INVASIVE: it routes a real probe to each
 * reachable agent + costs it a turn. A `?` (UNCONFIRMED) is NOT "deaf" — a busy
 * agent mid-long-turn legitimately won't process the probe within the window.
 */
export const INJECT_LEGEND = [
  'Legend (--inject): PROCESSED ✓ = the probe run_id echoed back via /health.last_processed —',
  '      the FULL chain proven (deliver → MCP push → agent read it as a TURN → local turn-receipt',
  '      → /health surfaced it).  ? = UNCONFIRMED within the window (delivered, but no echo yet —',
  '      a busy agent mid-long-turn legitimately may not have processed it; NOT proof of a gap).',
  '      — = not attempted (agent unreachable).',
  'INVASIVE: --inject routes a REAL /notify to each reachable agent, WAKING each + costing it a turn.',
  '      It is the IDLE-agent fallback; for a busy/active agent prefer the passive last_processed self-report.',
].join('\n');

/** `2/3 reachable agents processed an injected probe (1 unconfirmed — possibly busy)`. */
export function injectSummaryLine(results: readonly FleetDoctorResult[]): string {
  const attempted = results.filter((r) => r.processedInject !== null && r.processedInject !== undefined);
  const processed = attempted.filter((r) => r.processedInject === true).length;
  const unconfirmed = attempted.length - processed;
  const tail = unconfirmed > 0 ? ` (${unconfirmed} unconfirmed — possibly busy, NOT necessarily a gap)` : '';
  return `${processed}/${attempted.length} reachable agents processed an injected probe${tail}`;
}

/** Count of reachable agents an `--inject` run will WAKE (for the up-front warning). */
export function injectableCount(results: readonly FleetDoctorResult[]): number {
  return results.filter((r) => r.reachable).length;
}

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

/**
 * `--inject` ADDS `processed_inject` (+ `inject_run_id` / `inject_error` /
 * top-level `inject`) WITHOUT a `schema_version` bump. Per the documented policy
 * above, additive-OPTIONAL fields do NOT bump the version (a bump is reserved
 * for rename / removal / a same-name SEMANTIC shift). `processed_inject` is
 * present ONLY when `--inject` ran (`opts.inject`); a watchdog that pins
 * `schema_version === 1` keeps parsing clean and simply ignores the new key —
 * exactly the additive-tolerance the version contract is built for.
 */
export function fleetDoctorToJson(
  results: readonly FleetDoctorResult[],
  project?: string,
  opts: { readonly inject?: boolean; readonly routingLabelDrift?: RoutingLabelDriftCheck } = {},
): unknown {
  return {
    schema_version: FLEET_DOCTOR_JSON_SCHEMA_VERSION,
    project: project ?? null,
    ...(opts.inject
      ? {
          // Surfaced ONLY in inject mode so a consumer never misreads a
          // mode-off run as "0 processed". Loudly flags the invasive nature.
          inject: {
            invasive: true,
            woke: injectableCount(results),
            processed: results.filter((r) => r.processedInject === true).length,
          },
        }
      : {}),
    // Additive-optional (no schema bump — same policy as `inject` above):
    // present ONLY when `--manifest` was given (macf#1059). `ok: false`
    // surfaces a manifest that couldn't be loaded/parsed; `ok: true` carries
    // one entry PER manifest agent, never collapsed into a single verdict.
    ...(opts.routingLabelDrift
      ? {
          routing_label_drift: opts.routingLabelDrift.ok
            ? {
                manifest: opts.routingLabelDrift.manifestPath,
                agents: opts.routingLabelDrift.entries.map((e) => ({
                  role: e.role,
                  status: e.status,
                  recorded_label: e.recordedLabel,
                  config_source: e.configSource,
                  reason: e.reason ?? null,
                })),
              }
            : { manifest: opts.routingLabelDrift.manifestPath, error: opts.routingLabelDrift.error },
        }
      : {}),
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
      // Additive-optional (no schema bump): tri-state true/false/null, present
      // only under --inject. null = not attempted (unreachable).
      ...(opts.inject
        ? {
            processed_inject: r.processedInject ?? null,
            inject_run_id: r.injectRunId ?? null,
            inject_error: r.injectError ?? null,
          }
        : {}),
    })),
    disclaimer: HONESTY_DISCLAIMER,
  };
}

/**
 * The result of the OPTIONAL `--manifest`-gated routing-label-drift check
 * (macf#1059). Absent the flag entirely (no `manifest` option given), this
 * check never runs — `runFleetDoctor` never reaches for a `fleet.yaml` on
 * its own. `ok: false` covers a bad path / malformed manifest — an optional,
 * additive check must not crash the surrounding `fleet doctor` run just
 * because the operator-supplied manifest path was wrong.
 */
export type RoutingLabelDriftCheck =
  | { readonly ok: true; readonly manifestPath: string; readonly entries: readonly RoutingLabelDriftEntry[] }
  | { readonly ok: false; readonly manifestPath: string; readonly error: string };

/**
 * Run the manifest-vs-workspace routing-label drift check when a manifest
 * path is given (`--manifest`). Never throws: `detectRoutingLabelDriftFromManifestFile`
 * can throw on a malformed `fleet.yaml` (mirrors `parseFleetManifest`'s own
 * contract) — caught here into `{ ok: false }` so a bad path degrades this
 * ONE optional section, not the whole `fleet doctor` run.
 */
function runRoutingLabelDriftCheck(manifestPath: string | undefined): RoutingLabelDriftCheck | undefined {
  if (!manifestPath) return undefined;
  try {
    const entries = detectRoutingLabelDriftFromManifestFile(manifestPath, {
      readManifestText: (p) => readFileSync(p, 'utf-8'),
      discover: discoverWorkspaces,
      readConfig: readAgentConfig,
    });
    return { ok: true, manifestPath, entries };
  } catch (err) {
    return { ok: false, manifestPath, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `true` when the drift check ran (`--manifest` given) and EITHER found real
 * drift OR failed to run at all — both fold into `fleet doctor`'s non-zero
 * exit convention (see `runFleetDoctor`'s doc): an operator who asked for the
 * check gets a non-zero exit for "the check found a problem" AND for "the
 * check itself couldn't run", never a silent 0 for either.
 */
function routingLabelDriftIsBad(check: RoutingLabelDriftCheck | undefined): boolean {
  if (!check) return false;
  return !check.ok || hasRoutingLabelDrift(check.entries);
}

/** Plain-text rendering of {@link RoutingLabelDriftCheck} for the interactive `fleet doctor` output. */
function formatRoutingLabelDriftSection(check: RoutingLabelDriftCheck): string {
  if (!check.ok) {
    return `Routing-label drift check FAILED for manifest "${check.manifestPath}": ${check.error}`;
  }
  const lines = [`Routing-label drift vs manifest "${check.manifestPath}":`];
  for (const entry of check.entries) {
    const glyph = entry.status === 'clean' ? '✓' : entry.status === 'drift' ? '✗' : '?';
    const detail = entry.status === 'clean' ? `label "${entry.recordedLabel ?? ''}" matches` : (entry.reason ?? entry.status);
    lines.push(`  ${glyph} ${entry.role}: ${detail}`);
  }
  return lines.join('\n');
}

/**
 * A structured failure for a non-interactive `--json` consumer (macf#830 —
 * scheduler-safety: a cron reconciler / CI probe must be able to distinguish
 * "the CLI failed" from "empty result / healthy quiet fleet"). `code` is a
 * stable machine-matchable string; `message` is the SAME text also sent to
 * stderr, so the interactive + `--json` surfaces never disagree.
 */
export interface FleetDoctorFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The `--json` failure envelope. Carries the SAME `schema_version` as the
 * success shape (`fleetDoctorToJson`) — `error` is an ADDITIVE field, not a
 * breaking change to the existing contract (macf#830 AC4): a watchdog that
 * only reads `summary.verdict` on success is unaffected; one that wants to
 * distinguish "CLI failed" from "0 agents" checks for `error` first.
 */
export function fleetDoctorFailureToJson(failure: FleetDoctorFailure): unknown {
  return {
    schema_version: FLEET_DOCTOR_JSON_SCHEMA_VERSION,
    error: failure,
  };
}

/**
 * Resolve the project directory for `macf fleet doctor` WITHOUT requiring the
 * caller to be cd'd into a MACF project (macf#830). A cron reconciler / CI
 * probe's cwd is typically unrelated to any project (e.g. `$HOME`) — the prior
 * behavior walked up from cwd unconditionally and, on failure, called
 * `process.exit(1)` directly from the CLI-wiring layer BEFORE `--json` was
 * even consulted, producing empty stdout for a JSON consumer.
 *
 * `--dir <path>` (already wired to every other `fleet` subcommand — the
 * established cwd-independence flag in this CLI, see `index.ts`'s
 * `resolveProjectDir`) wins when given and is validated directly (no
 * walk-up, matching the prior `validateProjectDir` semantics exactly). When
 * absent, walks up from `cwd` — the prior interactive default, UNCHANGED.
 *
 * Pure + never exits the process — returns a `FleetDoctorFailure` on failure
 * so `runFleetDoctor` can render it consistently under `--json` (a valid,
 * non-empty JSON error object) or plain-text (stderr only, matching the
 * pre-#830 message).
 */
export function resolveFleetDoctorProjectDir(
  dirOpt: string | undefined,
  cwd: string = process.cwd(),
): { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly failure: FleetDoctorFailure } {
  if (dirOpt) {
    const abs = resolvePath(dirOpt);
    if (!existsSync(join(abs, '.macf', 'macf-agent.json'))) {
      return {
        ok: false,
        failure: {
          code: 'not_a_macf_project',
          message: `Not a MACF project: ${abs} has no .macf/macf-agent.json`,
        },
      };
    }
    return { ok: true, dir: abs };
  }
  const found = findProjectRoot(cwd);
  if (!found) {
    return {
      ok: false,
      failure: {
        code: 'not_in_macf_project',
        message:
          'Not in a MACF project (no .macf/macf-agent.json found walking up from cwd). ' +
          'Pass --dir <path>, or cd into a project.',
      },
    };
  }
  return { ok: true, dir: found };
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
  /** Run the INVASIVE Processed-now tier — routes a real probe + wakes each agent. */
  readonly inject?: boolean;
  /** Inject poll budget (seconds) → derives maxPolls at a fixed ~4s interval. */
  readonly injectTimeoutSec?: number;
  /**
   * Optional `fleet.yaml` path (macf#1059). When given, ALSO reports
   * manifest-role vs config-`routing_label` drift for every agent the
   * manifest declares, resolved against workspaces discovered on THIS host
   * (`discoverWorkspaces()`). Omitted by default — the check never runs
   * uninvited, and it is independent of the registry-based mesh check above
   * (no manifest needed for REACHABLE/ACCEPTED).
   */
  readonly manifest?: string;
}

/** Injectable seam so tests drive the command without touching the registry/network. */
export interface FleetDoctorDeps {
  readonly listPeers: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  readonly probe: FleetProbeFn;
  readonly diagnose: FleetDiagnosticFn;
  readonly genToken?: () => string;
  readonly project?: string;
  /** Inject-tier POST (only used under `--inject`). Wired by resolveDeps; faked in tests. */
  readonly injectPost?: FleetInjectPostFn;
  /** Inject-tier `/health` poll (only used under `--inject`). Wired by resolveDeps; faked in tests. */
  readonly injectPoll?: FleetInjectPollFn;
  /** Inject run-id generator + sleep override (tests pass deterministic fakes). */
  readonly injectGenRunId?: () => string;
  readonly injectSleep?: (ms: number) => Promise<void>;
  /**
   * Override for the `--manifest`-gated routing-label-drift check (macf#1059).
   * Production leaves this unset — `runFleetDoctor` falls back to the real
   * {@link runRoutingLabelDriftCheck} (real fs + `discoverWorkspaces()`).
   * Tests inject a fake so the drift check can be exercised without touching
   * a real filesystem, same seam shape as `injectPost`/`injectPoll` above.
   */
  readonly routingLabelDriftCheck?: (manifestPath: string | undefined) => RoutingLabelDriftCheck | undefined;
}

/**
 * Wire the registry + both mTLS calls from a project's config. `dirOpt` is the
 * RAW `--dir` flag value (possibly `undefined`) — resolution (explicit `--dir`
 * vs cwd walk-up) happens here via `resolveFleetDoctorProjectDir` (macf#830),
 * so every failure path — unresolvable project dir, missing config, missing
 * CA cert — returns the SAME `FleetDoctorFailure` shape for `runFleetDoctor`
 * to render consistently under `--json` or plain-text.
 */
async function resolveDepsFromRegistry(
  dirOpt: string | undefined,
): Promise<
  | { readonly ok: true; readonly deps: FleetDoctorDeps }
  | { readonly ok: false; readonly code: number; readonly failure: FleetDoctorFailure }
> {
  const dirResult = resolveFleetDoctorProjectDir(dirOpt);
  if (!dirResult.ok) {
    console.error(dirResult.failure.message);
    return { ok: false, code: 1, failure: dirResult.failure };
  }
  const projectDir = dirResult.dir;

  const config = readAgentConfig(projectDir);
  if (!config) {
    const failure: FleetDoctorFailure = {
      code: 'no_agent_config',
      message: 'No macf-agent.json found. Run `macf init` first.',
    };
    console.error(failure.message);
    return { ok: false, code: 1, failure };
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caCertPem = await client.readVariable(`${toVariableSegment(config.project)}_CA_CERT`);
  if (!caCertPem) {
    const failure: FleetDoctorFailure = {
      code: 'no_ca_cert',
      message: 'CA certificate not found in registry. Run `macf certs init` first.',
    };
    console.error(failure.message);
    return { ok: false, code: 1, failure };
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
      injectPost: (host, port, runId, markerAgent) =>
        postInjectNotify({ host, port, caCertPem, certPath, keyPath, runId, markerAgent }),
      injectPoll: (host, port) => pollLastProcessedToken({ host, port, caCertPem, certPath, keyPath }),
    },
  };
}

/**
 * Build the `FleetInjectConfig` from deps + options when `--inject` is on.
 * Returns `undefined` when inject is off OR the deps lack the inject seams
 * (defensive — production always wires them). A `~4s` poll interval; the
 * timeout-seconds budget derives `maxPolls`.
 */
function buildInjectConfig(
  deps: FleetDoctorDeps,
  opts: RunFleetDoctorOptions,
): FleetInjectConfig | undefined {
  if (!opts.inject) return undefined;
  if (!deps.injectPost || !deps.injectPoll) return undefined;
  const intervalMs = DEFAULT_INJECT_POLL_INTERVAL_MS;
  const budgetSec = opts.injectTimeoutSec ?? 24;
  // maxPolls so that (maxPolls-1)*interval ≈ budget; floor at 2 polls.
  const maxPolls = Math.max(2, Math.round((budgetSec * 1000) / intervalMs) + 1);
  return {
    post: deps.injectPost,
    poll: deps.injectPoll,
    genRunId: deps.injectGenRunId,
    sleep: deps.injectSleep,
    maxPolls,
    pollIntervalMs: intervalMs,
  };
}

/**
 * `macf fleet doctor` entry point. Returns the shell exit code — 1 when the
 * mesh is DEGRADED (any agent unreachable or not-accepting) OR when the run
 * FAILED before a verdict could be computed (unresolvable project dir,
 * missing config, missing CA cert, an unexpected probe/registry error — see
 * macf#830), 0 when HEALTHY or when no agents are registered (matching the
 * `macf doctor` "non-zero on problem" convention).
 *
 * `dirOpt` is the RAW `--dir` flag value (possibly `undefined` — resolved via
 * `resolveFleetDoctorProjectDir`, macf#830: explicit `--dir` wins, else walks
 * up from cwd exactly like the interactive default). This function NEVER
 * exits the process directly — every failure path returns a `FleetDoctorFailure`-
 * shaped outcome so a `--json` consumer (a cron reconciler / CI probe) always
 * gets a valid, non-empty, `jq`-parseable JSON object on stdout PLUS a nonzero
 * exit code — never empty-stdout+exit-0, and never empty-stdout+exit-nonzero
 * either. Plain-text mode is UNCHANGED: the failure message goes to stderr
 * only, same as before #830.
 *
 * `deps` is injected by tests; production resolves it from the project's
 * registry config via `resolveDepsFromRegistry`.
 */
export async function runFleetDoctor(
  dirOpt: string | undefined,
  opts: RunFleetDoctorOptions = {},
  deps?: FleetDoctorDeps,
): Promise<number> {
  try {
    let resolved = deps;
    if (!resolved) {
      const r = await resolveDepsFromRegistry(dirOpt);
      if (!r.ok) {
        // macf#830: never empty stdout under --json, even on the earliest
        // failure path (project-dir resolution never even reaches a registry).
        if (opts.json) {
          console.log(JSON.stringify(fleetDoctorFailureToJson(r.failure), null, 2));
        }
        return r.code;
      }
      resolved = r.deps;
    }

    const inject = buildInjectConfig(resolved, opts);
    const peers = await resolved.listPeers();

    // Loud up-front INVASIVE warning (DR-030 §3) to stderr BEFORE we route any
    // real probe. Skipped under --json (machine consumer) + when no agents exist.
    // The exact reachable count is reported post-gather (we'd otherwise double-
    // probe every agent just to count).
    if (inject && !opts.json && peers.length > 0) {
      console.error(
        `⚠️  --inject is INVASIVE: it routes a REAL /notify to each REACHABLE agent ` +
          `(up to ${String(peers.length)} registered), WAKING it + costing it a turn. ` +
          `IDLE-agent fallback — prefer the passive last_processed self-report for a busy agent.`,
      );
    }

    const results = await gatherFleetDoctor(peers, resolved.probe, resolved.diagnose, resolved.genToken, inject);

    // Independent of the registry-based mesh check above — a host-filesystem
    // scan against a manifest, not a registry query (macf#1059). Runs (and
    // can fail the exit code) even when zero peers are registered, so it is
    // computed BEFORE the "no agents registered" early-return below.
    const routingLabelDrift = (resolved.routingLabelDriftCheck ?? runRoutingLabelDriftCheck)(opts.manifest);
    const exitCode = (): number =>
      meshVerdict(results) === 'DEGRADED' || routingLabelDriftIsBad(routingLabelDrift) ? 1 : 0;

    if (opts.json) {
      console.log(
        JSON.stringify(fleetDoctorToJson(results, resolved.project, { inject: !!inject, routingLabelDrift }), null, 2),
      );
      return exitCode();
    }

    const header = `macf fleet doctor${resolved.project ? ` — ${resolved.project}` : ''}`;
    if (results.length === 0) {
      console.log(`${header}\n\nNo agents registered in the registry.`);
      if (routingLabelDrift) {
        console.log('');
        console.log(formatRoutingLabelDriftSection(routingLabelDrift));
      }
      return exitCode();
    }

    console.log(`${header}\n`);
    console.log(formatDoctorTable(results, !!inject));
    console.log('');
    console.log(summaryLine(results));
    if (inject) {
      console.log(
        `--inject routed a REAL probe to ${String(injectableCount(results))} reachable agent(s), waking each.`,
      );
      console.log(injectSummaryLine(results));
    }
    console.log('');
    console.log(HONESTY_LEGEND);
    if (inject) {
      console.log('');
      console.log(INJECT_LEGEND);
    }
    if (routingLabelDrift) {
      console.log('');
      console.log(formatRoutingLabelDriftSection(routingLabelDrift));
    }
    // The Processed tier does NOT fold into the verdict/exit code: an UNCONFIRMED
    // is "possibly busy," not "broken." Exit stays driven by Reachable+Accepted
    // (+ the routing-label drift check, when --manifest was given).
    return exitCode();
  } catch (err) {
    // Belt-and-braces (macf#830 AC2, "probe error" / "unresolvable registry"):
    // any throw we didn't anticipate (a rejected listPeers/probe call, a
    // registry-client construction failure, etc.) still must not leave a
    // --json consumer with empty stdout. Plain-text mode gets the message on
    // stderr only, matching every other failure path's behavior above.
    const failure: FleetDoctorFailure = {
      code: 'unexpected_error',
      message: err instanceof Error ? err.message : String(err),
    };
    console.error(`macf fleet doctor: ${failure.message}`);
    if (opts.json) {
      console.log(JSON.stringify(fleetDoctorFailureToJson(failure), null, 2));
    }
    return 1;
  }
}
