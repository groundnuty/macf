/**
 * `macf routing doctor --e2e` — the routing CAPABILITY test (DR-030 phase-2's
 * documented placeholder, groundnuty/macf issue on the six-secrets routing
 * outage). Sibling to the STATIC checks in `routing-doctor.ts`.
 *
 * `routing doctor`'s existing checks are a component checklist: caller-pin,
 * per-label routability, registration freshness, CA material. A checklist has
 * to KNOW what to check — and the outage this test exists to catch broke on a
 * requirement (six required secrets on the router's `workflow_call`) that no
 * checklist here enumerated, because enumerating it meant reading the
 * reusable workflow's own `secrets:` block by hand. A capability test needs
 * to know nothing: file a real issue, label it for a real agent, and see
 * whether the message arrives. If it does, every plumbing requirement the
 * checklist would have had to name — labels, the committed workflow, every
 * secret the workflow's `secrets:` block declares, cross-repo access, the
 * router's registry resolution — was satisfied, by construction.
 *
 * Three design decisions this module holds, deliberately:
 *
 *  1. TRAVELS THE FULL ROUTING PATH. The probe is a real GitHub issue, filed
 *     on the TARGET's own repo and labeled there — never a direct mTLS POST
 *     to the target's channel-server (that is `fleet doctor --inject`, and it
 *     bypasses the router entirely: it would pass cleanly on a fleet whose
 *     router cannot deliver a single message, which is exactly the failure
 *     this test exists to catch).
 *  2. ACKNOWLEDGED STRUCTURALLY, WITH NO AGENT ACTION. The receipt this test
 *     polls for is `/health.current_issue` (channel-server `health.ts`
 *     `setCurrentIssue`) — set the instant `deliverNotification` runs for an
 *     `issue_routed` payload with an `issue_number`, BEFORE any MCP push or
 *     tmux wake, so it never depends on the recipient's live session being
 *     idle, on the LLM choosing to act, or on hashing a tmux pane (a
 *     liveness signal, never an arrival signal).
 *  3. ASSERTS DELIVERED, NOT SEEN. `current_issue` proves the message reached
 *     the recipient's channel-server; it proves nothing about whether the
 *     agent's context ever absorbed it (receipt ≠ a distinct turn). That is
 *     the honest ceiling of what any fleet mechanism can assert, and it is
 *     still enough — every documented instance of this outage was upstream
 *     of delivery.
 *
 * A RED result NAMES where the chain stopped rather than reporting a bare
 * failure (see `RoutingE2eStage`): target misconfigured before anything was
 * filed, the recipient's endpoint never answered, the routing workflow never
 * triggered, the routing workflow triggered and failed, or the workflow
 * succeeded but the recipient never recorded receiving it. A missing-secret
 * outage surfaces as `router_run_failed` with the workflow run's own
 * conclusion + URL — this module never enumerates secret names itself, it
 * only relays what GitHub's own run status says.
 *
 * The probe issue is ALWAYS cleaned up (closed, never left open) on every
 * exit path that created one — a check that leaves debris behind gets
 * filtered out by whoever has to look at the label queue, and a filtered
 * check is a disabled check. Closing (not deleting) is deliberate: issue
 * deletion needs repo-admin GraphQL access most bot Apps never hold, and
 * closing a clearly-labeled probe is enough to avoid littering an open queue.
 * The router's own `on: issues: types: [labeled, closed]` fires a
 * `cleanup-labels` job on close (verified against the live workflow source),
 * which only strips status labels via `gh issue edit --remove-label` — it
 * does NOT re-notify the recipient, so cleanup never produces a second
 * delivery event. Diagnosis (including reading the routing workflow's run)
 * always happens BEFORE cleanup so the close event's own workflow run can
 * never be mistaken for the one the probe's label triggered.
 *
 * Self-routing note: the router's own `route-by-label` job SKIPS silently
 * when the label-adder is the SAME bot as the target
 * (`ACTOR == "${APP_NAME}[bot]"` — verified against the live
 * `agent-router.yml` source). This module refuses BEFORE filing anything
 * when the resolved target label equals the invoking agent's own routing
 * label, rather than let that skip present as an ambiguous timeout.
 *
 * Visibility gate (fix for a false-absence bug, macf#1077): every read this
 * module does past this point is scoped to the TARGET's own repo — a repo
 * this agent's own credential is frequently NOT installed on, because each
 * agent's credential is deliberately narrow (its own repo + the control
 * repo, nothing else). GitHub answers a 404 identically whether a private
 * repo genuinely has no committed workflow or the calling credential simply
 * cannot see the repo at all — those are NOT the same fact, and the first
 * live run of this probe collapsed them, reporting a confident "no router"
 * for a repo it was never entitled to read. The fix asks the ONE question
 * that IS answerable without ambiguity — "what does this credential's own
 * install listing contain?" (a complete enumeration, not a single scoped
 * read) — exactly once, before `isTargetCaller` or any other repo-scoped
 * read runs. A `repo` absent from that listing refuses immediately as
 * `target_visibility_unknown`, distinct from a confirmed-absent
 * `target_not_a_caller`, and none of the ambiguous per-file reads are even
 * attempted. One gate suffices for every later read on the SAME repo with
 * the SAME token — the App's permission grant is uniform per installed
 * repo, so a credential proven to see the repo at all is proven for its
 * workflow file, its agent-config, and its Actions runs alike; re-checking
 * per read would just repeat an already-answered question.
 *
 * REFUSE, not proceed-and-report, is the deliberate choice for an unknown
 * visibility result — the alternative considered was letting the flow run
 * on anyway and let `createProbeIssue`'s own failure carry the diagnosis.
 * Rejected for two reasons. First, this credential's write path shares the
 * SAME installation boundary as its read path (one App install grants
 * both), so proceeding would almost always just trade one honest "unknown"
 * for a less legible "could not create the probe issue: <gh error>" a few
 * steps later — strictly less informative, at the cost of an extra write
 * attempt against a repo already known to be unreadable.
 * Second, refusing here costs nothing: no issue exists yet, so there is
 * nothing to clean up (same "nothing filed, nothing to clean up" contract
 * every other `target_*` precondition in this file already holds) — where
 * `probe_creation_failed` DOES need a cleanup attempt because a write may
 * have partially landed. Fail fast, name the ambiguity precisely, and stop
 * — the same shape every other precondition refusal in this module takes.
 */
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import {
  createRegistryFromConfig,
  fromVariableSegment,
  generateToken,
  pingAgentHealth,
  toVariableSegment,
} from '@groundnuty/macf-core';
import { readAgentConfig, tokenSourceFromConfig, agentCertPath, agentKeyPath } from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import type { RoutingConfig } from './routing-doctor.js';
import { createCallerPinReader, createInstallRepoLister, createRoutingConfigGhReader } from './routing-doctor-gh.js';
import {
  createIssueCloser,
  createLabelApplier,
  createProbeIssueCreator,
  createRouterRunFinder,
} from './routing-e2e-gh.js';

// --- Result shape ---

/**
 * Where the chain stopped (or that it didn't). Every RED value names a
 * specific, distinguishable failure surface — never a generic "it failed."
 * `target_*` / precondition stages fire BEFORE any probe issue is filed (no
 * cleanup needed); everything from `probe_creation_failed` on fires AFTER an
 * issue exists (cleanup always attempted).
 *
 * `target_visibility_unknown` is deliberately distinct from
 * `target_not_a_caller` (macf#1077): the first means "this credential
 * cannot tell," the second means "confirmed absent." Collapsing them was
 * the bug — a credential not entitled to read a peer's repo got 404s on
 * every read and reported a confident absence it never actually confirmed.
 */
export type RoutingE2eStage =
  | 'delivered'
  | 'target_visibility_unknown'
  | 'target_not_a_caller'
  | 'target_label_not_found'
  | 'target_label_ambiguous'
  | 'self_route_would_skip'
  | 'target_unregistered'
  | 'probe_creation_failed'
  | 'probe_label_failed'
  | 'target_unreachable'
  | 'router_not_triggered'
  | 'router_run_failed'
  | 'delivered_not_confirmed';

export type RoutingE2eVerdict = 'GREEN' | 'RED';

export interface RoutingE2eProbeIssue {
  readonly number: number | null;
  readonly url: string | null;
}

export interface RoutingE2eCleanup {
  /** Whether cleanup was even attempted (false = no issue was ever created). */
  readonly attempted: boolean;
  readonly closed: boolean;
  readonly error?: string;
}

/** The routing workflow run found for the probe's `labeled` event, if any. */
export interface RoutingE2eRouterRun {
  readonly found: boolean;
  readonly conclusion: string | null;
  readonly status: string | null;
  readonly url: string | null;
}

export interface RoutingE2eResult {
  readonly verdict: RoutingE2eVerdict;
  readonly stage: RoutingE2eStage;
  /** Plain-language explanation — no internal issue/DR references. */
  readonly message: string;
  readonly targetRepo: string;
  readonly targetLabel: string | null;
  readonly probeIssue: RoutingE2eProbeIssue;
  /** Whether the target's `/health` answered at least once during the wait. */
  readonly everReachable: boolean;
  readonly routerRun: RoutingE2eRouterRun | null;
  readonly cleanup: RoutingE2eCleanup;
  readonly elapsedMs: number;
}

// --- Injectable seams ---

export type RoutingE2eProbeFn = (host: string, port: number) => Promise<HealthResponse | null>;

export type RoutingE2eCreateIssueResult =
  | { readonly ok: true; readonly number: number; readonly url: string }
  | { readonly ok: false; readonly error: string };

export type RoutingE2eLabelResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Injectable seam so tests drive the command fully offline. */
export interface RoutingE2eDeps {
  /** This agent's own routing label — the self-route guard compares against it. */
  readonly currentLabel: string | null;
  /**
   * The COMPLETE set of repos this agent's own credential is installed on
   * (`GET /installation/repositories`) — the one unambiguous signal about
   * what it can see. Checked ONCE, before any repo-scoped read, so a 404 on
   * a peer's repo is never mistaken for confirmed absence (macf#1077).
   */
  readonly listInstallRepos: () => Promise<readonly string[]>;
  readonly isTargetCaller: (repo: string) => Promise<boolean>;
  readonly readTargetRoutingConfig: (repo: string) => Promise<RoutingConfig | null>;
  readonly listRegistry: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  readonly probe: RoutingE2eProbeFn;
  readonly createProbeIssue: (repo: string) => Promise<RoutingE2eCreateIssueResult>;
  readonly applyLabel: (repo: string, issueNumber: number, label: string) => Promise<RoutingE2eLabelResult>;
  readonly closeIssue: (repo: string, issueNumber: number) => Promise<boolean>;
  readonly findRouterRun: (repo: string, sinceIso: string) => Promise<RoutingE2eRouterRun>;
  readonly maxPolls?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock, for elapsed-time reporting (defaults to `Date.now`). */
  readonly now?: () => number;
}

export interface RunRoutingE2eOptions {
  readonly targetRepo: string;
  readonly targetLabel?: string;
  /** Poll budget in seconds (derives `maxPolls` at the default interval). */
  readonly timeoutSec?: number;
}

/** GitHub Actions cold-start + tailnet-connect can legitimately take a while. */
export const DEFAULT_E2E_TIMEOUT_SEC = 180;
export const DEFAULT_E2E_POLL_INTERVAL_MS = 10_000;

/** `(maxPolls-1) * interval ≈ budget`; floor at 2 polls, same shape as fleet-doctor-inject. */
export function deriveMaxPolls(
  timeoutSec: number = DEFAULT_E2E_TIMEOUT_SEC,
  intervalMs: number = DEFAULT_E2E_POLL_INTERVAL_MS,
): number {
  return Math.max(2, Math.round((timeoutSec * 1000) / intervalMs) + 1);
}

/** A RED result for a precondition that failed BEFORE any issue was created — nothing to clean up. */
function refuse(
  stage: Exclude<
    RoutingE2eStage,
    'delivered' | 'probe_label_failed' | 'target_unreachable' | 'router_not_triggered' | 'router_run_failed' | 'delivered_not_confirmed'
  >,
  targetRepo: string,
  targetLabel: string | null,
  message: string,
  startedAt: number,
  now: () => number,
): RoutingE2eResult {
  return {
    verdict: 'RED',
    stage,
    message,
    targetRepo,
    targetLabel,
    probeIssue: { number: null, url: null },
    everReachable: false,
    routerRun: null,
    cleanup: { attempted: false, closed: false },
    elapsedMs: now() - startedAt,
  };
}

/**
 * Resolve which label to target on `repo`: the explicit `--target-label` if
 * given (validated against the repo's own committed routing config), else
 * the repo's sole configured label (the DR-043 one-agent-per-repo shape),
 * else a refusal naming what's ambiguous or missing.
 */
async function resolveTargetLabel(
  deps: RoutingE2eDeps,
  repo: string,
  explicit: string | undefined,
  startedAt: number,
  now: () => number,
): Promise<{ readonly ok: true; readonly label: string } | { readonly ok: false; readonly result: RoutingE2eResult }> {
  const config = await deps.readTargetRoutingConfig(repo);
  const labels = config ? Object.keys(config.agents) : [];

  if (explicit !== undefined) {
    if (!labels.includes(explicit)) {
      const known = labels.length > 0 ? labels.join(', ') : '(none)';
      return {
        ok: false,
        result: refuse(
          'target_label_not_found',
          repo,
          explicit,
          `"${repo}" has no routing entry for "${explicit}" — its committed routing config names: ${known}.`,
          startedAt,
          now,
        ),
      };
    }
    return { ok: true, label: explicit };
  }

  if (labels.length === 1) return { ok: true, label: labels[0]! };

  if (labels.length === 0) {
    return {
      ok: false,
      result: refuse(
        'target_label_not_found',
        repo,
        null,
        `"${repo}" has a routing workflow but no agent configured to receive labels there.`,
        startedAt,
        now,
      ),
    };
  }

  return {
    ok: false,
    result: refuse(
      'target_label_ambiguous',
      repo,
      null,
      `"${repo}" routes for more than one agent (${labels.join(', ')}) — pass --target-label to pick one.`,
      startedAt,
      now,
    ),
  };
}

/**
 * The `target_visibility_unknown` message — names the credential (its
 * routing label) and the mechanism, in plain words (no internal issue/DR
 * references; those belong in code comments, not operator-facing output).
 *
 * Two distinct causes, two distinct messages — collapsing them would repeat
 * this very issue's own Defect 2 shape (a line describing something that
 * did not happen): `'listing-unreadable'` means the install listing itself
 * never came back this run (nothing was confirmed either way — the target
 * repo is not "checked and absent," it is "never checked"); `'not-in-listing'`
 * means the listing WAS read successfully and the target genuinely was not
 * in it (the entitlement gap this issue reports).
 */
function visibilityUnknownMessage(currentLabel: string | null, repo: string, cause: 'listing-unreadable' | 'not-in-listing'): string {
  const who = currentLabel !== null ? `"${currentLabel}"'s credential` : "this agent's credential";
  if (cause === 'listing-unreadable') {
    return (
      `${who} could not read its own installed-repository list this run (a network/auth failure, not a confirmed ` +
      `answer) — nothing about "${repo}"'s routing workflow, label configuration, or recent runs can be asserted ` +
      'from here. Retry, or confirm this credential can reach the GitHub API at all before assuming anything ' +
      'about the target.'
    );
  }
  return (
    `${who} cannot confirm "${repo}" is visible to it — the repo is absent from that credential's own ` +
    "installed-repository list, which WAS read successfully this run. GitHub answers a read against a private " +
    'repo with the identical 404 whether the repo genuinely has nothing there or the credential simply is not ' +
    'installed on it, so nothing about its routing workflow, its label configuration, or its recent runs can be ' +
    "asserted from here. This is the expected shape when probing a peer's repo with an agent's own " +
    'narrowly-scoped credential — not itself a failure. Re-run with a credential installed on the target repo, or ' +
    'confirm its routing workflow another way before treating this result as proof the target cannot route.'
  );
}

/**
 * Run the routing capability probe end-to-end. PURE w.r.t. the injected
 * `deps` — tests pass fakes so nothing hits `gh` / the registry / the
 * network. Never throws: every failure surface resolves to a RED
 * `RoutingE2eResult` with a specific `stage`.
 */
export async function runRoutingE2eCore(
  deps: RoutingE2eDeps,
  opts: RunRoutingE2eOptions,
): Promise<RoutingE2eResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const repo = opts.targetRepo;

  // Visibility gate (macf#1077) — checked ONCE, before `isTargetCaller` or
  // any other repo-scoped read: a `repo` this credential's own install
  // listing doesn't contain can never yield a trustworthy `absent` from a
  // per-file 404, so every one of those reads is skipped entirely rather
  // than attempted and misread. See the module doc for the full rationale.
  //
  // `[]` is itself ambiguous — `listInstallRepos` degrades to `[]` on ANY
  // failure (network, auth, `gh` missing), and a real installation always
  // covers at least this agent's own repo, so an empty result here means
  // the listing read never actually landed, not "confirmed zero repos."
  // Reported as its OWN cause so the message never claims the listing
  // named this repo absent when it was never read at all (the exact
  // asserts-something-that-didn't-happen shape Defect 2 is about).
  // Case-folded: GitHub's listing returns its own canonical casing, and an
  // operator-typed `--target-repo` case mismatch must not read as "unknown."
  const installRepos = await deps.listInstallRepos();
  if (installRepos.length === 0) {
    return refuse(
      'target_visibility_unknown',
      repo,
      null,
      visibilityUnknownMessage(deps.currentLabel, repo, 'listing-unreadable'),
      startedAt,
      now,
    );
  }
  if (!installRepos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
    return refuse('target_visibility_unknown', repo, null, visibilityUnknownMessage(deps.currentLabel, repo, 'not-in-listing'), startedAt, now);
  }

  if (!(await deps.isTargetCaller(repo))) {
    return refuse(
      'target_not_a_caller',
      repo,
      null,
      `"${repo}" has no committed routing workflow (agent-router.yml) — nothing would ever pick up a label there.`,
      startedAt,
      now,
    );
  }

  const labelResolution = await resolveTargetLabel(deps, repo, opts.targetLabel, startedAt, now);
  if (!labelResolution.ok) return labelResolution.result;
  const targetLabel = labelResolution.label;

  if (deps.currentLabel !== null && deps.currentLabel === targetLabel) {
    return refuse(
      'self_route_would_skip',
      repo,
      targetLabel,
      `"${targetLabel}" is this agent's own routing label — the router intentionally ignores a label ` +
        'applied by the same agent it names, so a probe here would silently do nothing. Target a different agent.',
      startedAt,
      now,
    );
  }

  const registryByLabel = new Map<string, AgentInfo>();
  for (const e of await deps.listRegistry()) registryByLabel.set(fromVariableSegment(e.name), e.info);
  const targetInfo = registryByLabel.get(targetLabel);
  if (!targetInfo) {
    return refuse(
      'target_unregistered',
      repo,
      targetLabel,
      `"${targetLabel}" has no live registry entry — it has never registered a reachable endpoint, so there is nothing to poll for delivery.`,
      startedAt,
      now,
    );
  }

  const created = await deps.createProbeIssue(repo);
  if (!created.ok) {
    return refuse(
      'probe_creation_failed',
      repo,
      targetLabel,
      `could not create the probe issue on "${repo}": ${created.error}`,
      startedAt,
      now,
    );
  }

  const probeIssue: RoutingE2eProbeIssue = { number: created.number, url: created.url };

  /** Every exit path past this point created an issue — cleanup always runs. */
  const finish = async (
    partial: Pick<RoutingE2eResult, 'verdict' | 'stage' | 'message' | 'everReachable' | 'routerRun'>,
  ): Promise<RoutingE2eResult> => {
    let closed = false;
    let cleanupError: string | undefined;
    try {
      closed = await deps.closeIssue(repo, created.number);
    } catch (err) {
      cleanupError = err instanceof Error ? err.message : String(err);
    }
    return {
      ...partial,
      targetRepo: repo,
      targetLabel,
      probeIssue,
      cleanup: { attempted: true, closed, ...(cleanupError !== undefined ? { error: cleanupError } : {}) },
      elapsedMs: now() - startedAt,
    };
  };

  const labelResult = await deps.applyLabel(repo, created.number, targetLabel);
  if (!labelResult.ok) {
    return finish({
      verdict: 'RED',
      stage: 'probe_label_failed',
      message: `created probe issue #${String(created.number)} but could not apply the "${targetLabel}" label: ${labelResult.error} — nothing would have routed.`,
      everReachable: false,
      routerRun: null,
    });
  }

  const labeledAtIso = new Date(now()).toISOString();
  const maxPolls = deps.maxPolls ?? deriveMaxPolls(opts.timeoutSec);
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_E2E_POLL_INTERVAL_MS;

  let everReachable = false;
  let delivered = false;
  for (let i = 0; i < maxPolls; i++) {
    const health = await deps.probe(targetInfo.host, targetInfo.port);
    if (health !== null) {
      everReachable = true;
      if (health.current_issue === created.number) {
        delivered = true;
        break;
      }
    }
    if (i < maxPolls - 1) await sleep(intervalMs);
  }

  if (delivered) {
    return finish({
      verdict: 'GREEN',
      stage: 'delivered',
      message: `probe issue #${String(created.number)}, labeled for "${targetLabel}", was delivered and recorded by the recipient's channel-server.`,
      everReachable,
      routerRun: null,
    });
  }

  if (!everReachable) {
    return finish({
      verdict: 'RED',
      stage: 'target_unreachable',
      message: `"${targetLabel}"'s endpoint never answered a health check during the wait — the probe may never have had anywhere to arrive.`,
      everReachable,
      routerRun: null,
    });
  }

  const routerRun = await deps.findRouterRun(repo, labeledAtIso);
  if (!routerRun.found) {
    return finish({
      verdict: 'RED',
      stage: 'router_not_triggered',
      message: `no routing workflow run was ever triggered by the probe's label — check the label exists on "${repo}" and the workflow fires on it.`,
      everReachable,
      routerRun,
    });
  }
  if (routerRun.conclusion !== 'success') {
    return finish({
      verdict: 'RED',
      stage: 'router_run_failed',
      message:
        `the routing workflow run did not finish successfully (conclusion: ${routerRun.conclusion ?? routerRun.status ?? 'unknown'})` +
        (routerRun.url ? ` — see ${routerRun.url}.` : '.'),
      everReachable,
      routerRun,
    });
  }

  return finish({
    verdict: 'RED',
    stage: 'delivered_not_confirmed',
    message: `the routing workflow ran successfully and "${targetLabel}" is reachable, but its channel-server never recorded receiving the probe within the wait — check its process/logs.`,
    everReachable,
    routerRun,
  });
}

// --- JSON + text rendering ---

/** Independent of `routing-doctor.ts`'s `ROUTING_DOCTOR_JSON_SCHEMA_VERSION` — a separate document, not a field grafted onto that one. */
export const ROUTING_E2E_JSON_SCHEMA_VERSION = 1;

export function routingE2eToJson(result: RoutingE2eResult): unknown {
  return {
    schema_version: ROUTING_E2E_JSON_SCHEMA_VERSION,
    verdict: result.verdict,
    stage: result.stage,
    message: result.message,
    target: { repo: result.targetRepo, label: result.targetLabel },
    probe_issue: { number: result.probeIssue.number, url: result.probeIssue.url },
    ever_reachable: result.everReachable,
    router_run: result.routerRun,
    cleanup: {
      attempted: result.cleanup.attempted,
      closed: result.cleanup.closed,
      error: result.cleanup.error ?? null,
    },
    elapsed_ms: result.elapsedMs,
    // Describes what a GREEN verdict means — nothing was delivered on a RED
    // one, so the caveat would assert something that never happened
    // (macf#1077). `null`, not omitted, so the field is always present and
    // its meaning ("no delivery to caveat") is explicit in the JSON shape.
    disclaimer:
      result.verdict === 'GREEN'
        ? 'Proves the probe was DELIVERED to the recipient channel-server, not that the agent acted on it ' +
          '(receipt is not the same thing as a distinct turn).'
        : null,
  };
}

export function formatRoutingE2eText(result: RoutingE2eResult): string {
  const lines: string[] = [];
  lines.push(`Target: "${result.targetLabel ?? '(unresolved)'}" on ${result.targetRepo}`);
  if (result.probeIssue.number !== null) {
    lines.push(`Probe issue: #${String(result.probeIssue.number)}${result.probeIssue.url ? ` (${result.probeIssue.url})` : ''}`);
  }
  lines.push('');
  lines.push(result.verdict === 'GREEN' ? '✓ DELIVERED' : `✗ ${result.stage}`);
  lines.push(result.message);
  if (result.cleanup.attempted) {
    lines.push(
      result.cleanup.closed
        ? 'Probe issue closed (cleanup succeeded).'
        : `Probe issue was NOT closed — clean it up manually${result.cleanup.error ? ` (${result.cleanup.error})` : ''}.`,
    );
  }
  // Describes what a GREEN verdict means — a RED run delivered nothing, so
  // the caveat would assert something that never happened (macf#1077).
  if (result.verdict === 'GREEN') {
    lines.push('');
    lines.push(
      'Note: this proves the probe was DELIVERED to the recipient channel-server, not that the agent acted ' +
        'on it — a receipt is not the same thing as a distinct turn.',
    );
  }
  return lines.join('\n');
}

// --- Production dep wiring + CLI entrypoint ---

export interface RunRoutingE2eCliOptions {
  readonly json?: boolean;
  readonly targetRepo: string;
  readonly targetLabel?: string;
  readonly timeoutSec?: number;
}

async function resolveE2eDepsFromRegistry(
  projectDir: string,
): Promise<{ readonly ok: true; readonly deps: RoutingE2eDeps } | { readonly ok: false; readonly code: number; readonly message: string }> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    return { ok: false, code: 1, message: 'No macf-agent.json found. Run `macf init` first.' };
  }
  if (config.registry.type === 'local') {
    return {
      ok: false,
      code: 1,
      message: '`macf routing doctor --e2e` checks the GitHub routing plane; local-registry mode has none.',
    };
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caCertPem = (await client.readVariable(`${toVariableSegment(config.project)}_CA_CERT`)) ?? '';
  const certPath = agentCertPath(projectDir);
  const keyPath = agentKeyPath(projectDir);

  return {
    ok: true,
    deps: {
      currentLabel: config.routing_label ?? config.agent_name ?? null,
      listInstallRepos: createInstallRepoLister(token),
      isTargetCaller: async (repo) => (await createCallerPinReader(token)(repo)).status === 'pinned',
      readTargetRoutingConfig: createRoutingConfigGhReader(token),
      listRegistry: () => registry.list(''),
      probe: (host, port) => pingAgentHealth({ host, port, caCertPem, certPath, keyPath }),
      createProbeIssue: createProbeIssueCreator(token),
      applyLabel: createLabelApplier(token),
      closeIssue: createIssueCloser(token),
      findRouterRun: createRouterRunFinder(token),
    },
  };
}

/**
 * `macf routing doctor --e2e` entry point. Returns the shell exit code — 1
 * on RED (including every precondition refusal), 0 on GREEN, matching the
 * "non-zero on problem" convention `fleet doctor` / `routing doctor` share.
 * `deps` is injected by tests; production resolves it from the project's
 * registry config via `resolveE2eDepsFromRegistry`.
 */
export async function runRoutingE2e(
  projectDir: string,
  opts: RunRoutingE2eCliOptions,
  deps?: RoutingE2eDeps,
): Promise<number> {
  let resolved = deps;
  if (!resolved) {
    const r = await resolveE2eDepsFromRegistry(projectDir);
    if (!r.ok) {
      console.error(r.message);
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: ROUTING_E2E_JSON_SCHEMA_VERSION, error: r.message }, null, 2));
      }
      return r.code;
    }
    resolved = r.deps;
  }

  const result = await runRoutingE2eCore(resolved, {
    targetRepo: opts.targetRepo,
    targetLabel: opts.targetLabel,
    timeoutSec: opts.timeoutSec,
  });

  if (opts.json) {
    console.log(JSON.stringify(routingE2eToJson(result), null, 2));
  } else {
    console.log(`macf routing doctor --e2e — ${opts.targetRepo}\n`);
    console.log(formatRoutingE2eText(result));
  }

  return result.verdict === 'GREEN' ? 0 : 1;
}
