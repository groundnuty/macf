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
import { toVariableSegment, AgentInfoSchema } from '@groundnuty/macf-core';
import type { AgentInfo, RegistryConfig } from '@groundnuty/macf-core';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle, deriveControlRepoName, ROUTER_EMITTED_LABELS } from './fleet-manifest.js';
import type { FleetObserverFn, ObservedAgentState, ObservedState, Presence } from './plan.js';
import { readFleetLockFile } from './fleet-lock.js';
import { registryPathPrefix } from '../registry-helper.js';
import type {
  VaultAgentObservation,
  VaultCaObservation,
  VaultReadOptions,
  VaultRecipientCountResult,
  VaultRecipientsObservation,
  VaultRouterAppObservation,
  VaultTsOauthObservation,
} from './vault-read.js';
import { VaultError } from './vault-write.js';
import {
  queryVaultAgentPresence,
  queryVaultCaPresence,
  readVault,
  readVaultRecipientCount,
  vaultRouterAppId,
  vaultTsOauthClientId,
  vaultTsOauthSecret,
} from './vault-read.js';
import { RUNNER_PLATFORM_ENDPOINT_ENV_VAR, resolveRunnerPlatformEndpointWithProvenance } from './runner-platform.js';

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

// --- Already-provisioned-fleet install-scope drift detection (groundnuty/macf#1128) ---

/** One org-installed App's `appSlug` + observed `repository_selection`, the ONLY two fields {@link listOrgInstallRepositorySelections} needs — a narrower shape than `app-presence.ts::OrgInstallationRecord` on purpose, see that function's doc for why this module doesn't import from `app-presence.ts` at all. */
export interface OrgInstallScope {
  readonly appSlug: string;
  readonly repositorySelection?: string;
}

/**
 * `GET /orgs/{org}/installations?per_page=100` — the SAME endpoint +
 * ambient-`gh`-auth posture `app-presence.ts::listOrgAppInstallations`
 * already established for org-owned-fleet App-presence detection
 * (groundnuty/macf#967), reused here for a DIFFERENT fact: not "does the
 * App exist" but "what `repository_selection` does its install carry."
 *
 * **Deliberately NOT imported from `app-presence.ts`** — that module
 * imports {@link getStderr} FROM this one (`app-presence.ts`'s own import
 * line), so importing anything back from it here would be a module cycle.
 * This is the SAME "duplicate a small I/O leaf across a layer boundary
 * rather than introduce a cycle" precedent `registry-repo-coverage.ts` /
 * `identity-confirm.ts` / `doctor.ts` already establish for the sibling
 * App-JWT mint step (three independent copies, by design — see
 * `registry-repo-coverage.ts::mintAppJwt`'s doc).
 *
 * Org-owned fleets ONLY (see this function's caller): a personal-account
 * fleet has no ambient-auth listing endpoint at all
 * (`identity-confirm.ts`'s module doc: `/user/installations` 403s on both
 * bot tokens AND the operator's own `gh auth login` token) — there is no
 * fallback for `repository_selection` specifically the way
 * `app-presence.ts::resolveAppPresence` has one for bare existence (a
 * predicted-slug `GET /apps/{slug}` read cannot see this field for a
 * private App either). `undefined` — never a thrown error, never a guess —
 * on ANY failure (network, `gh` missing, permission-denied, malformed
 * body); the caller degrades every agent's `installRepositorySelection` to
 * `undefined` (honest "not observable this way"), never a false 'selected'.
 */
export async function listOrgInstallRepositorySelections(org: string): Promise<readonly OrgInstallScope[] | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `orgs/${org}/installations?per_page=100`], { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || !('installations' in parsed)) return undefined;
    const list = (parsed as { readonly installations?: unknown }).installations;
    if (!Array.isArray(list)) return undefined;
    const out: OrgInstallScope[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const { app_slug, repository_selection } = item as Record<string, unknown>;
      if (typeof app_slug !== 'string' || app_slug.length === 0) continue;
      out.push({
        appSlug: app_slug,
        ...(typeof repository_selection === 'string' ? { repositorySelection: repository_selection } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Look up ONE App's observed `repository_selection` from an already-fetched
 * org-installations listing. Pure; `undefined` when the listing itself is
 * `undefined` (the org-listing call failed/was skipped) OR the App isn't in
 * it (not installed on this org, or a fleet whose owner isn't an org at
 * all) OR the matching entry's body didn't carry the field — every case
 * collapses to "not observable this way," never a guess in either
 * direction (Amendment A4's honest-unknown floor).
 */
export function findInstallRepositorySelection(listing: readonly OrgInstallScope[] | undefined, appSlug: string): string | undefined {
  return listing?.find((i) => i.appSlug === appSlug)?.repositorySelection;
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
 * (`apply-routing-secrets.ts::publishRoutingSecrets`'s doc explains how
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
 * Injectable seam for {@link resolveAgentRepoState} — same "pure composition
 * over injected deps, testable without `execFile`" shape
 * {@link checkRunnerUsableByRepo}'s `RunnerUsabilityDeps` already establishes
 * for this file. `REAL_AGENT_REPO_STATE_DEPS` below is the production wiring
 * (the same three functions this module already exports).
 */
export interface AgentRepoStateDeps {
  readonly checkRepoExists: (repo: string) => Promise<Presence>;
  readonly checkRepoVariablePresence: (repo: string, name: string) => Promise<Presence>;
  readonly checkRepoSecretPresence: (repo: string, name: string) => Promise<Presence>;
}

/** Production wiring for {@link AgentRepoStateDeps} — the real `gh api` calls this module already exports. */
export const REAL_AGENT_REPO_STATE_DEPS: AgentRepoStateDeps = {
  checkRepoExists,
  checkRepoVariablePresence,
  checkRepoSecretPresence,
};

/** {@link resolveAgentRepoState}'s result — one agent repo's gated presence trio. */
export interface AgentRepoState {
  readonly repo: Presence;
  readonly caRepo: Presence;
  readonly routingClientRepo: Presence;
  /**
   * Set iff ANY of the three fields above was downgraded to `'unknown'` by
   * this function's visibility gate — `undefined` when `repo` resolved
   * `'present'` (the sub-reads' own values are trusted as-is; nothing to
   * explain).
   */
  readonly reason?: string;
}

/**
 * The `reason` text for a confirmed 404 on the repo itself — groundnuty/macf#1026
 * requirement 2's exact suggested shape ("say why: `unknown — this token
 * cannot see <repo> (404; not installed on it?)`, not a bare `unknown`"),
 * matched to {@link runnerIncapableDetail}'s established style (name the
 * resource, cite the HTTP evidence, explain the mechanism).
 */
function repoNotVisibleReason(repo: string): string {
  return (
    `this token cannot see "${repo}" (HTTP 404 reading the repo itself; not installed on it? GitHub returns 404 ` +
    'both for a repo that genuinely does not exist and for a private repo this token lacks access to — the two ' +
    'are indistinguishable to an unauthorized caller by design, so a 404 here is never confident evidence of ' +
    'absence). Its CA variable and ' +
    'routing-client secret reads are unknown for the same reason.'
  );
}

/**
 * The `reason` text for a repo-existence read that failed WITHOUT a
 * confirmed 404 (network/auth/`gh` failure) — distinguished from
 * {@link repoNotVisibleReason} so the message never claims "404" when the
 * read never got that far.
 */
function repoUnreadableReason(repo: string): string {
  return (
    `could not confirm "${repo}" is reachable this run (network/auth/gh failure reading the repo itself, not a ` +
    'confirmed 404) — its CA variable and routing-client secret reads are unknown for the same reason.'
  );
}

/**
 * Resolve one agent repo's gated presence trio — the fix for groundnuty/macf#1026:
 * a 404 on a per-agent repo-scoped resource is ambiguous (GitHub returns 404
 * identically for "doesn't exist" and "exists but this token can't see it" —
 * the SAME fact groundnuty/macf#969 established for `GET /apps/{slug}`), so
 * `'absent'` is only trustworthy once THIS run has independently proven the
 * caller can see the PARENT repo.
 *
 * The proof: {@link AgentRepoStateDeps.checkRepoExists} returning `'present'`
 * for `repo` — a 200 response is unambiguous (it proves existence AND
 * visibility at once), so once that holds, `caRepo`/`routingClientRepo` are
 * read for real and returned exactly as observed — a subsequent 404 there IS
 * genuine absence (macf#1026 requirement 3: "where the caller IS entitled to
 * see the resource… absent is still correct and must survive"). When
 * `checkRepoExists` does NOT return `'present'` (its own 404, or any other
 * read failure), visibility is unproven for the WHOLE repo — the sub-reads
 * are never even attempted (their result would be equally ambiguous: a 404
 * inside an unconfirmed-visible repo can't be told apart from "the repo
 * itself is invisible"), and all three fields collapse to `'unknown'` with a
 * diagnostic `reason` (requirement 1 + 2). NEVER throws — every injected dep
 * is itself documented never-throw.
 */
export async function resolveAgentRepoState(
  repo: string,
  caVarName: string,
  routingClientSecretName: string,
  deps: AgentRepoStateDeps = REAL_AGENT_REPO_STATE_DEPS,
): Promise<AgentRepoState> {
  const repoPresence = await deps.checkRepoExists(repo);
  if (repoPresence !== 'present') {
    const reason = repoPresence === 'absent' ? repoNotVisibleReason(repo) : repoUnreadableReason(repo);
    return { repo: 'unknown', caRepo: 'unknown', routingClientRepo: 'unknown', reason };
  }
  const [caRepo, routingClientRepo] = await Promise.all([
    deps.checkRepoVariablePresence(repo, caVarName),
    deps.checkRepoSecretPresence(repo, routingClientSecretName),
  ]);
  return { repo: 'present', caRepo, routingClientRepo };
}

/**
 * One GitHub-registered runner's capability-relevant fields (macf#934) — the
 * `GET .../actions/runners` response trimmed to what {@link isRunnerCapable}
 * needs. `busy` is carried for DIAGNOSTIC messages only — see that
 * function's doc for why it is never part of the usability predicate.
 */
export interface RunnerCapability {
  /**
   * GitHub's literal runner status (`'online'` | `'offline'`, and possibly
   * future values). Kept as `string`, not an enum — this module only ever
   * branches on the `'online'` literal, and an enum would be ceremony
   * around two known values plus a floor for values GitHub might add.
   */
  readonly status: string;
  /** NEVER consulted by {@link isRunnerCapable} — see that function's doc. Carried only so a diagnostic message can still report it. */
  readonly busy: boolean;
  readonly labels: ReadonlySet<string>;
}

/**
 * Whether `runner` can actually CLAIM the jobs `macf-actions`' router
 * dispatches (macf#934) — the missing half of the register-before-route
 * gate. Prior to this, `checkRunnerUsableByRepo` asked only "does a runner
 * usable-in-principle by this repo exist"; this asks the question the
 * router itself asks when GitHub tries to schedule a job onto a runner. TWO
 * predicates, BOTH required:
 *
 * 1. **`status === 'online'`.** An offline runner satisfies existence,
 *    scope, visibility, and even a label match, and still cannot pick up a
 *    job. Exact string equality against `'online'`, never a looser check —
 *    an unrecognized future status value resolves NOT-capable (the same
 *    conservative "functional-but-costly" direction Amendment H.1 already
 *    establishes for the whole gate: a false-negative here costs metered
 *    minutes, a false-positive silently stops the fleet from routing at
 *    all), never a silent pass.
 * 2. **`runner.labels ⊇ requiredLabels`** — SUPERSET, not equality. GitHub
 *    Actions claims a job iff the runner carries EVERY label the job's
 *    `runs-on` array declares; a runner missing even one of the router's
 *    emitted labels never sees the job. A real runner's actual label set
 *    (`["self-hosted","Linux","X64","macf-vm"]` — GitHub appends OS/arch
 *    labels automatically) still passes: it is a superset of the two
 *    labels the router requires, which is exactly what claim-eligibility
 *    needs.
 *
 * **`runner.busy` is DELIBERATELY NOT consulted.** It is throughput, not
 * capability — a BUSY runner is the HEALTHIEST possible signal (it is
 * claiming jobs right now). The naive `status === 'online' && !busy`
 * predicate would score our own live runner (which reads `busy: true`
 * under ordinary load) as unusable and silently drop the whole fleet onto
 * metered github-hosted runners on sight — verified against a live read:
 * `status=online busy=true labels=[self-hosted,Linux,X64,macf-vm]`.
 */
export function isRunnerCapable(runner: RunnerCapability, requiredLabels: readonly string[]): boolean {
  if (runner.status !== 'online') return false;
  for (const label of requiredLabels) {
    if (!runner.labels.has(label)) return false;
  }
  return true;
}

/**
 * Outcome of a repo-scoped runner-list read (macf#934 — replaces the
 * `Presence`-only `checkRepoScopedRunner`, which could answer "a runner is
 * registered" but never "a runner can claim a job"). `'ok'` carries EVERY
 * registered runner's capability fields — an empty array is a confident
 * zero-runners absence, the same case the old function's `count === 0`
 * branch covered. `'forbidden'` is a confirmed HTTP 403 (insufficient
 * permission — verified live: `macf-code-agent`'s token 403s on THIS exact
 * endpoint while `macf-science-agent`'s succeeds, an `administration: read`
 * gap that is per-App, not per-bot) so the caller can build a
 * permission-specific message instead of a generic "could not confirm."
 * `'unknown'` is every other read failure (network, `gh` missing,
 * malformed response).
 */
export type RepoRunnersOutcome =
  | { readonly kind: 'ok'; readonly runners: readonly RunnerCapability[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unknown' };

/** Parses one `--jq '[.runners[] | {status, busy, labels: [.labels[].name]}]'` array element; `undefined` on any shape mismatch (defensive — this is untyped JSON off the wire, not a Zod-validated boundary). */
function parseRunnerCapability(item: unknown): RunnerCapability | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { status, busy, labels } = item as { status?: unknown; busy?: unknown; labels?: unknown };
  if (typeof status !== 'string' || typeof busy !== 'boolean' || !Array.isArray(labels)) return undefined;
  return { status, busy, labels: new Set(labels.filter((l): l is string => typeof l === 'string')) };
}

/**
 * Read-only REPO-SCOPED runner-CAPABILITY read via `gh api
 * repos/<repo>/actions/runners` (macf#934 — supersedes the count-only
 * `checkRepoScopedRunner`; the ORIGINAL macf#922 primitive was
 * `total_count > 0` alone, which conflates "registered" with "usable").
 * Every runner's `status`/`busy`/`labels` is read in the SAME call the old
 * function used — {@link isRunnerCapable} is what changed, not the read's
 * cost or its required permission.
 *
 * A confirmed-empty list (zero runners registered) is `{kind: 'ok',
 * runners: []}` — same "confident absence" contract {@link checkRepoExists}
 * establishes. A 404 folds into that SAME empty-list outcome (matches the
 * ORIGINAL macf#922 behaviour, which read a 404 as `'absent'`) — see
 * {@link checkRunnerUsableByRepo}'s doc for why this repo-scoped leg still
 * needs an org-scoped fallback regardless of which branch produced the
 * empty list. A confirmed HTTP 403 is distinguished as `'forbidden'`
 * (macf#934 — a caller lacking `administration: read` must never read as
 * "no runner," per the honest-unknown floor); every other failure is
 * `'unknown'`. NEVER throws.
 */
async function listRepoScopedRunners(repo: string): Promise<RepoRunnersOutcome> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/actions/runners`, '--jq', '[.runners[] | {status, busy, labels: [.labels[].name]}]'],
      { encoding: 'utf-8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { kind: 'unknown' };
    const runners: RunnerCapability[] = [];
    for (const item of parsed) {
      const capability = parseRunnerCapability(item);
      if (capability !== undefined) runners.push(capability);
    }
    return { kind: 'ok', runners };
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return { kind: 'ok', runners: [] };
    if (/HTTP 403|Forbidden/i.test(stderr)) return { kind: 'forbidden' };
    return { kind: 'unknown' };
  }
}

/** One org self-hosted-runner group's identity — the minimal shape {@link checkRunnerUsableByRepo}'s resolution needs. */
interface RunnerGroupRef {
  readonly id: number;
  readonly name: string;
}

/** One org-registered runner (macf#934 — the org-scope sibling of {@link RunnerCapability}, with the group id {@link checkRunnerUsableByRepo} needs to cross-reference against visible groups). */
export interface OrgRunnerRecord extends RunnerCapability {
  readonly runnerGroupId: number;
}

/**
 * Presence + (when NOT present, and there IS something actionable) the
 * org-admin handover message — the richer sibling of {@link RepoArchivedMeta}
 * for {@link checkRunnerUsableByRepo} (macf#924; `detail` added macf#934).
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
  /**
   * A plain diagnostic naming WHY a runner that WAS found isn't usable
   * (macf#934) — distinct from `handover` (an org-admin GROUP-VISIBILITY
   * action; this carries no action, just an explanation): "found N
   * runner(s), online but missing label X" / "found a labeled runner but it
   * is offline" / "could not read runners for `<repo>` — insufficient
   * permission." `undefined` when there is nothing to explain: `presence`
   * is `'present'`, or the resolution found ZERO runners anywhere (the
   * existing generic "no self-hosted runner is confirmed registered"
   * wording in `apply-routing.ts::noRunnerRegisteredReason` /
   * `plan.ts::runnerClassReason` already covers that case correctly — this
   * field exists for the NEW case those callers previously had no way to
   * describe: a runner exists but fails the capability check.
   */
  readonly detail?: string;
  /**
   * Set `true` iff the repo-scoped runner-list read ({@link listRepoScopedRunners})
   * came back a CONFIRMED HTTP 403 (`RepoRunnersOutcome.kind === 'forbidden'`)
   * AND the resolution as a whole did not end in `presence: 'present'`
   * (groundnuty/macf#1054, DR-044 Decision 6: "fail as fast as possible, with
   * the cleanest reasons to act on"). A 403 here means *"I am not entitled to
   * look,"* never *"it is not there"* (Amendment A's floor) — a caller
   * lacking `administration: read` cannot make a runner appear by waiting
   * longer, so a poll built to wait out a REGISTERING runner (the honest
   * `'unknown'`/`'absent'` case this flag does NOT set) has no chance of ever
   * resolving `'present'` here. `pollForUsableRunner` (`apply-routing.ts`)
   * reads this flag to exit its retry loop on the FIRST check rather than
   * exhausting the whole deploy-window budget on a precondition that cannot
   * change mid-poll. `undefined` (never `false`) in every other case —
   * including a genuine "registered but not yet online" `'unknown'`/`'absent'`
   * (network hiccup, `gh` failure, or a runner mid-registration), which MUST
   * keep polling; see `checkRunnerUsableByRepo`'s doc for exactly where this
   * is set. Deliberately NOT folded into the shared {@link Presence} union
   * (which is used far beyond this one gate) — an additive field on THIS
   * richer type keeps the blast radius to the one caller that needs it.
   */
  readonly permissionDenied?: true;
  /**
   * Set `true` iff BOTH legs {@link checkRunnerUsableByRepo} can read
   * CONFIRM zero runners — the repo-scoped leg returned `{kind: 'ok',
   * runners: []}` (an empty list, not a 403/unreadable) AND the org-scope
   * leg's {@link RunnerUsabilityDeps.listOrgRunners} read (also confirmed,
   * not `'unknown'`) found zero runners in the WHOLE org, not merely zero
   * VISIBLE to this repo (groundnuty/macf#943, the third state the #1054
   * fix's `presence: 'absent'` couldn't distinguish from "something is
   * registering"). This is the caller-is-entitled-to-look sibling of
   * {@link permissionDenied}'s caller-is-NOT-entitled-to-look flag — the two
   * are mutually exclusive by construction (`permissionDenied` requires
   * `RepoRunnersOutcome.kind === 'forbidden'`; this flag requires
   * `kind === 'ok'`).
   *
   * **Deliberately NOT set merely because the repo-scoped leg is empty.** A
   * runner CAN be registered at org scope only (macf#924) or excluded from
   * every group visible to this repo (the `handover` case) — either shape
   * means a runner genuinely IS registered somewhere, so this flag stays
   * `undefined` and the honest "found something, not capable/visible yet"
   * detail/handover carries the explanation instead. Symmetrically, a
   * repo-scoped leg that found N>0 runners none of which are capable YET
   * (offline, still registering, a label not yet applied) also leaves this
   * `undefined` — that is precisely the "registered but not yet online"
   * case `pollForUsableRunner` MUST keep polling (a poll can observe that
   * runner transition to capable; it can never make a truly nonexistent one
   * appear). Only the TRUE zero — nothing at either scope — sets this.
   *
   * `pollForUsableRunner` (`apply-routing.ts`) reads this flag the same way
   * it reads `permissionDenied`: exit the retry loop on the FIRST check,
   * before ever calling `sleepFn` — a confirmed empty registry cannot
   * populate itself by being asked again on the SAME poll tick cadence this
   * tool controls (nothing in `apply` provisions a runner in-band). `undefined`
   * (never `false`) in every other case, matching `permissionDenied`'s own
   * convention.
   */
  readonly neverRegistered?: true;
}

/**
 * Injectable seam for {@link checkRunnerUsableByRepo}'s tests (macf#924,
 * reads enriched macf#934) — bundles its 3 independent `gh api` reads so a
 * test can fake any combination of repo-scope / org-groups-visible-to-repo /
 * org-runners responses WITHOUT mocking `node:child_process`. This file's
 * usual "gh-shelling fns are exercised only via `computePlan`'s
 * injected-fake `ObservedState` fixtures, not unit-tested directly" posture
 * (see `observer.test.ts`'s doc comment) doesn't scale to a 3-call,
 * multi-branch resolution with a required test matrix (repo-level / org
 * `all` / org `selected`-excluded / org `selected`-included / label-match /
 * label-miss / offline / forbidden / unreadable) — this is the one
 * exception. `REAL_RUNNER_USABILITY_DEPS` below is the production wiring.
 */
export interface RunnerUsabilityDeps {
  /** The repo-scoped leg — {@link listRepoScopedRunners} (macf#934; was the `Presence`-only `checkRepoScopedRunner` from macf#922). */
  readonly listRepoScopedRunners: (repo: string) => Promise<RepoRunnersOutcome>;
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
   * UNCHANGED by macf#934 — label/status capability is orthogonal to GROUP
   * visibility.
   */
  readonly listRunnerGroupsVisibleToRepo: (org: string, repoName: string) => Promise<ReadonlyArray<RunnerGroupRef> | 'unknown'>;
  /**
   * Every registered org-level runner, WITH its capability fields (macf#934
   * — was `listOrgRunnerGroupIds`, group-id-only; a group-id-only read could
   * confirm "a runner is registered in a visible group" but never "that
   * runner can claim a job"). Crossed against
   * {@link listRunnerGroupsVisibleToRepo}'s result to answer "is there a
   * CAPABLE registered runner IN a group this repo can use." Also what lets
   * the resolution distinguish "no org runner exists at all" (nothing to
   * hand over) from "an org runner exists but every group holding one
   * excludes this repo" (hand over to an org admin) — see
   * {@link checkRunnerUsableByRepo}'s doc. `'unknown'` on EVERY read
   * failure, including a 404 — same reasoning as
   * {@link listRunnerGroupsVisibleToRepo}'s doc.
   */
  readonly listOrgRunners: (org: string) => Promise<ReadonlyArray<OrgRunnerRecord> | 'unknown'>;
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
 * classic PAT/OAuth tokens). UNCHANGED by macf#934 (group visibility, not
 * capability, is this function's whole job — see the module-level "Preserve
 * the org-scope leg" note on {@link checkRunnerUsableByRepo}).
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

/** Parses one `--jq '[.runners[] | {runnerGroupId: .runner_group_id, status, busy, labels: [.labels[].name]}]'` array element; `undefined` on any shape mismatch. Sibling of {@link parseRunnerCapability}, with the extra `runnerGroupId` field. */
function parseOrgRunnerRecord(item: unknown): OrgRunnerRecord | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { runnerGroupId, ...rest } = item as { runnerGroupId?: unknown };
  if (typeof runnerGroupId !== 'number') return undefined;
  const capability = parseRunnerCapability(rest);
  if (capability === undefined) return undefined;
  return { ...capability, runnerGroupId };
}

/**
 * Real `listOrgRunners` — `GET /orgs/{org}/actions/runners` (org-scoped,
 * unfiltered by group; macf#934 — was `listOrgRunnerGroupIds`, group-id-only;
 * now ALSO reads `status`/`busy`/`labels` in the SAME call, no extra
 * request). Verified against GitHub's REST API docs (2026-08): "List
 * self-hosted runners for an organization"
 * (https://docs.github.com/en/rest/actions/self-hosted-runners) — each
 * runner object carries a `runner_group_id` integer field alongside
 * `status`/`busy`/`labels`; requires `admin:org` scope. Deliberately does
 * NOT paginate past the default page (same posture as
 * {@link listRepoScopedRunners}'s read, which reads page 1 only) — a
 * judgment call for typical small bootstrap fleets, noted here rather than
 * silently assumed.
 *
 * **Never treats 404 as confident-empty — same reasoning as
 * {@link realListRunnerGroupsVisibleToRepo}'s doc** (macf#924 review): this
 * function has no independent way to tell "no such org" apart from a
 * permission-driven mask, so every failure degrades to `'unknown'`.
 */
async function realListOrgRunners(org: string): Promise<ReadonlyArray<OrgRunnerRecord> | 'unknown'> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `orgs/${org}/actions/runners`, '--jq', '[.runners[] | {runnerGroupId: .runner_group_id, status, busy, labels: [.labels[].name]}]'],
      { encoding: 'utf-8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return 'unknown';
    const runners: OrgRunnerRecord[] = [];
    for (const item of parsed) {
      const record = parseOrgRunnerRecord(item);
      if (record !== undefined) runners.push(record);
    }
    return runners;
  } catch {
    return 'unknown';
  }
}

/** Production wiring for {@link RunnerUsabilityDeps} — real `gh api` calls. */
export const REAL_RUNNER_USABILITY_DEPS: RunnerUsabilityDeps = {
  listRepoScopedRunners,
  listRunnerGroupsVisibleToRepo: realListRunnerGroupsVisibleToRepo,
  listOrgRunners: realListOrgRunners,
};

/**
 * Splits `"owner/repo"` into its two parts; `undefined` on any unexpected
 * shape — defensive (schema only enforces `min(1)`, no `owner/repo` regex),
 * and this function must NEVER throw. Exported (groundnuty/macf#1220) so
 * `install-scope-coverage.ts`'s per-repo JWT probe reuses this SAME split
 * rather than a second hand-rolled copy — same "no second copy" discipline
 * `writeScratchPem`/`cleanupScratchPem` already established for the
 * scratch-PEM primitive.
 */
export function splitOwnerRepo(repo: string): { readonly owner: string; readonly name: string } | undefined {
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
    'step itself (org-admin action).'
  );
}

/**
 * The permission-specific `detail` for a confirmed HTTP 403 on the
 * repo-scoped runner list (macf#934) — named distinctly from a generic
 * "could not confirm" so the operator looks at the RIGHT thing (an App
 * permission grant) instead of chasing a runner that may well exist and be
 * healthy.
 */
function permissionDeniedDetail(repo: string): string {
  return (
    `could not read runners for "${repo}" — insufficient permission (HTTP 403; the App's installation token ` +
    'needs "administration: read" on this repo to list its registered runners — verified per-App, not per-bot: ' +
    'the same endpoint 200s for a differently-permissioned App on the same fleet).'
  );
}

/**
 * Builds the "a runner was found but isn't capable" `detail` (macf#934) —
 * distinguishes an ONLINE-but-mislabeled runner from a LABEL-MATCHING-but-
 * OFFLINE one, since they point the operator at different fixes (relabel
 * the runner vs restart its service). Prefers the label-match-but-offline
 * explanation when both shapes are present in `runners`, since an offline
 * service is the more actionable/likely-transient fix. `runners` must be
 * non-empty — callers only reach this after confirming at least one runner
 * was found and none is capable (see {@link isRunnerCapable}).
 */
function runnerIncapableDetail(repo: string, runners: readonly RunnerCapability[]): string {
  const offlineButLabeled = runners.find((r) => r.status !== 'online' && ROUTER_EMITTED_LABELS.every((label) => r.labels.has(label)));
  if (offlineButLabeled !== undefined) {
    return (
      `a runner registered for "${repo}" carries the required labels (${ROUTER_EMITTED_LABELS.join(', ')}) but is ` +
      `offline (status="${offlineButLabeled.status}") — register-before-route requires it ONLINE.`
    );
  }
  const onlineButMislabeled = runners.find((r) => r.status === 'online');
  if (onlineButMislabeled !== undefined) {
    const missing = ROUTER_EMITTED_LABELS.filter((label) => !onlineButMislabeled.labels.has(label));
    const found = [...onlineButMislabeled.labels].sort().join(', ') || '(none)';
    return (
      `a runner registered for "${repo}" is online but not carrying required label(s) "${missing.join(', ')}" ` +
      `(carries: ${found}).`
    );
  }
  return (
    `${String(runners.length)} runner(s) registered for "${repo}", none online and none carrying every required ` +
    `label (${ROUTER_EMITTED_LABELS.join(', ')}).`
  );
}

/**
 * Whether a self-hosted runner is REGISTERED and USABLE BY `repo` — the
 * register-before-route gate (macf#922), corrected for the org-runner-blind
 * cost regression (macf#923/#924), corrected AGAIN to actually check runner
 * CAPABILITY (macf#934). The gate used to ask only "does a runner usable by
 * this repo exist" — it never asked whether that runner could CLAIM the
 * jobs the router dispatches. Latent while every runner happened to carry
 * `macf-vm` by convention; unmasked the moment a caller's declared/
 * provisioned labels diverge, or a runner goes offline.
 *
 * **The invariant asserted here is "CAN CLAIM a routed job," not "exists
 * somewhere" and not "is registered."** Three failure directions, all real:
 * (1) {@link listRepoScopedRunners} alone cannot see an ORG-level runner
 * (GitHub's documented "usable by multiple repositories in an organization"
 * registration model has no per-repo registration at all — macf#923/#924);
 * (2) an org runner's runner-GROUP visibility can exclude this repo even
 * while the runner itself is healthy (macf#924); (3) a runner found at
 * EITHER scope can be offline, or online but missing a label the router's
 * job declaration requires (macf#934 — see {@link isRunnerCapable}).
 * Reporting `present` on any weaker signal than "found AND capable" is the
 * SAME shape of bug each time: trusting a proxy that looks like usability
 * but isn't (Amendment H.1's framing, applied here to the runner's own
 * fields instead of the token that gates *attempting* detection).
 *
 * Resolution order, PRESERVED from macf#922/#924 (this file's org-scope leg
 * — group resolution via `visible_to_repository` — is UNCHANGED by
 * macf#934; only the CAPABILITY predicate applied at each scope is new):
 * (1) repo-scoped runners (the common case, and the ONLY leg that doesn't
 * need `admin:org`) — `present` the moment ANY repo-scoped runner is
 * capable; (2) only if repo scope found no capable runner, org-scope
 * usability — `present` the moment ANY org runner in a group visible to
 * this repo is capable. A confirmed HTTP 403 on the repo-scoped leg does
 * NOT short-circuit to `'unknown'` — it still falls through to the org-scope
 * leg (a 403 on ONE leg is not evidence the OTHER leg is unreadable; a
 * fleet whose token can read org-level runners but not repo-level ones must
 * still resolve `present` off a usable org runner, same as macf#924 — see
 * this function's own tests for the regression this preserves). Any
 * unreadable org-scope leg (403 for missing `admin:org`, network, `gh`
 * missing) degrades the WHOLE resolution to `'unknown'` — Amendment A's
 * honest-unknown floor: a permission gap is not evidence of absence
 * (macf#924 requirement 4). NEVER throws.
 */
export async function checkRunnerUsableByRepo(repo: string, deps: RunnerUsabilityDeps = REAL_RUNNER_USABILITY_DEPS): Promise<RunnerUsability> {
  const repoOutcome = await deps.listRepoScopedRunners(repo);
  if (repoOutcome.kind === 'ok' && repoOutcome.runners.some((r) => isRunnerCapable(r, ROUTER_EMITTED_LABELS))) {
    return { presence: 'present' };
  }

  const split = splitOwnerRepo(repo);
  if (split === undefined) return { presence: 'unknown' };

  const [visibleGroups, orgRunners] = await Promise.all([
    deps.listRunnerGroupsVisibleToRepo(split.owner, split.name),
    deps.listOrgRunners(split.owner),
  ]);
  // groundnuty/macf#1054 (DR-044 Decision 6) — a CONFIRMED 403 on the
  // repo-scoped leg means "I am not entitled to look," never "it is not
  // there." Computed once here and threaded into every non-present return
  // below so `pollForUsableRunner` can fail fast instead of polling a
  // precondition that cannot change mid-poll — see `RunnerUsability.
  // permissionDenied`'s doc for the full contract.
  const repoForbidden = repoOutcome.kind === 'forbidden';

  if (visibleGroups === 'unknown' || orgRunners === 'unknown') {
    // repoOutcome may still have something worth explaining (found-but-
    // incapable runners, or a 403) even though the OVERALL answer is
    // 'unknown' — surface it rather than a bare "could not confirm."
    return {
      presence: 'unknown',
      detail: repoOutcomeDetail(repo, repoOutcome),
      ...(repoForbidden ? { permissionDenied: true } : {}),
    };
  }

  const visibleIds = new Set(visibleGroups.map((g) => g.id));
  const visibleOrgRunners = orgRunners.filter((r) => visibleIds.has(r.runnerGroupId));
  if (visibleOrgRunners.some((r) => isRunnerCapable(r, ROUTER_EMITTED_LABELS))) {
    return { presence: 'present' };
  }

  // Neither leg found a CAPABLE runner. repoOutcome is 'ok'-with-no-capable-
  // runner, 'forbidden', or 'unknown' here (the 'ok'-with-capable case
  // returned above) — an 'ok' outcome keeps the repo-scope contribution
  // 'absent' (confirmed, even if empty); 'forbidden'/'unknown' keep it
  // 'unknown', preserving macf#924's "a permission gap is not evidence of
  // absence" floor at the OVERALL level too. Note `repoForbidden` therefore
  // only ever pairs with `overallPresence === 'unknown'` here — never
  // `'absent'` — since a 'forbidden' repoOutcome forces `repoScopePresence`
  // to `'unknown'` on the very next line.
  const repoScopePresence: Presence = repoOutcome.kind === 'ok' ? 'absent' : 'unknown';
  const overallPresence: Presence = repoScopePresence === 'unknown' ? 'unknown' : 'absent';
  const detail = repoOutcomeDetail(repo, repoOutcome) ?? (visibleOrgRunners.length > 0 ? runnerIncapableDetail(repo, visibleOrgRunners) : undefined);

  // groundnuty/macf#943 — the third state a bare `presence: 'absent'` cannot
  // see: TRUE zero, at BOTH scopes, confirmed (never merely "not visible to
  // this repo" — see `RunnerUsability.neverRegistered`'s doc for why the
  // repo-scope-only or org-runners-count-only checks would be wrong here).
  // `orgRunners.length` (not `visibleOrgRunners.length`) is deliberate — an
  // org runner excluded from every group visible to this repo IS registered
  // somewhere, so it must NOT read as "never registered" (the `handover`
  // branch below already names that case correctly).
  const neverRegistered = repoOutcome.kind === 'ok' && repoOutcome.runners.length === 0 && orgRunners.length === 0;

  const excludedGroupIdsWithRunners = new Set(orgRunners.filter((r) => !visibleIds.has(r.runnerGroupId)).map((r) => r.runnerGroupId));
  const permissionDenied = repoForbidden ? ({ permissionDenied: true } as const) : {};
  const neverRegisteredFlag = neverRegistered ? ({ neverRegistered: true } as const) : {};
  if (excludedGroupIdsWithRunners.size === 0) return { presence: overallPresence, detail, ...permissionDenied, ...neverRegisteredFlag };
  return {
    presence: overallPresence,
    detail,
    handover: buildRunnerHandoverMessage(repo, split.owner, excludedGroupIdsWithRunners),
    ...permissionDenied,
    ...neverRegisteredFlag,
  };
}

/** The `detail` contribution from the repo-scoped leg alone — `undefined` when there is nothing repo-scope-specific to explain (zero runners found, or the leg is a plain unreadable with no permission signal). Factored out of {@link checkRunnerUsableByRepo} so both its early-return-avoided branches build the SAME message for the SAME repo-scope outcome. */
function repoOutcomeDetail(repo: string, outcome: RepoRunnersOutcome): string | undefined {
  if (outcome.kind === 'forbidden') return permissionDeniedDetail(repo);
  if (outcome.kind === 'ok' && outcome.runners.length > 0) return runnerIncapableDetail(repo, outcome.runners);
  return undefined;
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
 * One agent's registry-observed RUNTIME identity fact — groundnuty/macf#1017
 * ("a command that shows observed fleet state, no stored status"). This is
 * the honest CEILING of what the bootstrap plane can say about "is the
 * agent running": the registry entry (`MACF_<PROJECT>_AGENT_<ROLE>`,
 * written at agent-process startup via `Registry.registerConditional` — same key shape
 * `@groundnuty/macf-core`'s `registry/registry.ts::variableName` derives)
 * proves the agent REGISTERED at some point; it can NEVER prove the agent is
 * still alive right now (that needs a live mTLS `/health` probe, which
 * requires a per-agent CLIENT cert this operator-privileged, credential-free
 * tool structurally never holds — DR-035 §2: "it never mints a fleet-agent
 * bot token" — and by the same custody boundary never borrows a deployed
 * agent's client cert either). `commands/fleet.ts::runFleetStatus` is the
 * tool that CAN prove liveness (it runs from an already-deployed agent
 * workspace holding that agent's own cert); this function's caller renders
 * that split explicitly rather than papering over it (see
 * `status.ts`'s module doc).
 *
 * `'confirmed'`/`'present'` never means "online" — only "was registered, as
 * of the write, with this host/port/instance_id." `'confirmed'`/`'absent'`
 * is a live confirmed-404. Every other outcome (registry read failure,
 * present-but-unreadable value, present-but-not-JSON, present-but-not-
 * `AgentInfo`-shaped) degrades to `'unknown'` with a diagnostic `reason` —
 * Amendment A4's honest-unknown floor: an unreadable/malformed entry is
 * evidence of nothing about whether the agent is registered. NEVER throws.
 */
export type AgentRegistryObservation =
  | { readonly status: 'confirmed'; readonly presence: 'present'; readonly info: AgentInfo }
  | { readonly status: 'confirmed'; readonly presence: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string };

export async function readAgentRegistryInfo(registry: RegistryConfig, fleetName: string, role: string): Promise<AgentRegistryObservation> {
  const name = `${toVariableSegment(fleetName)}_AGENT_${toVariableSegment(role)}`;

  const presence = await checkRegistryVariablePresence(registry, name);
  if (presence === 'absent') return { status: 'confirmed', presence: 'absent' };
  if (presence === 'unknown') {
    return { status: 'unknown', reason: `registry variable "${name}" could not be read (network/auth/gh failure)` };
  }

  const raw = await readRegistryVariable(registry, name);
  if (raw === undefined) {
    return { status: 'unknown', reason: `registry variable "${name}" is present but its value could not be read` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unknown', reason: `registry variable "${name}" is present but is not valid JSON` };
  }

  const result = AgentInfoSchema.safeParse(parsed);
  if (!result.success) {
    return { status: 'unknown', reason: `registry variable "${name}" is present but does not match the expected agent-registration shape` };
  }
  return { status: 'confirmed', presence: 'present', info: result.data };
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
 *
 * `agents` also carries an entry for every `fleet.lock`-recorded role that
 * is NOT in `manifest.agents` (groundnuty/macf#1271, disclosed by #1270's
 * own body) — the input `plan.ts`'s row-4 `extraRoles` loop needs to ever
 * emit a real orphan/delete verb. Bounded strictly to `lock.agents` (never
 * an unbounded scan of the owner's Apps/repos); `app`/`install`/
 * `fingerprints` are lock-sourced exactly like a declared agent's (no
 * additional `gh api` call — `lock` is already an in-memory local-file
 * read by the time this loop runs), and `repo` stays `'unknown'` forever
 * (`FleetLockAgentSchema` records no repo name for ANY role, so there is
 * nothing to check). `routingTrustedActors` is READ regardless of whether
 * `manifest.routing?.runner` is declared (previously gated on it) — the
 * row-4 trigger case (`routing.runner` DROPPED) is precisely when a stale
 * value matters; see `routingTrustedActors`'s own inline comment below.
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
  // groundnuty/macf#1128 — already-provisioned-fleet install-scope drift
  // detection: ONE `GET /orgs/{org}/installations` call (never per-agent —
  // the listing already enumerates every App on the org in one shot),
  // reused by `findInstallRepositorySelection` per agent below AND, further
  // down, for the router App. `undefined` for a personal-account-owned
  // fleet (no ambient-auth listing endpoint exists there at all — see
  // `listOrgInstallRepositorySelections`'s doc) — every agent's
  // `installRepositorySelection` then honestly reads `undefined` too,
  // never a guess.
  const orgInstallScopes = manifest.owner.type === 'org' ? await listOrgInstallRepositorySelections(manifest.owner.account) : undefined;

  for (const agent of manifest.agents) {
    const lockEntry = lock?.agents.find((a) => a.role === agent.role);
    // groundnuty/macf#1026 — gated read: a raw 404 on `agent.repo` (or its
    // CA var / routing-client secret) is ambiguous for a token that may not
    // be entitled to see it (same 404-ambiguity macf#969 fixed for App
    // presence). `resolveAgentRepoState` only trusts `'absent'` once this
    // run has independently proven the caller can see the repo itself — see
    // that function's doc.
    const repoState = await resolveAgentRepoState(agent.repo, caVarName, 'ROUTING_CLIENT_CERT');
    const actionsPin = await readCallerActionsPin(agent.repo);
    // DR-043 Amendment G correction (groundnuty/macf#1034) — a STANDALONE
    // `{archived}` read, deliberately NOT threaded through
    // `resolveAgentRepoState` (macf#1026-gated, serves the unrelated
    // CA/routing-client presence trio above). The SAME function this
    // module's control-repo observation already uses (below) — one reader
    // per fact, not a second `{archived}` primitive.
    const repoArchivedMeta = await checkRepoArchivedState(agent.repo);
    agents[agent.role] = {
      app: lockEntry ? 'present' : 'unknown',
      appId: lockEntry?.app_id,
      install: lockEntry ? 'present' : 'unknown',
      installId: lockEntry?.install_id,
      repo: repoState.repo,
      repoVisibilityReason: repoState.reason,
      fingerprints: lockEntry?.fingerprints ?? {},
      deployedVersion: lockEntry?.deployed_version,
      actionsPin,
      archived: repoArchivedMeta.archived,
      installRepositorySelection: findInstallRepositorySelection(orgInstallScopes, deriveAppHandle(manifest.metadata.name, agent.role)),
    };
    caRepos[agent.repo] = repoState.caRepo;
    routingClientRepos[agent.repo] = repoState.routingClientRepo;
  }

  // groundnuty/macf#1271 (disclosed by #1270's own body) — row 4 of the
  // reconciler verb matrix (`plan.ts`'s `extraRoles` loop) can only ever act
  // on a role that shows up as a KEY in `agents` above; until this change
  // that map was built EXCLUSIVELY from `manifest.agents`, so
  // `Object.keys(observed.agents)` could never contain a role outside the
  // manifest — row 4's per-class verbs were correct and exhaustively
  // tested, but no real `plan` run could ever reach them (`computePlan`'s
  // OWN tests reproduce this only via a hand-built `ObservedState`, never
  // through this function).
  //
  // Bounded STRICTLY to `lock.agents` — the fix is "give row 4 an
  // observation," not "discover every role that might exist." `fleet.lock`
  // is the only record of what THIS TOOL provisioned (§D3 no-prune
  // invariant: `composeFleetLock` never prunes it), so it is the only set a
  // negative diff can act on safely; anything present on GitHub but absent
  // from BOTH the manifest AND the lock was never provably ours and stays
  // `report-extra` by `plan.ts`'s own existing (unchanged) no-lock branch —
  // which requires NO observation here at all, since `plan.ts`'s
  // `extraRoles`/`report-extra` logic already handles "in observed.agents,
  // not in the lock" correctly for whatever might reach it some OTHER way.
  // Walking `lock.agents` (never `manifest.agents`, never a live
  // enumeration of the owner's Apps/repos) is what keeps this bounded — no
  // `gh api` call added for this loop, since `lock` was already read via
  // `readFleetLock` above (a local file read).
  //
  // Per-field honesty, mirroring the manifest-agent branch above exactly:
  // `app`/`install` trust the lock entry's mere existence (same "no JWT
  // yet, so App/install existence comes from fleet.lock ONLY" floor this
  // function's own module doc states for a manifest-declared role — a
  // lock-recorded-but-undeclared role is no more/less confirmable live than
  // a lock-recorded-and-declared one). `fingerprints` is a straight lock
  // copy, same as the declared-agent branch. `repo` has NO lock-recorded
  // source at all — `FleetLockAgentSchema` carries no `repo` field (only a
  // manifest-declared `FleetAgent.repo` does, and this role has no manifest
  // entry) — so there is no repo NAME to check, let alone a live read to
  // attempt: it stays `'unknown'` for good, never a guessed `'absent'`
  // (Amendment A's honest-unknown floor — an observation that cannot be
  // made must never launder into a confident one).
  const manifestRoles = new Set(manifest.agents.map((a) => a.role));
  // Fleet-level pseudo-roles (`'runner-ops'` / `'router'`) are recorded in
  // `fleet.lock.agents` by design (`apply-runner-ops.ts::RUNNER_OPS_ROLE` /
  // `apply-router-app.ts::ROUTER_APP_ROLE`) but are never real per-manifest
  // agent identities — `plan.ts`'s own `extraRoles` filter already excludes
  // them via the same two literals. Inlined here (not imported) to avoid a
  // module cycle: `apply-router-app.ts` imports `app-identity-removal.ts`,
  // which imports THIS file's `getStderr` — importing back from
  // `apply-router-app.ts` would cycle. Same "documented same-literal-string
  // pair, not a cross-module import" convention `routingTrustedActors`
  // below already uses for `'MACF_TRUSTED_ACTORS'`.
  const fleetLevelPseudoRoles = new Set<string>(['runner-ops', 'router']);
  for (const lockEntry of lock?.agents ?? []) {
    if (manifestRoles.has(lockEntry.role) || fleetLevelPseudoRoles.has(lockEntry.role)) continue;
    agents[lockEntry.role] = {
      app: 'present',
      appId: lockEntry.app_id,
      install: 'present',
      installId: lockEntry.install_id,
      repo: 'unknown',
      fingerprints: lockEntry.fingerprints ?? {},
      deployedVersion: lockEntry.deployed_version,
    };
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
  //
  // groundnuty/macf#1271 — gated ONLY on there being a representative repo
  // to read from, NOT on `manifest.routing?.runner` being declared. The
  // prior `manifest.routing?.runner &&` guard meant this read never even
  // ran on the row-4 trigger fleet.yaml (`routing.runner` DROPPED from the
  // manifest) — `plan.ts`'s `routingDroppedItem` exists precisely to catch
  // a STILL-present `MACF_TRUSTED_ACTORS` in that exact shape (a stale
  // variable this tool wrote and the manifest no longer wants), and its own
  // doc says so explicitly: "not wired to any live read... `plan` will
  // report no negative diff on a fleet that has one, and there is no signal
  // distinguishing that from a fleet that does not." A `routing.runner`
  // declared fleet keeps reading the SAME as before (this is a strict
  // widening of the gate, not a behavior change on the declared side).
  const routingTrustedActors =
    representativeCallerRepo !== undefined ? await readRepoVariable(representativeCallerRepo, 'MACF_TRUSTED_ACTORS') : undefined;
  // macf#924 — checkRunnerUsableByRepo (not the repo-scoped-only
  // checkRunnerRegistered/checkRepoScopedRunner) so plan-time reporting sees
  // the SAME org-runner-aware resolution apply-time's per-repo gate uses
  // (apply-routing.ts::publishTrustedActors) — see that function's doc for
  // why plan and apply must agree "by construction, not by convention."
  const routingRunnerUsability =
    manifest.routing?.runner && representativeCallerRepo !== undefined ? await checkRunnerUsableByRepo(representativeCallerRepo) : undefined;
  const routingRunnerRegistered = routingRunnerUsability?.presence;
  const routingRunnerHandover = routingRunnerUsability?.handover;
  // macf#934 — the capability diagnostic (found-but-offline /
  // found-but-mislabeled / permission-denied); see `RunnerUsability.detail`'s
  // doc for why this is a NEW field, not folded into `routingRunnerHandover`.
  const routingRunnerDetail = routingRunnerUsability?.detail;

  // groundnuty/macf#1211 — the runner-provisioning contract's endpoint,
  // resolved at PLAN time so an unresolvable one is surfaced BEFORE the
  // operator approves `apply`, not discovered in apply's own non-fatal log
  // line. Gated the SAME way `apply-fleet.ts` gates the actual provisioning
  // call (`routing.runner` declared AND `runs_on === 'self-hosted'`) — a
  // hosted-runner fleet has nothing to resolve, and reading a scope variable
  // it will never use would be a needless live call. `readRegistryVariable`
  // is the SAME credential path (and the same `gh api .../actions/variables`
  // shape) `caRegistry`'s own read above already uses — no new auth path.
  const runnerPlatformScopeVariable =
    manifest.routing?.runner?.runs_on === 'self-hosted' ? await readRegistryVariable(manifest.owner.registry, RUNNER_PLATFORM_ENDPOINT_ENV_VAR) : undefined;
  const runnerPlatformEndpoint =
    manifest.routing?.runner?.runs_on === 'self-hosted'
      ? resolveRunnerPlatformEndpointWithProvenance({
          explicit: undefined, // no per-run override concept at plan time — see `runner-platform.ts`'s doc, tier 1
          manifestValue: manifest.transport.runner_platform_endpoint,
          scopeValue: runnerPlatformScopeVariable,
        })
      : undefined;

  // DR-043 Amendment G — same derived name `control-repo.ts::controlRepoFullName`
  // computes; see this function's doc for why it's re-derived here rather
  // than imported.
  const controlRepoFullNameHere = `${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`;
  const controlRepoMeta = await checkRepoArchivedState(controlRepoFullNameHere);
  // groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
  // — the control repo is a router-carrying repo too (since `#1070`), so it
  // gets the SAME live pin read every agent repo already gets
  // ({@link readCallerActionsPin}), targeted at the SAME derived full name
  // `controlRepoMeta` above already computed.
  const controlRepoActionsPin = await readCallerActionsPin(controlRepoFullNameHere);

  return {
    lock,
    agents,
    caRegistry,
    caRepos,
    routingClientRepos,
    routingTrustedActors,
    routingRunnerRegistered,
    routingRunnerHandover,
    routingRunnerDetail,
    runnerPlatformScopeVariable,
    runnerPlatformEndpoint,
    controlRepoPresence: controlRepoMeta.presence,
    controlRepoArchived: controlRepoMeta.archived,
    controlRepoActionsPin,
  };
}

// --- vaultAwareObserver — DR-043 Amendment D phase 3 ("the vault-aware observer") ---

/** Injectable seam for {@link vaultAwareObserver}'s tests — real defaults are `githubRegistryObserver` (bound to `manifestPath`), `vault-read.ts::readVault`, and `vault-read.ts::readVaultRecipientCount`. */
export interface VaultAwareObserverDeps {
  readonly observe?: FleetObserverFn;
  readonly readVault?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  /** DR-043 §D5 recipient-set reconciliation (macf#957) — see this function's own doc for why it's computed independently of `readVault`/`raw` above. */
  readonly readVaultRecipientCount?: (vaultPath: string) => VaultRecipientCountResult;
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
 * carried through unchanged — this function ADDS `vault`/`vaultCa`/
 * `vaultRecipients`/`vaultRouterApp` (groundnuty/macf#1105) /`vaultTsOauth`
 * (groundnuty/macf#1109), it never revises anything the non-vault-aware
 * observer already determined.
 */
export async function vaultAwareObserver(
  manifest: FleetManifest,
  manifestPath: string,
  vaultOpts: VaultReadOptions,
  deps?: VaultAwareObserverDeps,
): Promise<ObservedState> {
  const observe = deps?.observe ?? ((m: FleetManifest) => githubRegistryObserver(m, manifestPath));
  const doReadVault = deps?.readVault ?? readVault;
  const doReadRecipientCount = deps?.readVaultRecipientCount ?? readVaultRecipientCount;

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

  // groundnuty/macf#1105 — the router App's presence in THIS fleet's own
  // vault. Needed because a SHARED-scope reuse (`apply-router-app.ts::
  // RouterAppApplyOutcome`'s `'vault-reused'` status) deliberately never
  // writes a `fleet.lock` entry — lock-based presence alone (the
  // `runnerOpsItem` convention) would read this fleet as "create" forever,
  // even after a successful vault-backed reuse. `raw !== undefined` mirrors
  // `vaultCa`'s own gate exactly: a vault this run couldn't decrypt degrades
  // to honest 'unknown', never a false 'absent' (Amendment A4).
  const vaultRouterApp: VaultRouterAppObservation =
    raw !== undefined
      ? { status: 'confirmed', present: vaultRouterAppId(raw) !== undefined }
      : { status: 'unknown', reason: unknownReason };

  // groundnuty/macf#1109 — this fleet's own vault's Tailscale-OAuth-pair
  // presence, the fleet-level sibling of `vaultRouterApp` immediately above.
  // Needed so `plan.ts::tsOauthItem` can disclose "will publish" /
  // "absent and required" BEFORE the operator approves `apply` — see that
  // function's doc + `VaultTsOauthObservation`'s doc for why `present`
  // requires BOTH fields. Same `raw !== undefined` gate as `vaultRouterApp`:
  // a vault this run couldn't decrypt degrades to honest 'unknown', never a
  // false 'absent' (Amendment A4).
  const vaultTsOauth: VaultTsOauthObservation =
    raw !== undefined
      ? { status: 'confirmed', present: vaultTsOauthClientId(raw) !== undefined && vaultTsOauthSecret(raw) !== undefined }
      : { status: 'unknown', reason: unknownReason };

  // DR-043 §D5 recipient-set reconciliation (macf#957) — deliberately
  // INDEPENDENT of `raw`/`doReadVault` above: the recipient STANZA COUNT
  // needs no private key at all (see `vault-read.ts`'s module doc), so this
  // is computed from the vault file's header bytes directly, not gated on
  // whether the identity-key decrypt above succeeded.
  let vaultRecipients: VaultRecipientsObservation;
  try {
    const counted = doReadRecipientCount(vaultOpts.vaultPath);
    vaultRecipients = counted.status === 'counted' ? { status: 'confirmed', stanzaCount: counted.count } : { status: 'no-vault' };
  } catch (err) {
    vaultRecipients = { status: 'unknown', reason: err instanceof VaultError || err instanceof Error ? err.message : String(err) };
  }

  return { ...base, agents, vaultCa, vaultRecipients, vaultRouterApp, vaultTsOauth };
}
