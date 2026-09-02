/**
 * Tests for `checkCanonicalOverwriteSafety` (groundnuty/macf#1386) — the
 * refusal that stops `macf update` from silently reverting a workspace's
 * `.claude/rules/` / `.claude/scripts/` files when the installed CLI's OWN
 * checkout is behind its canonical branch. `#1384` made `macf doctor` WARN
 * about this same staleness axis; this is the structural refusal a
 * read-only warning could never become on its own.
 *
 * Deliberately reuses `detectCheckoutCurrency` (`#1376`) — every fixture
 * below follows the same git-fixture shape `build-info.test.ts` /
 * `doctor-checkout-currency.test.ts` already use, so this file never invents
 * a second staleness notion of its own to test against.
 *
 * Every rendered test constructs an INDEPENDENT fixture and asserts a
 * hardcoded expectation — never re-deriving "expected" from the function
 * under test (assert-the-wrong-path.md Trigger 1).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCanonicalOverwriteSafety } from '../../src/cli/canonical-overwrite-guard.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitUserConfig(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  gitUserConfig(dir);
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'initial');
}

function writePackageJson(dir: string, name = '@fake-scope/fake-cli'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

/**
 * A rule body that already carries the `<!--` managed-header marker
 * `computeCanonicalRuleFile` / `copyCanonicalRules` prepend when absent —
 * so what this seeds IS exactly what the guard computes as "would write",
 * with no header-prepend subtlety for fixtures to account for.
 */
function ruleFile(body: string): string {
  return `<!-- test -->\n${body}`;
}

/** Seed `packageRoot`'s canonical rule + script sources (on-disk only — never git-committed, matching detectCheckoutCurrency's own fixtures: identity + content are read straight off disk, not from git history). */
function seedCanonicalSources(
  packageRoot: string,
  ruleBody: string,
  scriptBody = '#!/bin/sh\necho old\n',
): void {
  mkdirSync(join(packageRoot, 'plugin', 'rules'), { recursive: true });
  writeFileSync(join(packageRoot, 'plugin', 'rules', 'test-rule.md'), ruleFile(ruleBody));
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  writeFileSync(join(packageRoot, 'scripts', 'test-script.sh'), scriptBody);
}

/**
 * Build `dir` as a git checkout of `remote` that is exactly `behindBy`
 * commits behind `origin/main` — `dir`'s own HEAD + working tree stay
 * exactly where they were first pushed; the advancing commits land via a
 * throwaway second clone, mirroring a real "someone else pushed to
 * origin/main and this checkout was never pulled" scenario. Ends with an
 * operator-style `git fetch` so `origin/main` resolves locally (the check
 * itself never fetches).
 */
function makeStaleCheckout(dir: string, remote: string, behindBy: number): void {
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '--initial-branch=main');

  writePackageJson(dir);
  initRepo(dir);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');

  if (behindBy > 0) {
    const throwaway = join(dirname(remote), 'throwaway-clone');
    git(dirname(remote), 'clone', '-q', remote, throwaway);
    gitUserConfig(throwaway);
    for (let i = 0; i < behindBy; i++) {
      git(throwaway, 'commit', '-q', '--allow-empty', '-m', `advance ${i}`);
    }
    git(throwaway, 'push', '-q', 'origin', 'HEAD:main');
  }

  git(dir, 'fetch', '-q', 'origin'); // operator-style local refresh, not the check itself
}

describe('checkCanonicalOverwriteSafety (groundnuty/macf#1386)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-canonical-overwrite-guard-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---

  it('DECISIVE PAIR (1/2): stale checkout + a workspace rule that differs from canonical → refused, naming the file and the lag', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 2);
    seedCanonicalSources(packageRoot, 'OLD CANONICAL RULE\n');

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile('NEWER WORKSPACE RULE\n'));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('refuse');
    if (result.kind !== 'refuse') throw new Error('unreachable');
    expect(result.files).toContain(join('.claude', 'rules', 'test-rule.md'));
    expect(result.detail).toMatch(/2 commit\(s\) behind/);
    expect(result.detail).toContain('origin/main');
    expect(result.detail).toContain(join('.claude', 'rules', 'test-rule.md'));
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with canonical proceeds even when workspace content differs', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 0);
    seedCanonicalSources(packageRoot, 'CANONICAL RULE\n');

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile('DIFFERENT WORKSPACE RULE\n'));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('proceed');
    expect(result.detail).toMatch(/current/i);
  });

  it('identical content is not a downgrade — stale checkout + a byte-identical workspace file proceeds without refusal', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');
    const body = 'SAME CONTENT\n';

    makeStaleCheckout(packageRoot, remote, 3);
    seedCanonicalSources(packageRoot, body);

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile(body));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('proceed');
    expect(result.detail).not.toMatch(/refus/i);
  });

  it('a fresh workspace with no existing rule/script copies proceeds even when the checkout is stale — nothing to protect yet', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    makeStaleCheckout(packageRoot, remote, 5);
    seedCanonicalSources(packageRoot, 'ANY CONTENT\n');

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('proceed');
  });

  it('npm-installed CLI (no .git checkout at all) is unaffected — proceeds regardless of workspace content', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const workspaceDir = join(tmp, 'workspace');
    writePackageJson(packageRoot);
    seedCanonicalSources(packageRoot, 'CANONICAL\n'); // no git init at all — the plain npm-install shape

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile('DIFFERENT\n'));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('proceed');
    expect(result.detail).toMatch(/not a git checkout/i);
  });

  it('unknown currency (no origin remote configured) never refuses — proceeds, saying the reference point could not be dated', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const workspaceDir = join(tmp, 'workspace');
    writePackageJson(packageRoot);
    initRepo(packageRoot); // a git checkout, but no origin remote at all

    seedCanonicalSources(packageRoot, 'CANONICAL\n');
    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile('DIFFERENT\n'));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('unknown');
    expect(result.kind).not.toBe('refuse');
    expect(result.detail).toMatch(/cannot determine/i);
  });

  it('protects .claude/scripts/ the same way as .claude/rules/', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 1);
    seedCanonicalSources(packageRoot, 'CANONICAL RULE\n', '#!/bin/sh\necho OLD\n');

    mkdirSync(join(workspaceDir, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'scripts', 'test-script.sh'), '#!/bin/sh\necho NEWER\n');

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('refuse');
    if (result.kind !== 'refuse') throw new Error('unreachable');
    expect(result.files).toContain(join('.claude', 'scripts', 'test-script.sh'));
  });

  it('MUTATION: reverting to always-proceed would silently accept the exact overwrite this guard exists to refuse', () => {
    // Same fixture as the decisive-pair refuse case above. A mutant that
    // always returns 'proceed' (the pre-#1386 behavior — no guard at all)
    // makes this assertion fail, because 'refuse' is the only kind that
    // carries a non-empty `files` list naming the at-risk file.
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 1);
    seedCanonicalSources(packageRoot, 'OLD\n');
    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), ruleFile('NEW\n'));

    const result = checkCanonicalOverwriteSafety(workspaceDir, packageRoot, 'main');
    expect(result.kind).toBe('refuse');
  });
});
