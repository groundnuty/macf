import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AgentInfo, Registry } from './registry/types.js';
import type { Logger } from './types.js';
import { MacfError } from './errors.js';

export class CollisionError extends MacfError {
  constructor(name: string, host: string, port: number) {
    super(
      'AGENT_COLLISION',
      `Agent '${name}' is already running at ${host}:${port}. ` +
      'Stop the existing agent before starting another.',
    );
    this.name = 'CollisionError';
  }
}

const HEALTH_PING_TIMEOUT_MS = 5000;

/**
 * Ping an agent's /health endpoint via mTLS.
 * Returns true if the agent responds, false if unreachable.
 */
function pingHealth(
  host: string,
  port: number,
  caCertPath: string,
  agentCertPath: string,
  agentKeyPath: string,
  timeoutMs: number = HEALTH_PING_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'GET',
        path: '/health',
        ca: readFileSync(caCertPath),
        cert: readFileSync(agentCertPath),
        key: readFileSync(agentKeyPath),
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (res) => {
        // Any 2xx response means the agent is alive
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
        res.resume(); // drain response
      },
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export type CollisionResult =
  | { readonly action: 'register' }
  | { readonly action: 'takeover'; readonly previous: AgentInfo }
  | { readonly action: 'abort'; readonly existing: AgentInfo };

/**
 * Check if an agent is already registered and alive.
 * Returns the action to take: register (fresh), takeover (dead), or abort (alive).
 */
export async function checkCollision(
  name: string,
  registry: Registry,
  certPaths: {
    readonly caCertPath: string;
    readonly agentCertPath: string;
    readonly agentKeyPath: string;
  },
  logger: Logger,
): Promise<CollisionResult> {
  const existing = await registry.get(name);

  if (existing === null) {
    logger.info('collision_check', { result: 'fresh', agent: name });
    return { action: 'register' };
  }

  logger.info('collision_check', {
    result: 'variable_exists',
    agent: name,
    host: existing.host,
    port: existing.port,
    instance_id: existing.instance_id,
  });

  const alive = await pingHealth(
    existing.host,
    existing.port,
    certPaths.caCertPath,
    certPaths.agentCertPath,
    certPaths.agentKeyPath,
  );

  if (alive) {
    logger.warn('collision_check', {
      result: 'abort',
      agent: name,
      host: existing.host,
      port: existing.port,
    });
    return { action: 'abort', existing };
  }

  logger.info('collision_check', {
    result: 'takeover',
    agent: name,
    previous_instance: existing.instance_id,
  });
  return { action: 'takeover', previous: existing };
}
