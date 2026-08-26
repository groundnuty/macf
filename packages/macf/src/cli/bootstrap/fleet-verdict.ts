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
 *     (`result.routingSecrets`). Widened further by groundnuty/macf#1241:
 *     a repo-level leg that reads `'failed'`/`'skipped'` is no longer
 *     automatically a routing gap — {@link widenRepoRoutingVerdict} also
 *     checks whether the SAME secret name is visible to that repo as an
 *     ORG-level secret (`GET /repos/{repo}/actions/organization-secrets`,
 *     {@link realListOrgSecretsVisibleToRepo}), because `agent-router.yml`'s
 *     `${{ secrets.NAME }}` resolves from whichever scope actually holds
 *     the value at workflow-run time — a fleet whose shared credentials
 *     (e.g. `TS_OAUTH_*`) live at org level, `visibility: all`, is NOT
 *     broken just because no repo-level copy exists. This uses a NEW
 *     per-repo, name-preserving reducer ({@link unsatisfiedRoutingSecretNames}),
 *     deliberately NOT `apply-routing-secrets.ts::perRepoRoutingOutcome` —
 *     that function discards the secret NAME (folds straight to a `reason`
 *     string) for its OWN consumer (`apply-fleet.ts`'s in-run log line,
 *     untouched by this widening); naming which secret is missing on which
 *     repo is exactly what this issue asks the verdict to render, so a
 *     name-preserving sibling was added beside it rather than reshaping a
 *     function a different, unrelated call site depends on.
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RoutingSecretName, RoutingSecretsPublishResult } from './apply-routing-secrets.js';
import { ALL_ROUTING_SECRET_NAMES, ROUTING_APP_ID_SECRET_NAME } from './apply-routing-secrets.js';
import type { EnsureVariableOutcome } from './ensure-variable.js';
import type { RemainingDeployReport } from './remaining-deploy.js';

const execFileAsync = promisify(execFile);

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

// --- Org-inherited routing-secret visibility (groundnuty/macf#1241) ---
//
// A repo-level presence check (`apply-routing-secrets.ts::publishRoutingSecrets`'s
// own `checkRepoSecretPresence`) can only ever see a REPO-scoped secret. It
// cannot see an ORG secret shared with that repo (`visibility: all`, or
// `visibility: selected` naming it) — GitHub resolves `${{ secrets.NAME }}`
// from whichever scope actually holds the value, so a repo-level absence is
// NOT evidence the workflow lacks the value. Live `macf-trial` signature:
// `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET` moved to an org secret (deliberately
// — the durable fix for the write-only-repo-secret trap), and the verdict
// read every repo lacking a REPO-level copy as "missing," even though every
// repo could see the org-level one at workflow-run time.

/**
 * The result of listing an organization's secrets visible to ONE repo —
 * `GET /repos/{owner}/{repo}/actions/organization-secrets`. GitHub filters
 * this list SERVER-SIDE to secrets already shared with the calling repo (an
 * org secret with `visibility: all`, or `visibility: selected` naming this
 * repo, or `visibility: private` on a private repo in the same org) — so a
 * NAME's presence in `names` already IS "covering visibility"; this module
 * never inspects or re-derives a `visibility` field itself.
 *
 * `'unknown'` is what ANY call failure collapses to (auth/network/permission
 * failure, an unexpected response shape, `gh` absent) — NEVER `'ok'` with an
 * empty/partial `names`. Per the issue's own requirement, a repo whose
 * org-listing could not be read must never be treated as "the secret is
 * missing" — that would report an absence from a call that never actually
 * observed one.
 */
export type OrgSecretsListResult = { readonly status: 'ok'; readonly names: readonly string[] } | { readonly status: 'unknown'; readonly reason: string };

/** Injectable seam for {@link resolveOrgSecretVisibility} — same "pure decision, injected I/O" shape this module's sibling preflights already use (e.g. `apply-routing-secrets.ts::TailscaleOauthPreflightDeps`). */
export interface RoutingVerdictOrgSecretsDeps {
  readonly listOrgSecretsVisibleToRepo: (repo: string) => Promise<OrgSecretsListResult>;
}

/**
 * Real `gh api --paginate repos/<repo>/actions/organization-secrets` read —
 * the ONE live call this module performs. Verified against GitHub's REST API
 * reference (not by an actual live call from this session — see this
 * function's own inline note below) to sit in the EXACT SAME documented
 * permission bracket as `observer.ts::checkRepoSecretPresence`'s
 * `GET /repos/<repo>/actions/secrets/<name>` — GitHub's docs list "List
 * repository organization secrets" / "Get a repository secret" / "List
 * repository secrets" together, with no distinct fine-grained-token
 * permission callout for any of the three (all three: "Authenticated users
 * must have collaborator access to a repository... OAuth app tokens and
 * personal access tokens (classic) need the repo scope"). In THIS
 * codebase's `bootstrap apply` path that credential is the OPERATOR's own
 * ambient `gh auth` session, never a fleet-agent App installation token —
 * `commands/doctor.ts::MACF_REQUIRED_PERMISSIONS` (the set every ordinary
 * agent App's manifest derives from) carries no `secrets` permission key
 * and no `organization_*` key at all (see `registry-scope-preflight.ts`'s
 * doc for the fuller argument, and `observer.ts`'s own module doc: "Repo
 * existence + repo-scoped Actions variables ARE plan-time-observable —
 * those use the operator's own ambient `gh` auth (this tool is
 * operator-privileged by design, DR-035 §2)"). Since `checkRepoSecretPresence`
 * already performs a same-bracket read successfully in this exact codepath,
 * this call is expected to work under the identical ambient credential — but
 * that is a documented-bracket argument, not a live-verified one; if the
 * bracket assumption is ever wrong in the field, the failure degrades to the
 * `'unknown'` branch below, never a false "missing."
 *
 * `--paginate` is load-bearing: this is a plain list endpoint (default 30
 * secrets/page). Skipping it would make an org with more than 30 secrets
 * silently look empty past the first page — reporting "missing" from a page
 * this call never fetched, exactly the bug class this issue exists to close.
 */
export async function realListOrgSecretsVisibleToRepo(repo: string): Promise<OrgSecretsListResult> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', '--paginate', `repos/${repo}/actions/organization-secrets`, '--jq', '.secrets[].name'], {
      encoding: 'utf-8',
    });
    const names = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { status: 'ok', names };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'unknown', reason: `gh api repos/${repo}/actions/organization-secrets failed: ${reason}` };
  }
}

/** Production wiring for {@link RoutingVerdictOrgSecretsDeps} — the real `gh api` call above. */
export const REAL_ROUTING_VERDICT_ORG_SECRETS_DEPS: RoutingVerdictOrgSecretsDeps = {
  listOrgSecretsVisibleToRepo: realListOrgSecretsVisibleToRepo,
};

/**
 * Every routing-secret NAME whose leg is currently a routing gap for `repo`
 * — `'failed'` or `'skipped'`, the SAME two statuses
 * `apply-routing-secrets.ts::perRepoRoutingOutcome` folds into `failed: true`
 * for ITS OWN (repo-level, name-discarding) reduction. This sibling keeps
 * the NAME rather than discarding it — see this section's module doc for
 * why `perRepoRoutingOutcome` itself is left untouched.
 */
export function unsatisfiedRoutingSecretNames(secrets: RoutingSecretsPublishResult, repo: string): readonly RoutingSecretName[] {
  return ALL_ROUTING_SECRET_NAMES.filter((name) => {
    const leg = secrets[name]?.[repo];
    return leg?.status === 'failed' || leg?.status === 'skipped';
  });
}

/** One repo's routing-secret verdict AFTER org-level widening — the decisive per-repo shape {@link routingVerdictComponent} aggregates over. */
export interface RepoRoutingVerdict {
  readonly repo: string;
  readonly state: FleetVerdictComponentState;
  /** Secret names confirmed missing at repo level with no covering org-level visibility (or org-level was never checked) — named, never a count. Empty unless `state === 'not-confirmed'`. */
  readonly missing: readonly RoutingSecretName[];
  /** Secret names whose repo-level leg failed/skipped AND whose org-level visibility could not be determined this run — honest-unknown, never folded into `missing`. Empty unless `state === 'unknown'`. */
  readonly unknownOrgSecrets: readonly RoutingSecretName[];
}

/**
 * Widen ONE repo's routing-secret gaps with an (optional) org-level
 * visibility observation (groundnuty/macf#1241) — a secret satisfied at ORG
 * level and visible to this repo is no longer a gap, regardless of WHY the
 * repo-level leg failed (`'unavailable'`-this-run, or genuinely
 * `'not-required'`-and-absent — `agent-router.yml`'s `${{ secrets.NAME }}`
 * resolves from whichever scope actually has the value at workflow-run
 * time; this tool's own repo-level provisioning decision, made elsewhere,
 * is orthogonal and untouched by this function).
 *
 * `orgListing` is `undefined` when the caller never attempted the org-level
 * check for this repo (e.g. every repo-level leg already passed, so there
 * was nothing to widen — {@link resolveOrgSecretVisibility} only calls the
 * live read for repos {@link unsatisfiedRoutingSecretNames} already flagged,
 * to avoid a wasted API call) — every currently-failing name is reported
 * `missing`, UNCHANGED, matching this module's pre-#1241 behavior exactly:
 * the byte-identical-when-the-caller-supplies-nothing contract every
 * additive optional parameter in this codebase carries.
 *
 * A single repo is never BOTH `missing` and `unknownOrgSecrets` — one
 * `gh api` call per repo either succeeds (`'ok'`, letting every unsatisfied
 * name be classified definitively as satisfied-or-missing) or fails as a
 * whole (`'unknown'`, so every unsatisfied name for that repo is honestly
 * unknown, never guessed).
 */
export function widenRepoRoutingVerdict(secrets: RoutingSecretsPublishResult, repo: string, orgListing: OrgSecretsListResult | undefined): RepoRoutingVerdict {
  const unsatisfied = unsatisfiedRoutingSecretNames(secrets, repo);
  if (unsatisfied.length === 0) return { repo, state: 'confirmed', missing: [], unknownOrgSecrets: [] };
  if (orgListing === undefined) return { repo, state: 'not-confirmed', missing: unsatisfied, unknownOrgSecrets: [] };
  if (orgListing.status === 'unknown') return { repo, state: 'unknown', missing: [], unknownOrgSecrets: unsatisfied };

  const visible = new Set(orgListing.names);
  const missing = unsatisfied.filter((name) => !visible.has(name));
  return { repo, state: missing.length > 0 ? 'not-confirmed' : 'confirmed', missing, unknownOrgSecrets: [] };
}

/**
 * Live-resolve org-secret visibility ONLY for the repos that actually need
 * it — a repo whose six repo-level legs are already fully satisfied costs
 * ZERO extra `gh api` calls (this is one call per REPO, never per
 * repo-and-secret, so an N-repo fleet costs at most N extra calls). Intended
 * call site: the CLI orchestration layer (`commands/bootstrap-apply.ts`),
 * immediately before rendering the end-of-run verdict — the same
 * already-async post-apply phase that resolves `computeInstallScopeCoverage`
 * live, so this is one more live-observation step there, not a new kind of
 * call. The returned map is exactly {@link routingVerdictComponent}'s
 * (optional, additive) second-parameter shape; a repo absent from the map
 * means "never attempted," which is also this function's own return value
 * (`{}`) when nothing was unsatisfied anywhere — byte-identical to omitting
 * the parameter entirely.
 */
export async function resolveOrgSecretVisibility(
  secrets: RoutingSecretsPublishResult,
  repos: readonly string[],
  deps: RoutingVerdictOrgSecretsDeps = REAL_ROUTING_VERDICT_ORG_SECRETS_DEPS,
): Promise<Readonly<Record<string, OrgSecretsListResult>>> {
  const result: Record<string, OrgSecretsListResult> = {};
  for (const repo of repos) {
    if (unsatisfiedRoutingSecretNames(secrets, repo).length === 0) continue;
    result[repo] = await deps.listOrgSecretsVisibleToRepo(repo);
  }
  return result;
}

/** Per-name detail text for one repo's still-missing secrets — names each secret alongside its underlying cause (the leg's own `reason`), so naming culprits (groundnuty/macf#1241) never drops the diagnostic value the old count-only render at least carried inside its deduped reason list. */
function formatMissingSecretNames(secrets: RoutingSecretsPublishResult, repo: string, names: readonly RoutingSecretName[]): string {
  return names
    .map((name) => {
      const leg = secrets[name]?.[repo];
      const reason = leg?.status === 'failed' || leg?.status === 'skipped' ? leg.reason : 'unspecified cause';
      return `${name} (${reason})`;
    })
    .join(', ');
}

/**
 * Routing component — repos are read off the result's own keys
 * (`Object.keys(secrets[ROUTING_APP_ID_SECRET_NAME])`), EXACTLY the
 * `routerCarryingRepos` set `apply-fleet.ts` calls `publishRoutingSecrets`
 * with (every one of the six per-name maps shares the identical repo
 * key-set by construction). Zero repos observed -> `'unknown'`
 * (honest-unknown floor).
 *
 * `orgSecretVisibility` (groundnuty/macf#1241) is an OPTIONAL, ADDITIVE
 * second parameter — see {@link widenRepoRoutingVerdict}'s doc for its
 * byte-identical-when-omitted contract. Every repo is widened through
 * {@link widenRepoRoutingVerdict}; a repo with a genuinely-missing secret
 * (`state: 'not-confirmed'`) OUTRANKS one whose org-check merely couldn't be
 * confirmed (`state: 'unknown'`) — same weakest-confident-claim precedence
 * `workspaceVerdictComponent` already uses — so the component is
 * `'not-confirmed'` if ANY repo is, `'unknown'` if none are but some
 * couldn't be confirmed, else `'confirmed'`.
 */
export function routingVerdictComponent(
  secrets: RoutingSecretsPublishResult,
  orgSecretVisibility: Readonly<Record<string, OrgSecretsListResult>> = {},
): FleetVerdictComponent {
  const repos = Object.keys(secrets[ROUTING_APP_ID_SECRET_NAME] ?? {});
  if (repos.length === 0) {
    return {
      name: 'routing',
      status: { state: 'unknown', detail: 'no router-carrying repos were observed this run — routing status could not be determined.' },
    };
  }

  const perRepo = repos.map((repo) => widenRepoRoutingVerdict(secrets, repo, orgSecretVisibility[repo]));
  const stillMissing = perRepo.filter((r) => r.state === 'not-confirmed');
  const stillUnknown = perRepo.filter((r) => r.state === 'unknown');
  if (stillMissing.length === 0 && stillUnknown.length === 0) {
    return { name: 'routing', status: { state: 'confirmed', detail: '' } };
  }

  const parts: string[] = [];
  if (stillMissing.length > 0) {
    const named = stillMissing.map((r) => `${r.repo}: ${formatMissingSecretNames(secrets, r.repo, r.missing)}`).join(' | ');
    parts.push(
      `${String(stillMissing.length)} of ${String(repos.length)} router-carrying repo(s) are missing at least one required routing secret ` +
        `at both repo AND org-inherited level (agent-router.yml requires all six unconditionally) — ${named}`,
    );
  }
  if (stillUnknown.length > 0) {
    const named = stillUnknown.map((r) => `${r.repo}: ${r.unknownOrgSecrets.join(', ')}`).join(' | ');
    parts.push(`${String(stillUnknown.length)} repo(s) could not have org-inherited coverage confirmed this run for — ${named}`);
  }
  return {
    name: 'routing',
    status: { state: stillMissing.length > 0 ? 'not-confirmed' : 'unknown', detail: parts.join('; ') },
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
