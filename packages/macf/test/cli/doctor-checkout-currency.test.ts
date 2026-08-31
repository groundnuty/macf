/**
 * Tests for `macf doctor`'s CLI-checkout-currency check (groundnuty/macf#1376
 * — a repo checkout of THIS CLI's own source has no way to learn it is
 * behind the canonical branch it tracks; `doctor.ts` documented the gap in
 * three prose comments — "nineteen days behind canonical with nothing able
 * to say so" / "a workspace can PASS while running behind a pinned-...HEAD"
 * — without a check backing them).
 *
 * Two existing currency layers, neither of which cover this:
 *   - `checkDistributedScriptCurrency` / `checkDistributedRuleCurrency`
 *     (#1362/#1360) resolve "canonical" via `findCliPackageRoot()`, which —
 *     in a repo-checkout/npm-link dev install — IS the same tree being
 *     doctored, so those checks compare that tree to itself and always PASS
 *     regardless of whether the tree is itself behind `origin/<branch>`.
 *   - `detectStaleDist` (#144) only compares the BUILT `dist/` stamp against
 *     that same tree's own HEAD (a rebuild-freshness question), never
 *     against its upstream.
 *
 * `checkCheckoutCurrency` is exercised directly (with a real, disposable git
 * fixture — `detectCheckoutCurrency`'s own primitive-level tests in
 * `build-info.test.ts` cover the git-mechanics edge cases; this file covers
 * the doctor-report state mapping + rendering) for the decisive pair + the
 * INFO/UNKNOWN cases. The final describe block drives the check through the
 * full `runDoctor` report and reads the RENDERED console output — matching
 * `doctor-script-currency.test.ts` / `doctor-rule-currency.test.ts`'s own
 * established shape, not a new reporting idiom.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkCheckoutCurrency, runDoctor } from '../../src/cli/commands/doctor.js';
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

describe('checkCheckoutCurrency (groundnuty/macf#1376)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-checkout-currency-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('INFO: a plain (non-git) directory — the npm-installed-consumer shape — does not fire', () => {
    // tmpRoot has no .git at all: exactly what findCliPackageRoot() resolves
    // to for a real npm install (global, local, or via npx).
    const result = checkCheckoutCurrency(tmpRoot);
    expect(result.status).toBe('INFO');
    expect(result.detail).toMatch(/not running from a git checkout|npm install/i);
    expect(result.detail).not.toMatch(/current|behind/i);
  });

  it('UNKNOWN: a git checkout with no configured upstream is never reported current', () => {
    initRepo(tmpRoot);
    const result = checkCheckoutCurrency(tmpRoot);
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    expect(result.detail).toMatch(/no configured upstream|detached HEAD/i);
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---

  it('DECISIVE PAIR (1/2): a checkout BEHIND its upstream reports WARN naming the exact count', () => {
    const remote = join(tmpRoot, 'remote.git');
    const work = join(tmpRoot, 'work');
    const work2 = join(tmpRoot, 'work2');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    mkdirSync(work, { recursive: true });
    initRepo(work);
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

    const result = checkCheckoutCurrency(work);
    expect(result.status).toBe('WARN');
    // The exact count is the signal — not "some number" (see the mutation
    // test in build-info.test.ts, which pins detectCheckoutCurrency's
    // commitCount to this same discrimination).
    expect(result.detail).toMatch(/2 commit\(s\) behind/);
    expect(result.detail).toContain('origin/main');
  });

  it('DECISIVE PAIR (2/2): a checkout LEVEL with its upstream reports PASS/current, no noise', () => {
    const remote = join(tmpRoot, 'remote.git');
    const work = join(tmpRoot, 'work');
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    mkdirSync(work, { recursive: true });
    initRepo(work);
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '-q', '-u', 'origin', 'main');

    const result = checkCheckoutCurrency(work);
    expect(result.status).toBe('PASS');
    expect(result.detail).toMatch(/current/i);
    expect(result.detail).toMatch(/0 commits behind/);
    // "No noise": the PASS path must not carry WARN-only phrasing.
    expect(result.detail).not.toMatch(/\bcommit\(s\) behind\b/);
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
   * `runDoctor` calls `checkCheckoutCurrency()` bare (no override) — it is
   * entirely about the running CLI's OWN checkout (`findCliPackageRoot()`),
   * never about `projectDir`, so there is no fixture knob to turn here (same
   * reasoning as why the check takes no `workspaceDir` parameter at all).
   * This test asserts the WIRING: whatever `checkCheckoutCurrency()`
   * actually returns for this real process reaches the console, tagged with
   * the matching status bracket — proving the section is reachable and
   * correctly rendered, not asserting a specific real-world commit count
   * (which is this session's git state, not the defect under test).
   */
  it('renders the CLI checkout currency section matching what checkCheckoutCurrency() itself reports', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const expected = checkCheckoutCurrency();

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // this check is WARN/UNKNOWN-only — never affects the exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CLI checkout currency');
    expect(out).toContain(`[${expected.status}]`);
  });

  /**
   * groundnuty/macf#1362 root cause 2's shape, reached through the ACTUAL
   * `macf doctor` entrypoint: no macf-agent.json at all still renders this
   * section (early-return branch) — matching the script/rule currency
   * sections' own no-early-return-skip fix.
   */
  it('renders the section even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    // Deliberately NO writeAgentConfig call.
    const expected = checkCheckoutCurrency();

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to this check

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('CLI checkout currency');
    expect(out).toContain(`[${expected.status}]`);
  });
});
