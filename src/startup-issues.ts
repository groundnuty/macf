import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './types.js';

const execFileAsync = promisify(execFile);

interface PendingIssue {
  readonly number: number;
  readonly title: string;
}

/**
 * Query GitHub for open issues assigned to this agent and push
 * a startup_check notification for each one.
 */
export async function checkPendingIssues(config: {
  readonly repo: string;
  readonly agentLabel: string;
  readonly token: string;
  readonly onNotify: (payload: {
    readonly type: 'startup_check';
    readonly message: string;
    readonly issue_number: number;
    readonly title: string;
    readonly source: string;
  }) => Promise<void>;
  readonly logger: Logger;
}): Promise<void> {
  const { repo, agentLabel, token, onNotify, logger } = config;

  let issues: readonly PendingIssue[];
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--label', agentLabel,
      '--state', 'open',
      '--json', 'number,title',
    ], {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: token },
    });

    issues = JSON.parse(stdout) as readonly PendingIssue[];
  } catch (err) {
    logger.warn('startup_issues_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (issues.length === 0) {
    logger.info('startup_issues_none', { repo, label: agentLabel });
    return;
  }

  logger.info('startup_issues_found', { count: issues.length });

  const summaries = issues.map(i => `#${i.number}: ${i.title}`);
  const message = `Pending issues found at startup:\n${summaries.join('\n')}`;

  await onNotify({
    type: 'startup_check',
    message,
    issue_number: issues[0]!.number,
    title: issues[0]!.title,
    source: 'startup',
  });
}
