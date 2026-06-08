/**
 * `notify_peer` MCP tool implementation per macf#256 / DR-023 UC-1.
 *
 * Registered on the channel-server's MCP surface; called by Claude Code's
 * plugin loader when the `Stop` hook fires (per `packages/macf/plugin/hooks/hooks.json`).
 * The tool resolves the peer agent's channel-server URL from the project
 * registry, then sends a notification payload to the peer's `/notify`
 * HTTP endpoint over mTLS.
 *
 * Failure semantics (per DR-023 §"Failure-mode contract" + §UC-1):
 *
 *   The hook layer is observational + non-blocking by default. All errors
 *   (peer unreachable, TLS handshake failure, peer rejected payload) are
 *   surfaced as `isError: true` — the LLM sees the error in the tool
 *   response + can self-correct, but the `Stop` event itself is NOT
 *   blocked. Polling-fallback (existing pattern: peer's SessionStart
 *   hook checks GitHub queue) catches missed notifications.
 *
 * `to` field semantic (refinement from DR-023 design — see macf#256
 * Option A):
 *
 *   `to` is OPTIONAL. When absent, the tool fans out to all peer
 *   agents registered in the project (registry `list()`). When
 *   present, it's a single-peer POST. This keeps the plugin-shipped
 *   hook entry universal across consumer workspaces (no per-agent
 *   `to:` customization needed).
 */
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Registry, AgentInfo } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import { z } from 'zod';
// macf#267 Findings 3+4: OTel span on outbound notify_peer + W3C
// traceparent propagation to receiver. `propagation.inject()` writes
// the traceparent + tracestate headers; `trace.getTracer()` provides
// the per-call CLIENT span. See @opentelemetry/api 1.x propagation
// API (canonical, verified at impl time).
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { buildInvokeAgentSpanName, Attr, GenAiAttr } from './tracing.js';
import { getNotifyPeerCounter, MetricAttr } from './metrics.js';
import { A2aClient, A2aClientError } from './a2a-client.js';
import type { Message } from './a2a-types.js';
import { intentSummary } from './comms-ledger.js';
import type { CommsLedgerEdge } from './comms-ledger.js';

export const NotifyPeerInputSchema = {
  to: z.string().optional()
    .describe('Peer agent name to notify. If omitted, broadcasts to all registered peers in the project.'),
  event: z.enum(['session-end', 'turn-complete', 'error', 'custom'])
    .describe('Event type triggering the notification. Receiver-side wake policy keys off this field (macf#355): `custom` (operator-driven) wakes the receiver TUI; `session-end` / `turn-complete` / `error` (Stop-hook autonomous) are observational-only — Pattern E preserves cross-agent Stop-hook loop prevention.'),
  message: z.string().optional()
    .describe('Optional human-readable message body.'),
  context: z.record(z.string(), z.unknown()).optional()
    .describe('Optional structured context payload (string-keyed object).'),
  // macf#473 piece 2 (DR-025): an optional GitHub object this nudge is tied
  // to (`owner/repo#N`), so an off-GitHub A2A edge stitches back to its
  // on-GitHub object in the comms-ledger graph. Defaults to null (a pure
  // nudge). Carried in the outbound A2A Message's `metadata.github_anchor`
  // so the receiver can record the same anchor on its recv edge.
  github_anchor: z.string().nullable().optional()
    .describe('Optional GitHub anchor (owner/repo#N) this notification is tied to, for the comms-ledger graph join. Null/omitted for a pure nudge.'),
} as const;

export const NotifyPeerOutputSchema = {
  delivered: z.boolean()
    .describe('True if at least one peer received HTTP 200 from /notify.'),
  channel_state: z.enum(['online', 'offline'])
    .describe('Aggregate state — "online" if at least one peer reachable, "offline" otherwise.'),
  peers_attempted: z.number().int().nonnegative()
    .describe('Number of peers the tool attempted to notify.'),
  peers_delivered: z.number().int().nonnegative()
    .describe('Subset of attempted peers that returned HTTP 200.'),
} as const;

export interface NotifyPeerDeps {
  readonly registry: Registry;
  readonly selfAgentName: string;
  readonly mTlsClientCertPem: string;
  readonly mTlsClientKeyPem: string;
  readonly caCertPem: string;
  readonly logger: Logger;
  /**
   * Optional outbound A2A client for protocol-selection (macf#396 Phase 3).
   * If absent, falls back to the legacy `/notify` envelope for all peers.
   * server.ts wires this when constructing the deps; tests can inject a
   * stub or omit entirely to exercise legacy-only paths.
   */
  readonly a2aClient?: A2aClient;
  /**
   * macf#473 piece 2 (DR-025): record an authoritative outbound comms-ledger
   * edge per peer once the dispatch outcome is known. Optional — pre-#473
   * deps (and most tests) omit it and the send site skips the ledger record.
   * Loud-but-proceeds: this closure never throws (server.ts binds it through
   * `recordEdge`).
   */
  readonly recordLedgerEdge?: (edge: CommsLedgerEdge) => void;
}

export interface NotifyPeerInput {
  readonly to?: string;
  readonly event: 'session-end' | 'turn-complete' | 'error' | 'custom';
  readonly message?: string;
  readonly context?: Record<string, unknown>;
  /** macf#473 piece 2: optional GitHub anchor (owner/repo#N) for the ledger graph join. */
  readonly github_anchor?: string | null;
}

export interface NotifyPeerResult {
  readonly delivered: boolean;
  readonly channel_state: 'online' | 'offline';
  readonly peers_attempted: number;
  readonly peers_delivered: number;
}

/**
 * Resolve target peer list. Single-peer mode if `to` provided; broadcast
 * to all-but-self otherwise. Always excludes self to prevent the
 * (server, tool, input) deduplication cycle DR-023 §"Cycle prevention"
 * warns about.
 *
 * Self-exclusion comparison normalizes via `toVariableSegment` because
 * Registry.list() returns names in GitHub-Variables-canonical form
 * (uppercased, hyphens-to-underscores per
 * `@groundnuty/macf-core:registry/variable-name.ts`), while
 * `selfAgentName` is the canonical agent identity (lowercased,
 * hyphenated). Comparing raw strings would never match → broadcasts
 * would loop back to self, triggering the dedup-cycle the §"Cycle
 * prevention" decision tree warns about. Bug surfaced in macf#256
 * empirical validation; fix scoped here per Option B.
 */
async function resolveTargetPeers(
  deps: NotifyPeerDeps,
  to: string | undefined,
): Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>> {
  const selfNormalized = toVariableSegment(deps.selfAgentName);
  if (to !== undefined && to !== '') {
    if (toVariableSegment(to) === selfNormalized) return [];
    const info = await deps.registry.get(to);
    if (info === null) return [];
    return [{ name: to, info }];
  }
  // Broadcast: list all registered peers, exclude self. Normalize BOTH
  // sides since Registry.list() can return names in either canonical
  // or variable form depending on the GitHubVariablesClient impl —
  // safest comparison normalizes both.
  const all = await deps.registry.list('');
  return all.filter(p => toVariableSegment(p.name) !== selfNormalized);
}

/**
 * Send a single mTLS POST to `https://${host}:${port}/notify` with the
 * payload as JSON. Returns true on HTTP 200, false on any other status
 * (peer alive but rejected) or transport error (peer unreachable).
 *
 * Distinguishes "peer alive + rejected" from "peer unreachable" via the
 * caller's outer aggregation (peer-alive returns false; transport-error
 * also returns false, but the next channel_state derivation can use the
 * stats to surface aggregate health).
 */
function postToPeer(
  deps: NotifyPeerDeps,
  peer: { readonly name: string; readonly info: AgentInfo },
  payload: object,
  timeoutMs: number,
): Promise<{ readonly httpOk: boolean; readonly transportOk: boolean }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    // macf#267 Finding 4: inject W3C traceparent on outbound POST so
    // receiver's NotifyReceived span becomes a child of the calling
    // agent's notify_peer span (cross-channel-server trace correlation).
    // propagation.inject() writes into the headers carrier using the
    // global propagator (ProvidedBy NodeTracerProvider in src/otel.ts).
    // The carrier is a plain object; node:https consumes it as request
    // headers verbatim.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    };
    propagation.inject(context.active(), headers);
    const req = httpsRequest(
      {
        hostname: peer.info.host,
        port: peer.info.port,
        path: '/notify',
        method: 'POST',
        cert: deps.mTlsClientCertPem,
        key: deps.mTlsClientKeyPem,
        ca: deps.caCertPem,
        // Channel server's cert SAN may not match host name when
        // advertise_host=127.0.0.1 (the canonical loopback case);
        // mTLS ensures identity via cert chain, not hostname.
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const httpOk = res.statusCode === 200;
        // Drain response body so socket can free; we don't care about content.
        res.resume();
        res.on('end', () => resolve({ httpOk, transportOk: true }));
      },
    );
    req.on('error', (err) => {
      deps.logger.warn('notify_peer_transport_error', {
        peer: peer.name,
        host: peer.info.host,
        port: String(peer.info.port),
        error: err.message,
      });
      resolve({ httpOk: false, transportOk: false });
    });
    req.on('timeout', () => {
      deps.logger.warn('notify_peer_timeout', {
        peer: peer.name,
        host: peer.info.host,
        port: String(peer.info.port),
        timeoutMs: String(timeoutMs),
      });
      req.destroy();
      resolve({ httpOk: false, transportOk: false });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Build the outbound URL for a peer's channel-server (used by A2A path
 * for AgentCard discovery + message/send target).
 */
function peerBaseUrl(peer: { readonly info: AgentInfo }): string {
  return `https://${peer.info.host}:${peer.info.port}`;
}

/**
 * Construct an A2A v1.0 Message from a notify_peer payload. The Message
 * shape encodes the legacy envelope's semantic fields (event, source,
 * message body, context) into A2A-canonical structure so the receiver
 * (after Phase 3.5 receiver-side wake-decision integration) can route
 * appropriately.
 *
 * - `messageId`: fresh UUID per call (spec § 4.1.4 — required)
 * - `role`: ROLE_USER (sender's perspective; spec § 4.1.5 — client→server)
 * - `parts[0]`: text with a human-readable summary of the notification
 * - `metadata.event` + `metadata.source` + `metadata.context`: structured
 *   payload preserved verbatim so receiver-side handlers can read them
 *
 * NOTE: Phase 3 ships the SENDER side only. The receiver's `/a2a/v1`
 * handler currently creates a Task COMPLETED for any message/send +
 * doesn't consult `decideWake`. Phase 3.5 (followup issue) wires the
 * receiver-side metadata-driven wake-decision routing so that custom
 * events on the A2A path still wake the receiver TUI.
 */
function buildA2aMessageFromPayload(
  input: NotifyPeerInput,
  selfAgentName: string,
): Message {
  const summary = input.message ?? `Notification from ${selfAgentName} (event=${input.event})`;
  return {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: summary }],
    metadata: {
      event: input.event,
      source: selfAgentName,
      ...(input.context !== undefined ? { context: input.context } : {}),
      // macf#473 piece 2: carry the github_anchor on the wire so the
      // receiver records the same anchor on its recv edge (graph join).
      ...(input.github_anchor != null ? { github_anchor: input.github_anchor } : {}),
    },
  };
}

/**
 * Decide which outbound protocol to use for a given peer (macf#396 Phase 3
 * design Q6 decision tree; the `event === 'custom' → legacy` carve-out was
 * LIFTED in macf#428 Phase 3.5 once receiver-side decideWake was wired on
 * the A2A path — so `custom` now travels A2A + wakes via the receiver):
 *
 *   1. `MACF_OUTBOUND_LEGACY=1` env var → legacy `/notify`
 *   2. No A2aClient configured → legacy `/notify`
 *   3. Peer publishes valid AgentCard with `protocolBinding === 'JSONRPC'`
 *      in any `supportedInterfaces[]` entry → A2A path
 *   4. Otherwise → legacy `/notify` (with warning span attribute)
 *
 * Protocol selection is **event-independent**: every event (including the
 * operator-driven `custom`) prefers A2A when the peer supports it. The
 * receiver applies Pattern E per-event via `decideWake` (custom → wake;
 * autonomous turn-complete/session-end/error → push-only) — so cross-agent
 * Stop-hook loop-prevention is preserved at the receiver regardless of
 * transport (macf#428; the sender no longer needs to special-case it).
 *
 * Returns `'a2a'` or `'legacy'`. Caller dispatches accordingly. AgentCard
 * fetch failures + schema-validation failures fall through to legacy with
 * the failure logged at warn level (not fatal — legacy path is safe).
 */
async function selectOutboundProtocol(
  deps: NotifyPeerDeps,
  peer: { readonly name: string; readonly info: AgentInfo },
): Promise<'a2a' | 'legacy'> {
  if (process.env['MACF_OUTBOUND_LEGACY'] === '1') {
    return 'legacy';
  }
  if (deps.a2aClient === undefined) {
    return 'legacy';
  }
  try {
    const card = await deps.a2aClient.getAgentCard(peerBaseUrl(peer));
    if (card === null) {
      // macf#422 Bug-2: a peer that returns 404/401/403 on AgentCard
      // discovery yields a clean `null` (NOT an exception) — so this
      // branch previously fell back to legacy SILENTLY, while the catch
      // block (transport/5xx/schema-fail) warned. A stale pre-v0.2.24
      // instance (no /.well-known/agent-card.json) hits exactly this path:
      // legacy routing + delivered:true, with no signal that A2A never ran.
      // Warn for symmetry with the catch so the operator can see WHY.
      deps.logger.warn('notify_peer_a2a_no_agent_card', {
        peer: peer.name,
        url: peerBaseUrl(peer),
      });
      return 'legacy';
    }
    const hasJsonRpcBinding = card.supportedInterfaces.some(
      (iface) => iface.protocolBinding === 'JSONRPC',
    );
    if (!hasJsonRpcBinding) {
      // macf#422 Bug-2: AgentCard present but no JSONRPC binding (e.g. a
      // pre-Phase-2c instance whose supportedInterfaces predate the
      // proto-aligned binding) → legacy. Previously silent; include the
      // bindings actually seen so a version-skewed peer is diagnosable.
      deps.logger.warn('notify_peer_a2a_no_jsonrpc_binding', {
        peer: peer.name,
        url: peerBaseUrl(peer),
        bindings: card.supportedInterfaces.map((iface) => iface.protocolBinding),
      });
      return 'legacy';
    }
    return 'a2a';
  } catch (err) {
    deps.logger.warn('notify_peer_agent_card_fetch_failed', {
      peer: peer.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'legacy';
  }
}

/**
 * Dispatch a notification to a single peer via either A2A `message/send`
 * or legacy `/notify` POST, depending on `selectOutboundProtocol()`'s
 * decision.
 *
 * Returns the same shape postToPeer returns — caller aggregates uniformly
 * across both protocols. `httpOk: true` means the peer ACCEPTED the
 * notification (A2A: returned a Task with non-error state; legacy: HTTP 200).
 * `transportOk: true` means the peer was REACHABLE (TLS + connect succeeded).
 *
 * The wrapping `invoke_agent {target}` span (set by `notifyPeer`'s
 * tracer scope) is shared across both protocols; this function sets
 * the `macf.outbound.protocol` attribute on the span to disambiguate.
 */
async function dispatchToPeer(
  deps: NotifyPeerDeps,
  peer: { readonly name: string; readonly info: AgentInfo },
  input: NotifyPeerInput,
  legacyPayload: object,
  timeoutMs: number,
): Promise<{ readonly httpOk: boolean; readonly transportOk: boolean }> {
  const protocol = await selectOutboundProtocol(deps, peer);
  const span = trace.getActiveSpan();
  if (span !== undefined) {
    span.setAttribute(Attr.OutboundProtocol, protocol);
  }

  // The A2A message id (when the A2A path is taken) doubles as the ledger
  // msg_id; for the legacy path there is no natural id so we generate one.
  let msgId: string | undefined;
  let result: { readonly httpOk: boolean; readonly transportOk: boolean };

  if (protocol === 'legacy') {
    result = await postToPeer(deps, peer, legacyPayload, timeoutMs);
  } else {
    // A2A path: construct message + send + map outcome.
    const message = buildA2aMessageFromPayload(input, deps.selfAgentName);
    msgId = message.messageId;
    try {
      const task = await deps.a2aClient!.sendMessage(
        `${peerBaseUrl(peer)}`,
        message,
        { target: peer.name },
      );
      const state = task.status.state;
      // Treat non-error terminal states as "delivered". REJECTED is the
      // canonical "agent declined" state — treat as not-delivered.
      const accepted =
        state === 'TASK_STATE_COMPLETED'
        || state === 'TASK_STATE_WORKING'
        || state === 'TASK_STATE_SUBMITTED'
        || state === 'TASK_STATE_INPUT_REQUIRED'
        || state === 'TASK_STATE_AUTH_REQUIRED';
      result = { httpOk: accepted, transportOk: true };
    } catch (err) {
      deps.logger.warn('notify_peer_a2a_error', {
        peer: peer.name,
        code: err instanceof A2aClientError ? err.code : 'UNKNOWN',
        error: err instanceof Error ? err.message : String(err),
      });
      const transportOk = !(err instanceof A2aClientError) || err.code !== 'TRANSPORT_ERROR';
      result = { httpOk: false, transportOk };
    }
  }

  // macf#473 piece 2: record the authoritative outbound SEND edge once the
  // dispatch OUTCOME is known. Unlike the recv sites, "append-before-deliver"
  // does not apply here — `delivered` must reflect the actual send result,
  // which is only known after the dispatch. `delivered` is set from `httpOk`
  // (the peer ACCEPTED the notification). trace_id comes from the active
  // CLIENT span (`invoke_agent`) set by notifyPeer. Loud-but-proceeds:
  // recordLedgerEdge never throws.
  if (deps.recordLedgerEdge !== undefined) {
    deps.recordLedgerEdge({
      ts: new Date().toISOString(),
      from: deps.selfAgentName,
      to: peer.name,
      // A notify_peer send is ALWAYS a DIRECT peer-to-peer exchange — both the
      // a2a-client path AND the legacy /notify POST go straight to the peer's
      // channel-server; neither traverses the macf-actions router. The
      // `github-route` channel is reserved for edges that actually went
      // THROUGH the router (recv side of mention/issue_routed/pr_review_state).
      channel: 'a2a',
      direction: 'send',
      event: input.event,
      msg_id: msgId ?? randomUUID(),
      intent_summary: intentSummary(input.message),
      github_anchor: input.github_anchor ?? null,
      delivered: result.httpOk,
      processed: null,
      trace_id: span?.spanContext().traceId ?? '',
    });
  }

  return result;
}

/**
 * Tool body — resolves peers, fans out, aggregates.
 *
 * Per-peer timeout is 5s (macf#267 Finding 1 fix; was 1s in v0.2.3,
 * which cut off mid-receiver-wake; comfortable margin even after
 * Finding 2's Option (d) makes /notify return ~5ms for peer_notification).
 *
 * macf#267 Finding 3: wraps in OTel CLIENT span (post-macf#369:
 * `invoke_agent {target}` per OTel GenAI Agent Spans semconv; was
 * `macf.tool.notify_peer` pre-#369)
 * with attributes (target, event, peers_attempted, peers_delivered) so
 * sender-side latency + outcome are visible in Phase D / Claim 1b traces.
 *
 * macf#267 Finding 4: per-peer postToPeer injects W3C traceparent on
 * outbound POST so receiver's NotifyReceived span becomes a child of
 * this notify_peer span (cross-channel-server trace correlation).
 */
export async function notifyPeer(
  deps: NotifyPeerDeps,
  input: NotifyPeerInput,
): Promise<NotifyPeerResult> {
  const tracer = trace.getTracer('macf');
  // macf#369 (A2A Phase 0): outbound CLIENT-kind span follows OTel
  // GenAI Agent Spans semconv for `invoke_agent` operations. Span name
  // is dynamic per target peer (`invoke_agent <target>` for single-peer
  // mode; bare `invoke_agent` for broadcast per spec fallback). The
  // per-span `gen_ai.agent.name` attribute carries the TARGET peer
  // (distinct from the per-resource `gen_ai.agent.name` set by
  // env.telemetry — which is the EMITTING agent). TraceQL queries
  // disambiguate via `resource.` vs `span.` prefix (devops-agent
  // 2026-05-18 confirmation on #369; observability-snapshot.sh
  // queries get dual-scope examples post-merge).
  //
  // Receiver-side incoming-span operation name (peer_notify) is set
  // independently in https.ts onNotify via operationNameForNotifyType()
  // — sender-side and receiver-side spans carry different GenAI
  // operation semantics and that's correct under the spec.
  return tracer.startActiveSpan(
    buildInvokeAgentSpanName(input.to),
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GenAiAttr.System]: 'macf',
        [GenAiAttr.OperationName]: 'invoke_agent',
        // Per-span gen_ai.agent.name = the TARGET peer being invoked.
        // Omitted entirely on broadcast (no single target). See OTel
        // GenAI Agent Spans spec § "Span name" + § "Recommended
        // attributes" (conditionally required).
        ...(input.to !== undefined && input.to.length > 0
          ? { [GenAiAttr.AgentName]: input.to }
          : {}),
        [Attr.NotifyType]: 'peer_notification',
        [Attr.NotifyEvent]: input.event,
        [Attr.NotifyTarget]: input.to ?? 'broadcast',
      },
    },
    async (span) => {
      try {
        const peers = await resolveTargetPeers(deps, input.to);
        if (peers.length === 0) {
          span.setAttribute(Attr.PeersAttempted, 0);
          span.setAttribute(Attr.PeersDelivered, 0);
          span.setStatus({ code: SpanStatusCode.OK });
          return {
            delivered: false,
            channel_state: 'offline' as const,
            peers_attempted: 0,
            peers_delivered: 0,
          };
        }

        const payload = {
          type: 'peer_notification',
          source: deps.selfAgentName,
          event: input.event,
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          // macf#473: carry the anchor on the LEGACY wire too (the A2A path
          // stamps it in Message.metadata.github_anchor). Without this the
          // legacy recv edge can't derive the anchor → silent drop + send/recv
          // graph-join asymmetry.
          ...(input.github_anchor != null ? { github_anchor: input.github_anchor } : {}),
        };

        // macf#396 Phase 3: dispatchToPeer does protocol-selection
        // per-peer (A2A vs legacy /notify) based on AgentCard discovery
        // + the MACF_OUTBOUND_LEGACY env flag + event-class routing.
        // See selectOutboundProtocol() for the decision tree.
        const results = await Promise.all(
          peers.map(p => dispatchToPeer(deps, p, input, payload, 5000)),
        );

        const peers_delivered = results.filter(r => r.httpOk).length;
        const peers_reachable = results.filter(r => r.transportOk).length;

        // testbed#242 T6 / macf#278: notify_peer counter increments
        // ONCE per attempted peer (not once per call). delivered=true|
        // false label distinguishes outcomes so Prometheus can compute
        // delivery rate via `sum(rate(macf_notify_peer_total{delivered=
        // "true"}[5m])) / sum(rate(macf_notify_peer_total[5m]))`.
        // Counter increments BEFORE span finalization so OTel's
        // periodic reader picks them up regardless of span outcome
        // (consistent with the receiver-side notify_received pattern).
        const peerCounter = getNotifyPeerCounter();
        for (const result of results) {
          peerCounter.add(1, {
            [MetricAttr.Event]: input.event,
            [MetricAttr.Delivered]: result.httpOk ? 'true' : 'false',
            [MetricAttr.Agent]: deps.selfAgentName,
          });
        }

        span.setAttribute(Attr.PeersAttempted, peers.length);
        span.setAttribute(Attr.PeersDelivered, peers_delivered);
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          delivered: peers_delivered > 0,
          channel_state: peers_reachable > 0 ? 'online' as const : 'offline' as const,
          peers_attempted: peers.length,
          peers_delivered,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
