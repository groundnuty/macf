/**
 * Tests for the cross-fleet GUEST block (DR-036 Amendment A, groundnuty/macf#679).
 *
 * Offline + deterministic: the registry resolve + the mTLS `/health` probe are
 * both injected (no network / no fs). The load-bearing cases:
 *   - a `route` guest that resolves + answers `/health` → online + live state;
 *   - a `route` guest that resolves but is unreachable → offline (down is OK for
 *     a routable guest);
 *   - a `route` guest NOT in the registry → unresolved;
 *   - an `operator-relay` (path-c) guest → `local-mode`, NEVER "down", even when
 *     the registry has no slot AND no probe is ever issued;
 *   - the `--json` shape carries `supervised: false` on every guest (the explicit
 *     no-supervision invariant).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, GuestBinding, HealthResponse } from '@groundnuty/macf-core';
import {
  buildGuestRows,
  formatGuestBlock,
  formatGuestHeartbeat,
  formatGuestReachability,
  gatherGuestStatuses,
  guestStatusesToJson,
  loadGuestBindings,
  loadFederatedCas,
  resolveGuestStatus,
  type GuestProbeFn,
  type GuestResolveFn,
  type GuestStatus,
} from '../../src/cli/commands/fleet-guests.js';

const NOW = Date.parse('2026-06-30T12:00:00Z');
const isoInMs = (ms: number): string => new Date(NOW + ms).toISOString();

function info(host: string, port: number, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    host,
    port,
    type: 'permanent',
    instance_id: `${host}-${port}`,
    started: isoInMs(-3_600_000),
    ...extra,
  };
}

function health(): HealthResponse {
  return {
    agent: 'code-agent',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 1200,
    current_issue: null,
    version: '0.2.41',
    last_notification: null,
    instance_id: 'inst-guest',
    cert_expiry: isoInMs(90 * 86_400_000),
  } as HealthResponse;
}

const routeGuest: GuestBinding = {
  agent: 'ppam-2026/code-agent',
  local_role: 'onedata-specialist',
  purpose: 'data-access dependency (onedata-mcp)',
  delegate_via: 'route',
  until: null,
};
const relayGuest: GuestBinding = {
  agent: 'ppam-2026/code-agent',
  local_role: 'onedata-specialist',
  purpose: 'data-access dependency (onedata-mcp)',
  delegate_via: 'operator-relay',
  until: null,
};

describe('resolveGuestStatus — path-aware reachability', () => {
  it('route guest: resolved + /health answers → online with live health', async () => {
    const resolve: GuestResolveFn = async () => info('100.64.0.9', 4900);
    const probe: GuestProbeFn = async () => health();
    const s = await resolveGuestStatus(routeGuest, resolve, probe);
    expect(s.reachability).toBe('online');
    expect(s.health).not.toBeNull();
    expect(s.info?.host).toBe('100.64.0.9');
  });

  it('route guest: resolved but /health silent → offline', async () => {
    const resolve: GuestResolveFn = async () => info('100.64.0.9', 4900);
    const probe: GuestProbeFn = async () => null;
    const s = await resolveGuestStatus(routeGuest, resolve, probe);
    expect(s.reachability).toBe('offline');
    expect(s.health).toBeNull();
  });

  it('route guest: not in the registry → unresolved (no probe needed)', async () => {
    const resolve: GuestResolveFn = async () => null;
    const probe = vi.fn<GuestProbeFn>(async () => health());
    const s = await resolveGuestStatus(routeGuest, resolve, probe);
    expect(s.reachability).toBe('unresolved');
    expect(probe).not.toHaveBeenCalled();
  });

  it('operator-relay guest: NEVER probed, NEVER "down" — even resolved', async () => {
    const resolve: GuestResolveFn = async () => info('127.0.0.1', 5000, { last_heartbeat: isoInMs(-1000) });
    const probe = vi.fn<GuestProbeFn>(async () => null);
    const s = await resolveGuestStatus(relayGuest, resolve, probe);
    expect(s.reachability).toBe('local-mode');
    expect(probe).not.toHaveBeenCalled(); // the (c) invariant: no cross-fleet probe
    expect(s.info?.instance_id).toBe('127.0.0.1-5000'); // registry-derived state IS shown
  });

  it('operator-relay guest: unresolved registry slot still renders local-mode, never down', async () => {
    const resolve: GuestResolveFn = async () => null;
    const probe = vi.fn<GuestProbeFn>(async () => null);
    const s = await resolveGuestStatus(relayGuest, resolve, probe);
    expect(s.reachability).toBe('local-mode');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('gatherGuestStatuses — per-guest isolation', () => {
  it('a rejected resolve degrades only that guest, never aborts the block', async () => {
    const bindings = [routeGuest, { ...routeGuest, agent: 'other-fleet/sci-agent' }];
    const resolve: GuestResolveFn = async (home) => {
      if (home === 'ppam-2026') throw new Error('registry blip');
      return info('100.64.0.2', 4200);
    };
    const probe: GuestProbeFn = async () => health();
    const out = await gatherGuestStatuses(bindings, resolve, probe);
    expect(out).toHaveLength(2);
    expect(out[0]!.reachability).toBe('unresolved'); // resolve threw → treated as null
    expect(out[1]!.reachability).toBe('online');
  });
});

describe('formatGuestReachability — the never-down local-mode label', () => {
  it('renders each verdict', () => {
    expect(formatGuestReachability('online')).toBe('online');
    expect(formatGuestReachability('offline')).toBe('offline');
    expect(formatGuestReachability('unresolved')).toMatch(/not in shared registry/);
    expect(formatGuestReachability('local-mode')).toBe('local-mode — home-fleet-observable only');
  });
});

describe('formatGuestHeartbeat — registry-derived freshness', () => {
  it('fresh within TTL, stale past it, — when absent/unresolved', () => {
    expect(formatGuestHeartbeat(info('h', 1, { last_heartbeat: isoInMs(-1000) }), NOW)).toBe('fresh');
    expect(formatGuestHeartbeat(info('h', 1, { last_heartbeat: isoInMs(-3_600_000) }), NOW)).toBe(
      'stale ⚠',
    );
    expect(formatGuestHeartbeat(info('h', 1), NOW)).toBe('—'); // no heartbeat → unknown, not dead
    expect(formatGuestHeartbeat(null, NOW)).toBe('—');
  });
});

describe('buildGuestRows / formatGuestBlock', () => {
  const statuses: readonly GuestStatus[] = [
    {
      binding: routeGuest,
      homeProject: 'ppam-2026',
      name: 'code-agent',
      info: info('100.64.0.9', 4900, { last_heartbeat: isoInMs(-1000) }),
      reachability: 'online',
      health: health(),
    },
    {
      binding: relayGuest,
      homeProject: 'ppam-2026',
      name: 'code-agent',
      info: null,
      reachability: 'local-mode',
      health: null,
    },
  ];

  it('renders the route guest row', () => {
    const rows = buildGuestRows(statuses, NOW);
    expect(rows[0]).toEqual([
      'ppam-2026/code-agent',
      'onedata-specialist',
      'route',
      '100.64.0.9:4900',
      'online',
      '100.64.0.9-4900',
      'fresh',
    ]);
  });

  it('renders the local-mode guest with placeholders + never "down"', () => {
    const rows = buildGuestRows(statuses, NOW);
    expect(rows[1]).toEqual([
      'ppam-2026/code-agent',
      'onedata-specialist',
      'operator-relay',
      '—',
      'local-mode — home-fleet-observable only',
      '—',
      '—',
    ]);
  });

  it('block carries the GUEST header + the unsupervised legend', () => {
    const block = formatGuestBlock(statuses, NOW);
    expect(block).toContain('GUEST / external collaborators');
    expect(block).toContain('does NOT supervise');
    expect(block).toContain('NEVER apply');
    expect(formatGuestBlock([], NOW)).toBe(''); // nothing prints with no guests
  });
});

describe('guestStatusesToJson — supervised:false invariant', () => {
  it('every guest carries supervised:false + the raw health passthrough', () => {
    const statuses: readonly GuestStatus[] = [
      {
        binding: routeGuest,
        homeProject: 'ppam-2026',
        name: 'code-agent',
        info: info('100.64.0.9', 4900),
        reachability: 'online',
        health: health(),
      },
      {
        binding: relayGuest,
        homeProject: 'ppam-2026',
        name: 'code-agent',
        info: null,
        reachability: 'local-mode',
        health: null,
      },
    ];
    const json = guestStatusesToJson(statuses) as ReadonlyArray<Record<string, unknown>>;
    expect(json).toHaveLength(2);
    expect(json.every((g) => g['supervised'] === false)).toBe(true);
    expect(json[0]!['reachability']).toBe('online');
    expect(json[0]!['delegate_via']).toBe('route');
    expect(json[1]!['reachability']).toBe('local-mode');
    expect(json[1]!['host']).toBeNull();
  });
});

describe('loadGuestBindings — fs loader + degradation', () => {
  function withTmpFleet(content: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-guest-'));
    if (content !== null) {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), content);
    }
    return dir;
  }

  it('returns [] when the file is absent', () => {
    const dir = withTmpFleet(null);
    try {
      expect(loadGuestBindings(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads guests from a valid file', () => {
    const dir = withTmpFleet(JSON.stringify({ routing_fleet: false, guests: [routeGuest] }));
    try {
      const guests = loadGuestBindings(dir);
      expect(guests).toHaveLength(1);
      expect(guests[0]!.agent).toBe('ppam-2026/code-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (loud) on malformed JSON', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = withTmpFleet('{ not json');
    try {
      expect(loadGuestBindings(dir)).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (loud) on a schema-invalid guest', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = withTmpFleet(JSON.stringify({ guests: [{ ...routeGuest, agent: 'bad' }] }));
    try {
      expect(loadGuestBindings(dir)).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// DR-041 Amendment A (groundnuty/macf#786): `loadFederatedCas` reads the SAME
// `.github/macf-fleet.json` file `loadGuestBindings` does (different field) —
// gates `macf-ping`'s cross-fleet guest addressing.
describe('loadFederatedCas — fs loader + degradation (macf#786)', () => {
  function withTmpFleet(content: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-federated-cas-'));
    if (content !== null) {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), content);
    }
    return dir;
  }

  it('returns [] when the file is absent', () => {
    const dir = withTmpFleet(null);
    try {
      expect(loadFederatedCas(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads federated_cas from a valid file', () => {
    const dir = withTmpFleet(JSON.stringify({ federated_cas: ['ppam-2026', 'icsoc-2026'] }));
    try {
      expect(loadFederatedCas(dir)).toEqual(['ppam-2026', 'icsoc-2026']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when federated_cas is absent from an otherwise-valid file', () => {
    const dir = withTmpFleet(JSON.stringify({ guests: [routeGuest] }));
    try {
      expect(loadFederatedCas(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (loud) on malformed JSON', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = withTmpFleet('{ not json');
    try {
      expect(loadFederatedCas(dir)).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (loud) on a schema-invalid federated_cas entry', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = withTmpFleet(JSON.stringify({ federated_cas: [123] }));
    try {
      expect(loadFederatedCas(dir)).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guests + federated_cas coexist — loading one does not disturb the other', () => {
    const dir = withTmpFleet(JSON.stringify({ guests: [routeGuest], federated_cas: ['ppam-2026'] }));
    try {
      expect(loadGuestBindings(dir)).toHaveLength(1);
      expect(loadFederatedCas(dir)).toEqual(['ppam-2026']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
