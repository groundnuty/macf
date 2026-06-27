/**
 * Tests for `macf fleet status` — roster + live health (DR-030 phase-1, macf#568).
 *
 * Offline + deterministic: the registry peer-list and the mTLS `/health` probe
 * are both injected (no network). The load-bearing cases are (a) an ONLINE agent
 * carrying the full self-report incl. a PRESENT `state` + `otel` (proving the
 * defensive read of the not-yet-typed fields works), and (b) an OFFLINE agent
 * (proving placeholders + offline status). A frozen `now` makes the
 * cert_expiry warn/crit math deterministic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import {
  buildFleetRows,
  daysUntil,
  fleetStatusToJson,
  formatCertExpiry,
  formatFleetTable,
  formatOtel,
  formatRunState,
  formatUptime,
  gatherFleetStatus,
  runFleetStatus,
  type FleetAgentStatus,
  type FleetProbeFn,
  type FleetStatusDeps,
} from '../../src/cli/commands/fleet.js';

const NOW = Date.parse('2026-06-26T12:00:00Z');
const isoInDays = (d: number): string => new Date(NOW + d * 86_400_000).toISOString();

function info(host: string, port: number): AgentInfo {
  return { host, port, type: 'permanent', instance_id: `${host}-${port}`, started: isoInDays(-1) };
}

/** An online `/health` body carrying the (not-yet-typed) `state` + `otel` fields. */
function onlineHealth(extra: Record<string, unknown> = {}): HealthResponse {
  return {
    agent: 'code-agent',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 7200,
    current_issue: 568,
    version: '0.2.38',
    last_notification: null,
    instance_id: 'inst-aaaa',
    cert_expiry: isoInDays(90),
    ...extra,
  } as HealthResponse;
}

describe('formatUptime', () => {
  it('renders seconds / minutes / hours', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(18 * 60)).toBe('18m');
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe('2h5m');
    expect(formatUptime(3 * 3600)).toBe('3h');
  });

  it('returns a placeholder for bad input', () => {
    expect(formatUptime(-1)).toBe('—');
    expect(formatUptime(NaN)).toBe('—');
  });
});

describe('daysUntil', () => {
  it('computes whole days, negative when past', () => {
    expect(daysUntil(isoInDays(30), NOW)).toBe(30);
    expect(daysUntil(isoInDays(-5), NOW)).toBe(-5);
  });
});

describe('formatCertExpiry — warn <30d / crit <7d', () => {
  it('plain when far out, ⚠ when <30d, ✗ when <7d / expired', () => {
    expect(formatCertExpiry(isoInDays(90), NOW)).toBe('90d');
    expect(formatCertExpiry(isoInDays(20), NOW)).toBe('20d ⚠');
    expect(formatCertExpiry(isoInDays(3), NOW)).toBe('3d ✗');
    expect(formatCertExpiry(isoInDays(-2), NOW)).toBe('expired 2d ago ✗');
  });

  it('placeholders an absent / unparseable value', () => {
    expect(formatCertExpiry(null, NOW)).toBe('—');
    expect(formatCertExpiry(undefined, NOW)).toBe('—');
    expect(formatCertExpiry('not-a-date', NOW)).toBe('—');
  });
});

describe('formatRunState — defensive over absent / string / object', () => {
  it('placeholders when absent', () => {
    expect(formatRunState(undefined)).toBe('—');
    expect(formatRunState(null)).toBe('—');
  });

  it('renders a plain string state (DR-030 §5 idle|busy)', () => {
    expect(formatRunState('idle')).toBe('idle');
    expect(formatRunState('busy')).toBe('busy');
  });

  it('renders an object state as "busy 18m on turn 7"', () => {
    expect(formatRunState({ status: 'busy', turn_number: 7, elapsed_ms: 18 * 60 * 1000 })).toBe(
      'busy 18m on turn 7',
    );
  });

  it('renders partial object fields without crashing', () => {
    expect(formatRunState({ status: 'idle' })).toBe('idle');
    expect(formatRunState({})).toBe('—');
  });
});

describe('formatOtel — defensive over endpoint_reachable', () => {
  it('renders reachability when present', () => {
    expect(formatOtel({ endpoint_reachable: true })).toBe('reachable');
    expect(formatOtel({ endpoint_reachable: false })).toBe('unreachable ✗');
  });

  it('placeholders when absent / malformed', () => {
    expect(formatOtel(undefined)).toBe('—');
    expect(formatOtel({})).toBe('—');
    expect(formatOtel('online')).toBe('—');
  });
});

describe('gatherFleetStatus', () => {
  it('marks each peer online/offline from the injected probe', async () => {
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200) },
    ];
    const health = onlineHealth();
    const probe: FleetProbeFn = async (_host, port) => (port === 4100 ? health : null);

    const statuses = await gatherFleetStatus(peers, probe);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ name: 'CODE_AGENT', online: true, health });
    expect(statuses[1]).toMatchObject({ name: 'SCIENCE_AGENT', online: false, health: null });
  });

  it('degrades a peer whose probe REJECTS instead of aborting the join (#609)', async () => {
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200) },
      { name: 'DEVOPS_AGENT', info: info('100.64.0.3', 4300) },
    ];
    const health = onlineHealth();
    // The middle peer's probe REJECTS transiently (e.g. `fetch failed`); the
    // others resolve normally. The join must still resolve with all three.
    const probe: FleetProbeFn = async (_host, port) => {
      if (port === 4200) throw new Error('fetch failed');
      return port === 4100 ? health : null;
    };

    const statuses = await gatherFleetStatus(peers, probe);
    expect(statuses).toHaveLength(3);
    expect(statuses[0]).toMatchObject({ name: 'CODE_AGENT', online: true, health });
    // Rejected probe → that peer is marked offline, not propagated as a throw.
    expect(statuses[1]).toMatchObject({ name: 'SCIENCE_AGENT', online: false, health: null });
    expect(statuses[2]).toMatchObject({ name: 'DEVOPS_AGENT', online: false, health: null });
  });
});

describe('buildFleetRows / formatFleetTable', () => {
  const statuses: readonly FleetAgentStatus[] = [
    {
      name: 'CODE_AGENT',
      host: '127.0.0.1',
      port: 4100,
      online: true,
      health: onlineHealth({
        state: { status: 'busy', turn_number: 7, elapsed_ms: 18 * 60 * 1000 },
        otel: { endpoint_reachable: true },
        cert_expiry: isoInDays(5), // crit
      }),
    },
    {
      name: 'SCIENCE_AGENT',
      host: '100.64.0.2',
      port: 4200,
      online: false,
      health: null,
    },
  ];

  it('renders the online agent with all present self-report fields', () => {
    const rows = buildFleetRows(statuses, NOW);
    expect(rows[0]).toEqual([
      'CODE_AGENT',
      '127.0.0.1:4100',
      'online',
      '2h', // 7200s
      'busy 18m on turn 7',
      'reachable',
      'inst-aaaa',
      '5d ✗',
    ]);
  });

  it('renders the offline agent with placeholders + offline status', () => {
    const rows = buildFleetRows(statuses, NOW);
    expect(rows[1]).toEqual([
      'SCIENCE_AGENT',
      '100.64.0.2:4200',
      'offline',
      '—',
      '—',
      '—',
      '—',
      '—',
    ]);
  });

  it('produces an aligned table with a header + separator', () => {
    const out = formatFleetTable(statuses, NOW);
    const lines = out.split('\n');
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('CERT-EXPIRY');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(out).toContain('busy 18m on turn 7');
    expect(out).toContain('offline');
  });
});

describe('fleetStatusToJson', () => {
  it('carries the raw /health body (incl. state/otel) through untouched', () => {
    const health = onlineHealth({ state: 'busy', otel: { endpoint_reachable: false } });
    const json = fleetStatusToJson([
      { name: 'CODE_AGENT', host: '127.0.0.1', port: 4100, online: true, health },
      { name: 'SCIENCE_AGENT', host: '100.64.0.2', port: 4200, online: false, health: null },
    ]) as { agents: ReadonlyArray<Record<string, unknown>> };

    expect(json.agents).toHaveLength(2);
    expect(json.agents[0]).toMatchObject({ name: 'CODE_AGENT', status: 'online', health });
    expect((json.agents[0]!.health as Record<string, unknown>)['otel']).toEqual({
      endpoint_reachable: false,
    });
    expect(json.agents[1]).toMatchObject({ name: 'SCIENCE_AGENT', status: 'offline', health: null });
  });
});

describe('runFleetStatus (injected deps)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
  });

  const deps = (
    peers: readonly { name: string; info: AgentInfo }[],
    probe: FleetProbeFn,
  ): FleetStatusDeps => ({ project: 'macf', listPeers: async () => peers, probe });

  it('prints the table for a live + offline pair', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200) },
    ];
    const health = onlineHealth({ state: { status: 'busy', turn_number: 7, elapsed_ms: 18 * 60 * 1000 } });
    const probe: FleetProbeFn = async (_h, port) => (port === 4100 ? health : null);

    const code = await runFleetStatus('/unused', { now: NOW }, deps(peers, probe));
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('macf fleet — macf');
    expect(out).toContain('CODE_AGENT');
    expect(out).toContain('online');
    expect(out).toContain('busy 18m on turn 7');
    expect(out).toContain('SCIENCE_AGENT');
    expect(out).toContain('offline');
  });

  it('emits JSON under --json', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [{ name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }];
    const health = onlineHealth({ otel: { endpoint_reachable: true } });
    const probe: FleetProbeFn = async () => health;

    const code = await runFleetStatus('/unused', { json: true, now: NOW }, deps(peers, probe));
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].status).toBe('online');
    expect(parsed.agents[0].health.otel).toEqual({ endpoint_reachable: true });
  });

  it('renders the full roster + exits 0 when one peer probe rejects (#609)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200) },
    ];
    const health = onlineHealth();
    const probe: FleetProbeFn = async (_h, port) => {
      if (port === 4200) throw new Error('fetch failed'); // transient single-peer reject
      return health;
    };

    const code = await runFleetStatus('/unused', { now: NOW }, deps(peers, probe));
    expect(code).toBe(0); // command degrades, does not abort
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CODE_AGENT');
    expect(out).toContain('online');
    expect(out).toContain('SCIENCE_AGENT');
    expect(out).toContain('offline'); // the rejected peer renders as unreachable
  });

  it('reports an empty registry cleanly', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runFleetStatus('/unused', { now: NOW }, deps([], async () => null));
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/No agents registered/);
  });
});
