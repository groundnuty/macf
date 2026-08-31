/**
 * Tests for `src/cli/build-info.ts` — stale-dist detection (#144).
 *
 * Two public functions:
 *   - readBuildInfo(packageRoot): load dist/.build-info.json (or null)
 *   - detectStaleDist(packageRoot): compare build-info.commit against
 *     git rev-parse HEAD in the same repo, returning null (not stale,
 *     can't determine, or no git) or StaleDistInfo (stale detected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readBuildInfo,
  detectStaleDist,
  detectUnknownFreshness,
  detectCheckoutCurrency,
  defaultGitRunner,
} from '../../src/cli/build-info.js';
import type { GitRunner } from '../../src/cli/build-info.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'initial');
}

function writeBuildInfo(packageRoot: string, commit: string, builtAt = '2026-04-20T20:00:00Z'): void {
  const distDir = join(packageRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, '.build-info.json'), JSON.stringify({ commit, built_at: builtAt }));
}

describe('readBuildInfo', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-buildinfo-read-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when dist/.build-info.json is missing', () => {
    expect(readBuildInfo(tmp)).toBeNull();
  });

  it('returns parsed info when the file exists', () => {
    writeBuildInfo(tmp, 'abc1234def5678', '2026-04-20T12:00:00Z');
    const info = readBuildInfo(tmp);
    expect(info).toEqual({ commit: 'abc1234def5678', built_at: '2026-04-20T12:00:00Z' });
  });

  it('returns null on malformed JSON (does not throw)', () => {
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', '.build-info.json'), '{ not valid');
    expect(readBuildInfo(tmp)).toBeNull();
  });
});

describe('detectStaleDist', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-staledist-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .git/ is missing (npm-tarball install)', () => {
    // No git init — just a directory with a build-info.
    writeBuildInfo(tmp, 'abc1234');
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when build-info is missing (never built)', () => {
    initRepo(tmp);
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when build-info.commit is "unknown" (fail-soft case)', () => {
    initRepo(tmp);
    writeBuildInfo(tmp, 'unknown');
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when commits match (fresh dist)', () => {
    initRepo(tmp);
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, head);
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns StaleDistInfo when commits differ', () => {
    initRepo(tmp);
    const oldHead = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, oldHead);
    // Make a new commit so HEAD moves.
    git(tmp, 'commit', '--allow-empty', '-q', '-m', 'newer');
    const newHead = git(tmp, 'rev-parse', 'HEAD');

    const stale = detectStaleDist(tmp);
    expect(stale).not.toBeNull();
    expect(stale?.buildCommit).toBe(oldHead);
    expect(stale?.currentCommit).toBe(newHead);
  });
});

describe('detectUnknownFreshness', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-unknown-freshness-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .git/ is missing (tarball install — nothing to warn about)', () => {
    writeBuildInfo(tmp, 'abc123');
    expect(detectUnknownFreshness(tmp)).toBeNull();
  });

  it('returns missing_build_info when .git/ exists but no build-info (operator ran `npx tsc` directly)', () => {
    initRepo(tmp);
    const r = detectUnknownFreshness(tmp);
    expect(r).toEqual({ reason: 'missing_build_info' });
  });

  it('returns unknown_build_commit when build-info.commit is "unknown" (build script ran without git)', () => {
    initRepo(tmp);
    writeBuildInfo(tmp, 'unknown');
    const r = detectUnknownFreshness(tmp);
    expect(r).toEqual({ reason: 'unknown_build_commit' });
  });

  it('returns null when build-info is genuine (stale-detect is the right check, not this)', () => {
    initRepo(tmp);
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, head);
    expect(detectUnknownFreshness(tmp)).toBeNull();
  });
});

/**
 * Tests for `detectCheckoutCurrency` (groundnuty/macf#1376 — a repo checkout
 * of THIS CLI's own source has no way to learn it is behind the canonical
 * branch it tracks). Distinct axis from `detectStaleDist` above: that
 * compares the BUILT dist/ stamp against packageRoot's own HEAD; this
 * compares packageRoot's HEAD against its configured upstream.
 */
describe('detectCheckoutCurrency (groundnuty/macf#1376)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-checkout-currency-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function initBareRemote(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main');
  }

  /** `initRepo` (defined above) + wire it to `remoteDir` as its upstream. */
  function initRepoWithUpstream(dir: string, remoteDir: string): void {
    mkdirSync(dir, { recursive: true });
    initRepo(dir);
    git(dir, 'remote', 'add', 'origin', remoteDir);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
  }

  it('not-a-checkout: a plain (non-git) directory does not fire — this is what keeps the check off for npm-installed consumers', () => {
    // `tmp` is untouched by git entirely — the npm-install shape.
    const result = detectCheckoutCurrency(tmp);
    expect(result.kind).toBe('not-a-checkout');
  });

  it('honest-unknown: a git checkout with no configured upstream is never reported current', () => {
    initRepo(tmp);
    const result = detectCheckoutCurrency(tmp);
    expect(result.kind).toBe('no-upstream');
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---
  // (1) alone — "behind reports the count" — is satisfied by an
  // implementation that always prints SOME number. (2) is what proves the
  // count is real: a level checkout must read "current," not noise.

  it('DECISIVE PAIR (1/2): a checkout BEHIND its upstream reports the exact count, not a stand-in value', () => {
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    const work2 = join(tmp, 'work2');
    initBareRemote(remote);
    initRepoWithUpstream(work, remote);

    // A second clone pushes TWO new commits — an implementation that always
    // prints a fixed/hardcoded number would not track this.
    git(tmp, 'clone', '-q', remote, work2);
    git(work2, 'config', 'user.email', 'test@example.invalid');
    git(work2, 'config', 'user.name', 'Test');
    git(work2, 'config', 'commit.gpgsign', 'false');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'third');
    git(work2, 'push', '-q', 'origin', 'HEAD:main');

    // Refresh work's LOCAL tracking ref only (what an operator's separate
    // `git fetch` would do) — `detectCheckoutCurrency` itself never does
    // this; see the mutation check below.
    git(work, 'fetch', '-q', 'origin');

    const result = detectCheckoutCurrency(work);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.commitCount).toBe(2);
      expect(result.upstream).toBe('origin/main');
    }
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with its upstream reports current (0), no noise', () => {
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    initBareRemote(remote);
    initRepoWithUpstream(work, remote);

    const result = detectCheckoutCurrency(work);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.commitCount).toBe(0);
      expect(result.upstream).toBe('origin/main');
    }
  });

  it('unreadable: a non-numeric rev-list result is honest-unknown, never current (injected GitRunner — verified no real git failure reaches this branch: a dangling upstream config makes @{u} itself fail with "no such branch", which is the no-upstream branch above, not this one)', () => {
    const fakeRunner: GitRunner = (args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
      if (args[0] === 'rev-parse' && args.includes('@{u}')) return 'origin/main';
      if (args[0] === 'rev-list') return 'not-a-number';
      return null;
    };
    const result = detectCheckoutCurrency('/irrelevant-for-this-test', fakeRunner);
    expect(result.kind).toBe('unreadable');
  });

  it('mutation check: never fetches — no git call this function makes includes "fetch" or "pull"', () => {
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    initBareRemote(remote);
    initRepoWithUpstream(work, remote);

    const invocations: (readonly string[])[] = [];
    const recordingRunner: GitRunner = (args, cwd) => {
      invocations.push(args);
      return defaultGitRunner(args, cwd);
    };

    const result = detectCheckoutCurrency(work, recordingRunner);
    expect(result.kind).toBe('ok'); // sanity: the recording wrapper didn't break anything

    expect(invocations.length).toBeGreaterThan(0);
    for (const args of invocations) {
      expect(args).not.toContain('fetch');
      expect(args).not.toContain('pull');
    }
  });

  it('fires in a REAL repo checkout — packages/macf itself, whose .git lives at the monorepo root, not inside packages/macf (the exact shape #144 never reached, and not only a fixture)', () => {
    // findCliPackageRoot() resolves to packages/macf/ for a dev/npm-link
    // install of THIS repo. .git/ is one level up (the monorepo root), not
    // inside packages/macf/ — a direct existsSync(join(dir, '.git'))-style
    // gate (what detectStaleDist uses) can never see this as a checkout.
    // This is not a fixture: it is this repo's own package root, right now.
    const realPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(existsSync(join(realPackageRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(realPackageRoot, '.git'))).toBe(false); // the exact gap this check closes

    const result = detectCheckoutCurrency(realPackageRoot);
    // `kind` must NOT be 'not-a-checkout' — that IS the ancestor-detection
    // proof: this environment's current branch may or may not itself carry
    // a configured upstream (a throwaway agent worktree branch commonly
    // doesn't — verified: this very worktree's branch has none), so 'ok'
    // vs 'no-upstream' is environment-dependent and asserting one of them
    // specifically would be asserting this session's branch config, not the
    // defect under test. What's NOT environment-dependent, and what a
    // synthetic fixture could never demonstrate, is that the real
    // packages/macf directory — .git-less itself — is recognized as living
    // inside a git working tree at all.
    expect(result.kind).not.toBe('not-a-checkout');
    expect(['ok', 'no-upstream']).toContain(result.kind);
    if (result.kind === 'ok') {
      expect(result.commitCount).toBeGreaterThanOrEqual(0);
    }
  });
});
