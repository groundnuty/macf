import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { loadAllAgents, readAgentConfig, agentCertPath, agentKeyPath } from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';
import type { HealthResponse } from '../../types.js';

const HEALTH_TIMEOUT_MS = 5000;

async function pingHealth(
  host: string,
  port: number,
  caCertPem: string,
  certPath: string,
  keyPath: string,
): Promise<HealthResponse | null> {
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'GET',
        path: '/health',
        ca: Buffer.from(caCertPem),
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        rejectUnauthorized: true,
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            resolve(body as HealthResponse);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * Show status of registered agents by pinging their /health endpoints.
 *
 * If projectDir is given, uses that project's config for registry access
 * (scopes the view to that project's peers). Otherwise loads all agents
 * from the global index and uses the first one's config.
 */
export async function showStatus(projectDir?: string): Promise<void> {
  const agents = loadAllAgents();
  const token = await generateToken();

  // Pick the config that drives registry access.
  let driverConfig;
  if (projectDir) {
    const c = readAgentConfig(projectDir);
    if (!c) {
      console.error(`Could not read agent config at ${projectDir}/.macf/macf-agent.json`);
      return;
    }
    driverConfig = c;
  } else {
    if (agents.length === 0) {
      console.log('No agents configured. Run `macf init` first.');
      return;
    }
    driverConfig = agents[0]!.config;
  }

  const registry = createRegistryFromConfig(driverConfig.registry, driverConfig.project, token);

  // Get CA cert from registry for mTLS pings (raw PEM, not via Registry which wraps as AgentInfo)
  const client = createClientFromConfig(driverConfig.registry, token);
  const caCertPem = await client.readVariable(`${driverConfig.project.toUpperCase()}_CA_CERT`);

  if (!caCertPem) {
    console.log('CA certificate not found in registry. Run `macf certs init` first.');
    return;
  }

  const peers = await registry.list('');

  console.log('macf agents:\n');

  for (const peer of peers) {
    // Find local agent config for cert paths
    const localAgent = agents.find(a => a.config.agent_name === peer.name);
    const certP = localAgent ? agentCertPath(localAgent.path) : '';
    const keyP = localAgent ? agentKeyPath(localAgent.path) : '';

    const health = await pingHealth(peer.info.host, peer.info.port, caCertPem, certP, keyP);

    if (health) {
      const uptime = formatUptime(health.uptime_seconds);
      const issue = health.current_issue ? `issue #${health.current_issue}` : 'idle';
      console.log(
        `  ${peer.name.padEnd(18)} ${peer.info.host}:${peer.info.port}`.padEnd(48) +
        `online   uptime ${uptime.padEnd(8)} ${issue}`,
      );
    } else {
      console.log(
        `  ${peer.name.padEnd(18)} ${'—'.padEnd(28)}offline`,
      );
    }
  }

  // Show any local agents not in registry
  for (const { config } of agents) {
    const inRegistry = peers.some(p => p.name === config.agent_name);
    if (!inRegistry) {
      console.log(
        `  ${config.agent_name.padEnd(18)} ${'—'.padEnd(28)}not registered`,
      );
    }
  }
}
