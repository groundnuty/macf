import { describe, it, expect } from 'vitest';
import { formatDashboard, formatPeerTable, formatIssues } from '../../../src/plugin/lib/format.js';
import type { HealthResponse } from '../../../src/types.js';

const sampleHealth: HealthResponse = {
  agent: 'code-agent',
  status: 'online',
  type: 'permanent',
  uptime_seconds: 3600,
  current_issue: 42,
  version: '0.1.0',
  last_notification: '2026-03-28T18:01:00Z',
};

describe('formatDashboard', () => {
  it('formats agent status with health data', () => {
    const output = formatDashboard('code-agent', sampleHealth, []);
    expect(output).toContain('code-agent');
    expect(output).toContain('online');
    expect(output).toContain('1h');
    expect(output).toContain('#42');
  });

  it('shows not registered when no health', () => {
    const output = formatDashboard('unknown', null, []);
    expect(output).toContain('not registered');
  });

  it('shows idle when no current issue', () => {
    const health: HealthResponse = { ...sampleHealth, current_issue: null };
    const output = formatDashboard('code-agent', health, []);
    expect(output).toContain('idle');
  });

  it('includes peers in output', () => {
    const peers = [
      { name: 'code-agent', health: sampleHealth },
      { name: 'science-agent', health: null },
    ];
    const output = formatDashboard('code-agent', sampleHealth, peers);
    expect(output).toContain('Peers:');
    expect(output).toContain('science-agent');
    expect(output).toContain('offline');
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
