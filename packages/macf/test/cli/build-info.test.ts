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
 * of the macf framework's own source has no way to learn it is behind the
 * canonical branch it tracks). Distinct axis from `detectStaleDist` above:
 * that compares the BUILT dist/ stamp against packageRoot's own HEAD; this
 * compares `projectDir`'s HEAD against `origin/<canonicalBranch>` — but only
 * when `projectDir` really is a checkout of the same package `packageRoot`
 * identifies (content-based identity, not a path comparison — see the
 * function's doc comment in build-info.ts for why a path/packageRoot-only
 * design was tried and abandoned after live-verifying it would never fire
 * for the actual deployed fleet).
 */
describe('detectCheckoutCurrency (groundnuty/macf#1376)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-checkout-currency-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const OWN_NAME = '@fake-scope/fake-cli';

  /** The "running CLI's own source" identity marker — always has this name. */
  function makePackageRoot(dir: string, name = OWN_NAME): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }

  function initBareRemote(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main');
  }

  /** A git checkout whose root package.json carries the given identity marker (non-monorepo layout). */
  function initIdentityRepo(dir: string, name = OWN_NAME): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    initRepo(dir);
    // package.json isn't committed — detectCheckoutCurrency reads it straight
    // off disk, not from git history, so this is deliberately untracked.
  }

  /** `initIdentityRepo` + wire it to `remoteDir` as `origin` (registered, not necessarily fetched). */
  function initIdentityRepoWithOrigin(dir: string, remoteDir: string, name = OWN_NAME): void {
    initIdentityRepo(dir, name);
    git(dir, 'remote', 'add', 'origin', remoteDir);
  }

  it('not-a-checkout: projectDir has no package.json at all — the plain-npm-install-consumer shape', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    mkdirSync(projectDir, { recursive: true }); // no package.json, no git

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    expect(result.kind).toBe('not-a-checkout');
  });

  it('not-a-checkout: projectDir is a DIFFERENT, unrelated project — even though it IS git-tracked with its own origin (the real npm-installed-consumer shape)', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const consumerRemote = join(tmp, 'consumer-remote.git');
    const projectDir = join(tmp, 'consumer-project');
    makePackageRoot(packageRoot);
    initBareRemote(consumerRemote);
    initIdentityRepoWithOrigin(projectDir, consumerRemote, 'some-consumer-project');

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    expect(result.kind).toBe('not-a-checkout');
  });

  it('not-a-checkout: identity matches but projectDir is not a git checkout at all', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: OWN_NAME })); // matches, but no git init

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    expect(result.kind).toBe('not-a-checkout');
  });

  it('identity match via the REAL monorepo layout: packages/macf/ carries the marker, the workspace root does not', () => {
    // Mirrors the actual shape of THIS repo exactly: the workspace root's
    // own package.json is the monorepo-tooling package (a DIFFERENT name),
    // and the identity marker lives one level down at packages/macf/.
    const packageRoot = join(tmp, 'pkgroot');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'some-monorepo-tooling-package' }));
    mkdirSync(join(projectDir, 'packages', 'macf'), { recursive: true });
    writeFileSync(join(projectDir, 'packages', 'macf', 'package.json'), JSON.stringify({ name: OWN_NAME }));
    initRepo(projectDir);

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    // No origin configured yet — proves identity matched (else this would
    // be 'not-a-checkout' too) and progressed to the next honest-unknown gate.
    expect(result.kind).toBe('no-upstream');
  });

  it('honest-unknown: an identity-matching git checkout with no origin remote is never reported current', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    initIdentityRepo(projectDir);

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    expect(result.kind).toBe('no-upstream');
  });

  it('unreadable: an origin remote is configured but was never fetched, so origin/<canonicalBranch> does not resolve locally — genuinely reachable via real git, not an injected scenario', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    initBareRemote(remote); // has the 'main' branch, but never fetched into projectDir
    initIdentityRepoWithOrigin(projectDir, remote);

    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main');
    expect(result.kind).toBe('unreadable');
  });

  it('unreadable: origin exists and IS fetched, but the canonical branch name is misconfigured (points at a ref that was never fetched)', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    initBareRemote(remote);
    initIdentityRepoWithOrigin(projectDir, remote);
    git(projectDir, 'push', '-q', '-u', 'origin', 'main');

    // Ask about a DIFFERENT canonical branch than the one that was ever pushed/fetched.
    const result = detectCheckoutCurrency(projectDir, packageRoot, 'develop');
    expect(result.kind).toBe('unreadable');
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---
  // (1) alone — "behind reports the count" — is satisfied by an
  // implementation that always prints SOME number. (2) is what proves the
  // count is real: a level checkout must read "current," not noise.

  it('DECISIVE PAIR (1/2): a checkout BEHIND its canonical branch reports the exact count, not a stand-in value', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    const work2 = join(tmp, 'work2');
    makePackageRoot(packageRoot);
    initBareRemote(remote);
    initIdentityRepoWithOrigin(work, remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

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

    const result = detectCheckoutCurrency(work, packageRoot, 'main');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.commitCount).toBe(2);
      expect(result.upstream).toBe('origin/main');
    }
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with its canonical branch reports current (0), no noise', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    makePackageRoot(packageRoot);
    initBareRemote(remote);
    initIdentityRepoWithOrigin(work, remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

    const result = detectCheckoutCurrency(work, packageRoot, 'main');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.commitCount).toBe(0);
      expect(result.upstream).toBe('origin/main');
    }
  });

  it('unreadable (defensive): a non-numeric rev-list result is honest-unknown, never current (injected GitRunner — protects against an unexpected future git output shape; the identity check reads real files, so real package.jsons are still needed to reach the gitRunner-driven branches at all)', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const projectDir = join(tmp, 'project');
    makePackageRoot(packageRoot);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: OWN_NAME }));

    const fakeRunner: GitRunner = (args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
      if (args[0] === 'remote') return 'https://example.invalid/repo.git';
      if (args[0] === 'rev-list') return 'not-a-number';
      return null;
    };
    const result = detectCheckoutCurrency(projectDir, packageRoot, 'main', fakeRunner);
    expect(result.kind).toBe('unreadable');
  });

  it('mutation check: never fetches — no git call this function makes includes "fetch" or "pull"', () => {
    const packageRoot = join(tmp, 'pkgroot');
    const remote = join(tmp, 'remote.git');
    const work = join(tmp, 'work');
    makePackageRoot(packageRoot);
    initBareRemote(remote);
    initIdentityRepoWithOrigin(work, remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

    const invocations: (readonly string[])[] = [];
    const recordingRunner: GitRunner = (args, cwd) => {
      invocations.push(args);
      return defaultGitRunner(args, cwd);
    };

    const result = detectCheckoutCurrency(work, packageRoot, 'main', recordingRunner);
    expect(result.kind).toBe('ok'); // sanity: the recording wrapper didn't break anything

    expect(invocations.length).toBeGreaterThan(0);
    for (const args of invocations) {
      expect(args).not.toContain('fetch');
      expect(args).not.toContain('pull');
    }
  });

  it('fires in a REAL repo checkout — the actual monorepo root + packages/macf, not a fixture (packages/macf has no .git of its own; .git lives at the monorepo root, one level up)', () => {
    // findCliPackageRoot() resolves to packages/macf/ for a dev/npm-link
    // install of THIS repo — no .git/ inside it at all (the exact shape a
    // direct existsSync(join(dir, '.git')) gate, like detectStaleDist's,
    // can never see as a checkout). The identity-matching design in THIS
    // function sidesteps that path question entirely: it walks up from
    // `projectDir` via real git plumbing, so it doesn't matter that
    // packages/macf itself is .git-less.
    const realPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const realProjectDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    expect(existsSync(join(realPackageRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(realPackageRoot, '.git'))).toBe(false); // the exact gap this check closes
    expect(existsSync(join(realProjectDir, '.git'))).toBe(true); // .git lives here instead

    const result = detectCheckoutCurrency(realProjectDir, realPackageRoot, 'main');
    // This is live, real state (this very checkout, right now) — not
    // asserting a fixed count, but `kind` MUST be 'ok': proof the identity
    // match + ancestor-aware git plumbing recognized the real monorepo
    // layout as a checkout of its own framework, which a synthetic fixture
    // could never demonstrate on its own.
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.commitCount).toBeGreaterThanOrEqual(0);
      expect(result.upstream).toBe('origin/main');
    }
  });
});
