/**
 * The fleet-level VERDICT `apply` reports at the end of a run — groundnuty/
 * macf#1184, "a fleet that cannot route is reported as 'provisioned'."
 *
 * The operator's own framing, after a clean `apply` run on `macf-trial`
 * (zero routing secrets on any repo, zero registered runners):
 *
 * > "I wouldn't be so bold to say that the fleet is provisioned. The fleet
 * > is defined on GitHub and not yet functional."
 *
 * `apply` already reports each piece HONESTLY on its own row — a routing
 * secret's per-repo leg, `MACF_TRUSTED_ACTORS`'s per-repo runner-confirm
 * leg, `remaining-deploy.ts`'s per-agent workspace check — but never states
 * the PROPERTY those rows jointly determine: can this fleet actually route,
 * to actually-running workspaces, through actually-registered runners? A
 * fleet missing any one of the three is not "provisioned" in any sense the
 * operator cares about, even though `apply` completed every step it
 * attempted without error.
 *
 * `groundnuty/macf#1111`'s rule, independently reached from a HEALTHY
 * verdict on a DIFFERENT surface (`routing doctor`) four days earlier,
 * governs this module's shape:
 *
 * > A composite verdict inherits the WEAKEST claim among its components,
 * > not the conjunction of their successes. ... Put the epistemic status in
 * > the verdict, not in a disclaimer beside it — a disclaimer is read once;
 * > a verdict is read every run.
 *
 * So this module does not add a longer disclaimer next to "provisioned" —
 * it computes a WEAKER verdict word, and names which component(s) failed
 * to confirm rather than leaving a bare adjective for the operator to
 * second-guess. See {@link determineFleetVerdict} for the reduction and
 * {@link formatFleetVerdictLines} for the render.
 *
 * **Three components, each independently honest:**
 *
 *   - **routing** — {@link routingVerdictComponent}, over the SAME
 *     `RoutingSecretsPublishResult` `apply-fleet.ts` already resolves
 *     (`result.routingSecrets`) and the SAME widened per-repo reducer
 *     (`apply-routing-secrets.ts::perRepoRoutingOutcome`, groundnuty/
 *     macf#1184) the in-run "Fleet-level: ... CANNOT route" log line uses —
 *     one decision, read twice, never re-derived.
 *   - **runners** — {@link runnerVerdictComponent}, over
 *     `result.routing` (the `MACF_TRUSTED_ACTORS` per-repo outcome map).
 *     **Deliberately does NOT treat `'already-present'` as confirmed** — see
 *     that function's own doc for why an inherited-from-an-earlier-run
 *     value proves nothing about THIS run's runner state, and treating it
 *     as confirmed would silently reproduce the exact over-claim this issue
 *     exists to close (a stale `MACF_TRUSTED_ACTORS` write surviving while
 *     every runner has since been deleted).
 *   - **workspaces** — {@link workspaceVerdictComponent}, over
 *     `remaining-deploy.ts::RemainingDeployReport` — no new filesystem
 *     probe, reuses the existing #1014 check verbatim.
 *
 * A component absent from the manifest's declared scope (no self-hosted
 * runner declared at all) is EXCLUDED from the verdict, not scored
 * `'not-confirmed'` — an operator who never asked for self-hosted routing
 * has nothing to be told is missing (mirrors `apply-routing-secrets.ts`'s
 * own `'not-required'` vs `'unavailable'` distinction for Tailscale).
 */
import type { RoutingSecretsPublishResult } from './apply-routing-secrets.js';
import { ROUTING_APP_ID_SECRET_NAME, perRepoRoutingOutcome } from './apply-routing-secrets.js';
import type { EnsureVariableOutcome } from './ensure-variable.js';
import type { RemainingDeployReport } from './remaining-deploy.js';

/** One component's honest status — `'confirmed'` is the ONLY state that participates in a positive verdict; `'not-confirmed'` and `'unknown'` are both "not confirmed" for verdict purposes (the decisive distinction the render layer preserves is which WORD it prints, never which one counts). */
export type FleetVerdictComponentState = 'confirmed' | 'not-confirmed' | 'unknown';

export interface FleetVerdictComponentStatus {
  readonly state: FleetVerdictComponentState;
  /** Empty when `state === 'confirmed'` — nothing to explain. Never a credential value. */
  readonly detail: string;
}

export interface FleetVerdictComponent {
  readonly name: string;
  readonly status: FleetVerdictComponentStatus;
}

export interface FleetVerdict {
  /** `true` iff EVERY component in {@link FleetVerdict.components} is `'confirmed'` — see this module's doc for why `'unknown'` counts the same as `'not-confirmed'` here (the honest-unknown floor: an indeterminate claim is never treated as a working one). */
  readonly confirmed: boolean;
  /** Every component this run actually checked — N/A components (e.g. no self-hosted runner declared) are never in this array. */
  readonly components: readonly FleetVerdictComponent[];
  /** The subset of {@link FleetVerdict.components} with `status.state !== 'confirmed'` — precomputed so the render layer never re-filters. */
  readonly unconfirmed: readonly FleetVerdictComponent[];
}

/**
 * The generic reduction — decisive pair (groundnuty/macf#1184's own test
 * requirement): every component `'confirmed'` -> `confirmed: true`; ANY
 * component NOT `'confirmed'` (including `'unknown'`) -> `confirmed: false`,
 * naming which. Pure; no I/O. An EMPTY `components` array (nothing was
 * checked at all — e.g. a manifest declaring zero agents and no self-hosted
 * runner) reduces to `confirmed: true` vacuously — there is nothing to
 * contradict a positive claim, same "nothing to report" convention
 * `remaining-deploy.ts::formatRemainingDeployLines` already uses for a
 * fully-deployed fleet.
 */
export function determineFleetVerdict(components: readonly FleetVerdictComponent[]): FleetVerdict {
  const unconfirmed = components.filter((c) => c.status.state !== 'confirmed');
  return { confirmed: unconfirmed.length === 0, components, unconfirmed };
}

/**
 * Routing component — reuses `perRepoRoutingOutcome` (the SAME widened
 * (groundnuty/macf#1184) per-repo reducer `determineFleetRoutingFact`
 * already calls for the in-run LOUD log line) rather than re-deriving a
 * second notion of "did routing work." Repos are read off the result's own
 * keys (`Object.keys(secrets[ROUTING_APP_ID_SECRET_NAME])`) — this is
 * EXACTLY the `routerCarryingRepos` set `apply-fleet.ts` calls
 * `publishRoutingSecrets` with (every one of the six per-name maps shares
 * the identical repo key-set by construction — `publishRoutingSecrets`'s
 * own per-repo, per-name double loop), so this never needs a second
 * parameter naming the repo set.
 *
 * Zero repos observed -> `'unknown'` (honest-unknown floor — a fleet
 * confirms nothing about routing when no router-carrying repo was even
 * checked this run, distinct from "checked and every repo passed").
 */
export function routingVerdictComponent(secrets: RoutingSecretsPublishResult): FleetVerdictComponent {
  const repos = Object.keys(secrets[ROUTING_APP_ID_SECRET_NAME] ?? {});
  if (repos.length === 0) {
    return {
      name: 'routing',
      status: { state: 'unknown', detail: 'no router-carrying repos were observed this run — routing status could not be determined.' },
    };
  }
  const perRepo = perRepoRoutingOutcome(secrets, repos);
  const failing = perRepo.filter((o) => o.failed);
  if (failing.length === 0) {
    return { name: 'routing', status: { state: 'confirmed', detail: '' } };
  }
  const reasons = [...new Set(failing.map((o) => o.reason ?? 'unspecified cause'))].sort();
  return {
    name: 'routing',
    status: {
      state: 'not-confirmed',
      detail:
        `${String(failing.length)} of ${String(repos.length)} router-carrying repo(s) are missing at least one ` +
        `required routing secret (agent-router.yml requires all six unconditionally): ${reasons.join(' | ')}`,
    },
  };
}

/**
 * Runner component — over `result.routing` (`MACF_TRUSTED_ACTORS`'s
 * per-repo outcome map; `apply-fleet.ts` leaves it `{}` whenever
 * `routing.runner` isn't declared `runs_on: self-hosted`, so an empty map
 * here means "not applicable," not "checked and failed" — returns
 * `undefined` in that case: this fleet never asked for self-hosted
 * routing, so there is nothing to report missing).
 *
 * **`'already-present'` is deliberately NOT `'confirmed'`.**
 * `ensureVariableCreated` is create-only: `'already-present'` means an
 * EARLIER run wrote `MACF_TRUSTED_ACTORS`, and this run's presence check
 * short-circuited before the live runner-usability check that gates
 * `create()` ever ran (see `apply-routing.ts::publishTrustedActorsGated`'s
 * doc — the live `checkRunnerUsableByRepo` read happens ONLY on the
 * absent-repo path, immediately before `create()`). A repo whose runner-ops
 * App exists but whose runner was deleted last week still reads
 * `'already-present'` from a stale write — treating that as `'confirmed'`
 * would silently reproduce the exact "table says provisioned, GitHub says
 * zero runners" gap #1184 reports. Mapped to `'unknown'` instead: this run
 * did not re-observe a live runner for that repo, so it cannot vouch for it
 * — distinct wording from a `'failed'`/`'skipped'` repo (a confirmed GAP)
 * per the amendment's explicit "never render 'no runners' and 'cannot see
 * runners' identically" requirement.
 *
 * `'pending'` (groundnuty/macf#1212 — an honest incomplete, not a failure)
 * is named explicitly in the detail text rather than folded silently into
 * the same bucket as `'failed'`/`'skipped'` — #1212's own "pending ≠
 * failed" distinction is preserved through to this render, not erased by
 * it.
 */
export function runnerVerdictComponent(routing: Readonly<Record<string, EnsureVariableOutcome>>): FleetVerdictComponent | undefined {
  const repos = Object.keys(routing);
  if (repos.length === 0) return undefined;

  const confirmedRepos = repos.filter((r) => routing[r]?.status === 'created');
  if (confirmedRepos.length === repos.length) {
    return { name: 'runners', status: { state: 'confirmed', detail: '' } };
  }

  const stalePresenceRepos = repos.filter((r) => routing[r]?.status === 'already-present');
  const pendingRepos = repos.filter((r) => routing[r]?.status === 'pending');
  const gapRepos = repos.filter((r) => routing[r]?.status === 'failed' || routing[r]?.status === 'skipped');

  const parts: string[] = [];
  if (gapRepos.length > 0) parts.push(`${String(gapRepos.length)} of ${String(repos.length)} repo(s) have NO confirmed self-hosted runner`);
  if (pendingRepos.length > 0) parts.push(`${String(pendingRepos.length)} still pending this run's bounded wait (may resolve on a later run)`);
  if (stalePresenceRepos.length > 0) {
    parts.push(`${String(stalePresenceRepos.length)} were not re-checked this run (an EARLIER run's registration; may be stale)`);
  }

  const state: FleetVerdictComponentState = gapRepos.length > 0 || pendingRepos.length > 0 ? 'not-confirmed' : 'unknown';
  return { name: 'runners', status: { state, detail: `${parts.join('; ')}.` } };
}

/**
 * Workspace component — over `remaining-deploy.ts`'s existing #1014 report;
 * no new filesystem probe. `'not-deployed'` (confidently absent on this
 * host) outranks `'unknown'` (a `deploy_path` this host can't corroborate,
 * e.g. a different host in a multi-host fleet) per the weakest-claim rule —
 * a report carrying ANY confidently-absent step is `'not-confirmed'`, never
 * softened to `'unknown'` just because it ALSO carries an unrelated
 * genuinely-indeterminate step.
 */
export function workspaceVerdictComponent(remainingDeploy: RemainingDeployReport): FleetVerdictComponent {
  if (remainingDeploy.steps.length === 0) {
    return { name: 'workspaces', status: { state: 'confirmed', detail: '' } };
  }
  const notDeployed = remainingDeploy.steps.filter((s) => s.presence === 'not-deployed');
  const unknown = remainingDeploy.steps.filter((s) => s.presence === 'unknown');
  const parts: string[] = [];
  if (notDeployed.length > 0) parts.push(`${String(notDeployed.length)} declared agent(s) have no local workspace on this host (${notDeployed.map((s) => s.role).join(', ')})`);
  if (unknown.length > 0) parts.push(`${String(unknown.length)} declared agent(s)' workspace presence is UNKNOWN on this host (${unknown.map((s) => s.role).join(', ')})`);
  return {
    name: 'workspaces',
    status: { state: notDeployed.length > 0 ? 'not-confirmed' : 'unknown', detail: `${parts.join('; ')}.` },
  };
}

/**
 * Human render — one line for a fully-confirmed run (requirement: "reports
 * success", not silence), or a headline plus one line per unconfirmed
 * component for anything short of that. Never uses the bare word
 * "provisioned" as a positive claim (groundnuty/macf#1184's core ask) —
 * "confirmed" is the verdict's own vocabulary throughout.
 */
export function formatFleetVerdictLines(verdict: FleetVerdict): readonly string[] {
  if (verdict.components.length === 0) return [];
  if (verdict.confirmed) {
    return [`✓ Fleet verdict: ${verdict.components.map((c) => c.name).join(', ')} all confirmed working this run.`];
  }
  const lines: string[] = [
    `⚠ Fleet verdict: NOT confirmed working — ${String(verdict.unconfirmed.length)} of ${String(verdict.components.length)} checked ` +
      'area(s) did not confirm this run:',
  ];
  for (const c of verdict.unconfirmed) {
    const tag = c.status.state === 'unknown' ? 'UNKNOWN' : 'NOT CONFIRMED';
    lines.push(`  • ${c.name}: ${tag} — ${c.status.detail}`);
  }
  lines.push('This fleet is defined on GitHub, not yet functional — "apply succeeded" describes the run, not the outcome.');
  return lines;
}

/**
 * `--json` render — snake_case, same field-per-component shape as the
 * human render (`name`/`state`/`detail`), so a script consuming `--json`
 * gets the identical verdict a human reading stdout would. `undefined` when
 * nothing was checked (`verdict.components.length === 0`) — the caller
 * (`bootstrap-apply.ts::fleetApplyResultToJson`) omits the `fleet_verdict`
 * key entirely in that case, matching `remaining_deploy`'s own
 * omit-when-N/A convention.
 */
export function fleetVerdictToJson(verdict: FleetVerdict): unknown {
  if (verdict.components.length === 0) return undefined;
  return {
    confirmed: verdict.confirmed,
    components: verdict.components.map((c) => ({ name: c.name, state: c.status.state, ...(c.status.detail.length > 0 ? { detail: c.status.detail } : {}) })),
  };
}
