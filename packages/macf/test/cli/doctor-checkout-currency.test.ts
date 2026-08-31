/**
 * Tests for `macf doctor`'s CLI-checkout-currency check (groundnuty/macf#1376
 * — a repo checkout of the macf framework's own source has no way to learn
 * it is behind the canonical branch it tracks; `doctor.ts` documented the
 * gap in prose comments — "nineteen days behind canonical with nothing able
 * to say so" / "a workspace can PASS while running behind a pinned-...HEAD"
 * — without a check backing them).
 *
 * Two existing currency layers, neither of which cover this:
 *   - `checkDistributedScriptCurrency` / `checkDistributedRuleCurrency`
 *     (#1362/#1360) resolve "canonical" via `findCliPackageRoot()`, which —
 *     in a repo-checkout/npm-link dev install — CAN be the same tree being
 *     doctored, so those checks compare that tree to itself and always PASS
 *     regardless of whether the tree is itself behind `origin/<branch>`.
 *   - `detectStaleDist` (#144) only compares the BUILT `dist/` stamp against
 *     that same tree's own HEAD (a rebuild-freshness question), never
 *     against its upstream.
 *
 * `checkCheckoutCurrency(projectDir, config, packageRoot)` targets
 * `projectDir` (the workspace being doctored) — NOT `packageRoot` alone,
 * which was tried first and abandoned after live-verifying that the real
 * deployed fleet installs the CLI via a plain global npm install with zero
 * directory relationship to the workspace it operates on (see
 * `detectCheckoutCurrency`'s doc comment in build-info.ts for the full
 * rationale). Because `projectDir` is fully controllable here, every
 * rendered test below constructs an INDEPENDENT fixture and asserts a
 * hardcoded expectation — never re-deriving "expected" from the function
 * under test (assert-the-wrong-path.md Trigger 1: a self-derived reference
 * value can't discriminate a broken implementation from a correct one).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkCheckoutCurrency, runDoctor } from '../../src/cli/commands/doctor.js';
import { findCliPackageRoot } from '../../src/cli/rules.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import { installSandboxFdAllowRead } from '../../src/cli/settings-writer.js';

function localConfig(): MacfAgentConfig {
  return {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'local', path: '/tmp/macf-test-registry.json' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'initial');
}

// The identity marker `checkCheckoutCurrency`'s default `packageRoot`
// (`findCliPackageRoot()`, un-overridden in these tests) actually carries —
// read dynamically from THIS repo's own package.json rather than hardcoded,
// so fixtures below match reality even if the package is ever renamed.
const REAL_CLI_PACKAGE_NAME = (
  JSON.parse(readFileSync(join(findCliPackageRoot(), 'package.json'), 'utf-8')) as { name: string }
).name;

describe('checkCheckoutCurrency (groundnuty/macf#1376)', () => {
  let tmpRoot: string;
  let packageRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-checkout-currency-'));
    packageRoot = join(tmpRoot, 'pkgroot');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fake-scope/fake-cli' }));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** A git checkout whose root package.json matches `packageRoot`'s identity. */
  function initIdentityRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fake-scope/fake-cli' }));
    initRepo(dir);
  }

  it('INFO: an unrelated project (own package.json, own git history) does not fire — the real npm-installed-consumer shape', () => {
    const projectDir = join(tmpRoot, 'consumer-project');
    mkdirSync(projectDir, { recursive: true });
    initRepo(projectDir); // no package.json matching packageRoot's identity — git-tracked, but unrelated
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'some-consumer-project' }));

    const result = checkCheckoutCurrency(projectDir, null, packageRoot);
    expect(result.status).toBe('INFO');
    expect(result.detail).toMatch(/not a checkout of the macf framework/i);
    expect(result.detail).not.toMatch(/current|behind/i);
  });

  it('UNKNOWN: an identity-matching checkout with no origin remote is never reported current', () => {
    const projectDir = join(tmpRoot, 'project');
    initIdentityRepo(projectDir);

    const result = checkCheckoutCurrency(projectDir, null, packageRoot);
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    expect(result.detail).toMatch(/no .origin. remote/i);
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---

  it('DECISIVE PAIR (1/2): a checkout BEHIND its canonical branch reports WARN naming the exact count', () => {
    const remote = join(tmpRoot, 'remote.git');
    const work = join(tmpRoot, 'work');
    const work2 = join(tmpRoot, 'work2');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    initIdentityRepo(work);
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

    git(tmpRoot, 'clone', '-q', remote, work2);
    git(work2, 'config', 'user.email', 'test@example.invalid');
    git(work2, 'config', 'user.name', 'Test');
    git(work2, 'config', 'commit.gpgsign', 'false');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'third');
    git(work2, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin'); // operator-style local refresh, not the check itself

    const result = checkCheckoutCurrency(work, null, packageRoot);
    expect(result.status).toBe('WARN');
    // The exact count is the signal — not "some number" (see the mutation
    // test in build-info.test.ts, which pins detectCheckoutCurrency's
    // commitCount to this same discrimination).
    expect(result.detail).toMatch(/2 commit\(s\) behind/);
    expect(result.detail).toContain('origin/main');
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with its canonical branch reports PASS/current, no noise', () => {
    const remote = join(tmpRoot, 'remote.git');
    const work = join(tmpRoot, 'work');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    initIdentityRepo(work);
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

    const result = checkCheckoutCurrency(work, null, packageRoot);
    expect(result.status).toBe('PASS');
    expect(result.detail).toMatch(/current/i);
    expect(result.detail).toMatch(/0 commits behind/);
    // "No noise": the PASS path must not carry WARN-only phrasing.
    expect(result.detail).not.toMatch(/\bcommit\(s\) behind\b/);
  });

  it('canonicalBranch resolution: a workspace with canonicalBranch: "develop" is compared against origin/develop, not origin/main', () => {
    const remote = join(tmpRoot, 'remote.git');
    const work = join(tmpRoot, 'work');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    initIdentityRepo(work);
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'checkout', '-q', '-b', 'develop');
    git(work, 'push', '-q', '-u', 'origin', 'develop');

    const config: MacfAgentConfig = { ...localConfig(), canonicalBranch: 'develop' };
    const result = checkCheckoutCurrency(work, config, packageRoot);
    expect(result.status).toBe('PASS');
    expect(result.detail).toContain('origin/develop');
  });
});

describe('runDoctor — CLI checkout currency section (rendered output, groundnuty/macf#1376)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-checkout-currency-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * `runDoctor` calls `checkCheckoutCurrency(projectDir, config)` with the
   * DEFAULT `packageRoot` (this real running CLI's own source) — so
   * `projectDir` (== `tmpRoot`, fully fixture-controlled) must itself carry
   * the REAL identity marker (`packages/macf/package.json` with THIS repo's
   * own package name) plus a real git history to produce a deterministic,
   * independently-known outcome. This is what makes the rendered decisive
   * pair fixture-constructible (not circular): the expectation below is
   * hardcoded from the fixture's construction, never re-derived by calling
   * `checkCheckoutCurrency` again.
   */
  function initFrameworkFixture(root: string): { readonly remote: string } {
    const remote = join(root, 'remote.git');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    // Mirror the real monorepo shape: root package.json is the tooling
    // package (a DIFFERENT name), the identity marker lives at
    // packages/macf/package.json.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-monorepo' }));
    mkdirSync(join(root, 'packages', 'macf'), { recursive: true });
    writeFileSync(join(root, 'packages', 'macf', 'package.json'), JSON.stringify({ name: REAL_CLI_PACKAGE_NAME }));
    initRepo(root);
    git(root, 'remote', 'add', 'origin', remote);
    return { remote };
  }

  it('renders PASS/current for a workspace level with its canonical branch — fixture-constructed, not circular', async () => {
    initFrameworkFixture(tmpRoot);
    git(tmpRoot, 'push', '-q', '-u', 'origin', 'main');
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CLI checkout currency');
    // Scope to THIS section's own line — the Disk space section further
    // down legitimately reports [PASS] for an unrelated reason, so a
    // whole-output [PASS] match would pass even if this check reported
    // WARN (a positive match is uninformative without scoping).
    const sectionLine = out.split('\n').find((line) => line.includes('current with'));
    expect(sectionLine).toBeDefined();
    expect(sectionLine).toMatch(/\[PASS\]/);
    expect(sectionLine).not.toMatch(/commit\(s\) behind/);
  });

  it('renders WARN naming the exact count for a workspace behind its canonical branch — fixture-constructed, not circular', async () => {
    const { remote } = initFrameworkFixture(tmpRoot);
    git(tmpRoot, 'push', '-q', '-u', 'origin', 'main');

    const work2 = join(tmpRoot, '..', 'work2-' + Math.random().toString(36).slice(2));
    git(join(tmpRoot, '..'), 'clone', '-q', remote, work2);
    git(work2, 'config', 'user.email', 'test@example.invalid');
    git(work2, 'config', 'user.name', 'Test');
    git(work2, 'config', 'commit.gpgsign', 'false');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'ahead');
    git(work2, 'push', '-q', 'origin', 'HEAD:main');
    git(tmpRoot, 'fetch', '-q', 'origin');
    rmSync(work2, { recursive: true, force: true });

    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // WARN-only — never affects the exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CLI checkout currency');
    // Scope to THIS section's own line — other sections can legitimately
    // emit [WARN] for unrelated reasons on a minimal fixture workspace, so
    // a whole-output [WARN] match would pass even if THIS check's own line
    // was mistagged.
    const sectionLine = out.split('\n').find((line) => line.includes('commit(s) behind'));
    expect(sectionLine).toBeDefined();
    expect(sectionLine).toMatch(/1 commit\(s\) behind/);
    expect(sectionLine).toMatch(/\[WARN\]/);
  });

  /**
   * groundnuty/macf#1362 root cause 2's shape, reached through the ACTUAL
   * `macf doctor` entrypoint: no macf-agent.json at all still renders this
   * section (early-return branch) — matching the script/rule currency
   * sections' own no-early-return-skip fix. `tmpRoot` here is a bare
   * mkdtemp dir with no package.json at all, which deterministically (not
   * circularly) can never match the identity check → INFO, every time.
   */
  it('renders INFO (not the framework\'s own source) even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    // Deliberately NO writeAgentConfig call, and tmpRoot has no package.json
    // at all — the plain-npm-consumer shape, guaranteed to read INFO.
    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to this check

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CLI checkout currency');
    // Scope the assertion to the CLI-checkout-currency section's own line —
    // the Disk space section further down legitimately reports [PASS] for
    // an unrelated reason, so a whole-output PASS/WARN exclusion would be a
    // false failure, not a real signal about THIS check.
    const sectionLine = out.split('\n').find((line) => line.includes("not a checkout of the macf framework"));
    expect(sectionLine).toBeDefined();
    expect(sectionLine).toMatch(/\[INFO\]/);
  });
});
