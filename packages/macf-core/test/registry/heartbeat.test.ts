/**
 * TTL staleness helper + constants — DR-031, groundnuty/macf#568.
 *
 * `isStaleEntry` is the READER side of the registry heartbeat: an entry whose
 * `last_heartbeat` aged past the TTL is treated as dead (its live instance very
 * likely died ungracefully without clearing the slot). The load-bearing BACK-
 * COMPAT contract: an ABSENT `last_heartbeat` is NEVER stale (unknown, not dead),
 * so older entries + pre-DR-031 channel-server versions are never falsely
 * reclaimed.
 */
import { describe, it, expect } from 'vitest';
import {
  isStaleEntry,
  DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_REGISTRY_TTL_MS,
} from '../../src/registry/heartbeat.js';
import type { AgentInfo } from '../../src/registry/types.js';

const BASE: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'aaaaaa',
  started: '2026-06-05T10:00:00Z',
};

/** `BASE` plus an explicit `last_heartbeat` stamp. */
function withBeat(last_heartbeat: string): AgentInfo {
  return { ...BASE, last_heartbeat };
}

const NOW = Date.parse('2026-06-26T12:00:00.000Z');
const TTL = 900_000; // 15 min

describe('isStaleEntry', () => {
  it('present + aged past the TTL → true (stale)', () => {
    // 20 min ago, TTL 15 min → stale.
    const entry = withBeat(new Date(NOW - 20 * 60 * 1000).toISOString());
    expect(isStaleEntry(entry, TTL, NOW)).toBe(true);
  });

  it('present + fresh (within the TTL) → false', () => {
    // 5 min ago, TTL 15 min → fresh.
    const entry = withBeat(new Date(NOW - 5 * 60 * 1000).toISOString());
    expect(isStaleEntry(entry, TTL, NOW)).toBe(false);
  });

  it('ABSENT last_heartbeat → false (unknown, NEVER dead) — the back-compat case', () => {
    // BASE has no last_heartbeat — an older entry / pre-DR-031 cs version. It must
    // NOT be judged stale regardless of how large the TTL window is.
    expect(isStaleEntry(BASE, TTL, NOW)).toBe(false);
    expect(isStaleEntry(BASE, 0, NOW)).toBe(false);
  });

  it('unparseable last_heartbeat → false (can not assert staleness)', () => {
    expect(isStaleEntry(withBeat('not-a-date'), TTL, NOW)).toBe(false);
  });

  it('boundary: exactly ttlMs old → false (strict >)', () => {
    // age === ttlMs is NOT > ttlMs, so not yet stale.
    const entry = withBeat(new Date(NOW - TTL).toISOString());
    expect(isStaleEntry(entry, TTL, NOW)).toBe(false);
  });

  it('boundary: one ms past ttlMs → true', () => {
    const entry = withBeat(new Date(NOW - TTL - 1).toISOString());
    expect(isStaleEntry(entry, TTL, NOW)).toBe(true);
  });
});

describe('heartbeat constants', () => {
  it('default heartbeat interval is a coarse 5 minutes', () => {
    expect(DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('default TTL is 3× the interval (one missed beat does not flap)', () => {
    expect(DEFAULT_REGISTRY_TTL_MS).toBe(3 * DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS);
    expect(DEFAULT_REGISTRY_TTL_MS).toBe(15 * 60 * 1000);
  });
});
