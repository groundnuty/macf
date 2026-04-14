import type { HealthResponse } from '../../types.js';
import type { PeerEntry } from './registry.js';

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * Format a status dashboard for a single agent.
 */
export function formatDashboard(
  agentName: string,
  ownHealth: HealthResponse | null,
  peers: ReadonlyArray<{ readonly name: string; readonly health: HealthResponse | null }>,
): string {
  const lines: string[] = [];

  lines.push(`=== ${agentName} ===`);
  lines.push('');

  if (ownHealth) {
    lines.push(`Status:    ${ownHealth.status}`);
    lines.push(`Type:      ${ownHealth.type}`);
    lines.push(`Uptime:    ${formatUptime(ownHealth.uptime_seconds)}`);
    lines.push(`Version:   ${ownHealth.version}`);
    if (ownHealth.current_issue) {
      lines.push(`Working:   issue #${ownHealth.current_issue}`);
    } else {
      lines.push(`Working:   idle`);
    }
    if (ownHealth.last_notification) {
      lines.push(`Last ping: ${ownHealth.last_notification}`);
    }
  } else {
    lines.push('Status: not registered or unreachable');
  }

  if (peers.length > 0) {
    lines.push('');
    lines.push('Peers:');
    for (const peer of peers) {
      if (peer.name === agentName) continue;
      if (peer.health) {
        const issue = peer.health.current_issue ? `#${peer.health.current_issue}` : 'idle';
        lines.push(`  ${peer.name.padEnd(20)} online   ${formatUptime(peer.health.uptime_seconds).padEnd(8)} ${issue}`);
      } else {
        lines.push(`  ${peer.name.padEnd(20)} offline`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a table of peers.
 */
export function formatPeerTable(
  peers: ReadonlyArray<{ readonly name: string; readonly info: PeerEntry['info']; readonly health: HealthResponse | null }>,
): string {
  const lines: string[] = [];

  lines.push(`${'NAME'.padEnd(22)} ${'HOST:PORT'.padEnd(28)} ${'STATUS'.padEnd(10)} ${'UPTIME'.padEnd(8)} CURRENT`);
  lines.push(`${'─'.repeat(22)} ${'─'.repeat(28)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(12)}`);

  for (const peer of peers) {
    const endpoint = `${peer.info.host}:${peer.info.port}`;
    if (peer.health) {
      const issue = peer.health.current_issue ? `#${peer.health.current_issue}` : 'idle';
      lines.push(
        `${peer.name.padEnd(22)} ${endpoint.padEnd(28)} ${'online'.padEnd(10)} ${formatUptime(peer.health.uptime_seconds).padEnd(8)} ${issue}`,
      );
    } else {
      lines.push(
        `${peer.name.padEnd(22)} ${endpoint.padEnd(28)} ${'offline'.padEnd(10)} ${'—'.padEnd(8)} —`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format pending issues for display.
 */
export function formatIssues(
  issues: ReadonlyArray<{ readonly number: number; readonly title: string }>,
): string {
  if (issues.length === 0) {
    return 'No pending issues.';
  }

  const lines: string[] = [`${issues.length} pending issue(s):\n`];
  for (const issue of issues) {
    lines.push(`  #${issue.number}: ${issue.title}`);
  }
  return lines.join('\n');
}
