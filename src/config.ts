import { existsSync } from 'node:fs';
import { ConfigError } from './errors.js';
import type { AgentConfig } from './types.js';

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

  const debugStr = process.env['MACF_DEBUG'] ?? 'false';
  const debug = debugStr === 'true' || debugStr === '1';

  const logPath = process.env['MACF_LOG_PATH'] || undefined;

  return {
    agentName,
    agentType,
    host,
    port,
    caCertPath,
    agentCertPath,
    agentKeyPath,
    debug,
    logPath,
  };
}
