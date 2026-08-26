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
 *     config file. Extended macf#872 with a SECOND, independent axis — pin
 *     CORRECTNESS: consistency alone measures modal agreement, so a fleet that
 *     drifted to the SAME stale pin on every repo reports `consistent: true` —
 *     green precisely when the problem is worst. `routing-doctor-pin-
 *     correctness.ts`'s `classifyPinState` compares each repo's pin against the
 *     fleet manifest's declared `versions.actions` (an operator-supplied
 *     `--manifest <path>`, else control-repo auto-discovery off the SAME
 *     install-set, else the honest `unknown` floor — never a pass) and crosses
 *     it with consistency into `inconsistent` / `consistent-and-correct` /
 *     `consistent-but-wrong` / `unknown`. Warn-never-fail: `consistent-but-wrong`
 *     does NOT flip the HEALTHY/DEGRADED verdict (a deliberate older pin is
 *     legitimate; the harm is SILENT staleness), but it DOES replace "pins
 *     consistent" in `summaryLine`'s own clause — never a separate footnote a
 *     reader can miss.
 *  2. The #538 split — TWO independent checks per agent:
 *     (a) ROUTABILITY — each routing label has a `MACF_AGENT_<LABEL>` key in the
 *         registry (the router resolves BY LABEL; a bot-name key is silently
 *         unrouteable).
 *     (b) SELF-SKIP correctness — `agent-config.json[label].app_name` is the
 *         bot-LOGIN, not the bare routing label (the #566 root cause:
 *         `repo-init.ts` wrote the agent-name). Independent of (a): a wrong
 *         `app_name` still ROUTES (resolution never touches it) — it breaks the
 *         actor-skip instead. Tri-state (macf#874, the #872 completeness audit):
 *         an authoritative bot-login (known for THIS agent's own label; a peer's
 *         is rarely known) verifies exactly (`ok`/`not_ok`); without one, the
 *         #566 heuristic can only rule out the ONE known-bad shape, so clearing
 *         it reports `unresolvable`, never `ok` — a check that only ruled out
 *         one bad value was previously reporting a positive verification it
 *         never performed.
 *  3. REGISTRATION freshness — `registry.instance_id == /health.instance_id`
 *     (precise current-vs-stale; disambiguates the #553 dying-server race). A
 *     reassigned port surfaces as unreachability; an aged `last_heartbeat` is a
 *     definitive stale (DR-031 `isStaleEntry`).
 *  4. CA material — `MACF_CA_CERT` (a readable VARIABLE) is present AND
 *     base64/PEM-parses (the #563 malformed-base64 class — present ≠ valid) AND,
 *     extended macf#873, IS THE CURRENT local CA. A rotated-out-but-well-formed
 *     cert used to pass this check outright — but that same variable is the mTLS
 *     trust anchor for every agent's `/health` probe, so a stale value silently
 *     fails EVERY probe, and each downstream check independently declines to
 *     fail on that (`freshnessFails` only fails `'stale'`; `routable` only checks
 *     the registry key exists) — the #872 "precondition for other checks'
 *     failures" absorption class. A definite mismatch fails the verdict AND, when
 *     most/all agents read unreachable, is reported as the LIKELY CAUSE rather
 *     than a separate, uncorrelated line.
 *  5. SESSION-name drift — `agent-config.json.tmux_session` follows the canonical
 *     `<project>@<routing-label>` convention (the silent Stage-2-routing-drop class).
 *     Vestigial + omitted on v3+ (macf#678): absent = PASS.
 *  6. ROUTING-CLIENT-CERT issuer staleness (macf#800) — the recorded issuer
 *     fingerprint of the routing-client cert (a write-only GitHub Actions secret
 *     this command CANNOT read) vs the project's CURRENT CA fingerprint (local
 *     disk). Mismatch = the cert was signed by a CA that has since been rotated
 *     out — the #799 outage class. Absent (never minted) is informational, not
 *     a failure. The matching state is named `presumed-ok`, not `ok` (macf#874,
 *     the #872 completeness audit): the deployed secret itself is unreadable, so
 *     a match is a comparison of the one proxy value available, never a
 *     verification of the cert.
 *  7. ROUTING-TABLE ARTIFACTS (macf#1191) — for EVERY repo visible in this run's
 *     install-set (not just the repo this command happens to run from), does
 *     that repo's OWN `.github/agent-config.json` name an agent it has no
 *     matching GitHub LABEL for? `macf-science-agent` named `devops-agent` in
 *     its routing table with no `devops-agent` label at all — that queue could
 *     never have returned anything, and a plain per-repo audit would have read
 *     it as a healthy empty queue rather than a structurally dead one
 *     (`coordination.md §5d`: an empty result is not evidence of absence unless
 *     the instrument would have shown presence). `routing-doctor-gh.ts`'s
 *     `createRepoLabelLister` is the artifact-EXISTENCE leaf; `evaluateRoutingArtifact`
 *     / `gatherRoutingArtifacts` / `buildArtifactChecks` below are the
 *     artifact-GENERAL sweep — a future implied artifact is a NEW ENTRY in
 *     `buildArtifactChecks`, never a new command. A repo this caller cannot
 *     read is reported `not-visible`, never `missing` (GitHub returns the
 *     identical 404 for "doesn't exist," "private and not installed," and
 *     "misnamed" — there is no discriminator to build, so this command does
 *     not pretend to have one); `not-visible` does NOT fail the verdict (an
 *     App legitimately installed on a subset of repos is normal, and failing
 *     on that would make the check permanently red for every narrow-scoped
 *     caller, reproducing the exact "always red, so ignored" failure mode),
 *     but it is never silently dropped either — `reposVisible` (the coverage
 *     figure) is carried in the summary line and JSON on EVERY run, clean or
 *     not, so a narrow-coverage clean run can never be misread as a full-fleet
 *     clean run. This command NEVER creates the missing artifact — see the
 *     WHY-comment on `buildArtifactChecks`.
 *
 *     macf#1193 refines the repo-config read itself: the original `if
 *     (!config) continue` collapsed absent / malformed / read-failed into
 *     the SAME "not a routing participant" free pass a `no-workflow` repo
 *     gets from the caller-pin sweep — but a repo with a CORRUPT config IS a
 *     participant whose routing is genuinely broken, which is the exact
 *     "skip indistinguishable from a pass" shape #1191 itself exists to
 *     eliminate, surviving inside its own fix. `readRoutingConfigForRepo`
 *     now returns a `RoutingConfigReadResult` distinguishing `absent` (a
 *     confident 404 on an already known-visible repo — silently skipped,
 *     unchanged) from `malformed` (a confirmed defect — fails the verdict
 *     via a `config-malformed` entry) from `read-failed` (network/rate-
 *     limit — inconclusive, lowers coverage via a `config-read-failed`
 *     entry, never fails the verdict). See `RoutingConfigReadResult` and
 *     `gatherRoutingArtifacts` for the full rationale.
 *
 * Every GitHub read (install-set, caller-pins, agent-config, repo labels), the
 * registry list, the mTLS `/health` probe, and the CA-var read are INJECTABLE
 * (`RoutingDoctorDeps`) so tests run fully offline. The `gh` shell-outs live in
 * `routing-doctor-gh.ts`.
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
  createRoutingConfigGhReaderDetailed,
  createFleetMarkerReader,
  createFleetManifestReader,
  createRepoLabelLister,
} from './routing-doctor-gh.js';
import {
  classifyPinState,
  evaluatePinCorrectness,
  pinClauseText,
  pinCorrectnessLine,
  pinCorrectnessWarning,
  resolveDesiredActionsPin,
  type PinCorrectnessState,
} from './routing-doctor-pin-correctness.js';

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
 * Discriminated read result for a repo's OWN `.github/agent-config.json`
 * (macf#1193, refining macf#1191's `readRoutingConfigForRepo:
 * (repo) => Promise<RoutingConfig | null>`). The prior `null` collapsed THREE
 * distinct outcomes — absent, malformed, and a plain read failure — into the
 * SAME "not a routing participant, contributes nothing" treatment
 * `gatherRoutingArtifacts` gave them all. A repo with a corrupt config IS a
 * routing participant whose routing is genuinely broken; reading it as "not a
 * participant" reproduced, one level down, the exact "skip indistinguishable
 * from a pass" shape #1191 itself exists to eliminate — surviving inside its
 * own fix.
 *
 *  - `present`     — read + parsed + shape-checked OK (`{ agents: {...} }`);
 *                    `config` carries the parsed value.
 *  - `absent`      — a CONFIDENT 404. Every repo `readRoutingConfigForRepo` is
 *                    called for comes from THIS run's App INSTALL-SET
 *                    enumeration (`RoutingDoctorDeps.listRepos`) — already
 *                    KNOWN-VISIBLE to this caller — so a 404 on ITS OWN
 *                    config is unambiguous: the file genuinely doesn't exist,
 *                    not "can't see this repo." The invisibility ambiguity
 *                    that motivated #1191's `not-visible` artifact status
 *                    (GitHub returns the identical 404 for absent / private /
 *                    misnamed) CANNOT arise for this specific read — that is
 *                    what makes silently skipping `absent` safe, unlike the
 *                    other two states below.
 *  - `malformed`   — the read succeeded (a 200) but the content isn't valid
 *                    JSON, or lacks the expected `{ agents: {...} }` shape
 *                    (including `agents: null` — `typeof null === 'object'`
 *                    would otherwise slip past a naive shape check). A
 *                    CONFIRMED defect on a CONFIRMED participant: this repo
 *                    committed a routing table, and it's broken.
 *  - `read-failed` — the read failed for any OTHER reason (network,
 *                    rate-limit, a transient 5xx, an auth hiccup). Genuinely
 *                    inconclusive — the SAME epistemic status `not-visible`
 *                    already carries elsewhere in this sweep (e.g.
 *                    `listRepoLabels`), never collapsed into a confident
 *                    absence OR a confirmed defect.
 */
export type RoutingConfigReadResult =
  | { readonly status: 'present'; readonly config: RoutingConfig }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly reason: string }
  | { readonly status: 'read-failed'; readonly reason: string };

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
 * Tri-state self-skip verdict (macf#874). `ok` — an authoritative bot-login was
 * available and matched. `not_ok` — a definite fault: `app_name` is missing, is
 * the bare routing label (the #566 shape), or mismatches a known authoritative
 * login. `unresolvable` — the #566 heuristic cleared (`app_name` is not the bare
 * label) but there was no authoritative login to confirm it against, so the
 * property was never actually established.
 */
export type SelfSkipStatus = 'ok' | 'not_ok' | 'unresolvable';

/**
 * Self-skip correctness (#538 check b / #566 / macf#874). `app_name` must be the
 * bot-LOGIN. When an authoritative `expectedBotLogin` is known (the running
 * agent's own `github_app.bot_login`, macf#535), compare exactly (normalized):
 * `ok` on match, `not_ok` on mismatch — this is a genuine positive verification.
 *
 * Without an authoritative login (the common case for a PEER — this command
 * only ever knows its OWN agent's bot-login), fall back to the structural #566
 * heuristic: `app_name === <bare routing label>` is the one shape #566 proved
 * broken, so that shape is `not_ok`. But clearing that one known-bad shape does
 * NOT prove `app_name` is a real, correct bot-login — a typo'd, renamed, or
 * stale peer `app_name` clears the heuristic too. An earlier version of this
 * function returned `ok: true` for every non-bare-label value, which reported a
 * positive verification for a check that had only ruled out one specific known-
 * bad value (macf#874's audit finding). `unresolvable` names that gap honestly:
 * the heuristic stays a POSITIVE detector for the #566 shape, but it can no
 * longer produce a green.
 */
export function evaluateSelfSkip(
  label: string,
  appName: string | undefined,
  expectedBotLogin?: string,
): { readonly status: SelfSkipStatus; readonly reason?: string } {
  if (!appName || appName.trim() === '') {
    return { status: 'not_ok', reason: 'app_name missing' };
  }
  if (expectedBotLogin) {
    return normalizeLogin(appName) === normalizeLogin(expectedBotLogin)
      ? { status: 'ok' }
      : { status: 'not_ok', reason: `app_name "${appName}" != bot-login "${expectedBotLogin}"` };
  }
  if (normalizeLogin(appName) === normalizeLogin(label)) {
    return {
      status: 'not_ok',
      reason: `app_name "${appName}" is the bare routing label, not a bot-login`,
    };
  }
  return {
    status: 'unresolvable',
    reason:
      `app_name "${appName}" is not the bare routing label, but no authoritative bot-login ` +
      'is known for this peer to confirm it against — not asserted',
  };
}

/**
 * The `selfSkipOk` back-compat boolean (macf#874): `true` ONLY for a verified
 * `ok`, `false` for a definite `not_ok`, `null` for `unresolvable` — the
 * honest-not-asserted state collapses to the SAME `null` a registry-only
 * agent's absent local config already renders as, never to `true`.
 */
function selfSkipStatusToBackCompatBool(status: SelfSkipStatus): boolean | null {
  if (status === 'ok') return true;
  if (status === 'not_ok') return false;
  return null;
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
      `WARN-not-FAIL pending a future session-rename migration)`,
  };
}

/** Strict base64: only the base64 alphabet, padded to a multiple of 4. */
export function isStrictBase64(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  if (t.length === 0 || t.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(t);
}

/**
 * CA material check (#563, extended macf#873). `MACF_CA_CERT` is a readable
 * VARIABLE; validate it is present AND parses — either as a PEM cert block whose
 * body is strict base64, or as a base64-of-PEM blob that decodes to a cert. A
 * present-but-malformed value (truncated / garbled base64) is the #563 class:
 * present ≠ valid.
 *
 * macf#873 extends this from "well-formed" to "well-formed AND CURRENT": a
 * rotated-out cert still parses cleanly, so present+valid alone let a stale CA
 * through even though it is the mTLS trust anchor every agent's `/health` probe
 * uses (see `resolveDepsFromRegistry`). Pass `currentCaFingerprint` — the SAME
 * local-disk read `deps.currentCaFingerprint()` check 6 already computes; do NOT
 * add a second local-CA read path — to get a `matchesCurrentCa` verdict alongside
 * present/valid. Omit it (or pass `null`, the default) to skip the comparison:
 * `matchesCurrentCa` is `null` (honest-not-asserted, NEVER a pass) whenever the
 * registry cert doesn't parse OR no local CA fingerprint was given.
 */
export function evaluateCaCert(
  raw: string | null | undefined,
  currentCaFingerprint: string | null = null,
): CaCheckResult {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return {
      present: false,
      valid: false,
      reason: 'MACF_CA_CERT absent or empty',
      matchesCurrentCa: null,
      registryCaFingerprint: null,
      currentCaFingerprint,
    };
  }
  const text = raw.trim();
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text);
  let normalizedPem: string | null = null;
  let base: { present: boolean; valid: boolean; reason?: string };

  if (pem) {
    const [, body] = pem;
    if (isStrictBase64(body!)) {
      normalizedPem = text;
      base = { present: true, valid: true };
    } else {
      base = { present: true, valid: false, reason: 'PEM body is not valid base64 (malformed)' };
    }
  } else if (isStrictBase64(text)) {
    // No PEM markers — maybe the whole value is base64-of-PEM (#563 storage form).
    const decoded = Buffer.from(text, 'base64').toString('utf-8');
    if (/-----BEGIN CERTIFICATE-----/.test(decoded)) {
      normalizedPem = decoded;
      base = { present: true, valid: true };
    } else {
      base = { present: true, valid: false, reason: 'base64 decodes but is not a certificate' };
    }
  } else {
    base = {
      present: true,
      valid: false,
      reason: 'present but not a parseable PEM/base64 certificate (malformed-base64)',
    };
  }

  const registryCaFingerprint = normalizedPem ? caCertFingerprint(normalizedPem) : null;
  const matchesCurrentCa =
    registryCaFingerprint !== null && currentCaFingerprint !== null
      ? registryCaFingerprint === currentCaFingerprint
      : null;

  return { ...base, matchesCurrentCa, registryCaFingerprint, currentCaFingerprint };
}

/**
 * Routing-client cert issuer staleness (#800, DR-010 amendment / silent-
 * fallback-hazards.md Instance 16):
 *  - `presumed-ok` — the recorded issuer fingerprint matches the CURRENT
 *                 project CA. The routing-client cert itself is a GitHub
 *                 Actions secret this command CANNOT read — secrets are
 *                 write-only — so this is NOT a verification that the
 *                 deployed cert is good; it is a comparison of the one
 *                 proxy value this command CAN read (the recorded issuer
 *                 fingerprint) against the current CA. An earlier version
 *                 named this state `ok`, which rendered indistinguishably
 *                 from a verified pass elsewhere in this table (macf#874's
 *                 audit finding) — `presumed-ok` names the forced proxy
 *                 honestly, in the state literal itself, not just in a
 *                 doc comment nobody sees at the CLI.
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
export type RoutingClientCertIssuerState = 'presumed-ok' | 'orphaned' | 'absent';

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
        'issue-routing-client`, or an older workspace) — informational only, not a failure',
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
      state: 'presumed-ok',
      recordedFingerprint: recorded.fingerprint,
      currentFingerprint: currentCaFingerprint,
      mintedAt: recorded.mintedAt,
      reason:
        'issuer fingerprint matches the current CA — the deployed routing-client cert ' +
        '(a write-only Actions secret this command cannot read) is PRESUMED signed by it, not independently verified',
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
      'every caller repo',
  };
}

// --- Routing-table artifact checks (macf#1191) ---

/**
 * Per-(repo, agent, artifact) verdict for a GitHub-plane artifact a repo's OWN
 * routing table (`.github/agent-config.json`) structurally REQUIRES to exist,
 * IN THAT SAME REPO, for the queue it implies to be reachable at all
 * (macf#1191 — `macf-science-agent` named `devops-agent` in its own routing
 * table with no `devops-agent` LABEL; that queue could never have returned
 * anything, and an empty result read as "nothing pending," not "structurally
 * incapable").
 *
 * `not-visible` is NOT a synonym for "probably missing" or a weaker flavor of
 * it. GitHub returns the identical 404 whether a repo doesn't exist, is
 * private with this caller's App not installed there, or was simply
 * misnamed — there is no status-code (or any other) discriminator between
 * "absent" and "cannot see," so this command does not attempt one. ANY
 * failure to read the artifact-existence data for a repo collapses to
 * `not-visible`, never to `missing` — reporting an unreadable repo as a
 * confirmed absence would reproduce, one level down, the exact
 * false-negative this check exists to eliminate: "same audit, same table,
 * different answers depending on who runs it" is exactly the failure mode
 * a `missing` verdict built on an inconclusive read would create.
 *
 * `config-malformed` / `config-read-failed` (macf#1193) are the REPO-LEVEL
 * siblings of `missing` / `not-visible` — not about a specific named agent,
 * but about whether the repo's OWN `.github/agent-config.json` was even
 * readable as a trustworthy routing table in the first place:
 *  - `config-malformed`   — the read succeeded but the content is broken
 *                           (bad JSON, or no usable `agents` object). A
 *                           CONFIRMED defect on a CONFIRMED participant,
 *                           same "genuinely broken, not merely unproven"
 *                           weight as `missing` — fails the verdict.
 *  - `config-read-failed` — the read failed for a transient reason
 *                           (network, rate-limit). Genuinely inconclusive,
 *                           same weight as `not-visible` — lowers coverage,
 *                           never fails the verdict.
 * Kept as DISTINCT literals rather than reusing `missing`/`not-visible`
 * outright: a config that is present-but-broken is a different KIND of
 * finding from a per-agent label gap, and this file has twice before
 * renamed a status literal specifically to stop a forced-proxy or an
 * unresolved-heuristic value from rendering indistinguishably from a
 * genuine pass (`routing_client_cert`'s `ok`→`presumed-ok`, macf#874) —
 * collapsing "the config is broken" into the same string as "this repo
 * names an agent with no matching label" would be the same mistake in the
 * opposite direction: a real defect rendering as a familiar, differently-
 * caused one. See `CONFIRMED_DEFECT_STATUSES` / `INCONCLUSIVE_STATUSES` for
 * how the verdict/coverage predicates group these WITHOUT caring which
 * literal fired.
 */
export type RoutingArtifactStatus =
  | 'present'
  | 'missing'
  | 'not-visible'
  | 'config-malformed'
  | 'config-read-failed';

/**
 * Statuses that are a CONFIRMED defect — they fail the routing-plane verdict.
 * Grouped by INTENT rather than enumerated inline at each call site so a
 * future status joins the right bucket by construction instead of requiring
 * every `.status === 'missing'`-style predicate to be found and updated by
 * hand (the exact class of silent gap macf#1193 itself is about).
 */
const CONFIRMED_DEFECT_STATUSES: ReadonlySet<RoutingArtifactStatus> = new Set([
  'missing',
  'config-malformed',
]);

/**
 * Statuses that are an INCONCLUSIVE read — they lower coverage but never fail
 * the verdict. Sibling grouping to `CONFIRMED_DEFECT_STATUSES`, above.
 */
const INCONCLUSIVE_STATUSES: ReadonlySet<RoutingArtifactStatus> = new Set([
  'not-visible',
  'config-read-failed',
]);

/**
 * Sentinel `agent` value for a config-level defect row (macf#1193) — NOT a
 * real routing label. A `config-malformed` / `config-read-failed` entry is
 * about the repo's OWN `.github/agent-config.json` as a whole, not about any
 * one named agent, so there is no real label to put here; the `status` field
 * (not this value) is what a consumer should branch on.
 */
const CONFIG_DEFECT_AGENT = '(config)';

/** Artifact name for a config-level defect row (macf#1193) — distinct from
 * `buildArtifactChecks`' per-agent artifact names (e.g. "assignment-label")
 * so a consumer can immediately tell these rows apart by `artifact` alone. */
const CONFIG_DEFECT_ARTIFACT = 'routing-config';

export interface RoutingArtifactResult {
  readonly repo: string;
  readonly agent: string;
  readonly artifact: string;
  readonly status: RoutingArtifactStatus;
  readonly reason?: string;
}

/**
 * A GitHub-plane artifact a routing-table entry structurally REQUIRES to
 * exist, IN THE SAME REPO that names it, for the queue it implies to be
 * reachable (macf#1191). The assignment label is the FIRST instance —
 * extend by appending a NEW ENTRY to `buildArtifactChecks` below, never by
 * adding a new command or a parallel sweep (the issue's own acceptance
 * criterion: "a new implied artifact is a new assertion in one place").
 */
export interface RoutingArtifactCheck {
  /** Stable name surfaced in reports, e.g. "assignment-label". */
  readonly artifact: string;
  /**
   * Fetch the repo-level existence-data ONCE per repo (e.g. the repo's label
   * names). `null` means the read FAILED for ANY reason — inaccessible,
   * deleted, network, anything — and is reported `not-visible` for every
   * agent this repo's table names, NEVER `missing`.
   */
  readonly fetchRepoState: (repo: string) => Promise<readonly string[] | null>;
  /** Whether `agent`'s artifact is present, given the fetched repo state. */
  readonly isPresent: (agent: string, repoState: readonly string[]) => boolean;
}

/** Pure per-(repo,agent) evaluator — the join `gatherRoutingArtifacts` drives. */
export function evaluateRoutingArtifact(
  repo: string,
  agent: string,
  check: RoutingArtifactCheck,
  repoState: readonly string[] | null,
): RoutingArtifactResult {
  if (repoState === null) {
    return {
      repo,
      agent,
      artifact: check.artifact,
      status: 'not-visible',
      reason: 'not visible to this caller — could be absent, private, or misnamed',
    };
  }
  if (check.isPresent(agent, repoState)) {
    return { repo, agent, artifact: check.artifact, status: 'present' };
  }
  return {
    repo,
    agent,
    artifact: check.artifact,
    status: 'missing',
    reason: `"${repo}" names "${agent}" in its routing table but has no matching ${check.artifact} — that queue is structurally unable to return work`,
  };
}

/**
 * Sweep EVERY repo visible in THIS run's install-set (the SAME `repos` list
 * the caller-pin check already fetched — no new repo-discovery mechanism)
 * against its OWN routing table (macf#1191). Repo R's own
 * `.github/agent-config.json` names the agents R routes to; each named agent
 * needs its artifacts present IN R — not in the repo this command happens to
 * run from — for R's queue to be reachable at all.
 *
 * `readRoutingConfigForRepo` (macf#1193) discriminates FOUR outcomes, and
 * this function treats each differently:
 *
 *  - `absent`      — R genuinely has no `.github/agent-config.json` (a
 *                    confident 404 on an already known-visible repo — see
 *                    `RoutingConfigReadResult`'s doc). Contributes NOTHING —
 *                    same "not a routing participant" treatment the
 *                    caller-pin sweep gives a `no-workflow` repo. A
 *                    DIFFERENT question from the `not-visible` per-agent
 *                    artifact status: this is "does R have a routing table
 *                    to audit at all"; `not-visible` is "R's table names
 *                    agent A, but the ARTIFACT read for A itself failed."
 *                    Conflating the two would make an ordinary non-fleet
 *                    repo (the overwhelming common case) show up as a
 *                    coverage gap it isn't.
 *  - `malformed`   — R's config exists but is broken (bad JSON, or no usable
 *                    `agents`). Unlike `absent`, this is a CONFIRMED defect
 *                    on a CONFIRMED participant — #1191's own `if (!config)
 *                    continue` gave this the SAME free pass an `absent` repo
 *                    gets, which is the exact gap macf#1193 closes. Emits
 *                    ONE `config-malformed` row for the repo (no per-agent
 *                    rows — a broken config names no agents to iterate).
 *  - `read-failed` — the read itself failed for a transient reason
 *                    (network, rate-limit). Genuinely inconclusive — emits
 *                    ONE `config-read-failed` row, the repo-level sibling of
 *                    a per-agent `not-visible` row: it lowers coverage
 *                    (`routing_artifacts_fully_covered`) but never fails the
 *                    verdict, and is NEVER silently dropped like `absent`.
 *  - `present`     — the pre-existing per-agent sweep (macf#1191), unchanged.
 */
export async function gatherRoutingArtifacts(
  repos: readonly string[],
  readRoutingConfigForRepo: (repo: string) => Promise<RoutingConfigReadResult>,
  checks: readonly RoutingArtifactCheck[],
): Promise<readonly RoutingArtifactResult[]> {
  const results: RoutingArtifactResult[] = [];
  for (const repo of repos) {
    const read = await readRoutingConfigForRepo(repo);

    if (read.status === 'absent') continue;

    if (read.status === 'malformed') {
      results.push({
        repo,
        agent: CONFIG_DEFECT_AGENT,
        artifact: CONFIG_DEFECT_ARTIFACT,
        status: 'config-malformed',
        reason: `"${repo}"'s .github/agent-config.json is malformed (${read.reason}) — a confirmed defect on a confirmed routing participant, not an absent routing table`,
      });
      continue;
    }

    if (read.status === 'read-failed') {
      results.push({
        repo,
        agent: CONFIG_DEFECT_AGENT,
        artifact: CONFIG_DEFECT_ARTIFACT,
        status: 'config-read-failed',
        reason: `could not read "${repo}"'s .github/agent-config.json this run (${read.reason})`,
      });
      continue;
    }

    // read.status === 'present'. Defensive `?? {}` (macf#1193): a config
    // that cleared the `malformed` shape-check (which itself already
    // rejects `agents: null`) should never reach here with a non-object
    // `agents`, but a differently-backed `readRoutingConfigForRepo`
    // implementation (a test fake, or a future production reader) could —
    // and `Object.keys(null)` throws, which this command must never do.
    const agents = Object.keys(read.config.agents ?? {});
    if (agents.length === 0) continue;
    for (const check of checks) {
      const repoState = await check.fetchRepoState(repo);
      for (const agent of agents) {
        results.push(evaluateRoutingArtifact(repo, agent, check, repoState));
      }
    }
  }
  return results;
}

/**
 * The artifact checks this run applies to every visible fleet repo's routing
 * table (macf#1191). The assignment label is the ONLY entry today — labels
 * are the CURRENT dependency a routing table has; a FUTURE implied artifact
 * (a required workflow file, a required team, anything else a routing entry
 * comes to depend on) is a NEW ENTRY appended HERE, never a new command or a
 * parallel sweep — this is the "artifact-general, not label-specific" shape
 * the issue's acceptance criteria require.
 *
 * WHY-COMMENT (do not remove, do not "improve" this into an auto-fix): this
 * check NEVER creates the missing artifact. It is report-only, by design,
 * permanently. Auto-creating a missing label would make it possible to
 * label OLD, CONCLUDED work, which then routes as though it were new —
 * `macf-science-agent#43` is the concrete precedent: a label applied
 * retroactively, ~8 weeks after the referenced work concluded and its
 * parent issue closed, caused it to route as fresh. Report the gap; let a
 * human decide whether to create the label; if they do, a SEPARATE
 * labelling pass should check the two cheap signals (months of silence, a
 * closed parent) before treating the newly-labelled issue as live — neither
 * of which this read-only audit is positioned to evaluate on its own. A
 * future patch that adds write access here must re-litigate this decision
 * explicitly, not slide it in as a "nice to have while we're in here."
 */
function buildArtifactChecks(deps: RoutingDoctorDeps): readonly RoutingArtifactCheck[] {
  return [
    {
      artifact: 'assignment-label',
      fetchRepoState: deps.listRepoLabels,
      isPresent: (agent, labels) => labels.includes(agent),
    },
    // Add a NEW entry HERE to extend to a future implied artifact (macf#1191) —
    // never a new command, never a parallel sweep.
  ];
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
  /**
   * Pin CORRECTNESS vs the fleet manifest's declared `versions.actions` (macf#872)
   * — an axis INDEPENDENT of `consistent`. Same exclusion scope as `consistent`
   * (`null` for non-members/non-callers); among participants, `evaluatePinCorrectness`'s
   * tri-state — `correct`/`incorrect` when an authoritative desired pin was resolved
   * this run, `unknown` when none was (no `--manifest`, no discoverable control repo,
   * or its `fleet.yaml` was unreadable — honest-not-asserted, NEVER a pass). See
   * `routing-doctor-pin-correctness.ts` for the full design rationale.
   */
  readonly correctness: PinCorrectnessState | null;
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
   * Back-compat boolean (schema_version:2, macf#874): `true` ONLY for a
   * genuinely-VERIFIED `ok` — never for `unresolvable` (see `selfSkipStatus`).
   * `null` covers BOTH a registry-only agent (no local config to check, #621)
   * AND an `unresolvable` local-config agent (heuristic cleared but not
   * authoritatively confirmed) — disambiguate via `inLocalConfig` +
   * `selfSkipStatus`, the same way `sessionOk`/`sessionStatus` disambiguate.
   */
  readonly selfSkipOk: boolean | null;
  /**
   * Tri-state self-skip check (macf#874): `ok` (authoritative match) / `not_ok`
   * (definite #538b/#566 fault) / `unresolvable` (heuristic cleared, no
   * authoritative login to confirm — honest-not-asserted, NEVER a pass). `null`
   * for a registry-only agent (REPO-scoped; no local config to check, #621).
   */
  readonly selfSkipStatus: SelfSkipStatus | null;
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
  /**
   * Whether the registry-published CA cert is the CURRENT local CA (macf#873,
   * silent-fallback-hazards.md Instance 16's sibling gap — check 6 compares the
   * routing-client cert's RECORDED issuer against the current CA; this compares
   * the registry's PUBLISHED CA itself, the mTLS trust anchor every agent's
   * `/health` probe uses). `false` is a DEFINITE mismatch — a rotated-out-but-
   * well-formed CA that fails every probe using it (the #872/#873 outage class).
   * `null` is honest-not-asserted (no valid registry cert to fingerprint, OR no
   * local CA on this machine) — NEVER treated as a pass by the verdict or the
   * render.
   */
  readonly matchesCurrentCa: boolean | null;
  /** SHA-256 fingerprint of the registry-published CA cert; `null` if unparseable. */
  readonly registryCaFingerprint: string | null;
  /** SHA-256 fingerprint of the CURRENT local CA cert; `null` if none on disk. */
  readonly currentCaFingerprint: string | null;
}

export interface RoutingDoctorReport {
  readonly project: string;
  readonly repoPins: readonly RepoPinRow[];
  readonly expectedPin: string | null;
  /**
   * The AUTHORITATIVE desired `macf-actions` pin (macf#872) — the fleet manifest's
   * `versions.actions`, resolved via `--manifest` override or control-repo
   * auto-discovery (see `resolveDesiredActionsPin`). Distinct from `expectedPin`,
   * which is the MODAL pin among the repos themselves (a proxy for agreement, not
   * for correctness) or an `--expected-pin` CLI override — a separate, pre-existing
   * escape hatch this field does not replace. `null` — honest unknown, never a pass
   * — when no authoritative source was reachable this run.
   */
  readonly desiredActionsPin: string | null;
  readonly hasRoutingConfig: boolean;
  readonly agents: readonly AgentRow[];
  readonly ca: CaCheckResult;
  /** #800 — routing-client cert issuer-vs-current-CA staleness check. */
  readonly routingClientCert: RoutingClientCertCheckResult;
  /**
   * Routing-table artifact checks (macf#1191) — one entry per (repo, agent,
   * artifact) across EVERY repo visible in this run's install-set, not just
   * the repo this command happens to run from. See `gatherRoutingArtifacts`.
   */
  readonly artifactChecks: readonly RoutingArtifactResult[];
  /**
   * How many repos THIS run's install-set enumerated (macf#1191) — the
   * coverage figure for the artifact-check sweep. NOT a claim about the
   * total fleet size: an App installed on a handful of repos sees a
   * handful; a differently-scoped caller sees a different number. A
   * `0 missing` reading from `artifactChecks` must always be read alongside
   * this number, which is why it is carried in the summary line and JSON on
   * every run — clean or not.
   */
  readonly reposVisible: number;
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
  /**
   * Read ANY visible repo's `.github/agent-config.json` (macf#1191) — unlike
   * `readRoutingConfig` (the CURRENT project only), this is called once per
   * repo in the install-set so the artifact sweep can audit repos this
   * command is not running from. A discriminated `RoutingConfigReadResult`
   * (macf#1193), NOT a plain `RoutingConfig | null`: `absent` (a confident
   * 404 on this ALREADY known-visible repo) is the SAME "not a routing
   * participant" treatment the caller-pin sweep gives a `no-workflow` repo —
   * silently skipped by `gatherRoutingArtifacts`; `malformed` is a CONFIRMED
   * defect on a CONFIRMED participant (fails the verdict); `read-failed`
   * (network/rate-limit/transient) is a genuine unknown (lowers coverage,
   * never fails the verdict). All three are DIFFERENT from the `not-visible`
   * artifact status (that applies to the per-agent ARTIFACT read, e.g.
   * `listRepoLabels`, never to this config read itself). See
   * `RoutingConfigReadResult`'s doc for the full rationale — the prior
   * `RoutingConfig | null` contract collapsed all three into one, which was
   * the exact gap #1193 closes.
   */
  readonly readRoutingConfigForRepo: (repo: string) => Promise<RoutingConfigReadResult>;
  /**
   * List a repo's label names (macf#1191's assignment-label artifact check).
   * `null` on ANY read failure — this command does not attempt to
   * distinguish "repo inaccessible to this caller" from "repo doesn't
   * exist" from "some other error" (GitHub's API does not either — see
   * `RoutingArtifactStatus`'s doc). Reported `not-visible`, never `missing`.
   */
  readonly listRepoLabels: (repo: string) => Promise<readonly string[] | null>;
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
  /**
   * Resolve the AUTHORITATIVE desired `macf-actions` pin for the pin-CORRECTNESS
   * check (macf#872) — takes the ALREADY-FETCHED install-set (the same list
   * `listRepos()` returned this run) so control-repo auto-discovery costs no extra
   * `gh api` round-trip. Omit (or resolve to `null`) to render `correctness` as
   * `unknown` for every participating repo — the honest default for any fleet with
   * no reachable `fleet.yaml` (most of today's substrate predates `macf bootstrap
   * apply` entirely). NEVER throws.
   */
  readonly desiredActionsPin?: (repos: readonly string[]) => Promise<string | null>;
  /** Clock for the heartbeat-TTL staleness math (defaults to `Date.now()`). */
  readonly now?: number;
}

/**
 * Resolve fleet membership (#614, opt-out) per pinned repo, then build the RepoPinRow
 * list. The modal/expected pin AND each `consistent` flag are scoped to FLEET-MEMBER
 * pinned repos only — a non-member's divergent pin neither pulls the modal nor flips
 * the verdict. Non-callers AND opted-out callers both get `consistent: null` (excluded).
 *
 * `desiredPin` (macf#872) drives the INDEPENDENT `correctness` axis — same member
 * scoping as `consistent`, but compared against the AUTHORITATIVE manifest value
 * (or `null`/unknown) rather than the modal.
 */
async function resolveRepoPins(
  pinResults: readonly CallerPinResult[],
  readFleetMarker: (repo: string) => Promise<FleetMarker | null>,
  expectedPinOverride: string | undefined,
  desiredPin: string | null,
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
      correctness: member ? evaluatePinCorrectness(r.pin, desiredPin) : null,
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
  // The probe is isolated (macf#959, mirrors `fleet.ts`'s `safeProbe` /
  // macf#609): a REJECTED probe (a transient network fault — the same
  // TOCTOU-style rejection `safeProbe` guards against) must degrade ONLY
  // this agent's row to unreachable, never escape `evaluateAgentRow` and
  // abort the whole per-agent loop in `gatherRoutingDoctor` below. Before
  // this fix, that rejection propagated all the way out of `runRoutingDoctor`
  // uncaught — the exact "Error: fetch failed", no table, no per-agent
  // verdict" symptom macf#959 reported for `macf routing doctor`.
  let freshness: FreshnessState = 'unregistered';
  let healthInstanceId: string | null | undefined;
  if (info) {
    const health = await deps.probe(info.host, info.port).catch(() => null);
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
    selfSkipOk: selfSkip ? selfSkipStatusToBackCompatBool(selfSkip.status) : null,
    selfSkipStatus: selfSkip ? selfSkip.status : null,
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
  // macf#872: the AUTHORITATIVE desired pin (fleet manifest `versions.actions`) —
  // resolved from the SAME install-set just fetched, so control-repo auto-discovery
  // costs no extra round-trip. `null` (no dep injected, or none resolved) → every
  // participating repo's `correctness` reads `unknown`, never a pass.
  const desiredActionsPin = (await deps.desiredActionsPin?.(repos)) ?? null;
  const { repoPins, expectedPin } = await resolveRepoPins(
    pinResults,
    deps.readFleetMarker,
    deps.expectedPin,
    desiredActionsPin,
  );

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

  // Single local-CA-fingerprint read, shared by check 4 (registry CA currency,
  // #873) and check 6 (routing-client cert issuer staleness, #800) — do NOT add
  // a second local-CA read path.
  const currentCaFp = deps.currentCaFingerprint();

  // 4. CA material — present/valid (#563) AND, extended #873, CURRENT.
  const ca = evaluateCaCert(await deps.readCaCert(), currentCaFp);

  // 6. Routing-client cert issuer staleness (#800) — a project-level check,
  // like CA material, not per-agent/per-repo.
  const routingClientCert = evaluateRoutingClientCertIssuer(
    await deps.readRoutingClientCertIssuer(),
    currentCaFp,
  );

  // 7. Routing-table artifact checks (macf#1191) — over the SAME install-set
  // `repos` already fetched for check 1, no extra repo-discovery round-trip.
  const artifactChecks = await gatherRoutingArtifacts(
    repos,
    deps.readRoutingConfigForRepo,
    buildArtifactChecks(deps),
  );

  return {
    project: deps.project,
    repoPins,
    expectedPin,
    desiredActionsPin,
    hasRoutingConfig,
    agents,
    ca,
    routingClientCert,
    artifactChecks,
    reposVisible: repos.length,
  };
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
 * constrains a locally-configured agent (`selfSkipOk === false` is the #566 fault) but
 * `null` self-skip does NOT fail — that covers BOTH a registry-only agent (honest-not-
 * asserted, no local config) AND an `unresolvable` local-config agent (macf#874: the
 * #566 heuristic cleared but no authoritative login confirmed it — a genuine unknown,
 * not a proven fault; `unresolvable` must not fail the verdict any more than the
 * pre-existing "no local config" `null` does, or a peer this check can never fully
 * verify would DEGRADE the plane on every run). The SESSION-name drift is deliberately EXCLUDED (DR-032 §6th-surface
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

/**
 * Whether the CA-material check passes: present + parses (#563) AND, extended
 * #873, matches the CURRENT local CA when that's known. `matchesCurrentCa ===
 * null` (honest-not-asserted — no local CA to compare against) does NOT fail;
 * only a DEFINITE mismatch (`=== false`) does. Shared by the verdict, the JSON
 * `summary.ca_ok`, and `summaryLine` so the three surfaces can't drift apart.
 */
function caCheckOk(ca: CaCheckResult): boolean {
  return ca.present && ca.valid && ca.matchesCurrentCa !== false;
}

/**
 * Whether the routing-table artifact sweep FAILS the verdict (macf#1191,
 * extended macf#1193). Only a CONFIRMED defect fails —
 * `CONFIRMED_DEFECT_STATUSES` (`missing` + `config-malformed`) — an
 * INCONCLUSIVE read never does: an App legitimately installed on a subset of
 * fleet repos is normal, and failing the verdict on every repo this caller
 * merely couldn't see (or whose config read merely timed out) would make the
 * check permanently red for any narrow-scoped caller, which gets ignored —
 * reproducing the exact "always red, so nobody reads it" failure mode this
 * whole command exists to avoid. Inconclusive entries are still surfaced
 * (never silently dropped) via `reposVisible` + the dedicated summary clause
 * / JSON fields — see `artifactSummaryClause`.
 */
function routingArtifactsFail(results: readonly RoutingArtifactResult[]): boolean {
  return results.some((r) => CONFIRMED_DEFECT_STATUSES.has(r.status));
}

/** `false` only on a CONFIRMED defect — mirrors `routingArtifactsFail`, exposed as JSON `summary.routing_artifacts_ok`. */
function routingArtifactsOk(results: readonly RoutingArtifactResult[]): boolean {
  return !routingArtifactsFail(results);
}

/**
 * `false` when ANY entry's read was INCONCLUSIVE this run (macf#1191,
 * extended macf#1193 — `INCONCLUSIVE_STATUSES`: `not-visible` +
 * `config-read-failed`). Distinct from `routingArtifactsOk`: a run can be
 * `ok` (no CONFIRMED defect) while NOT `fully_covered` (some repo's data, or
 * some repo's own config, this caller simply couldn't read) — that
 * combination is exactly the "clean but narrow" case a consumer must not
 * collapse into an unqualified pass. See `artifactSummaryClause` for the
 * human-readable rendering of the same distinction. A `config-malformed`
 * entry does NOT lower this — the read SUCCEEDED (the config is present and
 * broken, not unread), so it stays a pure `routingArtifactsOk` failure with
 * coverage unaffected; that is what keeps the malformed and read-failed
 * cases mutually distinguishable on this axis too.
 */
function routingArtifactsFullyCovered(results: readonly RoutingArtifactResult[]): boolean {
  return !results.some((r) => INCONCLUSIVE_STATUSES.has(r.status));
}

export function routingVerdict(report: RoutingDoctorReport): RoutingVerdict {
  if (report.repoPins.length === 0 && report.agents.length === 0) return 'EMPTY';
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const pinFail = participating.some((r) => !r.consistent);
  const agentFail = report.agents.some((a) => !agentRoutingOk(a));
  const caFail = !caCheckOk(report.ca);
  const routingClientCertFail = routingClientCertFails(report.routingClientCert);
  const artifactFail = routingArtifactsFail(report.artifactChecks);
  return pinFail || agentFail || caFail || routingClientCertFail || artifactFail ? 'DEGRADED' : 'HEALTHY';
}

/**
 * Whether a DEFINITE CA mismatch (`matchesCurrentCa === false`) is plausibly the
 * ROOT CAUSE of broad agent unreachability (macf#873 — the absorption half of
 * the fix, not just the comparison half). The registry CA is the mTLS trust
 * anchor for every `/health` probe (`resolveDepsFromRegistry`); a rotated-out
 * cert fails EVERY probe using it, and each downstream check independently
 * declines to fail on that alone (`freshnessFails` only fails `'stale'`;
 * `routable` only checks the registry key exists) — see the module doc + #872.
 *
 * Deliberately counts only `'unreachable'`, NOT `'stale'`: a `'stale'` agent
 * already fails the verdict on its own via `freshnessFails`, so the causal line
 * is most valuable exactly where nothing ELSE in the table would explain a
 * DEGRADED (or, pre-#873, a false-HEALTHY) verdict.
 *
 * Threshold: at least HALF the checked agents unreachable — "a majority, or
 * all" per the issue's framing (`unreachable * 2 >= total`, so N/N and a bare
 * majority both qualify). `total === 0` never triggers it.
 */
export function caMismatchLikelyCause(report: RoutingDoctorReport): boolean {
  if (report.ca.matchesCurrentCa !== false) return false;
  const total = report.agents.length;
  if (total === 0) return false;
  const unreachable = report.agents.filter((a) => a.freshness === 'unreachable').length;
  return unreachable * 2 >= total;
}

/**
 * The causal-attribution line (macf#873's absorption fix): states the CA
 * mismatch is the LIKELY CAUSE of the unreachable agents, with both
 * fingerprints, instead of leaving a lone CA ✗ and N independent agent ✗/?
 * marks for a reader to correlate by hand. `null` when `caMismatchLikelyCause`
 * doesn't hold — a mismatch with agents otherwise reachable (or broad
 * unreachability with a matching CA) still renders as a plain CA ✗ line / plain
 * freshness column, never an unsupported causal claim.
 */
export function caMismatchCauseLine(report: RoutingDoctorReport): string | null {
  if (!caMismatchLikelyCause(report)) return null;
  const total = report.agents.length;
  const unreachable = report.agents.filter((a) => a.freshness === 'unreachable').length;
  return (
    `CA MISMATCH is the likely cause of ${unreachable}/${total} agents unreachable ` +
    `(registry CA fingerprint ${report.ca.registryCaFingerprint ?? 'unknown'} != ` +
    `current CA ${report.ca.currentCaFingerprint ?? 'unknown'})`
  );
}

/**
 * The routing-table-artifact clause (macf#1191, extended macf#1193). ALWAYS
 * carries the coverage figure (`reposVisible`) — on a fully clean run too —
 * so "0 missing" can never be misread as "checked the whole fleet." A repo
 * this caller could not read contributes to a `not visible` count that is
 * surfaced here as well, distinct from `missing`: it does NOT fail the
 * verdict (see `routingArtifactsFail`'s doc), but it must never read like
 * "all clear" either. `config malformed` / `config unreadable` (macf#1193)
 * are the repo-level siblings of those two, called out with their OWN words
 * rather than folded into `missing`/`not visible` silently — a reader must
 * be able to tell "a repo names an agent with no matching label" apart from
 * "a repo's OWN routing table is broken/unreadable" from this line alone.
 */
function artifactSummaryClause(report: RoutingDoctorReport): string {
  const missing = report.artifactChecks.filter((r) => r.status === 'missing').length;
  const notVisible = report.artifactChecks.filter((r) => r.status === 'not-visible').length;
  const configMalformed = report.artifactChecks.filter((r) => r.status === 'config-malformed').length;
  const configReadFailed = report.artifactChecks.filter((r) => r.status === 'config-read-failed').length;
  const coverage = `${report.reposVisible} repo(s) visible to this caller`;
  if (missing === 0 && notVisible === 0 && configMalformed === 0 && configReadFailed === 0) {
    return `routing-table artifacts ✓ (${coverage})`;
  }
  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} missing`);
  if (configMalformed > 0) parts.push(`${configMalformed} config malformed`);
  if (notVisible > 0) parts.push(`${notVisible} not visible`);
  if (configReadFailed > 0) parts.push(`${configReadFailed} config unreadable`);
  return `routing-table artifacts ✗ ${parts.join(', ')} (of ${coverage})`;
}

/**
 * `4 fleet repos (pins consistent + current ("v3.4.2")); 3 agents (2 routing-OK);
 * CA ✓; routing-client cert ✓; routing-table artifacts ✓ (4 repo(s) visible to
 * this caller); routing plane: HEALTHY`.
 *
 * macf#872: the pin clause's parenthetical is driven by `classifyPinState` — NOT a
 * plain `pinsOk` boolean — so `consistent-but-wrong` and `unknown` replace "pins
 * consistent" IN PLACE rather than being appended as a separate line a reader could
 * miss. This is the fix for the composite-verdict-overstatement half of #872: the
 * exit code / HEALTHY-DEGRADED literal is untouched (warn-never-fail — see
 * `routing-doctor-pin-correctness.ts`), but the text a human actually reads can no
 * longer claim "pins consistent" while the fleet is uniformly stale or the manifest
 * was unreachable. macf#1191 extends the same "the text must not overclaim"
 * discipline to the artifact-coverage clause: `artifactSummaryClause` always
 * carries the coverage count, never just a bare pass/fail.
 */
export function summaryLine(report: RoutingDoctorReport): string {
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const agentOk = report.agents.filter(agentRoutingOk).length;
  const pinClause =
    participating.length > 0
      ? `${participating.length} routing repo(s) (${pinClauseText(classifyPinState(report), report.desiredActionsPin)})`
      : 'no routing-caller repos discovered';
  return (
    `${pinClause}; ${agentOk}/${report.agents.length} agents routing-OK; ` +
    `CA ${caCheckOk(report.ca) ? '✓' : '✗'}; routing-client cert ${routingClientCertGlyph(report.routingClientCert.state)}; ` +
    `${artifactSummaryClause(report)}; ` +
    `routing plane: ${routingVerdict(report)}`
  );
}

/**
 * Non-verdict-driving observations the watchdog should still SEE (DR-032 #610).
 * Currently: the session-name drift (`warn`) — visible, but it does NOT flip the
 * verdict (the known-pending session-rename migration) — and (macf#872) a fleet
 * that is UNIFORMLY stale against the manifest: `consistent-but-wrong` doesn't
 * fail the verdict either (warn-never-fail), so it needs the same loud-but-
 * non-fatal visibility. Surfaced additively in the JSON `warnings[]` and the
 * text-render warnings block.
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
  const pinWarning = pinCorrectnessWarning(report);
  if (pinWarning) out.push(pinWarning);
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

/**
 * Routing-client cert issuer state → glyph: presumed-ok ✓ presumed (macf#874 —
 * the deployed secret can't be read, so this can never render as a plain
 * unqualified ✓ pass), orphaned ✗ (macf#800), absent — (informational).
 */
export function routingClientCertGlyph(s: RoutingClientCertIssuerState): string {
  switch (s) {
    case 'presumed-ok':
      return '✓ presumed';
    case 'orphaned':
      return '✗ orphaned';
    case 'absent':
      return '— n/a';
  }
}

/** First 12 hex chars + ellipsis for compact fingerprint display; 'unknown' when absent. */
function shortFingerprint(fp: string | null): string {
  return fp ? `${fp.slice(0, 12)}…` : 'unknown';
}

/**
 * The `MACF_CA_CERT` status line (#563 present/valid + macf#873 current-CA
 * match). The `matchesCurrentCa === null` case renders DISTINCTLY from a pass
 * (`— n/a`, never `✓`) — honest-not-asserted must never read as success.
 */
export function caCertLine(ca: CaCheckResult): string {
  if (!ca.present) return 'MACF_CA_CERT: ✗ absent';
  if (!ca.valid) return `MACF_CA_CERT: ✗ ${ca.reason}`;
  if (ca.matchesCurrentCa === false) {
    return (
      `MACF_CA_CERT: ✗ present + parses but does NOT match the current CA — ` +
      `registry ${shortFingerprint(ca.registryCaFingerprint)} != current ${shortFingerprint(ca.currentCaFingerprint)}`
    );
  }
  if (ca.matchesCurrentCa === null) {
    return 'MACF_CA_CERT: ✓ present + parses — n/a current-CA check (no local CA to compare)';
  }
  return `MACF_CA_CERT: ✓ present + parses + matches current CA (${shortFingerprint(ca.currentCaFingerprint)})`;
}

/**
 * Self-skip status → glyph: ok ✓, not_ok ✗, unresolvable `? unresolved` (macf#874 —
 * distinct from BOTH a pass and the registry-only `— n/a`; a reader must not be able
 * to mistake "heuristic cleared, unconfirmed" for either "verified good" or "not
 * applicable here").
 */
export function selfSkipGlyph(s: SelfSkipStatus): string {
  switch (s) {
    case 'ok':
      return '✓';
    case 'not_ok':
      return '✗';
    case 'unresolvable':
      return '? unresolved';
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
    // null status = no local config to assert, distinct from both a pass AND the
    // `unresolvable` "checked but couldn't confirm" state (macf#874).
    a.selfSkipStatus === null ? '— n/a' : selfSkipGlyph(a.selfSkipStatus),
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

const ARTIFACT_HEADERS = ['REPO', 'AGENT', 'ARTIFACT', 'STATUS', 'REASON'] as const;

/**
 * Glyph per `RoutingArtifactStatus` (macf#1191, extended macf#1193). Written
 * as an EXHAUSTIVE switch (not a ternary) deliberately: a ternary over two
 * literals silently renders any FUTURE status as whichever branch it falls
 * into, with no compiler signal — the exact "a new status joins silently"
 * gap `CONFIRMED_DEFECT_STATUSES`/`INCONCLUSIVE_STATUSES` already close for
 * the verdict/coverage predicates. A switch missing a case fails to compile
 * once `RoutingArtifactStatus` gains another literal, so this render surface
 * gets the same "can't forget a branch" guarantee.
 */
function artifactStatusGlyph(status: RoutingArtifactStatus): string {
  switch (status) {
    case 'present':
      return '✓';
    case 'missing':
      return '✗ missing';
    case 'not-visible':
      return '? not-visible';
    case 'config-malformed':
      return '✗ malformed';
    case 'config-read-failed':
      return '? unreadable';
  }
}

/**
 * Only non-`present` rows (macf#1191) — mirrors `collectWarnings`' "only show
 * if any" shape: a fully-satisfied sweep renders NOTHING here (the coverage
 * figure still appears in `summaryLine`/JSON regardless), so a real gap is
 * never buried in a wall of green rows for a large fleet.
 */
export function buildArtifactRows(results: readonly RoutingArtifactResult[]): readonly (readonly string[])[] {
  return results
    .filter((r) => r.status !== 'present')
    .map((r) => [r.repo, r.agent, r.artifact, artifactStatusGlyph(r.status), r.reason ?? '']);
}

export function formatArtifactTable(results: readonly RoutingArtifactResult[]): string {
  return formatTable(ARTIFACT_HEADERS, buildArtifactRows(results));
}

/**
 * The honesty legend — these are STATIC GitHub-plane checks: they prove the
 * routing PLUMBING is wired right, NOT that a message was delivered (that is
 * `--e2e`, a later increment). Carried verbatim in the `--json` `disclaimer`.
 */
export const HONESTY_LEGEND = [
  'Legend: CALLER-PIN = the macf-actions @version each routing repo pins (must all match).',
  '        A repo opts OUT of the pin check via .github/macf-fleet.json {"routing_fleet":false}',
  '        (e.g. an intentional-Stage-2 test harness); absent marker = fleet member.',
  '        PIN CORRECTNESS is a SECOND, independent axis: CALLER-PIN/CONSISTENT above only prove',
  '        the repos agree with EACH OTHER — a fleet uniformly stale on the same wrong pin still',
  '        reads consistent. PIN CORRECTNESS compares that shared pin against the fleet manifest\'s',
  '        declared versions.actions (an operator --manifest, or auto-discovered from the control',
  '        repo already in this run\'s install-set); ✓ current / ✗ STALE / ? unknown (no manifest',
  '        reachable — never treated as a pass). WARN-not-FAIL: a STALE reading does not flip the',
  '        verdict, but replaces "pins consistent" in the summary line so it cannot read as healthy.',
  '        ROUTABLE = a MACF_AGENT_<LABEL> registry key exists (router resolves by LABEL).',
  '        SELF-SKIP = agent-config.json app_name is the bot-LOGIN, not the bare label. ✓ = an',
  '        authoritative login confirmed it; ✗ = a definite fault (missing/bare-label/mismatch);',
  '        "? unresolved" = the known-bad shape was ruled out but no authoritative login was',
  '        available to confirm it — honestly unresolved, NOT a pass (does not fail the verdict).',
  '        SESSION = agent-config.json tmux_session follows <project>@<routing-label> (assert-IF-',
  '                  PRESENT: absent = PASS, vestigial + omitted on v3; ⚠ warn = stale drift,',
  '                  WARN-not-FAIL — visible but does NOT drive the verdict, pending a session-rename migration).',
  '                  FRESH = registry instance_id == live /health instance_id (✗ stale / ? unreach).',
  '        The agent set is the registry fleet ∪ this repo\'s routing config: a registry-only',
  '        agent (one this repo does not route to, e.g. the auditor) shows "— n/a" SELF-SKIP/SESSION',
  '        (REPO-scoped, no local config) but is still ROUTABLE/FRESH-checked (FLEET-scoped).',
  '        MACF_CA_CERT = the registry-published CA is present + parses AND matches the',
  '        CURRENT local CA — the mTLS trust anchor for every /health probe; a rotated-',
  '        out-but-well-formed CA fails every probe silently, so a definite mismatch fails the',
  '        verdict and, when most/all agents read unreachable, is reported as the LIKELY CAUSE',
  '        rather than a separate line. — n/a = no local CA on this machine to compare (not a fail).',
  '        ROUTING-CLIENT CERT = the recorded issuer fingerprint (written by `macf certs',
  '        issue-routing-client`) vs the CURRENT project CA (local disk); the deployed cert ITSELF',
  '        is a write-only secret this command cannot read, so ✓ presumed = the recorded issuer',
  '        matches, NOT an independent verification of the deployed cert. ✗ orphaned = signed by a',
  '        rotated-out CA (re-mint + re-set the secret); — n/a = never minted, informational only.',
  '        ROUTING-TABLE ARTIFACTS = for every repo visible in this run (not only the repo this',
  '        command runs from), does that repo\'s OWN agent-config.json name an agent it has no',
  '        matching GitHub label for? A repo naming an agent with no such label has a queue that',
  '        can never return work — ✗ missing fails the verdict. "not visible" means this caller',
  '        could not read that repo\'s data at all (absent, private, or misnamed are indistinguishable',
  '        from here) and does NOT fail the verdict, but is never silently dropped either. The',
  '        coverage count is how many repos THIS caller could see this run — not a claim about the',
  '        total fleet size; a narrow-coverage clean run is reported as narrow, not as "all clear."',
  '        A repo\'s OWN agent-config.json can also be present but BROKEN: "config malformed" is a',
  '        confirmed defect (bad JSON, or no usable agents object) on a confirmed participant and',
  '        FAILS the verdict, same as a missing label — the read succeeded, so coverage is unaffected.',
  '        "config unreadable" means the read itself failed this run (network, rate-limit) — the same',
  '        inconclusive weight as "not visible": it lowers the coverage count but does NOT fail the',
  '        verdict, and is never silently dropped. A repo with NO agent-config.json at all is simply',
  '        not a routing participant and is not shown here.',
  '        This check is READ-ONLY — it never creates a missing label.',
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
 *
 * Bumped 1→2 for macf#873: `summary.ca_ok` gets a SAME-NAME SEMANTIC shift — it
 * now also fails on a definite `matches_current_ca:false` (previously it only
 * reflected present+valid), so a consumer trusting the OLD "ca_ok:true always
 * means present+valid" contract needs to know the meaning changed, not just
 * that new fields were added.
 *
 * Bumped 2→3 for macf#874, two SAME-NAME SEMANTIC shifts from the doctor-check
 * completeness audit (#872):
 *  - `agents[].self_skip_ok`: `true` previously meant "the #566 known-bad shape
 *    was ruled out" (a heuristic could reach `true` without ever confirming the
 *    correct value); it now means "an authoritative bot-login verified the
 *    match" — the unresolved-heuristic case reports `null` (see the new
 *    `self_skip_status` field for the full tri-state).
 *  - `routing_client_cert.state`: the passing literal renamed `"ok"` →
 *    `"presumed-ok"` — the deployed cert is a write-only secret this command
 *    cannot read, so the old `"ok"` literal read as a verification it never
 *    was. A consumer string-matching `state === "ok"` needs to know the
 *    literal changed, not just that the underlying check got stricter.
 *
 * Bumped 3→4 for macf#1191: unlike the earlier additive checks (#800's
 * routing-client cert, DR-032's session drift), the routing-table artifact
 * sweep is a NEW failure mode that feeds the EXISTING `summary.verdict`
 * field — a run that previously computed HEALTHY can now compute DEGRADED
 * under a condition no prior schema version checked for (a repo naming an
 * agent it has no matching label for). A consumer trusting "HEALTHY under
 * schema_version:3 means these N specific checks all passed" needs to know
 * a caller-pin-fresh CA-and-cert-clean run can still be DEGRADED now, not
 * just that new fields were added alongside an unchanged verdict formula.
 *
 * Bumped 4→5 for macf#1193, applying the SAME test #1191 used for its own
 * 3→4 bump — a new failure mode feeding the EXISTING `summary.verdict` — to
 * a gap inside #1191's own fix: a MALFORMED `.github/agent-config.json` on a
 * fleet repo previously collapsed to the identical "not a routing
 * participant, contributes nothing" free pass an ABSENT one gets. Three
 * same-name-or-adjacent shifts:
 *  - `summary.routing_artifacts_ok`: now ALSO `false` when any repo's OWN
 *    config is `config-malformed` — a run that was schema_version:4-HEALTHY
 *    under a fleet repo with a broken routing table can now compute
 *    DEGRADED, a condition schema_version:4 never checked for.
 *  - `summary.routing_artifacts_fully_covered`: now ALSO `false` when any
 *    repo's OWN config read was `config-read-failed` — additive in spirit
 *    (a schema_version:4 consumer already treated this field as
 *    non-verdict-failing coverage information), but the SET of things that
 *    can lower it grew, so it is called out here rather than left implicit.
 *  - `routing_artifacts[].status` gains two new literals (`config-malformed`,
 *    `config-read-failed`) a consumer switching on the string must know
 *    about — the SAME "a consumer string-matching on the literal needs to
 *    know it changed" reasoning the 2→3 bump used for
 *    `routing_client_cert.state`'s `"ok"` → `"presumed-ok"` rename.
 * Two NEW additive-only count fields (`routing_artifacts_config_malformed`,
 * `routing_artifacts_config_read_failed`) are added alongside the bump —
 * additive fields don't force a bump on their own, but they ride with this
 * one since it's already happening for the reasons above. Deliberately NOT
 * folded into the EXISTING `routing_artifacts_missing` / `_not_visible`
 * counts: doing so would keep the field NAMES stable but silently widen
 * what each one MEANS (a consumer reading `routing_artifacts_missing` today
 * expects "a per-agent label gap count," not "a per-agent label gap PLUS an
 * unrelated repo-level defect count") — the strongest reading of "do not
 * weaken #1192/#1191's existing counts."
 */
export const ROUTING_DOCTOR_JSON_SCHEMA_VERSION = 5;

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
      // Additive under schema_version:3, no further bump (macf#872 — new field, no
      // existing field's meaning shifted): the fleet-level composite crossing
      // CONSISTENCY with CORRECTNESS vs the manifest — see `classifyPinState`.
      // `pins_consistent:true` alone can NOT distinguish `consistent-and-correct`
      // from `consistent-but-wrong`; a consumer that cares about correctness (not
      // just agreement) must read THIS field, not `pins_consistent`.
      pin_state: classifyPinState(report),
      // Additive under schema_version:3, no further bump (macf#872): the
      // AUTHORITATIVE desired pin this run resolved (`--manifest` override or
      // control-repo auto-discovery); `null` when none was reachable — the
      // honest-unknown floor `pin_state:"unknown"` reflects.
      desired_actions_pin: report.desiredActionsPin,
      agents_total: report.agents.length,
      agents_routing_ok: report.agents.filter(agentRoutingOk).length,
      // Semantic shift (schema_version:2, macf#873): also false on a definite
      // `matches_current_ca:false` — see caCheckOk + the schema_version doc.
      ca_ok: caCheckOk(report.ca),
      // Additive (schema_version:1, #800): false only for the verdict-failing
      // `orphaned` state; `absent` (never minted) counts as true (not a fault).
      routing_client_cert_ok: !routingClientCertFails(report.routingClientCert),
      // New (schema_version:4, macf#1191): `false` only on a CONFIRMED `missing`
      // artifact — see `routingArtifactsFail`'s doc for why `not-visible` alone
      // does not flip this. Extended macf#1193 (schema_version:5): also `false`
      // on a `config-malformed` entry — see `CONFIRMED_DEFECT_STATUSES`.
      routing_artifacts_ok: routingArtifactsOk(report.artifactChecks),
      // New (schema_version:4, macf#1191): the coverage figure — how many repos
      // THIS run's install-set enumerated. ALWAYS present, even when
      // `routing_artifacts_ok` is true, so a consumer can never read a clean
      // `true` as "the whole fleet was checked" without also seeing the count
      // it was checked against.
      routing_artifacts_repos_visible: report.reposVisible,
      routing_artifacts_missing: report.artifactChecks.filter((r) => r.status === 'missing').length,
      routing_artifacts_not_visible: report.artifactChecks.filter((r) => r.status === 'not-visible').length,
      // New (schema_version:5, macf#1193): a repo's OWN `.github/agent-config.json`
      // being present-but-broken — a CONFIRMED defect, distinct from
      // `routing_artifacts_missing` (a per-agent label gap on an otherwise-usable
      // config). Folds into `routing_artifacts_ok` (see `CONFIRMED_DEFECT_STATUSES`),
      // but kept as its OWN count rather than added into `_missing` so that
      // field's literal meaning ("a per-agent label gap") does not silently widen.
      routing_artifacts_config_malformed: report.artifactChecks.filter((r) => r.status === 'config-malformed').length,
      // New (schema_version:5, macf#1193): the repo-level analogue of
      // `routing_artifacts_not_visible` — a repo whose OWN config this run could
      // not read for any OTHER reason (network, rate-limit, a transient error).
      // Folds into `routing_artifacts_fully_covered` (see `INCONCLUSIVE_STATUSES`),
      // kept as its own count for the same reason `_config_malformed` is above.
      routing_artifacts_config_read_failed: report.artifactChecks.filter((r) => r.status === 'config-read-failed')
        .length,
      // New (schema_version:4, macf#1191): `false` whenever ANY repo's artifact
      // data could not be read this run — independent of `routing_artifacts_ok`,
      // which only reflects CONFIRMED failures. A consumer that only checks
      // `routing_artifacts_ok` can miss a narrow-coverage run; this field is the
      // one that must be read alongside it for the "not all clear" guarantee.
      // Extended macf#1193 (schema_version:5) to also go `false` on a
      // `config-read-failed` entry — see the schema_version doc.
      routing_artifacts_fully_covered: routingArtifactsFullyCovered(report.artifactChecks),
    },
    // Additive (schema_version:1, DR-032 #610): non-verdict-driving observations the
    // watchdog should still SEE — currently the session-name drift (WARN-not-FAIL).
    warnings: collectWarnings(report),
    // Additive (schema_version:1, #614): pinned repos that opted OUT of the fleet via
    // `.github/macf-fleet.json` routing_fleet:false (excluded from pins_consistent).
    non_fleet_repos: collectNonFleetRepos(report),
    // New (schema_version:4, macf#1191): one entry per (repo, agent, artifact)
    // across every repo visible in this run's install-set — the full detail
    // behind the `routing_artifacts_*` summary counts above. `status` is one of
    // "present" / "missing" / "not-visible" / "config-malformed" /
    // "config-read-failed" (the last two added schema_version:5, macf#1193 —
    // repo-level rows, `agent`/`artifact` carry the sentinel documented on
    // `CONFIG_DEFECT_AGENT`/`CONFIG_DEFECT_ARTIFACT`); see `RoutingArtifactStatus`'s
    // doc for why none of these five are ever collapsed into another.
    routing_artifacts: report.artifactChecks.map((r) => ({
      repo: r.repo,
      agent: r.agent,
      artifact: r.artifact,
      status: r.status,
      reason: r.reason ?? null,
    })),
    caller_pins: report.repoPins.map((r) => ({
      repo: r.repo,
      pin: r.pin,
      status: r.status,
      // Additive (schema_version:1, #614): true = participates in pins_consistent.
      fleet_member: r.fleetMember,
      consistent: r.consistent,
      // Additive under schema_version:3, no further bump (macf#872): correctness
      // vs the manifest, INDEPENDENT of `consistent`. `null` for the same
      // exclusions as `consistent`; among participants, `"unknown"` when no
      // authoritative desired pin was reachable — never collapsed into a pass.
      correctness: r.correctness,
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
      // Semantic shift (schema_version:3, macf#874): `true` only for a
      // VERIFIED match — see the schema_version doc comment.
      self_skip_ok: a.selfSkipOk,
      // New (schema_version:3, macf#874): the full tri-state driving
      // `self_skip_ok` — `"unresolvable"` is the honest-not-asserted case a
      // consumer reading only the boolean can't distinguish from "no local
      // config" (both render `self_skip_ok: null`); disambiguate via
      // `in_local_config` + this field.
      self_skip_status: a.selfSkipStatus,
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
      // New (schema_version:2, macf#873): registry-CA-vs-current-CA comparison.
      // `matches_current_ca:false` is a DEFINITE mismatch (fails the verdict via
      // caFail); `null` is honest-not-asserted and never reads as a pass.
      matches_current_ca: report.ca.matchesCurrentCa,
      registry_fingerprint: report.ca.registryCaFingerprint,
      current_fingerprint: report.ca.currentCaFingerprint,
      // The absorption fix (macf#873): explicit causal attribution when the
      // mismatch is plausibly WHY most/all agents read unreachable, instead of
      // two independent lines a consumer has to correlate by hand.
      likely_cause_of_unreachability: caMismatchLikelyCause(report),
      cause_line: caMismatchCauseLine(report),
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
    // WHY (groundnuty/macf#1193 follow-up): `typeof null === 'object'`, so the
    // shape check alone admits `agents: null` and a consumer reaching
    // `Object.keys(null)` throws. The REMOTE reader rejects that explicitly;
    // this local one was safe only because its two callers happen to write
    // `?? {}`. A safety that holds by coincidence across call sites breaks the
    // day someone adds a third. Aligned with the remote guard so the invariant
    // lives in ONE place — the reader — rather than in every consumer.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.agents !== 'object' ||
      parsed.agents === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function resolveDepsFromRegistry(
  projectDir: string,
  manifestPathOverride?: string,
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
  // macf#1193: a SEPARATE reader instance for the per-repo artifact sweep —
  // `readRoutingConfigForRepo` needs the discriminated absent/malformed/
  // read-failed result; `ghRoutingReader` above (backing `readRoutingConfig`)
  // deliberately keeps the collapsed `RoutingConfig | null` contract, since
  // the current-repo fallback never needed the distinction. Both share the
  // SAME underlying `gh` read via `createRoutingConfigGhReaderDetailed` — see
  // `routing-doctor-gh.ts`.
  const ghRoutingReaderDetailed = createRoutingConfigGhReaderDetailed(token);
  const localRouting = readLocalRoutingConfig(projectDir);

  // #800: the routing-client cert issuer registry variable, same GitHubVariablesClient
  // + scope as CA material (DR-006) — written by `macf certs issue-routing-client`.
  const routingClientCertIssuerVarName = `${toVariableSegment(config.project)}_ROUTING_CLIENT_CERT_ISSUER`;

  // macf#872: the pin-CORRECTNESS check's authoritative source — `--manifest`
  // override, else control-repo auto-discovery off the install-set already fetched
  // this run (readControlManifestYaml is only ever invoked if discovery finds a
  // matching repo — see `resolveDesiredActionsPin`).
  const readControlManifestYaml = createFleetManifestReader(token);

  return {
    ok: true,
    deps: {
      project: config.project,
      botLogins,
      listRepos: createInstallRepoLister(token),
      readCallerPin: createCallerPinReader(token),
      readFleetMarker: createFleetMarkerReader(token),
      desiredActionsPin: (repos) =>
        resolveDesiredActionsPin(manifestPathOverride, repos, config.project, readControlManifestYaml),
      readRoutingConfig: async () => localRouting ?? (await ghRoutingReader(detectCurrentRepo(projectDir) ?? '')),
      // macf#1191: the SAME gh-content reader as the current-repo fallback above,
      // but called for EVERY repo in the install-set (not just the current
      // project) so the artifact sweep can audit repos this command isn't
      // running from — always via GitHub, never the local-file shortcut
      // `readRoutingConfig` takes for the CURRENT repo, since the point of this
      // check is to assert against each repo's committed truth.
      readRoutingConfigForRepo: ghRoutingReaderDetailed,
      listRepoLabels: createRepoLabelLister(token),
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
  /**
   * Path to a local `fleet.yaml` manifest (macf#872) — supplies the AUTHORITATIVE
   * desired `macf-actions` pin (`versions.actions`) for the pin-CORRECTNESS check.
   * Omit to fall back to control-repo auto-discovery, else honest `unknown`.
   */
  readonly manifestPath?: string;
}

/**
 * `macf routing doctor` entry point. Returns the shell exit code — 1 when the
 * routing plane is DEGRADED, 0 when HEALTHY or EMPTY (matching `fleet doctor` /
 * `macf doctor` "non-zero on problem"). The `--json` body prints regardless; the
 * watchdog reads `summary.verdict`. `deps` is injected by tests.
 */
/**
 * `macf routing doctor` entry point — a thin belt-and-braces wrapper
 * (macf#959, mirrors `fleet-doctor.ts`'s macf#830 fix) around the actual
 * work in `runRoutingDoctorInner`. Before this fix, `runRoutingDoctor` had
 * NO top-level catch at all: an unexpected throw ANYWHERE in
 * `gatherRoutingDoctor` (not just a rejected `/health` probe — the
 * per-agent isolation for that is `evaluateAgentRow`'s own `.catch`, above
 * — but e.g. a `listRepos`/`listRegistry` hiccup) propagated uncaught all
 * the way out of the command, printing a raw stack trace instead of the
 * per-agent table, and leaving a `--json` caller with EMPTY stdout (no
 * error envelope at all). This wrapper guarantees a one-line diagnosis on
 * stderr and, under `--json`, a non-empty JSON error envelope, matching the
 * `fleetDoctorFailureToJson` contract's "never empty stdout" discipline.
 */
export async function runRoutingDoctor(
  projectDir: string,
  opts: RunRoutingDoctorOptions = {},
  deps?: RoutingDoctorDeps,
): Promise<number> {
  try {
    return await runRoutingDoctorInner(projectDir, opts, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`macf routing doctor: ${message}`);
    if (opts.json) {
      console.log(
        JSON.stringify({ schema_version: ROUTING_DOCTOR_JSON_SCHEMA_VERSION, error: message }, null, 2),
      );
    }
    return 1;
  }
}

async function runRoutingDoctorInner(
  projectDir: string,
  opts: RunRoutingDoctorOptions,
  deps: RoutingDoctorDeps | undefined,
): Promise<number> {
  let resolved = deps;
  if (!resolved) {
    const r = await resolveDepsFromRegistry(projectDir, opts.manifestPath);
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
    // macf#872: a SECOND, independent line — the modal above is agreement-only;
    // this is correctness against the fleet manifest's declared `versions.actions`.
    console.log(pinCorrectnessLine(report));
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

  // Routing-table artifact checks (macf#1191): only non-"present" rows render (a
  // fully-satisfied sweep prints nothing here, matching `collectWarnings`' "only
  // show if any" shape) — but the coverage figure is ALWAYS stated, so a clean
  // sweep over a narrow install-set is never mistaken for a clean sweep over the
  // whole fleet.
  console.log(
    `Routing-table artifact checks (${report.reposVisible} repo(s) visible to this caller):`,
  );
  const artifactRows = buildArtifactRows(report.artifactChecks);
  if (artifactRows.length > 0) {
    console.log(formatArtifactTable(report.artifactChecks));
  } else {
    console.log('No missing or unverifiable routing-table artifacts among the visible repos.');
  }
  console.log('');

  const warnings = collectWarnings(report);
  if (warnings.length > 0) {
    console.log('Warnings (non-fatal — do NOT drive the verdict):');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    console.log('');
  }

  console.log(caCertLine(report.ca));
  console.log(
    `ROUTING-CLIENT CERT ISSUER: ${routingClientCertGlyph(report.routingClientCert.state)}` +
    (report.routingClientCert.reason ? ` — ${report.routingClientCert.reason}` : ''),
  );
  // The absorption fix (macf#873): a prominent, explicit causal-attribution line
  // — not a footnote — when a definite CA mismatch is plausibly WHY most/all
  // agents read unreachable, right before the verdict line it explains.
  const caCauseLine = caMismatchCauseLine(report);
  if (caCauseLine) {
    console.log('');
    console.log(`⚠️  ${caCauseLine}`);
  }
  console.log('');
  console.log(summaryLine(report));
  console.log('');
  console.log(HONESTY_LEGEND);

  return verdict === 'DEGRADED' ? 1 : 0;
}
