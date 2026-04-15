import { loadAllAgents, readAgentConfig } from '../config.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';

/**
 * List peers from the registry.
 *
 * If projectDir is given, uses that project's config for registry access.
 * Otherwise uses the first agent from the global index.
 */
export async function listPeers(projectDir?: string): Promise<void> {
  const token = await generateToken();

  let driverConfig;
  if (projectDir) {
    const c = readAgentConfig(projectDir);
    if (!c) {
      console.error(`Could not read agent config at ${projectDir}/.macf/macf-agent.json`);
      return;
    }
    driverConfig = c;
  } else {
    const agents = loadAllAgents();
    if (agents.length === 0) {
      console.log('No agents configured. Run `macf init` first.');
      return;
    }
    driverConfig = agents[0]!.config;
  }

  const registry = createRegistryFromConfig(driverConfig.registry, driverConfig.project, token);

  const peers = await registry.list('');

  if (peers.length === 0) {
    console.log('No peers registered in the registry.');
    return;
  }

  console.log('macf peers:\n');
  console.log(`  ${'NAME'.padEnd(25)} ${'HOST'.padEnd(20)} ${'PORT'.padEnd(8)} ${'TYPE'.padEnd(12)} STARTED`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(20)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(24)}`);

  for (const peer of peers) {
    console.log(
      `  ${peer.name.padEnd(25)} ${peer.info.host.padEnd(20)} ${String(peer.info.port).padEnd(8)} ${peer.info.type.padEnd(12)} ${peer.info.started}`,
    );
  }
}
