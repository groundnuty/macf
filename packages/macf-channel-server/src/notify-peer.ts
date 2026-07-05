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
import type { Registry, AgentInfo } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';
import { toVariableSegment, fromVariableSegment } from '@groundnuty/macf-core';
// DR-041 Amendment A (groundnuty/macf#786): the unified cross-fleet guest
// resolution ladder — same implementation `macf-ping` reuses (see
// packages/macf/src/plugin/bin/macf-plugin-cli.ts) so the addressing gate +
// its error text never drifts between call sites.
import { resolveGuestAddress } from '@groundnuty/macf-core';
import type { CrossProjectAgentResolver } from '@groundnuty/macf-core';
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
// DR-038 Slice B: the durable outbox this module now sends THROUGH (persist-
// then-send, Decision 1) instead of dispatching directly.
import type { Outbox, OutboxSendFn } from './delivery/outbox.js';

export const NotifyPeerInputSchema = {
  to: z.string().optional()
    .describe('Peer agent name to notify. If omitted, broadcasts to all registered peers in the project.'),
  event: z.enum(['session-end', 'session-compact', 'turn-complete', 'error', 'custom'])
    .describe('Event type triggering the notification. Receiver-side wake policy keys off this field (macf#355): `custom` (operator-driven) wakes the receiver TUI; `session-end` / `session-compact` / `turn-complete` / `error` (autonomous-flow) are observational-only — Pattern E preserves cross-agent Stop-hook loop prevention. `session-compact` (macf#673) is the PreCompact-hook event, distinct from the SessionEnd `session-end`.'),
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
  // DR-041 Amendment A (macf#786): a `<project>/<name>` cross-fleet guest
  // target that fails the resolution ladder (home fleet not in
  // `federated_cas`, or the guest's home-project registry slot is missing)
  // surfaces here as a CLEAR message instead of a silent `peers_attempted:0`.
  // Absent on success, and absent for a plain own-project `to` (unchanged
  // pre-#786 "peer not registered" shape has no error field either).
  error: z.string().optional()
    .describe('Clear resolution error for a cross-fleet guest `to` (`<project>/<name>`) that failed the DR-041 Amendment A addressing ladder — home fleet not federated, or not found in the guest\'s home-project registry. Absent on success or for a plain own-project `to`.'),
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
  /**
   * DR-038 Slice B: the durable, process-lifetime outbox `notifyPeer()` now
   * enqueues every dispatch through (persist-then-send, Decision 1), instead
   * of dispatching directly. Constructed ONCE at server startup (`server.ts`)
   * over a pluggable `OutboxStore` driver (`delivery/driver.ts`) with `send`
   * wired to `createNotifyOutboxSend()`'s adapter (below) — so retry state
   * survives across `notify_peer` calls (and, once a durable store driver
   * lands per DR-008, across this sender's own restarts).
   */
  readonly outbox: Outbox;
  /**
   * DR-038 Slice B: the read-once side-channel populated by
   * `createNotifyOutboxSend()`'s adapter on every send attempt, keyed by
   * outbox message-id. `Outbox.driveOnce()`'s public contract only returns
   * AGGREGATE counts (attempted/acked/failed/deadLettered), not per-entry
   * outcomes — this map is what lets `notifyPeer()` recover the SAME
   * per-peer {httpOk, transportOk} granularity the pre-DR-038 direct-dispatch
   * path returned synchronously (needed to preserve the `channel_state`
   * online-vs-offline distinction: "peer alive but rejected" vs "peer
   * unreachable"). `notifyPeer()` reads-and-deletes its own ids after the
   * immediate `driveOnce()` call; an id that needs a LATER retry (driven by
   * the periodic `outbox-ticker.ts`, after the originating `notifyPeer()`
   * call already returned) leaves one entry here that is simply overwritten
   * on the next attempt for that id and never independently unbounded — see
   * `createNotifyOutboxSend`'s doc comment for the full accepted-tradeoff note.
   */
  readonly outboxAttempts: Map<string, NotifyOutboxAttempt>;
  /**
   * DR-041 Amendment A (groundnuty/macf#786): federated project identifiers
   * this agent trusts — mirrors `.github/macf-fleet.json`'s `federated_cas`,
   * loaded ONCE at server startup via `trust-bundle.ts`'s
   * `loadFederatedCaProjects` and threaded here as the SAME list (not
   * re-parsed) per `server.ts`. Gates outbound addressing of a
   * `<project>/<name>` cross-fleet guest slug: a guest's home project MUST
   * appear here or the send fails with a clear DR-041 error rather than a
   * silent `peers_attempted:0`. Omitted (or `[]`, the DR-024 local-mode
   * case — a non-empty `federated_cas` there throws at channel-server
   * startup, per trust-bundle.ts) means "no federation": every
   * `<project>/<name>` target fails rung 2.
   */
  readonly federatedCas?: readonly string[];
  /**
   * DR-041 Amendment A: resolve a federated guest's home-project registry
   * slot — `(homeProject, name) → AgentInfo | null`. `server.ts` wires this
   * from the SAME shared-registry client (`varsClient`) already used for the
   * trust-bundle's federated CA cert reads + the `/sign` flow — a federated
   * fleet's `<PROJECT>_AGENT_<NAME>` slot lives in that SAME shared registry
   * namespace (DR-006 shared profile scope), just under a different project
   * prefix. Mirrors `fleet-guests.ts`'s `GuestResolveFn` (DR-036) exactly —
   * kept as an independent field (not that type) because this package does
   * not depend on the `macf` CLI package; the SHARED ladder logic lives in
   * macf-core's `resolveGuestAddress` instead. Omitted → cross-project
   * resolution is unavailable (structurally unreachable in practice, since
   * `federatedCas` is always `[]` whenever this is `undefined`).
   */
  readonly resolveCrossProjectAgent?: CrossProjectAgentResolver;
}

export interface NotifyPeerInput {
  readonly to?: string;
  readonly event: 'session-end' | 'session-compact' | 'turn-complete' | 'error' | 'custom';
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
  /** DR-041 Amendment A (macf#786) — see `NotifyPeerOutputSchema.error` doc. */
  readonly error?: string;
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
): Promise<{
  readonly peers: ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>;
  /** DR-041 Amendment A (macf#786) — see `resolvePeerAddress`'s doc comment. */
  readonly error?: string;
}> {
  const selfNormalized = toVariableSegment(deps.selfAgentName);
  if (to !== undefined && to !== '') {
    if (toVariableSegment(to) === selfNormalized) return { peers: [] };
    const { info, error } = await resolvePeerAddress(deps, to);
    if (error !== undefined) return { peers: [], error };
    if (info === null) return { peers: [] };
    return { peers: [{ name: to, info }] };
  }
  // Broadcast: list all registered peers, exclude self. Normalize BOTH
  // sides since Registry.list() can return names in either canonical
  // or variable form depending on the GitHubVariablesClient impl —
  // safest comparison normalizes both. Own-project ONLY — DR-041 Amendment
  // A extends explicit single-peer `to` addressing, not broadcast fan-out;
  // guests are never included in a broadcast.
  const all = await deps.registry.list('');
  return { peers: all.filter(p => toVariableSegment(p.name) !== selfNormalized) };
}

/**
 * DR-041 Amendment A (groundnuty/macf#786): resolve ONE address string to its
 * `AgentInfo`, guest-aware. The SINGLE implementation reused at BOTH initial
 * resolution (`resolveTargetPeers`, above) and outbox retry-time
 * RE-resolution (`createNotifyOutboxSend`'s `send`, below) — a guest peer's
 * LATER retries stay guest-aware too, not just the first attempt, exactly
 * mirroring why an own-project peer is already re-resolved at send time (a
 * retry gap can see host/port change via relaunch or collision takeover).
 *
 * A `<project>/<name>` slug is resolved via macf-core's `resolveGuestAddress`
 * (reusing `parseGuestAgentRef` + gating on `deps.federatedCas` — the #785
 * trust bundle is the SOLE admission gate per DR-041 Amendment A decision 1,
 * NOT the `guests` binding). ANY other shape (rung 4) falls through to the
 * UNCHANGED own-project `deps.registry.get()` lookup — byte-identical to the
 * pre-#786 behavior.
 *
 * `error` is populated ONLY for a guest-ref that fails rung 2 (home fleet not
 * federated) or rung 3 (registry slot missing) — the DR-041 Amendment A
 * "clear error, not silent peers_attempted:0" AC. A bare own-project miss
 * (rung 4) carries NO error — unchanged pre-#786 "peer not registered" shape
 * (`peers_attempted:0`, no error field).
 */
async function resolvePeerAddress(
  deps: NotifyDispatchDeps,
  to: string,
): Promise<{ readonly info: AgentInfo | null; readonly error?: string }> {
  const guestResolution = await resolveGuestAddress(
    to,
    deps.federatedCas ?? [],
    deps.resolveCrossProjectAgent ?? (() => Promise.resolve(null)),
  );
  switch (guestResolution.kind) {
    case 'resolved':
      return { info: guestResolution.info };
    case 'not-federated':
    case 'not-found':
      return { info: null, error: guestResolution.error };
    case 'not-a-guest-ref':
      return { info: await deps.registry.get(to) };
  }
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
  deps: NotifyDispatchDeps,
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
 * Build the legacy `/notify` envelope from a notify_peer input — pure,
 * per-peer-invariant (no per-peer info, so callers used to build it ONCE and
 * reuse across peers; DR-038 Slice B rebuilds it fresh per outbox send
 * attempt instead, which is cheap and keeps `dispatchToPeer` self-contained).
 * `message_id` is NOT included here — the caller (`dispatchToPeer`) stamps it
 * from the outbox-supplied stable id at send time (DR-038 Decision 2: the id
 * must be the SAME across every retry, and this function has no id of its
 * own to offer).
 */
function buildLegacyPayload(input: NotifyPeerInput, selfAgentName: string): Record<string, unknown> {
  return {
    type: 'peer_notification',
    source: selfAgentName,
    event: input.event,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    // macf#473: carry the anchor on the LEGACY wire too (the A2A path
    // stamps it in Message.metadata.github_anchor). Without this the
    // legacy recv edge can't derive the anchor → silent drop + send/recv
    // graph-join asymmetry.
    ...(input.github_anchor != null ? { github_anchor: input.github_anchor } : {}),
  };
}

/**
 * Construct an A2A v1.0 Message from a notify_peer payload. The Message
 * shape encodes the legacy envelope's semantic fields (event, source,
 * message body, context) into A2A-canonical structure so the receiver
 * (after Phase 3.5 receiver-side wake-decision integration) can route
 * appropriately.
 *
 * - `messageId`: the STABLE id supplied by the caller (DR-038 Decision 2 —
 *   minted ONCE at outbox-enqueue, reused verbatim on every retry; this
 *   function no longer mints its own, which would break receiver-side
 *   dedup on a retried A2A send — a redelivery under a fresh id would look
 *   like a brand-new message to `InboxStore.persist()`)
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
  id: string,
): Message {
  const summary = input.message ?? `Notification from ${selfAgentName} (event=${input.event})`;
  return {
    messageId: id,
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
  deps: NotifyDispatchDeps,
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
 *
 * DR-038 Slice B: `id` is now a REQUIRED parameter — the stable outbox
 * message-id (Decision 2), supplied by the caller (the outbox `send` seam,
 * `createNotifyOutboxSend` below) and stamped onto the wire payload for
 * BOTH protocols (legacy `message_id` field / A2A `Message.messageId`) —
 * the SAME id on every retry, which is the whole receiver-side dedup key.
 * `dispatchToPeer` no longer builds `legacyPayload` from a caller-supplied
 * object; it derives it fresh from `input` via `buildLegacyPayload` (cheap,
 * and keeps this function self-contained for the outbox's per-attempt calls).
 */
async function dispatchToPeer(
  deps: NotifyDispatchDeps,
  peer: { readonly name: string; readonly info: AgentInfo },
  input: NotifyPeerInput,
  id: string,
  timeoutMs: number,
): Promise<{ readonly httpOk: boolean; readonly transportOk: boolean }> {
  const protocol = await selectOutboundProtocol(deps, peer);
  const span = trace.getActiveSpan();
  if (span !== undefined) {
    span.setAttribute(Attr.OutboundProtocol, protocol);
  }

  let result: { readonly httpOk: boolean; readonly transportOk: boolean };

  if (protocol === 'legacy') {
    const legacyPayload = { ...buildLegacyPayload(input, deps.selfAgentName), message_id: id };
    result = await postToPeer(deps, peer, legacyPayload, timeoutMs);
  } else {
    // A2A path: construct message (stable id stamped in) + send + map outcome.
    const message = buildA2aMessageFromPayload(input, deps.selfAgentName, id);
    try {
      const task = await deps.a2aClient!.sendMessage(
        `${peerBaseUrl(peer)}`,
        message,
        // macf#590: the `target` becomes the span's `gen_ai.agent.name`
        // (telemetry only — the actual dispatch uses peerBaseUrl). In
        // broadcast mode `peer.name` is the GitHub-Variables-canonical
        // registry-key suffix (`DEVOPS_AGENT`); emit the kebab routing-label
        // (`devops-agent`) instead so the span matches the Claude-native
        // OTEL resource attr. Idempotent on an already-kebab single-peer `to`.
        { target: fromVariableSegment(peer.name) },
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
      msg_id: id,
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
  // macf#590: the span name + `gen_ai.agent.name` carry the kebab
  // routing-label (`devops-agent`), never the SCREAMING_SNAKE registry-key
  // form. `input.to` itself is left untouched — it remains the registry
  // LOOKUP key (resolveTargetPeers) + the raw `macf.notify.target` attr.
  // `fromVariableSegment` is idempotent on an already-kebab `to`.
  const targetLabel =
    input.to !== undefined && input.to.length > 0
      ? fromVariableSegment(input.to)
      : undefined;
  return tracer.startActiveSpan(
    buildInvokeAgentSpanName(targetLabel),
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GenAiAttr.System]: 'macf',
        [GenAiAttr.OperationName]: 'invoke_agent',
        // Per-span gen_ai.agent.name = the TARGET peer being invoked.
        // Omitted entirely on broadcast (no single target). See OTel
        // GenAI Agent Spans spec § "Span name" + § "Recommended
        // attributes" (conditionally required).
        ...(targetLabel !== undefined
          ? { [GenAiAttr.AgentName]: targetLabel }
          : {}),
        [Attr.NotifyType]: 'peer_notification',
        [Attr.NotifyEvent]: input.event,
        [Attr.NotifyTarget]: input.to ?? 'broadcast',
      },
    },
    async (span) => {
      try {
        const resolved = await resolveTargetPeers(deps, input.to);
        // DR-041 Amendment A (macf#786): a cross-fleet guest `to` that fails
        // the addressing ladder (home fleet not federated, or its
        // registry slot is missing) gets a CLEAR error here — never a
        // silent `peers_attempted:0` (the AC this rung exists to satisfy).
        if (resolved.error !== undefined) {
          span.setAttribute(Attr.PeersAttempted, 0);
          span.setAttribute(Attr.PeersDelivered, 0);
          span.setStatus({ code: SpanStatusCode.ERROR, message: resolved.error });
          return {
            delivered: false,
            channel_state: 'offline' as const,
            peers_attempted: 0,
            peers_delivered: 0,
            error: resolved.error,
          };
        }
        const peers = resolved.peers;
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

        // DR-038 Slice B: persist-then-send (Decision 1). Enqueue EVERY
        // peer's message into the durable outbox BEFORE any send is
        // attempted — `outbox.enqueue` mints the stable message-id
        // (Decision 2) and durably persists via the injected `OutboxStore`
        // driver, returning the id. Only THEN do we attempt delivery, via
        // one immediate `driveOnce()` call covering everything just
        // enqueued (plus any already-due backlog from a prior call) — this
        // gives the reachable-peer common case the same "delivered inline"
        // UX as the pre-DR-038 fire-and-forget dispatch, while an
        // unreachable peer's entry now durably SURVIVES in the outbox for
        // the periodic ticker (`delivery/outbox-ticker.ts`, wired in
        // `server.ts`) to keep retrying with backoff, bounded by the TTL,
        // across this sender's own restarts (Decision 4) — once a durable
        // store driver replaces the in-memory placeholder (DR-008).
        const enqueued = await Promise.all(
          peers.map(async (peer) => ({ peer, id: await deps.outbox.enqueue(peer.name, input) })),
        );
        await deps.outbox.driveOnce();

        // `Outbox.driveOnce()`'s public contract returns only AGGREGATE
        // counts, not per-entry outcomes — `deps.outboxAttempts` is the
        // read-once side-channel `createNotifyOutboxSend`'s adapter
        // populates per attempt (see its doc comment + `NotifyPeerDeps`
        // .outboxAttempts for the full rationale). Read-and-delete each id
        // this call just enqueued so the map doesn't grow across calls for
        // messages that succeed on the first attempt.
        const results = enqueued.map(({ peer, id }) => {
          const attempt = deps.outboxAttempts.get(id);
          deps.outboxAttempts.delete(id);
          return {
            peer,
            httpOk: attempt?.httpOk ?? false,
            transportOk: attempt?.transportOk ?? false,
          };
        });

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

// ---------------------------------------------------------------------------
// DR-038 Slice B — the outbox `send` seam wired to the ACTUAL peer dispatch.
// ---------------------------------------------------------------------------

/** Per-attempt outcome recorded in `NotifyPeerDeps.outboxAttempts`. */
export interface NotifyOutboxAttempt {
  readonly httpOk: boolean;
  readonly transportOk: boolean;
}

/**
 * Everything `createNotifyOutboxSend`'s adapter needs — exactly
 * `NotifyPeerDeps` minus the two outbox-related fields (which don't exist
 * yet at the point this factory is called: `server.ts` constructs the
 * adapter FIRST, then wraps it in `createOutbox({ send, ... })`, and only
 * THEN has a complete `NotifyPeerDeps` to hand to `notifyPeer()`).
 */
export type NotifyDispatchDeps = Omit<NotifyPeerDeps, 'outbox' | 'outboxAttempts'>;

/** Bound on `lastAttempts` size — defense-in-depth against unbounded growth
 * from ids that get retried after their originating `notifyPeer()` call has
 * already returned and read-and-deleted its own entries (see doc comment
 * below). FIFO-evicts the oldest tracked id once exceeded. */
const MAX_TRACKED_ATTEMPTS = 500;

/**
 * Build the `OutboxSendFn` wired to the real peer dispatch (legacy `/notify`
 * POST or A2A `message/send`, per `selectOutboundProtocol`) — this is the
 * seam DR-038 Decision 1's "persist-then-send" plugs the ACTUAL send into.
 * Constructed ONCE at server startup (`server.ts`) and passed to
 * `createOutbox({ send, ... })`; `server.ts` then folds the resulting
 * `outbox` + `lastAttempts` into the full `NotifyPeerDeps` handed to
 * `notifyPeer()`.
 *
 * The returned `lastAttempts` map is the read-once side-channel documented
 * on `NotifyPeerDeps.outboxAttempts`: `Outbox.driveOnce()`'s public contract
 * only returns aggregate attempted/acked/failed/deadLettered counts, not
 * per-entry outcomes, so this is what recovers the granular
 * {httpOk, transportOk} pair `notifyPeer()` needs to preserve the pre-DR-038
 * `channel_state` distinction (peer-alive-but-rejected vs peer-unreachable)
 * in its immediate return value. A message that needs a LATER retry (driven
 * by `delivery/outbox-ticker.ts`'s periodic tick, after the originating
 * `notifyPeer()` call has already read-and-deleted its own id) leaves one
 * stale entry here — bounded by `MAX_TRACKED_ATTEMPTS` (FIFO eviction), so
 * this is capped, not unbounded, even though it is not eagerly cleaned up
 * the moment a message finally acks or dead-letters. Accepted tradeoff for
 * this wiring slice; a follow-up could decorate `store.markAcked` /
 * `store.deadLetter` to evict eagerly if the cap ever proves too coarse in
 * practice.
 */
export function createNotifyOutboxSend(
  deps: NotifyDispatchDeps,
  timeoutMs = 5000,
): { readonly send: OutboxSendFn; readonly lastAttempts: Map<string, NotifyOutboxAttempt> } {
  const lastAttempts = new Map<string, NotifyOutboxAttempt>();

  function record(id: string, attempt: NotifyOutboxAttempt): void {
    if (lastAttempts.size >= MAX_TRACKED_ATTEMPTS && !lastAttempts.has(id)) {
      const oldestKey = lastAttempts.keys().next().value;
      if (oldestKey !== undefined) lastAttempts.delete(oldestKey);
    }
    lastAttempts.set(id, attempt);
  }

  const send: OutboxSendFn = async (target, id, payload) => {
    const input = payload as NotifyPeerInput;
    // Re-resolve the peer via the registry at SEND time (not at enqueue
    // time) — deliberate: across a retry gap the peer's host/port may have
    // changed (relaunch, collision takeover), and a stale cached AgentInfo
    // would keep retrying a dead address. `target` is the routing-label
    // string `outbox.enqueue`'s caller passed as its first arg
    // (`peer.name` in `notifyPeer()`) — for a DR-041 Amendment A cross-fleet
    // guest peer, that is the ORIGINAL `<project>/<name>` slug (see
    // `resolveTargetPeers`), so re-resolving via the SAME `resolvePeerAddress`
    // helper keeps a guest peer's LATER retries guest-aware too, not just the
    // first attempt. A guest whose federation is revoked between the initial
    // send and a later retry degrades to a normal failed attempt here (no
    // `error` propagation on this path — see `resolvePeerAddress`'s doc
    // comment: the clear DR-041 error text is an INITIAL-resolution UX
    // guarantee, not a per-retry one, since `OutboxSendFn`'s `{ack}` contract
    // has no slot to carry a message through).
    const { info } = await resolvePeerAddress(deps, target);
    if (info === null) {
      // Peer no longer registered — a transient (deregistered mid-restart)
      // or permanent (removed) absence look identical here; either way,
      // report a failed attempt so the outbox retries until the TTL either
      // finds the peer registered again or dead-letters per Decision 4.
      const attempt: NotifyOutboxAttempt = { httpOk: false, transportOk: false };
      record(id, attempt);
      return { ack: false };
    }
    const peer = { name: target, info };
    const result = await dispatchToPeer(deps, peer, input, id, timeoutMs);
    record(id, result);
    return { ack: result.httpOk };
  };

  return { send, lastAttempts };
}
