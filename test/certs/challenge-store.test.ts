/**
 * Tests for the in-memory challenge store (#80).
 *
 * The store is the security-critical primitive — mismatches in expected vs
 * observed values MUST be rejected, replays MUST be blocked, and the
 * timing-safe comparison MUST NOT short-circuit on partial matches.
 */
import { describe, it, expect } from 'vitest';
import { createChallengeStore, DEFAULT_CHALLENGE_TTL_MS } from '../../src/certs/challenge-store.js';

describe('createChallengeStore', () => {
  it('issues unique challenge_ids', () => {
    const store = createChallengeStore();
    const a = store.issue('code-agent');
    const b = store.issue('code-agent');
    expect(a.challengeId).not.toBe(b.challengeId);
    expect(a.expectedValue).not.toBe(b.expectedValue);
  });

  it('issues UUIDs as challenge_ids', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(r.challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('expectedValue is base64url, printable, >= 32 bytes entropy', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    // 32 random bytes → base64url is 43 chars with no padding.
    expect(r.expectedValue).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r.expectedValue.length).toBeGreaterThanOrEqual(40);
  });

  it('records the agent_name', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(r.agentName).toBe('code-agent');
  });

  it('consume returns "ok" on exact match', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('ok');
  });

  it('consume returns "mismatch" on wrong value', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(store.consume(r.challengeId, 'code-agent', 'wrong')).toBe('mismatch');
  });

  it('consume returns "mismatch" on wrong agent_name', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(store.consume(r.challengeId, 'science-agent', r.expectedValue)).toBe('mismatch');
  });

  it('consume returns "mismatch" on unknown challenge_id', () => {
    const store = createChallengeStore();
    expect(store.consume('00000000-0000-4000-8000-000000000000', 'code-agent', 'whatever'))
      .toBe('mismatch');
  });

  it('deletes the entry on successful consume (prevents replay)', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(store.size()).toBe(1);
    expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('ok');
    expect(store.size()).toBe(0);
    // Second consume with the same id must fail.
    expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('mismatch');
  });

  it('deletes the entry on mismatch consume too (prevents retry)', () => {
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    store.consume(r.challengeId, 'code-agent', 'wrong');
    expect(store.size()).toBe(0);
    // Even with the correct value, the second attempt fails.
    expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('mismatch');
  });

  it('handles length-mismatched observed value without crashing', () => {
    // timingSafeEqual throws on different-length buffers; the store must
    // short-circuit before that point.
    const store = createChallengeStore();
    const r = store.issue('code-agent');
    expect(() => store.consume(r.challengeId, 'code-agent', 'short'))
      .not.toThrow();
    // Also verify it returns mismatch cleanly.
    const r2 = store.issue('code-agent');
    expect(store.consume(r2.challengeId, 'code-agent', 'x')).toBe('mismatch');
  });

  describe('TTL and expiry', () => {
    it('respects the default TTL (5 minutes)', () => {
      let now = 1_000_000;
      const store = createChallengeStore({ clock: () => now });
      const r = store.issue('code-agent');

      // At T+TTL-1, entry should still be valid.
      now += DEFAULT_CHALLENGE_TTL_MS - 1;
      expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('ok');
    });

    it('rejects after TTL expires', () => {
      let now = 1_000_000;
      const store = createChallengeStore({ clock: () => now });
      const r = store.issue('code-agent');

      // At T+TTL+1, entry should be swept.
      now += DEFAULT_CHALLENGE_TTL_MS + 1;
      expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('mismatch');
    });

    it('custom TTL applies', () => {
      let now = 1_000_000;
      const store = createChallengeStore({ ttlMs: 1000, clock: () => now });
      const r = store.issue('code-agent');
      now += 1001;
      expect(store.consume(r.challengeId, 'code-agent', r.expectedValue)).toBe('mismatch');
    });

    it('size() reflects lazy sweep', () => {
      let now = 1_000_000;
      const store = createChallengeStore({ ttlMs: 1000, clock: () => now });
      store.issue('code-agent');
      store.issue('science-agent');
      expect(store.size()).toBe(2);
      now += 1001;
      expect(store.size()).toBe(0); // both swept
    });
  });
});
