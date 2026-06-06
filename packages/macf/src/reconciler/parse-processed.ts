/**
 * Parser for the Tempo TraceQL search response → PROCESSED receipts
 * (groundnuty/macf#444 Option D, piece 4 — the "actual set").
 *
 * Query the reconciler runs (science-agent, empirically verified on live Tempo):
 *
 *   GET /api/search
 *     q     = {name="turn_processed" && resource.service.namespace="macf"}
 *             | select(span.routed_run_id, span.agent)
 *     start = <epoch SECONDS>   end = <epoch SECONDS>   limit = <high>
 *
 * `select(span.<key>)` brings the span attrs back IN the search response
 * (no per-trace `/api/traces/<id>` fetch). Response shape:
 *
 *   { "traces": [ { "spanSets": [ { "spans": [
 *       { "attributes": [ { "key": "routed_run_id", "value": { "stringValue": "…" } },
 *                          { "key": "agent",         "value": { "stringValue": "…" } } ] } ] } ] } ] }
 *
 * Gotchas handled (per science's notes):
 *  1. `spanSets` (plural array) in current Tempo; older Tempo uses singular
 *     `spanSet` — handle both.
 *  2. attribute `value` is typed: `{ stringValue: … }` for ours.
 *  3. truncation (Tempo `limit` cap) is the CALLER's concern — a silently
 *     truncated PROCESSED set would read as missing receipts ⇒ false drops
 *     (Pattern-A class). The fetcher must assert `traceCount < limit`; this
 *     pure parser just reports `traceCount` so the caller can check.
 *
 * Pure (no I/O) so it's unit-testable against the recorded live shape; the
 * fetch + truncation-guard live in run.ts.
 */
import type { ProcessedReceipt } from './reconcile.js';

interface TempoAttr {
  readonly key?: string;
  readonly value?: { readonly stringValue?: string };
}
interface TempoSpan {
  readonly attributes?: readonly TempoAttr[];
}
interface TempoSpanSet {
  readonly spans?: readonly TempoSpan[];
}
interface TempoTrace {
  // current Tempo: plural `spanSets`; older: singular `spanSet`.
  readonly spanSets?: readonly TempoSpanSet[];
  readonly spanSet?: TempoSpanSet;
}
interface TempoSearchResponse {
  readonly traces?: readonly TempoTrace[];
}

function attrString(attrs: readonly TempoAttr[] | undefined, key: string): string | undefined {
  return attrs?.find((a) => a.key === key)?.value?.stringValue;
}

export interface ParseProcessedResult {
  readonly receipts: readonly ProcessedReceipt[];
  /** Number of traces in the response — caller compares against `limit` to
   *  detect silent truncation (false-drop hazard). */
  readonly traceCount: number;
}

/**
 * Parse a Tempo `/api/search` response into PROCESSED receipts. Each
 * `turn_processed` trace is a single-span trace; we read `routed_run_id` +
 * `agent` from its span attributes. Spans missing either key are skipped
 * (defensive — a malformed span isn't a receipt).
 */
export function parseProcessedFromTempo(body: unknown): ParseProcessedResult {
  const resp = (body ?? {}) as TempoSearchResponse;
  const traces = resp.traces ?? [];
  const receipts: ProcessedReceipt[] = [];

  for (const trace of traces) {
    const spanSets = trace.spanSets ?? (trace.spanSet ? [trace.spanSet] : []);
    for (const set of spanSets) {
      for (const span of set.spans ?? []) {
        const runId = attrString(span.attributes, 'routed_run_id');
        const agent = attrString(span.attributes, 'agent');
        if (runId && agent) receipts.push({ runId, agent });
      }
    }
  }

  return { receipts, traceCount: traces.length };
}

/**
 * Interpret a parsed result against the Tempo query `limit`. A result that HIT
 * the limit is (possibly) TRUNCATED — and a truncated PROCESSED set is missing
 * real receipts, which `reconcile()` would read as drops → a FALSE incident on
 * exactly the busy windows the reconciler exists to handle (Pattern A). So
 * truncation is NOT "these are the receipts"; it makes the PROCESSED set
 * **unknowable**, the same as a Tempo outage. Returns the receipts only when
 * the set is known-complete (`traceCount < limit`), else `null` — the caller
 * treats `null` as "Tempo problem → true no-op this run" (never open, never
 * close), distinguishing "Tempo unknown" from "0 verified drops".
 */
export function receiptsIfComplete(
  parsed: ParseProcessedResult,
  limit: number,
): readonly ProcessedReceipt[] | null {
  return parsed.traceCount >= limit ? null : parsed.receipts;
}
