/**
 * Real-git test for `realCommitAndPush` (agent-repo repo-init's `git add -A`
 * commit primitive) — asserts the DR-043 Amendment F #857 review's "Critical
 * subtlety" holds: agent-repo repo-init keeps its unchanged `-A` behavior
 * (only the control repo's commit path moved to an explicit allowlist; see
 * `control-repo-commit.test.ts` for that half). Same offline
 * bare-upstream-plus-clone harness as `test/cli/self-update.test.ts` /
 * `control-repo-commit.test.ts` — no network egress.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realCommitAndPush } from '../../../src/cli/bootstrap/apply-repo-init.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('realCommitAndPush (agent repo-init — unchanged -A behavior)', () => {
  let tmpRoot: string;
  let upstream: string;
  let workDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-repoinit-commit-test-'));
    upstream = join(tmpRoot, 'upstream.git');

    const seed = join(tmpRoot, 'seed');
    mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'config', 'user.email', 'test@example.invalid');
    git(seed, 'config', 'user.name', 'Test');
    git(seed, 'commit', '--allow-empty', '-q', '-m', 'seed');
    execFileSync('git', ['clone', '-q', '--bare', seed, upstream], { stdio: 'ignore' });

    workDir = join(tmpRoot, 'work');
    execFileSync('git', ['clone', '-q', '-b', 'main', upstream, workDir], { stdio: 'ignore' });
    git(workDir, 'config', 'user.email', 'test@example.invalid');
    git(workDir, 'config', 'user.name', 'Test');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('stages EVERYTHING (-A) — including files repoInit() wrote that are not on the control-repo allowlist', async () => {
    mkdirSync(join(workDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(workDir, '.github', 'workflows', 'agent-router.yml'), 'name: router\n', 'utf-8');
    writeFileSync(join(workDir, '.github', 'agent-config.json'), '{}\n', 'utf-8');
    // A file that would NOT be on the control-repo allowlist — must still be
    // swept in here, since this is the agent-repo path, not the control-repo
    // path.
    writeFileSync(join(workDir, 'README.md'), '# demo\n', 'utf-8');

    const result = await realCommitAndPush(workDir, 'chore(routing): repo-init');

    expect(result).toBe('pushed');
    const committed = git(workDir, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n');
    expect(committed).toEqual(
      expect.arrayContaining(['.github/workflows/agent-router.yml', '.github/agent-config.json', 'README.md']),
    );
  });
});
