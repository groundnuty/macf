/**
 * Tests for src/semver.ts — the shared `compareSemver` (moved here from
 * macf/src/cli/version-resolver.ts so the channel-server collision check
 * (groundnuty/macf#424) reuses one implementation).
 */
import { describe, it, expect } from 'vitest';
import { compareSemver } from '../src/semver.js';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.34', '0.2.20')).toBeGreaterThan(0);
    expect(compareSemver('0.2.20', '0.2.34')).toBeLessThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareSemver('0.2.34', '0.2.34')).toBe(0);
  });

  it('tolerates a leading v', () => {
    expect(compareSemver('v0.2.34', '0.2.34')).toBe(0);
    expect(compareSemver('v1.3.2', 'v1.3.1')).toBeGreaterThan(0);
  });

  it('treats an unparseable string as 0.0.0 (oldest) — the "missing = oldest" contract', () => {
    expect(compareSemver('not-a-version', '0.0.1')).toBeLessThan(0);
    expect(compareSemver('0.0.1', '')).toBeGreaterThan(0);
    expect(compareSemver('', 'garbage')).toBe(0); // both → 0.0.0
  });
});
