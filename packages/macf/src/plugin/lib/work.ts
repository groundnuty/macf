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

  // Dedup by repo+number — guards against a pagination fluke in the
  // install-repo lister or an overlapping custom `checkOneRepo` returning the
  // same issue twice. In the common case (each repo appears once) this is a
  // no-op pass-through.
  const seen = new Set<string>();
  const deduped: PendingIssue[] = [];
  for (const issue of perRepo.flat()) {
    const key = `${issue.repo ?? ''}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}
