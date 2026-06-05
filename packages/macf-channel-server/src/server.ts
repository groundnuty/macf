#!/usr/bin/env node
// macf#196: OTEL bootstrap is now async + dynamic. We still import
// the module eagerly (to get the function export), but the actual
// SDK packages are loaded only when the env is set, inside
// `bootstrapOtel()`. Calls to `trace.getTracer()` before the bootstrap
// runs return the global no-op tracer — harmless, since no spans are
// created before main() awaits the bootstrap.
import { bootstrapOtel } from './otel.js';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getTracer, SpanNames } from './tracing.js';
import { loadConfig } from '@groundnuty/macf-core';
import { createLogger } from '@groundnuty/macf-core';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import { buildAgentCard } from './agent-card.js';
import { TaskStore } from './a2a-task.js';
import { PACKAGE_VERSION } from './package-version.js';
import { createRegistry, createRegistryFromConfig } from '@groundnuty/macf-core';
import { checkCollision, CollisionError, RegisterRaceError } from './collision.js';
import { registerShutdownHandler } from './shutdown.js';
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
import type { NotifyPayload, SignRequest } from '@groundnuty/macf-core';

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

  const logger = createLogger({
    logPath: config.logPath,
    debug: config.debug,
  });

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
  const health = createHealthState(config.agentName, config.agentType);

  const onNotify = async (payload: NotifyPayload): Promise<void> => {
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
  };

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
    agentName: config.agentName,
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

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    onSign,
    agentCard,
    taskStore,
    logger,
  });

  // macf#256 / DR-023 UC-1: register notify_peer MCP tool on the MCP
  // channel BEFORE connecting (registerTool is a one-shot capability
  // declaration; can't add tools post-connect). Tool resolves peer URLs
  // via the registry, mTLS-POSTs to peer's /notify HTTP endpoint.
  // Per Option A (impl-time refinement to DR-023 §UC-1, approved on
  // macf#256): `to` field is OPTIONAL — when absent, broadcasts to all
  // peers in the project registry (excluding self).
  const { readFileSync } = await import('node:fs');
  const { notifyPeer, NotifyPeerInputSchema, NotifyPeerOutputSchema } = await import('./notify-peer.js');
  // macf#396 Phase 3: outbound A2A client for protocol-selection.
  // Shared across notify_peer invocations so the AgentCard cache is
  // process-lifetime (5-min TTL) rather than per-call. Closed in
  // shutdown.ts when the channel-server stops.
  const { A2aClient } = await import('./a2a-client.js');
  const mTlsClientCertPem = readFileSync(config.agentCertPath, 'utf8');
  const mTlsClientKeyPem = readFileSync(config.agentKeyPath, 'utf8');
  const caCertPem = readFileSync(config.caCertPath, 'utf8');
  const a2aClient = new A2aClient({
    mTlsClientCertPem,
    mTlsClientKeyPem,
    caCertPem,
  });
  const notifyPeerDeps = {
    registry,
    selfAgentName: config.agentName,
    mTlsClientCertPem,
    mTlsClientKeyPem,
    caCertPem,
    logger,
    a2aClient,
  };
  mcp.mcp.registerTool(
    'notify_peer',
    {
      description: 'Notify a peer agent of an event via the channel-server network. ' +
        'If `to` is provided, POSTs to that peer\'s /notify. If absent, broadcasts to ' +
        'all registered peers in the project (excluding self). Failure semantics are ' +
        'observational + non-blocking per DR-023 §"Failure-mode contract" — `isError: true` ' +
        'when peers were attempted but none delivered, signaling LLM self-correction; ' +
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
        isError: result.peers_attempted > 0 && result.peers_delivered === 0,
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

  // P1: Bind port
  const { actualPort } = await httpsServer.start(config.port, config.host);

  // P2: Collision detection. The HTTPS server is already bound + serving
  // (P1 above), so a version-aware takeover (groundnuty/macf#424) only fires
  // for an instance that can actually serve — a crash-on-boot newer instance
  // never reaches here to strand the slot.
  const collisionResult = await checkCollision(
    config.agentName,
    registry,
    {
      caCertPath: config.caCertPath,
      agentCertPath: config.agentCertPath,
      agentKeyPath: config.agentKeyPath,
    },
    PACKAGE_VERSION,
    logger,
  );

  if (collisionResult.action === 'abort') {
    await httpsServer.stop();
    throw new CollisionError(
      config.agentName,
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

  // P2: Conditional (CAS) write to close the read→write TOCTOU window
  // (groundnuty/macf#439). The collision check above observed the slot as
  // either absent (action 'register') or held by the takeover target (action
  // 'takeover'). Write only if the slot still matches that observation — a
  // concurrent same-identity instance that registered in the window makes this
  // write a no-op and aborts us cleanly, rather than silently clobbering it.
  const expectedSlot =
    collisionResult.action === 'takeover' ? collisionResult.previous : null;
  const registerResult = await registry.registerConditional(
    config.agentName,
    agentInfo,
    expectedSlot,
  );
  if (!registerResult.ok) {
    logger.warn('register_race_lost', {
      agent: config.agentName,
      expected_instance: expectedSlot?.instance_id ?? null,
      current_instance: registerResult.current?.instance_id ?? null,
      current_host: registerResult.current?.host ?? null,
      current_port: registerResult.current?.port ?? null,
    });
    await httpsServer.stop();
    throw new RegisterRaceError(config.agentName, registerResult.current);
  }
  logger.info('registered', {
    agent: config.agentName,
    host: config.advertiseHost,
    port: actualPort,
    instance_id: config.instanceId,
  });

  // P2: Register shutdown handler
  registerShutdownHandler({
    agentName: config.agentName,
    registry,
    httpsServer,
    logger,
  });

  logger.info('server_started', {
    port: actualPort,
    host: config.advertiseHost,
    agent: config.agentName,
    type: config.agentType,
    instance_id: config.instanceId,
  });
  }  // end runStartup
}

main().catch((err) => {
  // Force a clean exit on any fatal bootstrap abort (groundnuty/macf#449).
  // Both bootstrap-abort idioms — CollisionError and RegisterRaceError (#447)
  // — throw out of main() to here. Setting `process.exitCode = 1` alone is
  // NOT enough to terminate: the MCP stdio transport keeps stdin's readable
  // stream open, so the event loop stays alive and the process *hangs*
  // instead of exiting 1 (reproducible with a held-open stdin, e.g.
  // `sleep 10 | node …`). `process.exit(1)` tears down regardless. We set
  // exitCode first (so the code is correct even if the write callback never
  // fires) and exit from the stderr-flush callback so the diagnostic isn't
  // truncated on a pipe.
  process.exitCode = 1;
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    () => process.exit(1),
  );
});
