import type { AgentInfo, Registry } from '../../registry/types.js';

export interface OwnRegistration {
  readonly name: string;
  readonly info: AgentInfo;
}

export interface PeerEntry {
  readonly name: string;
  readonly info: AgentInfo;
}

/**
 * Get this agent's own registration from the registry.
 */
export async function getOwnRegistration(
  agentName: string,
  registry: Registry,
): Promise<OwnRegistration | null> {
  const info = await registry.get(agentName);
  if (!info) return null;
  return { name: agentName, info };
}

/**
 * List all registered peers (including self).
 */
export async function listPeers(
  registry: Registry,
  prefix: string = '',
): Promise<readonly PeerEntry[]> {
  const entries = await registry.list(prefix);
  return entries.map(e => ({ name: e.name, info: e.info }));
}
