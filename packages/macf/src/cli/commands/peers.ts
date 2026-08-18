import { loadAllAgentsWithCwdFallback, readAgentConfig, tokenSourceFromConfig } from '../config.js';
import { createRegistryFromConfig } from '@groundnuty/macf-core';
import { generateToken } from '@groundnuty/macf-core';

/**
 * List peers from the registry.
 *
 * If projectDir is given, uses that project's config for registry access.
 * Otherwise uses the first agent from the global index.
 */
export async function listPeers(projectDir?: string): Promise<void> {
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
    // WHY (#959): loadAllAgents() alone only consults the global
    // ~/.macf/agents.json index, so a workspace whose config exists at
    // cwd but never made it into that index misreported "not configured"
    // — actively wrong advice on an already-initialised workspace. The
    // cwd fallback closes that gap; see loadAllAgentsWithCwdFallback.
    const agents = loadAllAgentsWithCwdFallback();
    if (agents.length === 0) {
      console.log('No agents configured. Run `macf init` first.');
      return;
    }
    driverConfig = agents[0]!.config;
    driverPath = agents[0]!.path;
  }

  const token = await generateToken(tokenSourceFromConfig(driverPath, driverConfig));
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
