import type { AgentInfo, Registry, Logger } from '@groundnuty/macf-core';
import { classifyPeer, RegisterRaceError, MAX_REGISTER_RETRIES } from './collision.js';
import type { CollisionResult } from './collision.js';

/**
 * Over-register loop (groundnuty/macf#702) — the load-bearing fix for the
 * register-race abort that bricked devops for 8h (2026-07-01).
 *
 * Invariant: **exactly one LIVE instance per agent-identity; the newest launch
 * is authoritative.** A relaunch must CLAIM its own slot even when a stale /
 * same / older entry is present — never abort-to-dead because the slot is
 * occupied. It YIELDS only to a GENUINELY newer + live instance.
 *
 * Contract:
 *  - `initialExpected` is what the collision check observed the slot as: the
 *    takeover target (a stale/dead/older entry) for `action:'takeover'`, or
 *    `null` (expected-absent) for `action:'register'`.
 *  - `registerConditional` either CLAIMS (`ok:true` — including over a
 *    stale/unchanged entry, which is the devops fix: `current==expected`
 *    always claims, even under GitHub-Variables read-after-write lag) or
 *    reports a real conflict (`ok:false, reason:'lost-to-newer', current`).
 *  - On a conflict this loop RE-CLASSIFIES `current` with the same liveness +
 *    #424 version quadrant the collision check uses (`classifyPeer`, applied
 *    directly to `current` to avoid reopening a fresh `registry.get` TOCTOU
 *    window):
 *      - `classifyPeer` says `abort` → `current` is a genuinely newer LIVE
 *        peer → YIELD by throwing `RegisterRaceError` (the caller exits 0 —
 *        a clean stand-down, NOT a crash-loop abort-to-dead).
 *      - `classifyPeer` says `takeover` → `current` is stale/dead/older →
 *        FORCE the claim: retry with `expected = current`.
 *      - `current === null` (slot emptied by a racing deregister/prune) →
 *        retry against expected-absent.
 *  - Bounded by `MAX_REGISTER_RETRIES` so a pathologically flapping slot
 *    can't loop forever; on exhaustion it yields (throws RegisterRaceError)
 *    against the last-observed `current` rather than spinning.
 *
 * `deregister` (#586) is NOT relied on for correctness — this loop claims the
 * slot regardless of whether the prior instance cleaned up on exit. Deregister
 * remains a best-effort fast-reclaim optimization only.
 *
 * Returns nothing on success (the slot is claimed); throws `RegisterRaceError`
 * to signal a clean yield to a newer live instance.
 */
export async function registerWithTakeover(params: {
  readonly registry: Registry;
  readonly routingLabel: string;
  readonly agentInfo: AgentInfo;
  readonly collisionResult: CollisionResult;
  readonly certPaths: {
    readonly caCertPath: string;
    readonly agentCertPath: string;
    readonly agentKeyPath: string;
  };
  readonly incomingVersion: string;
  readonly logger: Logger;
  /**
   * Injectable re-classifier (defaults to `classifyPeer`). Tests pass a stub
   * so the loop's claim-vs-yield branching can be exercised without a live
   * `/health` mTLS probe.
   */
  readonly classify?: (
    name: string,
    existing: AgentInfo,
    certPaths: {
      readonly caCertPath: string;
      readonly agentCertPath: string;
      readonly agentKeyPath: string;
    },
    incomingVersion: string,
    logger: Logger,
  ) => Promise<CollisionResult>;
  /** Bound on retries (defaults to MAX_REGISTER_RETRIES); injectable for tests. */
  readonly maxRetries?: number;
}): Promise<void> {
  const {
    registry,
    routingLabel,
    agentInfo,
    collisionResult,
    certPaths,
    incomingVersion,
    logger,
  } = params;
  const classify = params.classify ?? classifyPeer;
  const maxRetries = params.maxRetries ?? MAX_REGISTER_RETRIES;

  let expectedSlot: AgentInfo | null =
    collisionResult.action === 'takeover' ? collisionResult.previous : null;
  let registerResult = await registry.registerConditional(
    routingLabel,
    agentInfo,
    expectedSlot,
  );

  for (let attempt = 0; !registerResult.ok; attempt += 1) {
    logger.warn('register_race_lost', {
      agent: routingLabel,
      attempt,
      expected_instance: expectedSlot?.instance_id ?? null,
      current_instance: registerResult.current?.instance_id ?? null,
      current_host: registerResult.current?.host ?? null,
      current_port: registerResult.current?.port ?? null,
    });

    if (registerResult.current === null) {
      // The slot was emptied in the window (a deregister/prune raced us) —
      // nothing to classify; retry the claim against expected-absent.
      expectedSlot = null;
    } else if (attempt >= maxRetries) {
      // Exhausted the retry budget against a flapping slot. Treat the last
      // observed `current` as the winner and yield rather than spin forever.
      throw new RegisterRaceError(routingLabel, registerResult.current);
    } else {
      const reclassified = await classify(
        routingLabel,
        registerResult.current,
        certPaths,
        incomingVersion,
        logger,
      );

      if (reclassified.action === 'abort') {
        // A genuinely different, newer, LIVE instance holds the slot. Yield —
        // this is the ONLY case that throws RegisterRaceError (macf#702). The
        // caller catches it and exits 0 (clean stand-down).
        logger.info('register_yield_to_newer', {
          agent: routingLabel,
          current_instance: registerResult.current.instance_id,
          current_host: registerResult.current.host,
          current_port: registerResult.current.port,
        });
        throw new RegisterRaceError(routingLabel, registerResult.current);
      }

      // 'register' (would only arise if `current` read as absent — it's
      // non-null here, kept for exhaustiveness) or 'takeover' (stale/dead/
      // older) — FORCE the claim against the re-classified current value.
      logger.info('register_force_takeover', {
        agent: routingLabel,
        attempt,
        over_instance: registerResult.current.instance_id,
        basis: reclassified.action,
      });
      expectedSlot =
        reclassified.action === 'takeover' ? reclassified.previous : null;
    }

    registerResult = await registry.registerConditional(
      routingLabel,
      agentInfo,
      expectedSlot,
    );
  }
}
