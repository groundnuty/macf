/**
 * Source-shape regression guard for the `issues` command wiring (macf#816 —
 * generic, non-hardwired work-discovery). `main()` is env/network-heavy
 * (mints a live GitHub token, shells out to `gh`), so exercising it directly
 * isn't practical here — the actual queue-union + fail-soft behavior is unit
 * tested in `test/plugin/lib/work.test.ts` and the compact-line rendering in
 * `test/plugin/lib/format.test.ts`. This file pins that the `issues` case
 * actually WIRES those primitives together, mirroring the pragmatic
 * source-shape posture `guest-peers-wiring.test.ts` already established for
 * the `peers`/`ping` cases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = readFileSync(join(repoRoot, 'src', 'plugin', 'bin', 'macf-plugin-cli.ts'), 'utf-8');

function issuesCaseSource(): string {
  const start = cliSrc.indexOf("case 'issues'");
  const end = cliSrc.indexOf('default:');
  return cliSrc.slice(start, end);
}

describe('macf-plugin-cli issues — generic work-discovery wiring (#816)', () => {
  it('imports checkAllPendingWork + resolveSelfLogin from work.js (not the narrower checkIssuesAcrossFleet alone)', () => {
    expect(cliSrc).toContain("from '../lib/work.js'");
    expect(cliSrc).toContain('checkAllPendingWork');
    expect(cliSrc).toContain('resolveSelfLogin');
  });

  it('imports formatIssuesOneline from format.js', () => {
    expect(cliSrc).toContain('formatIssuesOneline');
  });

  it('the issues case resolves selfLogin and passes it into checkAllPendingWork', () => {
    const issuesCase = issuesCaseSource();
    expect(issuesCase).toContain('resolveSelfLogin(');
    expect(issuesCase).toMatch(/checkAllPendingWork\(\{[^)]*selfLogin/s);
  });

  it('the issues case supports a --oneline compact mode gated on argv[3]', () => {
    const issuesCase = issuesCaseSource();
    expect(issuesCase).toContain("'--oneline'");
    expect(issuesCase).toContain('formatIssuesOneline(issues)');
  });

  it('the --oneline branch returns before draining the inbox (no double-drain / no side effect on a list-only query)', () => {
    const issuesCase = issuesCaseSource();
    const onelineBranchStart = issuesCase.indexOf("'--oneline'");
    const onelineBranchEnd = issuesCase.indexOf('break;', onelineBranchStart);
    const onelineBranch = issuesCase.slice(onelineBranchStart, onelineBranchEnd);
    expect(onelineBranch).not.toContain('drainInbox');
    expect(onelineBranch).not.toContain('getInboxStore');
  });
});
