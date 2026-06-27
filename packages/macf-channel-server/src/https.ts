import { createServer, type Server as NodeHttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NotifyPayloadSchema, SignRequestSchema } from '@groundnuty/macf-core';
import type { NotifyPayload, SignRequest, HealthResponse, HttpsServer, Logger } from '@groundnuty/macf-core';
import { PortExhaustedError, PortUnavailableError, HttpsServerError, HttpError } from '@groundnuty/macf-core';
import { getTracer, SpanNames, Attr, GenAiAttr, operationNameForNotifyType } from './tracing.js';
import { getNotifyReceivedCounter, getSignCallsCounter, MetricAttr } from './metrics.js';
import {
  JsonRpcRequestSchema,
  MessageSendParamsSchema,
  TaskIdParamsSchema,
  resolveTaskId,
  A2A_METHOD_MESSAGE_SEND,
  A2A_METHOD_TASKS_GET,
  A2A_METHOD_TASKS_CANCEL,
  A2A_ENDPOINT_PATH,
  A2A_ERROR_DOMAIN,
  A2A_REASON_INVALID_MESSAGE,
  A2A_REASON_METHOD_NOT_SUPPORTED,
  A2A_REASON_TASK_NOT_FOUND,
  A2A_REASON_TASK_NOT_RESUMABLE,
  A2A_REASON_TASK_TERMINAL_STATE,
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
} from './a2a-types.js';
import {
  TaskNotFoundError,
  TaskNotResumableError,
  TaskNotCancelableError,
  InvalidTaskTransitionError,
} from './a2a-task.js';
import type { TaskStore } from './a2a-task.js';
import { a2aMessageToNotifyPayload } from './a2a-delivery.js';
import { intentSummary } from './comms-ledger.js';
import type { CommsEvent, CommsLedgerEdge } from './comms-ledger.js';
import { formatNotifyContent } from './notify-formatter.js';
import type { Message } from './a2a-types.js';

const MAX_BODY_BYTES = 64 * 1024; // 64KB
export const PORT_RANGE_START = 8800;
export const PORT_RANGE_SIZE = 1000;
const MAX_PORT_ATTEMPTS = 10;

// clientAuth EKU OID — RFC 5280 §4.2.1.12. Peer certs emit this via
// generateAgentCert + signCSR (#125); the routing-action client cert
// emits it too (#119). Enforced at the server as the final step of
// DR-004 v2 EKU rollout (#121). Non-EKU certs are rejected at
// /notify + /health + /sign uniformly.
export const CLIENT_AUTH_EKU_OID = '1.3.6.1.5.5.7.3.2';

/**
 * Check whether the presented peer cert carries the clientAuth EKU.
 * Node's `tls.TLSSocket.getPeerCertificate()` exposes EKU as
 * `ext_key_usage` — an array of OID strings. If the field is absent
 * or empty, the cert carries no EKU; if present, we require the
 * clientAuth OID specifically. Exported for tests.
 */
export function peerCertHasClientAuthEKU(peerCert: {
  readonly ext_key_usage?: readonly string[];
}): boolean {
  return Array.isArray(peerCert.ext_key_usage)
    && peerCert.ext_key_usage.includes(CLIENT_AUTH_EKU_OID);
}

interface NodeError extends Error {
  readonly code?: string;
}

// Exported for tests (#109 H1). Uses crypto.randomInt (CSPRNG)
// rather than a weak PRNG — port numbers aren't secrets, but the
// canonical defensive pattern for random in security-adjacent code
// paths is the CSPRNG.
export function randomPort(): number {
  return PORT_RANGE_START + randomInt(PORT_RANGE_SIZE);
}

function sendJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(json);
}

/**
 * Headers required on A2A v1.0 protocol responses (macf#390 Phase 2a;
 * spec § 3.6). `A2A-Version` advertises the protocol version the server
 * implements; standard A2A clients read it for negotiation. Absence is
 * a spec-compliance gap that doesn't break v1.0 interop today but
 * becomes load-bearing when v1.1+ clients need to negotiate.
 */
const A2A_RESPONSE_HEADERS: Record<string, string> = {
  'A2A-Version': '1.0',
};

/** sendJson variant that always emits the A2A v1.0 spec § 3.6 response headers. */
function sendA2aJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  sendJson(res, status, body, A2A_RESPONSE_HEADERS);
}

function readBody(
  req: import('node:http').IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !settled) {
        settled = true;
        // Destroy the underlying socket (not just req) so the half-open
        // write-side (res) is also torn down. `req.destroy()` alone
        // leaves res attached to a destroyed request, which can retain
        // GC references under high-throughput abuse — see ultrareview
        // finding H2.
        req.socket.destroy();
        reject(new HttpsServerError('Body too large'));
        return;
      }
      if (!settled) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Map an inbound NotifyPayload type → the DR-025 unified comms-event
 * taxonomy (macf#473 piece 2). The GitHub router events map to their
 * taxonomy names; anything without a clean correspondence (ci_completion,
 * startup_check, peer_notification) falls back to `custom`. Exported for
 * the edge-site ordering tests.
 */
export function notifyTypeToCommsEvent(payload: NotifyPayload): CommsEvent {
  switch (payload.type) {
    case 'mention':
      return 'mention';
    case 'issue_routed':
      return 'issue-routed';
    case 'pr_review_state':
      return 'pr-review-state';
    case 'peer_notification':
      // A legacy peer_notification carries its OWN finer `event`
      // (session-end | turn-complete | error | custom) — these values are
      // already exactly the comms-event taxonomy names, so pass them through
      // directly. Collapsing to `custom` here would lose the event and create
      // a send/recv asymmetry (the sender records the real event). `event` is
      // optional on NotifyPayload → fall back to `custom` when absent.
      return payload.event ?? 'custom';
    default:
      // ci_completion / startup_check (no finer event to preserve).
      return 'custom';
  }
}

/**
 * Derive an `owner/repo#N`-style github_anchor from a NotifyPayload, or null
 * for a payload with no GitHub object to stitch to (macf#473 piece 2).
 * A peer-STAMPED anchor (legacy `peer_notification` carrying `github_anchor`
 * on the wire — macf#473) wins outright; otherwise prefer the producer-supplied
 * `repo` (macf-actions v3.2.0+, #30) and fall back to a bare `#N` when only the
 * issue number is known. Exported for tests.
 */
export function githubAnchorFromNotify(payload: NotifyPayload): string | null {
  // A peer-stamped anchor (off-GitHub nudge tied to a GitHub object) wins; the
  // sender knows the anchor the recv-side derivation can't reconstruct.
  if (typeof payload.github_anchor === 'string' && payload.github_anchor.length > 0) {
    return payload.github_anchor;
  }
  if (payload.issue_number === undefined && payload.pr_number === undefined) {
    return null;
  }
  const num = payload.issue_number ?? payload.pr_number;
  if (num === undefined) return null;
  return payload.repo ? `${payload.repo}#${num}` : `#${num}`;
}

/**
 * Read a github_anchor out of an A2A Message's metadata, if the sender
 * stamped one (macf#473 piece 2 — the outbound `notify_peer github_anchor`
 * field travels in `metadata.github_anchor`). Returns null when absent or
 * non-string. Exported for tests.
 */
export function githubAnchorFromMessage(message: Message): string | null {
  const anchor = (message.metadata ?? {})['github_anchor'];
  return typeof anchor === 'string' && anchor.length > 0 ? anchor : null;
}

/**
 * Map an inbound A2A Message's `metadata.event` → the comms-event taxonomy.
 * The sender stamps one of the four peer_notification events; anything
 * missing/unrecognized falls back to `custom` (same shape as the
 * a2a-delivery wake default). Exported for tests.
 */
export function a2aMetadataToCommsEvent(message: Message): CommsEvent {
  const ev = (message.metadata ?? {})['event'];
  switch (ev) {
    case 'session-end':
      return 'session-end';
    case 'turn-complete':
      return 'turn-complete';
    case 'error':
      return 'error';
    default:
      return 'custom';
  }
}

/**
 * Build the DR-030 §6 diagnostic ACK body (groundnuty/macf#568). Called only
 * on the `/notify` short-circuit when `payload.diagnostic === true`. Shape:
 *
 *   { ack: true, agent: <routingLabel>, instance_id: <instanceId>,
 *     correlation_token?: <echoed if the probe sent one> }
 *
 * `correlation_token` is included ONLY when the probe sent one (echoed
 * verbatim for request/response correlation); omitted otherwise. Extracted as
 * a pure function so the ACK contract is unit-testable without the mTLS
 * request path (`src/https.ts` is coverage-excluded — the full handler path is
 * e2e-tested). Exported for tests.
 */
export function diagnosticAckBody(
  payload: NotifyPayload,
  ids: { readonly agent: string; readonly instanceId: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ack: true,
    agent: ids.agent,
    instance_id: ids.instanceId,
  };
  if (payload.correlation_token !== undefined) {
    body['correlation_token'] = payload.correlation_token;
  }
  return body;
}

export function createHttpsServer(config: {
  readonly caCertPath: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly onNotify: (payload: NotifyPayload) => Promise<void>;
  readonly onHealth: () => HealthResponse;
  readonly onSign?: (request: SignRequest) => Promise<Record<string, unknown>>;
  /**
   * A2A v1.0 AgentCard served at `/.well-known/agent-card.json` per
   * spec § 4.4.1 + § 14.3. Optional — channel-servers running pre-#370
   * skip the endpoint and return 404 (existing route-not-found path).
   * Phase 1 (groundnuty/macf#370): pure additive discovery; zero
   * behavior change to existing endpoints.
   */
  readonly agentCard?: unknown;
  /**
   * A2A v1.0 inbound task store for `message/send` JSON-RPC handling
   * at `/a2a/v1` (groundnuty/macf#390 Phase 2a). Optional — pre-#390
   * channel-servers skip the route and return 404.
   *
   * Phase 2a: in-memory `Map<taskId, Task>`. Each request drives a
   * fresh task through the happy path SUBMITTED → WORKING → COMPLETED.
   * Phase 2b will exercise INPUT_REQUIRED / AUTH_REQUIRED + resume
   * via `Message.taskId`.
   */
  readonly taskStore?: TaskStore;
  readonly logger: Logger;
  /**
   * macf#473 piece 2 (DR-025): record an authoritative comms-ledger edge for
   * an inbound coordination recv. Invoked BEFORE `onNotify` at both recv edge
   * sites (`/notify` + A2A `message/send`). Loud-but-proceeds: a write
   * failure is logged + counted but never throws, so delivery is never
   * blocked. Optional — pre-#473 channel-servers (and most tests) omit it and
   * the recv sites simply skip the ledger record.
   */
  readonly recordLedgerEdge?: (edge: CommsLedgerEdge) => void;
  /**
   * This server's own agent name — the `to` of an inbound recv edge. Required
   * alongside `recordLedgerEdge`; when the latter is omitted this is unused.
   */
  readonly selfAgentName?: string;
  /**
   * DR-030 §6 (groundnuty/macf#568): the routing-label this server registers
   * under (registry key + cert CN; `config.routingLabel`). Echoed as `agent`
   * in the diagnostic ACK — same identity `/health` reports — so the
   * fleet-doctor "Accepted" check can confirm it reached the slot it resolved.
   * Optional; falls back to `selfAgentName` then `'unknown'` when omitted.
   */
  readonly routingLabel?: string;
  /**
   * DR-030 §6: this instance's `instance_id` (`config.instanceId`). Echoed in
   * the diagnostic ACK as the registry/health staleness disambiguator.
   * Optional; falls back to `'unknown'` when omitted.
   */
  readonly instanceId?: string;
}): HttpsServer {
  const { onNotify, onHealth, onSign, agentCard, taskStore, logger, recordLedgerEdge, selfAgentName, routingLabel, instanceId } = config;

  const tlsOptions = {
    key: readFileSync(config.agentKeyPath),
    cert: readFileSync(config.agentCertPath),
    ca: readFileSync(config.caCertPath),
    requestCert: true,
    rejectUnauthorized: true,
  };

  let server: NodeHttpsServer | undefined;

  async function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    // Defense-in-depth: reject at HTTP level even if TLS handshake passed.
    // Protects against misconfigured rejectUnauthorized during debugging.
    const tlsSocket = req.socket as TLSSocket;
    if (!tlsSocket.authorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Step 3 of the DR-004 v2 EKU rollout (#121): require the peer
    // cert to carry the clientAuth EKU. Peer certs emit it via
    // generateAgentCert + signCSR (#125); routing-action client cert
    // emits it via generateClientCert (#119). A CA-signed cert
    // WITHOUT the EKU — e.g. an old peer cert pre-#125 that hasn't
    // been rotated — is rejected uniformly at /health, /notify,
    // /sign. Operators who miss a rotation see 403 with a clear
    // message pointing at `macf certs rotate`.
    const peerCert = tlsSocket.getPeerCertificate() as {
      readonly ext_key_usage?: readonly string[];
      readonly subject?: { readonly CN?: string };
    };
    if (!peerCertHasClientAuthEKU(peerCert)) {
      const cn = peerCert.subject?.CN ?? 'unknown';
      logger.warn('client_cert_missing_eku', {
        from_cn: cn,
        url: req.url ?? '',
      });
      sendJson(res, 403, {
        error: 'Forbidden: client certificate missing clientAuth Extended Key Usage. Run `macf certs rotate` to pick up an EKU-enabled cert.',
      });
      return;
    }

    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      const health = onHealth();
      const clientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN;
      logger.info('health_pinged', { from_cn: clientCn ?? 'unknown' });
      sendJson(res, 200, health as unknown as Record<string, unknown>);
      return;
    }

    // A2A v1.0 AgentCard discovery endpoint (groundnuty/macf#370).
    // Per spec § 14.3, the well-known URL is `/.well-known/agent-card.json`.
    // Returns the AgentCard JSON built at channel-server startup (cached
    // for process lifetime; AgentCard is static between restarts per
    // spec § 4.4.1).
    //
    // Like /health + /notify + /sign, this endpoint is gated by mTLS +
    // EKU above. A2A's discovery model typically expects unauthenticated
    // public access, but MACF's threat model assumes mTLS-only peers
    // (per-project CA); a public AgentCard would require bypassing the
    // TLS gate uniformly which we don't do today. Future spec-divergence
    // worth tracking — Phase 2+ may add a separate unauthenticated
    // discovery surface if external A2A clients need it.
    if (method === 'GET' && url === '/.well-known/agent-card.json') {
      if (agentCard === undefined) {
        // Channel-server config didn't pass an AgentCard. Return 404
        // (route-not-found path), same as any unhandled URL.
        sendJson(res, 404, { error: 'AgentCard discovery not configured on this channel-server' });
        return;
      }
      const clientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN;
      logger.info('agent_card_served', { from_cn: clientCn ?? 'unknown' });
      sendJson(res, 200, agentCard as Record<string, unknown>);
      return;
    }

    if (method === 'POST' && url === '/notify') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'Body too large (max 64KB)' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const result = NotifyPayloadSchema.safeParse(parsed);
      if (!result.success) {
        // macf#616 (silent-fallback Instance 14): loud-log the rejection so a
        // malformed inbound payload — notably an anchorless `type:mention`, which
        // would otherwise surface as a context-free "You were mentioned" and
        // strand the recipient — is visible in operator logs rather than a silent
        // 400. The refine's error message carries the macf#616 reference for the
        // mention case; `attempted_type` aids triage when the body is otherwise
        // unparseable as a NotifyPayload.
        const attemptedType =
          parsed !== null && typeof parsed === 'object' && 'type' in parsed
            ? String((parsed as { type?: unknown }).type)
            : 'unknown';
        logger.warn('notify_validation_failed', {
          attempted_type: attemptedType,
          error: result.error.message,
        });
        sendJson(res, 400, { error: `Validation failed: ${result.error.message}` });
        return;
      }

      // DR-030 §6 (groundnuty/macf#568): the `diagnostic` discriminator — the
      // fleet-doctor mesh "Accepted" check. By the time we reach here the probe
      // has cleared the SAME path real routing uses: mTLS + clientAuth-EKU auth
      // (top of handleRequest) and the NotifyPayloadSchema parse (just above) —
      // so a green ACK proves auth+parse+receiver-ready. The check then
      // SHORT-CIRCUITS: respond synchronously with an ACK and return, BEFORE any
      // side-effect — no notify_received counter bump, no SERVER span, no
      // recordLedgerEdge, no onNotify (→ no mcp.pushNotification, no
      // health.recordNotification, no decideWake, no wakeViaTmux). Zero queue
      // pollution; a synthetic probe must not look like real received traffic.
      //
      // This composes with — but is strictly EARLIER than — Pattern E
      // (`decideWake`, macf#355): decideWake only gates the *wake*, and an
      // unrecognized event still pushes to MCP. The Accepted check needs no
      // push at all, so it is NOT a decideWake event value — it is this
      // pre-push short-circuit.
      if (result.data.diagnostic === true) {
        const probeCn = (req.socket as TLSSocket)
          .getPeerCertificate()?.subject?.CN ?? 'unknown';
        logger.info('diagnostic_ack', {
          from_cn: String(probeCn),
          correlation_token: result.data.correlation_token ?? null,
        });
        sendJson(
          res,
          200,
          diagnosticAckBody(result.data, {
            agent: routingLabel ?? selfAgentName ?? 'unknown',
            instanceId: instanceId ?? 'unknown',
          }),
        );
        return;
      }

      // testbed#242 T6 / macf#278: increment notify_received counter for
      // every validated inbound /notify. Counts BEFORE handler runs so
      // the metric reflects "what was received," not "what handler
      // succeeded" — handler outcome is captured in the span's status
      // code instead. Agent label sourced from MACF_AGENT_NAME env (set
      // by claude.sh launcher); falls back to "unknown" if absent so
      // the counter still emits in degraded-config scenarios.
      getNotifyReceivedCounter().add(1, {
        [MetricAttr.NotifyType]: result.data.type,
        [MetricAttr.Agent]: process.env['MACF_AGENT_NAME'] ?? 'unknown',
      });

      // macf#194: wrap onNotify in a SERVER span so child operations
      // (MCP push, tmux wake) attach to it via active-context
      // propagation. Parent context extracted from W3C `traceparent`
      // header if the routing Action sent one; otherwise a new root.
      // Span + any mcp/tmux children roll up to the same trace-id
      // in Langfuse/SigNoz, giving one unified trace per coord event.
      const parentCtx = propagation.extract(context.active(), req.headers);
      const clientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN ?? 'unknown';
      const tracer = getTracer();
      await tracer.startActiveSpan(
        SpanNames.NotifyReceived,
        {
          kind: SpanKind.SERVER,
          attributes: {
            [GenAiAttr.System]: 'macf',
            [GenAiAttr.OperationName]: operationNameForNotifyType(result.data.type),
            [Attr.NotifyType]: result.data.type,
            [Attr.RemoteCn]: clientCn,
            ...(result.data.issue_number !== undefined
              ? { [Attr.IssueNumber]: result.data.issue_number }
              : {}),
          },
        },
        parentCtx,
        async (span) => {
          try {
            // macf#473 piece 2: APPEND-BEFORE-DELIVER. Record the
            // authoritative inbound github-route recv edge BEFORE handing
            // off to onNotify, capturing trace_id synchronously from the
            // active SERVER span (OTel api 1.9.1 — synchronous, pre-export).
            // Loud-but-proceeds: recordLedgerEdge never throws.
            if (recordLedgerEdge !== undefined) {
              const payload = result.data;
              const num = payload.issue_number ?? payload.pr_number;
              recordLedgerEdge({
                ts: new Date().toISOString(),
                // `subject.CN` is typed `string | string[]`; coerce to a
                // single string for the edge `from` (multi-CN certs are
                // rejected upstream by extractCN, so this is defensive).
                from: String(clientCn),
                to: selfAgentName ?? 'unknown',
                // direct-vs-router taxonomy: a legacy `peer_notification` POST
                // arrives DIRECTLY at /notify (peer-to-peer, no router hop), so
                // it's `a2a`. Everything else at /notify is a router event
                // (mention / issue_routed / pr_review_state / ci_completion /
                // startup_check) → `github-route`.
                channel: payload.type === 'peer_notification' ? 'a2a' : 'github-route',
                direction: 'recv',
                event: notifyTypeToCommsEvent(payload),
                // Stable id: issue/pr number + type + ts; the type+number
                // pair disambiguates concurrent recvs, the ts breaks ties.
                msg_id: `${payload.type}:${num ?? 'na'}:${Date.now()}`,
                intent_summary: intentSummary(formatNotifyContent(payload).content),
                github_anchor: githubAnchorFromNotify(payload),
                delivered: true, // it was received over the wire
                processed: null, // backfilled later via the receipt join (#444)
                trace_id: span.spanContext().traceId,
              });
            }
            await onNotify(result.data);
            sendJson(res, 200, { status: 'received' });
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (err) {
            logger.error('notify_push_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            sendJson(res, 500, { error: 'Failed to push notification' });
          } finally {
            span.end();
          }
        },
      );
      return;
    }

    // macf#371: legacy `/sign` path returns 308 Permanent Redirect to
    // `/macf/sign`. 308 (not 301/302) preserves the POST method per
    // RFC 7538 — critical because /sign is POST-only with a JSON body.
    // We log every legacy-path hit as `sign_redirect_legacy` so the
    // 12-month removal trigger can observe redirect traffic going to
    // zero as callers migrate (separate signal from the canonical-path
    // counter `macf_sign_calls_total`).
    if (url === '/sign') {
      const legacyClientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN ?? 'unknown';
      logger.info('sign_redirect_legacy', {
        from_cn: legacyClientCn,
        method: method ?? 'unknown',
      });
      res.writeHead(308, {
        Location: '/macf/sign',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({
        error: 'Endpoint moved to /macf/sign (DR-010 Path 2, macf#371). Update your client.',
      }));
      return;
    }

    // NOTE: /macf/sign is intentionally NOT advertised in the A2A AgentCard
    // returned by /.well-known/agent-card.json (Phase 1, groundnuty/macf#370).
    // Live-attestation is MACF-only per DR-010 Path 2; external A2A clients
    // SHOULD NOT depend on this endpoint. See groundnuty/macf#371.
    if (method === 'POST' && url === '/macf/sign') {
      // macf#371: empirical-basis counter for DR-010 Path-2 12-month
      // removal trigger. Increments BEFORE the onSign-missing 503 gate
      // so any call (successful, schema-rejected, or onSign-absent) is
      // counted — the trigger is about "is anyone trying to use this?",
      // not "is anyone successfully using this?".
      getSignCallsCounter().add(1, {
        [MetricAttr.Agent]: process.env['MACF_AGENT_NAME'] ?? 'unknown',
      });

      if (!onSign) {
        sendJson(res, 503, { error: 'Signing not available on this agent' });
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'Body too large (max 64KB)' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const result = SignRequestSchema.safeParse(parsed);
      if (!result.success) {
        sendJson(res, 400, { error: `Validation failed: ${result.error.message}` });
        return;
      }

      // macf#194: /macf/sign SERVER span. Audit-trail value — every cert
      // issuance gets a trace entry correlatable to the requester
      // (cn + agent_name) + the trace-parent (who kicked off the
      // rotation?).
      const signParentCtx = propagation.extract(context.active(), req.headers);
      const signClientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN ?? 'unknown';
      const signTracer = getTracer();
      await signTracer.startActiveSpan(
        SpanNames.SignCsr,
        {
          kind: SpanKind.SERVER,
          attributes: {
            [GenAiAttr.System]: 'macf',
            [Attr.RemoteCn]: signClientCn,
            [GenAiAttr.AgentName]: result.data.agent_name,
          },
        },
        signParentCtx,
        async (span) => {
          try {
            const response = await onSign(result.data);
            sendJson(res, 200, response);
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (err) {
            // Typed HttpError carries a specific intended status;
            // anything else is an unexpected server-side failure → 500.
            const status = err instanceof HttpError ? err.httpStatus : 500;
            sendJson(res, status, {
              error: err instanceof Error ? err.message : 'Signing failed',
            });
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            span.end();
          }
        },
      );
      return;
    }

    // A2A v1.0 inbound JSON-RPC `message/send` endpoint (groundnuty/macf#390
    // Phase 2a). URL pattern `/a2a/v1` advertised via AgentCard.url; clients
    // discover via `/.well-known/agent-card.json` then POST JSON-RPC envelopes
    // here. Backwards-compat: existing `/notify` + `/macf/sign` + AgentCard
    // routes unchanged; A2A surface is purely additive.
    //
    // Phase 2a scope: happy-path message/send → fresh Task → SUBMITTED →
    // WORKING → COMPLETED (synchronous return). Phase 2b extends to
    // INPUT_REQUIRED / AUTH_REQUIRED + resume via Message.taskId; ALL state
    // transitions declared in `a2a-task.ts` but Phase 2a only exercises
    // the happy path.
    //
    // Traceparent: extracted from req.headers (W3C tracecontext via HTTP)
    // per header-only design decision 4 on macf#390 (#368 finding: current
    // mTLS topology doesn't header-rewrite). Defense-in-depth metadata-
    // stuffing reserved for Phase 4 (external gateway scenarios).
    if (method === 'POST' && url === A2A_ENDPOINT_PATH) {
      if (taskStore === undefined) {
        sendA2aJson(res, 404, { error: 'A2A endpoint not configured on this channel-server' });
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendA2aJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendA2aJson(res, 413, { error: 'Body too large (max 64KB)' });
        return;
      }

      // JSON-RPC 2.0 §5 — parse-error → -32700 (id=null since we couldn't
      // parse enough of the request to know its id).
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendA2aJson(res, 200, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JSONRPC_PARSE_ERROR,
            message: 'Parse error',
            data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
          },
        });
        return;
      }

      // JSON-RPC envelope shape — wrong shape → -32600 Invalid Request.
      const envelope = JsonRpcRequestSchema.safeParse(parsed);
      if (!envelope.success) {
        // Best-effort id extraction from the raw body for the error envelope.
        const rawId = (parsed as { id?: string | number }).id ?? null;
        sendA2aJson(res, 200, {
          jsonrpc: '2.0',
          id: rawId,
          error: {
            code: JSONRPC_INVALID_REQUEST,
            message: `Invalid JSON-RPC request: ${envelope.error.message}`,
            data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
          },
        });
        return;
      }

      // Method dispatch (macf#398 Phase 2d). Supported methods:
      //   - `message/send`  (Phase 2a + 2b) — fresh task or resume
      //   - `tasks/get`     (Phase 2d) — read-only task lookup
      //   - `tasks/cancel`  (Phase 2d) — transition non-terminal → CANCELED
      //
      // Out-of-scope methods (`message/stream`, `tasks/subscribe`,
      // `tasks/pushNotificationConfig.set`, etc.) → -32601 Method not
      // found. They land in Phase 3.5+ when streaming support arrives.
      const isSupportedMethod =
        envelope.data.method === A2A_METHOD_MESSAGE_SEND
        || envelope.data.method === A2A_METHOD_TASKS_GET
        || envelope.data.method === A2A_METHOD_TASKS_CANCEL;
      if (!isSupportedMethod) {
        sendA2aJson(res, 200, {
          jsonrpc: '2.0',
          id: envelope.data.id,
          error: {
            code: JSONRPC_METHOD_NOT_FOUND,
            message: `Method '${envelope.data.method}' not supported`,
            data: { reason: A2A_REASON_METHOD_NOT_SUPPORTED, domain: A2A_ERROR_DOMAIN },
          },
        });
        return;
      }

      // macf#398 Phase 2d: tasks/get + tasks/cancel are read-only/state-
      // mutation methods that don't go through TaskStore.completeHappyPath.
      // Dispatch directly + return early; spans named after the method
      // for OTel observability parity with `message/send`.
      if (envelope.data.method === A2A_METHOD_TASKS_GET) {
        const taskIdParams = TaskIdParamsSchema.safeParse(envelope.data.params);
        if (!taskIdParams.success) {
          sendA2aJson(res, 200, {
            jsonrpc: '2.0',
            id: envelope.data.id,
            error: {
              code: JSONRPC_INVALID_PARAMS,
              message: `Invalid tasks/get params: ${taskIdParams.error.message}`,
              data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
            },
          });
          return;
        }
        const taskId = resolveTaskId(taskIdParams.data);
        const task = taskId !== undefined ? taskStore.get(taskId) : undefined;
        if (task === undefined) {
          sendA2aJson(res, 200, {
            jsonrpc: '2.0',
            id: envelope.data.id,
            error: {
              code: JSONRPC_INVALID_PARAMS,
              message: `Task ${taskId ?? '(no id)'} not found`,
              data: { reason: A2A_REASON_TASK_NOT_FOUND, domain: A2A_ERROR_DOMAIN },
            },
          });
          return;
        }
        sendA2aJson(res, 200, {
          jsonrpc: '2.0',
          id: envelope.data.id,
          result: task,
        });
        return;
      }

      if (envelope.data.method === A2A_METHOD_TASKS_CANCEL) {
        const taskIdParams = TaskIdParamsSchema.safeParse(envelope.data.params);
        if (!taskIdParams.success) {
          sendA2aJson(res, 200, {
            jsonrpc: '2.0',
            id: envelope.data.id,
            error: {
              code: JSONRPC_INVALID_PARAMS,
              message: `Invalid tasks/cancel params: ${taskIdParams.error.message}`,
              data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
            },
          });
          return;
        }
        const taskId = resolveTaskId(taskIdParams.data);
        try {
          const task = taskStore.cancel(taskId ?? '', { nowIso: new Date().toISOString() });
          sendA2aJson(res, 200, {
            jsonrpc: '2.0',
            id: envelope.data.id,
            result: task,
          });
        } catch (err) {
          if (err instanceof TaskNotFoundError) {
            sendA2aJson(res, 200, {
              jsonrpc: '2.0',
              id: envelope.data.id,
              error: {
                code: JSONRPC_INVALID_PARAMS,
                message: `Task ${err.taskId} not found (cannot cancel)`,
                data: { reason: A2A_REASON_TASK_NOT_FOUND, domain: A2A_ERROR_DOMAIN },
              },
            });
            return;
          }
          if (err instanceof TaskNotCancelableError) {
            sendA2aJson(res, 200, {
              jsonrpc: '2.0',
              id: envelope.data.id,
              error: {
                code: JSONRPC_INVALID_PARAMS,
                message: `Task ${err.taskId} in state ${err.currentState} cannot be canceled`,
                data: { reason: A2A_REASON_TASK_TERMINAL_STATE, domain: A2A_ERROR_DOMAIN },
              },
            });
            return;
          }
          logger.error('a2a_tasks_cancel_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          sendA2aJson(res, 200, {
            jsonrpc: '2.0',
            id: envelope.data.id,
            error: {
              code: JSONRPC_INTERNAL_ERROR,
              message: 'Internal error processing tasks/cancel',
              data: { domain: A2A_ERROR_DOMAIN },
            },
          });
        }
        return;
      }

      // Below: A2A_METHOD_MESSAGE_SEND. The isSupportedMethod guard
      // already filtered out unknown methods.
      const params = MessageSendParamsSchema.safeParse(envelope.data.params);
      if (!params.success) {
        sendA2aJson(res, 200, {
          jsonrpc: '2.0',
          id: envelope.data.id,
          error: {
            code: JSONRPC_INVALID_PARAMS,
            message: `Invalid message/send params: ${params.error.message}`,
            data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
          },
        });
        return;
      }

      // Wrap in SERVER span (analog to existing /notify handler) so any
      // child operations attach via active-context propagation. Parent
      // ctx extracted from W3C `traceparent` per design decision 4.
      const parentCtx = propagation.extract(context.active(), req.headers);
      const clientCn = (req.socket as TLSSocket)
        .getPeerCertificate()?.subject?.CN ?? 'unknown';
      const tracer = getTracer();
      await tracer.startActiveSpan(
        'macf.a2a.message_send',
        {
          kind: SpanKind.SERVER,
          attributes: {
            [GenAiAttr.System]: 'macf',
            [GenAiAttr.OperationName]: 'a2a.message_send',
            [Attr.RemoteCn]: clientCn,
          },
        },
        parentCtx,
        async (span) => {
          try {
            const now = new Date().toISOString();
            const incomingMessage = params.data.message;

            // macf#473 piece 2: APPEND-BEFORE-DELIVER for the inbound A2A
            // recv edge. Records the authoritative edge BEFORE the
            // `onNotify(a2aMessageToNotifyPayload(...))` delivery, capturing
            // trace_id synchronously from the active SERVER span. Called from
            // both delivering branches (resume + happy-path); the REJECTED
            // test-fixture branch intentionally does NOT call it (a rejected
            // message was declined, not received — mirrors its no-deliver
            // semantics). Loud-but-proceeds: never throws.
            const recordA2aRecvEdge = (): void => {
              if (recordLedgerEdge === undefined) return;
              const text = a2aMessageToNotifyPayload(incomingMessage).message ?? '';
              recordLedgerEdge({
                ts: new Date().toISOString(),
                // `subject.CN` is typed `string | string[]`; coerce to a
                // single string for the edge `from`.
                from: String(clientCn),
                to: selfAgentName ?? 'unknown',
                channel: 'a2a',
                direction: 'recv',
                event: a2aMetadataToCommsEvent(incomingMessage),
                msg_id: incomingMessage.messageId,
                intent_summary: intentSummary(text),
                github_anchor: githubAnchorFromMessage(incomingMessage),
                delivered: true, // accepted over the wire
                processed: null, // backfilled later via the receipt join (#444)
                trace_id: span.spanContext().traceId,
              });
            };

            // macf#392 Phase 2b: resume branch. If incoming Message.taskId
            // is set, the client is resuming a paused task (INPUT_REQUIRED
            // or AUTH_REQUIRED state); dispatch to TaskStore.resume() instead
            // of creating a fresh task. Spec § 4.1.4 specifies Message.taskId
            // as the canonical resume reference. Per Q3 design decision on
            // #392, the route handler owns dispatch routing; TaskStore stays
            // a passive validator.
            if (incomingMessage.taskId !== undefined && incomingMessage.taskId.length > 0) {
              const task = taskStore.resume(incomingMessage.taskId, incomingMessage, { nowIso: now });
              span.setAttribute('macf.a2a.task_id', task.id);
              span.setAttribute('macf.a2a.task_state', task.status.state);
              span.setAttribute('macf.a2a.dispatch', 'resume');
              span.setStatus({ code: SpanStatusCode.OK });
              // macf#428 (Phase 3.5): deliver to the agent (resume branch too,
              // not just happy-path — avoids a deliver/silently-drop asymmetry).
              // See the happy-path call below for the ordering + wake rationale.
              recordA2aRecvEdge(); // macf#473: append-before-deliver
              await onNotify(a2aMessageToNotifyPayload(incomingMessage));
              sendA2aJson(res, 200, {
                jsonrpc: '2.0',
                id: envelope.data.id,
                result: task,
              });
              return;
            }

            // macf#392 Phase 2b: REJECTED-trigger test fixture. Env-flag-gated
            // synthetic trigger for exercising the SUBMITTED → REJECTED edge
            // without a real production rejection-policy layer (which lands
            // in Phase 3+). Tests + operator-supervised investigations set
            // MACF_A2A_TEST_REJECT_TRIGGER=1 to enable.
            const firstPart = incomingMessage.parts[0];
            const isRejectTrigger =
              process.env['MACF_A2A_TEST_REJECT_TRIGGER'] === '1'
              && firstPart !== undefined
              && 'text' in firstPart
              && firstPart.text === 'TEST_TRIGGER_REJECTED';
            if (isRejectTrigger) {
              const reasonMessage = {
                messageId: `reject-${randomUUID()}`,
                role: 'ROLE_AGENT' as const,
                parts: [{ text: 'Rejected by synthetic test trigger (MACF_A2A_TEST_REJECT_TRIGGER=1; macf#392 Phase 2b fixture).' }],
              };
              const task = taskStore.rejectFresh(incomingMessage, reasonMessage, { nowIso: now });
              span.setAttribute('macf.a2a.task_id', task.id);
              span.setAttribute('macf.a2a.task_state', task.status.state);
              span.setAttribute('macf.a2a.dispatch', 'reject_trigger');
              span.setStatus({ code: SpanStatusCode.OK });
              sendA2aJson(res, 200, {
                jsonrpc: '2.0',
                id: envelope.data.id,
                result: task,
              });
              return;
            }

            // Default Phase 2a happy-path: fresh task → WORKING → COMPLETED.
            // Agent's response is a synchronous text acknowledgment; Phase 3
            // will wire skill-name → MCP-tool dispatch so the response
            // reflects actual MACF-tool output.
            // randomUUID (CSPRNG) per the canonical no-weak-PRNG invariant
            // in src/ (#109 H1).
            const responseMessage = {
              messageId: `resp-${randomUUID()}`,
              role: 'ROLE_AGENT' as const,
              parts: [{ text: 'Acknowledged.' }],
            };
            const task = taskStore.completeHappyPath(
              incomingMessage,
              responseMessage,
              { nowIso: now },
            );
            span.setAttribute('macf.a2a.task_id', task.id);
            span.setAttribute('macf.a2a.task_state', task.status.state);
            span.setAttribute('macf.a2a.dispatch', 'fresh');
            span.setStatus({ code: SpanStatusCode.OK });
            // macf#428 (Phase 3.5): deliver to the receiving agent via the
            // SAME primitive as legacy /notify. `onNotify` does mcp_push +
            // decideWake (+ fire-and-forget wakeViaTmux). Without this the A2A
            // path created a Task but the agent never saw the message.
            //
            // Ordering: await onNotify (the mcp_push) BEFORE the response so a
            // push failure surfaces (propagates to the catch → JSON-RPC error)
            // rather than being masked behind a 200. The 1s tmux-submit sleep
            // does NOT block this: onNotify calls wakeViaTmux fire-and-forget
            // (server.ts, not awaited), so awaiting onNotify only waits on the
            // fast mcp_push.
            //
            // Wake policy is decideWake's (Pattern E, macf#267 Option d),
            // keyed on the metadata-carried event: custom → wake; autonomous
            // (turn-complete/session-end/error) → push-only (loop prevention);
            // missing/unrecognized → push-only (a2a-delivery.ts safety default).
            // The mTLS boundary is the trust gate — a trusted client that
            // stamps event=custom wakes, same as legacy /notify.
            //
            // NB: the REJECTED test-fixture branch above intentionally does
            // NOT deliver — a rejected message was declined, not received.
            recordA2aRecvEdge(); // macf#473: append-before-deliver
            await onNotify(a2aMessageToNotifyPayload(incomingMessage));
            sendA2aJson(res, 200, {
              jsonrpc: '2.0',
              id: envelope.data.id,
              result: task,
            });
          } catch (err) {
            logger.error('a2a_message_send_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });

            // macf#392 Phase 2b: structured error mapping per spec § 9
            // google.rpc.Status form. Resume-flow errors get specific reason
            // codes so callers can disambiguate (vs falling back to
            // INTERNAL_ERROR for everything).
            if (err instanceof TaskNotFoundError) {
              sendA2aJson(res, 200, {
                jsonrpc: '2.0',
                id: envelope.data.id,
                error: {
                  code: JSONRPC_INVALID_PARAMS,
                  message: `Task ${err.taskId} not found (cannot resume)`,
                  data: { reason: A2A_REASON_TASK_NOT_FOUND, domain: A2A_ERROR_DOMAIN },
                },
              });
              return;
            }
            if (err instanceof TaskNotResumableError) {
              sendA2aJson(res, 200, {
                jsonrpc: '2.0',
                id: envelope.data.id,
                error: {
                  code: JSONRPC_INVALID_PARAMS,
                  message: `Task ${err.taskId} in state ${err.currentState} is not resumable`,
                  data: {
                    reason: err.currentState === 'TASK_STATE_COMPLETED'
                      || err.currentState === 'TASK_STATE_FAILED'
                      || err.currentState === 'TASK_STATE_CANCELED'
                      || err.currentState === 'TASK_STATE_REJECTED'
                      ? A2A_REASON_TASK_TERMINAL_STATE
                      : A2A_REASON_TASK_NOT_RESUMABLE,
                    domain: A2A_ERROR_DOMAIN,
                  },
                },
              });
              return;
            }
            if (err instanceof InvalidTaskTransitionError) {
              sendA2aJson(res, 200, {
                jsonrpc: '2.0',
                id: envelope.data.id,
                error: {
                  code: JSONRPC_INVALID_PARAMS,
                  message: err.message,
                  data: { reason: A2A_REASON_INVALID_MESSAGE, domain: A2A_ERROR_DOMAIN },
                },
              });
              return;
            }
            sendA2aJson(res, 200, {
              jsonrpc: '2.0',
              id: envelope.data.id,
              error: {
                code: JSONRPC_INTERNAL_ERROR,
                message: 'Internal error processing message/send',
                data: { domain: A2A_ERROR_DOMAIN },
              },
            });
          } finally {
            span.end();
          }
        },
      );
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  function listenOnPort(
    srv: NodeHttpsServer,
    port: number,
    host: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeError): void => {
        srv.removeListener('error', onError);
        reject(err);
      };
      srv.on('error', onError);
      srv.listen(port, host, () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        resolve(actualPort);
      });
    });
  }

  function requestHandler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    handleRequest(req, res).catch((err) => {
      logger.error('request_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  }

  return {
    async start(port: number, host: string): Promise<{ readonly actualPort: number }> {
      server = createServer(tlsOptions, requestHandler);

      // TLS-layer handshake failures (no cert, expired cert, wrong CA,
      // missing clientAuth EKU per #121) never reach requestHandler.
      // Without this listener, operators see a dead connection with
      // no log entry explaining why. Log enough to triage — ultrareview
      // finding H1.
      server.on('tlsClientError', (err, tlsSocket) => {
        const peerCn = (tlsSocket.getPeerCertificate?.() as { subject?: { CN?: string } } | undefined)
          ?.subject?.CN ?? 'unknown';
        logger.warn('tls_client_error', {
          error: err.message,
          code: (err as NodeError).code ?? 'unknown',
          from_cn: peerCn,
          remote_addr: tlsSocket.remoteAddress ?? 'unknown',
        });
      });

      // Explicit port: fail immediately if busy
      if (port !== 0) {
        try {
          const actualPort = await listenOnPort(server, port, host);
          return { actualPort };
        } catch (err) {
          const nodeErr = err as NodeError;
          if (nodeErr.code === 'EADDRINUSE') {
            throw new PortUnavailableError(port);
          }
          throw new HttpsServerError(
            `Failed to start server: ${nodeErr.message}`,
          );
        }
      }

      // Random port: retry up to MAX_PORT_ATTEMPTS times
      for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
        const candidatePort = randomPort();
        try {
          const actualPort = await listenOnPort(server, candidatePort, host);
          return { actualPort };
        } catch (err) {
          const nodeErr = err as NodeError;
          if (nodeErr.code !== 'EADDRINUSE') {
            throw new HttpsServerError(
              `Failed to start server: ${nodeErr.message}`,
            );
          }
          // Close and recreate server for retry
          await new Promise<void>((r) => server!.close(() => r()));
          server = createServer(tlsOptions, requestHandler);
        }
      }

      throw new PortExhaustedError();
    },

    async stop(): Promise<void> {
      if (!server) return;

      return new Promise((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(new HttpsServerError(`Failed to stop server: ${err.message}`));
          else resolve();
        });
      });
    },
  };
}
