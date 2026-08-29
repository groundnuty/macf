/**
 * Per-repo routing-secret PARITY check (groundnuty/macf#1336) — detects when
 * a routing-critical GitHub Actions secret is present on SOME of a fleet's
 * agent repos and absent on others, a state `plan`'s existing fleet-level
 * items (`plan.ts::tsOauthItem`/`routingClientItem`) cannot see: each of
 * those reasons about ONE fleet-level vault fact or ONE representative
 * secret, never a cross-repo comparison of what is ALREADY on GitHub.
 *
 * **Live-measured motivating case (macf#1336).** On `macf-trial`,
 * `trial-code-agent`/`trial-science-agent` (provisioned in a warm
 * org-scope era — see `reference_warm_org_hides_cold_start_gaps`) both
 * carry `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`; `trial-writing-agent`
 * (added later) carries neither. `plan`'s existing `ts_oauth` item reads
 * this fleet-wide as a single `NOOP` — true at fleet/vault scope, and
 * SILENT about the repo-level split. `macf-actions@v3.4.2` declares both
 * names `required: true`, so the router on the repo missing them cannot
 * run — invisible until its FIRST trigger, which on a fleet with zero
 * workflow runs ever, has not happened yet. Independently reproduced the
 * same day on `macf-fresh` (2 warm repos / 3 cold repos) — same split, same
 * direction, two fleets, one tool: this is the DEFAULT outcome of adding an
 * agent to a fleet in a warm org scope, not a `macf-trial` curiosity.
 *
 * **Presence-only, by construction.** GitHub's Actions-secrets API is
 * write-only (`observer.ts::listRepoSecretNames` reads only `{name,
 * created_at, updated_at}` per entry, never a value); this module never
 * receives, stores, or renders a secret VALUE — `RepoSecretNamesObservation`
 * (`observer.ts`) has no field one could even be stored in.
 *
 * **This module never auto-publishes anything.** It is read-only,
 * diagnostic-only, mirroring `plan`'s own read-only-end-to-end posture. The
 * operator-supplied TS_OAUTH pair stays operator-supplied
 * (`--ts-oauth-client-id`/`--ts-oauth-secret`, macf#1188); a detected split
 * here is REPORTED, never remediated, by this tool.
 */
import type { Presence } from './plan.js';
import type { RepoSecretNamesObservation } from './observer.js';
import { ALL_ROUTING_SECRET_NAMES, type RoutingSecretName } from './apply-routing-secrets.js';

/**
 * One secret name's presence on one repo, derived from that repo's observed
 * name list. `undefined` observation — a repo this module was never told
 * about (macf#1336's own "a repo the fleet does not own is not consulted"
 * requirement: `findRoutingSecretAsymmetries` only ever looks up entries for
 * repos the CALLER passed in `repos`, so a repo outside the fleet's own
 * declared agent list is never even asked about) — reads identically to an
 * explicit `'unknown'` observation. This function never fabricates a
 * present/absent claim for a repo it has no data for.
 */
export function secretPresenceFor(secretName: RoutingSecretName, observation: RepoSecretNamesObservation | undefined): Presence {
  if (observation === undefined || observation.status === 'unknown') return 'unknown';
  return observation.names.has(secretName) ? 'present' : 'absent';
}

/**
 * One routing secret's cross-repo parity finding — emitted ONLY when the
 * fleet's agent repos genuinely DISAGREE about whether this secret exists.
 * See {@link findRoutingSecretAsymmetries}'s doc for the three-way verdict
 * this type represents only ONE branch of (the "split" branch — the other
 * two, uniform-present and uniform-absent, produce no entry at all).
 */
export interface RoutingSecretAsymmetry {
  readonly secretName: RoutingSecretName;
  /** Repos with a CONFIRMED-present read for this secret. Never empty when this finding exists. */
  readonly presentRepos: readonly string[];
  /** Repos with a CONFIRMED-absent read for this secret — the names macf#1336's own "naming which repos lack it" requirement asks for. Never empty when this finding exists. */
  readonly absentRepos: readonly string[];
  /** Repos whose presence could not be confirmed either way — named for transparency, but NEVER folded into `presentRepos`/`absentRepos` (Amendment A's honest-unknown floor: unreadable is never "consistent"). May be empty. */
  readonly unknownRepos: readonly string[];
  readonly message: string;
}

// groundnuty/macf#1061 — user-facing CLI output (the `formatPlanText`-rendered
// string {@link buildAsymmetryMessage} returns) must stand on its own for an
// operator who was never in the room: no bare `(macf#NNNN)` citation. This
// finding's OWN motivating issue is groundnuty/macf#1336 (the split this
// module detects); groundnuty/macf#855 established that a GitHub Actions
// secret's value is unreadable (this module reads presence via the
// name-listing endpoint only, never a value); groundnuty/macf#1188 is where
// `--ts-oauth-client-id`/`--ts-oauth-secret` were added as `apply` flags —
// all three are explained in PLAIN LANGUAGE below, never cited by number, in
// the returned string itself.
function buildAsymmetryMessage(
  secretName: RoutingSecretName,
  presentRepos: readonly string[],
  absentRepos: readonly string[],
  unknownRepos: readonly string[],
): string {
  const knownTotal = presentRepos.length + absentRepos.length;
  const unknownSuffix =
    unknownRepos.length > 0
      ? ` Presence on ${String(unknownRepos.length)} more repo(s) could not be confirmed this run — neither present ` +
        `nor absent, excluded from the ratio above: ${unknownRepos.join(', ')}.`
      : '';
  return (
    `Secret "${secretName}" is present on ${String(presentRepos.length)} of ${String(knownTotal)} repos with ` +
    `confirmed presence — ABSENT on: ${absentRepos.join(', ')}. A repo missing it cannot route once its ` +
    "agent-router.yml requires it (macf-actions@v3.4.2 declares every routing secret `required: true`)." +
    unknownSuffix +
    " Presence-only — GitHub's Actions-secrets API never exposes the value, only its name, so this tool cannot " +
    'and does not compare or publish values, only presence. This tool never auto-publishes a routing secret it ' +
    'detects missing: the Tailscale OAuth pair is supplied by the operator directly (the --ts-oauth-client-id/ ' +
    '--ts-oauth-secret flags on `macf bootstrap apply`); the router-App and routing-client secrets are published ' +
    "only through apply's own unified secrets writer."
  );
}

/**
 * The per-repo asymmetry sweep (groundnuty/macf#1336) — for each of
 * `apply-routing-secrets.ts::ALL_ROUTING_SECRET_NAMES` (the router-App
 * `MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY` pair, the routing-client
 * `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` pair, and the operator-supplied
 * `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET` pair), compares presence across
 * every repo the FLEET declares. `repos` is always `manifest.agents.map(a
 * => a.repo)` at the real call site (`plan.ts::computePlan`) — never a live
 * enumeration of the owner's other repos, so a repo the fleet does not own
 * is structurally never consulted: it simply never appears in `repos`, and
 * {@link secretPresenceFor} never looks one up that wasn't asked for.
 *
 * Pure; zero I/O — `perRepoSecretNames` is ALREADY-OBSERVED data
 * (`observer.ts::listRepoSecretNames`, threaded through
 * `ObservedState.routingSecretRepos`), matching `computePlan`'s own "no
 * network, no `gh` shell-outs" invariant.
 *
 * **Verdict per secret — three cases, only ONE reported:**
 * - Present on ALL repos with confirmed presence (zero confirmed-absent) →
 *   uniform, nothing wrong, NO entry. The satisfied state.
 * - Absent on ALL repos with confirmed presence (zero confirmed-present) →
 *   uniform absence — a DIFFERENT fact from a split (macf#1336's own
 *   framing: *"a fleet where no repo has it is not drifted, it is
 *   undeclared"*) — also NO entry. `tsOauthItem`'s existing fleet-level NOOP
 *   already carries this fact; this function does not duplicate it.
 * - BOTH present and absent among repos with confirmed presence → a genuine
 *   split. ONE entry, naming every repo that lacks it.
 *
 * A repo whose presence could not be confirmed (`'unknown'`) is NEVER folded
 * into either the present or the absent bucket — it is tracked separately
 * (`unknownRepos`) and named in the message, but never allowed to
 * manufacture a false "uniform" verdict by silently agreeing with whichever
 * side happens to be the majority (macf#1336's own "honest-unknown: never
 * 'consistent'" requirement). A secret with confirmed presence on ZERO
 * known repos (everything unknown) produces no entry either — there is
 * nothing yet to call a split.
 */
export function findRoutingSecretAsymmetries(
  repos: readonly string[],
  perRepoSecretNames: Readonly<Record<string, RepoSecretNamesObservation | undefined>>,
): readonly RoutingSecretAsymmetry[] {
  const findings: RoutingSecretAsymmetry[] = [];
  for (const secretName of ALL_ROUTING_SECRET_NAMES) {
    const presentRepos: string[] = [];
    const absentRepos: string[] = [];
    const unknownRepos: string[] = [];
    for (const repo of repos) {
      const presence = secretPresenceFor(secretName, perRepoSecretNames[repo]);
      if (presence === 'present') presentRepos.push(repo);
      else if (presence === 'absent') absentRepos.push(repo);
      else unknownRepos.push(repo);
    }
    if (presentRepos.length === 0 || absentRepos.length === 0) continue; // uniform (all-present / all-absent / all-unknown) — not an asymmetry
    findings.push({
      secretName,
      presentRepos,
      absentRepos,
      unknownRepos,
      message: buildAsymmetryMessage(secretName, presentRepos, absentRepos, unknownRepos),
    });
  }
  return findings;
}
