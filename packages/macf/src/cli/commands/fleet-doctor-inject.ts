/**
 * `macf fleet doctor --inject` — the network I/O leaf for the INVASIVE
 * Processed-now delivery-proof tier (DR-030 §3, macf#568 final increment).
 *
 * Split out of `fleet-doctor.ts` so the mTLS request shapes live in one small,
 * dependency-free module (this file imports NOTHING from `fleet-doctor.ts` — the
 * dependency is strictly one-directional, `fleet-doctor.ts` → here). The pure
 * orchestration (per-agent poll loop, glyphs, JSON, legends) stays in
 * `fleet-doctor.ts`.
 *
 * The load-bearing mechanism — verified against `notify-formatter.ts` +
 * `server.ts` + `comms-ledger.ts` + `emit-turn-receipt.sh`:
 *
 *   POST /notify { type:'mention', message:'… [macf-route:<runId>:<agent>] …' }
 *     → https.ts (NON-diagnostic → falls through to onNotify)
 *     → formatNotifyContent(mention) returns { content: payload.message } VERBATIM
 *     → server.ts feeds `content` to BOTH mcp.pushNotification AND wakeViaTmux
 *       (decideWake → 'mention' is a standard type → WAKE), which types `content`
 *       into the agent's TUI input buffer → submitted as the agent's next TURN
 *     → emit-turn-receipt.sh (UserPromptSubmit hook) greps the marker out of the
 *       prompt and appends {ts, run_id, agent} to processed-receipts.jsonl
 *     → /health.last_processed.correlation_token === <runId>  (mapReceiptToLast-
 *       Processed sets correlation_token = receipt.run_id — comms-ledger.ts).
 *
 * Matching the echoed run_id proves the full deliver→process chain. The
 * `mention` `message` field is the carrier because `formatNotifyContent` passes
 * it through unchanged (a `diagnostic:true` payload would short-circuit at the
 * server BEFORE any push — so we must NOT set it).
 */
import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { pingAgentHealth } from '@groundnuty/macf-core';
import type { HealthResponse } from '@groundnuty/macf-core';

/** Same per-request timeout as the non-invasive tiers' mTLS calls. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Outcome of the inject `/notify` POST (the real mention probe). */
export interface InjectPostResult {
  /** HTTP 200 — the probe entered the receiver (onNotify ran). */
  readonly delivered: boolean;
  /** Short reason when not delivered (transport error / non-200). */
  readonly error?: string;
}

/**
 * POST the REAL inject `/notify` mention (marker in `message`). Injectable for
 * tests. `runId` is the digits-only correlation id embedded in the marker;
 * `markerAgent` is the kebab agent slug the marker carries.
 */
export type FleetInjectPostFn = (
  host: string,
  port: number,
  runId: string,
  markerAgent: string,
) => Promise<InjectPostResult>;

/**
 * Poll the target's `/health` ONCE and return the CURRENT
 * `last_processed.correlation_token` (the most-recent processed receipt's
 * `run_id`), or `null` when absent. Injectable for tests.
 */
export type FleetInjectPollFn = (host: string, port: number) => Promise<string | null>;

/**
 * The REAL inject `/notify` POST. Mirrors `postDiagnosticNotify`'s mTLS request
 * shape (same CA + client cert/key, `rejectUnauthorized`, timeout) but sends a
 * NON-diagnostic `mention` whose `message` carries the
 * `[macf-route:<runId>:<markerAgent>]` marker. Resolves `{ delivered: true }`
 * only on HTTP 200; never throws (failures become `{ delivered:false, error }`).
 */
export async function postInjectNotify(config: {
  readonly host: string;
  readonly port: number;
  readonly caCertPem: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly runId: string;
  readonly markerAgent: string;
  readonly timeoutMs?: number;
}): Promise<InjectPostResult> {
  const { host, port, caCertPem, certPath, keyPath, runId, markerAgent, timeoutMs = DEFAULT_TIMEOUT_MS } = config;

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    return { delivered: false, error: 'client cert/key missing' };
  }

  const payload = JSON.stringify({
    type: 'mention',
    source: 'fleet-doctor',
    message:
      `fleet-doctor --inject probe (run_id=${runId}) — no action needed; this verifies ` +
      `delivery is processed end-to-end. [macf-route:${runId}:${markerAgent}]`,
  });

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'POST',
        path: '/notify',
        ca: Buffer.from(caCertPem),
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        rejectUnauthorized: true,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const status = res.statusCode ?? null;
        res.on('data', () => {});
        res.on('end', () => {
          resolve(
            status === 200
              ? { delivered: true }
              : { delivered: false, error: status === null ? 'no response' : `http ${status}` },
          );
        });
      },
    );
    req.on('error', (e) => resolve({ delivered: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ delivered: false, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * The narrow slice of `/health` the inject poll reads. Kept LOCAL (not the
 * shared `HealthResponse`) so this increment is DECOUPLED from the passive
 * `last_processed` increment's `HealthResponseSchema` change — they land on
 * separate PRs without a `types.ts` conflict, and at runtime the field is read
 * straight off the parsed body whether or not the shared type names it yet.
 */
interface HealthLastProcessedView {
  readonly last_processed?: { readonly correlation_token?: string | null } | null;
}

/** Extract `last_processed.correlation_token` from a parsed `/health` body. */
export function readCorrelationToken(health: HealthResponse | null): string | null {
  const lp = (health as HealthLastProcessedView | null)?.last_processed;
  return lp?.correlation_token ?? null;
}

/**
 * Poll one agent's `/health` (reusing the shared mTLS probe) and return its
 * CURRENT `last_processed.correlation_token`, or `null`. Production
 * `FleetInjectPollFn`.
 */
export async function pollLastProcessedToken(config: {
  readonly host: string;
  readonly port: number;
  readonly caCertPem: string;
  readonly certPath: string;
  readonly keyPath: string;
}): Promise<string | null> {
  const health = await pingAgentHealth(config);
  return readCorrelationToken(health);
}
