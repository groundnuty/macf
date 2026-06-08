/**
 * comms-ledger-record — the LOUD-BUT-PROCEEDS policy slot for the
 * comms-ledger (macf#473 piece 2; operator decision 2026-06-08).
 *
 * The library writer `appendEdge` (comms-ledger.ts) is deliberately
 * FAIL-LOUD — it throws on any write failure (I/O error) or schema-parse
 * rejection, because an authoritative DR-025 edge must never silently
 * disappear at the WRITE layer. But the channel-server's three coordination
 * EDGE SITES (inbound /notify recv, inbound A2A message/send recv, outbound
 * notify_peer send) sit on the delivery hot path: a ledger write failure
 * there must NOT abort the delivery the agent depends on. The observability
 * layer can never be allowed to cause a coordination outage.
 *
 * `recordEdge` reconciles those two requirements. It is append-first, and on
 * ANY failure it CATCHES, emits a LOUD signal on BOTH channels (a
 * `logger.error('comms_ledger_write_failed', …)` line carrying the edge
 * inline + a dedicated `comms_ledger_write_failed` metric carrying enough
 * label dimensions to reconstruct the edge class), then RETURNS normally.
 * It never re-throws and never silently swallows. The caller then proceeds
 * with delivery regardless.
 *
 * This is the structural inverse of `appendEdge`: the WRITE is fail-loud
 * (it must surface the failure to *someone*); the POLICY around it at the
 * hot-path sites is loud-but-proceeds (it must surface AND keep going). The
 * library stays pure; the policy lives here.
 */
import type { Logger } from '@groundnuty/macf-core';
import type { CommsLedger, CommsLedgerEdge } from './comms-ledger.js';

/**
 * Sink for the machine-readable half of the loud signal. Injected (not
 * imported directly from `metrics.ts`) so `recordEdge` degrades gracefully
 * when metrics are off — server.ts wires the real `getCommsLedgerWriteFailedCounter`
 * increment; tests inject a spy; omitting it entirely still logs.
 *
 * Receives the edge that failed to write so the recorder can derive whatever
 * label dimensions it wants (channel / direction / agent) from a single
 * source — keeping the label set decided at the metrics layer, not here.
 */
export type CommsLedgerWriteFailedRecorder = (failedEdge: CommsLedgerEdge) => void;

export interface RecordEdgeDeps {
  readonly ledger: CommsLedger;
  readonly logger: Logger;
  /**
   * Optional metric recorder for the write-failed signal. When absent,
   * `recordEdge` still emits the `logger.error` loud signal — the metric is
   * a complement, not a precondition (OTEL is opt-in; the log is always on).
   */
  readonly recordWriteFailed?: CommsLedgerWriteFailedRecorder;
}

/**
 * Append `edge` to the comms-ledger under the loud-but-proceeds policy.
 *
 * Behavior (macf#473 operator decision):
 *   1. append-first: call `ledger.appendEdge(edge)`.
 *   2. on ANY throw (I/O failure OR the Zod schema-parse rejection inside
 *      appendEdge) → CATCH it.
 *   3. emit the LOUD signal on both channels:
 *        - `logger.error('comms_ledger_write_failed', { edge, error })`
 *          — the edge is carried INLINE so the lost authoritative record is
 *          reconstructable from the log alone.
 *        - `recordWriteFailed(edge)` (if wired) — increments the dedicated
 *          metric carrying enough label dimensions to reconstruct the edge
 *          CLASS for alerting / dashboards.
 *   4. RETURN normally. NEVER re-throw, NEVER silently swallow.
 *
 * The caller proceeds with delivery afterward regardless of outcome. This
 * guarantees the observability layer can never cause a coordination outage,
 * while never being silent about a lost edge.
 *
 * Note: the no-op ledger (no MACF_LOG_PATH) never throws, so this is a clean
 * no-op there too — same as the rest of the observability surface when
 * unconfigured.
 */
export function recordEdge(deps: RecordEdgeDeps, edge: CommsLedgerEdge): void {
  try {
    deps.ledger.appendEdge(edge);
  } catch (err) {
    // LOUD signal — human-readable half (always on). The edge is carried
    // inline so the lost authoritative record can be reconstructed from the
    // log without the ledger file.
    deps.logger.error('comms_ledger_write_failed', {
      edge,
      error: err instanceof Error ? err.message : String(err),
    });
    // LOUD signal — machine-readable half (when metrics are wired).
    // Guard the recorder ITSELF so a misbehaving metric sink can't turn the
    // loud-but-proceeds policy back into a fatal path. Last-ditch only.
    if (deps.recordWriteFailed !== undefined) {
      try {
        deps.recordWriteFailed(edge);
      } catch (metricErr) {
        deps.logger.error('comms_ledger_write_failed_metric_error', {
          error: metricErr instanceof Error ? metricErr.message : String(metricErr),
        });
      }
    }
    // RETURN normally — the caller proceeds with delivery.
  }
}
