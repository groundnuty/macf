#!/usr/bin/env node
/**
 * Route-receipt reconciler entrypoint (groundnuty/macf#444 Option D, piece 4).
 *
 * Invoked by the scheduled `route-reconciler.yml` workflow. Thin I/O glue over
 * the unit-tested pure pieces (reconcile / parse-delivered / parse-processed):
 *
 *   1. DELIVERED — `gh run list` the `agent-router` runs (success, recent) +
 *      `gh run view --log` each → parse the `Routed … to <AGENT>` lines.
 *   2. PROCESSED — Tempo `/api/search` for `turn_processed` spans → parse the
 *      `(routed_run_id, agent)` attrs.
 *   3. reconcile() → drops (delivered, no receipt, older than the open-threshold).
 *   4. Emit `tempo_ok` + `drops_count` / `drops_json` to `$GITHUB_OUTPUT` for
 *      the workflow's open-on-absence / self-close-on-appearance incident steps.
 *
 * Pattern-A safety (false-drop avoidance): any Tempo problem — unreachable,
 * HTTP error, OR a result hitting the `limit` (truncation) — makes the
 * PROCESSED set UNKNOWABLE, which is NOT the same as "zero drops". Treating it
 * as empty would false-OPEN incidents (a truncated set reads as missing
 * receipts) and treating it as `drops_count=0` would false-CLOSE a real
 * incident on a transient outage. So all three paths emit `tempo_ok=false`;
 * the workflow gates BOTH the open AND the self-close steps on
 * `tempo_ok == 'true'`, making a Tempo problem a TRUE no-op (incidents left
 * exactly as they are). Only a verified-complete query opens (real drops) or
 * closes (verified zero).
 *
 * Config (env, set by the workflow):
 *   RECONCILER_REPO        owner/repo (default $GITHUB_REPOSITORY)
 *   ROUTER_WORKFLOW        router workflow file (default agent-router.yml)
 *   TEMPO_QUERY_ENDPOINT   Tempo query base, e.g. http://<tailnet-host>:13200
 *   OPEN_THRESHOLD_MIN     drop threshold, must exceed busy-turn latency (default 15)
 *   LOOKBACK_MIN           how far back to scan runs + Tempo (default 120; keep
 *                          below the window where the router exceeds the run-list
 *                          cap, else the DELIVERED set truncates → delivered_ok=false)
 *   TEMPO_LIMIT            Tempo search result cap (default 1000)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { reconcile, type DeliveredRoute, type ProcessedReceipt } from './reconcile.js';
import { parseDeliveredFromLog } from './parse-delivered.js';
import { parseProcessedFromTempo, receiptsIfComplete } from './parse-processed.js';

const MIN = 60_000;
/** `gh run list` page cap. If the router bursts past this in the lookback
 *  window the DELIVERED set truncates silently (Pattern A on the delivered
 *  side: a missed delivery → its receipt is never looked for → a real drop is
 *  silently NOT flagged). We WARN when the cap is hit so the symmetry is
 *  observable, but don't abort: delivered-side truncation under-reports drops
 *  (false negative), which is far less harmful than the processed-side
 *  truncation that would over-report them (false incident). */
const RUN_LIST_LIMIT = 100;
const envStr = (name: string, def: string): string => {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : def;
};

const REPO = envStr('RECONCILER_REPO', process.env['GITHUB_REPOSITORY'] ?? '');
const ROUTER_WORKFLOW = envStr('ROUTER_WORKFLOW', 'agent-router.yml');
const TEMPO = envStr('TEMPO_QUERY_ENDPOINT', 'http://127.0.0.1:13200').replace(/\/+$/, '');
const OPEN_THRESHOLD_MS = Number(envStr('OPEN_THRESHOLD_MIN', '15')) * MIN;
const LOOKBACK_MS = Number(envStr('LOOKBACK_MIN', '120')) * MIN;
const TEMPO_LIMIT = Number(envStr('TEMPO_LIMIT', '1000'));
/** Deployment-boundary cutoff (groundnuty/macf#444): ignore routes delivered
 *  before the receipt mechanism went live. Set `RECONCILER_SINCE` to the
 *  hook-go-live time (ISO-8601 e.g. `2026-06-06T08:00:00Z`, or epoch ms) at the
 *  first `RECONCILER_ENABLED` flip — pre-deployment routes had no marker + hit
 *  hookless sessions, so their missing receipt is EXPECTED, not a drop. Without
 *  it, run 1 would false-alarm on every pre-deployment route in the lookback.
 *  Self-obsoletes once LOOKBACK_MIN slides fully past the cutoff; unset ⇒ no cutoff. */
const SINCE_MS = ((): number | undefined => {
  const raw = process.env['RECONCILER_SINCE'];
  if (!raw) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    console.error(`WARN: RECONCILER_SINCE="${raw}" not parseable (want ISO-8601 or epoch ms) — ignoring cutoff.`);
    return undefined;
  }
  return ms;
})();

/** DELIVERED set: parse the router runs' `Routed … to <AGENT>` success lines.
 *  `truncated` is true when `gh run list` hit its page cap — the set is then
 *  UNKNOWABLE (older routes fell off the page), so the caller must NOT flag
 *  drops this run. Symmetric to the Tempo `tempo_ok` guard, on the delivered
 *  side (Pattern A): silently bounding coverage would let a real drop hide. */
function fetchDelivered(nowMs: number): { routes: DeliveredRoute[]; truncated: boolean } {
  const listJson = execFileSync(
    'gh',
    ['run', 'list', '--repo', REPO, '--workflow', ROUTER_WORKFLOW,
     '--status', 'success', '--limit', String(RUN_LIST_LIMIT), '--json', 'databaseId,createdAt'],
    { encoding: 'utf-8' },
  );
  const runs = JSON.parse(listJson) as ReadonlyArray<{ databaseId: number; createdAt: string }>;
  const truncated = runs.length >= RUN_LIST_LIMIT;
  if (truncated) {
    console.error(`WARN: gh run list hit the ${RUN_LIST_LIMIT}-run cap — DELIVERED set UNKNOWABLE (truncated; older routes in the ${LOOKBACK_MS / MIN}-min window fell off the page). Emitting delivered_ok=false (no drops this run); narrow LOOKBACK_MIN or raise the cap.`);
  }
  const out: DeliveredRoute[] = [];
  for (const run of runs) {
    const createdMs = Date.parse(run.createdAt);
    if (!Number.isFinite(createdMs) || nowMs - createdMs > LOOKBACK_MS) continue;
    let log: string;
    try {
      log = execFileSync('gh', ['run', 'view', String(run.databaseId), '--repo', REPO, '--log'],
        { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue; // log unavailable (expired/in-progress) — skip, not a drop signal
    }
    out.push(...parseDeliveredFromLog(log, String(run.databaseId), createdMs));
  }
  return { routes: out, truncated };
}

/** PROCESSED set: Tempo `turn_processed` spans → receipts. Aborts (no drops)
 *  on a Tempo failure to avoid false alarms (Pattern A). */
async function fetchProcessed(nowMs: number): Promise<readonly ProcessedReceipt[] | null> {
  const startSec = Math.floor((nowMs - LOOKBACK_MS) / 1000);
  const endSec = Math.floor(nowMs / 1000);
  const q = '{name="turn_processed" && resource.service.namespace="macf"} | select(span.routed_run_id, span.agent)';
  const url = `${TEMPO}/api/search?q=${encodeURIComponent(q)}&start=${startSec}&end=${endSec}&limit=${TEMPO_LIMIT}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    // `fetch failed` is opaque — the real cause is in err.cause (undici wraps
    // the network error). Surface its code + message so an unreachable Tempo
    // tells us WHICH failure: ENOTFOUND (MagicDNS not resolving the host),
    // ECONNREFUSED (nothing listening / not `tailscale serve`d), ETIMEDOUT
    // (ACL/firewall dropping the connection), or AbortError (15s timeout).
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const detail = e.cause?.code ?? e.cause?.message ?? e.name;
    console.error(`WARN: Tempo query unreachable [${url}] — ${e.message}: ${detail} — PROCESSED set unknowable; NOT flagging drops this run (avoids false alarms).`);
    return null;
  }
  if (!res.ok) {
    console.error(`WARN: Tempo query HTTP ${res.status} — PROCESSED set unknowable; treating as Tempo-unknown (true no-op this run).`);
    return null;
  }
  const parsed = parseProcessedFromTempo(await res.json());
  // Truncation is a Tempo problem too: an incomplete PROCESSED set reads as
  // missing receipts → false drops. receiptsIfComplete() returns null when the
  // result hit the limit, so it's handled identically to unreachable/HTTP-error.
  const receipts = receiptsIfComplete(parsed, TEMPO_LIMIT);
  if (receipts === null) {
    console.error(`WARN: Tempo returned ${parsed.traceCount} >= limit ${TEMPO_LIMIT} — PROCESSED set may be truncated (Pattern A: a truncated set reads as missing receipts → false drops). Treating as Tempo-unknown (true no-op this run); narrow LOOKBACK_MIN or raise TEMPO_LIMIT.`);
  }
  return receipts;
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const processed = await fetchProcessed(nowMs);
  if (processed === null) {
    // Tempo problem (unreachable / HTTP error / truncated) — the PROCESSED set
    // is UNKNOWABLE, NOT "zero drops". Emit tempo_ok=false; the workflow gates
    // BOTH its open AND its self-close steps on tempo_ok==true, so this is a
    // TRUE no-op: incidents are left exactly as they are (never false-OPEN on a
    // truncated set, never false-CLOSE a real incident on a transient outage).
    console.error('WARN: PROCESSED set unknowable this run — emitting tempo_ok=false (no open, no close).');
    emit({ tempoOk: false, deliveredOk: true, dropsCount: 0, inFlightCount: 0, dropsJson: '[]' });
    return;
  }
  const { routes: delivered, truncated } = fetchDelivered(nowMs);
  if (truncated) {
    // DELIVERED set unknowable (truncated) — like a Tempo problem, NOT "zero
    // drops". Emit delivered_ok=false so the workflow's open AND self-close
    // steps both no-op this run (each gated on tempo_ok && delivered_ok).
    emit({ tempoOk: true, deliveredOk: false, dropsCount: 0, inFlightCount: 0, dropsJson: '[]' });
    return;
  }
  const result = reconcile(delivered, processed, { nowMs, openThresholdMs: OPEN_THRESHOLD_MS, sinceMs: SINCE_MS });
  const dropsJson = JSON.stringify(result.drops);
  console.error(
    `reconcile: delivered=${result.deliveredCount} processed=${result.processedCount} ` +
    `drops=${result.drops.length} in_flight=${result.inFlight.length}` +
    (SINCE_MS ? ` (since=${new Date(SINCE_MS).toISOString()} — pre-deployment routes excluded)` : ''),
  );
  if (result.drops.length > 0) console.error(`DROPS: ${dropsJson}`);
  emit({ tempoOk: true, deliveredOk: true, dropsCount: result.drops.length, inFlightCount: result.inFlight.length, dropsJson });
}

function emit(o: { tempoOk: boolean; deliveredOk: boolean; dropsCount: number; inFlightCount: number; dropsJson: string }): void {
  const out = process.env['GITHUB_OUTPUT'];
  if (!out) return;
  appendFileSync(out, `tempo_ok=${o.tempoOk}\ndelivered_ok=${o.deliveredOk}\ndrops_count=${o.dropsCount}\nin_flight_count=${o.inFlightCount}\ndrops_json=${o.dropsJson}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
