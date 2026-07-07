import type { HealthResponse } from '@groundnuty/macf-core';
import type { OwnRegistration, PeerEntry } from './registry.js';

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * Format a status dashboard for a single agent.
 *
 * Three header states, based on what we know about the caller's own
 * agent (see #84 — previously this was always "Status: not registered"):
 *
 *   - `ownHealth` set (via self-ping): full live details
 *   - `ownRegistration` set but no health: registration info from the
 *     registry (host:port, type, instance_id, started_at) — enough
 *     to confirm the agent IS registered even without mTLS self-ping
 *   - Neither: "not registered"
 */
export function formatDashboard(
  agentName: string,
  ownRegistration: OwnRegistration | null,
  ownHealth: HealthResponse | null,
  peers: ReadonlyArray<{ readonly name: string; readonly health: HealthResponse | null }>,
): string {
  const lines: string[] = [];

  lines.push(`=== ${agentName} ===`);
  lines.push('');

  if (ownHealth) {
    // Live self-ping succeeded — show full health details.
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
  } else if (ownRegistration) {
    // Registry entry present but no live health (either couldn't ping
    // or pinging wasn't attempted). Show registration info as minimum
    // useful signal.
    lines.push(`Status:    registered (no live health)`);
    lines.push(`Type:      ${ownRegistration.info.type}`);
    lines.push(`Endpoint:  ${ownRegistration.info.host}:${ownRegistration.info.port}`);
    lines.push(`Instance:  ${ownRegistration.info.instance_id}`);
    lines.push(`Started:   ${ownRegistration.info.started}`);
  } else {
    lines.push('Status:    not registered');
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
 * Format a detailed view of a single agent's health (for `/macf-ping`).
 * Covers the live-health case (cert present, ping succeeded) and the
 * offline case (registration known, ping failed). See #85.
 */
export function formatHealthDetail(
  name: string,
  info: PeerEntry['info'],
  health: HealthResponse | null,
): string {
  const lines: string[] = [];
  lines.push(`=== ${name} ===`);
  lines.push('');
  lines.push(`Endpoint:  ${info.host}:${info.port}`);
  lines.push(`Type:      ${info.type}`);
  lines.push(`Instance:  ${info.instance_id}`);
  lines.push(`Started:   ${info.started}`);
  lines.push('');
  if (health) {
    lines.push(`Status:    ${health.status}`);
    lines.push(`Uptime:    ${formatUptime(health.uptime_seconds)}`);
    lines.push(`Version:   ${health.version}`);
    if (health.current_issue) {
      lines.push(`Working:   issue #${health.current_issue}`);
    } else {
      lines.push(`Working:   idle`);
    }
    if (health.last_notification) {
      lines.push(`Last ping: ${health.last_notification}`);
    }
  } else {
    lines.push('Status:    offline (no response to /health ping)');
  }
  return lines.join('\n');
}

/**
 * Format pending issues for display. `repo` is optional back-compat (single-
 * repo callers); when present (DR-038 Decision 7's App-install-set x label
 * queue spans multiple repos), it's prefixed so issue numbers — which are
 * only unique WITHIN a repo, not across the fleet — aren't ambiguous.
 */
export function formatIssues(
  issues: ReadonlyArray<{ readonly number: number; readonly title: string; readonly repo?: string }>,
): string {
  if (issues.length === 0) {
    return 'No pending issues.';
  }

  const lines: string[] = [`${issues.length} pending issue(s):\n`];
  for (const issue of issues) {
    const ref = issue.repo ? `${issue.repo}#${issue.number}` : `#${issue.number}`;
    lines.push(`  ${ref}: ${issue.title}`);
  }
  return lines.join('\n');
}

/**
 * Compact, single-line rendering of the pending-issue queue (macf#816) —
 * `repo#N: title; repo#N: title`. Built for embedding directly in the
 * `macf-startup-pickup.sh` SUBMIT prompt so the self-nudge names the
 * SPECIFIC pending issues, instead of a generic "review the queue above"
 * pointer that made the agent re-derive what was actually pending.
 *
 * Caps at `limit` entries (default 8) — the submit line names the
 * actionable set for a follow-up turn, not an unbounded backlog dump.
 * Returns `''` when there is nothing pending (or `issues` is empty) so the
 * caller can skip the submit entirely rather than send an empty nudge.
 */
export function formatIssuesOneline(
  issues: ReadonlyArray<{ readonly number: number; readonly title: string; readonly repo?: string }>,
  limit = 8,
): string {
  return issues
    .slice(0, limit)
    .map((issue) => {
      const ref = issue.repo ? `${issue.repo}#${issue.number}` : `#${issue.number}`;
      return `${ref}: ${issue.title}`;
    })
    .join('; ');
}

/**
 * DR-038 Decision 5 — the injected `coordination.md §Communication 5`
 * sweep instruction. Promotes the review/gate/mention pull-disciplines
 * from "a discipline the agent must remember" to an injected startup
 * step (paired with the JOINT devops canonical rule-text change — see
 * DR-038 build-split "the §5-promotion is JOINT (code + devops) and its
 * two halves MUST land together").
 *
 * Unconditional by design: `formatStartupReconcile` always appends this,
 * regardless of whether any issues or drained inbox messages exist — the
 * whole point of §5(c) is "don't wait for a ping that may never come",
 * so the sweep instruction has to render even on an otherwise-quiet
 * startup.
 */
export function formatSweepInstruction(): string {
  return [
    'Coordination sweep (coordination.md §Communication 5) — run before considering yourself idle:',
    '  (a) reviewer-sweep: any peer PR awaiting your formal review (approve/request-changes)?',
    '  (b) inbound-review-sweep + mention-sweep: any review request, or @mention on an open thread, addressed to you that you have not yet actioned?',
    '  (c) gate-sweep: for anything you are waiting on, does the APPROVED review or artifact already exist on GitHub?',
    'Assert against live GitHub state directly — do not wait for a ping that may have already arrived and been missed.',
  ].join('\n');
}

/**
 * DR-038 Decision 5 — the extended SessionStart startup_check. Composes
 * three sections: the existing issue-queue (`formatIssues`, unchanged),
 * any inbox messages drained on this startup (`inbox-drain.ts`'s
 * `drainInbox`, the "completeness half" — messages that arrived while the
 * agent was busy/relaunching or whose tmux-wake didn't land), and the
 * injected §5 sweep instruction.
 *
 * The drained-messages section is OMITTED entirely when nothing was
 * drained — an empty inbox must not add noise to an otherwise-normal
 * startup. The sweep instruction always renders (see
 * `formatSweepInstruction`).
 */
export function formatStartupReconcile(
  issues: ReadonlyArray<{ readonly number: number; readonly title: string }>,
  drained: ReadonlyArray<{ readonly id: string; readonly payload: unknown; readonly receivedAt: number }>,
): string {
  const sections: string[] = [formatIssues(issues)];

  if (drained.length > 0) {
    const lines: string[] = [`${drained.length} inbox message(s) drained on startup:`];
    for (const entry of drained) {
      const receivedIso = new Date(entry.receivedAt).toISOString();
      lines.push(`  ${entry.id} (received ${receivedIso}): ${JSON.stringify(entry.payload)}`);
    }
    sections.push(lines.join('\n'));
  }

  sections.push(formatSweepInstruction());

  return sections.join('\n\n');
}
