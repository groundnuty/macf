/**
 * GitHub-plane I/O leaf for `macf routing doctor --e2e` (`routing-e2e.ts`).
 *
 * Isolates the `gh` shell-outs the capability probe needs so the orchestration
 * in `routing-e2e.ts` stays PURE + offline-testable (production wires these;
 * tests inject fakes) — same split as `routing-doctor-gh.ts` for the static
 * checks. Unlike that module, three of these four calls WRITE (create the
 * probe issue, apply its label, close it on cleanup); `findRouterRun` is the
 * only read. The token is forwarded as `GH_TOKEN` in the subprocess env.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RoutingE2eCreateIssueResult, RoutingE2eLabelResult, RoutingE2eRouterRun } from './routing-e2e.js';

const execFileAsync = promisify(execFile);

/** Clock-skew tolerance for matching a workflow run to the label-add that triggered it. */
const RUN_LOOKBACK_BUFFER_MS = 5_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create the probe issue on `repo` — BARE, with no labels (labels are applied
 * in a separate call so the `labeled` webhook event — the router's actual
 * trigger — fires; GitHub does not fire `labeled` for labels supplied at
 * creation time). Title/body are self-explanatory to a human reading the
 * repo's issue list without any internal reference. NEVER throws.
 */
export function createProbeIssueCreator(token: string): (repo: string) => Promise<RoutingE2eCreateIssueResult> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<RoutingE2eCreateIssueResult> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          `repos/${repo}/issues`,
          '-X',
          'POST',
          '-f',
          'title=Routing self-test probe (automated)',
          '-f',
          'body=Automated routing capability check. Safe to ignore -- this issue is closed automatically ' +
            'once the check finishes; if you are reading this after it should have closed, the check likely ' +
            'crashed mid-run and this issue can be closed by hand.',
          '--jq',
          '{number: .number, url: .html_url}',
        ],
        { encoding: 'utf-8', env, maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as { number: number; url: string };
      return { ok: true, number: parsed.number, url: parsed.url };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  };
}

/**
 * Apply `label` to `issueNumber` on `repo` as a SEPARATE call from creation —
 * this is the act that fires the `issues.labeled` webhook the router listens
 * for. NEVER throws.
 */
export function createLabelApplier(
  token: string,
): (repo: string, issueNumber: number, label: string) => Promise<RoutingE2eLabelResult> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string, issueNumber: number, label: string): Promise<RoutingE2eLabelResult> => {
    try {
      await execFileAsync(
        'gh',
        ['api', `repos/${repo}/issues/${String(issueNumber)}/labels`, '-X', 'POST', '-f', `labels[]=${label}`],
        { encoding: 'utf-8', env, maxBuffer: 65_536 },
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  };
}

/**
 * Close `issueNumber` on `repo` — cleanup, always attempted regardless of the
 * probe's outcome. Closing (not deleting): issue deletion is a GraphQL-only
 * mutation gated on repo-admin permission most bot Apps never hold; closing a
 * clearly-labeled probe with `issues: write` (the same permission DR-019
 * already grants every agent App) is enough to avoid leaving debris in an
 * open queue. Returns `false` (never throws) on any failure so the caller can
 * report "cleanup did not land" rather than crash mid-report.
 */
export function createIssueCloser(token: string): (repo: string, issueNumber: number) => Promise<boolean> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string, issueNumber: number): Promise<boolean> => {
    try {
      await execFileAsync(
        'gh',
        ['api', `repos/${repo}/issues/${String(issueNumber)}`, '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not_planned'],
        { encoding: 'utf-8', env, maxBuffer: 65_536 },
      );
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Find the routing workflow run triggered by the probe's `labeled` event —
 * the earliest run on `repo`'s `agent-router.yml` (filtered to `event=issues`
 * runs) created at or after `sinceIso`, tolerant of a small clock-skew buffer.
 * Called ONLY after diagnosis needs it (probe timed out but the target WAS
 * reachable) and ALWAYS before the probe issue is closed, so the close
 * event's own `cleanup-labels` run (a DIFFERENT job, gated on `action ==
 * 'closed'`, never re-notifies — verified against the live workflow source)
 * can never be mistaken for the one the label triggered. NEVER throws;
 * degrades to `found: false` on any read failure (repo has no
 * `agent-router.yml`, auth failure, network error).
 */
export function createRouterRunFinder(
  token: string,
): (repo: string, sinceIso: string) => Promise<RoutingE2eRouterRun> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string, sinceIso: string): Promise<RoutingE2eRouterRun> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          `repos/${repo}/actions/workflows/agent-router.yml/runs`,
          '-f',
          'event=issues',
          '-f',
          'per_page=10',
          '--jq',
          '.workflow_runs',
        ],
        { encoding: 'utf-8', env, maxBuffer: 4 * 1024 * 1024 },
      );
      const runs = JSON.parse(stdout) as readonly {
        readonly conclusion: string | null;
        readonly status: string;
        readonly created_at: string;
        readonly html_url: string;
      }[];
      const sinceMs = Date.parse(sinceIso) - RUN_LOOKBACK_BUFFER_MS;
      const candidates = runs
        .filter((r) => Date.parse(r.created_at) >= sinceMs)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const run = candidates[0];
      if (!run) return { found: false, conclusion: null, status: null, url: null };
      return { found: true, conclusion: run.conclusion, status: run.status, url: run.html_url };
    } catch {
      return { found: false, conclusion: null, status: null, url: null };
    }
  };
}
