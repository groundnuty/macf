/**
 * Peer-liveness classification (macf#959 — "science died silently and all
 * five macf diagnostics failed to say so").
 *
 * WHY this module exists: the incident's actual shape was NOT "the agent is
 * dead" — science's tmux session (and the tmux-wake delivery fallback) was
 * alive the entire time; only its native `/health` channel was unreachable.
 * Every diagnostic that asked ONLY "does `/health` answer?" collapsed that
 * distinction into a flat "offline," which reads identically to genuinely
 * dead. This module adds a SECOND, INDEPENDENT signal — local tmux session
 * presence, plus a Pattern-C content-diff for a busy/idle detail
 * (silent-fallback-hazards.md Pattern C; macf#645 established that
 * `#{session_activity}` does NOT advance for an output-busy agent, so
 * alive-vs-dead must be read from `capture-pane` content, never from an
 * activity/staleness proxy) — so a native-down peer classifies as
 * `degraded` (alive, primary channel down) rather than being
 * indistinguishable from `dead` (no local session at all).
 *
 * Both signals are gathered FROM OUTSIDE the peer: the native probe is an
 * HTTP client dialing the peer's advertised port, and the tmux check reads
 * host-level state (`tmux has-session` / `capture-pane`) that exists
 * regardless of whether the process inside the pane is cooperating. Neither
 * depends on the dying agent doing anything — a truly dead process simply
 * produces no response / no session, and THAT absence is the observation.
 *
 * Honest-unknown floor (house standard — macf#1078, #1096, #1117): the tmux
 * check itself is tri-state. "This session does not exist" (absent) and
 * "I could not determine whether it exists" (unknown — no tmux server on
 * this host, `tmux` unavailable, a peer that runs on a different host
 * entirely) are DIFFERENT facts. Collapsing them would silently misreport an
 * out-of-scope peer (a different host) as `dead`, the same class of mistake
 * this rule exists to prevent.
 *
 * Scope (macf#959): same-host tmux introspection only. A peer running on a
 * DIFFERENT host from the one invoking this check has no local session to
 * find here — `probeLocalSession` reports that honestly as `unknown`, never
 * `dead`. Cross-host introspection (SSH / K8s) is DR-037 VM-driver
 * territory and is NOT built here — see the module's callers for the scope
 * note.
 */
import { execFileSync } from 'node:child_process';
import { fromVariableSegment } from '@groundnuty/macf-core';

/**
 * Whether a named tmux session exists, as OBSERVED from this host.
 * `'unknown'` is a DISTINCT verdict from `'absent'` — see the module doc.
 */
export type SessionExistence = 'present' | 'absent' | 'unknown';

/** Local tmux-session snapshot for a peer whose native `/health` is down. */
export interface LocalSessionSnapshot {
  readonly existence: SessionExistence;
  /**
   * Pattern-C content-diff over a short window; `null` when there is no
   * session to diff, or the pane was unreadable both times. Purely
   * informational here — UNLIKE `vm-driver.ts`'s `isBusy()` (which
   * conservatively defaults an unreadable pane to `busy: true` because its
   * caller, fleet-resume, must never act on an agent it cannot inspect),
   * this module never acts, only reports, so an unreadable pane is left
   * honestly `null` rather than guessed.
   */
  readonly busy: boolean | null;
}

/**
 * Four-state peer-liveness verdict, combining the native `/health` probe
 * with the local tmux check:
 *
 *   'online'   — native `/health` answered. Authoritative; the tmux check
 *                is skipped (nothing to add — already proven alive).
 *   'degraded' — native down, but a local tmux session for this peer
 *                exists (busy or idle both count as alive). This is
 *                macf#959's actual incident shape.
 *   'dead'     — native down AND the local tmux session is confirmed
 *                absent.
 *   'unknown'  — native down and local visibility could not be
 *                established (seam not wired, or genuinely indeterminate).
 *                NEVER collapsed into 'dead' or 'online' — the
 *                honest-unknown floor.
 */
export type PeerLiveness = 'online' | 'degraded' | 'dead' | 'unknown';

/**
 * Classify a peer's liveness from two INDEPENDENT, externally-observed
 * signals. Pure — no I/O, fully unit-testable.
 */
export function classifyPeerLiveness(
  online: boolean,
  session: LocalSessionSnapshot | null,
): PeerLiveness {
  if (online) return 'online';
  if (session === null || session.existence === 'unknown') return 'unknown';
  return session.existence === 'present' ? 'degraded' : 'dead';
}

/** The host-level tmux primitives this module needs — injectable for tests. */
export interface LocalSessionSeams {
  readonly hasSession: (session: string) => SessionExistence;
  readonly capturePane: (session: string) => string | null;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Pattern-C content-diff window (silent-fallback-hazards.md Pattern C). */
export const DEFAULT_LIVENESS_WINDOW_MS = 2000;

/**
 * Probe ONE peer's local tmux session. `existence` alone already answers
 * dead-vs-alive; the content-diff over `windowMs` is purely an ADDITIONAL
 * busy/idle detail on an already-`present` session — never used to demote a
 * live session toward `dead`. Demoting on staleness would reintroduce the
 * exact macf#645 hazard this module exists to avoid: a streaming/busy agent
 * must never misclassify as not-alive because its pane "looks" unchanged at
 * the wrong instant.
 */
export async function probeLocalSession(
  session: string,
  seams: LocalSessionSeams,
  windowMs: number = DEFAULT_LIVENESS_WINDOW_MS,
): Promise<LocalSessionSnapshot> {
  const existence = seams.hasSession(session);
  if (existence !== 'present') return { existence, busy: null };
  const before = seams.capturePane(session);
  await seams.sleep(windowMs);
  const after = seams.capturePane(session);
  if (before === null || after === null) return { existence, busy: null };
  return { existence, busy: before !== after };
}

/**
 * Derive a peer's canonical tmux session name — `<project>@<routing-label>`
 * (coordination.md "Canonical tmux launch pattern"; the session keys on
 * `routing_label`, NOT the registry's SCREAMING_SNAKE key). `peerName` is
 * the raw registry entry name (e.g. `SCIENCE_AGENT`); `fromVariableSegment`
 * recovers the kebab routing label the session was actually launched under.
 */
export function peerSessionName(project: string, peerName: string): string {
  return `${project}@${fromVariableSegment(peerName)}`;
}

/**
 * Read `tmux`'s stderr off a failed `execFileSync` call, if any was
 * captured. `execFileSync` attaches `.stderr` to the thrown error when the
 * child's stderr was piped (see `createLocalSessionSeams` below).
 */
function stderrOf(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const raw = (err as { stderr?: Buffer | string }).stderr;
    return raw ? raw.toString() : '';
  }
  return '';
}

/**
 * Real host seams — `tmux has-session` / `capture-pane`, fail-safe (never
 * throw). `hasSession` distinguishes tmux's two distinct failure shapes by
 * reading stderr: "can't find session" is a confirmed `'absent'`; anything
 * else (no server running on this host, `tmux` missing, a permission
 * error) is honestly `'unknown'` — this host may simply not be where the
 * peer runs (macf#959's cross-host scope note).
 */
export function createLocalSessionSeams(): LocalSessionSeams {
  return {
    hasSession: (session: string): SessionExistence => {
      try {
        execFileSync('tmux', ['has-session', '-t', session], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        return 'present';
      } catch (err) {
        return /can't find session/i.test(stderrOf(err)) ? 'absent' : 'unknown';
      }
    },
    capturePane: (session: string): string | null => {
      try {
        return execFileSync('tmux', ['capture-pane', '-t', session, '-p'], {
          encoding: 'utf-8',
        });
      } catch {
        return null;
      }
    },
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
