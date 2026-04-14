#!/usr/bin/env node
/**
 * MACF Plugin CLI — internal binary invoked by skills.
 * NOT the `macf` npm CLI (P4). This runs INSIDE Claude Code sessions.
 *
 * Usage:
 *   node macf-plugin-cli.js status
 *   node macf-plugin-cli.js peers
 *   node macf-plugin-cli.js ping <agent-name>
 *   node macf-plugin-cli.js issues
 */
import 'reflect-metadata';
import { formatDashboard, formatPeerTable, formatIssues } from '../lib/format.js';
import { listPeers } from '../lib/registry.js';
import { checkIssues } from '../lib/work.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';

const command = process.argv[2];

async function main(): Promise<void> {
  const agentName = process.env['MACF_AGENT_NAME'] ?? 'unknown';
  const project = process.env['MACF_PROJECT'] ?? 'MACF';

  switch (command) {
    case 'status': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(
        { type: 'repo', owner: 'groundnuty', repo: 'macf' },
        project,
        token,
      );
      const peers = await listPeers(registry);
      // Simple status without health pings (fast — health pinging is /macf-status's job)
      console.log(formatDashboard(agentName, null, peers.map(p => ({ name: p.name, health: null }))));
      break;
    }

    case 'peers': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(
        { type: 'repo', owner: 'groundnuty', repo: 'macf' },
        project,
        token,
      );
      const peers = await listPeers(registry);
      console.log(formatPeerTable(peers.map(p => ({ ...p, health: null }))));
      break;
    }

    case 'ping': {
      const targetName = process.argv[3];
      if (!targetName) {
        console.error('Usage: macf-plugin-cli ping <agent-name>');
        process.exitCode = 1;
        return;
      }
      console.log(`Pinging ${targetName}... (requires mTLS certs — use /macf-status for full health check)`);
      break;
    }

    case 'issues': {
      const token = await generateToken();
      const repo = 'groundnuty/macf';
      const label = 'code-agent';
      const issues = await checkIssues({ repo, label, token });
      console.log(formatIssues(issues));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available: status, peers, ping <name>, issues');
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
