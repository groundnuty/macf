import { describe, it, expect } from 'vitest';
import { formatDashboard, formatPeerTable, formatHealthDetail, formatIssues } from '../../../src/plugin/lib/format.js';
import type { HealthResponse } from '../../../src/types.js';
import type { OwnRegistration } from '../../../src/plugin/lib/registry.js';
import type { AgentInfo } from '../../../src/registry/types.js';

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
