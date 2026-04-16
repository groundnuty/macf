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
import { readFileSync } from 'node:fs';
import { formatDashboard, formatPeerTable, formatHealthDetail, formatIssues } from '../lib/format.js';
import { getOwnRegistration, listPeers } from '../lib/registry.js';
import { pingAgent } from '../lib/health.js';
import { checkIssues } from '../lib/work.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';
import { toVariableSegment } from '../../registry/variable-name.js';
import type { RegistryConfig } from '../../registry/types.js';

const command = process.argv[2];

function getRegistryConfig(): RegistryConfig {
  const repoEnv = process.env['MACF_REGISTRY_REPO'];
  if (repoEnv) {
    const parts = repoEnv.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { type: 'repo', owner: parts[0], repo: parts[1] };
    }
  }
  const orgEnv = process.env['MACF_REGISTRY_ORG'];
  if (orgEnv) return { type: 'org', org: orgEnv };
  const userEnv = process.env['MACF_REGISTRY_USER'];
  if (userEnv) return { type: 'profile', user: userEnv };
  // Default fallback
  return { type: 'repo', owner: 'groundnuty', repo: 'macf' };
}

async function main(): Promise<void> {
  const agentName = process.env['MACF_AGENT_NAME'] ?? 'unknown';
  const project = process.env['MACF_PROJECT'] ?? 'MACF';
  const registryConfig = getRegistryConfig();

  switch (command) {
    case 'status': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      // Fetch own registration from the registry so the dashboard header
      // reflects whether THIS agent is actually registered (see #84 —
      // previously always "not registered" due to hardcoded null).
      const [ownRegistration, peers] = await Promise.all([
        getOwnRegistration(agentName, registry),
        listPeers(registry),
      ]);
      // Live-health self-ping tracked under #85 (macf-ping is a stub;
      // wiring it up will let the dashboard show uptime/current_issue too).
      console.log(formatDashboard(
        agentName,
        ownRegistration,
        null,
        peers.map(p => ({ name: p.name, health: null })),
      ));
      break;
    }

    case 'peers': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      const peers = await listPeers(registry);
      console.log(formatPeerTable(peers.map(p => ({ ...p, health: null }))));
      break;
    }

    case 'ping': {
      // #85: invoke the canonical pingAgent over mTLS and format detailed
      // health. Previously this was a placeholder that just printed a TODO.
      const targetName = process.argv[3];
      if (!targetName) {
        console.error('Usage: macf-plugin-cli ping <agent-name>');
        process.exitCode = 1;
        return;
      }
      const caCertPath = process.env['MACF_CA_CERT'];
      const agentCertPath = process.env['MACF_AGENT_CERT'];
      const agentKeyPath = process.env['MACF_AGENT_KEY'];
      if (!caCertPath || !agentCertPath || !agentKeyPath) {
        console.error(
          'Error: MACF_CA_CERT / MACF_AGENT_CERT / MACF_AGENT_KEY must be set.\n' +
          '       These are set by claude.sh after `macf init`. Run /macf-ping from a macf workspace.',
        );
        process.exitCode = 1;
        return;
      }

      const token = await generateToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      // Look up the target in the registry. Names in the registry are
      // sanitized (uppercase, underscores), so match in that space.
      const peers = await listPeers(registry);
      const targetSanitized = toVariableSegment(targetName);
      const target = peers.find(p => p.name === targetSanitized);
      if (!target) {
        console.error(`Error: agent '${targetName}' not found in registry`);
        process.exitCode = 1;
        return;
      }

      const caCertPem = readFileSync(caCertPath, 'utf-8');
      const health = await pingAgent({
        host: target.info.host,
        port: target.info.port,
        caCertPem,
        certPath: agentCertPath,
        keyPath: agentKeyPath,
      });

      console.log(formatHealthDetail(targetName, target.info, health));
      if (!health) process.exitCode = 1;
      break;
    }

    case 'issues': {
      const token = await generateToken();
      const repo = process.env['MACF_REGISTRY_REPO'] ?? 'groundnuty/macf';
      const label = process.env['MACF_AGENT_LABEL'] ?? 'code-agent';
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
