/**
 * Tests for `macf doctor`'s composition of the distributed-script/rule-
 * currency WARN with the Framework-checkout-currency check (groundnuty/macf#1383).
 *
 * The bug this fixes: `checkDistributedScriptCurrency` / `checkDistributedRuleCurrency`
 * (#1362/#1360) compare on-disk files against the RUNNING CLI's own bundled
 * canonical, and their WARN's remedy was an unconditional "run `macf
 * update`". Measured live: refreshing all 16 rules from `origin/main` took
 * a workspace from "8 stale, 2 missing" to "16 stale, 0 missing", because
 * the installed CLI's bundled canonical was itself 102 commits behind
 * `origin/main` — the workspace got strictly MORE correct and the check got
 * strictly LOUDER, and its remedy (`macf update`) would have REVERTED the
 * improvement. `#1372` correctly targets the installed CLI as the reference
 * point for a consumer; the defect is that the verdict never says whether
 * that reference point is itself current, and never corrects the remedy
 * when it isn't.
 *
 * `checkCheckoutCurrency` (#1376, shipped in #1378) is the only signal in
 * this report able to date "the installed CLI's canonical" — but only when
 * `projectDir` genuinely IS a checkout of the framework's own source (the
 * `runDoctor` call sites default `packageRoot` to the REAL running CLI, so
 * these fixtures use the real identity marker exactly like
 * `doctor-checkout-currency.test.ts`'s own rendered describe block).
 *
 * Two decisive pairs (assert-the-wrong-path.md), on two independent axes:
 *
 * 1. Checkout lag, findings held fixed (one stale rule): a checkout BEHIND
 *    canonical must compose the corrected remedy; a checkout LEVEL with
 *    canonical must render byte-for-byte the pre-#1383 plain remedy (no
 *    added noise).
 * 2. Finding shape, checkout lag held fixed (behind): a STALE finding must
 *    compose the corrected remedy; an all-MISSING finding set must render
 *    the plain remedy even though the checkout is behind — a missing file
 *    has nothing on disk for a stale CLI to overwrite, so cautioning the
 *    reader off `macf update` for it would repeat the exact #1361-shaped
 *    contradiction ("this evidence says X, so don't do the one thing that
 *    helps") this file's own fix was built to avoid.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.js';
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

// Same reasoning as doctor-checkout-currency.test.ts: `runDoctor`'s default
// `packageRoot` is the REAL running CLI, so the identity marker fixtures
// below need to match reality, read dynamically rather than hardcoded.
const REAL_CLI_PACKAGE_NAME = (
  JSON.parse(readFileSync(join(findCliPackageRoot(), 'package.json'), 'utf-8')) as { name: string }
).name;

/**
 * Mirrors doctor-checkout-currency.test.ts's `initFrameworkFixture` exactly
 * — a real git checkout whose `packages/macf/package.json` carries THIS
 * repo's own package identity, with a bare remote wired as `origin`.
 */
function initFrameworkFixture(root: string): { readonly remote: string } {
  const remote = join(root, 'remote.git');
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '--initial-branch=main');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-monorepo' }));
  mkdirSync(join(root, 'packages', 'macf'), { recursive: true });
  writeFileSync(join(root, 'packages', 'macf', 'package.json'), JSON.stringify({ name: REAL_CLI_PACKAGE_NAME }));
  initRepo(root);
  git(root, 'remote', 'add', 'origin', remote);
  return { remote };
}

/** Writes a `.claude/rules/coordination.md` that can never match the real canonical bytes — forces WARN. */
function writeStaleRuleFile(root: string): void {
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'rules', 'coordination.md'),
    '# a rule file that will never match the real canonical bytes (groundnuty/macf#1383 fixture)\n',
  );
}

describe('runDoctor — rule-currency WARN composed with checkout currency (groundnuty/macf#1383)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-currency-composition-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function ruleCurrencyWarnLines(out: string): string[] {
    const startIdx = out.indexOf('Distributed rule currency');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const endIdx = out.indexOf('Framework checkout currency', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return out.slice(startIdx, endIdx).split('\n');
  }

  // --- Decisive pair ---

  it('DECISIVE PAIR (1/2): a checkout BEHIND canonical composes the reference point, its own lag, and the CLI-first remedy', async () => {
    const { remote } = initFrameworkFixture(tmpRoot);
    git(tmpRoot, 'push', '-q', '-u', 'origin', 'main');

    // Diverge origin/main ahead of tmpRoot by one commit — the exact shape
    // doctor-checkout-currency.test.ts's own rendered WARN test uses.
    const work2 = join(tmpRoot, '..', 'work2-' + Math.random().toString(36).slice(2));
    git(join(tmpRoot, '..'), 'clone', '-q', remote, work2);
    git(work2, 'config', 'user.email', 'test@example.invalid');
    git(work2, 'config', 'user.name', 'Test');
    git(work2, 'config', 'commit.gpgsign', 'false');
    git(work2, 'commit', '-q', '--allow-empty', '-m', 'ahead');
    git(work2, 'push', '-q', 'origin', 'HEAD:main');
    git(tmpRoot, 'fetch', '-q', 'origin');
    rmSync(work2, { recursive: true, force: true });

    writeStaleRuleFile(tmpRoot);
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // WARN-only — never affects the exit code

    const out = logSpy.mock.calls.flat().join('\n');
    const section = ruleCurrencyWarnLines(out).join('\n');

    // 1. The reference point — already-existing text, unchanged by this fix.
    expect(section).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
    // 2. Its currency — composed from checkCheckoutCurrency's own detail.
    expect(section).toMatch(/1 commit\(s\) behind/);
    expect(section).toContain('origin/main');
    // 3. The corrected remedy — CLI-first, never plain `macf update` alone.
    // No internal issue citation (macf#1061 "explain, don't cite" — this is
    // user-facing CLI output, not a code comment): the explanation stands
    // on its own instead of pointing at groundnuty/macf#1383.
    expect(section).toMatch(/THE INSTALLED CLI is probably STALE/);
    expect(section).toMatch(/update the CLI FIRST/);
    expect(section).not.toMatch(/\bmacf#\d+\b/);
    // The unconditional pre-#1383 remedy must NOT appear verbatim in this branch.
    expect(section).not.toContain(
      'Fix: run `macf update` (or `macf rules refresh --dir .`) to bring .claude/rules/ current.',
    );
  });

  // --- Second decisive pair: stale vs missing at fixed checkout lag ---
  //
  // The pair above holds findings fixed (one stale rule) and varies checkout
  // lag. This one holds checkout lag fixed (behind, same as pair 1/1) and
  // varies the finding shape: stale vs all-missing. A MISSING file (#1362
  // root cause 2 — a hook that never fires at all) has nothing on disk for
  // a stale CLI to overwrite, so `macf update` from a behind CLI still
  // strictly helps it. Cautioning the reader off the remedy that would fix
  // 15 missing files, on the strength of one stale finding, is the exact
  // #1361-shaped contradiction this test pins against.

  it('all-MISSING findings render the plain remedy even though the checkout is behind — nothing on disk to revert', async () => {
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

    // Deliberately NO writeStaleRuleFile call and no `.claude/rules/` at
    // all — every canonical rule name reports `missing`, zero `stale`.
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    const section = ruleCurrencyWarnLines(out).join('\n');

    expect(section).toMatch(/0 stale, \d+ missing of/);
    // The plain remedy fires — no revert-risk caution for missing-only findings.
    expect(section).toContain(
      'Fix: run `macf update` (or `macf rules refresh --dir .`) to bring .claude/rules/ current.',
    );
    expect(section).not.toMatch(/THE INSTALLED CLI is probably STALE/);
    expect(section).not.toMatch(/update the CLI FIRST/);
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with canonical renders the unchanged plain remedy — no added noise', async () => {
    initFrameworkFixture(tmpRoot);
    git(tmpRoot, 'push', '-q', '-u', 'origin', 'main');

    writeStaleRuleFile(tmpRoot);
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    const section = ruleCurrencyWarnLines(out).join('\n');

    expect(section).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
    // Unchanged plain remedy, byte-for-byte identical to the pre-#1383 line.
    expect(section).toContain(
      'Fix: run `macf update` (or `macf rules refresh --dir .`) to bring .claude/rules/ current.',
    );
    // No caveat noise added to the healthy case.
    expect(section).not.toMatch(/THE INSTALLED CLI is probably STALE/);
    expect(section).not.toMatch(/update the CLI FIRST/);
    expect(section).not.toContain('groundnuty/macf#1383');
    expect(section).not.toMatch(/commit\(s\) behind/);
  });

  // --- Honest-unknown ---

  it('checkout currency UNKNOWN (no origin remote): the reference point is stated as undatable, never implied fresh', async () => {
    // Identity-matching checkout, but deliberately NO `git remote add origin`
    // — the exact fixture shape doctor-checkout-currency.test.ts's own
    // "UNKNOWN: ... no origin remote" test uses, applied through the real
    // runDoctor entrypoint instead of the helper directly.
    mkdirSync(join(tmpRoot, 'packages', 'macf'), { recursive: true });
    writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({ name: 'fixture-monorepo' }));
    writeFileSync(join(tmpRoot, 'packages', 'macf', 'package.json'), JSON.stringify({ name: REAL_CLI_PACKAGE_NAME }));
    initRepo(tmpRoot);

    writeStaleRuleFile(tmpRoot);
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    const section = ruleCurrencyWarnLines(out).join('\n');

    expect(section).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
    // Honest-unknown: explicitly says it CANNOT be dated — never asserts freshness.
    expect(section).toMatch(/can.t be dated/);
    expect(section).toMatch(/don.t assume it.s fresh/);
    // The CLI-first remedy (which asserts staleness) must NOT fire — staleness
    // was never established, only undeterminable.
    expect(section).not.toMatch(/THE INSTALLED CLI is probably STALE/);
    expect(section).not.toMatch(/update the CLI FIRST/);
    // Falls back to the plain remedy as the best available action.
    expect(section).toContain(
      'Fix: run `macf update` (or `macf rules refresh --dir .`) to bring .claude/rules/ current.',
    );
  });
});
