/**
 * In-memory challenge store for the /sign endpoint's challenge-response
 * protocol (DR-010).
 *
 * Each outstanding challenge keeps its agent_name, the expected value that
 * the client is supposed to write to the registry, and an expiry timestamp.
 * Expired entries are discarded lazily on each access (no background timer
 * — the server process footprint stays constant regardless of how many
 * abandoned flows accumulate).
 *
 * The store is process-local. If a cert-signing peer is replaced / restarted
 * between step 1 and step 2 of a flow, the in-memory entry is lost and the
 * client's step 2 fails — they must restart with a fresh step 1. This is
 * acceptable: the window is short (5 min default), and losing in-flight
 * state during a server restart is the standard trade-off for avoiding a
 * persistent database. See `design/decisions/DR-010-cert-signing.md`.
 */
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

/** Challenge state tracked by the server for each outstanding flow. */
export interface ChallengeRecord {
  readonly challengeId: string;
  readonly agentName: string;
  readonly expectedValue: string;
  readonly expiresAt: number;
}

/** Default TTL for a challenge (5 minutes). */
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Pluggable clock so tests can advance time deterministically. In
 * production this is just `Date.now`.
 */
export type Clock = () => number;

/**
 * Create a new challenge store. Return a minimal API surface — the store
 * is opaque to the caller except via these methods.
 */
export function createChallengeStore(options: {
  readonly ttlMs?: number;
  readonly clock?: Clock;
} = {}): {
  readonly issue: (agentName: string) => ChallengeRecord;
  readonly consume: (challengeId: string, agentName: string, observedValue: string) => 'ok' | 'mismatch';
  readonly size: () => number;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const now: Clock = options.clock ?? Date.now;
  const map = new Map<string, ChallengeRecord>();

  /** Drop expired entries. O(n); acceptable for our scale (outstanding flows dozen-ish at most). */
  function sweep(): void {
    const t = now();
    for (const [id, rec] of map) {
      if (rec.expiresAt <= t) map.delete(id);
    }
  }

  /** Issue a new challenge for `agentName`. */
  function issue(agentName: string): ChallengeRecord {
    sweep();
    const challengeId = randomUUID();
    // 32 bytes → base64url keeps the variable value printable + URL-safe
    // (GitHub variables accept any UTF-8 but keeping it ASCII avoids edge
    // cases around encoding). 43 chars after base64url with no padding.
    const expectedValue = randomBytes(32).toString('base64url');
    const rec: ChallengeRecord = {
      challengeId,
      agentName,
      expectedValue,
      expiresAt: now() + ttlMs,
    };
    map.set(challengeId, rec);
    return rec;
  }

  /**
   * Consume a challenge: match challenge_id + agent_name + timing-safe value
   * comparison. On both success AND mismatch, the in-memory entry is deleted
   * to prevent replay. The caller is responsible for deleting the registry
   * variable (so that the success-log-then-delete-variable sequence stays
   * atomic in the server; keeping that outside the store avoids passing the
   * GitHub client in here).
   *
   * Returns:
   *   'ok'        — challenge matched, entry deleted (caller should sign)
   *   'mismatch'  — anything wrong (not found / expired / wrong agent / wrong value)
   *                 — do NOT leak which; caller returns generic error
   */
  function consume(
    challengeId: string,
    agentName: string,
    observedValue: string,
  ): 'ok' | 'mismatch' {
    sweep();
    const rec = map.get(challengeId);
    if (!rec) return 'mismatch';
    // Always delete on any observation to block replay, even on mismatch.
    map.delete(challengeId);
    if (rec.agentName !== agentName) return 'mismatch';
    // timingSafeEqual requires equal-length buffers. Different-length
    // observed value is an obvious mismatch — short-circuit before the
    // crypto call so we don't throw on the length mismatch.
    const expected = Buffer.from(rec.expectedValue, 'utf-8');
    const observed = Buffer.from(observedValue, 'utf-8');
    if (expected.length !== observed.length) return 'mismatch';
    if (!timingSafeEqual(expected, observed)) return 'mismatch';
    return 'ok';
  }

  /** For tests + observability. */
  function size(): number {
    sweep();
    return map.size;
  }

  return { issue, consume, size };
}

export type ChallengeStore = ReturnType<typeof createChallengeStore>;
