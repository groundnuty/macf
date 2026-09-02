/**
 * Tests for `macf rules refresh` — distributes canonical rules + scripts
 * to any workspace, independent of `.macf/macf-agent.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rulesRefresh } from '../../src/cli/commands/rules-refresh.js';

// `findCliPackageRoot` wrapped in `vi.fn()` (delegating to the real
// implementation by default) so the #1401 guard-integration tests below can
// override JUST that one call — `rulesRefresh` imports `copyCanonicalAssetsGuarded`
// from `canonical-overwrite-guard.js`, which itself calls `findCliPackageRoot`
// from THIS mocked module when no explicit `packageRoot` is passed. Same
// shape + same same-module-self-call caveat as `update.test.ts`'s top-of-file
// mock comment: `copyCanonicalRules` / `copyCanonicalScripts` are left real +
// unmocked, and their OWN internal default-parameter resolution of
// `findCliPackageRoot()` bypasses this mock (a same-module self-call vitest
// cannot intercept) — they always copy from THIS repo's real canonical
// sources regardless of the fixture root the guard judges staleness against.
vi.mock('../../src/cli/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/rules.js')>();
  return {
    ...actual,
    findCliPackageRoot: vi.fn(actual.findCliPackageRoot),
  };
});

import { findCliPackageRoot } from '../../src/cli/rules.js';

describe('rulesRefresh', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-rules-refresh-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('works on a workspace with no .macf/ directory', () => {
    // The whole point of this command: workspaces without `macf init`.
    expect(existsSync(join(tmpRoot, '.macf'))).toBe(false);

    const result = rulesRefresh(tmpRoot);

    // Real canonical files exist in-repo, so we get real output.
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.rules).toContain('coordination.md');
    expect(result.scripts).toContain('tmux-send-to-claude.sh');

    // Files landed where expected.
    expect(existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.claude', 'scripts', 'tmux-send-to-claude.sh'))).toBe(true);

    // .macf/ still absent — we didn't create it.
    expect(existsSync(join(tmpRoot, '.macf'))).toBe(false);
  });

  it('works on a workspace that already has a .claude/ with hand-curated files', () => {
    // Simulate an existing workspace like groundnuty/macf: .claude/ exists
    // with a hand-curated agent-identity.md that we must not touch.
    const claudeDir = join(tmpRoot, '.claude');
    const rulesDir = join(claudeDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'agent-identity.md'), '# hand-curated\n');

    rulesRefresh(tmpRoot);

    // Hand-curated file is untouched.
    expect(existsSync(join(rulesDir, 'agent-identity.md'))).toBe(true);
    // Canonical file arrived alongside it.
    expect(existsSync(join(rulesDir, 'coordination.md'))).toBe(true);
  });

  it('is idempotent — running twice leaves the same final state', () => {
    rulesRefresh(tmpRoot);
    const first = existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'));

    // Second call should not crash and should leave the file in place.
    expect(() => rulesRefresh(tmpRoot)).not.toThrow();
    const second = existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'));

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('throws when target directory does not exist', () => {
    const missing = join(tmpRoot, 'does-not-exist');
    expect(() => rulesRefresh(missing)).toThrow(/does not exist/);
  });

  it('throws when target path is a file, not a directory', () => {
    const filePath = join(tmpRoot, 'notadir');
    writeFileSync(filePath, 'just a file');
    expect(() => rulesRefresh(filePath)).toThrow(/not a directory/);
  });
});

describe('canonical-overwrite guard integration (groundnuty/macf#1401, extending #1386 from update alone)', () => {
  // Local git-fixture helpers, matching the shape update.test.ts /
  // canonical-overwrite-guard.test.ts already use — never invents a second
  // staleness notion of its own to test against.
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function gitUserConfig(cwd: string): void {
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'commit.gpgsign', 'false');
  }
  function writePackageJson(pkgDir: string, name = '@fake-scope/fake-cli'): void {
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }
  /** A stale fake CLI checkout: `behindBy` commits behind origin/main. */
  function makeStaleFakeCliCheckout(pkgDir: string, remote: string, behindBy: number): void {
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    writePackageJson(pkgDir);
    git(pkgDir, 'init', '-q', '-b', 'main');
    gitUserConfig(pkgDir);
    git(pkgDir, 'commit', '-q', '--allow-empty', '-m', 'initial');
    git(pkgDir, 'remote', 'add', 'origin', remote);
    git(pkgDir, 'push', '-q', '-u', 'origin', 'main');
    const throwaway = join(dirname(remote), `throwaway-clone-${Math.random().toString(36).slice(2)}`);
    git(dirname(remote), 'clone', '-q', remote, throwaway);
    gitUserConfig(throwaway);
    for (let i = 0; i < behindBy; i++) {
      git(throwaway, 'commit', '-q', '--allow-empty', '-m', `advance ${i}`);
    }
    git(throwaway, 'push', '-q', 'origin', 'HEAD:main');
    rmSync(throwaway, { recursive: true, force: true });
    git(pkgDir, 'fetch', '-q', 'origin');
    // A REAL canonical rule NAME (coordination.md) — the guard's staleness
    // judgment reads THIS fixture dir, but the actual copy (once it
    // proceeds) always runs against THIS repo's own real canonical source
    // (copyCanonicalRules's same-module self-call bypasses the mock above —
    // see this file's top-of-file mock comment), so only a filename the
    // real canonical dir ALSO contains will be meaningfully overwritten.
    mkdirSync(join(pkgDir, 'plugin', 'rules'), { recursive: true });
    writeFileSync(join(pkgDir, 'plugin', 'rules', 'coordination.md'), '<!-- fake stale canonical -->\nirrelevant\n');
  }

  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-rules-refresh-guard-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('DECISIVE PAIR (1/2) — REACHABILITY: refuses through the real `rulesRefresh()` command — a pre-existing workspace rule is left untouched when the installed CLI checkout is stale', () => {
    const fakeRoot = join(tmpRoot, '..', `fake-stale-cli-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, '..', `fake-stale-remote-${Math.random().toString(36).slice(2)}.git`);
    // A deliberately distinctive count — see update.test.ts's identical
    // REACHABILITY test for why (this repo's own checkout may itself be a
    // few commits behind at test-run time; a distinctive count makes a
    // silently-bypassed mock assert-visible instead of coincidentally
    // passing).
    makeStaleFakeCliCheckout(fakeRoot, remote, 53);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    const sentinel = '<!-- test -->\nWORKSPACE HAS SOMETHING NEWER — must survive\n';
    writeFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), sentinel);

    const result = rulesRefresh(tmpRoot);

    expect(readFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), 'utf-8')).toBe(sentinel);
    expect(result.refused).toBe(true);
    expect(result.rules).toEqual([]);
    const allErrors = errorSpy.mock.calls.flat().join('\n');
    expect(allErrors).toMatch(/Refused:/);
    expect(allErrors).toMatch(/53 commit\(s\) behind/);
    expect(allErrors).toContain(join('.claude', 'rules', 'coordination.md'));

    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('DECISIVE PAIR (2/2) — REACHABILITY: a current checkout proceeds through the real `rulesRefresh()` command — real canonical content lands', () => {
    const fakeRoot = join(tmpRoot, '..', `fake-current-cli-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, '..', `fake-current-remote-${Math.random().toString(36).slice(2)}.git`);
    makeStaleFakeCliCheckout(fakeRoot, remote, 0);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    const result = rulesRefresh(tmpRoot);

    expect(result.refused).toBe(false);
    expect(result.rules).toContain('coordination.md');
    expect(errorSpy.mock.calls.flat().join('\n')).not.toMatch(/Refused:/);

    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('--force overrides the refusal — the file IS overwritten, with a warning noting the override', () => {
    const fakeRoot = join(tmpRoot, '..', `fake-stale-cli-force-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, '..', `fake-stale-remote-force-${Math.random().toString(36).slice(2)}.git`);
    makeStaleFakeCliCheckout(fakeRoot, remote, 61);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    const sentinel = '<!-- test -->\nWORKSPACE HAS SOMETHING NEWER — should be overwritten by --force\n';
    writeFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), sentinel);

    const result = rulesRefresh(tmpRoot, { force: true });

    expect(readFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), 'utf-8')).not.toBe(sentinel);
    expect(result.refused).toBe(false);
    const warnOut = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(warnOut).toMatch(/--force overriding a stale-CLI overwrite refusal/);
    expect(warnOut).toMatch(/61 commit\(s\) behind/);

    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });
});
