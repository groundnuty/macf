import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PendingIssue {
  readonly number: number;
  readonly title: string;
}

/**
 * Check for pending GitHub issues assigned to this agent.
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

    return JSON.parse(stdout) as readonly PendingIssue[];
  } catch (err) {
    process.stderr.write(
      `Warning: failed to check issues: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}
