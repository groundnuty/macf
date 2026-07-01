/**
 * `verifyGreen` — the shared post-restart health-and-version gate (DR-037
 * Decision 5). Both the rolling-upgrade sequencer and the reconcile loop need it:
 * after a `driver.restart(agent)`, confirm the agent came back REACHABLE at the
 * TARGET version before proceeding to the next agent (upgrade) or clearing the
 * heal (reconcile).
 *
 * Pure + runtime-agnostic (macf-core, DR-037 OQ2). It takes an injectable
 * "re-resolve + probe" callback and polls-with-timeout. The **re-resolve is the
 * caller's job, inside `probe`** — `restart-self` relaunches with a NEW port +
 * instance_id (DR-037 Decision 5), so a correct `probe(agent)` MUST re-read the
 * registry for the FRESH endpoint on each call and never reuse the dead
 * pre-restart `host:port` (a silent-fallback trap: a stale endpoint returns
 * `null` forever → a false "not-green"). `verifyGreen` itself only polls that
 * callback + applies the version check via macf-core's `compareSemver`.
 */
import { compareSemver } from './semver.js';
import type { HealthResponse } from './types.js';

/** Default poll interval between `probe` attempts (ms). */
export const DEFAULT_VERIFY_GREEN_INTERVAL_MS = 2000;

/** Inputs to `verifyGreen`. */
export interface VerifyGreenOptions {
  /** The agent (routing label) to verify — passed straight to `probe`. */
  readonly agent: string;
  /** The version the agent must self-report to be considered green. */
  readonly targetVersion: string;
  /** Total wall-time budget before giving up (ms). */
  readonly timeoutMs: number;
  /** Poll interval between attempts (ms; default `DEFAULT_VERIFY_GREEN_INTERVAL_MS`). */
  readonly intervalMs?: number;
}

/**
 * Injectable seams for `verifyGreen` — keeps it a pure function of its inputs
 * (no clock, no network, no timers baked in), so it's unit-testable with a fake
 * probe sequence + a virtual clock.
 */
export interface VerifyGreenDeps {
  /**
   * Re-resolve the agent's CURRENT registry endpoint and probe its `/health`.
   * Returns the parsed body, or `null` when unreachable (offline / mid-restart /
   * endpoint not yet re-advertised). MUST re-read the registry each call so a
   * restart-self port churn is picked up (DR-037 Decision 5).
   */
  readonly probe: (agent: string) => Promise<HealthResponse | null>;
  /** Sleep `ms` between poll attempts (injected so tests don't wait). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in ms (injected so tests drive the timeout). */
  readonly now: () => number;
}

/**
 * The terminal outcome of a `verifyGreen` poll.
 *
 * - `ok: true`  — the agent self-reported the target version; `version` echoes it.
 * - `ok: false` + `reason: 'wrong-version'` — the agent was REACHABLE within the
 *   budget but never at the target (`lastVersion` is the last version seen, or
 *   `null` if a reachable body carried no version). The common mid-restart case
 *   that never converges (bad pin / stuck old process).
 * - `ok: false` + `reason: 'unreachable'` — the agent was NEVER reachable within
 *   the budget (every probe returned `null`). The dead / never-relaunched case.
 */
export type VerifyGreenResult =
  | { readonly ok: true; readonly version: string }
  | {
      readonly ok: false;
      readonly reason: 'wrong-version' | 'unreachable';
      readonly lastVersion: string | null;
    };

/**
 * Poll `deps.probe(agent)` until the agent self-reports `targetVersion`
 * (via `compareSemver === 0`) or the `timeoutMs` budget is exhausted.
 *
 * Guarantees at least one probe (even with `timeoutMs === 0`), then checks the
 * elapsed budget BEFORE each `sleep`, so the loop always terminates. The
 * version comparison uses `compareSemver` (macf-core, macf#424) so a leading
 * `v` / normalization is handled consistently with the rest of the fleet.
 */
export async function verifyGreen(
  opts: VerifyGreenOptions,
  deps: VerifyGreenDeps,
): Promise<VerifyGreenResult> {
  const intervalMs = opts.intervalMs ?? DEFAULT_VERIFY_GREEN_INTERVAL_MS;
  const start = deps.now();
  let reachedOnce = false;
  let lastVersion: string | null = null;

  for (;;) {
    const health = await deps.probe(opts.agent);
    if (health) {
      reachedOnce = true;
      lastVersion = health.version ?? null;
      if (lastVersion !== null && compareSemver(lastVersion, opts.targetVersion) === 0) {
        return { ok: true, version: lastVersion };
      }
    }

    if (deps.now() - start >= opts.timeoutMs) {
      return {
        ok: false,
        reason: reachedOnce ? 'wrong-version' : 'unreachable',
        lastVersion,
      };
    }
    await deps.sleep(intervalMs);
  }
}
