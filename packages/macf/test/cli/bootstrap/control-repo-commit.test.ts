/**
 * Real-git tests for `realControlRepoCommitAndPush` — the control repo's
 * explicit-allowlist commit primitive (DR-043 Amendment F, groundnuty/macf#857
 * review). Deliberately NOT injected/faked: the whole point of this function
 * is what it actually stages, so these tests run real `git` against a local
 * bare "upstream" + a real clone (offline — a filesystem path remote, same
 * harness shape as `test/cli/self-update.test.ts`). No network egress.
 *
 * `control-repo.test.ts` covers everything else in this module with injected
 * `ControlRepoDeps` — see that file's doc for why the split.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  realControlRepoCommitAndPush,
  CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY,
} from '../../../src/cli/bootstrap/control-repo.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('realControlRepoCommitAndPush', () => {
  let tmpRoot: string;
  let upstream: string;
  let workDir: string;

  beforeEach(() => {
    // Real bare upstream + a real clone, exactly the shape `provisionControlRepo`
    // hands `commitAndPush` in production (a freshly cloned checkout) — see
    // self-update.test.ts for the same harness pattern applied elsewhere in
    // this package.
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-control-commit-test-'));
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

  it('stages + commits + pushes ONLY the allowlist files that exist, and NEVER secrets/recovery/*', async () => {
    writeFileSync(join(workDir, 'fleet.yaml'), 'apiVersion: macf/v0\n', 'utf-8');
    writeFileSync(join(workDir, 'fleet.lock'), '{}\n', 'utf-8');
    mkdirSync(join(workDir, 'secrets', 'recovery'), { recursive: true });
    // A recovery artifact left behind by a failed batched compose (Amendment
    // B, §D5) — the exact hazard the reviewer's ruling closes.
    writeFileSync(join(workDir, 'secrets', 'recovery', 'code-agent.age'), 'age-encryption-ciphertext-not-real', 'utf-8');
    // A file OUTSIDE the allowlist entirely — must never be swept in either
    // (this is what `-A` would have grabbed and the allowlist must not).
    writeFileSync(join(workDir, 'scratch-notes.txt'), 'not part of the control repo state', 'utf-8');

    const result = await realControlRepoCommitAndPush(workDir, 'test: control repo commit');

    expect(result).toBe('pushed');
    const committed = git(workDir, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n');
    expect(committed).toContain('fleet.yaml');
    expect(committed).toContain('fleet.lock');
    expect(committed).not.toContain('secrets/recovery/code-agent.age');
    expect(committed).not.toContain('scratch-notes.txt');
    // Recovery artifact is left on disk (never deleted by this function —
    // that's `apply-fleet.ts`'s job on a successful vault compose) but
    // untracked/unstaged. `git status --porcelain` collapses an entirely
    // untracked DIRECTORY to its dirname (`?? secrets/`), so list untracked
    // files individually rather than pattern-matching the summarized form.
    expect(existsSync(join(workDir, 'secrets', 'recovery', 'code-agent.age'))).toBe(true);
    const untracked = git(workDir, 'ls-files', '-o', '--exclude-standard').split('\n');
    expect(untracked).toContain('secrets/recovery/code-agent.age');
    expect(untracked).toContain('scratch-notes.txt');

    // The pushed commit landed on the bare upstream too, not just locally.
    const upstreamCommitted = execFileSync('git', ['ls-tree', '-r', 'main', '--name-only'], { cwd: upstream, encoding: 'utf-8' })
      .trim()
      .split('\n');
    expect(upstreamCommitted).toContain('fleet.yaml');
    expect(upstreamCommitted).not.toContain('secrets/recovery/code-agent.age');
  });

  it('commits + pushes secrets/vault.age and .gitignore when present (full allowlist)', async () => {
    writeFileSync(join(workDir, 'fleet.yaml'), 'apiVersion: macf/v0\n', 'utf-8');
    writeFileSync(join(workDir, 'fleet.lock'), '{}\n', 'utf-8');
    mkdirSync(join(workDir, 'secrets'), { recursive: true });
    writeFileSync(join(workDir, 'secrets', 'vault.age'), 'age-encrypted-vault-not-real', 'utf-8');
    writeFileSync(join(workDir, '.gitignore'), `${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`, 'utf-8');

    const result = await realControlRepoCommitAndPush(workDir, 'test: full allowlist');

    expect(result).toBe('pushed');
    const committed = git(workDir, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n');
    expect(committed).toEqual(expect.arrayContaining(['fleet.yaml', 'fleet.lock', 'secrets/vault.age', '.gitignore']));
  });

  it('a MISSING allowlist file (e.g. no vault.age yet) does not fail the sync — stages whatever DOES exist', async () => {
    writeFileSync(join(workDir, 'fleet.yaml'), 'apiVersion: macf/v0\n', 'utf-8');
    // No fleet.lock, no secrets/vault.age, no .gitignore.

    const result = await realControlRepoCommitAndPush(workDir, 'test: partial allowlist');

    expect(result).toBe('pushed');
    const committed = git(workDir, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n');
    expect(committed).toEqual(['fleet.yaml']);
  });

  it('returns "nothing-to-commit" when no allowlist file exists and nothing is staged', async () => {
    // Working tree has ONLY a non-allowlisted file (untracked) — no
    // allowlist path exists at all.
    writeFileSync(join(workDir, 'scratch-notes.txt'), 'irrelevant', 'utf-8');

    const result = await realControlRepoCommitAndPush(workDir, 'test: nothing to commit');

    expect(result).toBe('nothing-to-commit');
    // Nothing was committed — HEAD unchanged from the seed commit.
    expect(git(workDir, 'log', '-1', '--pretty=%s')).toBe('seed');
  });

  it('returns "nothing-to-commit" on a second call when the allowlist content is unchanged', async () => {
    writeFileSync(join(workDir, 'fleet.yaml'), 'apiVersion: macf/v0\n', 'utf-8');
    const first = await realControlRepoCommitAndPush(workDir, 'first commit');
    expect(first).toBe('pushed');

    // No changes since — same content, nothing new to stage.
    const second = await realControlRepoCommitAndPush(workDir, 'second commit (should no-op)');
    expect(second).toBe('nothing-to-commit');
  });

  it('does NOT swallow a real staging failure (git add on a genuinely broken repo propagates)', async () => {
    // Point the function at a directory that is NOT a git repo at all —
    // `git add` (and every other git call) must fail loudly, not resolve to
    // a success-shaped return value.
    const notARepo = join(tmpRoot, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    writeFileSync(join(notARepo, 'fleet.yaml'), 'apiVersion: macf/v0\n', 'utf-8');

    await expect(realControlRepoCommitAndPush(notARepo, 'should throw')).rejects.toThrow();
  });
});
