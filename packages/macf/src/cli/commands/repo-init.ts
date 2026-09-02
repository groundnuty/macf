import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateToken, proxyAwareFetch } from '@groundnuty/macf-core';
import type { RegistryConfig, TokenSource } from '@groundnuty/macf-core';
import { registryPathPrefix } from '../registry-helper.js';
import { isValidProjectName } from '../config.js';
import { resolveActionsRefToFullTag, isImmutableActionsTag } from '../version-resolver.js';
import { detectStaleDist } from '../build-info.js';
import { findCliPackageRoot } from '../rules.js';
import { assertRouterWorkflowWellFormed } from './repo-init-router-guard.js';
import { ALL_ROUTING_SECRET_NAMES, ROUTING_BUNDLE_SECRET_NAME } from '../bootstrap/apply-routing-secrets.js';

export interface RepoInitOptions {
  readonly repo?: string;
  readonly actionsVersion: string;
  readonly agents?: string;
  readonly force: boolean;
  /**
   * Explicit App credentials for the label-creation token mint (groundnuty/macf#920)
   * — threaded by `apply-repo-init.ts` from a freshly-created App's in-memory
   * credentials so `generateToken` doesn't have to fall back to ambient
   * `GH_TOKEN`/`APP_ID`/`INSTALL_ID`/`KEY_PATH` env vars (which a Mac-side
   * `macf bootstrap apply` run never has — it operates as the OPERATOR, not
   * as the just-minted bot). Omitted (the default) preserves the exact
   * pre-#920 behavior: `generateToken()` falls through its own env-var
   * chain, degrading to a `labels: {status:'skipped'}` outcome when none of
   * those are set — the normal case for an interactive `macf repo-init`
   * run before an App/token exists yet.
   */
  readonly tokenSource?: TokenSource;
  /**
   * Optional shared tmux session name. When provided alongside 2+ agents,
   * all agents share this session and each is given a `tmux_window` equal
   * to the agent name. Omit or combine with a single agent to get the
   * legacy "session per agent, no window" layout.
   */
  readonly sessionName?: string;
  /**
   * Project name passed to the v3 reusable workflow's required `project`
   * input (macf#566). Defaults to the repo name. Must match the `project`
   * field in the agents' `.macf/macf-agent.json` — it derives the
   * `<PROJECT_SEG>_AGENT_<NAME>` registry-variable + `<PROJECT_SEG>_CA_CERT`
   * lookups. Only consumed when the pinned actions version is v3+.
   */
  readonly project?: string;
  /**
   * Registry scope for the v3 reusable workflow's `registry-api-path` input
   * (DR-006). One of `repo`, `org`, or `profile`. Mirrors `macf init`'s
   * `--registry-type`. Only consumed when the pinned actions version is
   * v3+; v1.x routing reads addressing from agent-config.json, not the
   * registry.
   *
   * **Omitted (the common case) is NOT the same as `repo` (groundnuty/macf#810).**
   * A fleet's registry is meant to be fleet-scoped — every agent's caller
   * pointing `registry-api-path` at ONE shared scope, so a registry write
   * (e.g. a rotated CA cert) is visible to every sibling agent. `repo`
   * scope self-points at the calling repo's own variables; N agent repos
   * each defaulting to `repo` produces N independent scopes, which is
   * exactly the per-repo drift DR-006 exists to avoid (verified live: every
   * agent repo on `macf-trial`/`macf-fresh` pointed at itself). So when this
   * field is left unset, `buildRoutingRegistry` derives the scope from a
   * LIVE fact — the owner account's GitHub type (`GET /users/<owner>`) —
   * rather than defaulting to `repo`: an Organization owner gets `org`
   * scope, a User owner gets `profile` scope (an org-scope default would
   * 404 unconditionally against a User account). `repo` is still reachable
   * by passing it explicitly — the DR-006 "fallback/edge cases" scope
   * remains available, it just is no longer silently the default.
   */
  readonly registryType?: string;
  /** Org login for `--registry-type org`. */
  readonly registryOrg?: string;
  /** User login for `--registry-type profile`. */
  readonly registryUser?: string;
  /**
   * Explicit `owner`/`repo` override for `--registry-type repo`
   * (groundnuty/macf#1374) — the manifest-declared target `apply` threads
   * through from `owner.registry.{owner,repo}` (`bootstrap/apply-repo-init.ts`
   * ::repoInitRegistryOptions). No CLI flag sets these — a bare `macf
   * repo-init --registry-type repo` invocation always omits them, and
   * {@link buildRoutingRegistry} keeps its pre-#1374 self-point default
   * (the repo THIS call is initializing) whenever either is absent. Must be
   * given TOGETHER or not at all: `apply` only ever supplies both (a
   * `RegistryConfig` with `type: 'repo'` requires both fields at the schema
   * level — `RepoRegistryConfigSchema` — so a partial pair is a caller bug,
   * not a real state), and `buildRoutingRegistry` throws rather than
   * silently mixing a manifest-declared owner with a self-pointed repo.
   */
  readonly registryOwner?: string;
  /** Paired with {@link registryOwner} — see its doc. */
  readonly registryRepo?: string;
  /**
   * Verbatim `fleet.yaml` `routing.runner.runs_on` declaration
   * (groundnuty/macf#1368) — threaded straight through to
   * `generateWorkflow`'s `with:` block via {@link V3WorkflowInputs.runnerRunsOn},
   * gated there on `isRunnerRunsOnCapableActionsVersion(actionsVersion)`.
   * Omitted (the default — every pre-#1368 caller, and any fleet with no
   * `routing.runner` declared at all) emits nothing new: the generated
   * caller is byte-identical to before this option existed. Only consumed
   * on a v3+ pin; a v1.x/v2.x caller never gets a `with:` block regardless.
   */
  readonly routingRunnerRunsOn?: string;
}

/**
 * Parse the major version from a macf-actions pin (`v3`, `v3.3.0`, `v1.2`).
 * Returns null when the ref is not a `vN[.N[.N]]` tag (e.g. a branch name).
 */
function parseActionsMajor(version: string): number | null {
  const match = /^v(\d+)(?:\.\d+){0,2}$/.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * The v3 reusable workflow (`agent-router.yml@v3+`) requires the `project`
 * input and resolves addressing from the MACF registry via `registry-api-path`
 * (macf#566). v1.x/v2.x callers must NOT pass those inputs — the v1 reusable
 * workflow declares no `workflow_call.inputs`, so an unknown `with:` key is a
 * hard error. Gate the `with:` block on a v3+ pin.
 *
 * `main` (the macf-actions default branch) currently tracks the v3 contract,
 * so it is treated as v3+.
 */
export function isV3PlusActionsVersion(version: string): boolean {
  if (version === 'main') return true;
  const major = parseActionsMajor(version);
  return major !== null && major >= 3;
}

/**
 * Parse a FULLY-PINNED `vMAJOR.MINOR.PATCH` tag into its numeric parts.
 * Returns `null` for anything else (a floating `v3`/`v3.4` ref, `main`, a
 * branch name) — {@link isBundleCapableActionsVersion} treats all of those
 * as NOT bundle-capable rather than guessing (see that function's doc).
 */
function parseActionsVersionTuple(version: string): readonly [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The full-tag threshold at which `agent-router.yml` accepts the single
 * bundled routing secret (`MACF_ROUTING_BUNDLE`, groundnuty/macf#1112)
 * instead of requiring `secrets: inherit` to cross the caller/callee
 * GitHub scope boundary. Bump this alongside the macf-actions release that
 * actually ships the bundle-unpacking "Resolve routing secrets" step in
 * every `route-by-*` job — this constant is the ONE place that pairing is
 * recorded, so a future minor bump only needs its number updated here.
 */
export const MIN_BUNDLE_CAPABLE_ACTIONS_VERSION = 'v3.5.0';

/**
 * True only for a FULLY-PINNED immutable tag at/above
 * {@link MIN_BUNDLE_CAPABLE_ACTIONS_VERSION}, or `main` (the macf-actions
 * dev branch — treated as always-current, same convention
 * `isV3PlusActionsVersion` already uses). A floating major/minor ref
 * (`v3`, `v3.5`) that failed to resolve to an immutable tag (see
 * `resolveActionsRefToFullTag`) is deliberately treated as NOT
 * bundle-capable: `secrets: inherit` already works unconditionally for a
 * same-scope caller, so the safe fallback on an unresolved ref is the
 * existing default, never a guess about a version this code cannot
 * confirm.
 */
export function isBundleCapableActionsVersion(version: string): boolean {
  if (version === 'main') return true;
  const tuple = parseActionsVersionTuple(version);
  if (!tuple) return false;
  const [major, minor] = tuple;
  const [minMajor, minMinor] = parseActionsVersionTuple(MIN_BUNDLE_CAPABLE_ACTIONS_VERSION)!;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * The full-tag threshold at which `agent-router.yml`'s reusable workflow
 * accepts the `runner-runs-on` input (groundnuty/macf-actions#83,
 * groundnuty/macf#1368/#1194) — the input that lets `pick-runner` FAIL a
 * declared-self-hosted fleet's job rather than silently relocating it to a
 * metered `ubuntu-latest` runner.
 *
 * Bumped to `v3.5.0` 2026-09-02 — verified live, not guessed: `gh api
 * repos/groundnuty/macf-actions/compare/7316fec...v3.5.0 --jq .status`
 * returned `"ahead"` (`v3.5.0`'s history contains commit `7316fec2`, i.e.
 * #83), and `gh api
 * repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml?ref=v3.5.0`
 * decoded to a workflow body containing 7 occurrences of `runner-runs-on`.
 * `v3.5.0` is a real released tag shipping #83.
 *
 * History — why this constant sat at `undefined` before today, and why the
 * type annotation stays `string | undefined` rather than narrowing to
 * `string` (an operator may need to unset it again the same way): verified
 * live 2026-08-30 (`gh api repos/groundnuty/macf-actions/tags`), the latest
 * RELEASED full tag was then `v3.4.2`, cut before #83 merged — #83 had
 * landed only on macf-actions' `main` (commit `7316fec2`) and had not
 * shipped in any tag. This is the exact class
 * {@link MIN_BUNDLE_CAPABLE_ACTIONS_VERSION} warns about: that constant
 * named `v3.5.0` while no such tag existed, so every real pin fell through
 * its gate and the fix it guarded was unreachable for months (see the
 * `generateWorkflow — explicit six-secret emission for a v3+ non-bundle
 * pin` test block's own citation of that incident). This constant avoided
 * repeating the mistake by staying `undefined` (meaning NO released tag was
 * treated as capable) until an operator verified — with the two live reads
 * above — that a real released tag actually shipped #83, and bumped it.
 * {@link isRunnerRunsOnCapableActionsVersion} treats `main` as capable
 * regardless — the same "dev branch always current" convention
 * {@link isV3PlusActionsVersion} and {@link isBundleCapableActionsVersion}
 * already use.
 */
export const MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION: string | undefined = 'v3.5.0';

/**
 * True only for `main`, or a FULLY-PINNED tag at/above
 * {@link MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION} (`v3.5.0` as of
 * 2026-09-02 — see that constant's doc for the live verification).
 * Compares major.minor.PATCH, unlike {@link isBundleCapableActionsVersion}'s
 * major.minor-only comparison: #83 could ship as a patch release of the
 * existing v3.4 line just as easily as a new minor, and this function must
 * not treat an already-released PATCH below the eventual threshold (e.g.
 * the already-shipped `v3.4.0`/`v3.4.1`/`v3.4.2`, none of which carry
 * `runner-runs-on`) as capable merely because it shares a major.minor with
 * a future capable patch.
 */
export function isRunnerRunsOnCapableActionsVersion(version: string): boolean {
  if (version === 'main') return true;
  if (MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION === undefined) return false;
  const tuple = parseActionsVersionTuple(version);
  const minTuple = parseActionsVersionTuple(MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION);
  if (!tuple || !minTuple) return false;
  const [major, minor, patch] = tuple;
  const [minMajor, minMinor, minPatch] = minTuple;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

/**
 * Live GitHub account-type read via the public `/users/{owner}` endpoint —
 * `.type` is `"Organization"` for an org-owned login, `"User"` for a
 * personal one (GitHub exposes orgs under the same `/users` path for
 * either kind). Unauthenticated-readable, so this resolves even before
 * `repoInit` has minted any token — label creation, the first thing in this
 * file that needs one, runs strictly later (see `repoInit`'s body). An
 * ambient `GH_TOKEN` is attached when present purely to raise the rate
 * limit; it is never required.
 *
 * Never throws — any network failure, non-OK response, or a `.type` that is
 * neither `"User"` nor `"Organization"` degrades to `'unknown'`, which
 * {@link buildRoutingRegistry} treats as a hard, loud refusal rather than a
 * silent guess (groundnuty/macf#810's honest-unknown requirement: never
 * default to `/orgs/` and let it 404 later, at the router's own registry
 * read).
 *
 * Deliberately a SEPARATE implementation from `bootstrap/manifest-scaffold.ts`'s
 * own `fetchOwnerType` (same discriminator — `GET /users/{account}` →
 * `.type`). That helper shells out to the `gh` CLI; every other GitHub read
 * in THIS file (and every existing `repo-init.test.ts` mock) goes through
 * `proxyAwareFetch`/`globalThis.fetch`. Two implementations of one fact
 * check, kept because each matches its own file's transport convention — a
 * third instance would be the signal to extract a shared helper instead.
 */
export async function fetchOwnerType(owner: string): Promise<'user' | 'org' | 'unknown'> {
  try {
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
    const token = process.env['GH_TOKEN'];
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await proxyAwareFetch(`https://api.github.com/users/${owner}`, { headers });
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { type?: unknown };
    if (body.type === 'Organization') return 'org';
    if (body.type === 'User') return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build the registry config that the v3 caller's `registry-api-path` is
 * derived from. Mirrors `macf init`'s `--registry-type` switch + reuses the
 * canonical `registryPathPrefix` mapping (DR-006). `local` registries have no
 * GitHub-Actions routing path, so they are rejected here.
 *
 * groundnuty/macf#810 — when `opts.registryType` is unset, the scope is NOT
 * a fixed default; it's derived from the owner's live GitHub account type
 * (see {@link fetchOwnerType}'s doc for why `repo` is the wrong default and
 * why the discriminator must be a fact, not a guess). Org owner → `org`
 * scope; User owner → `profile` scope (DR-006 — `/orgs/<user>` 404s
 * unconditionally against a User account); undeterminable → throw, naming
 * both explicit forms so the caller can choose rather than silently
 * receiving a scope that only fails later.
 *
 * **`case 'repo'` (groundnuty/macf#1374 fix):** `opts.registryOwner`/
 * `opts.registryRepo`, when BOTH given, name the manifest-declared target
 * verbatim — never the repo this call happens to be initializing. When
 * NEITHER is given (every bare-CLI call; no Commander flag sets them), the
 * pre-#1374 self-point default is unchanged: `owner`/`repoName` (the repo
 * `repoInit()` derived from `opts.repo` a few lines up its own call site) —
 * DR-006's documented first-choice default for an operator who hasn't
 * declared an explicit scope. A caller supplying exactly ONE of the pair is
 * a bug, not a real state (`RepoRegistryConfigSchema` requires both
 * together at the schema `apply` reads from) — fail loud rather than
 * silently mixing a manifest owner with a self-pointed repo or vice versa.
 */
async function buildRoutingRegistry(
  opts: RepoInitOptions,
  owner: string,
  repoName: string,
): Promise<RegistryConfig> {
  const regType = opts.registryType;
  if (regType === undefined) {
    const ownerType = await fetchOwnerType(owner);
    if (ownerType === 'org') return { type: 'org', org: owner };
    if (ownerType === 'user') return { type: 'profile', user: owner };
    throw new Error(
      `Could not determine whether "${owner}" is a GitHub User or Organization ` +
        '(GET /users/<owner> failed, or returned a "type" that was neither). repo-init ' +
        'refuses to guess the default registry-api-path scope — pass one explicitly: ' +
        `--registry-type org --registry-org ${owner} (org scope, "/orgs/${owner}"), or ` +
        `--registry-type profile --registry-user ${owner} (profile scope, "/repos/${owner}/${owner}").`,
    );
  }
  switch (regType) {
    case 'org':
      if (!opts.registryOrg) throw new Error('--registry-org required for org registry');
      return { type: 'org', org: opts.registryOrg };
    case 'profile':
      if (!opts.registryUser) throw new Error('--registry-user required for profile registry');
      return { type: 'profile', user: opts.registryUser };
    case 'repo': {
      const hasOwner = opts.registryOwner !== undefined;
      const hasRepo = opts.registryRepo !== undefined;
      if (hasOwner !== hasRepo) {
        throw new Error('registryOwner and registryRepo must be supplied together (or neither)');
      }
      return { type: 'repo', owner: opts.registryOwner ?? owner, repo: opts.registryRepo ?? repoName };
    }
    case 'local':
      throw new Error(
        'local registry has no GitHub-Actions routing path; macf-actions v3 routing ' +
          'requires a GitHub-backed registry. Use --registry-type repo, org, or profile.',
      );
    default:
      throw new Error(`Unknown registry type: "${regType}" (expected repo, org, or profile)`);
  }
}

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/**
 * The outcome of `repoInit`'s label-creation step (groundnuty/macf#920).
 * `'skipped'` is the pre-#920 degrade (no usable token — informational, not
 * fatal, for the plain interactive CLI); `'ok'`/`'partial-failure'`
 * distinguish "every expected label is now present" from "some label POST
 * genuinely failed" so a caller with a stake in routing actually working
 * (`apply-repo-init.ts`) can tell the two apart instead of both reading as
 * "repo-init succeeded."
 */
export type LabelsOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'ok'; readonly created: readonly string[]; readonly existed: readonly string[] }
  | { readonly status: 'partial-failure'; readonly created: readonly string[]; readonly existed: readonly string[]; readonly failed: readonly string[] };

export interface RepoInitResult {
  readonly workflow: 'created' | 'skipped';
  readonly config: 'created' | 'updated' | 'skipped';
  readonly labels: LabelsOutcome;
}

const STATUS_LABELS: readonly LabelSpec[] = [
  { name: 'in-progress', color: 'fbca04', description: 'Actively being worked on' },
  { name: 'in-review', color: '0e8a16', description: 'PR created, awaiting review' },
  { name: 'blocked', color: 'e11d48', description: 'Needs help or input' },
  { name: 'agent-offline', color: 'b60205', description: 'Agent VM unreachable' },
  // groundnuty/macf#1091: the declared "route this later, not now" signal —
  // delegation-template.md's canonical Backlog-mode label, and the escape
  // hatch check-mention-routing.sh's `create`-guard requires an agent to
  // reach for explicitly instead of silently omitting both a label and a
  // mention. Every freshly repo-init'd fleet needs this label to exist
  // before that guard can be satisfied without friction. Color/description
  // match the pre-existing `backlog` label on groundnuty/macf itself.
  { name: 'backlog', color: 'ededed', description: 'Filed for later — deliberately unassigned, not yet routed to anyone' },
];

const AGENT_LABEL_COLOR = '1d76db';

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Detect owner/repo from git remote. Uses execFileSync (no shell injection).
 */
function detectRepoFromGit(cwd: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
    if (match) return `${match[1]}/${match[2]}`;
    return null;
  } catch {
    return null;
  }
}

function validateVersion(version: string): void {
  const validPatterns = [/^v\d+$/, /^v\d+\.\d+$/, /^v\d+\.\d+\.\d+$/];
  const isTag = validPatterns.some(p => p.test(version));
  if (!isTag && version !== 'main') {
    process.stderr.write(
      `Warning: "${version}" is not a tag ref. Production repos should pin to a tag (v1, v1.0, or v1.0.0).\n`,
    );
  }
}

/**
 * Inputs threaded into the v3 reusable workflow's `with:` block (macf#566).
 * `registryApiPath` is the DR-006 API-path prefix (no trailing
 * `/actions/variables`), e.g. `/repos/<user>/<user>` for profile scope.
 */
export interface V3WorkflowInputs {
  readonly project: string;
  readonly registryApiPath: string;
  /**
   * Verbatim `routing.runner.runs_on` declaration from `fleet.yaml`
   * (groundnuty/macf#1368) — `undefined` when the fleet declares no
   * routing runner at all, which is the common case and must leave the
   * generated caller byte-identical to before this field existed.
   * `generateWorkflow` only emits it into the `with:` block when
   * {@link isRunnerRunsOnCapableActionsVersion} confirms the pinned
   * macf-actions router actually declares the input — an unknown `with:`
   * key is a hard composition error (see `isV3PlusActionsVersion`'s doc),
   * so the gate lives in `generateWorkflow` itself, not in this type.
   */
  readonly runnerRunsOn?: string;
}

export function generateWorkflow(
  actionsVersion: string,
  v3Inputs?: V3WorkflowInputs,
): string {
  const lines = [
    'name: Agent Router',
    'on:',
    '  issues:',
    '    types: [labeled, closed]',
    '  issue_comment:',
    '    types: [created]',
    // macf#980: synchronize + ready_for_review added alongside opened. A PR
    // opened while mergeStateStatus DIRTY produces ZERO workflow runs at all
    // (GitHub can't build the merge ref pull_request events test), so opened
    // — the only trigger before this fix — is unreachable for that PR's
    // whole life; a later force-push only emits synchronize, which wasn't
    // subscribed. ready_for_review closes the parallel draft->ready gap
    // (#942's disclosure ladder recommends opening a PR as --draft, and a
    // draft marked ready never routed either). See the gate job below for
    // the notification-storm suppression this addition requires.
    '  pull_request:',
    '    types: [opened, ready_for_review, synchronize]',
    '  pull_request_review:',
    '    types: [submitted]',
    // CI-completion routing (macf-actions#6, v1.3+/v3+): notify an agent when a
    // PR's checks finish. Inert on older pins (the reusable workflow's
    // route-by-ci-completion job simply doesn't fire); present so the generated
    // router is byte-consistent with macf's own committed router.
    '  check_suite:',
    '    types: [completed]',
    // The caller MUST grant at least what the reusable workflow's jobs declare,
    // or the reusable-workflow call fails at composition with `startup_failure`
    // — every event is dropped and NOTHING routes. This was the icsoc-2026
    // routing outage (macf#797): a bootstrap-generated router with NO
    // permissions block silently never routed a single event from setup until
    // an operator noticed days later. `checks: read` backs the check_suite
    // CI-completion job (without it that job 403s inside the reusable workflow).
    // Mirrors macf's own committed .github/workflows/agent-router.yml.
    'permissions:',
    '  contents: read',
    '  issues: write',
    '  pull-requests: read',
    '  checks: read',
    'jobs:',
    // ─── ROUTE GATE (macf#980) ───
    // synchronize fires on EVERY push to the PR head, and route-by-mention
    // (inside the reusable workflow) re-scans the PR body for @mentions on
    // every pull_request event with no action-type discrimination — so a
    // naive, unconditional synchronize subscription would re-notify the
    // reviewer on every push during ordinary review iteration. Worse than
    // the bug it fixes. This gate restores RECOVERY-ONLY semantics for
    // synchronize: route only when NO prior pull_request-triggered "Agent
    // Router" run exists for the PR's head branch — mirroring the
    // operator's own diagnostic (`gh run list --workflow "Agent Router"
    // --json event,headBranch --jq 'select(.headBranch=="<branch>")'`). A
    // rebase that resolves the DIRTY state (or any push that is the FIRST
    // to reach a valid merge ref) is then the natural, self-healing
    // recovery.
    //
    // opened and ready_for_review are NOT gated on prior-run recovery
    // semantics — they always route unconditionally (same as opened did
    // before macf#980), UNLESS the actor is dependabot[bot] (see the ACTOR
    // check below, which applies uniformly across every pull_request
    // action). Gating ready_for_review on "no prior run" would wrongly
    // suppress it whenever opened already fired for that PR — which it
    // does today even for draft PRs (route-by-mention doesn't discriminate
    // on draft state), so a question-carrying draft (per #942) would still
    // be silenced at the exact moment (ready_for_review) this fix exists
    // to unblock.
    //
    // Also closes a Dependabot-authored pull_request exposure
    // (groundnuty/macf#1363): the caller's secrets: block fails the
    // reusable-workflow CALL OUTRIGHT for Dependabot-authored pull_request
    // events (Dependabot PRs get an EMPTY secrets context by GitHub
    // design — a security control, not a misconfiguration), so route:
    // fails at composition ("Secret X is required, but not provided")
    // before any job body runs — a red X on a PR whose actual check may be
    // perfectly green. An earlier pass at this (macf#980) scoped the ACTOR
    // check to non-opened actions only and left opened exposed; macf#1363
    // closed that gap after six Dependabot PRs sat unreviewed for months
    // behind the false-red signal, with exactly one of the six failing on
    // its own merits (#174, a genuine TypeScript 6.0 incompatibility).
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      actions: read',
    '    outputs:',
    '      should-route: ${{ steps.decide.outputs.should-route }}',
    '    steps:',
    '      - name: Decide whether to invoke the router',
    '        id: decide',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          REPO: ${{ github.repository }}',
    '          EVENT_NAME: ${{ github.event_name }}',
    '          ACTION: ${{ github.event.action }}',
    '          ACTOR: ${{ github.actor }}',
    '          HEAD_REF: ${{ github.head_ref }}',
    '          RUN_ID: ${{ github.run_id }}',
    '        run: |',
    '          set -euo pipefail',
    '',
    '          # Only pull_request events need gating — every other trigger',
    '          # (issues, issue_comment, pull_request_review, check_suite) is',
    '          # unaffected by this fix and always routes.',
    '          if [ "$EVENT_NAME" != "pull_request" ]; then',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            exit 0',
    '          fi',
    '',
    '          # groundnuty/macf#1363: Dependabot-triggered pull_request runs',
    '          # get an EMPTY secrets context by GitHub design, so the route',
    '          # job secrets: block fails to compose regardless of ACTION —',
    '          # skip routing for every dependabot[bot]-actor pull_request',
    '          # event (opened, ready_for_review, synchronize alike) rather',
    '          # than let composition fail. An undetermined actor falls',
    '          # through to the routable branches below: failing open on',
    '          # ROUTING is safe, failing open on SECRETS is not.',
    '          if [ "$ACTOR" = "dependabot[bot]" ]; then',
    '            echo "should-route=false" >> "$GITHUB_OUTPUT"',
    '            echo "skip: dependabot[bot] actor on a pull_request event — no repository-secrets access (#1363)"',
    '            exit 0',
    '          fi',
    '',
    '          # opened + ready_for_review: always route, unconditionally.',
    '          if [ "$ACTION" != "synchronize" ]; then',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            exit 0',
    '          fi',
    '',
    '          # synchronize: recovery-only. Route only if no PRIOR pull_request-',
    '          # triggered "Agent Router" run exists for this branch, EXCLUDING',
    '          # the run this step is itself executing in (that run already',
    '          # appears in `gh run list` — without excluding RUN_ID the query',
    '          # always finds >=1 and the gate would ALWAYS suppress, permanently',
    '          # defeating the recovery path this fix exists to restore).',
    '          PRIOR_COUNT=$(gh run list --repo "$REPO" --workflow agent-router.yml \\',
    '            --branch "$HEAD_REF" --event pull_request --json databaseId \\',
    '            | jq --arg run_id "$RUN_ID" \'[.[] | select((.databaseId | tostring) != $run_id)] | length\')',
    '',
    '          if [ "${PRIOR_COUNT:-0}" -gt 0 ]; then',
    '            echo "should-route=false" >> "$GITHUB_OUTPUT"',
    '            echo "skip: $PRIOR_COUNT prior Agent Router run(s) already exist for branch $HEAD_REF — recovery-only semantics suppress this synchronize"',
    '          else',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            echo "route: no prior Agent Router run for branch $HEAD_REF — recovery synchronize"',
    '          fi',
    '  route:',
    '    needs: gate',
    "    if: needs.gate.outputs.should-route == 'true'",
    `    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@${actionsVersion}`,
  ];
  // The v3+ reusable workflow requires `project` and resolves addressing from
  // the registry via `registry-api-path` (macf#566). v1.x/v2.x callers must
  // omit `with:` entirely — those workflows declare no `workflow_call.inputs`,
  // and an unknown input is a hard error. Gate strictly on a v3+ pin.
  if (v3Inputs && isV3PlusActionsVersion(actionsVersion)) {
    lines.push('    with:');
    lines.push(`      project: ${v3Inputs.project}`);
    lines.push(`      registry-api-path: ${v3Inputs.registryApiPath}`);
    // groundnuty/macf#1368: only a pin whose workflow_call.inputs actually
    // declares `runner-runs-on` may receive it — passing an input a pinned
    // reusable workflow doesn't declare is a hard composition error (see
    // this function's own `isV3PlusActionsVersion` gate above, same
    // reasoning). A fleet that declares nothing
    // (`v3Inputs.runnerRunsOn === undefined`) emits nothing here — the
    // generated caller stays byte-identical to before this field existed.
    if (v3Inputs.runnerRunsOn !== undefined && isRunnerRunsOnCapableActionsVersion(actionsVersion)) {
      lines.push(`      runner-runs-on: ${v3Inputs.runnerRunsOn}`);
    }
  }
  // groundnuty/macf#1112 / #1338: `secrets: inherit` does not cross a GitHub
  // org/enterprise scope boundary. Confirmed twice now — live on macf#1111
  // (an org-owned fleet's caller failed at secret evaluation before any
  // step ran) AND again on macf#1338 against every currently-released
  // `macf-actions` v3.x tag (v3.0.0 through v3.4.2, verified live via `gh
  // api repos/groundnuty/macf-actions/tags` — there is no v3.5.0 yet) —
  // and confirmed against GitHub's own current docs (fetched live, not
  // from training data): "Workflows that call reusable workflows in the
  // same organization or enterprise can use the `inherit` keyword to
  // implicitly pass the secrets." A provisioned fleet's agent repos live
  // in the fleet's own org, never `groundnuty` (where `macf-actions`
  // lives), so `inherit` is unconditionally the wrong form for a v3+
  // caller today.
  //
  // A bundle-capable pin (>= MIN_BUNDLE_CAPABLE_ACTIONS_VERSION, not yet
  // released) gets the single `MACF_ROUTING_BUNDLE` secret — the caller's
  // interface then never depends on the callee's secret set, so a future
  // secret addition on the callee side can't break an already-generated
  // caller the way explicit-six passing would.
  //
  // Every currently-released v3.x tag's `workflow_call.secrets` block has
  // been the SAME six required names since v3.0.0 (verified live across
  // v3.0.0 and v3.4.2) — passing them EXPLICITLY by name is unrestricted
  // by org boundary (only the `inherit` shorthand is org-scoped, per the
  // docs quote above) and needs no macf-actions release beyond what's
  // already shipped. This is the fallback for every v3+ pin below the
  // bundle threshold — i.e. every v3+ pin that exists today.
  //
  // v1.x/v2.x (legacy, permanent-Stage-2 substrate pins per the operator's
  // 2026-04-27 directive) are UNCHANGED — they're used exclusively by
  // same-org (`groundnuty`) substrate workspaces, where `inherit` already
  // works, and their `workflow_call.secrets` sets differ from the v3.x
  // six (v1.x: `AGENT_SSH_KEY` + 2; v2.x: 4 — verified live), so blindly
  // emitting the v3 six-name form for them would be wrong.
  if (isBundleCapableActionsVersion(actionsVersion)) {
    lines.push('    secrets:');
    lines.push(`      ${ROUTING_BUNDLE_SECRET_NAME}: \${{ secrets.${ROUTING_BUNDLE_SECRET_NAME} }}`);
  } else if (v3Inputs && isV3PlusActionsVersion(actionsVersion)) {
    lines.push('    secrets:');
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      lines.push(`      ${name}: \${{ secrets.${name} }}`);
    }
  } else {
    lines.push('    secrets: inherit');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Agent-config entry schema.
 *
 * `tmux_window` is optional: when present the routing workflow sends to
 * `${tmux_session}:${tmux_window}` (per-agent window inside a shared
 * session); when absent it sends to just `${tmux_session}` (legacy layout,
 * one session per agent). See groundnuty/macf#69 and the matching workflow
 * support in `groundnuty/macf-actions` v1.1.
 */
interface AgentConfigEntry {
  app_name: string;
  host: string;
  /**
   * Stage-2 (v1.x SSH-router) send-target: the router SSHes in and sends to
   * `${tmux_session}` (or `${tmux_session}:${tmux_window}`). Load-bearing for
   * v1.x routing (which reads addressing from this file), but VESTIGIAL on v3+
   * where routing resolves the channel endpoint from the MACF registry instead.
   * Omitted from the generated template on a v3+ pin (macf#678) so `macf routing
   * doctor`'s SESSION check reads `absent` (= PASS) rather than the false
   * `tmux_session "<label>" != "<project>@<routing-label>"` WARN — the field held
   * the bare label, never the canonical `<project>@<routing-label>` session name.
   */
  tmux_session?: string;
  tmux_window?: string;
  ssh_user: string;
  tmux_bin: string;
  ssh_key_secret: string;
  /**
   * Absolute path to the agent's workspace on the remote host. When set,
   * the routing workflow invokes `$workspace_dir/.claude/scripts/tmux-send-to-claude.sh`
   * (the canonical helper shipped by #56/#61) instead of inlining the
   * tmux-submit pattern. See groundnuty/macf#71 + macf-actions v1.2.
   * Optional: absent → routing falls back to the inline pattern
   * (backward compatible with pre-v1.2 agent-router.yml).
   */
  workspace_dir?: string;
}

/**
 * Options passed to generate/patch helpers so they can compute sensible
 * default values for new entries. Owner/repo come from `--repo`; ssh_user
 * defaults to 'ubuntu' matching the other template defaults.
 */
export interface AgentEntryDefaults {
  readonly owner?: string;
  readonly repo?: string;
  /**
   * Routing "project" (macf#806). When present, a freshly-created entry's
   * `app_name` becomes `<project>-<agent>` — the GitHub App handle per
   * DR-032 (the App handle carries the `<project>-` prefix; the bare
   * `<agent>` is only the routing label/agent-config key). This is the
   * SAME value threaded into the v3 caller's `with.project` input
   * (`opts.project ?? repoName`), so a repo's agent-config.json and its
   * router agree on which project's Apps they address. Omitted (legacy
   * callers, or callers with no notion of "project") → `app_name` stays
   * the bare agent/routing label, matching pre-#806 behavior.
   */
  readonly project?: string;
}

const DEFAULT_LABEL_TO_STATUS: Readonly<Record<string, string>> = {
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'blocked': 'Blocked',
};

interface AgentConfigFile {
  agents: Record<string, AgentConfigEntry>;
  label_to_status?: Record<string, string>;
  [key: string]: unknown;
}

function makeAgentEntry(
  agent: string,
  useWindows: boolean,
  sessionName: string | undefined,
  defaults?: AgentEntryDefaults,
  omitTmuxSession = false,
): AgentConfigEntry {
  const sshUser = 'ubuntu';
  // app_name is the GitHub App handle used by the router to resolve mention/
  // review participants (`${app_name}[bot]`) — NOT just a routing label. Per
  // DR-032, the App handle is `<project>-<agent>`; the bare `<agent>` is only
  // the routing-label/agent-config key. When the caller knows the project
  // (macf#806), prefix it; legacy/no-project callers keep the pre-#806
  // unprefixed default. Never append `[bot]` here — the router appends it.
  const appName = defaults?.project ? `${defaults.project}-${agent}` : agent;
  const entry: AgentConfigEntry = {
    app_name: appName,
    host: '<agent-host-ip>',
    // v3+ (registry-routed): omit the vestigial Stage-2 send-target (macf#678).
    ...(omitTmuxSession ? {} : { tmux_session: useWindows ? sessionName! : agent }),
    ssh_user: sshUser,
    tmux_bin: 'tmux',
    ssh_key_secret: 'AGENT_SSH_KEY',
  };
  if (useWindows && !omitTmuxSession) entry.tmux_window = agent;
  // Default workspace_dir = /home/<ssh_user>/repos/<owner>/<repo>. Covers
  // the common case where agents are cloned into ~/repos/<owner>/<repo>
  // on the host. Users override per-agent if their layout differs.
  if (defaults?.owner && defaults?.repo) {
    entry.workspace_dir = `/home/${sshUser}/repos/${defaults.owner}/${defaults.repo}`;
  }
  return entry;
}

export function generateAgentConfig(
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
  omitTmuxSession = false,
): string {
  if (agents.length === 0) {
    return JSON.stringify({
      agents: {
        '<agent-name>': {
          app_name: '<github-app-name>',
          host: '<agent-host-ip>',
          // v3+ (registry-routed) omits the vestigial Stage-2 send-target (macf#678).
          ...(omitTmuxSession ? {} : { tmux_session: '<tmux-session-name>' }),
          ssh_user: 'ubuntu',
          tmux_bin: 'tmux',
          ssh_key_secret: 'AGENT_SSH_KEY',
          workspace_dir: '/home/ubuntu/repos/<owner>/<repo>',
        },
      },
      label_to_status: { ...DEFAULT_LABEL_TO_STATUS },
    }, null, 2) + '\n';
  }

  const useWindows = !!sessionName && agents.length > 1;

  const agentEntries: Record<string, AgentConfigEntry> = {};
  for (const agent of agents) {
    agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults, omitTmuxSession);
  }
  return JSON.stringify({
    agents: agentEntries,
    label_to_status: { ...DEFAULT_LABEL_TO_STATUS },
  }, null, 2) + '\n';
}

/**
 * DR-032 double-prefix repair (macf#791/#805). Before the bootstrap SKILL's
 * naming guidance was corrected, operators were told the agent NAME *was*
 * the GitHub App handle, so `--agents` got invoked with the already-prefixed
 * form (`<project>-<agent>`) and the map KEY itself ended up carrying the
 * project prefix instead of the bare routing label. `agent-config.json`'s
 * key is exactly what `route-by-label` looks the issue's clean `<role>-agent`
 * label up against — a lingering double-prefixed key means the lookup
 * silently misses (`route-by-label` skips with `exit 0`, "not an agent
 * label"), with no error anywhere (see `silent-fallback-hazards.md`). A
 * separate 2026-06-27 rename pass fixed cert CN / registry keys / tmux
 * sessions on the live icsoc-2026 fleet but missed this file, so the stale
 * key can still be sitting in an already-committed agent-config.json.
 *
 * Scope is deliberately narrow: only agents named in THIS run's `--agents`
 * list are considered (mirrors the "agents not in --agents are left alone"
 * contract of `patchAgentConfig` itself) — a blind `<project>-` prefix strip
 * over every existing key would risk false-positiving on a legitimately
 * named agent that happens to start with the project's name. And a clean
 * key is never clobbered by a stale duplicate: if both `<agent>` and
 * `<project>-<agent>` are present, the clean entry's data wins and the
 * stale duplicate is left for the operator to clean up by hand (no data is
 * silently discarded here, no destructive migration is invented — the
 * mutation is a rename, applied only when it is unambiguously safe).
 */
function normalizeDoublePrefixedKeys(
  agents: Record<string, AgentConfigEntry>,
  agentList: readonly string[],
  project: string | undefined,
): void {
  if (!project) return; // can't distinguish "double-prefixed" from "legitimately named" without it
  for (const agent of agentList) {
    if (agent in agents) continue; // clean key already present — never overwritten by a stale duplicate
    const staleKey = `${project}-${agent}`;
    if (staleKey === agent) continue; // degenerate empty-project guard
    const stale = agents[staleKey];
    if (!stale) continue;
    agents[agent] = stale;
    delete agents[staleKey];
  }
}

/**
 * Merge-preserving regenerate for #76: update only tmux_session/tmux_window
 * fields from user input, preserve app_name/host/ssh_key_secret/ssh_user
 * /tmux_bin/unknown-fields, preserve top-level label_to_status and extras.
 * Agents not in the --agents list are left alone.
 *
 * When `omitTmuxSession` is set (a v3+ registry-routed pin, macf#678) the patch
 * DELETES the vestigial `tmux_session`/`tmux_window` from re-patched entries so a
 * substrate agent re-running `macf repo-init` at v3 sheds the leftover Stage-2
 * send-target — clearing `macf routing doctor`'s false SESSION WARN.
 *
 * Before touching any entry, also repairs a DR-032 double-prefixed key left
 * over from a pre-fix bootstrap run or an incomplete rename pass (macf#805)
 * — see `normalizeDoublePrefixedKeys` above.
 */
export function patchAgentConfig(
  existingJson: string,
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
  omitTmuxSession = false,
): string {
  let parsed: AgentConfigFile;
  try {
    parsed = JSON.parse(existingJson) as AgentConfigFile;
  } catch {
    throw new Error('Existing agent-config.json is not valid JSON; aborting rather than overwrite.');
  }
  if (!parsed.agents || typeof parsed.agents !== 'object') {
    throw new Error('Existing agent-config.json has no `agents` object; aborting.');
  }

  // Repair any DR-032 double-prefixed key BEFORE the merge loop below reads
  // `parsed.agents[agent]` — normalizing in place here means the loop's
  // existing-entry lookup transparently finds the (now-renamed) entry and
  // preserves its fields, same as any other pre-existing agent (macf#805).
  normalizeDoublePrefixedKeys(parsed.agents, agents, defaults?.project);

  const useWindows = !!sessionName && agents.length > 1;
  const agentEntries: Record<string, AgentConfigEntry> = { ...parsed.agents };

  for (const agent of agents) {
    const existing = parsed.agents[agent];
    if (!existing) {
      agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults, omitTmuxSession);
      continue;
    }
    const patched: AgentConfigEntry = { ...existing };
    if (omitTmuxSession) {
      // v3+ (registry-routed): shed the vestigial Stage-2 send-target (macf#678).
      delete patched.tmux_session;
      delete patched.tmux_window;
    } else {
      patched.tmux_session = useWindows ? sessionName! : agent;
      if (useWindows) {
        patched.tmux_window = agent;
      } else {
        delete patched.tmux_window;
      }
    }
    if (!patched.ssh_key_secret) patched.ssh_key_secret = 'AGENT_SSH_KEY';
    // Inject workspace_dir default for old entries that lack it, so
    // existing configs self-upgrade to enable helper invocation without
    // requiring a hand-edit. Users can customize afterwards.
    if (!patched.workspace_dir && defaults?.owner && defaults?.repo) {
      patched.workspace_dir = `/home/${patched.ssh_user || 'ubuntu'}/repos/${defaults.owner}/${defaults.repo}`;
    }
    agentEntries[agent] = patched;
  }

  const out: AgentConfigFile = { ...parsed, agents: agentEntries };
  if (!out.label_to_status) {
    out.label_to_status = { ...DEFAULT_LABEL_TO_STATUS };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

export async function createLabel(
  owner: string,
  repo: string,
  token: string,
  spec: LabelSpec,
): Promise<'created' | 'exists' | 'failed'> {
  const res = await proxyAwareFetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: spec.name,
      color: spec.color,
      description: spec.description,
    }),
  });

  if (res.status === 201) return 'created';
  if (res.status === 422) return 'exists';
  return 'failed';
}

/**
 * `validate`, when given, runs ONLY on the branch that actually writes —
 * never on the "existing file, no --force" skip branch (groundnuty/macf#886).
 * That scoping matters: an unrelated pre-existing file left untouched by a
 * plain re-run must never fail this check, because the content the
 * validator would inspect is never used. A throw from `validate` propagates
 * before `writeFileSync` runs, so a degraded artifact never touches disk.
 */
function writeFileSafe(
  path: string,
  content: string,
  force: boolean,
  validate?: (content: string) => void,
): 'created' | 'skipped' {
  if (existsSync(path) && !force) {
    process.stderr.write(`Skipping existing file (use --force to overwrite): ${path}\n`);
    return 'skipped';
  }
  validate?.(content);
  ensureDir(path);
  writeFileSync(path, content);
  return 'created';
}

/**
 * Bootstrap a repo for MACF routing.
 */
export async function repoInit(
  projectDir: string,
  opts: RepoInitOptions,
): Promise<RepoInitResult> {
  const absDir = resolve(projectDir);

  validateVersion(opts.actionsVersion);

  // groundnuty/macf#886 — companion signal to the artifact self-check below
  // (`assertRouterWorkflowWellFormed`). Reuses the existing stale-dist
  // detector (previously wired only into `macf update`) so a dev/git-clone
  // install that's behind its own source HEAD gets an early, causal hint
  // pointing at WHY the output might be wrong. Deliberately a WARNING, not a
  // block: staleness is a proxy, not proof — it says nothing about whether
  // THIS command's output is actually affected, and (per the detector's own
  // fail-soft contract) it has no signal at all for an install with no
  // `.git/` directory. The artifact check below is what actually blocks a
  // bad emission; this is strictly an earlier, narrower hint for the subset
  // of installs it can see.
  const cliPackageRoot = findCliPackageRoot();
  const staleDist = detectStaleDist(cliPackageRoot);
  if (staleDist) {
    process.stderr.write(
      'Warning: the installed macf CLI dist/ is stale.\n' +
        `  built from: ${staleDist.buildCommit.slice(0, 7)} (at ${staleDist.builtAt})\n` +
        `  source HEAD: ${staleDist.currentCommit.slice(0, 7)}\n` +
        '  The files this command generates may not reflect the latest repo-init behavior.\n' +
        `  Fix: run \`macf self-update\` (or \`cd ${cliPackageRoot} && npm run build\`) and re-run repo-init.\n`,
    );
  }

  // macf#797 + operator decision 2026-07-05: the router pin must be an
  // IMMUTABLE full tag (`v3.4.1`), not a floating major/minor (`v3`/`v3.4`),
  // so a fleet never silently receives a behavioral change within a major
  // (floating `@v3` currently even lags `@v3.4.1`; behavioral shifts like
  // v3.4.0 origin-routing ship inside the major). Resolve a floating v3+ ref
  // to the latest full tag at generation time. Degrade LOUDLY — keep the
  // floating ref + warn — if GitHub is unreachable, rather than hard-fail,
  // since repo-init otherwise tolerates offline (e.g. label creation is
  // skipped without a token). Legacy v1.x/v2.x pins (operator-authored
  // substrate routers, not bootstrap-generated) are left untouched.
  let pinnedVersion = opts.actionsVersion;
  if (
    isV3PlusActionsVersion(opts.actionsVersion) &&
    !isImmutableActionsTag(opts.actionsVersion) &&
    opts.actionsVersion !== 'main'
  ) {
    const resolved = await resolveActionsRefToFullTag(opts.actionsVersion);
    if (resolved) {
      pinnedVersion = resolved;
      process.stderr.write(
        `✓ Pinned router to immutable ${resolved} (resolved from floating "${opts.actionsVersion}").\n`,
      );
    } else {
      process.stderr.write(
        `Warning: could not resolve "${opts.actionsVersion}" to an immutable full tag ` +
          `(GitHub unreachable or no matching vX.Y.Z). The router will pin the FLOATING ref ` +
          `"${opts.actionsVersion}", which can silently receive behavioral changes. ` +
          `Re-run with --actions-version vX.Y.Z to pin immutably.\n`,
      );
    }
  }

  const repo = opts.repo ?? detectRepoFromGit(absDir);
  if (!repo) {
    throw new Error(
      '--repo required (or run from a git repo with a GitHub origin remote)',
    );
  }
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
  }
  const [owner, repoName] = parts;

  const agentList = opts.agents ? opts.agents.split(',').map(s => s.trim()).filter(Boolean) : [];

  const workflowPath = join(absDir, '.github', 'workflows', 'agent-router.yml');
  const configPath = join(absDir, '.github', 'agent-config.json');

  // Resolve the routing "project" once — it feeds BOTH the v3 caller's
  // `with.project` input AND the agent-config.json `app_name` (macf#806): per
  // DR-032 the GitHub App handle is `<project>-<agent>`, and that's true
  // regardless of router major version (a v1.x-routed fleet still registers
  // its Apps under the prefixed handle). Computed unconditionally so
  // `app_name` is correct even on a v1.x/legacy pin.
  const project = opts.project ?? repoName!;

  // macf#566: a v3+ pin needs the `project` + `registry-api-path` inputs in the
  // generated caller; a v1.x pin must omit them. Resolve the v3 inputs only
  // when the pin is v3+ so `repo-init --actions-version v1.x` still emits a
  // valid v1 caller.
  let v3Inputs: V3WorkflowInputs | undefined;
  if (isV3PlusActionsVersion(pinnedVersion)) {
    if (!isValidProjectName(project)) {
      throw new Error(`Invalid project name "${project}": must match [a-zA-Z0-9_-]+`);
    }
    const registry = await buildRoutingRegistry(opts, owner!, repoName!);
    v3Inputs = { project, registryApiPath: registryPathPrefix(registry) };

    // groundnuty/macf#1368 — thread the manifest's declared runner intent
    // through, but only when the pinned macf-actions router actually
    // accepts it (an unknown `with:` key is a hard composition error).
    // Below-threshold pins are told LOUDLY why the declaration was
    // dropped rather than silently omitted, per this issue's own "reason
    // stated" requirement — `generateWorkflow` itself is a pure string
    // generator with no I/O, so the warning lives here, at the one caller
    // that has both the declared value and a place to print to stderr.
    if (opts.routingRunnerRunsOn !== undefined) {
      if (isRunnerRunsOnCapableActionsVersion(pinnedVersion)) {
        v3Inputs = { ...v3Inputs, runnerRunsOn: opts.routingRunnerRunsOn };
      } else {
        // Citation guard (macf#1061): this string must stand on its own —
        // no internal issue numbers (see this module's own doc comment
        // above, a maintainer-facing surface, for the actual references).
        process.stderr.write(
          `Warning: routing.runner.runs_on is declared ("${opts.routingRunnerRunsOn}") but the pinned macf-actions ` +
            `router "${pinnedVersion}" does not accept the runner-runs-on input — that requires macf-actions ` +
            `${MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION} or later (or the unreleased "main"). The generated ` +
            'agent-router.yml will NOT declare this runner intent to the router; re-run repo-init with an ' +
            `actionsVersion pin at or above ${MIN_RUNNER_RUNS_ON_CAPABLE_ACTIONS_VERSION}.\n`,
        );
      }
    }
  }

  // groundnuty/macf#886 — the artifact self-check: assert the emitted
  // content actually carries every element the reusable workflow consumes
  // BEFORE it is written to disk. Runs only on the branch that would
  // actually write (see `writeFileSafe`'s doc) — an unrelated existing file
  // left alone by a plain re-run is never affected.
  const workflowResult = writeFileSafe(
    workflowPath,
    generateWorkflow(pinnedVersion, v3Inputs),
    opts.force,
    assertRouterWorkflowWellFormed,
  );

  // Agent-config handling: always merge-preserve when the file exists,
  // regardless of --force (#82). Previously --force was required even to
  // add new agents to an existing config; the "fresh template wins"
  // semantic was a UX trap — users running `macf repo-init --agents foo`
  // on an existing repo saw "Skipping existing file" and thought agents
  // were scaffolded when nothing changed.
  //
  // --force now only controls the workflow file (agent-router.yml) — the
  // workflow is regenerated from scratch (no fields to preserve), so the
  // old "don't overwrite" guard still makes sense there.
  //
  // Patch is safe to call repeatedly: unchanged inputs produce the same
  // output (idempotent), new agents are added, existing agent entries
  // preserve app_name/host/ssh_key_secret/ssh_user/tmux_bin/workspace_dir,
  // and top-level label_to_status + unknown keys pass through. `project`
  // (macf#806) makes freshly-created entries' `app_name` the DR-032 App
  // handle (`<project>-<agent>`) instead of the bare routing label —
  // required for `route-by-mention`/`route-by-pr-review-state` to resolve
  // `${app_name}[bot]` against the participant's actual GitHub login.
  const entryDefaults: AgentEntryDefaults = { owner: owner!, repo: repoName!, project };
  // v3+ routing resolves the channel endpoint from the MACF registry, so the
  // agent-config.json `tmux_session` send-target is vestigial and only drives a
  // false `macf routing doctor` SESSION WARN — omit it on v3+ (macf#678). v1.x
  // still reads addressing from this file, so keep it there.
  const omitTmuxSession = isV3PlusActionsVersion(opts.actionsVersion);
  let configResult: 'created' | 'updated' | 'skipped';
  if (existsSync(configPath)) {
    const patched = patchAgentConfig(
      readFileSync(configPath, 'utf-8'),
      agentList,
      opts.sessionName,
      entryDefaults,
      omitTmuxSession,
    );
    writeFileSync(configPath, patched);
    configResult = 'updated';
  } else {
    const fresh = generateAgentConfig(agentList, opts.sessionName, entryDefaults, omitTmuxSession);
    const writeRes = writeFileSafe(configPath, fresh, false);
    configResult = writeRes;  // 'created' (file didn't exist) is the expected path
  }

  const allLabels: LabelSpec[] = [...STATUS_LABELS];
  for (const agent of agentList) {
    allLabels.push({
      name: agent,
      color: AGENT_LABEL_COLOR,
      description: `Assigned to ${agent}[bot]`,
    });
  }

  let token: string;
  try {
    token = await generateToken(opts.tokenSource);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Warning: could not generate token (${reason}). Skipping label creation.\n`);
    const labels: LabelsOutcome = { status: 'skipped', reason };
    printResults(workflowResult, configResult, labels);
    printNextSteps(configResult, agentList, opts.actionsVersion);
    return { workflow: workflowResult, config: configResult, labels };
  }

  const created: string[] = [];
  const existed: string[] = [];
  const failed: string[] = [];

  for (const spec of allLabels) {
    const result = await createLabel(owner, repoName, token, spec);
    if (result === 'created') created.push(spec.name);
    else if (result === 'exists') existed.push(spec.name);
    else failed.push(spec.name);
  }

  // groundnuty/macf#920 — `failed` is NOT swallowed into the same "success"
  // shape as `created`/`existed`: a caller that threaded a real tokenSource
  // (i.e. can actually tell whether this run COULD have succeeded) needs to
  // distinguish "every expected label is present" from "the API rejected
  // some of them" — see `apply-repo-init.ts`'s use of this field.
  const labels: LabelsOutcome = failed.length === 0 ? { status: 'ok', created, existed } : { status: 'partial-failure', created, existed, failed };

  printResults(workflowResult, configResult, labels);
  printNextSteps(configResult, agentList, opts.actionsVersion);
  return { workflow: workflowResult, config: configResult, labels };
}

function printResults(
  workflowResult: 'created' | 'skipped',
  configResult: 'created' | 'updated' | 'skipped',
  labels: LabelsOutcome,
): void {
  if (workflowResult === 'created') console.log('✓ Created .github/workflows/agent-router.yml');
  if (configResult === 'created') console.log('✓ Created .github/agent-config.json');
  if (configResult === 'updated') console.log('✓ Patched .github/agent-config.json (preserving existing entries)');
  if (labels.status === 'skipped') return; // the "Skipping label creation" warning was already printed at the call site
  if (labels.created.length > 0) console.log(`✓ Created labels: ${labels.created.join(', ')}`);
  if (labels.existed.length > 0) console.log(`  Labels already exist: ${labels.existed.join(', ')}`);
  if (labels.status === 'partial-failure') console.error(`✗ Failed to create labels: ${labels.failed.join(', ')}`);
}

/**
 * groundnuty/macf#1109 — audited every secret this block used to list
 * unconditionally, one verdict each:
 *
 *   - `AGENT_SSH_KEY` — OBSOLETE for a v3+ pin. `agent-router.yml`'s own
 *     module doc (fetched off `main`) says so explicitly: "Legacy fields
 *     carried over from v1.x / v2.x consumers (`host`, `port`,
 *     `tmux_session`, `tmux_bin`, `ssh_user`, `ssh_key_secret`) may remain
 *     in the file but are unread under v3." Gated on
 *     `isV3PlusActionsVersion` below — still genuinely needed for a v1.x/
 *     v2.x pin (Stage-2 SSH+tmux routing), so it stays for THAT caller.
 *   - `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` — genuinely
 *     operator-supplied for a v3+ pin (Amendment C: never tool-minted), but
 *     NOT "one of several tidy-up items" the way this text used to read —
 *     `agent-router.yml@v3.4.2` declares both `required: true`
 *     unconditionally, so the routing plane will not function without
 *     them. Wording below states that consequence explicitly rather than
 *     reading as bland housekeeping. (`macf bootstrap apply` publishes
 *     these from the operator's vault automatically when present — see
 *     `apply-fleet.ts` — this manual instruction is what's left for a
 *     standalone `macf repo-init` run with no vault, or an apply run whose
 *     vault genuinely didn't have them.)
 */
function printNextSteps(
  configResult: 'created' | 'updated' | 'skipped',
  agentList: readonly string[],
  actionsVersion: string,
): void {
  console.log('\nNext steps:\n');
  if (configResult === 'created' && agentList.length === 0) {
    console.log('  1. Edit .github/agent-config.json to set your agents\' hosts and tmux sessions');
  } else if (configResult === 'created') {
    console.log('  1. Edit .github/agent-config.json and replace <agent-host-ip> placeholders');
  } else if (configResult === 'updated') {
    console.log('  1. Review .github/agent-config.json — existing entries preserved, only tmux fields updated');
  }
  console.log('  2. Set repo secrets (Settings → Secrets and variables → Actions):');
  if (!isV3PlusActionsVersion(actionsVersion)) {
    console.log('       - AGENT_SSH_KEY: SSH private key for connecting to agent hosts');
  }
  console.log('       - TS_OAUTH_CLIENT_ID: Tailscale OAuth client ID — REQUIRED: routing will not function until this is set (agent-router.yml declares it mandatory; the GitHub-hosted runner cannot reach agent VMs without joining the tailnet through it)');
  console.log('       - TS_OAUTH_SECRET: Tailscale OAuth secret — REQUIRED, same as above');
  console.log('  3. Install your agent GitHub Apps on this repo');
  console.log('  4. Commit and push: git add .github/ && git commit -m "chore: bootstrap MACF routing"');
}
