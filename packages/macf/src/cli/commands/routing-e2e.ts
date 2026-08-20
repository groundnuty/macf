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
 */
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import { fromVariableSegment } from '@groundnuty/macf-core';
import type { RoutingConfig } from './routing-doctor.js';

// --- Result shape ---

/**
 * Where the chain stopped (or that it didn't). Every RED value names a
 * specific, distinguishable failure surface — never a generic "it failed."
 * `target_*` / precondition stages fire BEFORE any probe issue is filed (no
 * cleanup needed); everything from `probe_creation_failed` on fires AFTER an
 * issue exists (cleanup always attempted).
 */
export type RoutingE2eStage =
  | 'delivered'
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
    disclaimer:
      'Proves the probe was DELIVERED to the recipient channel-server, not that the agent acted on it ' +
      '(receipt is not the same thing as a distinct turn).',
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
  lines.push('');
  lines.push(
    'Note: this proves the probe was DELIVERED to the recipient channel-server, not that the agent acted ' +
      'on it — a receipt is not the same thing as a distinct turn.',
  );
  return lines.join('\n');
}
