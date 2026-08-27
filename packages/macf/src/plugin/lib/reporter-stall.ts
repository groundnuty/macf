import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInstallRepoLister } from '../../cli/commands/routing-doctor-gh.js';

const execFileAsync = promisify(execFile);

/**
 * Reporter-side stall sweep (groundnuty/macf#1170).
 *
 * `coordination.md §Communication 5`'s injected startup step
 * (`formatSweepInstruction`) promotes three INBOUND disciplines — reviewer
 * requests addressed to you, gates you're waiting on — from "a discipline
 * the agent must remember" to a structural startup composition. It has no
 * OUTBOUND counterpart: nothing re-presents an issue THIS agent filed,
 * whose promise (a closing condition, a verification, a deferral) went
 * unread. Six real stalls (macf#1012, #838, #999, #855, plus two more cited
 * on #1170) shared exactly that shape — every one surfaced by someone
 * checking, never by someone remembering. This module is the query half of
 * the fix; `format.ts`'s `formatReporterStallSweep` is the render half.
 *
 * SCOPE (macf#1170 amendment 1, self-corrected before build started): this
 * sweep covers three of the four stall mechanisms the issue catalogued —
 * an implicit closing condition, a verification nobody acted on, and a
 * deferral condition nobody re-read. All three are PROMISES (true when
 * written, decaying silently until someone looks again), which a periodic
 * re-presentation fixes. The fourth (macf#1112 — "closed as reporter"
 * stated in prose but the `gh issue close` never run) is an ASSERTION that
 * was false the instant it was written; it needs a one-command
 * immediate-verification tail at the moment of the claim, not a later
 * sweep. Deliberately NOT specially detected or excluded here — the plain
 * "open + authored-by-me + quiet" net happens to also catch that shape
 * incidentally, which is harmless; building code to recognize and exclude
 * it would be solving a problem this module doesn't own.
 *
 * SIGNAL CHOSEN: staleness (`updatedAt` age), not "a merged PR references
 * it". Measured before building either way: this fleet's canonical
 * convention (`coordination.md §Issue Lifecycle 1`) is `Refs #N`, never
 * `Closes #N`, specifically to avoid GitHub's auto-close — and GitHub only
 * populates `closedByPullRequestsReferences` for issues an auto-close
 * keyword targets. Checked live: 0 of 200 issues in groundnuty/macf carry
 * it. A PR-reference signal would be an empty sweep that looks clean on
 * every single run — exactly the macf-science-agent#43 shape (a queue that
 * structurally cannot return anything is indistinguishable from a queue
 * that legitimately has nothing). Staleness is directly what the issue's
 * own worked examples measured (each instance's "N days" IS this metric),
 * and it's a real, always-populated field.
 *
 * CROSS-REPO COVERAGE (amendment 2): reuses `createInstallRepoLister` — the
 * SAME primitive `checkIssuesAcrossFleet` (the INBOUND sweep) already uses.
 * Per DR-038 Decision 7, the App install-set IS "every repo this agent can
 * act in", which is also exactly "every repo this agent could plausibly
 * have filed an issue into" — an agent can't file where it has no write
 * access. Reusing the primitive is both DRY and correct: the amendment-2
 * blind spot (macf-science-agent#43 — filed outside the narrow "my repos"
 * set the sweep was originally scoped to) is closed by construction, not by
 * a second bespoke enumeration.
 *
 * HONEST-COVERAGE FLOOR: two distinct failure shapes, both reported
 * explicitly rather than rendered as indistinguishable-from-"nothing
 * stale":
 *   - a SINGLE repo's listing query fails (rate limit, revoked access,
 *     transient 5xx) → that repo's name lands in `unreadableRepos`; its
 *     absence from `stalls` must never be read as "nothing stale there".
 *   - the TOP-LEVEL install-set enumeration itself returns `[]` →
 *     `enumerationFailed: true`. A live agent's install-set is never
 *     genuinely empty (DR-038 Decision 7 — the App is always installed on
 *     at least its own repo), so an empty enumeration result IS the
 *     enumeration call failing. `createInstallRepoLister` itself collapses
 *     "genuinely zero repos" and "the whole call failed" to the same `[]`
 *     (a pre-existing characteristic shared with the inbound sweep, not
 *     introduced here — see macf#1170 final report for why fixing the
 *     shared primitive is out of this module's scope). This function does
 *     not inherit that collapse at ITS OWN boundary: `repos.length === 0`
 *     is treated as a failure signal here, never silently rendered as a
 *     clean sweep.
 *
 * DEFERRAL VERDICT VS REMINDER (amendment 1): every surfaced stall carries
 * an unconditional reminder ("re-read its stated conditions") by default —
 * that satisfies the amendment's requirement that a PROSE deferral
 * ("behind the operator's live provisioning run") never be silently
 * rendered as if it were confirmed fine, with zero prose-detection code.
 * The reminder is the ceiling for anything this module cannot mechanically
 * verify. On top of that floor, a NARROW, phrase-anchored regex looks for a
 * machine-checkable reference (`behind #932`, `blocked on #932`, ...); when
 * found AND the referenced issue/PR has since closed, the stall gets an
 * upgraded VERDICT line instead. This is deliberately not a general `#N`
 * extractor or a multi-condition classifier — issue bodies in this fleet
 * routinely cite a dozen other issues in "Refs" trailers and prior-art
 * links, and extracting every number would produce false "cleared"
 * verdicts. Only a number immediately following one of five deferral
 * phrases counts.
 */

export interface ReporterStallDeferral {
  /** The `owner/repo#N` (cross-repo) or bare `#N` (same-repo) reference the
   * sweep found in a deferral phrase, now confirmed CLOSED. */
  readonly ref: string;
  readonly closedAt?: string;
}

export interface ReporterStall {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly updatedAt: string;
  readonly daysQuiet: number;
  /** Set ONLY when a deferral reference was found AND resolved AND is now
   * CLOSED — the narrow verdict case. Absent means "reminder only" (the
   * default for every stall, including one with an unresolvable or still-
   * open reference, or with no detectable reference at all). */
  readonly clearedRef?: ReporterStallDeferral;
}

export interface ReporterStallResult {
  readonly stalls: readonly ReporterStall[];
  /** Install-set repos whose OWN listing query failed — reported
   * distinctly from "reachable, zero stale issues" (honest-coverage
   * floor). */
  readonly unreadableRepos: readonly string[];
  /** True when the top-level install-set enumeration returned nothing —
   * treated as a failure signal, not "nothing to sweep" (see module doc). */
  readonly enumerationFailed: boolean;
  /** Total candidates crossing `staleDays`, BEFORE `limit` truncated the
   * list down to `stalls`. Required (not optional) so every construction
   * site — real or test — makes an explicit choice; an omitted field that
   * silently defaulted to "nothing was capped" would be exactly the kind
   * of false-by-omission the render layer exists to avoid (macf#1170,
   * science-agent: "a reader who sees five items and does not know there
   * are thirty-nine has been told something false by omission"). Always
   * `0` when `enumerationFailed` is `true` — there is no candidate count
   * to report when the enumeration itself never ran. */
  readonly totalStale: number;
}

/**
 * Default stale-after threshold, in days of `updatedAt` inactivity.
 *
 * Measured against the live install-set (macf#1170 final report — 39 open
 * self-filed issues across 5 repos at measurement time): the shortest
 * documented in-scope stall instance (macf#999) sat 6 days before a peer
 * noticed. 5 days catches that with a one-day margin while staying well
 * above same-day/next-day review turnaround, which is the fleet's norm —
 * 22 of the 39 measured issues were under 1 day old. The render-side cap
 * (`DEFAULT_REPORTER_STALL_LIMIT`) is what actually bounds session-to-
 * session noise, not this threshold; see that constant's doc.
 */
export const DEFAULT_REPORTER_STALL_DAYS = 5;

/**
 * Cap on rendered stalls, independent of how many cross `staleDays`.
 * Measured: at the 5-day default against the live install-set, 20 of 39
 * open self-filed issues qualified — rendering all of them every session
 * IS the noise failure the issue explicitly warns against (`#1099`'s
 * always-FATAL / `#1114`'s always-firing shape). Same reasoning as
 * `formatIssuesOneline`'s `limit = 8` default: cap to the most-urgent
 * subset (ranked by `daysQuiet` descending — oldest promises first) rather
 * than widen the threshold, which would just move the same wall of text to
 * a different N. The deep per-candidate fetch (`fetchBodyAndComments`,
 * used only for deferral-reference detection) is bounded to this same cap
 * — never run against the full candidate set inside a SessionStart hook.
 *
 * A cap that truncates silently is its own false-by-omission hazard — a
 * reader seeing 5 items with no indication that 34 more exist reads the
 * sweep as complete. `ReporterStallResult.totalStale` carries the pre-cap
 * count so the render layer (`formatReporterStallSweep`) can say "N of M"
 * whenever the cap actually bit, rather than rendering a bare list that
 * looks identical whether it's everything or a fifth of everything.
 */
export const DEFAULT_REPORTER_STALL_LIMIT = 5;

interface RawOpenAuthoredIssue {
  readonly number: number;
  readonly title: string;
  readonly updatedAt: string;
}

interface RefState {
  readonly state: 'OPEN' | 'CLOSED';
  readonly closedAt?: string;
}

async function defaultListOpenAuthored(
  repo: string,
  token: string,
): Promise<readonly RawOpenAuthoredIssue[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'list',
    '--repo', repo,
    '--author', '@me',
    '--state', 'open',
    '--json', 'number,title,updatedAt',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, GH_TOKEN: token },
  });
  return JSON.parse(stdout) as readonly RawOpenAuthoredIssue[];
}

async function defaultFetchBodyAndComments(
  repo: string,
  number: number,
  token: string,
): Promise<{ readonly body: string; readonly comments: readonly { readonly body: string }[] }> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'view', String(number),
    '--repo', repo,
    '--json', 'body,comments',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as { body: string; comments: readonly { body: string }[] };
}

/**
 * Resolve one issue/PR's state by number. Deliberately hits the generic
 * `/repos/{repo}/issues/{number}` REST endpoint (not `gh issue view` /
 * `gh pr view`) — GitHub's data model treats a PR as an issue for this
 * purpose, so one call resolves a deferral reference regardless of whether
 * it points at an issue or a PR. Fails soft to `undefined` (network error,
 * 404 on a deleted/inaccessible target, malformed response) — a deferral
 * reference this module can't resolve degrades to the reminder default,
 * never to a false verdict.
 */
async function defaultResolveRefState(
  repo: string,
  number: number,
  token: string,
): Promise<RefState | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', `repos/${repo}/issues/${number}`,
      '--jq', '{state: .state, closed_at: .closed_at}',
    ], {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: token },
    });
    const parsed = JSON.parse(stdout) as { readonly state: string; readonly closed_at: string | null };
    if (parsed.state.toUpperCase() !== 'CLOSED') return { state: 'OPEN' };
    return parsed.closed_at ? { state: 'CLOSED', closedAt: parsed.closed_at } : { state: 'CLOSED' };
  } catch {
    return undefined;
  }
}

/**
 * Narrow, phrase-anchored deferral-reference detector — see module doc
 * "DEFERRAL VERDICT VS REMINDER" for why this is deliberately not a
 * general `#N` extractor. Only a number within 40 characters of one of
 * five deferral phrases counts as machine-checkable.
 */
const DEFERRAL_REF_RE =
  /\b(?:behind|blocked on|blocked by|gated on|waiting on|deferred until)\b[^\n]{0,40}?([\w.-]+\/[\w.-]+)?#(\d+)/i;

function extractDeferralRef(
  text: string,
  sameRepo: string,
): { readonly repo: string; readonly number: number } | undefined {
  const m = DEFERRAL_REF_RE.exec(text);
  if (!m) return undefined;
  const number = Number(m[2]);
  if (!Number.isFinite(number)) return undefined;
  return { repo: m[1] ?? sameRepo, number };
}

/**
 * Search body + comments for a deferral reference, most-recent-first: a
 * later comment's restatement (or resolution) of a deferral supersedes an
 * earlier one. `gh issue view --json comments` returns oldest-first;
 * reversed here, body checked last (the original filing is the OLDEST
 * statement of the condition).
 */
function findDeferralRef(
  body: string,
  comments: readonly { readonly body: string }[],
  sameRepo: string,
): { readonly repo: string; readonly number: number } | undefined {
  const texts = [...comments].reverse().map((c) => c.body).concat(body);
  for (const text of texts) {
    const ref = extractDeferralRef(text, sameRepo);
    if (ref) return ref;
  }
  return undefined;
}

export async function checkReporterStalls(config: {
  readonly token: string;
  readonly staleDays?: number;
  readonly limit?: number;
  /** Override for tests; defaults to `Date.now()`. */
  readonly now?: number;
  /** Override for tests; defaults to the real `/installation/repositories`
   * lister — the SAME primitive the inbound sweep uses (see module doc). */
  readonly listInstallRepos?: () => Promise<readonly string[]>;
  /** Override for tests; defaults to `gh issue list --author @me`. */
  readonly listOpenAuthored?: (
    repo: string,
    token: string,
  ) => Promise<readonly RawOpenAuthoredIssue[]>;
  /** Override for tests; defaults to `gh issue view --json body,comments`.
   * Only called for the top-`limit` stale candidates (bounded cost). */
  readonly fetchBodyAndComments?: (
    repo: string,
    number: number,
    token: string,
  ) => Promise<{ readonly body: string; readonly comments: readonly { readonly body: string }[] }>;
  /** Override for tests; defaults to the generic issues/PRs REST lookup. */
  readonly resolveRefState?: (
    repo: string,
    number: number,
    token: string,
  ) => Promise<RefState | undefined>;
}): Promise<ReporterStallResult> {
  const { token } = config;
  const staleDays = config.staleDays ?? DEFAULT_REPORTER_STALL_DAYS;
  const limit = config.limit ?? DEFAULT_REPORTER_STALL_LIMIT;
  const now = config.now ?? Date.now();
  const listInstallRepos = config.listInstallRepos ?? createInstallRepoLister(token);
  const listOpenAuthored = config.listOpenAuthored ?? defaultListOpenAuthored;
  const fetchBodyAndComments = config.fetchBodyAndComments ?? defaultFetchBodyAndComments;
  const resolveRefState = config.resolveRefState ?? defaultResolveRefState;

  const repos = await listInstallRepos();
  if (repos.length === 0) {
    // See module doc "HONEST-COVERAGE FLOOR" — a genuinely empty install
    // set does not happen for a live agent; this is the enumeration call
    // failing, reported as such rather than as a clean sweep.
    return { stalls: [], unreadableRepos: [], enumerationFailed: true, totalStale: 0 };
  }

  const unreadableRepos: string[] = [];
  const candidates: Array<{
    repo: string;
    number: number;
    title: string;
    updatedAt: string;
    daysQuiet: number;
  }> = [];

  await Promise.all(
    repos.map(async (repo) => {
      let issues: readonly RawOpenAuthoredIssue[];
      try {
        issues = await listOpenAuthored(repo, token);
      } catch (err) {
        // Mirrors `checkIssues`'s stderr-warning convention (work.ts) —
        // debuggable, and never includes the token: `err.message` here is
        // whatever `gh` printed, and GH_TOKEN is passed via `env`, never
        // as a CLI arg or in output the CLI echoes back.
        process.stderr.write(
          `Warning: reporter-stall sweep could not check ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        unreadableRepos.push(repo);
        return;
      }
      for (const issue of issues) {
        const daysQuiet = (now - Date.parse(issue.updatedAt)) / 86_400_000;
        if (daysQuiet >= staleDays) {
          candidates.push({
            repo,
            number: issue.number,
            title: issue.title,
            updatedAt: issue.updatedAt,
            daysQuiet,
          });
        }
      }
    }),
  );

  // Oldest promises first, capped — see DEFAULT_REPORTER_STALL_LIMIT doc.
  candidates.sort((a, b) => b.daysQuiet - a.daysQuiet);
  const top = candidates.slice(0, limit);

  const stalls: ReporterStall[] = await Promise.all(
    top.map(async (c): Promise<ReporterStall> => {
      try {
        const { body, comments } = await fetchBodyAndComments(c.repo, c.number, token);
        const ref = findDeferralRef(body, comments, c.repo);
        if (ref) {
          const resolved = await resolveRefState(ref.repo, ref.number, token);
          if (resolved?.state === 'CLOSED') {
            return {
              ...c,
              clearedRef: {
                ref: ref.repo === c.repo ? `#${ref.number}` : `${ref.repo}#${ref.number}`,
                closedAt: resolved.closedAt,
              },
            };
          }
        }
        return c;
      } catch {
        // The stall itself is real (confirmed via the cheap listing call
        // above) — a failure fetching body/comments only means the
        // deferral-verdict enrichment is unavailable, never that the
        // stall should be dropped.
        return c;
      }
    }),
  );

  return { stalls, unreadableRepos, enumerationFailed: false, totalStale: candidates.length };
}
