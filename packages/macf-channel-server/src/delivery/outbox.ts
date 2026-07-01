/**
 * DR-038 Decisions 1, 2, 4 — the sender-side effectively-once logic:
 * persist-then-send, stable message-id reuse across retries, exponential-
 * backoff retry bounded by a wall-clock TTL, and dead-letter escalation on
 * TTL expiry.
 *
 * Runtime-agnostic over an injected `OutboxStore` (the pluggable driver,
 * `store.ts`), an injected `send` transport seam, and an injected clock — so
 * the whole retry loop is deterministically testable without real time or
 * real network I/O, and so a driver swap (in-memory here, VM disk-spool /
 * K8s PVC-broker per DR-008) never touches this file.
 *
 * Retries are driven off the PERSISTED outbox, not an in-memory queue:
 * `driveOnce` re-reads `store.listPending()` on every call. This is the
 * crux of restart-survival (Decision 4) — a fresh `createOutbox()` instance
 * over the SAME store (simulating a sender restart) sees every entry a
 * prior process instance hadn't finished with, and its very first
 * `driveOnce` picks up anything already past its `nextAttemptAt` — which is
 * also what naturally implements the DR-038 "Open Questions" lean ("one
 * immediate attempt on startup... then re-enter backoff") without any
 * startup-specific code path: an overdue entry is simply due right away.
 */
import type { Logger } from '@groundnuty/macf-core';
import type { OutboxStore, OutboxEntry } from './store.js';
import { mintMessageId } from './message-id.js';

/**
 * Result of one send attempt. `ack: true` means durable-ACK per DR-038
 * Decision 3 (an HTTP 200 the *receiver* only returns after its own
 * persist-then-ACK). Anything else — `ack: false`, or the `send` promise
 * rejecting — is treated uniformly as a delivery failure (timeout, 5xx,
 * connection-refused: the dead-peer case) and the entry stays in the
 * outbox for retry.
 */
export interface OutboxSendResult {
  readonly ack: boolean;
}

/**
 * The injected transport seam. A real implementation dispatches the actual
 * `message/send` (or legacy notify_peer POST) call; this module never
 * touches the network directly — that keeps the effectively-once logic
 * testable with a fake and reusable across transports.
 */
export type OutboxSendFn = (
  target: string,
  id: string,
  payload: unknown,
) => Promise<OutboxSendResult>;

/** Default exponential-backoff base (DR-038 Decision 4: "~1s → … → 5min"). */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** Default exponential-backoff cap (DR-038 Decision 4: "~1s → … → 5min"). */
export const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1000;

/**
 * Default wall-clock TTL bounding the retry budget. DR-038 Decision 4
 * proposes 24h ("the 8h outage fits comfortably; a multi-day VM outage
 * would dead-letter, correctly escalating to GitHub" — Open Questions).
 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `baseMs * 2^attemptCount`, capped at `capMs`. `attemptCount` is the number
 * of PRIOR failed attempts (0 on the first failure → backoff = `baseMs`).
 * A wall-clock TTL bounds the retry budget (see `DEFAULT_TTL_MS`), NOT an
 * attempt-count ceiling — an attempt count is meaningless across restart
 * gaps of varying length (DR-038 Decision 4).
 */
export function computeBackoffMs(
  attemptCount: number,
  baseMs: number = DEFAULT_BACKOFF_BASE_MS,
  capMs: number = DEFAULT_BACKOFF_CAP_MS,
): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attemptCount));
  return Math.min(exp, capMs);
}

export interface OutboxDeps {
  readonly store: OutboxStore;
  readonly send: OutboxSendFn;
  /** Injectable epoch-ms clock (testing). Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Invoked once per TTL-expired entry, AFTER `store.deadLetter(id)` has
   * already run. This is the decision-layer escalation hook DR-038
   * Decision 4 requires ("a `gh issue` to the operator/reporter... a
   * decision-layer action... NOT a store-driver method") — this slice does
   * NOT implement the GitHub call itself; a later wiring slice supplies a
   * real callback. A throw from this callback is caught + logged, never
   * allowed to abort the rest of the drive tick.
   */
  readonly onDeadLetter?: (entry: OutboxEntry) => void | Promise<void>;
  readonly logger?: Logger;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly ttlMs?: number;
}

/** Per-tick counters, mainly for test assertions + operator diagnostics. */
export interface OutboxDriveSummary {
  readonly attempted: number;
  readonly acked: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export interface Outbox {
  /**
   * Persist a NEW message BEFORE any send attempt (Decision 1: persist-
   * then-send). Mints a fresh message-id (Decision 2) and returns it.
   */
  readonly enqueue: (target: string, payload: unknown) => Promise<string>;
  /**
   * Drive one retry tick: for every pending entry whose `nextAttemptAt <=
   * now`, either dead-letter it (TTL expired — checked BEFORE attempting
   * another send) or attempt a send (ack → `markAcked`; failure →
   * `reschedule` with the next backoff). Callable directly by tests with an
   * explicit `now`, or wrapped in an operator-driven loop with injected
   * sleep between ticks.
   */
  readonly driveOnce: (now?: number) => Promise<OutboxDriveSummary>;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const { store, send, onDeadLetter, logger } = deps;
  const now = deps.now ?? Date.now;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  async function enqueue(target: string, payload: unknown): Promise<string> {
    const id = mintMessageId();
    const t = now();
    const entry: OutboxEntry = {
      id,
      target,
      payload,
      enqueuedAt: t,
      nextAttemptAt: t, // eligible for the first attempt immediately
      attemptCount: 0,
    };
    await store.enqueue(entry);
    return id;
  }

  async function driveOnce(nowOverride?: number): Promise<OutboxDriveSummary> {
    const t = nowOverride ?? now();
    const pending = await store.listPending();
    let attempted = 0;
    let acked = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const entry of pending) {
      if (entry.nextAttemptAt > t) continue; // not due yet

      // TTL check takes priority over attempting another send: once the
      // wall-clock budget is spent, Decision 4 downgrades to the
      // always-durable GitHub-anchored escalation rather than retrying
      // further — dead-letter is a downgrade to a durable substrate, not
      // "give up."
      if (t - entry.enqueuedAt > ttlMs) {
        await store.deadLetter(entry.id);
        deadLettered++;
        if (onDeadLetter !== undefined) {
          try {
            await onDeadLetter(entry);
          } catch (err) {
            logger?.warn('outbox_dead_letter_callback_failed', {
              id: entry.id,
              target: entry.target,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        continue;
      }

      attempted++;
      let result: OutboxSendResult;
      try {
        result = await send(entry.target, entry.id, entry.payload);
      } catch (err) {
        logger?.warn('outbox_send_failed', {
          id: entry.id,
          target: entry.target,
          error: err instanceof Error ? err.message : String(err),
        });
        result = { ack: false };
      }

      if (result.ack) {
        await store.markAcked(entry.id);
        acked++;
      } else {
        failed++;
        const nextAttemptCount = entry.attemptCount + 1;
        const backoff = computeBackoffMs(entry.attemptCount, backoffBaseMs, backoffCapMs);
        await store.reschedule(entry.id, t + backoff, nextAttemptCount);
      }
    }

    return { attempted, acked, failed, deadLettered };
  }

  return { enqueue, driveOnce };
}
