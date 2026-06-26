/**
 * `macf routing doctor` — ROUTING-INFRA-layer interconnect check (DR-030 phase-2,
 * macf#568). Sibling to the mesh `macf fleet doctor`.
 *
 * Where `fleet doctor` proves the AGENTS reach EACH OTHER over the mTLS channel
 * mesh, `routing doctor` proves the GitHub *delivery plane that CARRIES them* is
 * wired right. These are STATIC GitHub-plane checks — they prove the routing
 * *plumbing* (caller pins, registry-as-routing-source, certs, repo-set), NOT that
 * a message was actually delivered end-to-end (that is `--e2e`, a LATER increment,
 * NOT built here). The honesty legend states this loudly.
 *
 * The five checks (DR-030 §4, harvested from the 2026-06-26 Stage-3 outage):
 *
 *  1. CALLER-PIN consistency — every fleet repo's `agent-router.yml`
 *     `uses: groundnuty/macf-actions/...@<pin>` is on the SAME version. A mixed
 *     `@v1.3.x` / `@v3.3.0` set = an incomplete cutover — *this would have caught
 *     the outage*. Repo-set source (DR-030 Q3): the App INSTALL-SET, not a new
 *     config file.
 *  2. The #538 split — TWO independent checks per agent:
 *     (a) ROUTABILITY — each routing label has a `MACF_AGENT_<LABEL>` key in the
 *         registry (the router resolves BY LABEL; a bot-name key is silently
 *         unrouteable).
 *     (b) SELF-SKIP correctness — `agent-config.json[label].app_name` is the
 *         bot-LOGIN, not the bare routing label (the #566 root cause:
 *         `repo-init.ts` wrote the agent-name). Independent of (a): a wrong
 *         `app_name` still ROUTES (resolution never touches it) — it breaks the
 *         actor-skip instead.
 *  3. REGISTRATION freshness — `registry.instance_id == /health.instance_id`
 *     (precise current-vs-stale; disambiguates the #553 dying-server race). A
 *     reassigned port surfaces as unreachability; an aged `last_heartbeat` is a
 *     definitive stale (DR-031 `isStaleEntry`).
 *  4. CA material — `MACF_CA_CERT` (a readable VARIABLE) is present AND
 *     base64/PEM-parses (the #563 malformed-base64 class — present ≠ valid).
 *  5. SESSION-name drift — `agent-config.json.tmux_session` follows the canonical
 *     `<project>@<agent>` convention (the silent Stage-2-routing-drop class).
 *
 * Every GitHub read (install-set, caller-pins, agent-config), the registry list,
 * the mTLS `/health` probe, and the CA-var read are INJECTABLE (`RoutingDoctorDeps`)
 * so tests run fully offline. The `gh` shell-outs live in `routing-doctor-gh.ts`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
  isStaleEntry,
  DEFAULT_REGISTRY_TTL_MS,
} from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import { formatTable } from './ps.js';
import {
  createInstallRepoLister,
  createCallerPinReader,
  createRoutingConfigGhReader,
} from './routing-doctor-gh.js';

// --- Shared types (also consumed by routing-doctor-gh.ts) ---

export type CallerPinStatus = 'pinned' | 'no-workflow' | 'error';

/** One repo's caller-pin read. `pinned` ones participate in the consistency verdict. */
export interface CallerPinResult {
  readonly repo: string;
  readonly pin: string | null;
  readonly status: CallerPinStatus;
  readonly error?: string;
}

/** One agent's entry in a repo's `.github/agent-config.json`. */
export interface RoutingConfigEntry {
  readonly app_name?: string;
  readonly tmux_session?: string;
}

/** A repo's `.github/agent-config.json` (the router's per-label config). */
export interface RoutingConfig {
  readonly agents: Readonly<Record<string, RoutingConfigEntry>>;
}

/** Probe a single endpoint's `/health`; null on any failure. Injectable for tests. */
export type RoutingProbeFn = (host: string, port: number) => Promise<HealthResponse | null>;

// --- Pure check primitives ---

/** Normalize a GitHub login for comparison: lowercase, strip `app/` + `[bot]`. */
export function normalizeLogin(s: string): string {
  return s.trim().toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/**
 * The expected fleet caller-pin: an explicit override, else the MODAL (most
 * common) pin among the repos that ARE routing callers. `null` when no repo pins
 * macf-actions (nothing to be consistent about).
 */
export function computeExpectedPin(
  pinned: readonly string[],
  override?: string,
): string | null {
  if (override) return override;
  if (pinned.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of pinned) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = pinned[0]!;
  let bestN = 0;
  for (const [p, n] of counts) {
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/**
 * Self-skip correctness (#538 check b / #566). `app_name` must be the bot-LOGIN.
 * When an authoritative `expectedBotLogin` is known (the running agent's own
 * `github_app.bot_login`, macf#535), compare exactly (normalized). Otherwise fall
 * back to the structural heuristic: the #566 bug is literally `app_name === <bare
 * routing label>`, so flag that — anything else passes (we can't prove the exact
 * bot-login without an authoritative actor source; stated in the legend).
 */
export function evaluateSelfSkip(
  label: string,
  appName: string | undefined,
  expectedBotLogin?: string,
): { readonly ok: boolean; readonly reason?: string } {
  if (!appName || appName.trim() === '') {
    return { ok: false, reason: 'app_name missing' };
  }
  if (expectedBotLogin) {
    return normalizeLogin(appName) === normalizeLogin(expectedBotLogin)
      ? { ok: true }
      : { ok: false, reason: `app_name "${appName}" != bot-login "${expectedBotLogin}"` };
  }
  if (normalizeLogin(appName) === normalizeLogin(label)) {
    return {
      ok: false,
      reason: `app_name "${appName}" is the bare routing label, not a bot-login (#566)`,
    };
  }
  return { ok: true };
}

/**
 * Session-name drift (#? Stage-2 fallback). The CONVENTION check: `tmux_session`
 * must equal `<project>@<label>`. This is a STATIC convention check — it proves the
 * config follows the canonical naming, NOT that it matches the LIVE tmux session
 * (a runtime fact this command can't see). Stated in the legend.
 */
export function evaluateSession(
  label: string,
  tmuxSession: string | undefined,
  project: string,
): { readonly ok: boolean; readonly expected: string; readonly reason?: string } {
  const expected = `${project}@${label}`;
  if (!tmuxSession || tmuxSession.trim() === '') {
    return { ok: false, expected, reason: 'tmux_session missing' };
  }
  if (tmuxSession === expected) return { ok: true, expected };
  return {
    ok: false,
    expected,
    reason: `tmux_session "${tmuxSession}" != "${expected}" (<project>@<agent> convention)`,
  };
}

/** Strict base64: only the base64 alphabet, padded to a multiple of 4. */
export function isStrictBase64(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  if (t.length === 0 || t.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(t);
}

/**
 * CA material check (#563). `MACF_CA_CERT` is a readable VARIABLE; validate it is
 * present AND parses — either as a PEM cert block whose body is strict base64, or
 * as a base64-of-PEM blob that decodes to a cert. A present-but-malformed value
 * (truncated / garbled base64) is the #563 class: present ≠ valid.
 */
export function evaluateCaCert(raw: string | null | undefined): {
  readonly present: boolean;
  readonly valid: boolean;
  readonly reason?: string;
} {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { present: false, valid: false, reason: 'MACF_CA_CERT absent or empty' };
  }
  const text = raw.trim();
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text);
  if (pem) {
    return isStrictBase64(pem[1]!)
      ? { present: true, valid: true }
      : { present: true, valid: false, reason: 'PEM body is not valid base64 (#563 malformed)' };
  }
  // No PEM markers — maybe the whole value is base64-of-PEM (#563 storage form).
  if (isStrictBase64(text)) {
    const decoded = Buffer.from(text, 'base64').toString('utf-8');
    if (/-----BEGIN CERTIFICATE-----/.test(decoded)) return { present: true, valid: true };
    return { present: true, valid: false, reason: 'base64 decodes but is not a certificate' };
  }
  return {
    present: true,
    valid: false,
    reason: 'present but not a parseable PEM/base64 certificate (#563 malformed-base64)',
  };
}

export type FreshnessState = 'fresh' | 'stale' | 'unreachable' | 'unknown' | 'unregistered';

/**
 * Classify a registry entry's freshness against the LIVE `/health`:
 *  - `/health` answers + instance_id MATCHES   → `fresh`.
 *  - `/health` answers + instance_id MISMATCH  → `stale` (registry points at an
 *                                                older instance; a newer one answered).
 *  - `/health` answers but reports no instance_id (older cs) → `unknown`.
 *  - `/health` unreachable + heartbeat aged past TTL (DR-031) → `stale` (definitively
 *                                                dead — ungraceful death).
 *  - `/health` unreachable, heartbeat fresh/absent → `unreachable` (can't confirm;
 *                                                NOT a verdict failure — liveness is
 *                                                `fleet doctor`'s job, not the plane's).
 */
export function classifyFreshness(
  info: AgentInfo,
  health: HealthResponse | null,
  now: number,
  ttlMs: number,
): FreshnessState {
  if (health === null) {
    return isStaleEntry(info, ttlMs, now) ? 'stale' : 'unreachable';
  }
  const hid = health.instance_id ?? null;
  if (!hid) return 'unknown';
  return hid === info.instance_id ? 'fresh' : 'stale';
}

// --- Result model ---

export interface RepoPinRow {
  readonly repo: string;
  readonly pin: string | null;
  readonly status: CallerPinStatus;
  /** `true`/`false` for routing callers; `null` for non-callers (excluded from verdict). */
  readonly consistent: boolean | null;
}

export interface AgentRow {
  readonly label: string;
  readonly appName: string | null;
  readonly tmuxSession: string | null;
  readonly routable: boolean;
  readonly selfSkipOk: boolean;
  readonly selfSkipReason?: string;
  readonly sessionOk: boolean;
  readonly sessionExpected: string;
  readonly sessionReason?: string;
  readonly freshness: FreshnessState;
  readonly registryInstanceId?: string | null;
  readonly healthInstanceId?: string | null;
}

export interface CaCheckResult {
  readonly present: boolean;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface RoutingDoctorReport {
  readonly project: string;
  readonly repoPins: readonly RepoPinRow[];
  readonly expectedPin: string | null;
  readonly hasRoutingConfig: boolean;
  readonly agents: readonly AgentRow[];
  readonly ca: CaCheckResult;
}

// --- Orchestration ---

/** Injectable seam so tests drive the command fully offline. */
export interface RoutingDoctorDeps {
  readonly project: string;
  /** The App install-set (DR-030 Q3 repo-set source). */
  readonly listRepos: () => Promise<readonly string[]>;
  /** Read a repo's macf-actions caller-pin from agent-router.yml. */
  readonly readCallerPin: (repo: string) => Promise<CallerPinResult>;
  /** The CURRENT project's routing config (`.github/agent-config.json`). */
  readonly readRoutingConfig: () => Promise<RoutingConfig | null>;
  /** Registry agents (for routability + freshness). */
  readonly listRegistry: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  /** mTLS `/health` probe (freshness). */
  readonly probe: RoutingProbeFn;
  /** The `MACF_CA_CERT` variable's raw value. */
  readonly readCaCert: () => Promise<string | null>;
  /** Authoritative expected bot-logins by routing label (partial; heuristic fallback). */
  readonly botLogins?: Readonly<Record<string, string>>;
  /** Explicit expected caller-pin (else the modal pin). */
  readonly expectedPin?: string;
  /** Clock for the heartbeat-TTL staleness math (defaults to `Date.now()`). */
  readonly now?: number;
}

/**
 * Run all five checks. PURE w.r.t. the injected deps — tests pass fakes so nothing
 * hits gh / the registry / the network.
 */
export async function gatherRoutingDoctor(deps: RoutingDoctorDeps): Promise<RoutingDoctorReport> {
  const now = deps.now ?? Date.now();

  // 1. Caller-pin sweep across the install-set.
  const repos = await deps.listRepos();
  const pinResults: CallerPinResult[] = [];
  for (const repo of repos) pinResults.push(await deps.readCallerPin(repo));
  const pinnedVals = pinResults.filter((r) => r.status === 'pinned' && r.pin).map((r) => r.pin!);
  const expectedPin = computeExpectedPin(pinnedVals, deps.expectedPin);
  const repoPins: RepoPinRow[] = pinResults.map((r) => ({
    repo: r.repo,
    pin: r.pin,
    status: r.status,
    consistent: r.status === 'pinned' ? r.pin === expectedPin : null,
  }));

  // Registry index (routability + freshness).
  const registry = await deps.listRegistry();
  const registryByName = new Map(registry.map((e) => [e.name, e.info] as const));

  // 2 + 3 + 5. Per-agent checks from the routing config.
  const config = await deps.readRoutingConfig();
  const hasRoutingConfig = config !== null;
  const agents: AgentRow[] = [];
  for (const [label, entry] of Object.entries(config?.agents ?? {})) {
    const regKey = toVariableSegment(label);
    const info = registryByName.get(regKey) ?? null;
    const routable = info !== null;

    const selfSkip = evaluateSelfSkip(label, entry.app_name, deps.botLogins?.[label]);
    const session = evaluateSession(label, entry.tmux_session, deps.project);

    let freshness: FreshnessState = 'unregistered';
    let healthInstanceId: string | null | undefined;
    if (info) {
      const health = await deps.probe(info.host, info.port);
      freshness = classifyFreshness(info, health, now, DEFAULT_REGISTRY_TTL_MS);
      healthInstanceId = health?.instance_id ?? null;
    }

    agents.push({
      label,
      appName: entry.app_name ?? null,
      tmuxSession: entry.tmux_session ?? null,
      routable,
      selfSkipOk: selfSkip.ok,
      selfSkipReason: selfSkip.reason,
      sessionOk: session.ok,
      sessionExpected: session.expected,
      sessionReason: session.reason,
      freshness,
      registryInstanceId: info?.instance_id ?? null,
      healthInstanceId,
    });
  }

  // 4. CA material.
  const ca = evaluateCaCert(await deps.readCaCert());

  return { project: deps.project, repoPins, expectedPin, hasRoutingConfig, agents, ca };
}

// --- Verdict ---

export type RoutingVerdict = 'HEALTHY' | 'DEGRADED' | 'EMPTY';

/** A registry entry's freshness fails the verdict only when definitively `stale`. */
function freshnessFails(s: FreshnessState): boolean {
  return s === 'stale';
}

export function routingVerdict(report: RoutingDoctorReport): RoutingVerdict {
  if (report.repoPins.length === 0 && report.agents.length === 0) return 'EMPTY';
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const pinFail = participating.some((r) => !r.consistent);
  const agentFail = report.agents.some(
    (a) => !a.routable || !a.selfSkipOk || !a.sessionOk || (a.routable && freshnessFails(a.freshness)),
  );
  const caFail = !report.ca.present || !report.ca.valid;
  return pinFail || agentFail || caFail ? 'DEGRADED' : 'HEALTHY';
}

/** `4 fleet repos (pins consistent); 3 agents (2 routing-OK); CA ✓; routing plane: HEALTHY`. */
export function summaryLine(report: RoutingDoctorReport): string {
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const pinsOk = participating.length > 0 && participating.every((r) => r.consistent);
  const agentOk = report.agents.filter(
    (a) => a.routable && a.selfSkipOk && a.sessionOk && !freshnessFails(a.freshness),
  ).length;
  const pinClause =
    participating.length > 0
      ? `${participating.length} routing repo(s) (${pinsOk ? 'pins consistent' : 'PIN DIVERGENCE'})`
      : 'no routing-caller repos discovered';
  return (
    `${pinClause}; ${agentOk}/${report.agents.length} agents routing-OK; ` +
    `CA ${report.ca.valid ? '✓' : '✗'}; routing plane: ${routingVerdict(report)}`
  );
}

// --- Render ---

function boolGlyph(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** ✓ consistent / ✗ divergent / `— n/a` (non-caller). */
export function pinGlyph(consistent: boolean | null): string {
  if (consistent === null) return '— n/a';
  return consistent ? '✓' : '✗';
}

/** Freshness → short glyph: fresh ✓, stale ✗, unreachable/unknown ?, unregistered —. */
export function freshnessGlyph(s: FreshnessState): string {
  switch (s) {
    case 'fresh':
      return '✓';
    case 'stale':
      return '✗ stale';
    case 'unreachable':
      return '? unreach';
    case 'unknown':
      return '? unkn';
    case 'unregistered':
      return '—';
  }
}

const REPO_HEADERS = ['REPO', 'CALLER-PIN', 'CONSISTENT'] as const;
const AGENT_HEADERS = ['AGENT', 'ROUTABLE', 'SELF-SKIP', 'SESSION', 'FRESH'] as const;

export function buildRepoRows(rows: readonly RepoPinRow[]): readonly (readonly string[])[] {
  return rows.map((r) => [r.repo, r.pin ?? (r.status === 'error' ? '(read error)' : '—'), pinGlyph(r.consistent)]);
}

export function buildAgentRows(rows: readonly AgentRow[]): readonly (readonly string[])[] {
  return rows.map((a) => [
    a.label,
    boolGlyph(a.routable),
    boolGlyph(a.selfSkipOk),
    boolGlyph(a.sessionOk),
    freshnessGlyph(a.freshness),
  ]);
}

export function formatRepoTable(rows: readonly RepoPinRow[]): string {
  return formatTable(REPO_HEADERS, buildRepoRows(rows));
}

export function formatAgentTable(rows: readonly AgentRow[]): string {
  return formatTable(AGENT_HEADERS, buildAgentRows(rows));
}

/**
 * The honesty legend — these are STATIC GitHub-plane checks: they prove the
 * routing PLUMBING is wired right, NOT that a message was delivered (that is
 * `--e2e`, a later increment). Carried verbatim in the `--json` `disclaimer`.
 */
export const HONESTY_LEGEND = [
  'Legend: CALLER-PIN = the macf-actions @version each routing repo pins (must all match).',
  '        ROUTABLE = a MACF_AGENT_<LABEL> registry key exists (router resolves by LABEL).',
  '        SELF-SKIP = agent-config.json app_name is the bot-LOGIN, not the bare label (#566).',
  '        SESSION = tmux_session follows the <project>@<agent> convention (a STATIC convention',
  '                  check, NOT a match against the live tmux session).  FRESH = registry',
  '                  instance_id == live /health instance_id (✗ stale / ? unreachable-or-unknown).',
  'NOTE: these are STATIC GitHub-plane checks — they prove the routing PLUMBING is wired right,',
  '      NOT that a message was delivered end-to-end (that is `macf routing doctor --e2e`, a',
  '      later increment). Mesh delivery is `macf fleet doctor`.',
].join('\n');

const HONESTY_DISCLAIMER =
  'Static GitHub-plane checks: they prove the routing plumbing (caller-pins, registry-as-routing-' +
  'source, CA material, session-name convention) is wired right, NOT that a message was delivered ' +
  'end-to-end (that is --e2e, a later increment). Mesh delivery is `macf fleet doctor`.';

// --- JSON contract (DR-031 watchdog input; same hard-version discipline as fleet doctor) ---

/**
 * `schema_version` is the HARD version contract (DR-006 watchdog, devops #118):
 * a consumer asserts `schema_version === <known>` and refuses an unknown value,
 * so ANY breaking change (rename / removal / a same-name SEMANTIC shift) fails
 * LOUD rather than silently misreading. BUMP on any breaking change; additive-
 * optional fields do NOT bump it. Independent from fleet doctor's schema_version
 * (a separate command, a separate contract).
 */
export const ROUTING_DOCTOR_JSON_SCHEMA_VERSION = 1;

export function routingDoctorToJson(report: RoutingDoctorReport): unknown {
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  return {
    schema_version: ROUTING_DOCTOR_JSON_SCHEMA_VERSION,
    project: report.project,
    summary: {
      verdict: routingVerdict(report),
      routing_repos: participating.length,
      pins_consistent: participating.length > 0 && participating.every((r) => r.consistent),
      expected_pin: report.expectedPin,
      agents_total: report.agents.length,
      agents_routing_ok: report.agents.filter(
        (a) => a.routable && a.selfSkipOk && a.sessionOk && !freshnessFails(a.freshness),
      ).length,
      ca_ok: report.ca.present && report.ca.valid,
    },
    caller_pins: report.repoPins.map((r) => ({
      repo: r.repo,
      pin: r.pin,
      status: r.status,
      consistent: r.consistent,
    })),
    agents: report.agents.map((a) => ({
      label: a.label,
      app_name: a.appName,
      tmux_session: a.tmuxSession,
      routable: a.routable,
      self_skip_ok: a.selfSkipOk,
      self_skip_reason: a.selfSkipReason ?? null,
      session_ok: a.sessionOk,
      session_expected: a.sessionExpected,
      session_reason: a.sessionReason ?? null,
      freshness: a.freshness,
      registry_instance_id: a.registryInstanceId ?? null,
      health_instance_id: a.healthInstanceId ?? null,
    })),
    ca_cert: {
      present: report.ca.present,
      valid: report.ca.valid,
      reason: report.ca.reason ?? null,
    },
    disclaimer: HONESTY_DISCLAIMER,
  };
}

// --- Production dep wiring ---

/** Read the CURRENT project repo's `.github/agent-config.json` from disk. */
function readLocalRoutingConfig(projectDir: string): RoutingConfig | null {
  const path = join(projectDir, '.github', 'agent-config.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RoutingConfig;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.agents !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveDepsFromRegistry(
  projectDir: string,
): Promise<{ readonly ok: true; readonly deps: RoutingDoctorDeps } | { readonly ok: false; readonly code: number }> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return { ok: false, code: 1 };
  }
  if (config.registry.type === 'local') {
    console.error('`macf routing doctor` checks the GitHub routing plane; local-registry mode has none.');
    return { ok: false, code: 1 };
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caVarName = `${toVariableSegment(config.project)}_CA_CERT`;
  // Read the CA cert ONCE: it's both the freshness-probe trust anchor AND the
  // subject of the CA-material check. A malformed value just makes the probe fail
  // (→ unreachable), which is itself a correct signal.
  const caCertPem = await client.readVariable(caVarName);
  const certPath = agentCertPath(projectDir);
  const keyPath = agentKeyPath(projectDir);

  // Authoritative bot-login for THIS agent's own routing label (macf#535). Other
  // labels fall back to the #566 bare-label heuristic in evaluateSelfSkip.
  const ownLabel = config.routing_label ?? config.agent_name;
  const ownBotLogin = config.github_app?.bot_login;
  const botLogins = ownBotLogin ? { [ownLabel]: ownBotLogin } : undefined;

  // The GitHub reader fallback for the routing config: prefer the local file (we
  // are usually IN the project repo), else read the current repo via gh.
  const ghRoutingReader = createRoutingConfigGhReader(token);
  const localRouting = readLocalRoutingConfig(projectDir);

  return {
    ok: true,
    deps: {
      project: config.project,
      botLogins,
      listRepos: createInstallRepoLister(token),
      readCallerPin: createCallerPinReader(token),
      readRoutingConfig: async () => localRouting ?? (await ghRoutingReader(detectCurrentRepo(projectDir) ?? '')),
      listRegistry: () => registry.list(''),
      probe: (host, port) => pingAgentHealth({ host, port, caCertPem: caCertPem ?? '', certPath, keyPath }),
      readCaCert: async () => caCertPem,
    },
  };
}

/** Best-effort `owner/repo` from the project's git remote (for the gh routing-config fallback). */
function detectCurrentRepo(projectDir: string): string | null {
  try {
    const path = join(projectDir, '.git', 'config');
    if (!existsSync(path)) return null;
    const m = /github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?/.exec(readFileSync(path, 'utf-8'));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface RunRoutingDoctorOptions {
  readonly json?: boolean;
  /** Explicit expected caller-pin (else the modal pin across the fleet). */
  readonly expectedPin?: string;
}

/**
 * `macf routing doctor` entry point. Returns the shell exit code — 1 when the
 * routing plane is DEGRADED, 0 when HEALTHY or EMPTY (matching `fleet doctor` /
 * `macf doctor` "non-zero on problem"). The `--json` body prints regardless; the
 * watchdog reads `summary.verdict`. `deps` is injected by tests.
 */
export async function runRoutingDoctor(
  projectDir: string,
  opts: RunRoutingDoctorOptions = {},
  deps?: RoutingDoctorDeps,
): Promise<number> {
  let resolved = deps;
  if (!resolved) {
    const r = await resolveDepsFromRegistry(projectDir);
    if (!r.ok) return r.code;
    resolved = r.deps;
  }
  if (opts.expectedPin && !resolved.expectedPin) {
    resolved = { ...resolved, expectedPin: opts.expectedPin };
  }

  const report = await gatherRoutingDoctor(resolved);
  const verdict = routingVerdict(report);

  if (opts.json) {
    console.log(JSON.stringify(routingDoctorToJson(report), null, 2));
    return verdict === 'DEGRADED' ? 1 : 0;
  }

  const header = `macf routing doctor — ${report.project}`;
  if (verdict === 'EMPTY') {
    console.log(`${header}\n\nNo fleet repos discovered and no routing config agents. Nothing to check.`);
    if (!report.ca.present) console.log('Note: MACF_CA_CERT not found in the registry.');
    return 0;
  }

  console.log(`${header}\n`);

  if (report.repoPins.length > 0) {
    console.log('Caller-pin consistency (App install-set):');
    console.log(formatRepoTable(report.repoPins));
    if (report.expectedPin) console.log(`Expected pin (modal): ${report.expectedPin}`);
    console.log('');
  } else {
    console.log('Caller-pin consistency: no fleet repos discovered (App install-set unavailable).\n');
  }

  if (report.hasRoutingConfig) {
    console.log('Per-agent routing checks (current project routing config):');
    console.log(formatAgentTable(report.agents));
    console.log('');
  } else {
    console.log('Per-agent routing checks: no .github/agent-config.json found for this project.\n');
  }

  console.log(
    `MACF_CA_CERT: ${report.ca.present ? (report.ca.valid ? '✓ present + parses' : `✗ ${report.ca.reason}`) : '✗ absent'}`,
  );
  console.log('');
  console.log(summaryLine(report));
  console.log('');
  console.log(HONESTY_LEGEND);

  return verdict === 'DEGRADED' ? 1 : 0;
}
