/**
 * Tests for declared `network.advertise_host` vs. registered `host`
 * comparison (groundnuty/macf#1203).
 */
import { describe, it, expect } from 'vitest';
import {
  advertiseHostDriftEntryToJson,
  detectAdvertiseHostDrift,
  detectAdvertiseHostDriftForAgent,
  formatAdvertiseHostDriftLines,
  hasAdvertiseHostMismatch,
} from '../../../src/cli/bootstrap/advertise-host-drift.js';
import type { AgentRegistryObservation } from '../../../src/cli/bootstrap/observer.js';

const AGENT_INFO = {
  host: '100.64.0.1',
  port: 8443,
  type: 'permanent' as const,
  instance_id: 'sci-instance-1',
  started: '2026-08-10T00:00:00.000Z',
};

describe('detectAdvertiseHostDriftForAgent — decisive pair (assert-the-wrong-path.md two triggers)', () => {
  it('DECISIVE 1 — declared host !== registered host -> reported as a mismatch', () => {
    const registry: AgentRegistryObservation = { status: 'confirmed', presence: 'present', info: AGENT_INFO };
    const entry = detectAdvertiseHostDriftForAgent('science-agent', 'other-host.ts.net', registry);
    expect(entry.status).toBe('mismatch');
    expect(entry.declaredHost).toBe('other-host.ts.net');
    expect(entry.registeredHost).toBe('100.64.0.1');
    expect(entry.reason).toContain('100.64.0.1');
    expect(entry.reason).toContain('other-host.ts.net');
  });

  it('DECISIVE 2 — declared host === registered host -> NOT reported as a mismatch (proves the checker is not "always mismatch")', () => {
    const registry: AgentRegistryObservation = { status: 'confirmed', presence: 'present', info: AGENT_INFO };
    const entry = detectAdvertiseHostDriftForAgent('science-agent', '100.64.0.1', registry);
    expect(entry.status).toBe('match');
    expect(entry.status).not.toBe('mismatch');
    expect(entry.registeredHost).toBe('100.64.0.1');
    expect(entry.reason).toBeUndefined();
  });
});

describe('detectAdvertiseHostDriftForAgent — honest-unknown floor', () => {
  it('never-registered (confirmed absent) -> unknown, NEVER mismatch — the false-positive that would get the check ignored', () => {
    const registry: AgentRegistryObservation = { status: 'confirmed', presence: 'absent' };
    const entry = detectAdvertiseHostDriftForAgent('code-agent', 'example.ts.net', registry);
    expect(entry.status).toBe('unknown');
    expect(entry.status).not.toBe('mismatch');
    expect(entry.registeredHost).toBeUndefined();
    expect(entry.reason).toBeDefined();
  });

  it('registry read itself failed (status: unknown) -> unknown, NEVER mismatch', () => {
    const registry: AgentRegistryObservation = { status: 'unknown', reason: 'registry variable could not be read (network/auth/gh failure)' };
    const entry = detectAdvertiseHostDriftForAgent('code-agent', 'example.ts.net', registry);
    expect(entry.status).toBe('unknown');
    expect(entry.reason).toBe('registry variable could not be read (network/auth/gh failure)');
  });

  it('a fleet provisioned but not yet deployed (every agent absent) reports zero mismatches — hasAdvertiseHostMismatch is false', () => {
    const entries = detectAdvertiseHostDrift(
      'example.ts.net',
      {
        'science-agent': { status: 'confirmed', presence: 'absent' },
        'code-agent': { status: 'confirmed', presence: 'absent' },
      },
      ['science-agent', 'code-agent'],
    );
    expect(entries.every((e) => e.status === 'unknown')).toBe(true);
    expect(hasAdvertiseHostMismatch(entries)).toBe(false);
  });
});

describe('detectAdvertiseHostDriftForAgent — port ruling: HOST ONLY, port is never compared', () => {
  it('same host, DIFFERENT port -> still match (port is not part of the comparison)', () => {
    const registry: AgentRegistryObservation = { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, port: 9999 } };
    const entry = detectAdvertiseHostDriftForAgent('science-agent', '100.64.0.1', registry);
    expect(entry.status).toBe('match');
  });

  it('two agents on the SAME declared host but different live ports both match — a port is assigned at launch and may legitimately differ run to run', () => {
    const entries = detectAdvertiseHostDrift(
      '100.64.0.1',
      {
        'science-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, port: 8443, instance_id: 'sci-1' } },
        'code-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, port: 51222, instance_id: 'code-1' } },
      },
      ['science-agent', 'code-agent'],
    );
    expect(entries.every((e) => e.status === 'match')).toBe(true);
  });
});

describe('detectAdvertiseHostDrift — fleet-level, one entry per role, honest-unknown for an unqueried role', () => {
  it('a role missing from the registry map degrades to unknown, "registry not queried this run" — same fallback status.ts uses', () => {
    const entries = detectAdvertiseHostDrift('example.ts.net', {}, ['science-agent']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('unknown');
    expect(entries[0]?.reason).toBe('registry not queried this run');
  });

  it('a mixed fleet reports per-agent, never collapsing to one opaque fleet-wide verdict', () => {
    const entries = detectAdvertiseHostDrift(
      'example.ts.net',
      {
        'science-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, host: 'example.ts.net' } },
        'code-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, host: 'wrong-host.ts.net' } },
      },
      ['science-agent', 'code-agent'],
    );
    const sci = entries.find((e) => e.role === 'science-agent');
    const code = entries.find((e) => e.role === 'code-agent');
    expect(sci?.status).toBe('match');
    expect(code?.status).toBe('mismatch');
    expect(hasAdvertiseHostMismatch(entries)).toBe(true);
  });
});

describe('formatAdvertiseHostDriftLines', () => {
  it('renders the declared host once + a line per agent, and never cites an internal issue/DR reference (no-internal-citations guard)', () => {
    const entries = detectAdvertiseHostDrift(
      'example.ts.net',
      {
        'science-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, host: 'example.ts.net' } },
        'code-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO, host: 'wrong-host.ts.net' } },
        'writing-agent': { status: 'confirmed', presence: 'absent' },
      },
      ['science-agent', 'code-agent', 'writing-agent'],
    );
    const lines = formatAdvertiseHostDriftLines(entries);
    const text = lines.join('\n');
    expect(text).toContain('example.ts.net');
    expect(text).toContain('science-agent');
    expect(text).toContain('MISMATCH');
    expect(text).toContain('wrong-host.ts.net');
    expect(text).toContain('writing-agent');
    expect(text).not.toMatch(/\bmacf#\d+\b|\bDR-0\d{2}\b/);
  });

  it('empty entry list renders nothing', () => {
    expect(formatAdvertiseHostDriftLines([])).toEqual([]);
  });
});

describe('advertiseHostDriftEntryToJson — snake_case field names, matches this CLI convention', () => {
  it('carries role/declared_host/status/registered_host/reason', () => {
    const entry = detectAdvertiseHostDriftForAgent('science-agent', 'declared.example', {
      status: 'confirmed',
      presence: 'present',
      info: { ...AGENT_INFO, host: 'other.example' },
    });
    const json = advertiseHostDriftEntryToJson(entry) as Record<string, unknown>;
    expect(json['role']).toBe('science-agent');
    expect(json['declared_host']).toBe('declared.example');
    expect(json['status']).toBe('mismatch');
    expect(json['registered_host']).toBe('other.example');
    expect(typeof json['reason']).toBe('string');
  });

  it('carries unknown_kind, distinguishing read-failed from never-registered', () => {
    const readFailed = detectAdvertiseHostDriftForAgent('science-agent', 'declared.example', {
      status: 'unknown',
      reason: 'registry variable could not be read (network/auth/gh failure)',
    });
    expect((advertiseHostDriftEntryToJson(readFailed) as Record<string, unknown>)['unknown_kind']).toBe('read-failed');

    const neverRegistered = detectAdvertiseHostDriftForAgent('science-agent', 'declared.example', {
      status: 'confirmed',
      presence: 'absent',
    });
    expect((advertiseHostDriftEntryToJson(neverRegistered) as Record<string, unknown>)['unknown_kind']).toBe('never-registered');
  });
});
