/**
 * Tests for `macf doctor`'s stray-script visibility check
 * (groundnuty/macf#1401 second increment) — surfaces `.claude/scripts/`
 * entries the tool did NOT put there, distinct from the pre-existing
 * currency check's "is what IS here current" question. A stray is not a
 * defect (an operator may want it there forever) — the check is INFO, not
 * WARN, and never deletes.
 *
 * `checkStrayScripts` is exercised directly (with fake canonical dirs,
 * offline, no network) for the decisive pair + the edge cases. The final
 * describe block drives the check through the full `runDoctor` report and
 * reads the RENDERED console output — same pattern as
 * `doctor-script-currency.test.ts`'s own rendered-output block.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkStrayScripts, runDoctor } from '../../src/cli/commands/doctor.js';
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

describe('checkStrayScripts (groundnuty/macf#1401 second increment)', () => {
  let tmpRoot: string;
  let fakeCanonical: string;
  let fakePluginScripts: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-stray-scripts-'));
    fakeCanonical = join(tmpRoot, 'canonical');
    fakePluginScripts = join(tmpRoot, 'plugin-canonical');
    mkdirSync(fakeCanonical, { recursive: true });
    mkdirSync(fakePluginScripts, { recursive: true });
    // Mirrors doctor-script-currency.test.ts's fixture placement: check-gh-token.sh
    // lives in the PLUGIN canonical dir per DR-039 phase 2.
    writeFileSync(join(fakePluginScripts, 'check-gh-token.sh'), '#!/usr/bin/env bash\necho canonical\n');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const dirs = () => ({ canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

  function writeScript(name: string, content = '#!/usr/bin/env bash\necho hi\n'): void {
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', name), content);
  }

  it('PASS: no .claude/scripts/ directory at all', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('PASS: empty .claude/scripts/ directory', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
  });

  it('PASS: only distributed + allow-listed entries present', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('check-gh-token.sh');
    writeScript('macf-statusline.sh');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  // --- Decisive pair (assert-the-wrong-path.md) ---

  it('DECISIVE PAIR (1/2): a stray present is NAMED', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('check-gh-token.sh');
    writeScript('my-hand-authored-helper.sh');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.findings).toEqual([{ name: 'my-hand-authored-helper.sh' }]);
    expect(result.detail).toMatch(/1 script/);
  });

  it('DECISIVE PAIR (2/2): only distributed + allow-listed → silent (PASS, no findings)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('check-gh-token.sh');
    writeScript('macf-statusline.sh');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('reports repo-local build tooling (release.sh) as a stray — the motivating instance, deliberately NOT allow-listed', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('release.sh');
    writeScript('release.test.sh');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    const names = result.findings.map((f) => f.name).sort();
    expect(names).toEqual(['release.sh', 'release.test.sh']);
  });

  it('reports a non-.sh stray file — a leftover .bak/.mjs is exactly the shape nobody notices', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('check-gh-token.sh.bak', 'leftover');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.findings).toEqual([{ name: 'check-gh-token.sh.bak' }]);
  });

  it('skips a directory inside .claude/scripts/ — never reported as a stray', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts', 'a-subdir'), { recursive: true });
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
  });

  it('follows a symlinked stray script rather than losing it (entry.isFile() would report the symlink type, not the target)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    const target = join(tmpRoot, 'external-helper.sh');
    writeFileSync(target, '#!/usr/bin/env bash\necho hi\n');
    symlinkSync(target, join(tmpRoot, '.claude', 'scripts', 'linked-helper.sh'));
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.findings.map((f) => f.name)).toContain('linked-helper.sh');
  });

  it('does not throw on a broken symlink — skipped, not reported', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    symlinkSync(join(tmpRoot, 'does-not-exist.sh'), join(tmpRoot, '.claude', 'scripts', 'broken-link.sh'));
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('INFO: no .macf/ directory — not a macf-managed workspace, no false-positive stray enumeration', () => {
    writeScript('anything.sh');
    const result = checkStrayScripts(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.findings).toEqual([]);
    expect(result.detail).toMatch(/not a macf-managed workspace/i);
  });

  it("UNKNOWN: plugin scripts dir absent — never enumerates findings (a script canonical to the missing dir would misread as a stray)", () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    writeScript('check-gh-token.sh'); // canonical to the (about-to-be-missing) plugin dir
    const result = checkStrayScripts(tmpRoot, {
      canonicalDir: fakeCanonical,
      pluginScriptsDir: join(tmpRoot, 'does-not-exist'),
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings).toEqual([]);
  });

  it('UNKNOWN: legacy scripts dir absent — symmetric case', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    const result = checkStrayScripts(tmpRoot, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
      pluginScriptsDir: fakePluginScripts,
    });
    expect(result.status).toBe('UNKNOWN');
  });
});

describe('runDoctor — Stray scripts + guard-gap classification (rendered output, groundnuty/macf#1401)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-stray-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePluginHooksJsonZeroPreToolUse(pluginRelDir: string): void {
    const dir = join(tmpRoot, pluginRelDir, 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2));
  }

  function writeClaudeSh(pluginDirExpr: string): void {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      ['#!/bin/bash', 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"', `exec claude --plugin-dir "${pluginDirExpr}" "$@"`, ''].join('\n'),
    );
  }

  it('renders the Stray scripts section header and names a stray entry', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'scripts', 'my-operator-helper.sh'), '#!/usr/bin/env bash\necho hi\n');

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // INFO-only — does not affect the exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Stray scripts');
    expect(out).toContain('my-operator-helper.sh');
    expect(out).toMatch(/\[INFO\]/);
  });

  it('renders no findings when .claude/scripts/ is empty of strays', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Stray scripts');
    expect(out).toMatch(/no .claude\/scripts\/ directory|\[PASS\]/i);
  });

  it('composes the systemic-pin classification into the Distributed script currency WARN when the mounted plugin has zero PreToolUse hooks', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    // Deliberately no .claude/scripts/ population at all — every canonically
    // distributed script reads `missing`, which is what makes the
    // classification eligible to print (stale-only findings never do).
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJsonZeroPreToolUse('.macf/plugin');

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed script currency');
    expect(out).toMatch(/plugin clone carries no hooks/);
    expect(out).toMatch(/version-pin defect at deploy/);
    expect(out).not.toMatch(/version-pin defect at deploy.*version-pin defect at deploy/s); // printed once
    // Never cites an internal issue number in this user-facing line.
    expect(out).not.toMatch(/\bmacf#\d+\b/);
  });
});
