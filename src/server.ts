import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import { createRegistryFromConfig } from './registry/factory.js';
import { checkCollision, CollisionError } from './collision.js';
import { registerShutdownHandler } from './shutdown.js';
import { generateToken } from './token.js';
import { checkPendingIssues } from './startup-issues.js';
import { createChallenge, verifyAndConsumeChallenge } from './certs/challenge.js';
import { signCSR } from './certs/agent-cert.js';
import { loadCA } from './certs/ca.js';
import type { NotifyPayload, SignRequest } from './types.js';
import type { AgentInfo } from './registry/types.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = createLogger({
    logPath: config.logPath,
    debug: config.debug,
  });

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

    let content: string;
    if (payload.type === 'issue_routed') {
      if (payload.issue_number !== undefined) {
        const suffix = payload.title ? `: ${payload.title}` : '';
        content = `Issue #${payload.issue_number} was routed to you${suffix}`;
        health.setCurrentIssue(payload.issue_number);
      } else {
        content = payload.title
          ? `An issue was routed to you: ${payload.title}`
          : 'An issue was routed to you';
      }
    } else if (payload.type === 'mention') {
      content = payload.message ?? 'You were mentioned';
    } else {
      content = payload.message ?? 'Pending issues found at startup';
    }

    logger.info('notify_received', {
      type: payload.type,
      issue: payload.issue_number,
    });

    await mcp.pushNotification(content, meta);
    health.recordNotification();

    logger.info('mcp_pushed', {
      type: payload.type,
      issue: payload.issue_number,
    });
  };

  // P2: Generate token early — needed for /sign endpoint and registry
  const token = await generateToken();
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const { createGitHubClient } = await import('./registry/github-client.js');

  // Build the variables client for the /sign challenge flow
  let signPathPrefix: string;
  switch (config.registry.type) {
    case 'org': signPathPrefix = `/orgs/${config.registry.org}`; break;
    case 'profile': signPathPrefix = `/repos/${config.registry.user}/${config.registry.user}`; break;
    case 'repo': signPathPrefix = `/repos/${config.registry.owner}/${config.registry.repo}`; break;
  }
  const varsClient = createGitHubClient(signPathPrefix, token);

  // P3: /sign endpoint handler (two-step challenge-response)
  const onSign = async (request: SignRequest): Promise<Record<string, unknown>> => {
    // Try to load CA key — if not available, this agent can't sign
    let ca: { certPem: string; keyPem: string };
    try {
      ca = loadCA(config.caCertPath, config.caCertPath.replace('-cert.pem', '-key.pem'));
    } catch {
      const err = new Error('CA key not available on this agent');
      (err as any).status = 503;
      throw err;
    }

    if (!request.challenge_done) {
      // Step 1: Create challenge
      const challenge = await createChallenge({
        project: config.project,
        agentName: request.agent_name,
        client: varsClient,
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

    // Step 2: Verify challenge + sign CSR
    await verifyAndConsumeChallenge({
      project: config.project,
      agentName: request.agent_name,
      client: varsClient,
    });
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

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    onSign,
    logger,
  });

  // P1: Connect MCP channel
  await mcp.connect();

  // P1: Bind port
  const { actualPort } = await httpsServer.start(config.port, config.host);

  // P2: Collision detection
  const collisionResult = await checkCollision(
    config.agentName,
    registry,
    {
      caCertPath: config.caCertPath,
      agentCertPath: config.agentCertPath,
      agentKeyPath: config.agentKeyPath,
    },
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

  await registry.register(config.agentName, agentInfo);
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

  // P2: Check for pending issues and push startup_check notification
  await checkPendingIssues({
    repo: 'groundnuty/macf',
    agentLabel: 'code-agent',
    token,
    onNotify,
    logger,
  });

  logger.info('server_started', {
    port: actualPort,
    host: config.advertiseHost,
    agent: config.agentName,
    type: config.agentType,
    instance_id: config.instanceId,
  });
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
