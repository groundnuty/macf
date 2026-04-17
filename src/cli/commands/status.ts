import { loadAllAgents, readAgentConfig, agentCertPath, agentKeyPath, tokenSourceFromConfig } from '../config.js';
import { toVariableSegment } from '../../registry/variable-name.js';
import { createClientFromConfig } from '../registry-helper.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';
// Shared with `src/plugin/lib/health.ts` — see ultrareview finding A3.
import { pingAgentHealth } from '../../mtls-health-ping.js';

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

  // Pick the config + path that drives registry access and token generation.
  let driverConfig;
  let driverPath: string;
  if (projectDir) {
    const c = readAgentConfig(projectDir);
    if (!c) {
      console.error(`Could not read agent config at ${projectDir}/.macf/macf-agent.json`);
      return;
    }
    driverConfig = c;
    driverPath = projectDir;
  } else {
    if (agents.length === 0) {
      console.log('No agents configured. Run `macf init` first.');
      return;
    }
    driverConfig = agents[0]!.config;
    driverPath = agents[0]!.path;
  }

  const token = await generateToken(tokenSourceFromConfig(driverPath, driverConfig));

  const registry = createRegistryFromConfig(driverConfig.registry, driverConfig.project, token);

  // Get CA cert from registry for mTLS pings (raw PEM, not via Registry which wraps as AgentInfo)
  const client = createClientFromConfig(driverConfig.registry, token);
  const caCertPem = await client.readVariable(`${toVariableSegment(driverConfig.project)}_CA_CERT`);

  if (!caCertPem) {
    console.log('CA certificate not found in registry. Run `macf certs init` first.');
    return;
  }

  const peers = await registry.list('');

  console.log('macf agents:\n');

  for (const peer of peers) {
    // peer.name comes back uppercased from the registry (toVariableSegment),
    // so compare in that space rather than the original-case agent_name.
    const localAgent = agents.find(
      a => toVariableSegment(a.config.agent_name) === peer.name,
    );
    const certP = localAgent ? agentCertPath(localAgent.path) : '';
    const keyP = localAgent ? agentKeyPath(localAgent.path) : '';

    const health = await pingAgentHealth({
      host: peer.info.host,
      port: peer.info.port,
      caCertPem,
      certPath: certP,
      keyPath: keyP,
    });

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

  // Show any local agents not in registry. Compare in sanitized space
  // since that's what the registry stores.
  for (const { config } of agents) {
    const sanitized = toVariableSegment(config.agent_name);
    const inRegistry = peers.some(p => p.name === sanitized);
    if (!inRegistry) {
      console.log(
        `  ${config.agent_name.padEnd(18)} ${'—'.padEnd(28)}not registered`,
      );
    }
  }
}
