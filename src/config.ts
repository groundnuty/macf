import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ConfigError } from './errors.js';
import type { AgentConfig } from './types.js';
import type { RegistryConfig } from './registry/types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`Required environment variable ${name} is not set`);
  }
  return value;
}

function requireFilePath(name: string): string {
  const path = requireEnv(name);
  if (!existsSync(path)) {
    throw new ConfigError(`File not found for ${name}: ${path}`);
  }
  return path;
}

export function loadConfig(): AgentConfig {
  const agentName = requireEnv('MACF_AGENT_NAME');
  const caCertPath = requireFilePath('MACF_CA_CERT');
  const agentCertPath = requireFilePath('MACF_AGENT_CERT');
  const agentKeyPath = requireFilePath('MACF_AGENT_KEY');

  const agentType = process.env['MACF_AGENT_TYPE'] ?? 'permanent';
  if (agentType !== 'permanent' && agentType !== 'worker') {
    throw new ConfigError(`MACF_AGENT_TYPE must be "permanent" or "worker", got "${agentType}"`);
  }

  const portStr = process.env['MACF_PORT'] ?? '0';
  const port = Number.parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    throw new ConfigError(`MACF_PORT must be 0-65535, got "${portStr}"`);
  }

  const host = process.env['MACF_HOST'] ?? '0.0.0.0';
  const advertiseHost = process.env['MACF_ADVERTISE_HOST'] ?? (host === '0.0.0.0' ? '127.0.0.1' : host);

  const debugStr = process.env['MACF_DEBUG'] ?? 'false';
  const debug = debugStr === 'true' || debugStr === '1';

  const logPath = process.env['MACF_LOG_PATH'] || undefined;

  // P2: Registry config
  const project = process.env['MACF_PROJECT'] ?? 'MACF';
  const agentRole = process.env['MACF_AGENT_ROLE'] ?? agentName;
  const instanceId = randomBytes(3).toString('hex');

  const registryType = process.env['MACF_REGISTRY_TYPE'] ?? 'repo';
  const registryConfig = parseRegistryConfig(registryType);

  return {
    agentName,
    agentType,
    agentRole,
    host,
    advertiseHost,
    port,
    caCertPath,
    agentCertPath,
    agentKeyPath,
    debug,
    logPath,
    project,
    instanceId,
    registry: registryConfig,
  };
}

function parseRegistryConfig(registryType: string): RegistryConfig {
  switch (registryType) {
    case 'org': {
      const org = process.env['MACF_REGISTRY_ORG'];
      if (!org) throw new ConfigError('MACF_REGISTRY_ORG is required when MACF_REGISTRY_TYPE=org');
      return { type: 'org', org };
    }
    case 'profile': {
      const user = process.env['MACF_REGISTRY_USER'];
      if (!user) throw new ConfigError('MACF_REGISTRY_USER is required when MACF_REGISTRY_TYPE=profile');
      return { type: 'profile', user };
    }
    case 'repo': {
      const scope = process.env['MACF_REGISTRY_REPO'] ?? 'groundnuty/macf';
      const parts = scope.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new ConfigError(`MACF_REGISTRY_REPO must be "owner/repo", got "${scope}"`);
      }
      return { type: 'repo', owner: parts[0], repo: parts[1] };
    }
    default:
      throw new ConfigError(
        `MACF_REGISTRY_TYPE must be "org", "profile", or "repo", got "${registryType}"`,
      );
  }
}
