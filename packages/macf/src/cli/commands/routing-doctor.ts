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
 * The checks (DR-030 §4, harvested from the 2026-06-26 Stage-3 outage; #6 added
 * per macf#800):
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
 *     `<project>@<routing-label>` convention (the silent Stage-2-routing-drop class).
 *     Vestigial + omitted on v3+ (macf#678): absent = PASS.
 *  6. ROUTING-CLIENT-CERT issuer staleness (macf#800) — the recorded issuer
 *     fingerprint of the routing-client cert (a write-only GitHub Actions secret
 *     this command CANNOT read) vs the project's CURRENT CA fingerprint (local
 *     disk). Mismatch = the cert was signed by a CA that has since been rotated
 *     out — the #799 outage class. Absent (never minted) is informational, not
 *     a failure.
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
  caCertPath as caCertPathFor,
} from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import {
  createRegistryFromConfig,
  generateToken,
  pingAgentHealth,
  toVariableSegment,
  fromVariableSegment,
  isStaleEntry,
  caCertFingerprint,
  DEFAULT_REGISTRY_TTL_MS,
} from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import { formatTable } from './ps.js';
import {
  createInstallRepoLister,
  createCallerPinReader,
  createRoutingConfigGhReader,
  createFleetMarkerReader,
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

/**
 * A pinned repo's `.github/macf-fleet.json` opt-OUT marker (#614). A repo that is
 * an agent-router caller still participates in the `pins_consistent` verdict UNLESS
 * it declares itself non-fleet here (`{ "routing_fleet": false }`). Lives WITH the
 * opted-out repo (self-documenting), so there is no central allowlist / agent-config
 * coupling / hardcoded repo-set baked into the published package. Absent file, or the
 * key absent/`true`, → member (the opt-out direction; see `isFleetMember`).
 */
export interface FleetMarker {
  readonly routing_fleet?: boolean;
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
 * Fleet membership via the opt-OUT marker (#614). A pinned (agent-router-caller) repo
 * participates in `pins_consistent` UNLESS it explicitly declares itself non-fleet via
 * `.github/macf-fleet.json` `{ "routing_fleet": false }`.
 *
 * The opt-OUT direction is load-bearing: the DEFAULT is MEMBER, so a NEW fleet repo is
 * checked from day one. Opt-IN is the dangerous direction — a new member would silently
 * default to UNCHECKED and a real pin-drift would go uncaught. Opt-out fails toward
 * OVER-checking (a stray repo flagged), never toward a silent gap. Hence: absent /
 * unreadable marker, or `routing_fleet !== false`, → member.
 */
export function isFleetMember(marker: FleetMarker | null | undefined): boolean {
  return !(marker !== null && marker !== undefined && marker.routing_fleet === false);
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

/** Session-name check tri-state (DR-032 #610): present+match / present+stale / absent. */
export type SessionStatus = 'ok' | 'warn' | 'absent';

/**
 * Session-name drift (DR-032 §6th-surface amendment, #601 / #610). The CONVENTION
 * check: `agent-config.json:tmux_session` should equal `<project>@<routing-label>` —
 * keyed on the ROUTING LABEL (= `MACF_ROUTING_LABEL`, what `claude.sh` self-wraps on
 * per `claude-sh.ts` since macf#678), NOT the OTEL agent-name. The registry key / cert
 * CN / DR-031 watchdog all key on the routing-label too, so the session matches what
 * they target even for a name != routing_label agent (science). `label` here IS the
 * routing label (the caller iterates registry keys / agent-config.json keys). This is
 * a STATIC convention check — it proves the config follows the canonical naming, NOT
 * that it matches the LIVE tmux session (a runtime fact this command can't see).
 *
 * Tri-state, and deliberately NOT a verdict-failing check:
 *  - `absent` — no `tmux_session` (or no `agent-config.json` at all). ASSERT-IF-PRESENT:
 *               agent-config.json was the Stage-2 SSH-router's target list and is
 *               vestigial on v3 channel agents (the v3+ template omits it per macf#678),
 *               so its absence is a PASS, not a fault.
 *  - `ok`     — present and matches `<project>@<routing-label>`.
 *  - `warn`   — present but stale (e.g. a leftover Stage-2 bare-label send-target). The
 *               known-pending DR-032 session-rename migration; WARN-not-FAIL — it stays
 *               VISIBLE but does NOT drive DEGRADED/exit-1 (else the DR-006 watchdog
 *               false-restarts on a gated step).
 */
export function evaluateSession(
  label: string,
  tmuxSession: string | undefined,
  project: string,
): { readonly status: SessionStatus; readonly expected: string; readonly reason?: string } {
  const expected = `${project}@${label}`;
  if (!tmuxSession || tmuxSession.trim() === '') {
    return { status: 'absent', expected };
  }
  if (tmuxSession === expected) return { status: 'ok', expected };
  return {
    status: 'warn',
    expected,
    reason:
      `tmux_session "${tmuxSession}" != "${expected}" (<project>@<routing-label> convention; ` +
      `WARN-not-FAIL pending the DR-032 session-rename migration)`,
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

/**
 * Routing-client cert issuer staleness (#800, DR-010 amendment / silent-
 * fallback-hazards.md Instance 16):
 *  - `ok`       — the recorded issuer fingerprint matches the CURRENT project
 *                 CA. The routing-client cert (a GitHub Actions secret this
 *                 command CANNOT read — secrets are write-only) is presumed
 *                 signed by the live CA.
 *  - `orphaned` — the recorded issuer fingerprint does NOT match the current
 *                 CA. A CA (re-)issue happened since this cert was minted;
 *                 the deployed routing-client cert is presumed signed by the
 *                 OLD CA and every mTLS route-by-label POST it makes will be
 *                 rejected. This is the #799 outage class.
 *  - `absent`   — no issuer was ever recorded (never minted via `macf certs
 *                 issue-routing-client`, or a pre-#800 workspace). Assert-
 *                 IF-PRESENT: this is informational, NOT a failure — there
 *                 is nothing (yet) to compare against.
 */
export type RoutingClientCertIssuerState = 'ok' | 'orphaned' | 'absent';

export interface RoutingClientCertCheckResult {
  readonly state: RoutingClientCertIssuerState;
  readonly recordedFingerprint: string | null;
  readonly currentFingerprint: string | null;
  readonly mintedAt: string | null;
  readonly reason?: string;
}

/**
 * Parse the `<PROJECT>_ROUTING_CLIENT_CERT_ISSUER` registry variable value
 * written by `macf certs issue-routing-client` (#800). Returns `null` for
 * anything that isn't a well-formed `{issuer_fingerprint, minted_at}`
 * envelope — missing, empty, malformed JSON, and a missing/empty
 * `issuer_fingerprint` field are ALL treated as "never recorded" (the
 * `absent` state), never as a parse failure that blocks the check.
 */
export function parseRoutingClientCertIssuer(
  raw: string | null | undefined,
): { readonly fingerprint: string; readonly mintedAt: string | null } | null {
  if (!raw || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const fingerprint = rec['issuer_fingerprint'];
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') return null;
  const mintedAt = typeof rec['minted_at'] === 'string' ? rec['minted_at'] : null;
  return { fingerprint, mintedAt };
}

/**
 * Compare the recorded routing-client cert issuer fingerprint against the
 * project's CURRENT CA fingerprint. Pure w.r.t. its inputs — the CURRENT CA
 * fingerprint is read from LOCAL disk (`caCertPathFor`, the same source of
 * truth `certs rotate` / `issue-routing-client` sign against), not the
 * registry-stored `CA_CERT` variable, so this check reflects what THIS
 * machine would sign a fresh routing-client cert with.
 */
export function evaluateRoutingClientCertIssuer(
  recordedRaw: string | null | undefined,
  currentCaFingerprint: string | null,
): RoutingClientCertCheckResult {
  const recorded = parseRoutingClientCertIssuer(recordedRaw);
  if (!recorded) {
    return {
      state: 'absent',
      recordedFingerprint: null,
      currentFingerprint: currentCaFingerprint,
      mintedAt: null,
      reason:
        'no routing-client cert issuer recorded yet (never minted via `macf certs ' +
        'issue-routing-client`, or a pre-#800 workspace) — informational only, not a failure',
    };
  }
  if (currentCaFingerprint === null) {
    // A recorded issuer exists but this run has no local CA cert to compare
    // against — can't assert either way. Same "informational, not a
    // failure" posture as absent: we don't want a locally-missing CA file
    // to masquerade as an orphaned routing-client cert (false positive).
    return {
      state: 'absent',
      recordedFingerprint: recorded.fingerprint,
      currentFingerprint: null,
      mintedAt: recorded.mintedAt,
      reason: 'no local CA cert found for this project — cannot verify the routing-client cert issuer this run',
    };
  }
  if (recorded.fingerprint === currentCaFingerprint) {
    return {
      state: 'ok',
      recordedFingerprint: recorded.fingerprint,
      currentFingerprint: currentCaFingerprint,
      mintedAt: recorded.mintedAt,
    };
  }
  return {
    state: 'orphaned',
    recordedFingerprint: recorded.fingerprint,
    currentFingerprint: currentCaFingerprint,
    mintedAt: recorded.mintedAt,
    reason:
      'routing-client cert is orphaned (signed by a rotated-out CA) — re-mint via `macf ' +
      'certs issue-routing-client` and re-set ROUTING_CLIENT_CERT/ROUTING_CLIENT_KEY on ' +
      'every caller repo (macf#800)',
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
  /**
   * Fleet membership (#614, opt-out): `true` for a routing-caller repo that
   * participates in `pins_consistent`; `false` for a pinned repo that opted OUT
   * (`.github/macf-fleet.json` `routing_fleet:false`) AND for non-callers (no
   * caller → not a participating member). Distinguish the two via `status`.
   */
  readonly fleetMember: boolean;
  /**
   * `true`/`false` only for FLEET-MEMBER routing callers; `null` for non-callers AND
   * opted-out callers — both excluded from the verdict.
   */
  readonly consistent: boolean | null;
}

export interface AgentRow {
  readonly label: string;
  readonly appName: string | null;
  readonly tmuxSession: string | null;
  readonly routable: boolean;
  /**
   * Provenance (#621): `true` when a local `.github/agent-config.json[label]` entry
   * exists (REPO-scoped checks apply); `false` for a REGISTRY-ONLY fleet agent (the
   * current repo does not route to it — e.g. the auditor seen from groundnuty/macf).
   * A consumer reads this to know whether a null repo-scoped field is null-because-
   * registry-only (no local expectation) vs null-because-the-check-was-not-run.
   */
  readonly inLocalConfig: boolean;
  /**
   * REPO-scoped self-skip (#538b / #566). `null` for a registry-only agent — no local
   * `agent-config.json` entry, so there is no `app_name` to assert (honest-not-asserted,
   * NOT a fault). A boolean only when `inLocalConfig` is true.
   */
  readonly selfSkipOk: boolean | null;
  readonly selfSkipReason?: string;
  /**
   * Back-compat boolean (schema_version:1): `true` for `ok` + `absent`, `false` for
   * the stale `warn`. No longer drives the verdict — see `sessionStatus` (DR-032 #610).
   * `null` for a registry-only agent (REPO-scoped; no local config to check, #621).
   */
  readonly sessionOk: boolean | null;
  /**
   * Tri-state session check (DR-032 #610): `ok` (match) / `warn` (stale drift, non-fatal)
   * / `absent` (vestigial on v3). `null` for a registry-only agent (REPO-scoped, #621).
   */
  readonly sessionStatus: SessionStatus | null;
  /** Expected `<project>@<routing-label>` session; `null` for a registry-only agent (#621). */
  readonly sessionExpected: string | null;
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
  /** #800 — routing-client cert issuer-vs-current-CA staleness check. */
  readonly routingClientCert: RoutingClientCertCheckResult;
}

// --- Orchestration ---

/** Injectable seam so tests drive the command fully offline. */
export interface RoutingDoctorDeps {
  readonly project: string;
  /** The App install-set (DR-030 Q3 repo-set source). */
  readonly listRepos: () => Promise<readonly string[]>;
  /** Read a repo's macf-actions caller-pin from agent-router.yml. */
  readonly readCallerPin: (repo: string) => Promise<CallerPinResult>;
  /**
   * Read a pinned repo's `.github/macf-fleet.json` opt-out marker (#614). One extra
   * small content-read per PINNED repo; absent/unreadable → member (`isFleetMember`).
   */
  readonly readFleetMarker: (repo: string) => Promise<FleetMarker | null>;
  /** The CURRENT project's routing config (`.github/agent-config.json`). */
  readonly readRoutingConfig: () => Promise<RoutingConfig | null>;
  /** Registry agents (for routability + freshness). */
  readonly listRegistry: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  /** mTLS `/health` probe (freshness). */
  readonly probe: RoutingProbeFn;
  /** The `MACF_CA_CERT` variable's raw value. */
  readonly readCaCert: () => Promise<string | null>;
  /**
   * The `<PROJECT>_ROUTING_CLIENT_CERT_ISSUER` registry variable's raw value
   * (#800), written by `macf certs issue-routing-client`. `null` when never
   * minted (pre-#800 workspace, or the collision-guard blocked minting).
   */
  readonly readRoutingClientCertIssuer: () => Promise<string | null>;
  /**
   * The project's CURRENT CA cert fingerprint, read from LOCAL disk (#800) —
   * `null` when this machine has no local CA cert for the project. Sync
   * because it's a local file read, unlike the other deps which hit GitHub.
   */
  readonly currentCaFingerprint: () => string | null;
  /** Authoritative expected bot-logins by routing label (partial; heuristic fallback). */
  readonly botLogins?: Readonly<Record<string, string>>;
  /** Explicit expected caller-pin (else the modal pin). */
  readonly expectedPin?: string;
  /** Clock for the heartbeat-TTL staleness math (defaults to `Date.now()`). */
  readonly now?: number;
}

/**
 * Resolve fleet membership (#614, opt-out) per pinned repo, then build the RepoPinRow
 * list. The modal/expected pin AND each `consistent` flag are scoped to FLEET-MEMBER
 * pinned repos only — a non-member's divergent pin neither pulls the modal nor flips
 * the verdict. Non-callers AND opted-out callers both get `consistent: null` (excluded).
 */
async function resolveRepoPins(
  pinResults: readonly CallerPinResult[],
  readFleetMarker: (repo: string) => Promise<FleetMarker | null>,
  expectedPinOverride?: string,
): Promise<{ readonly repoPins: RepoPinRow[]; readonly expectedPin: string | null }> {
  const memberByRepo = new Map<string, boolean>();
  for (const r of pinResults) {
    if (r.status === 'pinned') memberByRepo.set(r.repo, isFleetMember(await readFleetMarker(r.repo)));
  }
  const isMember = (r: CallerPinResult): boolean =>
    r.status === 'pinned' && (memberByRepo.get(r.repo) ?? true);
  const memberPinnedVals = pinResults.filter((r) => isMember(r) && r.pin).map((r) => r.pin!);
  const expectedPin = computeExpectedPin(memberPinnedVals, expectedPinOverride);
  const repoPins = pinResults.map((r): RepoPinRow => {
    const member = isMember(r);
    return {
      repo: r.repo,
      pin: r.pin,
      status: r.status,
      fleetMember: member,
      consistent: member ? r.pin === expectedPin : null,
    };
  });
  return { repoPins, expectedPin };
}

/**
 * Build one agent's row. FLEET-scoped checks (routability + freshness/instance_id) run
 * for every registry entry — they need no local config, so they hold from ANY repo's run
 * (#621). REPO-scoped checks (self-skip + session) run ONLY when a local agent-config
 * `entry` exists; a registry-only agent (`entry === undefined`) NULLS them — there is no
 * local `app_name`/`tmux_session` to assert (honest-not-asserted, same discipline as the
 * #612 null output_tokens), NOT a fault.
 */
async function evaluateAgentRow(
  label: string,
  info: AgentInfo | null,
  entry: RoutingConfigEntry | undefined,
  deps: RoutingDoctorDeps,
  now: number,
): Promise<AgentRow> {
  const inLocalConfig = entry !== undefined;

  // FLEET-scoped: freshness from the registry entry + the live /health probe.
  let freshness: FreshnessState = 'unregistered';
  let healthInstanceId: string | null | undefined;
  if (info) {
    const health = await deps.probe(info.host, info.port);
    freshness = classifyFreshness(info, health, now, DEFAULT_REGISTRY_TTL_MS);
    healthInstanceId = health?.instance_id ?? null;
  }

  // REPO-scoped: only when a local agent-config entry exists. The agent-config key IS the
  // routing label — the canonical session keys on the routing-label too (macf#678), so
  // the SESSION check matches even for a name != routing_label agent (science).
  const selfSkip = entry ? evaluateSelfSkip(label, entry.app_name, deps.botLogins?.[label]) : null;
  const session = entry ? evaluateSession(label, entry.tmux_session, deps.project) : null;

  return {
    label,
    appName: entry?.app_name ?? null,
    tmuxSession: entry?.tmux_session ?? null,
    routable: info !== null,
    inLocalConfig,
    selfSkipOk: selfSkip ? selfSkip.ok : null,
    selfSkipReason: selfSkip?.reason,
    // `session` is tri-state (DR-032 #610). `sessionOk` stays for back-compat (true for
    // `ok` + `absent`, false for the stale `warn`); null for a registry-only agent (#621).
    sessionOk: session ? session.status !== 'warn' : null,
    sessionStatus: session ? session.status : null,
    sessionExpected: session ? session.expected : null,
    sessionReason: session?.reason,
    freshness,
    registryInstanceId: info?.instance_id ?? null,
    healthInstanceId,
  };
}

/**
 * Run all five checks. PURE w.r.t. the injected deps — tests pass fakes so nothing
 * hits gh / the registry / the network.
 */
export async function gatherRoutingDoctor(deps: RoutingDoctorDeps): Promise<RoutingDoctorReport> {
  const now = deps.now ?? Date.now();

  // 1. Caller-pin sweep across the install-set; fleet membership (#614) scopes the verdict.
  const repos = await deps.listRepos();
  const pinResults: CallerPinResult[] = [];
  for (const repo of repos) pinResults.push(await deps.readCallerPin(repo));
  const { repoPins, expectedPin } = await resolveRepoPins(pinResults, deps.readFleetMarker, deps.expectedPin);

  // Registry index (routability + freshness).
  const registry = await deps.listRegistry();
  const registryByName = new Map(registry.map((e) => [e.name, e.info] as const));

  // 2 + 3 + 5. Per-agent checks across the UNION of (registry-registered fleet agents) and
  // (locally-configured routing-targets) — de-duped by label, registry order first (#621).
  // The OLD loop iterated `config.agents` (the current repo's routing-TARGETS) only, so a
  // registered fleet agent the repo does not route to (e.g. the auditor, from groundnuty/
  // macf) was registered-but-never-checked → silently skipped. The union closes that: every
  // registry agent gets the FLEET-scoped checks (routability + freshness) from any repo's run.
  const config = await deps.readRoutingConfig();
  const hasRoutingConfig = config !== null;
  const configAgents = config?.agents ?? {};

  const regKeyByLabel = new Map<string, string>();
  const seen = new Set<string>();
  const orderedLabels: string[] = [];
  const pushLabel = (label: string): void => {
    if (seen.has(label)) return;
    seen.add(label);
    orderedLabels.push(label);
  };
  for (const e of registry) {
    const label = fromVariableSegment(e.name);
    regKeyByLabel.set(label, e.name);
    pushLabel(label);
  }
  for (const label of Object.keys(configAgents)) pushLabel(label);

  const agents: AgentRow[] = [];
  for (const label of orderedLabels) {
    const regKey = regKeyByLabel.get(label) ?? toVariableSegment(label);
    const info = registryByName.get(regKey) ?? null;
    agents.push(await evaluateAgentRow(label, info, configAgents[label], deps, now));
  }

  // 4. CA material.
  const ca = evaluateCaCert(await deps.readCaCert());

  // 6. Routing-client cert issuer staleness (#800) — a project-level check,
  // like CA material, not per-agent/per-repo.
  const routingClientCert = evaluateRoutingClientCertIssuer(
    await deps.readRoutingClientCertIssuer(),
    deps.currentCaFingerprint(),
  );

  return { project: deps.project, repoPins, expectedPin, hasRoutingConfig, agents, ca, routingClientCert };
}

// --- Verdict ---

export type RoutingVerdict = 'HEALTHY' | 'DEGRADED' | 'EMPTY';

/** A registry entry's freshness fails the verdict only when definitively `stale`. */
function freshnessFails(s: FreshnessState): boolean {
  return s === 'stale';
}

/**
 * Whether an agent's ROUTING-PLANE checks pass — the single predicate the verdict,
 * the summary line, and the JSON `agents_routing_ok` all share. Keyed on the FLEET-scoped
 * invariants (routability + freshness) so it covers REGISTRY-ONLY agents too (#621): a
 * registered fleet agent that has gone definitively `stale` still DEGRADES the plane from
 * ANY repo's run, even with no local config. The SELF-SKIP clause is REPO-scoped — it
 * constrains a locally-configured agent (`selfSkipOk === false` is the #566 fault) but a
 * registry-only agent's `null` self-skip is honest-not-asserted, NOT a failure
 * (`!== false`). The SESSION-name drift is deliberately EXCLUDED (DR-032 §6th-surface
 * amendment, #610): a stale `agent-config.json:tmux_session` is the known-pending
 * session-rename migration — WARN-not-FAIL, surfaced via `sessionStatus` + `warnings[]`.
 */
function agentRoutingOk(a: AgentRow): boolean {
  return a.routable && a.selfSkipOk !== false && !freshnessFails(a.freshness);
}

/**
 * Whether the routing-client cert check FAILS the verdict (#800). Only the
 * `orphaned` state fails — `absent` (never minted) is deliberately excluded,
 * same "informational, not a failure" posture as a pre-migration workspace
 * that has nothing to compare against yet.
 */
function routingClientCertFails(r: RoutingClientCertCheckResult): boolean {
  return r.state === 'orphaned';
}

export function routingVerdict(report: RoutingDoctorReport): RoutingVerdict {
  if (report.repoPins.length === 0 && report.agents.length === 0) return 'EMPTY';
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const pinFail = participating.some((r) => !r.consistent);
  const agentFail = report.agents.some((a) => !agentRoutingOk(a));
  const caFail = !report.ca.present || !report.ca.valid;
  const routingClientCertFail = routingClientCertFails(report.routingClientCert);
  return pinFail || agentFail || caFail || routingClientCertFail ? 'DEGRADED' : 'HEALTHY';
}

/** `4 fleet repos (pins consistent); 3 agents (2 routing-OK); CA ✓; routing-client cert ✓; routing plane: HEALTHY`. */
export function summaryLine(report: RoutingDoctorReport): string {
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const pinsOk = participating.length > 0 && participating.every((r) => r.consistent);
  const agentOk = report.agents.filter(agentRoutingOk).length;
  const pinClause =
    participating.length > 0
      ? `${participating.length} routing repo(s) (${pinsOk ? 'pins consistent' : 'PIN DIVERGENCE'})`
      : 'no routing-caller repos discovered';
  return (
    `${pinClause}; ${agentOk}/${report.agents.length} agents routing-OK; ` +
    `CA ${report.ca.valid ? '✓' : '✗'}; routing-client cert ${routingClientCertGlyph(report.routingClientCert.state)}; ` +
    `routing plane: ${routingVerdict(report)}`
  );
}

/**
 * Non-verdict-driving observations the watchdog should still SEE (DR-032 #610).
 * Currently: the session-name drift (`warn`) — visible, but it does NOT flip the
 * verdict (the known-pending session-rename migration). Surfaced additively in the
 * JSON `warnings[]` and the text-render warnings block.
 */
export function collectWarnings(report: RoutingDoctorReport): readonly string[] {
  const out: string[] = [];
  for (const a of report.agents) {
    if (a.sessionStatus === 'warn') {
      out.push(
        a.sessionReason
          ? `agent "${a.label}": ${a.sessionReason}`
          : `agent "${a.label}": tmux_session drift (expected "${a.sessionExpected}")`,
      );
    }
  }
  return out;
}

/**
 * The deliberately opted-OUT pinned repos (#614): agent-router callers that declared
 * `.github/macf-fleet.json` `routing_fleet:false` and are therefore excluded from the
 * `pins_consistent` verdict. Non-callers are NOT listed (they never had a pin). Surfaced
 * additively in the JSON `non_fleet_repos[]` + the text render so the exclusion is
 * VISIBLE rather than a silent scope-narrowing.
 */
export function collectNonFleetRepos(report: RoutingDoctorReport): readonly string[] {
  return report.repoPins.filter((r) => r.status === 'pinned' && !r.fleetMember).map((r) => r.repo);
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

/** Session status → glyph: ok ✓, warn ⚠ (non-fatal drift), absent — (assert-if-present PASS). */
export function sessionGlyph(s: SessionStatus): string {
  switch (s) {
    case 'ok':
      return '✓';
    case 'warn':
      return '⚠ warn';
    case 'absent':
      return '—';
  }
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

/** Routing-client cert issuer state → glyph: ok ✓, orphaned ✗ (macf#800), absent — (informational). */
export function routingClientCertGlyph(s: RoutingClientCertIssuerState): string {
  switch (s) {
    case 'ok':
      return '✓';
    case 'orphaned':
      return '✗ orphaned';
    case 'absent':
      return '— n/a';
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
    // REPO-scoped self-skip + session render `— n/a` for a registry-only agent (#621):
    // null = no local config to assert, distinct from a ✗ failure.
    a.selfSkipOk === null ? '— n/a' : boolGlyph(a.selfSkipOk),
    a.sessionStatus === null ? '— n/a' : sessionGlyph(a.sessionStatus),
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
  '        A repo opts OUT of the pin check via .github/macf-fleet.json {"routing_fleet":false}',
  '        (e.g. an intentional-Stage-2 test harness); absent marker = fleet member (#614).',
  '        ROUTABLE = a MACF_AGENT_<LABEL> registry key exists (router resolves by LABEL).',
  '        SELF-SKIP = agent-config.json app_name is the bot-LOGIN, not the bare label (#566).',
  '        SESSION = agent-config.json tmux_session follows <project>@<routing-label> (assert-IF-',
  '                  PRESENT: absent = PASS, vestigial + omitted on v3 (#678); ⚠ warn = stale drift,',
  '                  WARN-not-FAIL — visible but does NOT drive the verdict, DR-032 session-rename).',
  '                  FRESH = registry instance_id == live /health instance_id (✗ stale / ? unreach).',
  '        The agent set is the registry fleet ∪ this repo\'s routing config (#621): a registry-only',
  '        agent (one this repo does not route to, e.g. the auditor) shows "— n/a" SELF-SKIP/SESSION',
  '        (REPO-scoped, no local config) but is still ROUTABLE/FRESH-checked (FLEET-scoped).',
  '        ROUTING-CLIENT CERT (macf#800) = the recorded issuer fingerprint (written by `macf certs',
  '        issue-routing-client`) vs the CURRENT project CA (local disk). ✗ orphaned = signed by a',
  '        rotated-out CA (re-mint + re-set the secret); — n/a = never minted, informational only.',
  'NOTE: these are STATIC GitHub-plane checks — they prove the routing PLUMBING is wired right,',
  '      NOT that a message was delivered end-to-end (that is `macf routing doctor --e2e`, a',
  '      later increment). Mesh delivery is `macf fleet doctor`.',
].join('\n');

const HONESTY_DISCLAIMER =
  'Static GitHub-plane checks: they prove the routing plumbing (caller-pins, registry-as-routing-' +
  'source, CA material, routing-client cert issuer, session-name convention) is wired right, NOT ' +
  'that a message was delivered end-to-end (that is --e2e, a later increment). Mesh delivery is ' +
  '`macf fleet doctor`.';

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
      agents_routing_ok: report.agents.filter(agentRoutingOk).length,
      ca_ok: report.ca.present && report.ca.valid,
      // Additive (schema_version:1, #800): false only for the verdict-failing
      // `orphaned` state; `absent` (never minted) counts as true (not a fault).
      routing_client_cert_ok: !routingClientCertFails(report.routingClientCert),
    },
    // Additive (schema_version:1, DR-032 #610): non-verdict-driving observations the
    // watchdog should still SEE — currently the session-name drift (WARN-not-FAIL).
    warnings: collectWarnings(report),
    // Additive (schema_version:1, #614): pinned repos that opted OUT of the fleet via
    // `.github/macf-fleet.json` routing_fleet:false (excluded from pins_consistent).
    non_fleet_repos: collectNonFleetRepos(report),
    caller_pins: report.repoPins.map((r) => ({
      repo: r.repo,
      pin: r.pin,
      status: r.status,
      // Additive (schema_version:1, #614): true = participates in pins_consistent.
      fleet_member: r.fleetMember,
      consistent: r.consistent,
    })),
    agents: report.agents.map((a) => ({
      label: a.label,
      app_name: a.appName,
      tmux_session: a.tmuxSession,
      routable: a.routable,
      // Additive (schema_version:1, #621): false = a registry-only fleet agent (the
      // current repo does not route to it); its repo-scoped fields below are null-because-
      // registry-only, NOT null-because-failed. FLEET-scoped fields (routable, freshness)
      // are still asserted for it.
      in_local_config: a.inLocalConfig,
      self_skip_ok: a.selfSkipOk,
      self_skip_reason: a.selfSkipReason ?? null,
      session_ok: a.sessionOk,
      session_status: a.sessionStatus,
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
    // Additive (schema_version:1, #800): routing-client cert issuer-vs-current-CA
    // staleness. `state: "orphaned"` fails the verdict; `"absent"` is informational.
    routing_client_cert: {
      state: report.routingClientCert.state,
      recorded_fingerprint: report.routingClientCert.recordedFingerprint,
      current_fingerprint: report.routingClientCert.currentFingerprint,
      minted_at: report.routingClientCert.mintedAt,
      reason: report.routingClientCert.reason ?? null,
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

  // #800: the routing-client cert issuer registry variable, same GitHubVariablesClient
  // + scope as CA material (DR-006) — written by `macf certs issue-routing-client`.
  const routingClientCertIssuerVarName = `${toVariableSegment(config.project)}_ROUTING_CLIENT_CERT_ISSUER`;

  return {
    ok: true,
    deps: {
      project: config.project,
      botLogins,
      listRepos: createInstallRepoLister(token),
      readCallerPin: createCallerPinReader(token),
      readFleetMarker: createFleetMarkerReader(token),
      readRoutingConfig: async () => localRouting ?? (await ghRoutingReader(detectCurrentRepo(projectDir) ?? '')),
      listRegistry: () => registry.list(''),
      probe: (host, port) => pingAgentHealth({ host, port, caCertPem: caCertPem ?? '', certPath, keyPath }),
      readCaCert: async () => caCertPem,
      readRoutingClientCertIssuer: () => client.readVariable(routingClientCertIssuerVarName),
      // Local disk, NOT the registry-stored CA_CERT var — the same source of truth
      // `certs rotate` / `issue-routing-client` sign against (#800).
      currentCaFingerprint: () => {
        const p = caCertPathFor(config.project);
        if (!existsSync(p)) return null;
        try {
          return caCertFingerprint(readFileSync(p, 'utf-8'));
        } catch {
          return null;
        }
      },
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
    const nonFleet = collectNonFleetRepos(report);
    if (nonFleet.length > 0) {
      console.log(
        `Non-fleet (opt-out via .github/macf-fleet.json routing_fleet:false; excluded from pin check): ${nonFleet.join(', ')}`,
      );
    }
    console.log('');
  } else {
    console.log('Caller-pin consistency: no fleet repos discovered (App install-set unavailable).\n');
  }

  if (report.agents.length > 0) {
    // The agent set is the UNION of registry-registered fleet agents + this repo's routing
    // config (#621); a registry-only agent (`— n/a` repo-scoped columns) is one the current
    // repo does not route to but is still FLEET-scoped-checked (routability + freshness).
    const scope = report.hasRoutingConfig
      ? 'registry fleet ∪ current project routing config'
      : 'registry fleet (no .github/agent-config.json for this project — repo-scoped checks n/a)';
    console.log(`Per-agent routing checks (${scope}):`);
    console.log(formatAgentTable(report.agents));
    console.log('');
  } else {
    console.log('Per-agent routing checks: no registered fleet agents and no .github/agent-config.json found.\n');
  }

  const warnings = collectWarnings(report);
  if (warnings.length > 0) {
    console.log('Warnings (non-fatal — do NOT drive the verdict):');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    console.log('');
  }

  console.log(
    `MACF_CA_CERT: ${report.ca.present ? (report.ca.valid ? '✓ present + parses' : `✗ ${report.ca.reason}`) : '✗ absent'}`,
  );
  console.log(
    `ROUTING-CLIENT CERT ISSUER (macf#800): ${routingClientCertGlyph(report.routingClientCert.state)}` +
    (report.routingClientCert.reason ? ` — ${report.routingClientCert.reason}` : ''),
  );
  console.log('');
  console.log(summaryLine(report));
  console.log('');
  console.log(HONESTY_LEGEND);

  return verdict === 'DEGRADED' ? 1 : 0;
}
