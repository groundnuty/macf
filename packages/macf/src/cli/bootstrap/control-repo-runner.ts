/**
 * groundnuty/macf#1446 — the control repo's runner class, as a plan row.
 *
 * When the manifest declares `routing.control_repo_runs_on: self-hosted`, the
 * control repo needs THREE things before its routing works, each owned by a
 * different writer, each independently absent: the installed router caller
 * passing `runner-runs-on: self-hosted`, a `MACF_TRUSTED_ACTORS` repo
 * variable (without it the router refuses every actor), and a registered,
 * usable runner. Absent any one, "declared self-hosted" is not "routes
 * self-hosted" — and the failure is NOT a silent hosted fallback: routing
 * either fails red or queues for a runner that never comes. So the row names
 * each missing piece and says so plainly.
 *
 * Pure — no I/O. Not declared => no row at all (caller omits it).
 */
import type { PlanItem, Presence } from './plan.js';

/** Value of the caller's `runner-runs-on:` input, or `undefined` when the line is absent. The generated caller carries exactly one. */
export function extractRunnerRunsOnInput(content: string): string | undefined {
  const m = /^\s*runner-runs-on:\s*["']?([^\s"'#]+)/m.exec(content);
  return m?.[1];
}

export interface ControlRepoRunnerObservation {
  /** `undefined` = the installed caller could not be read / is not installed. */
  readonly callerRunsOn: string | undefined;
  readonly callerReadable: boolean;
  readonly trustedActors: string | undefined;
  readonly runnerPresence: Presence | undefined;
  readonly runnerHandover: string | undefined;
  readonly runnerDetail: string | undefined;
}

export function controlRepoRunnerItem(
  fleetName: string,
  controlRepo: string,
  desiredTrustedActors: string,
  obs: ControlRepoRunnerObservation,
): PlanItem {
  const target = `routing:${fleetName}:control-runner`;
  const gaps: string[] = [];
  if (!obs.callerReadable) {
    gaps.push(`the installed router caller on "${controlRepo}" could not be read, so "runner-runs-on: self-hosted" is unconfirmed`);
  } else if (obs.callerRunsOn !== 'self-hosted') {
    gaps.push(
      `the caller on "${controlRepo}" does not pass "runner-runs-on: self-hosted" ` +
        `(${obs.callerRunsOn === undefined ? 'no such input' : `it passes "${obs.callerRunsOn}"`}) — apply regenerates it`,
    );
  }
  const varDiffers = obs.trustedActors !== undefined && obs.trustedActors !== desiredTrustedActors;
  if (obs.trustedActors === undefined) gaps.push(`"${controlRepo}" has no MACF_TRUSTED_ACTORS variable — the router refuses every actor without it`);
  else if (varDiffers) gaps.push(`MACF_TRUSTED_ACTORS on "${controlRepo}" is "${obs.trustedActors}" but the fleet derives "${desiredTrustedActors}"`);
  if (obs.runnerPresence !== 'present') {
    gaps.push(
      (obs.runnerPresence === 'absent'
        ? `no self-hosted runner is registered and usable by "${controlRepo}"`
        : `a runner usable by "${controlRepo}" could not be confirmed`) +
        ' — apply asks the runner platform to provision one; if the platform has no scale set for this repo, the operator must register a runner on it' +
        (obs.runnerDetail !== undefined ? ` ${obs.runnerDetail}` : '') +
        (obs.runnerHandover !== undefined ? ` ${obs.runnerHandover}` : ''),
    );
  }
  if (gaps.length === 0) {
    return {
      kind: 'routing',
      target,
      verb: 'noop',
      reason: `Control repo "${controlRepo}" runner class: self-hosted — caller, MACF_TRUSTED_ACTORS and a usable runner are all in place.`,
      confirm_required: false,
    };
  }
  return {
    kind: 'routing',
    target,
    verb: 'update',
    reason:
      `Control repo "${controlRepo}" is declared self-hosted but is not ready: ${gaps.join('; ')}. ` +
      'Until all three exist, routing through the control repo FAILS or queues — it does not fall back to a hosted runner.',
    confirm_required: varDiffers,
  };
}
