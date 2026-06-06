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
 *   4. Emit `drops_count` / `drops_json` to `$GITHUB_OUTPUT` for the workflow's
 *      open-on-absence / self-close-on-appearance incident steps.
 *
 * Pattern-A safety (false-drop avoidance): a Tempo query FAILURE makes the
 * PROCESSED set unknowable — treating it as empty would flag every delivery as
 * a drop. So on Tempo failure we abort WITHOUT emitting drops (exit 0, loud
 * WARN); and on a result count hitting the limit we WARN (silent truncation =
 * false drops). Never alert on a Tempo problem; only on real missing receipts.
 *
 * Config (env, set by the workflow):
 *   RECONCILER_REPO        owner/repo (default $GITHUB_REPOSITORY)
 *   ROUTER_WORKFLOW        router workflow file (default agent-router.yml)
 *   TEMPO_QUERY_ENDPOINT   Tempo query base, e.g. http://<tailnet-host>:13200
 *   OPEN_THRESHOLD_MIN     drop threshold, must exceed busy-turn latency (default 15)
 *   LOOKBACK_MIN           how far back to scan runs + Tempo (default 360)
 *   TEMPO_LIMIT            Tempo search result cap (default 1000)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { reconcile, type DeliveredRoute, type ProcessedReceipt } from './reconcile.js';
import { parseDeliveredFromLog } from './parse-delivered.js';
import { parseProcessedFromTempo } from './parse-processed.js';

const MIN = 60_000;
const envStr = (name: string, def: string): string => {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : def;
};

const REPO = envStr('RECONCILER_REPO', process.env['GITHUB_REPOSITORY'] ?? '');
const ROUTER_WORKFLOW = envStr('ROUTER_WORKFLOW', 'agent-router.yml');
const TEMPO = envStr('TEMPO_QUERY_ENDPOINT', 'http://127.0.0.1:13200').replace(/\/+$/, '');
const OPEN_THRESHOLD_MS = Number(envStr('OPEN_THRESHOLD_MIN', '15')) * MIN;
const LOOKBACK_MS = Number(envStr('LOOKBACK_MIN', '360')) * MIN;
const TEMPO_LIMIT = Number(envStr('TEMPO_LIMIT', '1000'));

/** DELIVERED set: parse the router runs' `Routed … to <AGENT>` success lines. */
function fetchDelivered(nowMs: number): DeliveredRoute[] {
  const listJson = execFileSync(
    'gh',
    ['run', 'list', '--repo', REPO, '--workflow', ROUTER_WORKFLOW,
     '--status', 'success', '--limit', '100', '--json', 'databaseId,createdAt'],
    { encoding: 'utf-8' },
  );
  const runs = JSON.parse(listJson) as ReadonlyArray<{ databaseId: number; createdAt: string }>;
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
  return out;
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
    console.error(`WARN: Tempo query unreachable (${(err as Error).message}) — PROCESSED set unknowable; NOT flagging drops this run (avoids false alarms).`);
    return null;
  }
  if (!res.ok) {
    console.error(`WARN: Tempo query HTTP ${res.status} — NOT flagging drops this run (avoids false alarms).`);
    return null;
  }
  const { receipts, traceCount } = parseProcessedFromTempo(await res.json());
  if (traceCount >= TEMPO_LIMIT) {
    console.error(`WARN: Tempo returned ${traceCount} >= limit ${TEMPO_LIMIT} — possible silent truncation → false drops (Pattern A). Narrow LOOKBACK_MIN or raise TEMPO_LIMIT.`);
  }
  return receipts;
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const processed = await fetchProcessed(nowMs);
  if (processed === null) {
    // Tempo problem — emit zero drops so the workflow self-closes/no-ops; never false-alarm.
    emit({ dropsCount: 0, inFlightCount: 0, dropsJson: '[]' });
    return;
  }
  const delivered = fetchDelivered(nowMs);
  const result = reconcile(delivered, processed, { nowMs, openThresholdMs: OPEN_THRESHOLD_MS });
  const dropsJson = JSON.stringify(result.drops);
  console.error(
    `reconcile: delivered=${result.deliveredCount} processed=${result.processedCount} ` +
    `drops=${result.drops.length} in_flight=${result.inFlight.length}`,
  );
  if (result.drops.length > 0) console.error(`DROPS: ${dropsJson}`);
  emit({ dropsCount: result.drops.length, inFlightCount: result.inFlight.length, dropsJson });
}

function emit(o: { dropsCount: number; inFlightCount: number; dropsJson: string }): void {
  const out = process.env['GITHUB_OUTPUT'];
  if (!out) return;
  appendFileSync(out, `drops_count=${o.dropsCount}\nin_flight_count=${o.inFlightCount}\ndrops_json=${o.dropsJson}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
