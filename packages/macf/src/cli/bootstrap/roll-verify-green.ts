/**
 * The re-resolving `verifyGreen` probe adapter (macf#722 Fix A), shared
 * between `macf fleet upgrade` (`commands/fleet-upgrade.ts`) and `macf
 * bootstrap apply`'s version-reconcile phase (`bootstrap/apply-version.ts`,
 * DR-043 Amendment L / groundnuty/macf#1045).
 *
 * Extracted so BOTH callers share the exact same adapter rather than each
 * hand-rolling their own copy — the pattern this file exists to prevent is
 * two independently-maintained probe adapters silently drifting apart
 * (`#1000`'s golden-path lesson). This module is plumbing ONLY: it never
 * touches the sequencer/busy-gate/HALT/verify-green STATE MACHINE itself
 * (that's `@groundnuty/macf-core`'s `upgradeFleets`/`rollFleet`/`verifyGreen`
 * — the actual "roll" Amendment L2 requires calling, never reimplementing).
 *
 * A single re-resolving probe, bound to whichever fleet's driver is
 * CURRENTLY being rolled. `upgradeFleets` processes fleets serially and
 * calls `resolveDriver(fleet)` immediately before rolling it, so `current`
 * is always the right driver during that fleet's verify polls (DR-037
 * Decision 5: `driver.probe()` re-lists the registry each call → sees the
 * fresh restart-self port).
 */
import {
  verifyGreen,
  type FleetDriver,
  type HealthResponse,
  type VerifyGreenOptions,
  type VerifyGreenResult,
} from '@groundnuty/macf-core';

export interface ReResolvingVerifyGreen {
  readonly resolveDriver: (fleet: string) => Promise<FleetDriver | null>;
  readonly verifyGreen: (opts: VerifyGreenOptions) => Promise<VerifyGreenResult>;
}

/** Build the resolve/probe/verify-green triple around a raw `resolveDriver`. */
export function makeReResolvingVerifyGreen(
  resolveDriverFn: (fleet: string) => Promise<FleetDriver | null>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): ReResolvingVerifyGreen {
  let current: FleetDriver | null = null;
  const resolveDriver = async (fleet: string): Promise<FleetDriver | null> => {
    current = await resolveDriverFn(fleet);
    return current;
  };
  const probe = async (agent: string): Promise<HealthResponse | null> => {
    if (!current) return null;
    const state = await current.probe();
    const found = state.agents.find((a) => a.name === agent);
    return found && found.online ? found.health : null;
  };
  return {
    resolveDriver,
    verifyGreen: (o: VerifyGreenOptions) => verifyGreen(o, { probe, sleep, now }),
  };
}
