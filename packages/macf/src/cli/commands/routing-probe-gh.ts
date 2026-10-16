/**
 * GitHub-plane + filesystem I/O leaf for `macf routing probe`
 * (`routing-probe.ts`). The only writes are: ONE comment on an existing
 * issue, or ONE new issue plus its label. Nothing is ever deleted or closed.
 * Every function returns a result value and never throws.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PostResult, ProbePostSpec, ProbeRun, TextRead } from './routing-probe.js';

const execFileAsync = promisify(execFile);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PROBE_NOTE =
  'Automated routing probe. Safe to ignore; nothing needs doing. ';

export function createProbePoster(token: string): (spec: ProbePostSpec) => Promise<PostResult> {
  const env = { ...process.env, GH_TOKEN: token };
  const api = async (args: readonly string[]): Promise<unknown> => {
    const { stdout } = await execFileAsync('gh', ['api', ...args], { encoding: 'utf-8', env, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as unknown;
  };
  return async (spec) => {
    try {
      if (spec.mode === 'mention') {
        const body = `@${spec.botLogin ?? ''}[bot] ${PROBE_NOTE}(probe ${spec.token})`;
        const out = (await api([
          `repos/${spec.repo}/issues/${String(spec.issue)}/comments`,
          '-X', 'POST', '-f', `body=${body}`,
        ])) as { html_url: string };
        return { ok: true, issueNumber: spec.issue as number, url: out.html_url };
      }
      const created = (await api([
        `repos/${spec.repo}/issues`,
        '-X', 'POST',
        '-f', 'title=Routing probe (automated)',
        '-f', `body=${PROBE_NOTE}This issue is left open on purpose; close it by hand. (probe ${spec.token})`,
      ])) as { number: number; html_url: string };
      // A separate call: the label-added event is the router's trigger.
      await api([
        `repos/${spec.repo}/issues/${String(created.number)}/labels`,
        '-X', 'POST', '-f', `labels[]=${spec.label}`,
      ]);
      return { ok: true, issueNumber: created.number, url: created.html_url };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  };
}

export function createProbeRunLister(
  token: string,
): (repo: string, event: 'issues' | 'issue_comment', sinceIso: string) => Promise<readonly ProbeRun[]> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo, event, sinceIso) => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/actions/workflows/agent-router.yml/runs`, '-f', `event=${event}`, '-f', 'per_page=20', '--jq', '.workflow_runs'],
        { encoding: 'utf-8', env, maxBuffer: 4 * 1024 * 1024 },
      );
      const runs = JSON.parse(stdout) as readonly {
        id: number; status: string | null; conclusion: string | null; html_url: string; created_at: string;
      }[];
      const sinceMs = Date.parse(sinceIso);
      return runs
        .filter((r) => Date.parse(r.created_at) >= sinceMs)
        .map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, url: r.html_url, createdAt: r.created_at }));
    } catch {
      return [];
    }
  };
}

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

/** `<state>/macf/<project>@<agent-name>/channel.log` — derived from identity, never scanned. */
export function receiverLogPathFor(project: string, agentName: string | null): string | null {
  if (!agentName) return null;
  const state = process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
  return join(state, 'macf', `${project}@${agentName}`, 'channel.log');
}

export async function readLocalLog(path: string): Promise<TextRead> {
  try {
    return { kind: 'ok', text: await readFile(path, 'utf-8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', error: errMessage(err) };
  }
}
