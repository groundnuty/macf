import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import type { NotifyPayload } from './types.js';

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

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    logger,
  });

  await mcp.connect();

  const { actualPort } = await httpsServer.start(config.port, config.host);

  logger.info('server_started', {
    port: actualPort,
    host: config.host,
    agent: config.agentName,
    type: config.agentType,
  });
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
