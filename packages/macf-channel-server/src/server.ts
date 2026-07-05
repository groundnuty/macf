#!/usr/bin/env node
// macf#196: OTEL bootstrap is now async + dynamic. We still import
// the module eagerly (to get the function export), but the actual
// SDK packages are loaded only when the env is set, inside
// `bootstrapOtel()`. Calls to `trace.getTracer()` before the bootstrap
// runs return the global no-op tracer — harmless, since no spans are
// created before main() awaits the bootstrap.
import { bootstrapOtel } from './otel.js';

import { readFileSync } from 'node:fs';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getTracer, SpanNames } from './tracing.js';
import { loadConfig } from '@groundnuty/macf-core';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import { buildAgentCard } from './agent-card.js';
import { TaskStore } from './a2a-task.js';
import { PACKAGE_VERSION } from './package-version.js';
import { createRegistry, createRegistryFromConfig } from '@groundnuty/macf-core';
import { checkCollision, CollisionError, RegisterRaceError } from './collision.js';
import { registerWithTakeover } from './register-with-takeover.js';
import { registerShutdownHandler } from './shutdown.js';
import { createForensicLogger } from './forensic-log.js';
import { createLifecycleTracker } from './lifecycle.js';
import { registerCrashHandlers } from './crash-handlers.js';
import { createAliveTicker } from './alive-ticker.js';
import { createRegistryHeartbeat, resolveHeartbeatIntervalMs } from './registry-heartbeat.js';
import { createTokenRefresher } from './token-refresh.js';
import { createRefreshAwareClient } from './refresh-aware-client.js';
import { createChallenge, verifyAndConsumeChallenge } from '@groundnuty/macf-core';
import { createChallengeStore } from '@groundnuty/macf-core';
import { signCSR } from '@groundnuty/macf-core';
import { loadCA } from '@groundnuty/macf-core';
import { HttpError } from '@groundnuty/macf-core';
import { formatNotifyContent } from './notify-formatter.js';
import { wakeViaTmux } from './tmux-wake.js';
import { decideWake } from './wake-decision.js';
import { createCommsLedger } from './comms-ledger.js';
import { recordEdge } from './comms-ledger-record.js';
import type { CommsLedgerEdge } from './comms-ledger.js';
import { getCommsLedgerWriteFailedCounter, MetricAttr } from './metrics.js';
import type { NotifyPayload, SignRequest } from '@groundnuty/macf-core';
// DR-038 Slice B (groundnuty/macf#704): the durable effectively-once delivery
// wiring — pluggable store driver, outbox (sender) + inbox (receiver), and
// the periodic ticker that drives outbox retries over the server's lifetime.
import { createDefaultDeliveryStores } from './delivery/driver.js';
import { createOutbox } from './delivery/outbox.js';
import { createInbox } from './delivery/inbox.js';
import { createOutboxTicker } from './delivery/outbox-ticker.js';
// DR-038 Decision 5 follow-on (groundnuty/macf#744): the live inbox orphan-
// drain ticker — same family as the outbox ticker above, re-firing onNotify
// for the receiver's own in-process undrained entries.
import { createInboxTicker } from './delivery/inbox-ticker.js';
import type { OutboxEntry } from '@groundnuty/macf-core';
// DR-041 Decision 1 (groundnuty/macf#784): cross-fleet multi-CA trust bundle.
// Built ONCE at startup + threaded unchanged to all three mTLS-configuring
// sites (inbound https.ts `ca:`, outbound a2a-client.ts + notify-peer.ts
// `caCertPem`) — see macf-core's trust-bundle.ts module doc for the full
// trust model. Moved to macf-core by DR-041 Amendment B (groundnuty/macf#794)
// so the `macf` CLI's guest-probe path can share the SAME security-critical
// resolution logic rather than duplicating it.
// DR-041 Amendment A (groundnuty/macf#786): `loadFederatedCaProjects` is
// called ONCE here (below) and its result threaded to BOTH the trust-bundle
// PEM resolution AND the outbound messaging layer's `federatedCas` dep —
// `buildTrustBundlePem`'s all-in-one orchestration is bypassed in favor of
// its two constituent calls so the file is read/parsed exactly once
// (single source, per the addressing-gate design on #786).
import { loadFederatedCaProjects, resolveFederatedCaBundle } from '@groundnuty/macf-core';

// NOTE: `checkPendingIssues` from './startup-issues.js' used to be
// called here at boot — but the call had a hardcoded
// `repo: 'groundnuty/macf', agentLabel: 'code-agent'`, so every
// agent (regardless of identity/workspace) queried macf's code-agent
// issues at startup + emitted a startup_check notification per hit.
// Created cross-agent noise on every fresh launch (macf#192).
// Removed in macf#192 because the marketplace v0.1.7
// `session-start-pickup.sh` SessionStart hook now handles this
// correctly — per-agent label from $MACF_AGENT_NAME + enumerates
// `/installation/repositories` so multi-repo agents are covered too.
// The function itself is still exported from src/startup-issues.ts
// for API back-compat; just not invoked here.
import type { AgentInfo } from '@groundnuty/macf-core';

async function main(): Promise<void> {
  // Bootstrap OTEL BEFORE anything calls `trace.getTracer()` with
  // intent to record. Function is no-op when
  // OTEL_EXPORTER_OTLP_ENDPOINT is unset; when set, dynamic-imports
  // the SDK packages + registers the global provider. See macf#196.
  await bootstrapOtel();

  const config = loadConfig();

  // macf#642: a GUARANTEED forensic file log. The macf-core logger NO-OPS when
  // MACF_LOG_PATH is unset, and stderr is unreliable (Claude Code stops draining
  // the stdio pipe under load) — so the channel-server could die with no trail.
  // createForensicLogger defaults the path to $XDG_STATE_HOME / $HOME/.local/state
  // when the launcher didn't export MACF_LOG_PATH (defense-in-depth; an explicit
  // MACF_LOG_PATH still wins), and degrades to stderr-only rather than crashing if
  // the file sink can't be opened.
  const { logger, logPath: forensicLogPath, fileActive } = createForensicLogger({
    agentName: config.agentName,
    debug: config.debug,
  });

  // Loud startup forensic line — file AND stderr regardless of debug — so the
  // resolved log path is discoverable + the first line bounds the process start.
  logger.info('forensic_log_active', {
    log_path: forensicLogPath,
    file_active: fileActive,
    pid: process.pid,
    version: PACKAGE_VERSION,
  });
  process.stderr.write(
    `macf-channel-server: forensic log → ${forensicLogPath}` +
      (fileActive ? '' : ' (file sink UNAVAILABLE — stderr only)') +
      ` [pid ${String(process.pid)}, v${PACKAGE_VERSION}]\n`,
  );

  // macf#642: lifecycle-phase tracker — the crash handlers + alive-tick read this
  // so the forensic log pinpoints WHERE the process was when it died.
  const lifecycle = createLifecycleTracker({ initial: 'boot' });

  // macf#642: top-level crash handlers, registered EARLY (before the rest of
  // startup) so an uncaughtException / unhandledRejection during boot still lands
  // in the forensic log + attempts a bounded graceful deregister, then exits 1.
  // The shutdown `cleanup` is wired later (it needs the registry + HTTPS server);
  // the getter returns undefined until then, so an early crash logs + exits
  // without a deregister it has nothing to perform.
  let shutdownCleanup: ((trigger?: string) => Promise<boolean>) | undefined;
  registerCrashHandlers({
    logger,
    lifecycle,
    getCleanup: () => shutdownCleanup,
  });

  // macf#642: record the process exit code in the forensic log. The 'exit' event
  // allows only synchronous work — logger.info uses appendFileSync (sync), so the
  // line is durably written before the process is gone.
  process.on('exit', (code) => {
    logger.info('process_exit', {
      code,
      pid: process.pid,
      lifecycle_phase: lifecycle.snapshot().phase,
    });
  });

  // macf#473 piece 2 (DR-025): the authoritative write-ahead comms-ledger,
  // a SIBLING of channel.log derived from MACF_LOG_PATH. A no-op when
  // logPath is unset (mirrors `logger`). The `appendEdge` writer is
  // fail-loud; `recordEdge` wraps it in the loud-but-proceeds policy so a
  // ledger-write failure at a coordination edge site never aborts delivery
  // (operator decision 2026-06-08). Bound here once so the three edge sites
  // (inbound /notify, inbound A2A message/send, outbound notify_peer) call a
  // single closure — they build the edge, this records it.
  const commsLedger = createCommsLedger({ logPath: config.logPath });
  const recordLedgerEdge = (edge: CommsLedgerEdge): void =>
    recordEdge(
      {
        ledger: commsLedger,
        logger,
        recordWriteFailed: (failedEdge) =>
          getCommsLedgerWriteFailedCounter().add(1, {
            [MetricAttr.Agent]: config.agentName,
            [MetricAttr.Channel]: failedEdge.channel,
            [MetricAttr.Direction]: failedEdge.direction,
          }),
      },
      edge,
    );

  // Partial-startup failures (MCP connected, port bound, then registry
  // or collision fails) would otherwise crash with only the stderr
  // message from the outer catch — channel.log would show the agent
  // starting and then go silent, leaving operators with no signal.
  // Wrap the startup body so post-logger failures land in the log.
  // Ultrareview finding H5.
  try {
    await runStartup();
  } catch (err) {
    logger.error('startup_failed', {
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string }).code ?? 'unknown',
    });
    throw err;
  }

  async function runStartup(): Promise<void> {
  const mcp = createMcpChannel({ agentName: config.agentName });
  // macf#545: /health echoes the ROUTING identity (the router cross-checks the
  // liveness response against the registry slot it resolved), not the bot-name.
  // DR-030 phase-1: also self-report instance_id (registry/health staleness
  // disambiguator) + cert_expiry (leaf notAfter) from the live config.
  const health = createHealthState(config.routingLabel, config.agentType, {
    instanceId: config.instanceId,
    certPath: config.agentCertPath,
    // DR-030 E1: read the comms-ledger (sibling of logPath) for last_processed.
    logPath: config.logPath,
  });

  // macf#642: a boundary try/catch around the /notify delivery path. https.ts
  // already catches at the request boundary (→ 500), but a dedicated catch here
  // attributes the failure to the notify handler (payload type + stack) AND guards
  // the fire-and-forget sub-calls (e.g. wakeViaTmux) so nothing can escape as an
  // unhandledRejection. Re-thrown so the request boundary still returns 500 — the
  // delivery genuinely failed; this only adds a louder, attributed log.
  const onNotify = async (payload: NotifyPayload): Promise<void> => {
    try {
      await deliverNotification(payload);
    } catch (err) {
      logger.error('notify_handler_error', {
        type: payload.type,
        issue: payload.issue_number,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? '') : '',
      });
      throw err;
    }
  };

  async function deliverNotification(payload: NotifyPayload): Promise<void> {
    const meta: Record<string, string> = { type: payload.type };
    if (payload.issue_number !== undefined) {
      meta['issue_number'] = String(payload.issue_number);
    }
    if (payload.source !== undefined) {
      meta['source'] = payload.source;
    }

    const { content, issueNumber } = formatNotifyContent(payload);
    if (issueNumber !== undefined) {
      health.setCurrentIssue(issueNumber);
    }

    logger.info('notify_received', {
      type: payload.type,
      issue: payload.issue_number,
    });

    // macf#194: wrap MCP push in an INTERNAL child span of the active
    // notify span. Shows up in Langfuse as a timed hop between the
    // inbound HTTP and the tmux wake.
    const tracer = getTracer();
    await tracer.startActiveSpan(
      SpanNames.McpPush,
      { kind: SpanKind.INTERNAL },
      async (span) => {
        try {
          await mcp.pushNotification(content, meta);
          span.setStatus({ code: SpanStatusCode.OK });
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
    health.recordNotification();

    logger.info('mcp_pushed', {
      type: payload.type,
      issue: payload.issue_number,
    });

    // macf#185: sidecar wake via tmux-send-to-claude.sh. The MCP push
    // above deposits the notification in the channel-server's
    // observable state but does NOT interrupt a running Claude TUI
    // with a new prompt — /notify ≠ wake without this step. Tmux
    // injection surfaces the notification as the TUI's next input
    // turn, so the agent actually processes it. Fail-silent on any
    // path where tmux isn't available (no workspace dir, no tmux
    // session, helper missing, tmux command errors).
    //
    // macf#267 Finding 2 (Option d): peer_notification is observational
    // only by default — MCP push deposits the notification in channel
    // state for /macf-status visibility, but tmux wake is suppressed.
    // This stops the cross-agent Stop-hook ping-pong loop: peer
    // notifications don't trigger fresh turns on receivers, so receivers
    // don't fire their own Stop hooks in response. SessionStart polling-
    // fallback (DR-020) catches notifications on next session start if
    // needed. All other NotifyTypes (issue_routed, mention,
    // startup_check, ci_completion) preserve existing wake-on-receipt
    // behavior.
    //
    // macf#355: receiver-side wake policy reads `event` field directly.
    // `event: 'custom'` (operator-driven slash-command per macf#350)
    // wakes the receiver TUI; autonomous events (`session-end` /
    // `turn-complete` / `error` from Stop-hook flows) skip wake to keep
    // cross-agent Stop-hook loop prevention intact (Pattern E). Previous
    // design (#351) used a `wake?: boolean` field on the payload; that
    // leaked Pattern E implementation detail into every sender's API
    // and was removed in v0.2.21 (#355) — the `event` field already
    // encoded the same intent.
    const wakeDecision = decideWake(payload);
    if (wakeDecision.action === 'skip') {
      logger.info('tmux_wake_skipped', {
        reason: wakeDecision.reason,
        detail: 'macf#267 Option d — peer notifications skip tmux wake to prevent cross-agent Stop-hook loop',
      });
    } else if (config.workspaceDir !== undefined) {
      // macf#355: surface the operator-driven wake path explicitly when
      // a peer_notification with event=custom arrives. The downstream
      // wakeViaTmux call logs `tmux_wake_delivered` on success, but
      // that event is identical for routed-issue / mention / custom-
      // event calls — this annotation makes the custom-event cause
      // visible.
      if (wakeDecision.reason === 'peer_notification_custom_event') {
        logger.info('peer_notification_custom_event', {
          source: payload.source ?? 'unknown',
          event: payload.event ?? 'unknown',
        });
      }
      // Use the formatted content as the wake prompt — same text
      // Claude would see via the MCP channel, just delivered
      // through the input buffer path so it becomes an actual turn.
      wakeViaTmux(content, {
        workspaceDir: config.workspaceDir,
        session: config.tmuxSession,
        window: config.tmuxWindow,
        logger,
      });
    } else {
      logger.info('tmux_wake_skipped', {
        reason: 'no_workspace_dir',
        detail: 'MACF_WORKSPACE_DIR unset',
      });
    }
  }

  // P2: Build the project registry + (GitHub-mode only) /sign varsClient.
  //
  // Pre-macf#317 this section also called `await generateToken()` to
  // mint a static token + pass it into `createRegistryFromConfig` +
  // `createGitHubClient`. The token-refresh wrapper now handles minting
  // lazily (first call to `tokenRefresher.getRefreshedToken()`) — we
  // don't pre-mint here because the refresh-aware client mints on first
  // use anyway, and pre-minting wouldn't improve startup signal.
  //
  // DR-024 / macf#322: local-registry mode dispatches via
  // `createRegistryFromConfig` (which routes 'local' to LocalRegistryClient)
  // instead of building a refresh-aware GitHub Variables client. The
  // `/sign` challenge-response endpoint is structurally inactive in
  // local mode — operators pre-share the CA via filesystem perms, so
  // there is no challenge to verify. `onSign` returns a 503 with a
  // diagnostic body pointing at the local-mode trust model (DR-024
  // §"/sign endpoint disabled in local mode" — Return 404 with diagnostic
  // body strategy chosen so peers that mistakenly try challenge-response
  // get a clear error rather than a connection-refused).
  const isLocalRegistry = config.registry.type === 'local';

  // macf#317: in-runner token refresh. The refresher caches the current
  // token in-process; on each call it returns cached if age < 50min,
  // else mints fresh via macf-gh-token.sh. On 401 from a downstream API
  // call, the refresh-aware client retries once with forceRefresh: true.
  // This closes the >1hr-session expiry gap (silent-fallback Instance 1
  // expiry sub-case) — the cv-architect 401 at 67min uptime witnessed
  // 2026-05-01 was the motivating incident.
  // No-op in local mode (no token to mint) — but constructed unconditionally
  // because subsequent code paths take the refresher reference; the
  // refresher itself only fires on first `getRefreshedToken()` call.
  const tokenRefresher = createTokenRefresher({ logger });

  let registry;
  let varsClient: ReturnType<typeof createRefreshAwareClient> | undefined;

  if (isLocalRegistry) {
    // DR-024 §"Decision rule for future PRs" 2: factory dispatch on
    // `registry.type`. The empty token argument is unused for local
    // (LocalRegistryClient ignores it) — kept positional for call-surface
    // symmetry across all four variants.
    registry = createRegistryFromConfig(config.registry, config.project, '');
    // varsClient stays undefined; /sign is structurally inactive.
  } else {
    // TypeScript narrowed `config.registry.type` to `repo|org|profile`
    // by virtue of the `isLocalRegistry` check above. The exhaustive
    // switch over the narrowed union still fails the build if a fifth
    // GitHub-backed variant is ever added — same coverage as the
    // pre-DR-024 form.
    let signPathPrefix: string;
    switch (config.registry.type) {
      case 'org':
        signPathPrefix = `/orgs/${config.registry.org}`;
        break;
      case 'profile':
        signPathPrefix = `/repos/${config.registry.user}/${config.registry.user}`;
        break;
      case 'repo':
        signPathPrefix = `/repos/${config.registry.owner}/${config.registry.repo}`;
        break;
    }

    // Project-registry path prefix differs from /sign prefix only in the
    // org case (registry uses /orgs/<org> too — same shape). Re-derive
    // here for clarity even though it's identical to signPathPrefix.
    const registryClient = createRefreshAwareClient({
      pathPrefix: signPathPrefix,
      tokenRefresher,
      logger,
    });
    registry = createRegistry(registryClient, config.project);

    // Build the variables client for the /sign challenge flow with the
    // same refresh-aware wrapping. Stop hook + /sign both 401 after the
    // 1-hour token TTL absent this fix.
    varsClient = createRefreshAwareClient({
      pathPrefix: signPathPrefix,
      tokenRefresher,
      logger,
    });
  }

  // DR-041 Decision 1 (groundnuty/macf#784): resolve this agent's multi-CA
  // trust bundle ONCE, here, before any of the three mTLS-configuring sites
  // are constructed below. `varsClient` is the SAME shared-registry client
  // used for the /sign flow above — a federated fleet's `<PROJECT>_CA_CERT`
  // lives in that same registry namespace (DR-006 shared profile scope),
  // just under a different project prefix, so no separate client is needed.
  // `undefined` in DR-024 local-registry mode; `resolveFederatedCaBundle`
  // throws LOUD at startup if federated_cas is declared without a resolvable
  // shared registry, rather than silently shipping a partial bundle (see
  // trust-bundle.ts module doc). Zero federation declared → returns
  // `ownCaCertPem` unchanged, byte-for-byte the pre-#784 single-CA value.
  //
  // DR-041 Amendment A (groundnuty/macf#786): `federatedCaProjects` is read
  // HERE (single source) via `loadFederatedCaProjects`, then threaded to
  // BOTH `resolveFederatedCaBundle` (the trust-bundle PEM, below) AND
  // `notifyDispatchDeps.federatedCas` (the outbound MESSAGING addressing
  // gate, further below) — the SAME list gates both "can I mTLS this fleet"
  // and "can I address this fleet's guest," which is the point (DR-041
  // Amendment A decision 1: trust is the single admission gate for both).
  const ownCaCertPem = readFileSync(config.caCertPath, 'utf8');
  const federatedCaProjects = loadFederatedCaProjects(config.workspaceDir, logger);
  const trustBundlePem = await resolveFederatedCaBundle(
    ownCaCertPem,
    federatedCaProjects,
    varsClient,
    logger,
  );

  // In-memory challenge store (DR-010, #80). Process-local; server restart
  // between step 1 and step 2 of a flow invalidates outstanding challenges.
  const challengeStore = createChallengeStore();

  // /sign endpoint handler — two-step challenge-response (DR-010).
  // Step 1: allocate challenge, return id + instruction (no registry write).
  // Step 2: verify challenge_id + registry-observed value, sign CSR.
  const onSign = async (request: SignRequest): Promise<Record<string, unknown>> => {
    // DR-024 §"/sign endpoint disabled in local mode": local-registry
    // mode has no GitHub-mediated identity proof. Reject with a clear
    // 404 + diagnostic body so peers that mistakenly hit /sign see why
    // it's not part of the trust path here.
    if (varsClient === undefined) {
      throw new HttpError(
        404,
        '/sign is disabled in local-registry mode (DR-024). ' +
          'Local mode uses pre-shared CA via filesystem permissions; ' +
          'there is no challenge-response trust path.',
      );
    }
    const sharedVarsClient = varsClient;
    // Try to load CA key — if not available, this agent can't sign.
    let ca: { certPem: string; keyPem: string };
    try {
      ca = loadCA(config.caCertPath, config.caKeyPath);
    } catch {
      throw new HttpError(503, 'CA key not available on this agent');
    }

    if (!request.challenge_done) {
      // Step 1: allocate in-memory challenge, return id + instruction.
      const challenge = createChallenge({
        project: config.project,
        agentName: request.agent_name,
        store: challengeStore,
      });
      logger.info('sign_challenge_created', {
        agent_name: request.agent_name,
        challenge_id: challenge.challengeId,
      });
      return {
        challenge_id: challenge.challengeId,
        instruction: challenge.instruction,
      };
    }

    // Step 2: verify challenge + sign CSR. The refine() on SignRequestSchema
    // already guarantees challenge_id is present when challenge_done is true.
    const result = await verifyAndConsumeChallenge({
      project: config.project,
      agentName: request.agent_name,
      challengeId: request.challenge_id!,
      store: challengeStore,
      client: sharedVarsClient,
    });

    if (result === 'mismatch') {
      // Generic error — do not leak which check failed (no oracle for
      // attackers probing expired/mismatched-agent/wrong-value, etc).
      logger.warn('sign_challenge_failed', { agent_name: request.agent_name });
      throw new HttpError(401, 'challenge verification failed');
    }

    logger.info('sign_challenge_verified', { agent_name: request.agent_name });

    const certPem = await signCSR({
      csrPem: request.csr,
      agentName: request.agent_name,
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });

    logger.info('sign_cert_issued', { agent_name: request.agent_name });
    return { cert: certPem };
  };

  // A2A v1.0 AgentCard built at startup; served at
  // /.well-known/agent-card.json. Static across the channel-server
  // process lifetime per spec § 4.4.1 (AgentCard version-pinned).
  // groundnuty/macf#370 — A2A Phase 1.
  const agentCard = buildAgentCard({
    // macf#545: the A2A card `name` is the peer-ADDRESSING identity (how a peer
    // resolves us) → the routing label, not the OTEL bot-name.
    agentName: config.routingLabel,
    agentRole: config.agentRole,
    project: config.project,
    url: `https://${config.advertiseHost}:${config.port}`,
    version: PACKAGE_VERSION,
  });

  // macf#390 Phase 2a: in-memory A2A task store wired into the JSON-RPC
  // route at /a2a/v1. Lifecycle scoped to the channel-server process —
  // no on-disk state per design decision 2 on the issue. Phase 2.5 may
  // revisit if longer-lived persistence becomes a need.
  const taskStore = new TaskStore();

  // DR-038 Slice B (groundnuty/macf#704): construct the delivery stores ONCE,
  // process-lifetime. `createDefaultDeliveryStores` is the in-memory
  // PLACEHOLDER driver (logs a loud warning) — the devops-owned DR-008
  // disk-spool driver is a straight swap of this one call, per
  // `delivery/driver.ts`'s doc comment; nothing downstream (inbox, outbox,
  // the /notify + message/send receiver wiring, or the notify_peer sender
  // wiring) changes shape when that swap happens.
  const { outboxStore, inboxStore } = createDefaultDeliveryStores(logger);
  const inbox = createInbox({ store: inboxStore });

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    // DR-041 Decision 1 (macf#784): the resolved multi-CA trust bundle
    // (own CA + any federated fleets' CAs) — see the module doc on
    // `trust-bundle.ts` + the `caBundlePem` doc comment on `https.ts`'s
    // config for the full trust model + any-of-N semantics.
    caBundlePem: trustBundlePem,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    onSign,
    agentCard,
    taskStore,
    // DR-038 Slice B: the durable receiver-side inbox — persist-then-ACK
    // (Decision 3) for the direct A2A path (/notify peer_notification +
    // A2A message/send).
    inbox,
    logger,
    // macf#473 piece 2: the inbound recv edge sites (/notify + A2A
    // message/send) record an authoritative ledger edge BEFORE delivering
    // to onNotify, capturing trace_id from the active SERVER span.
    recordLedgerEdge,
    selfAgentName: config.agentName,
    // DR-030 §6 (macf#568): identity echoed in the diagnostic ACK. routingLabel
    // matches the /health `agent` (registry slot the router resolves);
    // instanceId is the staleness disambiguator.
    routingLabel: config.routingLabel,
    instanceId: config.instanceId,
  });

  // macf#256 / DR-023 UC-1: register notify_peer MCP tool on the MCP
  // channel BEFORE connecting (registerTool is a one-shot capability
  // declaration; can't add tools post-connect). Tool resolves peer URLs
  // via the registry, mTLS-POSTs to peer's /notify HTTP endpoint.
  // Per Option A (impl-time refinement to DR-023 §UC-1, approved on
  // macf#256): `to` field is OPTIONAL — when absent, broadcasts to all
  // peers in the project registry (excluding self).
  const { notifyPeer, NotifyPeerInputSchema, NotifyPeerOutputSchema, createNotifyOutboxSend } =
    await import('./notify-peer.js');
  // macf#396 Phase 3: outbound A2A client for protocol-selection.
  // Shared across notify_peer invocations so the AgentCard cache is
  // process-lifetime (5-min TTL) rather than per-call. Closed in
  // shutdown.ts when the channel-server stops.
  const { A2aClient } = await import('./a2a-client.js');
  const mTlsClientCertPem = readFileSync(config.agentCertPath, 'utf8');
  const mTlsClientKeyPem = readFileSync(config.agentKeyPath, 'utf8');
  // DR-041 Decision 1 (macf#784): both outbound mTLS legs (A2A message/send
  // + legacy /notify POST) validate the REMOTE peer's server cert against
  // this SAME trust bundle the inbound side validates client certs against
  // — a foreign fleet's server cert must be accepted here too, or outbound
  // A2A/notify to a federated guest stays broken even though inbound works.
  // Deliberately the identical `trustBundlePem` value built once above; do
  // NOT re-read `config.caCertPath` here (that would silently drop the
  // federated CAs from the outbound leg only — the exact partial-bundle
  // hazard trust-bundle.ts's module doc warns against).
  const caCertPem = trustBundlePem;
  const a2aClient = new A2aClient({
    mTlsClientCertPem,
    mTlsClientKeyPem,
    caCertPem,
  });
  // DR-041 Amendment A (groundnuty/macf#786): outbound cross-fleet GUEST
  // addressing. `varsClient` is the SAME shared-registry client used for the
  // trust-bundle's federated CA cert reads above + the /sign flow — a
  // federated fleet's `<PROJECT>_AGENT_<NAME>` registry slot lives in that
  // SAME shared registry namespace (DR-006 shared profile scope), just
  // under a different project prefix, so `createRegistry(varsClient,
  // homeProject)` resolves it with no separate client + no fresh token
  // mint. `undefined` in DR-024 local-registry mode — structurally
  // unreachable in practice anyway, since `federatedCaProjects` is always
  // `[]` there (a non-empty `federated_cas` throws above, at the trust-
  // bundle resolution step, before this point is ever reached).
  const resolveCrossProjectAgent =
    varsClient === undefined
      ? undefined
      : (homeProject: string, name: string): Promise<AgentInfo | null> =>
          createRegistry(varsClient, homeProject).get(name);
  const notifyDispatchDeps = {
    registry,
    selfAgentName: config.agentName,
    // macf#790 Gap 2: the canonical cross-fleet reply-to slug, computed ONCE
    // here (the wiring site — the only place both `config.project` and
    // `config.routingLabel` are naturally in scope) and threaded through
    // notify-peer.ts's dispatch so every outbound payload carries an
    // unambiguous `<project>/<name>` reply address rather than a bare
    // routing label a cross-fleet guest would resolve inside its OWN
    // project.
    selfReplyTo: `${config.project}/${config.routingLabel}`,
    mTlsClientCertPem,
    mTlsClientKeyPem,
    caCertPem,
    logger,
    a2aClient,
    // macf#473 piece 2: the outbound send edge site records a ledger edge
    // per peer once the dispatch outcome (delivered) is known.
    recordLedgerEdge,
    // DR-041 Amendment A (macf#786): the SAME federated-project list that
    // gated the trust bundle above now gates outbound guest addressing too.
    federatedCas: federatedCaProjects,
    resolveCrossProjectAgent,
  };

  // DR-038 Slice B: wire the durable outbox — `send` is the ACTUAL peer
  // dispatch (legacy /notify POST or A2A message/send), adapted to the
  // `OutboxSendFn` contract by `createNotifyOutboxSend`. `onDeadLetter` is a
  // LOUD log only in this slice — Decision 4 explicitly scopes the GitHub-
  // issue escalation as a decision-layer action, not a channel-server-core
  // concern; wiring the actual `gh issue create` call is a follow-on (TODO
  // below), not this wiring slice.
  const { send: outboxSend, lastAttempts: outboxAttempts } = createNotifyOutboxSend(notifyDispatchDeps);
  const onOutboxDeadLetter = (entry: OutboxEntry): void => {
    logger.error('outbox_dead_letter', {
      id: entry.id,
      target: entry.target,
      enqueued_at: new Date(entry.enqueuedAt).toISOString(),
      attempt_count: entry.attemptCount,
      // TODO(DR-038 Decision 4 follow-on): escalate via `gh issue create` to
      // the operator/reporter — the always-durable GitHub-anchored downgrade
      // Decision 4 calls for. Deliberately NOT wired here: a GitHub call is a
      // decision-layer action ("a decision-layer action... NOT a store-driver
      // method" — Decision 4), out of scope for the channel-server core this
      // slice wires. Until that lands, a TTL-expired direct-path message is
      // LOUDLY logged but not automatically escalated to GitHub.
      detail: 'TTL expired without a durable ACK (DR-038 Decision 4). GitHub-issue ' +
        'escalation is NOT YET WIRED — see TODO at this call site.',
    });
  };
  const outbox = createOutbox({
    store: outboxStore,
    send: outboxSend,
    onDeadLetter: onOutboxDeadLetter,
    logger,
  });
  const notifyPeerDeps = {
    ...notifyDispatchDeps,
    outbox,
    outboxAttempts,
  };

  // DR-038 Decision 4 ("resumed on sender startup"): drive the outbox once
  // immediately at boot, before the recurring ticker starts, so any entry
  // already overdue when this process comes up gets its first attempt right
  // away rather than waiting a full tick interval. A no-op today (the
  // in-memory store starts empty every process launch); load-bearing once a
  // durable store driver (DR-008) replaces the in-memory placeholder.
  const outboxTicker = createOutboxTicker({ outbox, logger });
  void outboxTicker.tickNow();

  // DR-038 Decision 5 follow-on (groundnuty/macf#744): the live inbox
  // orphan-drain ticker — re-fires `onNotify` for any undrained inbox entry
  // whose ORIGINAL `onNotify` call threw between `inbox.accept()` and
  // `inbox.markProcessed()` (see the on-receipt wiring in https.ts). Same
  // "tick once at boot, then start the recurring interval" ordering as the
  // outbox ticker above, and for the same reason: any orphan already
  // undrained when this process comes up gets an immediate first re-fire
  // attempt rather than waiting a full tick interval. Today's in-memory
  // inbox store starts empty every process launch, so this is a no-op on a
  // fresh boot — it becomes load-bearing for cross-restart orphans once a
  // durable store driver (DR-008) replaces the placeholder; even today it
  // recovers a transient onNotify failure within THIS process's lifetime,
  // which the fire-and-forget pre-DR-038 behavior never did.
  const inboxTicker = createInboxTicker({ inbox, onNotify, logger });
  void inboxTicker.tickNow();
  mcp.mcp.registerTool(
    'notify_peer',
    {
      description: 'Notify a peer agent of an event via the channel-server network. ' +
        'If `to` is provided, POSTs to that peer\'s /notify. If absent, broadcasts to ' +
        'all registered peers in the project (excluding self). `to` also accepts a ' +
        '`<project>/<name>` cross-fleet guest slug (DR-041 Amendment A, macf#786), gated ' +
        'on the fleet\'s `federated_cas` trust bundle. Failure semantics are ' +
        'observational + non-blocking per DR-023 §"Failure-mode contract" — `isError: true` ' +
        'when peers were attempted but none delivered, OR when a guest `to` fails the DR-041 ' +
        'addressing ladder (see the `error` field), signaling LLM self-correction; ' +
        'the triggering Stop event proceeds regardless.',
      inputSchema: NotifyPeerInputSchema,
      outputSchema: NotifyPeerOutputSchema,
    },
    async (input) => {
      const result = await notifyPeer(notifyPeerDeps, input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        // Spread into a fresh object so the SDK's open
        // `{[x: string]: unknown}` index-signature constraint accepts
        // it. NotifyPeerResult's `readonly` props make the strict-shape
        // assignment fail otherwise.
        structuredContent: { ...result },
        // DR-041 Amendment A (macf#786): a guest-addressing ladder failure
        // (`result.error` set) is ALSO an error result, not just the
        // pre-#786 attempted-but-undelivered case.
        isError: result.error !== undefined || (result.peers_attempted > 0 && result.peers_delivered === 0),
      };
    },
  );

  // macf#271 / DR-023 UC-3: register checkpoint_to_memory MCP tool on
  // the same MCP channel. Hook event is PreCompact (NOT Stop, despite
  // the issue's original framing — see DR-023 §UC-3 amendment + the
  // checkpoint.ts file-header for the reframe rationale). Tool writes
  // a session-handoff file to the agent's per-project memory directory
  // under `~/.claude/projects/<encoded-cwd>/memory/`. Failure-mode is
  // observational + non-blocking: any error path returns
  // `{written: false, reason}` and `isError: false` so PreCompact
  // proceeds (a missed checkpoint is recoverable; blocking compaction
  // is not).
  const {
    checkpointToMemory,
    CheckpointToMemoryInputSchema,
    CheckpointToMemoryOutputSchema,
  } = await import('./checkpoint.js');
  const checkpointDeps = {
    selfAgentName: config.agentName,
    logger,
  };
  mcp.mcp.registerTool(
    'checkpoint_to_memory',
    {
      description: 'Write a session-handoff checkpoint to the agent\'s per-project ' +
        'memory directory. Invoked by the PreCompact hook (DR-023 UC-3) before context ' +
        'compaction so the next session can read structured handoff state via the ' +
        'MEMORY.md index pattern. Failure-mode is observational + non-blocking — write ' +
        'failures log + return `{written: false, reason}` to the hook without raising; ' +
        'compaction always proceeds.',
      inputSchema: CheckpointToMemoryInputSchema,
      outputSchema: CheckpointToMemoryOutputSchema,
    },
    async (input) => {
      const result = await checkpointToMemory(checkpointDeps, input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: { ...result },
        // Per DR-023 §UC-3: PreCompact is best-effort. Even on
        // write-failure, surface isError:false so compaction proceeds.
        // The `reason` field in structured output is sufficient signal
        // for LLM self-correction in subsequent turns.
        isError: false,
      };
    },
  );

  // P1: Connect MCP channel
  await mcp.connect();
  lifecycle.set('mcp-connected'); // macf#642 forensic phase marker

  // P1: Bind port
  const { actualPort } = await httpsServer.start(config.port, config.host);
  lifecycle.set('port-bound'); // macf#642 forensic phase marker

  // P2: Collision detection. The HTTPS server is already bound + serving
  // (P1 above), so a version-aware takeover (groundnuty/macf#424) only fires
  // for an instance that can actually serve — a crash-on-boot newer instance
  // never reaches here to strand the slot.
  // macf#538: the registry KEY (collision lookup + register + remove) uses the
  // routing-label (defaults to agentName, so inert for existing agents), NOT
  // the OTEL bot-name. Telemetry/metrics/display below stay on agentName — only
  // the registry IDENTITY moves. (Peer-facing identities — health, A2A card,
  // cert CN — must agree with the key; tracked as the macf#538 follow-up.)
  const collisionResult = await checkCollision(
    config.routingLabel,
    registry,
    {
      caCertPath: config.caCertPath,
      agentCertPath: config.agentCertPath,
      agentKeyPath: config.agentKeyPath,
    },
    PACKAGE_VERSION,
    logger,
  );
  lifecycle.set('collision-checked'); // macf#642 forensic phase marker

  if (collisionResult.action === 'abort') {
    await httpsServer.stop();
    throw new CollisionError(
      config.routingLabel,
      collisionResult.existing.host,
      collisionResult.existing.port,
    );
  }

  // P2: Register in GitHub variable (use advertiseHost, not bind address)
  const agentInfo: AgentInfo = {
    host: config.advertiseHost,
    port: actualPort,
    type: config.agentType as 'permanent' | 'worker',
    instance_id: config.instanceId,
    started: new Date().toISOString(),
  };

  // P2: Over-register the slot (groundnuty/macf#702 — the devops 8h-outage
  // fix, reshaping the #439 CAS write). The collision check above observed the
  // slot as absent (action 'register') or held by a takeover target (action
  // 'takeover'). `registerWithTakeover` CLAIMS the slot — including over a
  // stale/same/older entry (never aborting-to-dead because the slot is
  // occupied) — and YIELDS (throws RegisterRaceError, caught at main()'s
  // top-level for a CLEAN exit 0) only to a genuinely newer + LIVE instance.
  // See `register-with-takeover.ts` for the full claim-vs-yield contract; it
  // re-classifies any lost-race `current` with the same liveness + #424
  // version quadrant the collision check used, bounded by MAX_REGISTER_RETRIES.
  try {
    await registerWithTakeover({
      registry,
      routingLabel: config.routingLabel,
      agentInfo,
      collisionResult,
      certPaths: {
        caCertPath: config.caCertPath,
        agentCertPath: config.agentCertPath,
        agentKeyPath: config.agentKeyPath,
      },
      incomingVersion: PACKAGE_VERSION,
      logger,
    });
  } catch (err) {
    // Stop the (already-serving) HTTPS server before propagating a yield/abort
    // so we don't leave a bound port behind on our way out.
    await httpsServer.stop();
    throw err;
  }
  lifecycle.set('registered'); // macf#642 forensic phase marker
  logger.info('registered', {
    agent: config.routingLabel,
    host: config.advertiseHost,
    port: actualPort,
    instance_id: config.instanceId,
  });

  // P2: Registry heartbeat (DR-031, groundnuty/macf#568). The live instance
  // periodically re-stamps `last_heartbeat` on its OWN slot (instance-id-guarded:
  // re-stamp only if the slot still carries OUR instance_id, never a #424
  // takeover's). A reader TTL-judges an aged-out entry dead — the backstop for the
  // UNGRACEFUL death (kill -9 / OOM / power loss) that the graceful-deregister
  // (#586) shutdown handler below never runs for. COARSE by design (default 5 min,
  // `MACF_REGISTRY_HEARTBEAT_INTERVAL_MS` overrides; `0` disables) to bound the
  // App-token write budget + the #439 If-Match TOCTOU surface. Started AFTER the
  // shutdown handler is wired so `stop()` is registered for cleanup first.
  // macf#702 loser-yields split-brain guard: if a heartbeat observes that a
  // NEWER instance has over-registered our slot ('not-ours'), THIS displaced
  // instance stands down via the graceful-shutdown cleanup so exactly one live
  // instance remains. `shutdownCleanup` is assigned just below and always set
  // before `start()` fires the first beat, so the lazy reference is safe.
  const registryHeartbeat = createRegistryHeartbeat({
    registry,
    agentName: config.routingLabel,
    instanceId: config.instanceId,
    logger,
    intervalMs: resolveHeartbeatIntervalMs(process.env['MACF_REGISTRY_HEARTBEAT_INTERVAL_MS']),
    onDisplaced: () => {
      logger.warn('standing_down_displaced', {
        agent: config.routingLabel,
        instance_id: config.instanceId,
        detail: 'a newer instance over-registered the slot — graceful shutdown (macf#702)',
      });
      // Trigger the same instance-id-guarded graceful cleanup as a SIGTERM. It
      // deregisters only if still ours (it is NOT — the newer instance holds
      // it, so deregister will no-op 'not-ours') + stops the HTTPS server, then
      // exits. Fire-and-forget; the cleanup's once-guard makes a racing signal
      // benign.
      void shutdownCleanup?.('displaced-by-newer-instance').then(
        (ok) => process.exit(ok ? 0 : 1),
        () => process.exit(1),
      );
    },
  });

  // P2: Register shutdown handler. On graceful shutdown it deregisters the
  // registry slot (key = routingLabel) — but instance-id-guarded (DR-031,
  // groundnuty/macf#553 root-cause): the slot is deleted ONLY if it still
  // carries OUR instance_id, so a newer instance that took over the slot
  // (groundnuty/macf#424) while we ran is never clobbered on our exit. Also
  // clears the registry-heartbeat interval (DR-031) on the way out.
  // macf#642: capture the returned cleanup so the top-level crash handlers can
  // attempt the same instance-id-guarded graceful deregister (behind a hard
  // timeout) on an uncaughtException / unhandledRejection.
  shutdownCleanup = registerShutdownHandler({
    agentName: config.routingLabel,
    registry,
    instanceId: config.instanceId,
    httpsServer,
    healthState: health,
    registryHeartbeat,
    // DR-038 Slice B: clear the outbox-retry-drive interval on shutdown —
    // same best-effort posture as registryHeartbeat/otel-probe (unref()'d,
    // so a missed clear can't pin exit; a hiccup must not mask a real
    // deregister/stop failure).
    outboxTicker,
    // DR-038 Decision 5 follow-on (groundnuty/macf#744): clear the inbox
    // orphan-drain interval on shutdown too — same best-effort posture.
    inboxTicker,
    logger,
  });

  // Start the periodic heartbeat now that its stop() is wired into shutdown.
  registryHeartbeat.start();
  // DR-038 Decision 4: start the periodic outbox-retry-drive tick now that
  // its stop() is wired into shutdown too (same ordering rationale as the
  // registry heartbeat above).
  outboxTicker.start();
  // DR-038 Decision 5 follow-on (groundnuty/macf#744): start the periodic
  // inbox orphan-drain tick now that its stop() is wired into shutdown too.
  inboxTicker.start();

  lifecycle.set('serving'); // macf#642 forensic phase marker
  logger.info('server_started', {
    port: actualPort,
    host: config.advertiseHost,
    agent: config.agentName,
    type: config.agentType,
    instance_id: config.instanceId,
    pid: process.pid,
    version: PACKAGE_VERSION,
    log_path: forensicLogPath,
  });

  // macf#642: periodic "alive" tick to the forensic log (every 60s, unref()'d so
  // it can't pin the event loop). Its purpose is its ABSENCE — when the server
  // dies a SILENT death (OOM / SIGKILL / power loss) no crash handler runs and
  // the log just stops; the last `alive` line then bounds the death to a ≤60s
  // window. Started last so the log shows the server reached steady state.
  createAliveTicker({ logger, lifecycle }).start();
  }  // end runStartup
}

main().catch((err) => {
  // Force a clean exit on any bootstrap abort (groundnuty/macf#449). Setting
  // `process.exitCode` alone is NOT enough to terminate: the MCP stdio
  // transport keeps stdin's readable stream open, so the event loop stays
  // alive and the process *hangs* instead of exiting (reproducible with a
  // held-open stdin, e.g. `sleep 10 | node …`). `process.exit()` tears down
  // regardless. We set exitCode first (so the code is correct even if the
  // write callback never fires) and exit from the stderr-flush callback so
  // the diagnostic isn't truncated on a pipe.
  //
  // groundnuty/macf#702: `RegisterRaceError` is now a CLEAN YIELD, not a
  // fatal abort — it fires ONLY when a genuinely newer, live instance holds
  // the slot (see the retry loop in `main()` above), which is the CORRECT
  // outcome for this launch, not a failure. Exit 0 with an informational
  // (not "Fatal:") message so external monitors don't flag a legitimate
  // yield as a crash. `CollisionError` and any other thrown error remain the
  // fatal exit-1 path (groundnuty/macf#447).
  if (err instanceof RegisterRaceError) {
    process.exitCode = 0;
    process.stderr.write(
      `${err.message}\n`,
      () => process.exit(0),
    );
    return;
  }

  process.exitCode = 1;
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    () => process.exit(1),
  );
});
