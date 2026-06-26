import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * comms-ledger — the write-ahead, per-agent, authoritative record of every
 * coordination edge the channel-server sends or receives.
 *
 * Implements DR-025 (observable coordination substrate). The invariant: any
 * channel carrying agent-to-agent coordination MUST preserve a durable,
 * graph-reconstructable, fleet-analyzable record. GitHub gives this for free;
 * A2A / direct channels must earn it deliberately or the diagnose→redesign
 * instrument (and the paper's evidence) goes blind. This is macf#444 one layer
 * up; a Tempo-only design would reproduce silent-fallback Instance 8 (OTLP
 * silent-drop) as the methodology's foundation.
 *
 * Resilience shape: a write-ahead log + a downstream rebuildable index. The
 * JSONL ledger is AUTHORITATIVE (local disk, synchronous, fail-loud); the Tempo
 * span is a DERIVED best-effort central index over the same data. The durable
 * write happens BEFORE the lossy network hop, independent of Tempo's health.
 *
 * This module is the library layer (#473 piece 1): the schema, the unified
 * event taxonomy, the fail-loud writer, the `processed` backfill join, the
 * multi-host gather, and the rotation policy. Wiring it into the three edge
 * sites (inbound `/notify`, inbound A2A `message/send`, outbound notify_peer)
 * is #473 piece 2.
 */

/**
 * Unified coordination-event taxonomy (DR-025 §"Channel unification").
 * One enum spanning the A2A events and the router events, so a ledger edge
 * analyzes identically regardless of which channel carried it.
 */
export const CommsEventSchema = z.enum([
  // A2A / peer_notification (notify_peer `event`, message/send)
  'turn-complete',
  'session-end',
  'error',
  'custom',
  // GitHub router (the macf-actions route-by-* blocks)
  'issue-routed',
  'mention',
  'pr-review-state',
]);
export type CommsEvent = z.infer<typeof CommsEventSchema>;

export const CommsChannelSchema = z.enum(['a2a', 'github-route']);
export type CommsChannel = z.infer<typeof CommsChannelSchema>;

export const CommsDirectionSchema = z.enum(['send', 'recv']);
export type CommsDirection = z.infer<typeof CommsDirectionSchema>;

/**
 * One coordination edge — one JSONL line per exchange (DR-025 §"The edge schema").
 *
 * - `delivered` is known at edge-write (the byte sequence was accepted/pushed).
 * - `processed` is the macf#444 distinction (delivery ≠ a turn actually happening).
 *   It is NULLABLE at edge-write — the peer hasn't necessarily taken a turn yet —
 *   and is backfilled later via the receipt join (`backfillProcessed`). The
 *   edge-write must never block on it.
 * - `trace_id` cross-references the Tempo span. It is captured synchronously from
 *   `span.spanContext().traceId` (OTel api ≥1.9.1: synchronous, available pre-export)
 *   BEFORE this write; the span export (`span.end()`) happens after, async, best-effort.
 * - `github_anchor` stitches an off-GitHub edge back to its GitHub object so the
 *   on-GitHub and off-GitHub graphs join into one; `null` for a pure nudge.
 */
export const CommsLedgerEdgeSchema = z.object({
  ts: z.string(), // ISO 8601
  from: z.string(),
  to: z.string(),
  channel: CommsChannelSchema,
  event: CommsEventSchema,
  direction: CommsDirectionSchema,
  msg_id: z.string(),
  intent_summary: z.string(),
  github_anchor: z.string().nullable(),
  delivered: z.boolean(),
  processed: z.boolean().nullable(),
  trace_id: z.string(),
});
export type CommsLedgerEdge = z.infer<typeof CommsLedgerEdgeSchema>;

/** Max length of the deterministic intent-summary clip. */
export const INTENT_SUMMARY_MAX = 120;

/**
 * Cheap, deterministic intent summary: the first non-empty line of the message,
 * trimmed and clipped to `max` chars.
 *
 * Explicitly NOT an LLM summarize (#473 AC): keep a model dependency and its
 * latency out of the delivery hot path. This runs synchronously on every edge.
 */
export function intentSummary(
  text: string | null | undefined,
  max: number = INTENT_SUMMARY_MAX,
): string {
  if (!text) return '';
  const firstLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  if (firstLine.length <= max) return firstLine;
  // Clip on a char boundary; the ellipsis signals truncation (never a silent cap).
  return firstLine.slice(0, max - 1) + '…';
}

/** Canonical per-agent ledger filename, kept as a sibling of `channel.log`. */
export const COMMS_LEDGER_FILENAME = 'comms-ledger.jsonl';

/**
 * Derive the ledger path from the channel-server's `logPath` (`MACF_LOG_PATH`),
 * as a sibling file in the same `.macf/logs/` directory. Returns `undefined`
 * when no log path is configured (the ledger is then a no-op, mirroring how the
 * `logger` is a no-op without `MACF_LOG_PATH` — the real fleet always sets it).
 */
export function ledgerPathFromLog(logPath: string | undefined): string | undefined {
  if (!logPath) return undefined;
  return join(dirname(logPath), COMMS_LEDGER_FILENAME);
}

export interface CommsLedger {
  /**
   * Append one coordination edge — SYNCHRONOUS and FAIL-LOUD.
   *
   * Throws if the write fails: an authoritative edge would otherwise be lost,
   * and DR-025 names this the one operation that must NOT silently degrade.
   * This is the structural distinction from the best-effort `logger`
   * (`channel.log`), whose `logger.info` must stay non-fatal. Callers append to
   * the ledger BEFORE the (async, best-effort) Tempo span export, so a Tempo or
   * network failure can never cost an edge.
   */
  readonly appendEdge: (edge: CommsLedgerEdge) => void;
  /** The resolved ledger path, or `undefined` if the ledger is a no-op. */
  readonly path: string | undefined;
}

const NOOP_LEDGER: CommsLedger = {
  appendEdge: () => {
    /* no path configured → no-op (mirrors logger when MACF_LOG_PATH unset) */
  },
  path: undefined,
};

/**
 * Create the per-agent write-ahead comms-ledger writer.
 *
 * Pass the channel-server's `logPath`; the ledger is written to a sibling
 * `comms-ledger.jsonl` in the same directory. A distinct writer from `logger`
 * by design — fail-loud, authoritative — never the best-effort log.
 *
 * Durability note (research-confirmed: OTel api 1.9.1 / Node `fs`): `appendFileSync`
 * is synchronous and throws on write error (the fail-loud guarantee), but does
 * NOT `fsync`. The threat model is a Tempo/network failure with the edge already
 * on local disk — not power-loss — so per-write `fsync` (latency on every
 * exchange) is deliberately skipped.
 */
export function createCommsLedger(opts: {
  readonly logPath?: string | undefined;
  /** Override the derived path (mainly for tests). */
  readonly ledgerPath?: string | undefined;
}): CommsLedger {
  const ledgerPath = opts.ledgerPath ?? ledgerPathFromLog(opts.logPath);
  if (!ledgerPath) return NOOP_LEDGER;

  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, '');

  return {
    path: ledgerPath,
    appendEdge: (edge: CommsLedgerEdge): void => {
      // Validate the shape (cheap, catches a malformed edge at the source),
      // then append exactly one JSONL line. appendFileSync throws on any write
      // error → propagates to the caller (fail-loud, per DR-025).
      const line = JSON.stringify(CommsLedgerEdgeSchema.parse(edge));
      appendFileSync(ledgerPath, line + '\n');
    },
  };
}

/**
 * Backfill `processed` on edges from a set of receipt keys (DR-025 / macf#444).
 *
 * Edges are written with `processed: null` (unknown-at-write); a receipt — proof
 * the peer actually took a turn — resolves it. This is a PURE function: it does
 * NOT mutate the append-only ledger, it produces a derived view (the same shape
 * as `reconciler/reconcile.ts`, which joins delivered routes ⋈ turn receipts).
 *
 * Channel split for the `processed` (delivery ≠ turn) join:
 *   - **a2a edges** join on `msg_id` via THIS function — `keyOf` maps the edge
 *     to its `msg_id` and `receiptKeys` carries the observed receipts.
 *   - **github-route edges** are tracked SEPARATELY by the macf#444 reconciler,
 *     which is run_id-keyed off the prompt `[macf-route:RUN:AGENT]` marker. The
 *     github-route recv edge intentionally does NOT carry that run_id (it is
 *     absent from CommsLedgerEdge, NotifyPayload, and the `type:num:ts` msg_id),
 *     so the `(run_id, agent)` join is structurally impossible HERE. A
 *     github-route edge's `processed` therefore stays `null` in the ledger BY
 *     DESIGN; its delivery≠turn distinction lives in the reconciler's view, not
 *     this one. `backfillProcessed` is the a2a-side join.
 *
 * `keyOf` is left channel-agnostic on purpose (it just reads `msg_id` for the
 * a2a join); edges whose `processed` is already non-null are left untouched
 * (idempotent).
 */
export function backfillProcessed(
  edges: readonly CommsLedgerEdge[],
  receiptKeys: ReadonlySet<string>,
  keyOf: (edge: CommsLedgerEdge) => string,
): CommsLedgerEdge[] {
  return edges.map((e) =>
    e.processed === null ? { ...e, processed: receiptKeys.has(keyOf(e)) } : e,
  );
}

/**
 * Gather + merge per-agent ledgers into one fleet view, ordered by `ts`.
 *
 * The per-agent ledger is the durable floor; Tempo is the central convenience
 * index. When Tempo is down, fleet-graph analysis falls back to merging the
 * per-agent ledgers. On the single-host substrate this is trivial — all the
 * `comms-ledger.jsonl` files are local. For a MULTI-HOST fleet the gather step
 * is explicit and operator-defined: collect each host's ledger (e.g.
 * `rsync <agent-host>:.../comms-ledger.jsonl ./gathered/<agent>.jsonl`) into one
 * place, then call this. There is deliberately NO central durable sink — that
 * would reintroduce the single point of failure DR-025 exists to avoid.
 *
 * Malformed lines are skipped (a corrupt line must not blind the whole gather);
 * this is the one place a parse error is tolerated, because gather is a derived
 * read, not the authoritative write.
 */
export function mergeLedgers(contents: readonly string[]): CommsLedgerEdge[] {
  const edges: CommsLedgerEdge[] = [];
  for (const content of contents) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parsed = CommsLedgerEdgeSchema.safeParse(JSON.parse(safeJson(line)));
      if (parsed.success) edges.push(parsed.data);
    }
  }
  return edges.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Parse-guard: return the line if it is JSON-parseable, else an empty object literal. */
function safeJson(line: string): string {
  try {
    JSON.parse(line);
    return line;
  } catch {
    return '{}';
  }
}

// --- DR-030 phase-1 (groundnuty/macf#568): last_processed via the RECEIPT SINK ---
//
// The `/health` `last_processed` field is the agent's passive-Processed
// self-report: "I processed a routed coordination message at time T", proven
// LOCALLY with no synthetic injection (DR-030 §3 "Passive-Processed tier").
//
// THE LOCAL "PROCESSED" SOURCE IS THE RECEIPT SINK, not the comms-ledger.
// When the router injects a prompt it appends a `[macf-route:<run_id>:<agent>]`
// marker (macf-actions#45); the `emit-turn-receipt.sh` UserPromptSubmit hook
// fires when that prompt is submitted AS A TURN and — alongside the OTLP
// `turn_processed` span (which feeds Tempo + the #444 reconciler) — appends one
// receipt line per marker to `processed-receipts.jsonl` (a sibling of
// `channel.log`, see `receiptSinkPathFromLog`). THAT local append is the proof a
// turn happened, and it is what this reader surfaces — making the passive tier a
// real LOCAL self-report rather than a Tempo-only one (the keystone of #568).
//
// Why NOT the comms-ledger's `processed` field: every edge site writes
// `processed: null` — the delivery≠turn join is a DERIVED view (`backfillProcessed`
// / the #444 reconciler), never written back to the append-only ledger (DR-025).
// So a `recv` + `processed:true` edge never exists on disk and a ledger scan is
// always null. The ledger stays the authoritative edge record; this sink is the
// separate, purpose-built local "I took a turn" proof.

/** Receipt-sink filename (sibling of `channel.log`); the local turn-receipt log. */
export const RECEIPT_SINK_FILENAME = 'processed-receipts.jsonl';

/**
 * Derive the receipt-sink path from the channel-server's `logPath` (`MACF_LOG_PATH`),
 * as a sibling file in the same `.macf/logs/` directory — parallel to
 * `ledgerPathFromLog`. `undefined` when no log path is configured (then
 * `last_processed` is null: there is no sink to read). This is the SAME path the
 * `emit-turn-receipt.sh` hook writes to (`$(dirname MACF_LOG_PATH)/<filename>`).
 */
export function receiptSinkPathFromLog(logPath: string | undefined): string | undefined {
  if (!logPath) return undefined;
  return join(dirname(logPath), RECEIPT_SINK_FILENAME);
}

/**
 * One local turn-receipt line, written by `emit-turn-receipt.sh` (one per routed
 * marker the agent processed in a turn). The compact wire form is exactly
 * `{"ts":<epoch-ms>,"run_id":"<run_id>","agent":"<agent>"}`.
 */
export const ProcessedReceiptSchema = z.object({
  /** Epoch milliseconds at which the routed prompt was submitted as a turn. */
  ts: z.number(),
  /** The router run id from the `[macf-route:<run_id>:<agent>]` marker. */
  run_id: z.string().min(1),
  /** The kebab agent name from the marker. */
  agent: z.string().min(1),
});
export type ProcessedReceipt = z.infer<typeof ProcessedReceiptSchema>;

/** The `/health` `last_processed` self-report shape (DR-030 passive-Processed tier). */
export interface LastProcessedReport {
  /** ISO-8601 timestamp of the most-recent turn-receipt (null if none/unparseable). */
  readonly at: string | null;
  /**
   * GitHub anchor (owner/repo#N). Always `null` for the receipt sink — a turn
   * receipt carries no github_anchor. The field stays in the shape for back-compat
   * with the schema (and a future ledger-join view that could populate it).
   */
  readonly anchor: string | null;
  /** now − ts, clamped ≥ 0; null when `at` is absent or `ts` is non-finite. */
  readonly age_ms: number | null;
  /**
   * The receipt's `run_id` — THE `--inject` CONTRACT. An injector routes a prompt
   * carrying a known `run_id` in its `[macf-route:<run_id>:<agent>]` marker, lets
   * the agent process it in a turn, then reads `/health` and matches this
   * `correlation_token` to confirm ITS OWN message was processed.
   */
  readonly correlation_token: string | null;
}

/**
 * Parse a receipt-sink file's text into receipts, tolerantly: blank + malformed
 * lines (incl. a torn final line mid-append) are skipped, never fatal — a corrupt
 * line must not blind the read. Same posture as `mergeLedgers`.
 */
export function parseReceipts(content: string): ProcessedReceipt[] {
  const out: ProcessedReceipt[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ProcessedReceiptSchema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Select the most-recent receipt (max `ts`), or null when there are none.
 * Single-pass max-`ts` (not a sort) — cheap on the infrequent `/health` path. On
 * equal `ts`, the first-seen wins (a benign tie). Max-`ts` (rather than just the
 * last line) is robust to out-of-order lines under clock skew.
 */
export function selectLastReceipt(
  receipts: readonly ProcessedReceipt[],
): ProcessedReceipt | null {
  let best: ProcessedReceipt | null = null;
  for (const r of receipts) {
    if (best === null || r.ts > best.ts) best = r;
  }
  return best;
}

/**
 * Map a selected receipt (or null) into the `last_processed` `/health` shape.
 * `at` ← ISO-8601 of the receipt's epoch-ms `ts`; `correlation_token` ← `run_id`
 * (the `--inject` contract); `anchor` ← null (the sink carries no github_anchor);
 * `age_ms` ← now − ts, clamped ≥ 0. A non-finite `ts` yields `at: null` + `age_ms: null`.
 */
export function mapReceiptToLastProcessed(
  receipt: ProcessedReceipt | null,
  now: number,
): LastProcessedReport | null {
  if (receipt === null) return null;
  const finite = Number.isFinite(receipt.ts);
  return {
    at: finite ? new Date(receipt.ts).toISOString() : null,
    anchor: null,
    age_ms: finite ? Math.max(0, Math.floor(now - receipt.ts)) : null,
    correlation_token: receipt.run_id,
  };
}

/**
 * Read the agent's most-recent turn-receipt from the receipt sink and map it to
 * the `/health` `last_processed` self-report. NEVER throws — an unset/missing/
 * unreadable/garbage sink (or any read/parse error) degrades to `null`, so it can
 * never break `/health`. Inject `readReceipts` in tests to skip the file entirely.
 *
 * Perf: reads the whole jsonl on each call. A `/health` ping is infrequent and the
 * sink is operator-rotated like the ledger (see `ROTATION_POLICY`), so a bounded
 * full read is fine; a tail-scan optimisation is possible if it ever grows unbounded.
 */
export function readLastProcessed(opts: {
  readonly logPath?: string | undefined;
  readonly receiptSinkPath?: string | undefined;
  readonly now: number;
  readonly readReceipts?: () => readonly ProcessedReceipt[];
}): LastProcessedReport | null {
  try {
    let receipts: readonly ProcessedReceipt[];
    if (opts.readReceipts) {
      receipts = opts.readReceipts();
    } else {
      const path = opts.receiptSinkPath ?? receiptSinkPathFromLog(opts.logPath);
      if (!path || !existsSync(path)) return null;
      receipts = parseReceipts(readFileSync(path, 'utf8'));
    }
    return mapReceiptToLastProcessed(selectLastReceipt(receipts), opts.now);
  } catch {
    return null;
  }
}

/**
 * Rotation/retention policy (DR-025 §"Costs", "no silent caps"):
 *
 * The ledger is the PERMANENT record, so rotation is deliberate and must NEVER
 * silently truncate. The writer here only ever appends — it has no size cap and
 * no truncation path by construction. If an operator rotates the file for size,
 * the canonical action is archive-on-rotate (move the old file aside, e.g.
 * `comms-ledger.jsonl.<date>`), never `> truncate` or head/tail clipping. Size
 * management is an operator concern, intentionally outside this hot-path writer.
 */
export const ROTATION_POLICY = 'archive-on-rotate; never silent truncation' as const;
