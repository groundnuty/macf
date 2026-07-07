import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInstallRepoLister } from '../../cli/commands/routing-doctor-gh.js';

const execFileAsync = promisify(execFile);

export interface PendingIssue {
  readonly number: number;
  readonly title: string;
  /** Which repo this issue lives in. Set when checked across the App install-set. */
  readonly repo?: string;
}

/**
 * Check for pending GitHub issues assigned to this agent in ONE repo.
 */
export async function checkIssues(config: {
  readonly repo: string;
  readonly label: string;
  readonly token: string;
}): Promise<readonly PendingIssue[]> {
  const { repo, label, token } = config;

  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--label', label,
      '--state', 'open',
      '--json', 'number,title',
    ], {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: token },
    });

    const parsed = JSON.parse(stdout) as ReadonlyArray<{
      readonly number: number;
      readonly title: string;
    }>;
    return parsed.map((issue) => ({ ...issue, repo }));
  } catch (err) {
    process.stderr.write(
      `Warning: failed to check issues in ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/**
 * Check for pending GitHub issues assigned to this agent ACROSS EVERY repo the
 * agent's GitHub App is installed on (DR-038 Decision 7).
 *
 * The queue-source is `{repos the App is installed on} x {the agent's label}`
 * — complete by construction. Per DR-038 Decision 7: the App install-set IS
 * the globally-unique "repos that are mine", and install-boundary =
 * action-boundary = queue-boundary — an agent literally cannot act outside
 * its install set, so this enumeration is complete by construction, not
 * best-effort. Replaces the prior single-repo queue-source (`checkIssues`
 * called once against a hardcoded/`MACF_REGISTRY_REPO`-configured repo in
 * `macf-plugin-cli.ts`'s `issues` command), which silently missed any routed
 * issue filed in a repo other than the one configured.
 *
 * NOT a global label-search (`gh search issues --label <mine>` poisons with
 * unrelated strangers' same-named labels on unrelated repos — verified during
 * DR-008 §5/§6) and NOT the bot login as assignee (`[bot]` cannot be a GitHub
 * assignee — 404). The install-set x label join is the only complete +
 * correct source.
 *
 * Reuses the SAME `/installation/repositories` enumeration primitive as
 * `macf routing doctor` (`createInstallRepoLister`, DR-030 Q3) and the
 * planned `macf onboard-agent` (#698) — DR-038 Decision 7 explicitly calls
 * for one shared App-install-set primitive, not a second hand-rolled
 * enumeration + auth path.
 *
 * Fail-soft per repo: an inaccessible repo (revoked access, 404, transient
 * 5xx) warns to stderr and is skipped — it does NOT blank the whole queue.
 * `checkOneRepo` (default: `checkIssues`) already fails soft internally and
 * returns `[]` on error; the try/catch here is a second line of defense so a
 * custom injected `checkOneRepo` that throws can't take down the aggregate
 * either. A single-install App behaves exactly like the old single-repo
 * `checkIssues` call (one repo in, same issues out).
 */
export async function checkIssuesAcrossFleet(config: {
  readonly label: string;
  readonly token: string;
  /** Override for tests; defaults to the real `/installation/repositories` lister. */
  readonly listInstallRepos?: () => Promise<readonly string[]>;
  /** Override for tests; defaults to `checkIssues` against one repo. */
  readonly checkOneRepo?: (
    repo: string,
    label: string,
    token: string,
  ) => Promise<readonly PendingIssue[]>;
}): Promise<readonly PendingIssue[]> {
  const { label, token } = config;
  const listInstallRepos = config.listInstallRepos ?? createInstallRepoLister(token);
  const checkOneRepo =
    config.checkOneRepo ?? ((repo, l, t) => checkIssues({ repo, label: l, token: t }));

  const repos = await listInstallRepos();
  if (repos.length === 0) return [];

  const perRepo = await Promise.all(
    repos.map(async (repo): Promise<readonly PendingIssue[]> => {
      try {
        return await checkOneRepo(repo, label, token);
      } catch (err) {
        process.stderr.write(
          `Warning: failed to check issues in ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return [];
      }
    }),
  );

  return dedupePendingIssues(perRepo.flat());
}

/**
 * Dedup a `PendingIssue` list by `${repo}#${number}`. Shared by
 * `checkIssuesAcrossFleet` (guards against a pagination fluke in the
 * install-repo lister, or an overlapping custom `checkOneRepo` returning
 * the same issue twice) and `checkAllPendingWork` (macf#816 — the SAME
 * issue can legitimately surface from BOTH the install-set x label join
 * AND the `involves:` search, e.g. an issue that is both labeled for this
 * agent and one it was @mentioned on). In the common case (each issue
 * surfaces once) this is a no-op pass-through.
 */
function dedupePendingIssues(issues: readonly PendingIssue[]): PendingIssue[] {
  const seen = new Set<string>();
  const deduped: PendingIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.repo ?? ''}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

/**
 * Resolve THIS agent's searchable GitHub login — the DR-032 handle-stem
 * `<project>-<name>` (e.g. `macf-code-agent`, `icsoc-2026-code-agent`) —
 * from the two identity env vars `claude.sh` exports (`MACF_PROJECT` +
 * `MACF_AGENT_NAME`; DR-032's `project` + `name` fields).
 *
 * Deliberately reads the RAW env vars rather than `macf-plugin-cli.ts`'s
 * own defaulted locals (`agentName ?? 'unknown'`, `project ?? 'MACF'`):
 * composing a login from those fallbacks would silently search for the
 * bogus login `MACF-unknown` instead of skipping the leg. Returns
 * `undefined` when either is unset/blank so the caller
 * (`checkAllPendingWork`) can fail-soft by skipping the `involves:` leg
 * entirely rather than guessing (macf#816).
 *
 * The `[bot]` suffix is intentionally NOT appended here — see
 * `searchInvolvesIssues`, the only place it's hardcoded — so a caller
 * that logs/composes `selfLogin` on its own sees the bare handle-stem.
 */
export function resolveSelfLogin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const project = env['MACF_PROJECT']?.trim();
  const agentName = env['MACF_AGENT_NAME']?.trim();
  if (!project || !agentName) return undefined;
  return `${project}-${agentName}`;
}

/**
 * Cap on `gh search issues --involves` results (macf#816) — generous for a
 * per-agent queue without risking an unbounded response for a very
 * socially-active bot account. `gh search issues -L` paginates internally
 * up to this count in a single command — no manual page-loop needed.
 */
const INVOLVES_SEARCH_LIMIT = 100;

/**
 * Default `involves:` search — `gh search issues --involves <login>`.
 * Isolated from `searchInvolvesIssues` so the query shape (the exact `gh`
 * invocation) is independently exercisable without needing a fake
 * `listSearch` injectable for every test.
 */
async function defaultListSearch(
  login: string,
  token: string,
): Promise<readonly PendingIssue[]> {
  const { stdout } = await execFileAsync('gh', [
    'search', 'issues',
    '--involves', login,
    '--state', 'open',
    '--json', 'number,title,repository',
    '-L', String(INVOLVES_SEARCH_LIMIT),
  ], {
    encoding: 'utf-8',
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 16 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout) as ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly repository: { readonly nameWithOwner: string };
  }>;
  return parsed.map((issue) => ({
    number: issue.number,
    title: issue.title,
    repo: issue.repository.nameWithOwner,
  }));
}

/**
 * Search GitHub for OPEN issues this agent is INVOLVED in — GitHub's
 * `involves:` qualifier (author ∪ assignee ∪ mentions ∪ commenter), keyed
 * on the agent's globally-unique bot LOGIN (macf#816, devops-verified live
 * on the issue thread).
 *
 * This is the GENERIC complement to `checkIssuesAcrossFleet`'s install-set
 * x label join (DR-038 Decision 7): that join is complete WITHIN the
 * App's install-set but bounded to it — a routed issue filed on a repo the
 * App isn't installed on (e.g. a cross-fleet guest task on a third-party
 * public repo) is invisible to it. `involves:` surfaces those too, because
 * it's keyed on the bot account, not on repo membership.
 *
 * POISON-FREE by construction, unlike a global label search (rejected in
 * `checkIssuesAcrossFleet`'s docstring for exactly this reason): a label
 * is a short string a stranger's unrelated repo can coincidentally reuse;
 * a GitHub LOGIN is globally unique, so `involves:<this-bot>[bot]` can
 * only ever match issues this specific bot actually touched.
 *
 * `mentions:` was tried and rejected (devops, live-verified on the issue
 * thread) — GitHub's `mentions:` qualifier returns ZERO results for bot
 * accounts. `involves:` is the qualifier that actually surfaces bot
 * activity.
 *
 * Under the plugin's `ghs_` installation token, `involves:` returns issues
 * in {install-set PRIVATE repos} ∪ {any PUBLIC repo the bot is involved
 * in} — exactly the queue this leg is meant to add on top of the
 * install-set x label join.
 *
 * FAILS SOFT independently of the install-set x label leg (macf#816
 * review criterion): a rate-limit (403/429), a 5xx, a malformed response,
 * or any other error warns to stderr and resolves to `[]`. This function
 * NEVER throws — its caller (`checkAllPendingWork`) unions this leg with
 * the install-set x label leg, and a failure here must degrade the
 * combined queue to the D7 install-set x label basis only, never blank it.
 */
export async function searchInvolvesIssues(config: {
  readonly selfLogin: string;
  readonly token: string;
  /** Override for tests; defaults to `gh search issues --involves`. */
  readonly listSearch?: (
    login: string,
    token: string,
  ) => Promise<readonly PendingIssue[]>;
}): Promise<readonly PendingIssue[]> {
  const { selfLogin, token } = config;
  const listSearch = config.listSearch ?? defaultListSearch;
  // The `[bot]` suffix is REQUIRED — devops-verified a bare login 422s
  // against GitHub's search API for a GitHub App's bot account. This is
  // the ONLY place `[bot]` is hardcoded in this module (macf#816).
  const login = `${selfLogin}[bot]`;

  try {
    return await listSearch(login, token);
  } catch (err) {
    process.stderr.write(
      `Warning: failed to search involves:${login} issues: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/** Unwrap a settled promise's value, warning + degrading to `[]` on
 * rejection. The independent-fail-soft primitive `checkAllPendingWork`
 * applies to EACH of its two legs — a throw from either source must
 * never blank the other's results (macf#816 review criterion). */
function unwrapOrWarn(
  source: string,
  result: PromiseSettledResult<readonly PendingIssue[]>,
): readonly PendingIssue[] {
  if (result.status === 'fulfilled') return result.value;
  const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
  process.stderr.write(`Warning: ${source} pending-work source failed: ${reason}\n`);
  return [];
}

/**
 * The complete, generic startup work-queue (macf#816) — the UNION of:
 *
 *   - `checkIssuesAcrossFleet` (DR-038 Decision 7): {App install-set} x
 *     {agent label} — complete WITHIN the install-set, but bounded to it.
 *   - `searchInvolvesIssues`: `involves:<this-bot>[bot]` — poison-free,
 *     keyed on the globally-unique bot login, NOT bounded to the
 *     install-set.
 *
 * Deduped by `${repo}#${number}` (an issue can legitimately match BOTH
 * legs — e.g. labeled for this agent AND @mentioned on the same issue).
 *
 * Each leg fails soft INDEPENDENTLY of the other — a rate-limit, an auth
 * hiccup, or a thrown error in EITHER leg degrades the combined queue to
 * the OTHER leg's results, never to an empty queue. This is
 * `Promise.allSettled`, not `Promise.all`: the latter rejects the whole
 * aggregate (discarding the successful leg's results) the instant either
 * promise rejects — exactly the failure mode this function exists to
 * avoid.
 *
 * `selfLogin` is optional — when the caller can't resolve it (see
 * `resolveSelfLogin`), the `involves:` leg is skipped entirely (never
 * attempted with a guessed/bogus login) and the queue is exactly
 * `checkIssuesAcrossFleet`'s result, matching pre-#816 behavior.
 */
export async function checkAllPendingWork(config: {
  readonly label: string;
  readonly token: string;
  readonly selfLogin?: string;
  /** Override for tests; forwarded to `checkIssuesAcrossFleet`. */
  readonly listInstallRepos?: () => Promise<readonly string[]>;
  /** Override for tests; forwarded to `checkIssuesAcrossFleet`. */
  readonly checkOneRepo?: (
    repo: string,
    label: string,
    token: string,
  ) => Promise<readonly PendingIssue[]>;
  /** Override for tests; replaces the WHOLE `searchInvolvesIssues` call
   * (not just its inner `listSearch`) so a test can simulate the
   * `involves:` leg throwing without reaching into `gh` at all. */
  readonly searchInvolves?: (config: {
    readonly selfLogin: string;
    readonly token: string;
  }) => Promise<readonly PendingIssue[]>;
}): Promise<readonly PendingIssue[]> {
  const { label, token, selfLogin } = config;
  const searchInvolves = config.searchInvolves ?? searchInvolvesIssues;

  const [installSetResult, involvesResult] = await Promise.allSettled([
    checkIssuesAcrossFleet({
      label,
      token,
      listInstallRepos: config.listInstallRepos,
      checkOneRepo: config.checkOneRepo,
    }),
    selfLogin
      ? searchInvolves({ selfLogin, token })
      : Promise.resolve<readonly PendingIssue[]>([]),
  ]);

  const installSetIssues = unwrapOrWarn('install-set x label', installSetResult);
  const involvesIssues = unwrapOrWarn('involves', involvesResult);

  return dedupePendingIssues([...installSetIssues, ...involvesIssues]);
}
