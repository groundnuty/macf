/**
 * `githubRegistryObserver` — the REAL, read-only `FleetObserverFn`
 * implementation for `macf bootstrap plan` (DR-043 Slice 1a, groundnuty/macf#838).
 *
 * This is the I/O LEAF (same split as `fleet-doctor.ts` / `fleet-doctor-inject.ts`):
 * every network/subprocess touch lives here, so `plan.ts`'s `computePlan` stays
 * pure and fully unit-tested against hand-built `ObservedState` fixtures. This
 * module itself is deliberately THIN and best-effort — every read degrades to
 * `'unknown'` (or `undefined`) rather than throwing, per DR-043 §D2's plan-time
 * constraint: **there is no JWT yet** (the App doesn't exist until `apply`
 * creates it), so App / install existence can only be inferred from
 * `fleet.lock` (populated by a PRIOR `apply`), never confirmed live. Repo
 * existence + repo-scoped Actions variables ARE plan-time-observable — those
 * use the operator's own ambient `gh` auth (this tool is operator-privileged
 * by design, DR-035 §2 / `macf-bootstrap-safety.md` — it never mints a
 * fleet-agent bot token).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveControlRepoName } from './fleet-manifest.js';
import type { FleetObserverFn, ObservedAgentState, ObservedState, Presence } from './plan.js';
import { readFleetLockFile } from './fleet-lock.js';
import { registryPathPrefix } from '../registry-helper.js';
import type { VaultAgentObservation, VaultCaObservation, VaultReadOptions } from './vault-read.js';
import { VaultError } from './vault-write.js';
import { queryVaultAgentPresence, queryVaultCaPresence, readVault } from './vault-read.js';

const execFileAsync = promisify(execFile);

/**
 * Read `fleet.lock` from the same directory as the manifest file. Returns
 * `null` when absent (a not-yet-provisioned fleet — the common Slice 1a
 * case) or malformed. NEVER throws. Thin wrapper over
 * `fleet-lock.ts::readFleetLockFile` (macf#857) — that function takes the
 * exact lock path directly (needed by `apply-fleet.ts`'s control-repo
 * self-heal read); this one derives it from a manifest file's directory.
 */
export function readFleetLock(manifestPath: string): FleetLock | null {
  return readFleetLockFile(join(dirname(manifestPath), 'fleet.lock'));
}

/**
 * Best-effort extraction of a caught `execFile` error's captured stderr.
 * Exported so `control-repo.ts` reuses the same 404-vs-other-failure
 * discrimination (Amendment F's `checkControlRepoMeta`) instead of
 * duplicating this parsing.
 */
export function getStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const s = (err as { readonly stderr?: unknown }).stderr;
    return typeof s === 'string' ? s : '';
  }
  return '';
}

/**
 * Read-only repo-existence check via `gh api repos/<owner>/<repo>`. A `gh`-
 * reported 404 is a confident `'absent'`; any other failure (auth, network,
 * rate-limit, `gh` missing) degrades to `'unknown'` rather than claiming
 * absence. NEVER throws.
 */
export async function checkRepoExists(repo: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/** One repo's presence + (when present) its `archived` bit — the shape {@link checkRepoArchivedState} returns. */
export interface RepoArchivedMeta {
  readonly presence: Presence;
  readonly archived?: boolean;
}

/**
 * Read-only `{archived}` probe — DR-043 Amendment G (groundnuty/macf#867):
 * `plan` needs to report an archived control repo as a DELIBERATE fleet
 * state (`plan.ts`'s new `control_repo` item), not as drift, and that read
 * has to happen at PLAN time (credential-free, live `gh`, per DR-043
 * Amendment A1) alongside every other repo/variable read this file already
 * does. Deliberately NOT `control-repo.ts::checkControlRepoMeta` reused
 * directly here — `control-repo.ts` already imports {@link getStderr} FROM
 * this module, so a reverse import (this module pulling a function back
 * FROM `control-repo.ts`) would create a circular module edge. Same
 * one-round-trip `gh api ... --jq '{archived: .archived}'` shape as that
 * function's sibling copy — a drift between the two would be caught by
 * their own tests, never silent.
 */
export async function checkRepoArchivedState(repo: string): Promise<RepoArchivedMeta> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}`, '--jq', '{archived: .archived}'], { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(stdout);
    const archived =
      typeof parsed === 'object' && parsed !== null && 'archived' in parsed && typeof (parsed as { archived: unknown }).archived === 'boolean'
        ? (parsed as { archived: boolean }).archived
        : undefined;
    return { presence: 'present', archived };
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return { presence: 'absent' };
    return { presence: 'unknown' };
  }
}

/**
 * Best-effort read-only repo-scoped Actions-variable read. Returns the
 * value, or `undefined` on ANY failure (missing var, no access, `gh`
 * absent) — this collapses "confirmed absent" and "couldn't tell" into one
 * signal, an intentional THIN-observer simplification (see module doc).
 * NEVER throws.
 */
export async function readRepoVariable(repo: string, name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'],
      { encoding: 'utf-8' },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read-only repo-scoped Actions-variable EXISTENCE check — the
 * absent/unknown-distinguishing sibling of {@link readRepoVariable} (which
 * collapses both into `undefined`; fine for the `routingTrustedActors` VALUE
 * read, but not for the per-repo CA-var drift class the #806 acceptance test needs
 * to reproduce: telling a confirmed-404 repo-var apart from a couldn't-read
 * one, same split as {@link checkRepoExists}). A `gh`-reported 404 is a
 * confident `'absent'`; any other failure degrades to `'unknown'`. NEVER
 * throws (macf#839 review [BLOCKING] 3).
 */
export async function checkRepoVariablePresence(repo: string, name: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}/actions/variables/${name}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Read-only repo-scoped Actions-SECRET existence check (groundnuty/macf#920)
 * — the `GET /repos/<repo>/actions/secrets/<name>` sibling of
 * {@link checkRepoVariablePresence}. GitHub's secrets API is write-only (a
 * 200 here returns only `{name, created_at, updated_at}` metadata, NEVER the
 * value) so this is the ONLY presence signal available — unlike a variable,
 * there is no create-endpoint 409 to lean on for a create-only guarantee
 * (`apply-routing-client.ts::publishRoutingClientSecrets`'s doc explains how
 * that module still stays create-only via a presence-check-BEFORE-write,
 * non-atomic but sufficient for an operator-driven, non-concurrent bootstrap
 * tool). A `gh`-reported 404 is a confident `'absent'`; any other failure
 * degrades to `'unknown'`. NEVER throws.
 */
export async function checkRepoSecretPresence(repo: string, name: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}/actions/secrets/${name}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Read-only REPO-SCOPED self-hosted-runner-registration check via `gh api
 * repos/<repo>/actions/runners` — the ORIGINAL macf#922 register-before-route
 * primitive, UNCHANGED. `'present'` = at least one runner is REGISTERED
 * (`total_count > 0`) to THIS repo directly — deliberately "registered," not
 * "online": the router's own `pick-runner` doc comment says "registered,"
 * and a registered-but-currently-offline runner is a narrower failure (a
 * hung job) than writing `MACF_TRUSTED_ACTORS` with zero runners registered
 * at all. A confident empty list is `'absent'`; any read failure (auth /
 * network / insufficient scope / `gh` missing) degrades to `'unknown'` —
 * same discrimination {@link checkRepoExists} already uses. NEVER throws.
 *
 * **This is only HALF the register-before-route gate as of macf#924** — see
 * {@link checkRunnerUsableByRepo}, which composes this repo-scoped leg with
 * an ORG-scoped leg. GitHub documents self-hosted runners registered at the
 * organization level as usable by "multiple repositories in an
 * organization" WITHOUT per-repo registration — this repo-scoped-only read
 * is structurally blind to that case (confirmed via `gh api
 * repos/<repo>/actions/runners`'s own docs: it lists runners registered TO
 * that repository, nothing org-wide). macf#923 traced exactly this gap: an
 * org fleet with one working org-level runner read `total_count: 0` here,
 * scored `absent`, and `apply` silently fell back to metered github-hosted
 * Actions minutes on a private repo — the router-cost bug macf#922 existed
 * to fix in the first place, reintroduced by this check's narrow scope.
 */
async function checkRepoScopedRunner(repo: string): Promise<Presence> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}/actions/runners`, '--jq', '.total_count'], {
      encoding: 'utf-8',
    });
    const count = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(count)) return 'unknown';
    return count > 0 ? 'present' : 'absent';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/** One org self-hosted-runner group's identity — the minimal shape {@link checkRunnerUsableByRepo}'s resolution needs. */
interface RunnerGroupRef {
  readonly id: number;
  readonly name: string;
}

/**
 * Presence + (when NOT present, and there IS something actionable) the
 * org-admin handover message — the richer sibling of {@link RepoArchivedMeta}
 * for {@link checkRunnerUsableByRepo} (macf#924).
 */
export interface RunnerUsability {
  readonly presence: Presence;
  /**
   * Set for the "an org-level runner IS registered, but every group holding
   * one excludes this repo" case — the repo needs to be added to a group's
   * repository-access allowlist, which is an ORG-ADMIN action this tool can
   * name and hand over but never perform itself (same
   * `app-identity-removal.ts::reportAppIdentityRemoval` posture: report the
   * manual step + the exact place to perform it, never claim success on
   * someone else's action). Can accompany EITHER `presence: 'absent'` (the
   * repo-scoped leg was confidently empty AND the org leg confirmed the
   * exclusion) or `presence: 'unknown'` (the repo-scoped leg itself
   * couldn't be read, but the org leg's confirmed exclusion is still useful
   * actionable information — reporting it doesn't overclaim about the
   * unconfirmed repo-scoped leg). `undefined` when there is nothing
   * actionable to report: a genuine absence (no org runner anywhere) or an
   * org-leg read failure (that diagnostic lives in `presence` alone, via
   * `apply-routing.ts::noRunnerRegisteredReason`'s generic unknown branch).
   */
  readonly handover?: string;
}

/**
 * Injectable seam for {@link checkRunnerUsableByRepo}'s tests (macf#924) —
 * bundles its 3 independent `gh api` reads so a test can fake any
 * combination of repo-scope / org-groups-visible-to-repo / org-runner-group
 * responses WITHOUT mocking `node:child_process`. This file's usual
 * "gh-shelling fns are exercised only via `computePlan`'s injected-fake
 * `ObservedState` fixtures, not unit-tested directly" posture (see
 * `observer.test.ts`'s doc comment) doesn't scale to a 3-call, multi-branch
 * resolution with a required test matrix (repo-level / org `all` / org
 * `selected`-excluded / org `selected`-included / absent / unreadable) —
 * this is the one exception. `REAL_RUNNER_USABILITY_DEPS` below is the
 * production wiring; {@link checkRepoScopedRunner} keeps this file's
 * established NEVER-throws / 404-is-confident-absent-else-unknown
 * discrimination (unchanged from macf#922), but the two ORG-scope reads
 * below deliberately do NOT — see their fields' docs and
 * `realListRunnerGroupsVisibleToRepo`'s doc for why (macf#924 review).
 */
export interface RunnerUsabilityDeps {
  /** The repo-scoped leg — {@link checkRepoScopedRunner}, unchanged from macf#922. */
  readonly checkRepoScopedRunner: (repo: string) => Promise<Presence>;
  /**
   * Runner GROUPS this specific repo is allowed to use, resolved
   * SERVER-SIDE by GitHub's own `visible_to_repository` query param on `GET
   * /orgs/{org}/actions/runner-groups` (verified against GitHub's REST docs
   * 2026-08 — see this function's doc for source URLs). Delegating to this
   * param (rather than re-implementing visibility resolution here) is what
   * lets the resolution stay correct for ALL three `visibility` values
   * (`all` / `selected` / `private`) — in particular `private` depends on
   * the REPO's own private/public bit, which GitHub already resolves
   * server-side and this tool would otherwise have to fetch and reason
   * about separately. `'unknown'` on EVERY read failure, including a 404 —
   * deliberately NOT this file's usual "404 is confident-absent" convention
   * (macf#924 review): a 404 here cannot be told apart from a
   * permission-driven mask without an independent signal this function
   * doesn't have, and the honest-unknown floor puts the burden of proof on
   * the confident branch. See `realListRunnerGroupsVisibleToRepo`'s doc.
   */
  readonly listRunnerGroupsVisibleToRepo: (org: string, repoName: string) => Promise<ReadonlyArray<RunnerGroupRef> | 'unknown'>;
  /**
   * Every registered org-level runner's `runner_group_id` (`GET
   * /orgs/{org}/actions/runners`, NOT filtered by group) — crossed against
   * {@link listRunnerGroupsVisibleToRepo}'s result to answer "is there a
   * registered runner IN a group this repo can use." Also what lets the
   * resolution distinguish "no org runner exists at all" (nothing to hand
   * over) from "an org runner exists but every group holding one excludes
   * this repo" (hand over to an org admin) — see
   * {@link checkRunnerUsableByRepo}'s doc. `'unknown'` on EVERY read
   * failure, including a 404 — same reasoning as
   * {@link listRunnerGroupsVisibleToRepo}'s doc.
   */
  readonly listOrgRunnerGroupIds: (org: string) => Promise<ReadonlySet<number> | 'unknown'>;
}

/**
 * Real `listRunnerGroupsVisibleToRepo` — `GET /orgs/{org}/actions/runner-groups
 * ?visible_to_repository=<repoName>` (bare repo name, no `owner/` prefix —
 * the org is already the path segment; format CONFIRMED, not inferred, via
 * go-github's `ListOrgRunnerGroupOptions.VisibleToRepository string` field +
 * its test fixture `VisibleToRepository: "github"` asserting
 * `visible_to_repository=github` in the request — go-github is generated off
 * the same OpenAPI description GitHub's own docs render from). Verified
 * against GitHub's REST API docs (2026-08): "List self-hosted runner groups
 * for an organization" (https://docs.github.com/en/rest/actions/self-hosted-runner-groups
 * — `visible_to_repository` query param, "Only return runner groups that are
 * allowed to be used by this repository"; requires `admin:org` scope for
 * classic PAT/OAuth tokens).
 *
 * **Never treats 404 as confident-empty (macf#924 review) — every failure
 * here degrades to `'unknown'`, deliberately UNLIKE this file's other
 * `checkRepoExists`-style reads.** Community reports (`gh`/API discussions)
 * describe the missing-`admin:org` failure as `403 "Must have admin
 * rights..."` / `"must be an org admin or have the runners and runner
 * groups fine-grained permission"` — NOT 404 — so the 403 path already
 * falls through to `'unknown'` correctly. But this function has no
 * independent way to prove a 404 here is "no such org" rather than some
 * GitHub-side permission-driven mask, and Amendment A4's honest-unknown
 * floor puts the burden of proof on the CONFIDENT branch, not the cautious
 * one — a wrong `'absent'` writes nothing and looks like a clean plan; a
 * wrong `'unknown'` merely costs a plan line's precision. The ordinary
 * "zero groups visible" case returns 200 with an empty array regardless (no
 * confident-empty inference needed for it), so this costs nothing on the
 * common path.
 */
async function realListRunnerGroupsVisibleToRepo(org: string, repoName: string): Promise<ReadonlyArray<RunnerGroupRef> | 'unknown'> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `orgs/${org}/actions/runner-groups?visible_to_repository=${encodeURIComponent(repoName)}`, '--jq', '[.runner_groups[] | {id, name}]'],
      { encoding: 'utf-8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return 'unknown';
    return parsed.filter(
      (g): g is RunnerGroupRef => typeof g === 'object' && g !== null && typeof (g as { id?: unknown }).id === 'number' && typeof (g as { name?: unknown }).name === 'string',
    );
  } catch {
    return 'unknown';
  }
}

/**
 * Real `listOrgRunnerGroupIds` — `GET /orgs/{org}/actions/runners`
 * (org-scoped, unfiltered by group). Verified against GitHub's REST API
 * docs (2026-08): "List self-hosted runners for an organization"
 * (https://docs.github.com/en/rest/actions/self-hosted-runners) — each
 * runner object carries a `runner_group_id` integer field; requires
 * `admin:org` scope. Deliberately does NOT paginate past the default page
 * (same posture as {@link checkRepoScopedRunner}'s `.total_count` read,
 * which reads page 1 only) — a judgment call for typical small bootstrap
 * fleets, noted here rather than silently assumed.
 *
 * **Never treats 404 as confident-empty — same reasoning as
 * {@link realListRunnerGroupsVisibleToRepo}'s doc** (macf#924 review): this
 * function has no independent way to tell "no such org" apart from a
 * permission-driven mask, so every failure degrades to `'unknown'`.
 */
async function realListOrgRunnerGroupIds(org: string): Promise<ReadonlySet<number> | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `orgs/${org}/actions/runners`, '--jq', '[.runners[].runner_group_id]'], {
      encoding: 'utf-8',
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return 'unknown';
    return new Set(parsed.filter((x): x is number => typeof x === 'number'));
  } catch {
    return 'unknown';
  }
}

/** Production wiring for {@link RunnerUsabilityDeps} — real `gh api` calls. */
export const REAL_RUNNER_USABILITY_DEPS: RunnerUsabilityDeps = {
  checkRepoScopedRunner,
  listRunnerGroupsVisibleToRepo: realListRunnerGroupsVisibleToRepo,
  listOrgRunnerGroupIds: realListOrgRunnerGroupIds,
};

/** Splits `"owner/repo"` into its two parts; `undefined` on any unexpected shape — defensive (schema only enforces `min(1)`, no `owner/repo` regex), and this function must NEVER throw. */
function splitOwnerRepo(repo: string): { readonly owner: string; readonly name: string } | undefined {
  const idx = repo.indexOf('/');
  if (idx <= 0 || idx === repo.length - 1) return undefined;
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/** The org-admin settings page for a runner group's repository-access allowlist — runner groups exist only at the org level, so this has no personal-account form (contrast `app-identity-removal.ts::appSettingsAdvancedUrl`'s user-vs-org branch). */
function orgRunnerGroupSettingsUrl(org: string, groupId: number): string {
  return `https://github.com/organizations/${org}/settings/actions/runner-groups/${groupId}`;
}

/** Builds the org-admin handover message for {@link checkRunnerUsableByRepo}'s "excluded" outcome — an org runner IS registered, but every group holding one excludes `repo`. */
function buildRunnerHandoverMessage(repo: string, org: string, excludedGroupIdsWithRunners: ReadonlySet<number>): string {
  const links = [...excludedGroupIdsWithRunners]
    .sort((a, b) => a - b)
    .map((id) => orgRunnerGroupSettingsUrl(org, id))
    .join(', ');
  return (
    `An org-level self-hosted runner IS registered in "${org}", but its runner group's repository-access ` +
    `list excludes "${repo}" — an org admin must add this repo at: ${links}. This tool cannot perform that ` +
    'step itself (org-admin action; macf#924).'
  );
}

/**
 * Whether a self-hosted runner is REGISTERED and USABLE BY `repo` — the
 * register-before-route gate (macf#922), corrected for the org-runner-blind
 * cost regression (macf#923/#924). {@link checkRepoScopedRunner} alone
 * cannot see an ORG-level runner (GitHub's documented "usable by multiple
 * repositories in an organization" registration model has no per-repo
 * registration at all) — an org fleet with one working org runner read
 * `total_count: 0` there, scored `absent`, and `apply` silently fell back
 * to metered github-hosted Actions minutes on a private repo.
 *
 * **The invariant asserted here is "usable by THIS repo," not "exists
 * somewhere."** An org runner can be online and registered while its
 * runner-GROUP's visibility (`all` / `selected` / `private`) excludes this
 * specific repo — reporting `present` for ANY org runner regardless of
 * group visibility would be the MIRROR-IMAGE bug (trusting a runner that
 * will never pick up this repo's jobs). Group-visibility resolution is
 * delegated to GitHub's own `visible_to_repository` query param
 * ({@link RunnerUsabilityDeps.listRunnerGroupsVisibleToRepo}) rather than
 * re-implemented here.
 *
 * Resolution order: (1) repo-scoped registration (unchanged from #922 — the
 * common case, and the ONLY leg that doesn't need `admin:org`); (2) only if
 * NOT present at repo scope, org-scope usability. Any unreadable org-scope
 * leg (403 for missing `admin:org`, network, `gh` missing) degrades the
 * WHOLE resolution to `'unknown'` — Amendment A's honest-unknown floor: a
 * permission gap is not evidence of absence (macf#924 requirement 4). NEVER
 * throws.
 */
export async function checkRunnerUsableByRepo(repo: string, deps: RunnerUsabilityDeps = REAL_RUNNER_USABILITY_DEPS): Promise<RunnerUsability> {
  const repoScope = await deps.checkRepoScopedRunner(repo);
  if (repoScope === 'present') return { presence: 'present' };

  const split = splitOwnerRepo(repo);
  if (split === undefined) return { presence: 'unknown' };

  const [visibleGroups, orgRunnerGroupIds] = await Promise.all([
    deps.listRunnerGroupsVisibleToRepo(split.owner, split.name),
    deps.listOrgRunnerGroupIds(split.owner),
  ]);
  if (visibleGroups === 'unknown' || orgRunnerGroupIds === 'unknown') return { presence: 'unknown' };

  const visibleIds = new Set(visibleGroups.map((g) => g.id));
  if ([...orgRunnerGroupIds].some((id) => visibleIds.has(id))) return { presence: 'present' };

  // repoScope is 'absent' or 'unknown' here (the 'present' case returned
  // above); org-scope found nothing usable either. An 'unknown' repo-scope
  // leg keeps the OVERALL answer 'unknown' even though org-scope is
  // confirmed — we still can't rule out a repo-level runner we failed to read.
  const overallPresence: Presence = repoScope === 'unknown' ? 'unknown' : 'absent';
  const excludedGroupIdsWithRunners = new Set([...orgRunnerGroupIds].filter((id) => !visibleIds.has(id)));
  if (excludedGroupIdsWithRunners.size === 0) return { presence: overallPresence };
  return { presence: overallPresence, handover: buildRunnerHandoverMessage(repo, split.owner, excludedGroupIdsWithRunners) };
}

/**
 * Read-only registry-scope Actions-variable EXISTENCE check — the other leg
 * of the DR two-place rule (macf#806): the CA var lives on the registry
 * (`owner.registry`: profile/org/repo scope) AND on every agent repo (see
 * {@link checkRepoVariablePresence}). Reuses `registryPathPrefix` (the same
 * scope→API-path mapping the agent-side registry client uses) so this stays
 * in lockstep with how the registry is actually addressed. An unsupported
 * scope (`local` — no GitHub API path) or any read failure degrades to
 * `'unknown'` rather than throwing; a confirmed 404 is `'absent'`. NEVER
 * throws (macf#839 review [BLOCKING] 3).
 */
export async function checkRegistryVariablePresence(registry: RegistryConfig, name: string): Promise<Presence> {
  let pathPrefix: string;
  try {
    pathPrefix = registryPathPrefix(registry);
  } catch {
    return 'unknown';
  }
  try {
    await execFileAsync('gh', ['api', `${pathPrefix.replace(/^\//, '')}/actions/variables/${name}`], {
      encoding: 'utf-8',
    });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Best-effort read-only registry-scope Actions-variable VALUE read — the
 * registry-scope sibling of {@link readRepoVariable} (macf#838 Phase 2b, the
 * CA-reuse path: `apply-ca.ts::resolveCaCert` needs the EXISTING CA cert's
 * value to backfill any per-repo legs the #806 drift class left missing).
 * Returns `undefined` on ANY failure (missing var, no access, unsupported
 * registry scope, `gh` absent) — same "collapse absent + unreadable into one
 * signal" posture `readRepoVariable` already establishes; a caller that
 * needs to distinguish MUST run {@link checkRegistryVariablePresence} first
 * (which `resolveCaCert` does). NEVER throws.
 */
export async function readRegistryVariable(registry: RegistryConfig, name: string): Promise<string | undefined> {
  let pathPrefix: string;
  try {
    pathPrefix = registryPathPrefix(registry);
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `${pathPrefix.replace(/^\//, '')}/actions/variables/${name}`, '--jq', '.value'],
      { encoding: 'utf-8' },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The macf-actions caller `uses:` reference on a repo's committed
 * `.github/workflows/agent-router.yml` — DR-043 §D6's `versions.actions`
 * observed-state source. Mirrors `routing-doctor-gh.ts`'s (module-private)
 * `ACTIONS_USES_RE` of the same shape — kept as an INDEPENDENT copy rather
 * than a shared import: that module threads a minted App-installation
 * token per call, whereas every read in THIS file uses the bootstrap tool's
 * ambient operator `gh` auth (this module's doc; `checkRepoExists` et al.
 * take no token param either) — importing across that boundary would either
 * force a token this tool doesn't mint or silently diverge from this file's
 * "operator-privileged, GitHub-only, no App token" posture.
 */
const ACTIONS_USES_RE = /uses:\s*groundnuty\/macf-actions\/\.github\/workflows\/agent-router\.yml@(\S+)/;

/** Decode a GitHub contents-API `.content` base64 blob (newline-wrapped). */
function decodeGhContent(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8');
}

/**
 * Pure regex extraction, split out from {@link readCallerActionsPin}'s `gh`
 * shell-out specifically so it is independently unit-testable — the read
 * itself follows this module's established "gh-shelling functions are
 * exercised only via `computePlan`'s injected-fake `ObservedState`
 * fixtures, not unit-tested directly" posture (see `observer.test.ts`'s doc
 * comment). Returns `undefined` when the content has no macf-actions
 * `uses:` line.
 */
export function extractActionsPin(content: string): string | undefined {
  const m = ACTIONS_USES_RE.exec(content);
  return m?.[1];
}

/**
 * Best-effort read-only read of a repo's macf-actions router pin — DR-043
 * §D6's `versions.actions` observed-state source. Returns the pin string, or
 * `undefined` on ANY failure (file absent, no macf-actions `uses:` line,
 * auth / network / `gh` absent) — same "collapse absent + unreadable into
 * one signal" posture {@link readRepoVariable} already establishes for this
 * file's other VALUE reads; a caller needing absent-vs-unreadable would need
 * a presence-style split, which `plan.ts`'s `UNKNOWN_REASONS.actionsPin`
 * doesn't require (both causes read as the same honest "unknown"). NEVER
 * throws.
 */
export async function readCallerActionsPin(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/contents/.github/workflows/agent-router.yml`, '--jq', '.content'],
      { encoding: 'utf-8' },
    );
    return extractActionsPin(decodeGhContent(stdout));
  } catch {
    return undefined;
  }
}

/**
 * The real `FleetObserverFn`. `manifestPath` is the on-disk path to the
 * `fleet.yaml` that was parsed into `manifest` — used only to locate the
 * co-located `fleet.lock` (never re-parses the manifest itself).
 *
 * Per-agent: App + install existence come from `fleet.lock` ONLY (never
 * `'absent'` — a missing lock entry is `'unknown'`, since the App may simply
 * not have been provisioned via THIS tool yet, and we have no JWT to check
 * GitHub directly). Repo existence is a live `gh api` read. Fingerprints
 * are copied verbatim from the lock (never a live registry read in Slice 1a
 * — see `plan.ts`'s `secretFingerprintItem` doc for why drift-detection
 * there is a Slice-2 concern).
 *
 * CA presence is read at BOTH DR two-place-rule legs (macf#806, until
 * macf-actions#66 collapses it to one): the **registry** (`owner.registry` —
 * profile/org/repo scope, read once) AND a **per-agent-repo** copy on EVERY
 * agent's `repo` (macf#839 review [BLOCKING] 3 — a single "representative"
 * repo read cannot reproduce the #806 drift class: a per-repo var absent
 * while the registry + other repos have it).
 *
 * The routing vars (`MACF_TRUSTED_ACTORS` value + the register-before-route
 * runner-registration check, macf#922) are read on a single REPRESENTATIVE
 * caller repo — `manifest.agents[0].repo` (macf#857 / DR-043 Amendment F
 * review). Prior to Amendment F this read `transport.vault_repo`, which (in
 * every fleet seen so far) happened to BE an agent repo; Amendment F removes
 * `vault_repo` entirely (the vault now lives in the derived `<fleet>-control`
 * repo, which is NEVER a routing caller — the trust var is set per §D1 on
 * "every caller repo," and the control repo is not one). Reading it from the
 * control repo would make `routingTrustedActors` permanently `undefined`, so
 * `routingItem` would emit `create` forever and the `noop`/`update`
 * branches would go permanently dead — a silent plan regression. `agents[0]`
 * preserves the original "one representative target" semantics;
 * `FleetManifestSchema.agents` is `.min(1)` so this is always populated at
 * the type level, but `noUncheckedIndexedAccess` still requires the runtime
 * guard below.
 *
 * The control repo's presence/archived state (DR-043 Amendment G,
 * `plan.ts`'s new `control_repo` item) is read the SAME way `checkRepoExists`
 * reads an agent repo — credential-free, live `gh` — via
 * {@link checkRepoArchivedState} against the SAME derived name
 * `control-repo.ts::controlRepoFullName` computes (`deriveControlRepoName`
 * imported from `fleet-manifest.ts`, not `controlRepoFullName` itself — see
 * `checkRepoArchivedState`'s doc for why this module can't import FROM
 * `control-repo.ts`).
 *
 * §D6 version steering (macf#838 follow-up) adds two per-agent reads:
 * `deployedVersion` comes from `fleet.lock` ONLY (same "lock-or-unknown,
 * never live" posture as App/install existence above) — this Mac-side tool
 * still has no mTLS route to `/health.version`, so it never reads live.
 * `macf fleet upgrade -f <fleet.yaml>`'s confirmed-verify-green write-back
 * (macf#907, `fleet-lock-recorder.ts`) is what populates `deployed_version`
 * in the FIRST place; `readFleetLock` here then reads it back from THIS
 * manifest's own local directory, which reflects the control repo's latest
 * commit only once that checkout is pulled — see
 * `ObservedAgentState.deployedVersion`'s doc for the full "why `undefined`
 * happens" account. `actionsPin`, by contrast, genuinely IS a live read —
 * {@link readCallerActionsPin} against `agent.repo` — same "per-repo, not
 * fleet-representative" posture the CA reads above already use, for the
 * same #806-class reason.
 */
export async function githubRegistryObserver(manifest: FleetManifest, manifestPath: string): Promise<ObservedState> {
  const lock = readFleetLock(manifestPath);
  const seg = toVariableSegment(manifest.metadata.name);
  const caVarName = `${seg}_CA_CERT`;

  const agents: Record<string, ObservedAgentState> = {};
  const caRepos: Record<string, Presence> = {};
  // groundnuty/macf#920 gap 2 — same read `apply-fleet.ts`'s routing-client
  // publish step uses (`RoutingClientApplyDeps.checkRepoSecretPresence`), so
  // plan and apply agree on presence by construction.
  const routingClientRepos: Record<string, Presence> = {};

  for (const agent of manifest.agents) {
    const lockEntry = lock?.agents.find((a) => a.role === agent.role);
    const repo = await checkRepoExists(agent.repo);
    const actionsPin = await readCallerActionsPin(agent.repo);
    agents[agent.role] = {
      app: lockEntry ? 'present' : 'unknown',
      appId: lockEntry?.app_id,
      install: lockEntry ? 'present' : 'unknown',
      installId: lockEntry?.install_id,
      repo,
      fingerprints: lockEntry?.fingerprints ?? {},
      deployedVersion: lockEntry?.deployed_version,
      actionsPin,
    };
    caRepos[agent.repo] = await checkRepoVariablePresence(agent.repo, caVarName);
    routingClientRepos[agent.repo] = await checkRepoSecretPresence(agent.repo, 'ROUTING_CLIENT_CERT');
  }

  const caRegistry = await checkRegistryVariablePresence(manifest.owner.registry, caVarName);

  // macf#857 — representative caller repo; see this function's doc for why
  // it's `agents[0].repo`, not `transport.vault_repo` (removed) or the
  // control repo (never a routing caller).
  const representativeCallerRepo = manifest.agents[0]?.repo;
  // macf#922 — 'MACF_TRUSTED_ACTORS' inlined (not imported from
  // apply-routing.ts's TRUSTED_ACTORS_VAR) matching this file's established
  // convention of a documented same-literal-string pair rather than a
  // cross-module import (see apply-routing.ts's own doc: "matches
  // observer.ts's read of the same name").
  const routingTrustedActors =
    manifest.routing?.runner && representativeCallerRepo !== undefined
      ? await readRepoVariable(representativeCallerRepo, 'MACF_TRUSTED_ACTORS')
      : undefined;
  // macf#924 — checkRunnerUsableByRepo (not the repo-scoped-only
  // checkRunnerRegistered/checkRepoScopedRunner) so plan-time reporting sees
  // the SAME org-runner-aware resolution apply-time's per-repo gate uses
  // (apply-routing.ts::publishTrustedActors) — see that function's doc for
  // why plan and apply must agree "by construction, not by convention."
  const routingRunnerUsability =
    manifest.routing?.runner && representativeCallerRepo !== undefined ? await checkRunnerUsableByRepo(representativeCallerRepo) : undefined;
  const routingRunnerRegistered = routingRunnerUsability?.presence;
  const routingRunnerHandover = routingRunnerUsability?.handover;

  // DR-043 Amendment G — same derived name `control-repo.ts::controlRepoFullName`
  // computes; see this function's doc for why it's re-derived here rather
  // than imported.
  const controlRepoMeta = await checkRepoArchivedState(`${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`);

  return {
    lock,
    agents,
    caRegistry,
    caRepos,
    routingClientRepos,
    routingTrustedActors,
    routingRunnerRegistered,
    routingRunnerHandover,
    controlRepoPresence: controlRepoMeta.presence,
    controlRepoArchived: controlRepoMeta.archived,
  };
}

// --- vaultAwareObserver — DR-043 Amendment D phase 3 ("the vault-aware observer") ---

/** Injectable seam for {@link vaultAwareObserver}'s tests — real defaults are `githubRegistryObserver` (bound to `manifestPath`) and `vault-read.ts::readVault`. */
export interface VaultAwareObserverDeps {
  readonly observe?: FleetObserverFn;
  readonly readVault?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
}

/**
 * `githubRegistryObserver`, decorated with vault-derived per-agent secret
 * presence + fleet-level CA-key presence — DR-043 Amendment D phase 3, named
 * literally in the DR's phasing table: *"Vault read → vault-aware observer +
 * read-only decrypt... lifts phase 2 into Amendment A's confirm tier."*
 *
 * **Operator-gated by construction, not by a runtime check.** A caller only
 * reaches this function by supplying `vaultOpts` — a vault path AND an age
 * identity-key PATH it already holds on disk. An agent context never holds
 * the fleet's age key (Amendment C: the key is operator-provided, never
 * tool-minted, never handed to a fleet agent), so it structurally cannot
 * construct these options for a REAL fleet's vault; this module's own tests
 * exercise it against synthetic keys only (`vault-read.ts`'s module doc).
 *
 * **Never a guess — always `confirmed` or honestly `unknown` (Amendment A4).**
 * Every vault-read failure (missing vault file, missing/unreadable identity,
 * wrong key, malformed plaintext — see `vault-read.ts::readVault`'s doc)
 * degrades the WHOLE decoration to `status: 'unknown'` with the causing
 * `VaultError`'s message (already scrubbed of secret material at the
 * source) as `reason` — NEVER `'absent'`. "An absent identity key is not
 * evidence of an empty vault" (this increment's own brief) is exactly this
 * floor: a caller who forgot `--identity-key`, or pointed it at the wrong
 * file, gets `unknown`, never a false "nothing's provisioned."
 *
 * The BASE observation (`githubRegistryObserver`'s `lock`/`caRepos`/
 * `routingTrustedActors`/non-vault agent fields) is computed exactly as before and
 * carried through unchanged — this function ADDS `vault`/`vaultCa`, it never
 * revises anything the non-vault-aware observer already determined.
 */
export async function vaultAwareObserver(
  manifest: FleetManifest,
  manifestPath: string,
  vaultOpts: VaultReadOptions,
  deps?: VaultAwareObserverDeps,
): Promise<ObservedState> {
  const observe = deps?.observe ?? ((m: FleetManifest) => githubRegistryObserver(m, manifestPath));
  const doReadVault = deps?.readVault ?? readVault;

  const base = await observe(manifest);

  let raw: Readonly<Record<string, string>> | undefined;
  let unknownReason = 'vault not read (no vault/identity-key path given)';
  try {
    raw = await doReadVault(vaultOpts);
  } catch (err) {
    unknownReason = err instanceof VaultError || err instanceof Error ? err.message : String(err);
  }

  const agents: Record<string, ObservedAgentState> = {};
  for (const [role, obs] of Object.entries(base.agents)) {
    const vault: VaultAgentObservation =
      raw !== undefined
        ? { status: 'confirmed', presence: queryVaultAgentPresence(raw, manifest.metadata.name, role) }
        : { status: 'unknown', reason: unknownReason };
    agents[role] = { ...obs, vault };
  }

  const vaultCa: VaultCaObservation =
    raw !== undefined
      ? { status: 'confirmed', presence: queryVaultCaPresence(raw, manifest.metadata.name) }
      : { status: 'unknown', reason: unknownReason };

  return { ...base, agents, vaultCa };
}
