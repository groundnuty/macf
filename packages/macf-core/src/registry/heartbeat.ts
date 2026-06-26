import type { AgentInfo } from './types.js';

/**
 * Registry heartbeat + TTL staleness (DR-031, groundnuty/macf#568).
 *
 * The live instance periodically re-stamps `last_heartbeat` on its registry slot
 * (`Registry.heartbeatConditional`); a reader uses `isStaleEntry` to treat an
 * entry whose heartbeat aged past a TTL as dead. This PAIRS with the graceful-
 * deregister (#586): graceful-deregister covers the CLEAN-exit stale-entry case
 * (the shutdown handler deletes the slot); the TTL backstops the UNGRACEFUL death
 * (kill -9 / OOM / power loss) that never runs the shutdown handler. Together they
 * close the stale-registration class.
 */

/**
 * Default registry-heartbeat re-stamp cadence: 5 minutes.
 *
 * COARSE BY DESIGN. Each beat is a WRITE to GitHub Actions Variables per agent →
 * it consumes the App-token write budget AND interacts with the #439 If-Match
 * TOCTOU surface. Do NOT make it frequent. Operators can override (or disable
 * with `0`) via `MACF_REGISTRY_HEARTBEAT_INTERVAL_MS`.
 */
export const DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 300_000

/**
 * Default staleness TTL: 3× the heartbeat interval (15 minutes).
 *
 * The 3× multiple gives one missed beat (e.g. a transient registry-write failure
 * that the next interval recovers from) slack so a healthy-but-briefly-unlucky
 * instance isn't flapped to "stale". An entry is only judged stale once it has
 * gone substantially past the cadence without a successful re-stamp.
 */
export const DEFAULT_REGISTRY_TTL_MS = 3 * DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS; // 900_000

/**
 * Decide whether a registry entry is STALE — i.e. its live instance very likely
 * died ungracefully without clearing the slot (DR-031, groundnuty/macf#568).
 *
 * Returns `true` ONLY when `entry.last_heartbeat` is PRESENT and has aged past
 * `ttlMs` (`now - parse(last_heartbeat) > ttlMs`). Critically BACK-COMPAT:
 *
 *  - ABSENT `last_heartbeat` → `false` (UNKNOWN, never dead). Older entries and
 *    pre-DR-031 channel-server versions that never heartbeat must NOT be falsely
 *    reclaimed. (The next launch's #424 collision check — a live `/health` probe —
 *    reclaims a genuinely-dead no-heartbeat slot regardless; the TTL is a reader-
 *    side backstop, not the only mechanism.)
 *  - UNPARSEABLE `last_heartbeat` → `false`. If we can't compute an age we don't
 *    assert staleness (fail toward "alive", never a false "dead").
 *
 * Pure + injectable `now` (epoch ms) for deterministic testing.
 */
export function isStaleEntry(entry: AgentInfo, ttlMs: number, now: number): boolean {
  const hb = entry.last_heartbeat;
  if (hb === undefined) return false; // absent → unknown, NEVER dead (back-compat)
  const beatMs = Date.parse(hb);
  if (Number.isNaN(beatMs)) return false; // unparseable → can't assert staleness
  return now - beatMs > ttlMs;
}
