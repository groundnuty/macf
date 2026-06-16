/**
 * Read-only GitHub seam for the auditor Monitor (groundnuty/macf#502, DR-026 F4).
 *
 * THE LOAD-BEARING INVARIANT: the Monitor is strictly READ-ONLY. This interface
 * exposes ONLY read operations — `listOpenIssues` + `listOpenPRs`. There is
 * deliberately NO create/comment/close/merge/edit method on the seam, so a
 * mutation is not merely "discouraged" but *unrepresentable* through the type.
 * Tests inject a fake implementation and assert it received reads only.
 *
 * The default implementation shells out to the `gh` CLI via `execFile` — the
 * same canonical read pattern as `src/plugin/lib/work.ts#checkIssues`. It only
 * ever invokes `gh issue list` / `gh pr list` (both pure reads). The token is
 * passed via the `GH_TOKEN` env (the house auth posture), never baked into a
 * remote or used for a write.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A single open issue, as read from `gh issue list --json`. */
export interface MonitorIssue {
  readonly number: number;
  readonly title: string;
  /** ISO8601 creation timestamp (for stale detection). */
  readonly createdAt: string;
  /** Assignment + status labels (we group stale issues by assignment label). */
  readonly labels: readonly string[];
}

/** A single open PR, as read from `gh pr list --json`. */
export interface MonitorPR {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  /** GitHub's review decision: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null. */
  readonly reviewDecision: string | null;
  /** GitHub's mergeable state string (e.g. CLEAN, BLOCKED, DIRTY, UNKNOWN). */
  readonly mergeStateStatus: string | null;
  readonly isDraft: boolean;
}

/**
 * The read-only GitHub seam. Implementations MUST perform only reads. The
 * Monitor command depends on this interface (not on `gh` directly) so tests can
 * inject a fake + assert no mutation ever happens.
 */
export interface GitHubReader {
  listOpenIssues(repo: string): Promise<readonly MonitorIssue[]>;
  listOpenPRs(repo: string): Promise<readonly MonitorPR[]>;
}

/** Shape `gh issue list --json number,title,createdAt,labels` returns. */
interface GhIssueRow {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly labels?: ReadonlyArray<{ readonly name: string }>;
}

/** Shape `gh pr list --json ...` returns. */
interface GhPrRow {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly reviewDecision?: string | null;
  readonly mergeStateStatus?: string | null;
  readonly isDraft?: boolean;
}

/**
 * The production GitHub reader: shells out to `gh` for issue/PR LISTS only.
 *
 * `token` is forwarded as `GH_TOKEN` in the subprocess env — the canonical bot
 * auth posture. Both calls are pure reads (`gh issue list`, `gh pr list`); this
 * class has no write path at all.
 */
export function createGhReader(token: string): GitHubReader {
  const env = { ...process.env, GH_TOKEN: token };

  return {
    async listOpenIssues(repo: string): Promise<readonly MonitorIssue[]> {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'issue', 'list',
          '--repo', repo,
          '--state', 'open',
          '--limit', '500',
          '--json', 'number,title,createdAt,labels',
        ],
        { encoding: 'utf-8', env, maxBuffer: 32 * 1024 * 1024 },
      );
      const rows = JSON.parse(stdout) as readonly GhIssueRow[];
      return rows.map((r) => ({
        number: r.number,
        title: r.title,
        createdAt: r.createdAt,
        labels: (r.labels ?? []).map((l) => l.name),
      }));
    },

    async listOpenPRs(repo: string): Promise<readonly MonitorPR[]> {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr', 'list',
          '--repo', repo,
          '--state', 'open',
          '--limit', '500',
          '--json', 'number,title,createdAt,reviewDecision,mergeStateStatus,isDraft',
        ],
        { encoding: 'utf-8', env, maxBuffer: 32 * 1024 * 1024 },
      );
      const rows = JSON.parse(stdout) as readonly GhPrRow[];
      return rows.map((r) => ({
        number: r.number,
        title: r.title,
        createdAt: r.createdAt,
        reviewDecision: r.reviewDecision ?? null,
        mergeStateStatus: r.mergeStateStatus ?? null,
        isDraft: r.isDraft ?? false,
      }));
    },
  };
}
