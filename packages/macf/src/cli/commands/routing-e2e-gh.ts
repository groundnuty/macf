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
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TextRead } from './routing-e2e-evidence.js';
import type { RoutingE2eCreateIssueResult, RoutingE2eLabelResult, RoutingE2eRouterRun, RoutingE2eRunListing } from './routing-e2e.js';

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
    // A per-probe token in the title: the router run's display_title is this title, which is
    // how the probe tells its own run from a concurrent one.
    const title = `Routing self-test probe (automated) ${randomBytes(4).toString('hex')}`;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          `repos/${repo}/issues`,
          '-X',
          'POST',
          '-f',
          `title=${title}`,
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
      return { ok: true, number: parsed.number, url: parsed.url, title };
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
 * a read failure returns `found: false` WITH `error` set (repo has no
 * `agent-router.yml`, auth failure, network error).
 */
export function createRouterRunFinder(
  token: string,
): (repo: string, sinceIso: string, event?: 'issues' | 'issue_comment') => Promise<RoutingE2eRouterRun> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string, sinceIso: string, event: 'issues' | 'issue_comment' = 'issues'): Promise<RoutingE2eRouterRun> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--method',
          'GET',
          `repos/${repo}/actions/workflows/agent-router.yml/runs`,
          '-f',
          `event=${event}`,
          '-f',
          'per_page=10',
          '--jq',
          '.workflow_runs',
        ],
        { encoding: 'utf-8', env, maxBuffer: 4 * 1024 * 1024 },
      );
      const runs = JSON.parse(stdout) as readonly {
        readonly id: number;
        readonly conclusion: string | null;
        readonly status: string;
        readonly created_at: string;
        readonly html_url: string;
        readonly display_title?: string;
      }[];
      const sinceMs = Date.parse(sinceIso) - RUN_LOOKBACK_BUFFER_MS;
      const candidates = runs
        .filter((r) => Date.parse(r.created_at) >= sinceMs)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const run = candidates[0];
      if (!run) return { found: false, conclusion: null, status: null, url: null };
      return { found: true, id: run.id, conclusion: run.conclusion, status: run.status, url: run.html_url, ...(run.display_title !== undefined ? { title: run.display_title } : {}) };
    } catch (err) {
      // Could not read ≠ no run: carry the error so the caller says "unknown".
      return { found: false, conclusion: null, status: null, url: null, error: errMessage(err) };
    }
  };
}

/**
 * Post ONE clearly labelled comment mentioning the recipient's bot on an
 * existing issue. Never edits or deletes anything. NEVER throws.
 */
export function createMentionPoster(
  token: string,
): (repo: string, issue: number, botLogin: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo, issue, botLogin) => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api', `repos/${repo}/issues/${String(issue)}/comments`, '-X', 'POST',
          '-f', `body=@${botLogin}[bot] Automated routing probe. Safe to ignore; nothing needs doing.`,
          '--jq', '.html_url',
        ],
        { encoding: 'utf-8', env, maxBuffer: 1024 * 1024 },
      );
      return { ok: true, url: stdout.trim() };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  };
}

/** The router run's log, read by run id. NEVER throws. */
export function createRunLogReader(token: string): (repo: string, runId: number) => Promise<TextRead> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo, runId) => {
    try {
      const { stdout } = await execFileAsync('gh', ['run', 'view', String(runId), '--repo', repo, '--log'], {
        encoding: 'utf-8', env, maxBuffer: 32 * 1024 * 1024,
      });
      return { kind: 'ok', text: stdout };
    } catch (err) {
      return { kind: 'error', error: errMessage(err) };
    }
  };
}

/**
 * `<state>/macf/<project>@<routing label>/channel.log` — the receiver's log,
 * derived from its identity (the routing-table KEY, the same derivation the
 * launcher bakes into MACF_LOG_PATH), never by scanning the host.
 */
export function receiverLogPathFor(project: string, routingLabel: string): string {
  const state = process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
  return join(state, 'macf', `${project}@${routingLabel}`, 'channel.log');
}

export async function readLocalLog(path: string): Promise<TextRead> {
  try {
    return { kind: 'ok', text: await readFile(path, 'utf-8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', error: errMessage(err) };
  }
}

/**
 * EVERY router run for `event` created no earlier than 5 s before `sinceIso`,
 * oldest first (the finder above returns only the first). Used to disambiguate
 * concurrent runs by their logs. NEVER throws; a read failure is `{ ok: false }`, never `[]`.
 */
export function createRouterRunLister(
  token: string,
): (repo: string, sinceIso: string, event: 'issues' | 'issue_comment') => Promise<RoutingE2eRunListing> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo, sinceIso, event) => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--method', 'GET', `repos/${repo}/actions/workflows/agent-router.yml/runs`, '-f', `event=${event}`, '-f', 'per_page=20', '--jq', '.workflow_runs'],
        { encoding: 'utf-8', env, maxBuffer: 4 * 1024 * 1024 },
      );
      const runs = JSON.parse(stdout) as readonly {
        id: number; conclusion: string | null; status: string; created_at: string; html_url: string; display_title?: string;
      }[];
      const sinceMs = Date.parse(sinceIso) - RUN_LOOKBACK_BUFFER_MS;
      const listed = runs
        .filter((r) => Date.parse(r.created_at) >= sinceMs)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((r) => ({ found: true, id: r.id, conclusion: r.conclusion, status: r.status, url: r.html_url, ...(r.display_title !== undefined ? { title: r.display_title } : {}) }));
      return { ok: true, runs: listed };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  };
}

/** Mention mode: the existing issue's title (GET), or undefined when it cannot be read. NEVER throws. */
export function createIssueTitleReader(token: string): (repo: string, issue: number) => Promise<string | undefined> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo, issue) => {
    try {
      const { stdout } = await execFileAsync('gh', ['api', '--method', 'GET', `repos/${repo}/issues/${String(issue)}`, '--jq', '.title'], {
        encoding: 'utf-8',
        env,
        maxBuffer: 1024 * 1024,
      });
      const t = stdout.trim();
      return t.length > 0 ? t : undefined;
    } catch {
      return undefined;
    }
  };
}
