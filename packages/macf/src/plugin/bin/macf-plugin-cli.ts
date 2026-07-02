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
import { formatDashboard, formatPeerTable, formatHealthDetail, formatStartupReconcile } from '../lib/format.js';
import { getOwnRegistration, listPeers } from '../lib/registry.js';
import { pingAgent } from '../lib/health.js';
import { probePeerHealth } from '../lib/probe-peer-health.js';
import { buildDashboardHealth } from '../lib/build-dashboard-health.js';
import { getRegistryConfig } from '../lib/registry-config.js';
import { mintFreshGitHubToken } from '../lib/fresh-github-token.js';
import { checkIssues } from '../lib/work.js';
import { getInboxStore } from '../lib/inbox-store.js';
import { drainInbox } from '../lib/inbox-drain.js';
import { createRegistryFromConfig } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import {
  loadGuestBindings,
  gatherGuestStatuses,
  formatGuestBlock,
  type GuestProbeFn,
  type GuestResolveFn,
} from '../../cli/commands/fleet-guests.js';

const command = process.argv[2];

/**
 * Probe a `route` guest's `/health` by host:port, reusing the same cert-env
 * mTLS path `probePeerHealth` uses for members (returns null when the cert env
 * is missing or the probe fails → the guest renders offline, still visible via
 * the registry). Only `host`/`port` of the synthetic `AgentInfo` are used.
 */
function probeGuestHealth(host: string, port: number): Promise<HealthResponse | null> {
  const info: AgentInfo = { host, port, type: 'permanent', instance_id: '', started: '' };
  return probePeerHealth({ name: 'guest', info });
}

async function main(): Promise<void> {
  const agentName = process.env['MACF_AGENT_NAME'] ?? 'unknown';
  const project = process.env['MACF_PROJECT'] ?? 'MACF';
  const registryConfig = getRegistryConfig();

  switch (command) {
    case 'status': {
      // Local-mode skip-token: LocalRegistryClient ignores the token argument
      // (no GitHub backend); claude.sh intentionally doesn't export App-cred
      // env vars in local mode per DR-024 / PR #329. Mirrors
      // `channel-server/src/server.ts` line 210.
      // GitHub-mode: forceMint via mintFreshGitHubToken() to bypass any stale
      // GH_TOKEN inherited from a long-running parent Claude TUI (macf#338).
      const token = registryConfig.type === 'local' ? '' : await mintFreshGitHubToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      // Fetch own registration from the registry so the dashboard header
      // reflects whether THIS agent is actually registered (see #84 —
      // previously always "not registered" due to hardcoded null).
      const [ownRegistration, peers] = await Promise.all([
        getOwnRegistration(agentName, registry),
        listPeers(registry),
      ]);
      const { ownHealth, peersWithHealth } = await buildDashboardHealth(
        ownRegistration,
        peers,
        probePeerHealth,
      );
      console.log(formatDashboard(agentName, ownRegistration, ownHealth, peersWithHealth));
      break;
    }

    case 'peers': {
      // Local-mode skip-token (see status case for rationale).
      // GitHub-mode: forceMint to bypass any stale GH_TOKEN inherited from
      // a long-running parent Claude TUI (>1hr → 1hr-TTL bot token expired).
      // Each macf-plugin-cli invocation is a short-lived subprocess; mint
      // freshness is bounded to one CLI run. macf#338.
      const token = registryConfig.type === 'local' ? '' : await mintFreshGitHubToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      const peers = await listPeers(registry);
      const peersWithHealth = await Promise.all(
        peers.map(async p => ({ ...p, health: await probePeerHealth(p) })),
      );
      console.log(formatPeerTable(peersWithHealth));

      // GUEST / external collaborators block (DR-036 Amendment A, macf#679) —
      // cross-fleet guests the consumer DEPENDS on but does NOT supervise. Same
      // block `macf fleet status` renders. Additive + best-effort: any failure
      // here must never break the members roster above.
      const workspaceDir = process.env['MACF_WORKSPACE_DIR'] ?? process.cwd();
      const guestBindings = loadGuestBindings(workspaceDir);
      if (guestBindings.length > 0) {
        const resolveGuest: GuestResolveFn = (homeProject, name) =>
          createRegistryFromConfig(registryConfig, homeProject, token).get(name);
        const guestProbe: GuestProbeFn = (host, port) =>
          probeGuestHealth(host, port);
        const guests = await gatherGuestStatuses(guestBindings, resolveGuest, guestProbe);
        console.log('');
        console.log(formatGuestBlock(guests, Date.now()));
      }
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

      // Local-mode skip-token (see status case for rationale).
      // GitHub-mode: forceMint to bypass any stale GH_TOKEN inherited from
      // a long-running parent Claude TUI (>1hr → 1hr-TTL bot token expired).
      // Each macf-plugin-cli invocation is a short-lived subprocess; mint
      // freshness is bounded to one CLI run. macf#338.
      const token = registryConfig.type === 'local' ? '' : await mintFreshGitHubToken();
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
      // Same forceMint rationale as status/peers/ping (macf#338) — `issues`
      // is GitHub-only by design (queries gh api repos/...), so the
      // stale-token-from-long-running-parent class hits here too.
      const token = await mintFreshGitHubToken();
      const repo = process.env['MACF_REGISTRY_REPO'] ?? 'groundnuty/macf';
      const label = process.env['MACF_AGENT_LABEL'] ?? 'code-agent';
      const issues = await checkIssues({ repo, label, token });

      // DR-038 Decision 5 — the on-startup completeness half: drain any
      // inbox message that arrived while the agent was busy/relaunching
      // or whose tmux-wake didn't land, and inject the coordination.md §5
      // review/gate/mention sweep instruction alongside the issue queue.
      // `getInboxStore()` is currently an in-memory placeholder (see
      // `inbox-store.ts`) — real cross-process durability is pending
      // devops's disk-backed driver (DR-008).
      const inboxStore = getInboxStore();
      const drained = await drainInbox(inboxStore);

      console.log(formatStartupReconcile(issues, drained));
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
