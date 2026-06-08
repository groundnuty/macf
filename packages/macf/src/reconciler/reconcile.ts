/**
 * Route-receipt reconciler — pure drop-detection logic (groundnuty/macf#444
 * Option D, piece 4).
 *
 * Closes the structural gap: a `turn_processed` span nobody queries is
 * *forensic*, not *surfacing*. This is the consumer that turns the ABSENCE of
 * a receipt span into a structural signal.
 *
 * It joins two sets on `(runId, agent)`:
 *   - DELIVERED — the routes the macf-actions router LOGGED as delivered
 *     (`Routed … to <AGENT> via helper|inline`), each with the route run's
 *     timestamp. (Source: GitHub run logs — see sources.ts.)
 *   - PROCESSED — the `turn_processed` spans the substrate UserPromptSubmit
 *     hook emitted when the marked prompt became a turn. (Source: Tempo
 *     TraceQL `{name="turn_processed" && resource.service.namespace="macf"}`.)
 *
 * A DELIVERED route is a **drop** iff it has no matching PROCESSED span AND it
 * is older than the open-threshold. The threshold is load-bearing: a
 * *legitimately busy* agent processes the ping late (the #437 co-verify showed
 * ~4 min legit latency), so a recent unmatched delivery is "still in flight",
 * NOT a drop. The threshold must exceed observed busy-turn latency (≈15–20 min,
 * tunable). This + the per-run recompute gives the open-on-absence /
 * self-close-on-appearance behaviour (e2e.yml #166/#163 shape): while drops
 * exist the workflow holds an incident open; once a late span lands (or none
 * remain) the next run reports zero drops and the workflow self-closes.
 *
 * The join key is the **marker-parsed** `(runId, agent)` — both sides derive
 * from the router's `[macf-route:${GITHUB_RUN_ID}:${AGENT_NAME}]` marker /
 * `Routed … to <AGENT>` log line, so they match by construction. (NOT the
 * receiving agent's `MACF_AGENT_NAME`, which is unset on substrate — see #444
 * discussion + the #451 hook.)
 *
 * This module is intentionally PURE (no I/O) so the load-bearing logic is fully
 * unit-testable; the GitHub/Tempo fetchers + the incident open/self-close live
 * in sources.ts / run.ts / the scheduled workflow.
 */

/** A delivered route the router logged, with the route run's completion time. */
export interface DeliveredRoute {
  /** The `${GITHUB_RUN_ID}` of the agent-router run that delivered it. */
  readonly runId: string;
  /** The target agent the route was delivered to (`Routed … to <AGENT>`). */
  readonly agent: string;
  /** Epoch ms when the route was delivered (the router run's timestamp). */
  readonly deliveredAtMs: number;
}

/** A `(runId, agent)` pair that produced a `turn_processed` span. */
export interface ProcessedReceipt {
  readonly runId: string;
  readonly agent: string;
}

export interface ReconcileOptions {
  /** Current time (epoch ms). Injected for deterministic tests. */
  readonly nowMs: number;
  /**
   * A delivered-but-unmatched route younger than this is "still in flight"
   * (a busy agent may process it late), NOT a drop. Must exceed observed
   * busy-turn latency (#437: ~4 min) — default ≈15 min, env-tunable.
   */
  readonly openThresholdMs: number;
  /**
   * Deployment-boundary cutoff (epoch ms): ignore delivered routes older than
   * this. Routes that predate the receipt mechanism's go-live (a pre-v1.3.4
   * router prompt with no marker, hitting a session with no hook) have no
   * `turn_processed` receipt by construction — a missing receipt there is
   * EXPECTED, not a drop. Without this the first reconcile after enabling
   * would flag every pre-deployment route in the lookback window as a false
   * drop (groundnuty/macf#444). Undefined / 0 ⇒ no cutoff (judge all routes).
   */
  readonly sinceMs?: number;
  /**
   * Coalesced-turn proximity window (epoch ms) for the macf#479 precision-floor
   * gate. A would-be drop is SUPPRESSED (benign coalesce) when a *different*
   * delivery to the same agent within ±this is receipted — proof the agent was
   * alive and processing routed turns then, so this one coalesced/clobbered into
   * a sibling's turn. Must be > the turn-batching window (~couple min) and <
   * `openThresholdMs` (so a real lone/offline/RC-bound drop, which has no
   * receipted sibling, still flags). Undefined / 0 ⇒ no suppression (pre-#479).
   */
  readonly proximityMs?: number;
}

/**
 * A would-be drop suppressed by the macf#479 coalesced-turn gate: a sibling
 * delivery to the same agent was receipted within the proximity window, so the
 * agent demonstrably processed routed turns around this delivery. Reported
 * separately (not in `drops`) so the caller can emit a LOUD, counted signal —
 * the suppression is observable (never a silent mask), keeping the clobber rate
 * visible for the source-side `C-u`-clobber follow-up.
 */
export interface SuppressedCoalesce {
  readonly route: DeliveredRoute;
  /** The receipted sibling delivery's run id that proves the agent was active. */
  readonly siblingRunId: string;
  /** `sibling.deliveredAtMs − route.deliveredAtMs` (signed), for the log. */
  readonly deltaMs: number;
}

export interface ReconcileResult {
  /**
   * Deliveries with no matching `turn_processed` span, older than the
   * open-threshold — the structural drops to alert on. Empty ⇒ the workflow
   * self-closes any open incident.
   */
  readonly drops: readonly DeliveredRoute[];
  /** Count of delivered routes considered (diagnostic). */
  readonly deliveredCount: number;
  /** Count of distinct processed receipts seen (diagnostic). */
  readonly processedCount: number;
  /**
   * Delivered routes that are unmatched but still within the threshold —
   * "in flight", reported for visibility but NOT alerted on.
   */
  readonly inFlight: readonly DeliveredRoute[];
  /**
   * Would-be drops suppressed by the macf#479 coalesced-turn gate (a receipted
   * sibling delivery to the same agent within the proximity window). NOT alerted
   * on, but the caller logs + counts each so the suppression stays observable.
   */
  readonly suppressed: readonly SuppressedCoalesce[];
}

/** Canonical join key for a `(runId, agent)` pair. */
export function receiptKey(p: { runId: string; agent: string }): string {
  return `${p.runId}:${p.agent}`;
}

/**
 * macf#479 coalesced-turn gate. For a would-be drop, find a *different*
 * delivery to the same agent within ±proximityMs that WAS receipted. Its
 * existence means the agent was alive + processing routed turns around the
 * delivery, so this one benignly coalesced/clobbered into a sibling's turn.
 *
 * Crucially it counts only ROUTED receipts (the `processed` set), so an
 * RC-bound agent — alive on the RC-SDK but silently dropping ALL its tmux
 * pings, none of which receipt — has NO receipted sibling near a real drop and
 * is correctly NOT suppressed. (Returns null ⇒ no benign sibling ⇒ real drop.)
 */
function findReceiptedSibling(
  route: DeliveredRoute,
  inScope: readonly DeliveredRoute[],
  processedKeys: ReadonlySet<string>,
  proximityMs: number,
): SuppressedCoalesce | null {
  let best: SuppressedCoalesce | null = null;
  for (const sib of inScope) {
    if (sib.runId === route.runId) continue; // not itself
    if (sib.agent !== route.agent) continue; // same agent only
    const deltaMs = sib.deliveredAtMs - route.deliveredAtMs;
    if (Math.abs(deltaMs) > proximityMs) continue; // outside the window
    if (!processedKeys.has(receiptKey(sib))) continue; // sibling must be receipted
    // Prefer the temporally-nearest receipted sibling for the log.
    if (best === null || Math.abs(deltaMs) < Math.abs(best.deltaMs)) {
      best = { route, siblingRunId: sib.runId, deltaMs };
    }
  }
  return best;
}

/**
 * Pure reconciliation: which delivered routes are drops (no receipt span +
 * older than the open-threshold) vs. still-in-flight (no receipt yet but
 * within the threshold) vs. processed (have a receipt).
 */
export function reconcile(
  delivered: readonly DeliveredRoute[],
  processed: readonly ProcessedReceipt[],
  opts: ReconcileOptions,
): ReconcileResult {
  const processedKeys = new Set(processed.map(receiptKey));

  // Deployment-boundary guard (groundnuty/macf#444): drop routes delivered
  // before the receipt mechanism went live from scope entirely — those prompts
  // had no marker and hit hookless sessions, so a missing receipt is EXPECTED,
  // not a drop. Else the first reconcile after enabling would false-alarm on
  // every pre-deployment route in the lookback window.
  const sinceMs = opts.sinceMs;
  const inScope = sinceMs ? delivered.filter((r) => r.deliveredAtMs >= sinceMs) : delivered;
  const proximityMs = opts.proximityMs ?? 0;

  const drops: DeliveredRoute[] = [];
  const inFlight: DeliveredRoute[] = [];
  const suppressed: SuppressedCoalesce[] = [];

  for (const route of inScope) {
    if (processedKeys.has(receiptKey(route))) continue; // receipt landed — fine
    const ageMs = opts.nowMs - route.deliveredAtMs;
    if (ageMs <= opts.openThresholdMs) {
      inFlight.push(route); // unmatched but young → busy agent may process late
      continue;
    }
    // Unmatched + past the threshold → a would-be drop. macf#479: suppress it
    // (benign coalesce) iff a receipted sibling delivery to the same agent sits
    // within the proximity window — the agent was demonstrably processing routed
    // turns then. No receipted sibling (lone / offline / RC-bound) ⇒ real drop.
    const sibling = proximityMs > 0
      ? findReceiptedSibling(route, inScope, processedKeys, proximityMs)
      : null;
    if (sibling !== null) {
      suppressed.push(sibling);
    } else {
      drops.push(route);
    }
  }

  return {
    drops,
    inFlight,
    suppressed,
    deliveredCount: inScope.length,
    processedCount: processedKeys.size,
  };
}
