/**
 * Tests for `macf doctor`'s managed-file-git-tracking check
 * (groundnuty/macf#1411 — every existing currency check reports the same
 * PASS for "current, tracked in git" as it does for "current, untracked" —
 * and only the second is what "current" means. A canonically-distributed
 * `.claude/scripts/` or `.claude/rules/` file that is ALSO tracked in git is
 * a second writer racing `macf update`: the next `git reset --hard` or fresh
 * clone silently reinstalls whatever was last committed, with no error and
 * nothing to say so until the *next* `macf doctor` run happens to re-check
 * byte currency).
 *
 * `checkManagedFilesGitTracking` is exercised directly (with fake canonical
 * dirs, real git repos in tmp fixtures) for the decisive pair + the mixed
 * case + the no-git-repo case. The final describe block drives the check
 * through the full `runDoctor` report and reads the RENDERED console output
 * (not a helper's return value) — same discipline as the sibling currency
 * checks: a correct-but-unreachable code path is only caught by a test
 * reading output through the real entrypoint.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkManagedFilesGitTracking, runDoctor } from '../../src/cli/commands/doctor.js';
import { copyCanonicalRules, copyCanonicalScripts } from '../../src/cli/rules.js';
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

describe('checkManagedFilesGitTracking (groundnuty/macf#1411)', () => {
  let tmpRoot: string;
  let fakeCanonical: string;
  let fakePluginScripts: string;
  let fakeRules: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-managed-git-tracking-'));
    fakeCanonical = join(tmpRoot, 'canonical-scripts');
    fakePluginScripts = join(tmpRoot, 'canonical-plugin-scripts');
    fakeRules = join(tmpRoot, 'canonical-rules');
    mkdirSync(fakeCanonical, { recursive: true });
    mkdirSync(fakePluginScripts, { recursive: true });
    mkdirSync(fakeRules, { recursive: true });
    // One canonical script (plugin dir per DR-039 phase 2 placement) + one
    // canonical rule — enough to exercise the union of both populations.
    writeFileSync(join(fakePluginScripts, 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    writeFileSync(join(fakeRules, 'coordination.md'), '# coordination\n');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const dirs = () => ({
    canonicalDir: fakeCanonical,
    pluginScriptsDir: fakePluginScripts,
    rulesDir: fakeRules,
  });

  it('WARN: a distributed script committed to git is named by path (decisive pair, part 1)', () => {
    initRepo(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    git(tmpRoot, 'add', '.claude/scripts/check-gh-token.sh');
    git(tmpRoot, 'commit', '-q', '-m', 'accidentally track a managed script');

    const result = checkManagedFilesGitTracking(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toEqual([{ path: '.claude/scripts/check-gh-token.sh' }]);
    expect(result.detail).toMatch(/tracked in git/i);
  });

  it('PASS: the same file present but ignored via .gitignore is silent (decisive pair, part 2)', () => {
    initRepo(tmpRoot);
    writeFileSync(join(tmpRoot, '.gitignore'), '.claude/scripts/*\n');
    git(tmpRoot, 'add', '.gitignore');
    git(tmpRoot, 'commit', '-q', '-m', 'ignore managed scripts');
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    // Confirm the fixture actually exercises "ignored", not merely "never
    // added" — `git add` on an ignored path fails without `-f`.
    expect(() => git(tmpRoot, 'add', '.claude/scripts/check-gh-token.sh')).toThrow();

    const result = checkManagedFilesGitTracking(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('UNKNOWN: no .git directory at all — never reported as PASS', () => {
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');

    const result = checkManagedFilesGitTracking(tmpRoot, dirs());
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('WARN: a mix (one tracked, one ignored) names ONLY the tracked file', () => {
    initRepo(tmpRoot);
    writeFileSync(join(tmpRoot, '.gitignore'), '.claude/scripts/*\n');
    git(tmpRoot, 'add', '.gitignore');
    git(tmpRoot, 'commit', '-q', '-m', 'ignore managed scripts');

    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    // check-gh-token.sh stays ignored/untracked.

    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), '# coordination\n');
    git(tmpRoot, 'add', '.claude/rules/coordination.md');
    git(tmpRoot, 'commit', '-q', '-m', 'accidentally track a managed rule');

    const result = checkManagedFilesGitTracking(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toEqual([{ path: '.claude/rules/coordination.md' }]);
  });

  it('PASS: an empty distributed set (neither canonical dir has anything) has nothing to check', () => {
    initRepo(tmpRoot);
    const result = checkManagedFilesGitTracking(tmpRoot, {
      canonicalDir: join(tmpRoot, 'no-scripts-here'),
      pluginScriptsDir: join(tmpRoot, 'no-plugin-scripts-here'),
      rulesDir: join(tmpRoot, 'no-rules-here'),
    });
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('mutation check: a canonically-named file that was never `git add`ed is never reported tracked (positive control)', () => {
    initRepo(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    // Deliberately no `git add` — present on disk, untracked.

    const result = checkManagedFilesGitTracking(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });
});

describe('runDoctor — Managed file git tracking section (rendered output, groundnuty/macf#1411)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-managed-git-tracking-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Real canonical scripts + rules (no override) — the assertion is against
   * what an operator actually sees. `copyCanonicalScripts`/`copyCanonicalRules`
   * are the exact functions `macf update` calls, so the workspace is fully
   * current for byte-currency purposes; only the git-tracking state of ONE
   * file is deliberately wrong.
   */
  it('names a tracked distributed script in the rendered report; exit code unaffected', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    initRepo(tmpRoot);
    copyCanonicalScripts(tmpRoot);
    copyCanonicalRules(tmpRoot);
    git(tmpRoot, 'add', '.claude/scripts/check-gh-token.sh');
    git(tmpRoot, 'commit', '-q', '-m', 'accidentally track a managed script');

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // WARN-only — does not affect exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Managed file git tracking');
    expect(out).toContain('.claude/scripts/check-gh-token.sh');
    expect(out).toMatch(/\[WARN\]/);
  });

  it('reports PASS with no findings when nothing distributed is tracked in git', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    initRepo(tmpRoot);
    copyCanonicalScripts(tmpRoot);
    copyCanonicalRules(tmpRoot);
    // Deliberately never `git add` anything under `.claude/scripts/` or
    // `.claude/rules/`.

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Managed file git tracking');
    const section = out.slice(out.indexOf('Managed file git tracking'));
    expect(section).toMatch(/\[PASS\]/);
  });

  /**
   * groundnuty/macf#1362's root-cause-2 shape (no macf-agent.json at all) —
   * the check must render even through the early-return path, same
   * discipline as the sibling currency checks.
   */
  it('renders even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    initRepo(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'macf-gh-token.sh'), '#!/usr/bin/env bash\necho ok\n');
    git(tmpRoot, 'add', '.claude/scripts/macf-gh-token.sh');
    git(tmpRoot, 'commit', '-q', '-m', 'track a managed script in an unmanaged workspace');

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to tracking

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Managed file git tracking');
    expect(out).toContain('.claude/scripts/macf-gh-token.sh');
    expect(out).toMatch(/\[WARN\]/);
  });
});
