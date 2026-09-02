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
import { dirname, join, relative } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCanonicalOverwriteSafety, copyCanonicalAssetsGuarded } from '../../src/cli/canonical-overwrite-guard.js';

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

describe('copyCanonicalAssetsGuarded (groundnuty/macf#1401 — the shared entry point every writer routes through)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-copy-canonical-guarded-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---

  it('DECISIVE PAIR (1/2): refuse + no force → the copy is SKIPPED — rules/scripts empty, `copied: false`, workspace file untouched', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 3);
    seedCanonicalSources(packageRoot, 'OLD CANONICAL\n');

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    const sentinel = ruleFile('NEWER WORKSPACE RULE — must survive\n');
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), sentinel);

    const outcome = copyCanonicalAssetsGuarded(workspaceDir, { packageRoot, canonicalBranch: 'main' });

    expect(outcome.copied).toBe(false);
    expect(outcome.rules).toEqual([]);
    expect(outcome.scripts).toEqual([]);
    expect(outcome.guard.kind).toBe('refuse');
    // The real copyCanonicalRules (unmocked here — a direct unit call, not
    // routed through a module mock) would have overwritten this file with
    // THIS repo's actual coordination.md content had the guard not skipped
    // the call entirely. Proves the skip is real, not just a reported verdict.
    expect(readFileSync(join(workspaceDir, '.claude', 'rules', 'test-rule.md'), 'utf-8')).toBe(sentinel);
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with canonical proceeds — real canonical content lands, `copied: true`', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 0);
    seedCanonicalSources(packageRoot, 'unused — copyCanonicalRules resolves its OWN default source dir\n');
    mkdirSync(workspaceDir, { recursive: true });

    const outcome = copyCanonicalAssetsGuarded(workspaceDir, { packageRoot, canonicalBranch: 'main' });

    expect(outcome.copied).toBe(true);
    expect(outcome.guard.kind).toBe('proceed');
    // Real canonical content from THIS repo lands (copyCanonicalRules is
    // called with no explicit canonicalDir — see the function's own doc
    // comment for why that's deliberate).
    expect(outcome.rules).toContain('coordination.md');
    expect(outcome.scripts.length).toBeGreaterThan(0);
    expect(readFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), 'utf-8').length).toBeGreaterThan(0);
  });

  it('--force overrides an un-forced refusal — `copied: true`, guard still reports `refuse`, the file IS overwritten', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');

    makeStaleCheckout(packageRoot, remote, 5);
    // Seed the FIXTURE's canonical rules dir under a REAL canonical rule
    // NAME (coordination.md) — not the generic `test-rule.md` this file's
    // shared `seedCanonicalSources` helper uses. The ACTUAL copy below runs
    // against THIS repo's real canonical source (copyCanonicalAssetsGuarded
    // never threads the fixture packageRoot into the real copy call — see
    // its own doc comment), so only a filename the REAL canonical dir also
    // contains will actually get overwritten by the assertion below.
    mkdirSync(join(packageRoot, 'plugin', 'rules'), { recursive: true });
    writeFileSync(join(packageRoot, 'plugin', 'rules', 'coordination.md'), ruleFile('OLD CANONICAL\n'));

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    const sentinel = ruleFile('WORKSPACE HAS SOMETHING NEWER — should be overwritten by --force\n');
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), sentinel);

    const outcome = copyCanonicalAssetsGuarded(workspaceDir, {
      packageRoot,
      canonicalBranch: 'main',
      force: true,
    });

    expect(outcome.copied).toBe(true);
    expect(outcome.guard.kind).toBe('refuse'); // the verdict is unchanged by force — only the ACTION changes
    expect(readFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), 'utf-8')).not.toBe(sentinel);
  });

  it('unknown currency proceeds — `copied: true`, guard reports `unknown`', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const workspaceDir = join(tmp, 'workspace');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fake-scope/fake-cli', version: '0.0.0' }));
    initRepo(packageRoot); // a git checkout, but no origin remote at all
    mkdirSync(workspaceDir, { recursive: true });

    const outcome = copyCanonicalAssetsGuarded(workspaceDir, { packageRoot, canonicalBranch: 'main' });

    expect(outcome.copied).toBe(true);
    expect(outcome.guard.kind).toBe('unknown');
  });

  it('MUTATION: a mutant that always skips (copied: false unconditionally) would drop the real copy on the proceed path — this assertion catches it', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const workspaceDir = join(tmp, 'workspace');
    makeStaleCheckout(packageRoot, remote, 0);
    seedCanonicalSources(packageRoot, 'irrelevant\n');
    mkdirSync(workspaceDir, { recursive: true });

    const outcome = copyCanonicalAssetsGuarded(workspaceDir, { packageRoot, canonicalBranch: 'main' });
    expect(outcome.copied).toBe(true);
    expect(outcome.rules.length).toBeGreaterThan(0);
  });

  it('defaults `packageRoot` to `findCliPackageRoot()` when omitted — the real running CLI, not a fixture', () => {
    const workspaceDir = join(tmp, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    // No packageRoot option — must resolve THIS repo's own root and judge
    // against it rather than throwing or silently no-op'ing.
    const outcome = copyCanonicalAssetsGuarded(workspaceDir, { canonicalBranch: 'main' });

    expect(['proceed', 'unknown', 'refuse']).toContain(outcome.guard.kind);
    // Whatever the verdict, this repo's real canonical rules dir is non-empty,
    // so a 'refuse' here (this repo's OWN checkout behind its own origin/main
    // at test-run time) is the only branch that would leave rules empty.
    if (outcome.guard.kind !== 'refuse') {
      expect(outcome.rules.length).toBeGreaterThan(0);
    }
  });
});

// --- Source-shape audit: only the guard module / rules.ts may call the raw copy functions ---
//
// `copyCanonicalAssetsGuarded` above is the single guarded entry point. If a
// FIFTH (or sixth, ...) command file under `src/cli/commands/` were to
// import `copyCanonicalRules` / `copyCanonicalScripts` from `rules.js`
// directly and call them, it would silently reproduce the exact #1386 class
// this whole module exists to close — bypassing the guard entirely, with no
// runtime signal. This is the structural guarantee that makes coverage a
// property of the CODE SHAPE, not of an enumerated list of call sites that
// can silently go stale the next time someone adds a command.
const RAW_COPY_CALL_PATTERN = /\bcopyCanonicalRules\(|\bcopyCanonicalScripts\(/;

function listCommandTsFiles(commandsDir: string): string[] {
  return readdirSync(commandsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(commandsDir, e.name));
}

describe('source-shape audit: only canonical-overwrite-guard.ts / rules.ts call the raw copy functions (groundnuty/macf#1401)', () => {
  const commandsDir = fileURLToPath(new URL('../../src/cli/commands', import.meta.url));

  // Decisive per assert-the-wrong-path.md: prove the scanner actually fires
  // before trusting its "clean" verdict on the real tree below.
  it('FIRES on a synthetic direct call to copyCanonicalRules', () => {
    const bad = "const rules = copyCanonicalRules(absDir);";
    expect(RAW_COPY_CALL_PATTERN.test(bad)).toBe(true);
  });

  it('FIRES on a synthetic direct call to copyCanonicalScripts', () => {
    const bad = "const scripts = copyCanonicalScripts(targetDir, { canonicalDir });";
    expect(RAW_COPY_CALL_PATTERN.test(bad)).toBe(true);
  });

  it('does NOT fire on a call to the guarded helper (copyCanonicalAssetsGuarded(...), not the raw functions)', () => {
    const ok = "const outcome = copyCanonicalAssetsGuarded(absDir, { packageRoot, canonicalBranch });";
    expect(RAW_COPY_CALL_PATTERN.test(ok)).toBe(false);
  });

  it('no file under src/cli/commands/ calls copyCanonicalRules / copyCanonicalScripts directly', () => {
    const files = listCommandTsFiles(commandsDir);
    expect(files.length).toBeGreaterThan(10); // sanity: the walker found the tree

    const violators = files
      .filter((f) => RAW_COPY_CALL_PATTERN.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(commandsDir, f));

    expect(violators).toEqual([]);
  });
});
