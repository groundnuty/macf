/**
 * Tests for `plugin/scripts/check-git-sweep.sh` — the PreToolUse hook that
 * blocks `git stash -u`/`--include-untracked`/`-a`/`--all` and `git clean`
 * force+directories invocations when the untracked macf framework surface
 * (`.macf/**`, `.claude/scripts/check-*.sh`) would actually be swept.
 * groundnuty/macf#814 — the PREVENT half of the prevent+detect combination
 * (the DETECT half is check-framework-surface.sh).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
 * (stderr → Claude as the error). Override: MACF_SKIP_GIT_SWEEP_CHECK=1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-git-sweep.sh');

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
}

/** Build a real git repo with the macf framework surface present + untracked. */
function buildRepoWithUntrackedFramework(opts: { readonly track?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-sweep-repo-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.macf', 'plugin', 'hooks.json'), '{}');
  writeFileSync(join(dir, '.macf', 'macf-agent.json'), '{}');
  writeFileSync(join(dir, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\n');
  // A tracked file so the repo has at least one commit to be "real".
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  if (opts.track) {
    git(dir, ['add', '.macf', '.claude']);
    git(dir, ['commit', '-q', '-m', 'track framework files']);
  }
  return dir;
}

/** A git repo with no macf framework surface at all (nothing at risk). */
function buildPlainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-sweep-plain-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function nonGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-sweep-nongit-'));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(opts: {
  readonly command: string;
  readonly workspace: string;
  readonly env?: Record<string, string | undefined>;
}): RunResult {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    CLAUDE_PROJECT_DIR: opts.workspace,
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: cleanEnv,
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('check-git-sweep.sh (hook)', () => {
  describe('blocks — untracked framework surface at risk', () => {
    it('blocks `git stash push -u` when framework files are untracked', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash push -u -m wip', workspace: repo });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('BLOCKED by MACF git-sweep guard');
      expect(r.stderr).toContain('groundnuty/macf#814');
      expect(r.stderr).toContain('.macf/plugin');
    });

    it('blocks bare `git stash -u`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash -u', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `git stash --include-untracked`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash push --include-untracked', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `git stash -a` / `--all`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash --all', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `git clean -fd`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git clean -fd', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `git clean -fdx` / `-xdf` bundled forms', () => {
      const repo1 = buildRepoWithUntrackedFramework();
      expect(runHook({ command: 'git clean -fdx', workspace: repo1 }).status).toBe(2);
      const repo2 = buildRepoWithUntrackedFramework();
      expect(runHook({ command: 'git clean -xdf', workspace: repo2 }).status).toBe(2);
    });

    it('blocks `git clean -f -d` (separate short flags)', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git clean -f -d', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `git clean --force -d`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git clean --force -d', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('lists the actual at-risk paths in the block message', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash -u', workspace: repo });
      expect(r.stderr).toContain('.macf/plugin/hooks.json');
      expect(r.stderr).toContain('.macf/macf-agent.json');
      expect(r.stderr).toContain('.claude/scripts/check-gh-token.sh');
    });
  });

  describe('wrapper-form coverage', () => {
    it('blocks `sudo git stash -u`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'sudo git stash -u', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar git clean -fd`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'env FOO=bar git clean -fd', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks a bare `VAR=x git stash -u` prefix form', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'VAR=x git stash -u', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "git clean -xdf"`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'bash -c "git clean -xdf"', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "git stash --include-untracked"`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'bash -c "git stash --include-untracked"', workspace: repo });
      expect(r.status).toBe(2);
    });

    it('blocks a chained form after `&&`', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'make check && git stash -u', workspace: repo });
      expect(r.status).toBe(2);
    });
  });

  describe('allows — nothing at risk', () => {
    it('allows `git stash -u` when the framework surface is TRACKED (not untracked)', () => {
      const repo = buildRepoWithUntrackedFramework({ track: true });
      const r = runHook({ command: 'git stash push -u', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows `git clean -fd` in a repo with no macf framework surface at all', () => {
      const repo = buildPlainRepo();
      const r = runHook({ command: 'git clean -fd', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows bare `git stash` (no untracked flag — does not sweep untracked files)', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows `git stash push -m "wip"` (message only, no untracked flag)', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git stash push -m "wip"', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows `git stash pop` / `git stash drop` / `git stash list`', () => {
      const repo = buildRepoWithUntrackedFramework();
      expect(runHook({ command: 'git stash pop', workspace: repo }).status).toBe(0);
      expect(runHook({ command: 'git stash drop stash@{0}', workspace: repo }).status).toBe(0);
      expect(runHook({ command: 'git stash list', workspace: repo }).status).toBe(0);
    });

    it('allows `git clean -n -d` (dry run, no force)', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git clean -n -d', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows `git clean -f` alone (force but no directories)', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({ command: 'git clean -f', workspace: repo });
      expect(r.status).toBe(0);
    });

    it('allows entirely unrelated commands', () => {
      const repo = buildRepoWithUntrackedFramework();
      expect(runHook({ command: 'gh pr view 1', workspace: repo }).status).toBe(0);
      expect(runHook({ command: 'git push -u origin main', workspace: repo }).status).toBe(0);
      expect(runHook({ command: 'make -f dev.mk check', workspace: repo }).status).toBe(0);
    });
  });

  describe('override', () => {
    it('MACF_SKIP_GIT_SWEEP_CHECK=1 allows a sweep that would otherwise be blocked', () => {
      const repo = buildRepoWithUntrackedFramework();
      const r = runHook({
        command: 'git stash -u',
        workspace: repo,
        env: { MACF_SKIP_GIT_SWEEP_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('fail-open on infra errors', () => {
    it('allows when the workspace is not a git repo at all', () => {
      const dir = nonGitDir();
      mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
      const r = runHook({ command: 'git stash -u', workspace: dir });
      expect(r.status).toBe(0);
    });

    it('allows when the command payload has no extractable command', () => {
      const repo = buildRepoWithUntrackedFramework();
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: JSON.stringify({ session_id: 'test', tool_name: 'Bash', tool_input: {} }),
        env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: repo },
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
    });
  });
});
