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
}

/** Canonical join key for a `(runId, agent)` pair. */
export function receiptKey(p: { runId: string; agent: string }): string {
  return `${p.runId}:${p.agent}`;
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

  const drops: DeliveredRoute[] = [];
  const inFlight: DeliveredRoute[] = [];

  for (const route of delivered) {
    if (processedKeys.has(receiptKey(route))) continue; // receipt landed — fine
    const ageMs = opts.nowMs - route.deliveredAtMs;
    if (ageMs > opts.openThresholdMs) {
      drops.push(route); // unmatched + past the threshold → structural drop
    } else {
      inFlight.push(route); // unmatched but young → busy agent may process late
    }
  }

  return {
    drops,
    inFlight,
    deliveredCount: delivered.length,
    processedCount: processedKeys.size,
  };
}
