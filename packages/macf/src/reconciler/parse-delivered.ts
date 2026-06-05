/**
 * Parser for the macf-actions router's "delivered" log lines (groundnuty/macf#444
 * Option D, piece 4 — the "expected set").
 *
 * Each `route-by-*` block in `agent-router.yml` echoes a success line when it
 * delivers a routed prompt to an agent's tmux session:
 *
 *   route-by-label          → `Routed issue #N to <AGENT> via helper|inline (…)`
 *   route-by-mention        → `Routed mention to <AGENT> via helper|inline (…)`
 *   route-by-ci-completion  → `Routed CI completion for PR #N to <AGENT> via helper|inline (…)`
 *   route-by-pr-review-state→ `Routed review-state (STATE) for PR #N to <AGENT> via helper|inline (…)`
 *
 * The common, stable shape is `Routed … to <AGENT> via (helper|inline)`. A
 * `Routed …` with no `via helper|inline` (e.g. the `delivery FAILED` /
 * `offline, skipping` lines) is NOT a delivery and must not be counted. The
 * agent token is kebab (`code-agent`, `science-agent`, `devops-agent`) — for
 * `route-by-label` it's the label (== the agent name), which is exactly what
 * the marker `[macf-route:${RUN_ID}:${AGENT_NAME|LABEL}]` and thus the
 * `turn_processed` span's `agent` attr also carry, so the join matches by
 * construction.
 *
 * `runId` + `deliveredAtMs` come from the run's metadata (caller supplies them),
 * not the log text. Pure (testable) — the gh-API fetch lives in run.ts.
 */
import type { DeliveredRoute } from './reconcile.js';

// `Routed <anything-not-newline> to <kebab-agent> via helper|inline`.
// The non-greedy `.*?` + the required `via (helper|inline)` tail excludes the
// failure/offline lines (which have no `via helper|inline`). `\b` after the
// alternation avoids matching a longer accidental token.
const ROUTED_LINE = /Routed [^\n]*? to ([a-z][a-z0-9-]*) via (?:helper|inline)\b/g;

/**
 * Extract the agents a single router run delivered to, from its log text.
 * Dedups per (runId, agent) — a run that logs the same agent twice yields one
 * DeliveredRoute. Returns one entry per distinct delivered agent.
 */
export function parseDeliveredFromLog(
  logText: string,
  runId: string,
  deliveredAtMs: number,
): DeliveredRoute[] {
  const agents = new Set<string>();
  for (const m of logText.matchAll(ROUTED_LINE)) {
    agents.add(m[1]!);
  }
  return [...agents].map((agent) => ({ runId, agent, deliveredAtMs }));
}
