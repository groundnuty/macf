/**
 * Shared meter + metric instrument conventions for MACF channel server.
 *
 * Single source of truth for instrument names + attribute keys (parallels
 * `tracing.ts` for spans). Counter increments scattered across `https.ts`
 * (server-side `/notify` handler) and `notify-peer.ts` (client-side
 * outbound) read from this module so the canonical names + label sets
 * stay synchronized.
 *
 * Closes testbed#242 T6 (deferred metrics AC) per macf#278:
 *   - `macf.notify_received_total{type, agent}` — server-side counter,
 *     incremented per inbound /notify request after schema validation
 *   - `macf.notify_peer_total{event, delivered, agent}` — client-side
 *     counter, incremented per notify_peer broadcast (one increment per
 *     attempted peer; `delivered` label distinguishes success / failure)
 *
 * Both counters fire only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
 * `getMeter()` returns a no-op meter (zero-cost) when unset, mirroring
 * `getTracer()`'s pattern in `tracing.ts`. See DR-021 for the
 * zero-cost-default doctrine.
 *
 * Naming convention: `macf.<area>.<metric>_<unit>` per OTel semantic
 * conventions guidance. Counters end in `_total`; histograms (none yet)
 * would end in their unit (e.g., `_duration_ms`).
 */
import { metrics } from '@opentelemetry/api';
import type { Counter, Meter } from '@opentelemetry/api';

/** The single meter instance used across the MACF channel-server codebase. */
export function getMeter(): Meter {
  return metrics.getMeter('macf');
}

/** Metric instrument names — centralized for easy rename + grep. */
export const MetricNames = {
  /**
   * Server-side counter incremented per inbound /notify request after
   * schema validation. Labels: `type` (NotifyType variant), `agent`
   * (this server's agent name). Use to compute scenario-08-style
   * delivery rates + per-type traffic breakdown in Prometheus.
   */
  NotifyReceivedTotal: 'macf.notify_received_total',
  /**
   * Client-side counter incremented per notify_peer broadcast attempt
   * (one increment per attempted peer; `delivered=true|false` label
   * distinguishes outcomes). Labels: `event` (peer_notification event
   * name), `delivered` (bool stringified), `agent` (sender's agent name).
   * Pairs with `NotifyReceivedTotal` for end-to-end counter correlation.
   */
  NotifyPeerTotal: 'macf.notify_peer_total',
  /**
   * Server-side counter incremented per inbound `/macf/sign` request
   * (after EKU gate + method/URL dispatch, before schema validation).
   * Empirical basis for the DR-010 Path-2 "12-month zero-call removal
   * trigger" per macf#371: if this counter shows 0 calls for 12
   * consecutive months from the namespace-rename PR's merge date, we
   * file a follow-up issue to remove the endpoint entirely (and defer
   * live attestation to a future A2A spec extension per Path 1). The
   * canonical-path counter only — legacy `/sign` hits are logged via
   * `sign_redirect_legacy` (counted separately as a redirect log event,
   * not on this counter; the 308 response steers callers to the
   * canonical path which then records here). Labels: `agent` (this
   * server's agent name).
   */
  SignCallsTotal: 'macf.sign_calls_total',
  /**
   * Counter incremented every time a comms-ledger edge write fails
   * (macf#473 piece 2). The ledger writer (`appendEdge`) is fail-loud
   * (throws); the `recordEdge` policy helper catches that throw, emits a
   * LOUD signal, then proceeds with delivery — so an observability-layer
   * failure can never cause a coordination outage. This counter is the
   * machine-readable half of that loud signal (the `logger.error
   * comms_ledger_write_failed` log line is the human-readable half). A
   * non-zero value means at least one authoritative coordination edge was
   * lost: the DR-025 ledger is the durable floor, so any miss is
   * alert-worthy. Labels: `agent` (this server's agent name), `channel`
   * (a2a | github-route), `direction` (send | recv).
   */
  CommsLedgerWriteFailedTotal: 'macf.comms_ledger_write_failed_total',
} as const;

/** Metric attribute keys — separate from span attributes (`Attr` in tracing.ts). */
export const MetricAttr = {
  /** NotifyType variant for the inbound /notify request (mention, peer_notification, etc.). */
  NotifyType: 'macf.notify.type',
  /** This server's agent name (denormalized into the metric for cross-agent aggregation). */
  Agent: 'macf.agent',
  /** Stringified boolean — was this peer's notification HTTP-200'd? */
  Delivered: 'macf.notify.delivered',
  /** peer_notification event name (session-end, turn-complete, error, custom). */
  Event: 'macf.notify.event',
  /** Comms-ledger edge channel (a2a | github-route) — on the write-failed counter (macf#473). */
  Channel: 'macf.comms.channel',
  /** Comms-ledger edge direction (send | recv) — on the write-failed counter (macf#473). */
  Direction: 'macf.comms.direction',
} as const;

/**
 * Lazy-created counter instances. The api's `metrics.getMeter('macf')`
 * returns a no-op meter when no global MeterProvider is registered (the
 * zero-cost default), so calling `.add()` on instruments created from it
 * is safe + free. Re-creation per call would be wasteful but harmless;
 * we cache for the common path.
 */
let cachedNotifyReceivedCounter: Counter | undefined;
let cachedNotifyPeerCounter: Counter | undefined;
let cachedSignCallsCounter: Counter | undefined;
let cachedCommsLedgerWriteFailedCounter: Counter | undefined;

/**
 * Get the cached `macf.notify_received_total` counter, creating it
 * on first access. Safe to call before `bootstrapOtel()` runs — the
 * no-op meter returns no-op instruments when OTEL is disabled.
 */
export function getNotifyReceivedCounter(): Counter {
  cachedNotifyReceivedCounter ??= getMeter().createCounter(MetricNames.NotifyReceivedTotal, {
    description: 'Inbound /notify requests received after schema validation',
    unit: '1',
  });
  return cachedNotifyReceivedCounter;
}

/**
 * Get the cached `macf.notify_peer_total` counter, creating it on
 * first access. Same lazy-create pattern as `getNotifyReceivedCounter`.
 */
export function getNotifyPeerCounter(): Counter {
  cachedNotifyPeerCounter ??= getMeter().createCounter(MetricNames.NotifyPeerTotal, {
    description: 'Outbound notify_peer broadcast attempts (one increment per attempted peer)',
    unit: '1',
  });
  return cachedNotifyPeerCounter;
}

/**
 * Get the cached `macf.sign_calls_total` counter, creating it on
 * first access. Same lazy-create pattern as `getNotifyReceivedCounter`.
 * Empirical basis for DR-010 Path-2 12-month removal trigger
 * (macf#371). Increments fire on every `/macf/sign` hit (canonical
 * path only — legacy `/sign` redirects do NOT increment here, they
 * log `sign_redirect_legacy` instead).
 */
export function getSignCallsCounter(): Counter {
  cachedSignCallsCounter ??= getMeter().createCounter(MetricNames.SignCallsTotal, {
    description: 'Inbound /macf/sign requests received (empirical basis for DR-010 Path-2 12-month removal trigger, macf#371)',
    unit: '1',
  });
  return cachedSignCallsCounter;
}

/**
 * Get the cached `macf.comms_ledger_write_failed_total` counter, creating
 * it on first access. Same lazy-create pattern as the others — safe before
 * `bootstrapOtel()` (no-op meter → no-op instrument when OTEL is disabled).
 * Incremented by the `recordEdge` policy helper's catch block (macf#473
 * piece 2) when an authoritative comms-ledger write fails.
 */
export function getCommsLedgerWriteFailedCounter(): Counter {
  cachedCommsLedgerWriteFailedCounter ??= getMeter().createCounter(MetricNames.CommsLedgerWriteFailedTotal, {
    description: 'Comms-ledger edge writes that failed (loud-but-proceeds policy; non-zero = a lost authoritative coordination edge, macf#473)',
    unit: '1',
  });
  return cachedCommsLedgerWriteFailedCounter;
}

/**
 * Reset cached instruments. ONLY for use in tests that need to swap in
 * a fresh MeterProvider between cases. Do not call from production
 * code — the cache is correct under any normal lifecycle.
 */
export function resetMetricsCacheForTesting(): void {
  cachedNotifyReceivedCounter = undefined;
  cachedNotifyPeerCounter = undefined;
  cachedSignCallsCounter = undefined;
  cachedCommsLedgerWriteFailedCounter = undefined;
}
