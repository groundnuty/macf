import { describe, it, expect } from 'vitest';
import {
  formatDashboard,
  formatPeerTable,
  formatHealthDetail,
  formatIssues,
  formatIssuesOneline,
  formatSweepInstruction,
  formatStartupReconcile,
  formatReporterStallSweep,
} from '../../../src/plugin/lib/format.js';
import type { HealthResponse } from '@groundnuty/macf-core';
import type { OwnRegistration } from '../../../src/plugin/lib/registry.js';
import type { AgentInfo } from '@groundnuty/macf-core';
import type { ReporterStallResult } from '../../../src/plugin/lib/reporter-stall.js';

const sampleHealth: HealthResponse = {
  agent: 'code-agent',
  status: 'online',
  type: 'permanent',
  uptime_seconds: 3600,
  current_issue: 42,
  version: '0.1.0',
  last_notification: '2026-03-28T18:01:00Z',
};

const sampleRegistration: OwnRegistration = {
  name: 'code-agent',
  info: {
    host: '100.86.5.117',
    port: 8847,
    type: 'permanent',
    instance_id: 'abc123',
    started: '2026-04-16T10:00:00Z',
  },
};

describe('formatDashboard', () => {
  it('formats agent status with health data (full live details)', () => {
    const output = formatDashboard('code-agent', sampleRegistration, sampleHealth, []);
    expect(output).toContain('code-agent');
    expect(output).toContain('online');
    expect(output).toContain('1h');
    expect(output).toContain('#42');
  });

  it('shows not registered when both registration and health are null', () => {
    const output = formatDashboard('unknown', null, null, []);
    expect(output).toContain('not registered');
  });

  it('shows idle when no current issue', () => {
    const health: HealthResponse = { ...sampleHealth, current_issue: null };
    const output = formatDashboard('code-agent', sampleRegistration, health, []);
    expect(output).toContain('idle');
  });

  it('includes peers in output', () => {
    const peers = [
      { name: 'code-agent', health: sampleHealth },
      { name: 'science-agent', health: null },
    ];
    const output = formatDashboard('code-agent', sampleRegistration, sampleHealth, peers);
    expect(output).toContain('Peers:');
    expect(output).toContain('science-agent');
    expect(output).toContain('offline');
  });

  it('shows registration info when agent is registered but no live health (#84)', () => {
    // This is the #84 fix: without a live health ping, previously the
    // header always said "not registered" even for agents that were
    // registered. Now it shows what we know from the registry entry.
    const output = formatDashboard('code-agent', sampleRegistration, null, []);
    expect(output).toContain('registered');
    expect(output).not.toContain('not registered');
    expect(output).toContain('100.86.5.117:8847');
    expect(output).toContain('abc123');
  });

  it('does NOT include self in peers table (self goes in header)', () => {
    const peers = [
      { name: 'code-agent', health: sampleHealth },   // self
      { name: 'science-agent', health: null },        // peer
    ];
    const output = formatDashboard('code-agent', sampleRegistration, sampleHealth, peers);
    // Self appears in header once ("=== code-agent ===") but not in the
    // peers table. Count explicit table-formatted occurrences.
    const peerSection = output.split('Peers:')[1] ?? '';
    expect(peerSection).not.toContain('code-agent');
    expect(peerSection).toContain('science-agent');
  });
});

describe('formatPeerTable', () => {
  it('formats a table of peers', () => {
    const peers = [
      {
        name: 'code-agent',
        info: { host: '100.86.5.117', port: 8847, type: 'permanent' as const, instance_id: 'a1', started: '2026-01-01T00:00:00Z' },
        health: sampleHealth,
      },
      {
        name: 'science-agent',
        info: { host: '100.86.5.117', port: 8848, type: 'permanent' as const, instance_id: 'b2', started: '2026-01-01T00:00:00Z' },
        health: null,
      },
    ];
    const output = formatPeerTable(peers);
    expect(output).toContain('NAME');
    expect(output).toContain('code-agent');
    expect(output).toContain('online');
    expect(output).toContain('science-agent');
    expect(output).toContain('offline');
  });
});

describe('formatHealthDetail (#85)', () => {
  const sampleInfo: AgentInfo = {
    host: '100.86.5.117',
    port: 8847,
    type: 'permanent',
    instance_id: 'abc123',
    started: '2026-04-16T10:00:00Z',
  };

  it('shows full health when ping succeeded', () => {
    const output = formatHealthDetail('code-agent', sampleInfo, sampleHealth);
    expect(output).toContain('code-agent');
    expect(output).toContain('100.86.5.117:8847');
    expect(output).toContain('abc123');
    expect(output).toContain('permanent');
    expect(output).toContain('2026-04-16T10:00:00Z');
    expect(output).toContain('online');
    expect(output).toContain('1h');
    expect(output).toContain('#42');
  });

  it('shows offline when ping returned null', () => {
    const output = formatHealthDetail('code-agent', sampleInfo, null);
    expect(output).toContain('code-agent');
    // Registration details still shown even when offline
    expect(output).toContain('100.86.5.117:8847');
    expect(output).toContain('abc123');
    // Clear offline message
    expect(output).toContain('offline');
    expect(output).toContain('no response');
    // No stale health fields in the output
    expect(output).not.toContain('online');
    expect(output).not.toContain('Uptime:');
  });

  it('shows idle when agent is online with no current issue', () => {
    const idle: HealthResponse = { ...sampleHealth, current_issue: null };
    const output = formatHealthDetail('code-agent', sampleInfo, idle);
    expect(output).toContain('idle');
  });

  it('omits last_notification line when null', () => {
    const noPing: HealthResponse = { ...sampleHealth, last_notification: null };
    const output = formatHealthDetail('code-agent', sampleInfo, noPing);
    expect(output).not.toContain('Last ping:');
  });
});

describe('formatIssues', () => {
  it('formats pending issues', () => {
    const output = formatIssues([
      { number: 11, title: 'P1 Channel Server' },
      { number: 19, title: 'P2 Registration' },
    ]);
    expect(output).toContain('2 pending');
    expect(output).toContain('#11');
    expect(output).toContain('#19');
  });

  it('shows no pending issues message', () => {
    const output = formatIssues([]);
    expect(output).toContain('No pending issues');
  });
});

describe('formatIssuesOneline (macf#816)', () => {
  it('renders repo#N: title pairs separated by "; "', () => {
    const output = formatIssuesOneline([
      { number: 1, title: 'fix the thing', repo: 'groundnuty/macf' },
      { number: 2, title: 'write the docs', repo: 'groundnuty/macf' },
    ]);
    expect(output).toBe('groundnuty/macf#1: fix the thing; groundnuty/macf#2: write the docs');
  });

  it('falls back to bare #N when repo is absent (back-compat, single-repo callers)', () => {
    const output = formatIssuesOneline([{ number: 5, title: 'no repo tag' }]);
    expect(output).toBe('#5: no repo tag');
  });

  it('returns an empty string when there are no pending issues (caller skips the submit)', () => {
    expect(formatIssuesOneline([])).toBe('');
  });

  it('caps at 8 entries by default', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      title: `issue ${i + 1}`,
      repo: 'groundnuty/macf',
    }));
    const output = formatIssuesOneline(issues);
    expect(output.split('; ')).toHaveLength(8);
    expect(output).toContain('groundnuty/macf#8');
    expect(output).not.toContain('groundnuty/macf#9');
  });

  it('honors a custom limit', () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: `issue ${i + 1}`,
      repo: 'groundnuty/macf',
    }));
    const output = formatIssuesOneline(issues, 2);
    expect(output.split('; ')).toHaveLength(2);
  });

  it('never emits multi-part "pending issue(s)"/"No pending issues" prose (compact mode, no formatIssues text)', () => {
    expect(formatIssuesOneline([{ number: 1, title: 'x', repo: 'a/b' }])).not.toContain('pending issue');
    expect(formatIssuesOneline([])).not.toContain('No pending issues');
  });
});

describe('formatSweepInstruction — DR-038 Decision 5 §Communication 5 injection', () => {
  it('references coordination.md and all three sweeps (review/gate/mention)', () => {
    const text = formatSweepInstruction();
    expect(text).toContain('coordination.md');
    expect(text).toContain('§Communication 5');
    expect(text).toContain('reviewer-sweep');
    expect(text).toContain('gate-sweep');
    expect(text.toLowerCase()).toContain('mention-sweep');
  });
});

describe('formatStartupReconcile — extended SessionStart startup_check (DR-038 Decision 5)', () => {
  it('composes issues + drained inbox messages + the sweep instruction', () => {
    const output = formatStartupReconcile(
      [{ number: 11, title: 'P1 Channel Server' }],
      [{ id: 'msg-1', payload: { hello: 'world' }, receivedAt: 0, processed: false }],
    );
    expect(output).toContain('#11');
    expect(output).toContain('msg-1');
    expect(output).toContain('hello');
    expect(output).toContain('coordination.md');
  });

  it('omits the drained-messages section entirely when the inbox is empty (no drain noise)', () => {
    const output = formatStartupReconcile([{ number: 11, title: 'x' }], []);
    expect(output).not.toContain('inbox message');
  });

  it('still injects the sweep instruction on an otherwise-quiet startup', () => {
    const output = formatStartupReconcile([], []);
    expect(output).toContain('No pending issues');
    expect(output).not.toContain('inbox message');
    expect(output).toContain('coordination.md');
  });

  it('preserves the existing formatIssues text verbatim as the first section', () => {
    const issues = [{ number: 42, title: 'test issue' }];
    const output = formatStartupReconcile(issues, []);
    expect(output.startsWith(formatIssues(issues))).toBe(true);
  });

  it('composes the reporter-stall section when passed (macf#1170), without changing pre-existing output when omitted', () => {
    const reporterStalls: ReporterStallResult = {
      stalls: [
        {
          repo: 'org/repo',
          number: 7,
          title: 'a stale one',
          updatedAt: '2026-08-01T00:00:00Z',
          daysQuiet: 8.2,
        },
      ],
      unreadableRepos: [],
      enumerationFailed: false,
      totalStale: 1,
    };
    const withStalls = formatStartupReconcile([], [], reporterStalls);
    const withoutStalls = formatStartupReconcile([], []);

    expect(withStalls).toContain('org/repo#7');
    expect(withoutStalls).not.toContain('org/repo#7');
    // Back-compat: omitting the 3rd arg reproduces the pre-#1170 output.
    expect(withoutStalls).toBe(formatStartupReconcile([], [], undefined));
  });

  it('omits the reporter-stall section entirely on a clean sweep (no noise)', () => {
    const clean: ReporterStallResult = { stalls: [], unreadableRepos: [], enumerationFailed: false, totalStale: 0 };
    const output = formatStartupReconcile([{ number: 1, title: 'x' }], [], clean);
    expect(output).not.toContain('Reporter-side');
    expect(output).not.toContain('issue(s) you filed');
  });
});

describe('formatReporterStallSweep (groundnuty/macf#1170)', () => {
  it('returns empty string on a clean sweep (all repos reachable, zero stalls) — no noise', () => {
    const result: ReporterStallResult = { stalls: [], unreadableRepos: [], enumerationFailed: false, totalStale: 0 };
    expect(formatReporterStallSweep(result)).toBe('');
  });

  it('renders the honest-unknown floor when the top-level enumeration failed — never looks like a clean sweep', () => {
    const result: ReporterStallResult = { stalls: [], unreadableRepos: [], enumerationFailed: true, totalStale: 0 };
    const output = formatReporterStallSweep(result);
    expect(output).not.toBe('');
    expect(output.toLowerCase()).toContain('could not enumerate');
    expect(output.toLowerCase()).toContain('unknown');
  });

  it('renders unreadable repos even when there are zero stalls (never silently omitted as "clean")', () => {
    const result: ReporterStallResult = {
      stalls: [],
      unreadableRepos: ['org/broken'],
      enumerationFailed: false,
      totalStale: 0,
    };
    const output = formatReporterStallSweep(result);
    expect(output).toContain('org/broken');
    expect(output.toLowerCase()).toContain('could not check');
  });

  it('renders a plain reminder line for a stall with no cleared deferral reference', () => {
    const result: ReporterStallResult = {
      stalls: [
        { repo: 'groundnuty/macf', number: 999, title: 'verification nobody acted on', updatedAt: '', daysQuiet: 6.4 },
      ],
      unreadableRepos: [],
      enumerationFailed: false,
      totalStale: 1,
    };
    const output = formatReporterStallSweep(result);
    expect(output).toContain('groundnuty/macf#999');
    expect(output).toContain('verification nobody acted on');
    expect(output).toContain('6d');
    expect(output.toLowerCase()).toContain('re-read');
    expect(output).not.toContain('CLOSED');
    // Not capped (totalStale === stalls.length) — no "N of M" disclosure noise.
    expect(output).not.toMatch(/\bof\b \d+ issue/);
  });

  it('renders an upgraded verdict line for a stall with a cleared deferral reference', () => {
    const result: ReporterStallResult = {
      stalls: [
        {
          repo: 'groundnuty/macf',
          number: 855,
          title: 'deferral condition cleared',
          updatedAt: '',
          daysQuiet: 8.0,
          clearedRef: { ref: '#932', closedAt: '2026-08-17T00:00:00Z' },
        },
      ],
      unreadableRepos: [],
      enumerationFailed: false,
      totalStale: 1,
    };
    const output = formatReporterStallSweep(result);
    expect(output).toContain('#932');
    expect(output).toContain('CLOSED');
    expect(output).toContain('2026-08-17');
  });

  // The bounded-output requirement (macf#1170: "Cap it and say what was
  // capped") — a truncated list must disclose the truncation, not render
  // identically to a complete one.
  it('discloses the cap as "N of M" when the candidate list was truncated', () => {
    const result: ReporterStallResult = {
      stalls: [
        { repo: 'org/repo', number: 1, title: 'oldest', updatedAt: '', daysQuiet: 20 },
      ],
      unreadableRepos: [],
      enumerationFailed: false,
      totalStale: 4,
    };
    const output = formatReporterStallSweep(result);
    expect(output).toContain('1 of 4');
    expect(output).toContain('3 more not shown');
    expect(output).not.toMatch(/close|Close/); // surfaces, never instructs closure
  });

  it('does NOT disclose a cap when nothing was truncated (totalStale === stalls.length)', () => {
    const result: ReporterStallResult = {
      stalls: [
        { repo: 'org/repo', number: 1, title: 'only one', updatedAt: '', daysQuiet: 10 },
      ],
      unreadableRepos: [],
      enumerationFailed: false,
      totalStale: 1,
    };
    const output = formatReporterStallSweep(result);
    expect(output).not.toContain(' of ');
    expect(output).not.toContain('more not shown');
  });

  it('never renders text matching the hook\'s auto-submit gate regex (pending issue(s): / inbox message(s) drained on startup:)', () => {
    const result: ReporterStallResult = {
      stalls: [
        { repo: 'org/repo', number: 1, title: 'x', updatedAt: '', daysQuiet: 10 },
      ],
      unreadableRepos: ['org/other'],
      enumerationFailed: false,
      totalStale: 1,
    };
    const output = formatReporterStallSweep(result);
    expect(output).not.toMatch(/pending issue\(s\):/);
    expect(output).not.toMatch(/inbox message\(s\) drained on startup:/);

    const failed = formatReporterStallSweep({ stalls: [], unreadableRepos: [], enumerationFailed: true, totalStale: 0 });
    expect(failed).not.toMatch(/pending issue\(s\):/);
    expect(failed).not.toMatch(/inbox message\(s\) drained on startup:/);
  });
});
