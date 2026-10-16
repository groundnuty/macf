/**
 * groundnuty/macf#1477 — doctor reports a workspace whose macf certs/env
 * paths are not git-ignored, and `--fix` restores the macf block.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkMacfIgnores, runDoctor } from '../../src/cli/commands/doctor.js';
import { updateGitignore } from '../../src/cli/commands/init.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import {
  installGhTokenHook,
  installIdleCompactionOff,
  installPluginSkillPermissions,
  installSandboxExcludedCommands,
  installSandboxFdAllowRead,
  installStartupPickupHook,
} from '../../src/cli/settings-writer.js';

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-macf-ignores-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  writeAgentConfig(dir, {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'local', path: '/tmp/macf-test-registry.json' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  });
  mkdirSync(join(dir, '.macf', 'certs'), { recursive: true });
  mkdirSync(join(dir, '.claude', '.macf'), { recursive: true });
  writeFileSync(join(dir, '.claude', '.macf', 'env.github'), 'x\n');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

/** Every other `--fix` trigger satisfied, so only the ignore finding can trip the gate. */
function satisfyFloor(): void {
  installPluginSkillPermissions(dir);
  installGhTokenHook(dir);
  installStartupPickupHook(dir);
  installSandboxFdAllowRead(dir);
  installSandboxExcludedCommands(dir);
  installIdleCompactionOff(dir);
}

describe('checkMacfIgnores', () => {
  it('WARNs naming each existing path git does not ignore', () => {
    const r = checkMacfIgnores(dir);
    expect(r.status).toBe('WARN');
    expect(r.findings).toEqual(['.macf/certs', '.claude/.macf/env.github']);
  });

  it('PASSes once the macf block is present', () => {
    updateGitignore(dir);
    expect(checkMacfIgnores(dir)).toMatchObject({ status: 'PASS', findings: [] });
  });

  it('reports a tracked secret on its own, never as merely unignored', () => {
    execFileSync('git', ['add', '-f', '.claude/.macf/env.github'], { cwd: dir });
    updateGitignore(dir);
    const r = checkMacfIgnores(dir);
    expect(r.status).toBe('WARN');
    expect(r.tracked).toEqual(['.claude/.macf/env.github']);
    expect(r.findings).toEqual([]);
    expect(r.detail).toContain(
      '.claude/.macf/env.github is tracked by git, so ignore rules do not apply to it. Remove it from the index with git rm --cached .claude/.macf/env.github and commit; if that commit was ever pushed, treat the key or token in it as exposed and rotate it.',
    );
  });

  it('a key committed under .macf/certs is reported as tracked even after .macf/ is ignored', () => {
    mkdirSync(join(dir, '.macf', 'certs'), { recursive: true });
    writeFileSync(join(dir, '.macf', 'certs', 'agent-key.pem'), 'secret');
    execFileSync('git', ['add', '-f', '.macf/certs/agent-key.pem'], { cwd: dir });
    updateGitignore(dir);
    const r = checkMacfIgnores(dir);
    expect(r.status).toBe('WARN');
    expect(r.tracked).toContain('.macf/certs');
  });

  it('reports a "!" re-include when the block exists but the path is still not ignored', () => {
    updateGitignore(dir);
    writeFileSync(join(dir, '.gitignore'), readFileSync(join(dir, '.gitignore'), 'utf-8') + '!.claude/.macf/\n');
    const r = checkMacfIgnores(dir);
    expect(r.status).toBe('WARN');
    expect(r.reincluded).toEqual(['.claude/.macf/env.github']);
    expect(r.detail).toContain(
      '.claude/.macf/env.github is still not ignored after the macf block was added; a "!" line in .gitignore re-includes it. Remove that line.',
    );
  });

  it('missing block gives the plain WARN text', () => {
    expect(checkMacfIgnores(dir).detail).toBe(
      ".macf/certs, .claude/.macf/env.github not ignored by git, so an agent's git add -A would commit its certs and env files.",
    );
  });

  it('UNKNOWN outside a git repository (never PASS)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'doctor-macf-ignores-plain-'));
    mkdirSync(join(plain, '.macf', 'certs'), { recursive: true });
    try {
      expect(checkMacfIgnores(plain).status).toBe('UNKNOWN');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('runDoctor --fix with the macf ignores missing', () => {
  it('with the block present and the floor satisfied there is nothing to fix', async () => {
    satisfyFloor();
    updateGitignore(dir);
    await runDoctor(dir, { fix: true, yes: true });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('--fix: nothing to fix');
  });

  it('the missing ignore alone trips the gate, and --fix restores the block', async () => {
    satisfyFloor();
    await runDoctor(dir, { fix: true, yes: true });

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('--fix: nothing to fix');
    expect(out).toContain('restore the macf block in .gitignore');
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('.macf/');
    for (const p of ['.macf/certs', '.claude/.macf/env.github']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', p], { cwd: dir })).not.toThrow();
    }
  });

  it('a tracked file stays reported after --fix, which does not claim to repair it', async () => {
    satisfyFloor();
    execFileSync('git', ['add', '-f', '.claude/.macf/env.github'], { cwd: dir });
    updateGitignore(dir);
    await runDoctor(dir, { fix: true, yes: true });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('--fix: nothing to fix');
    expect(out).toContain('is tracked by git, so ignore rules do not apply to it');
    expect(out).not.toContain('Fix: run `macf doctor --fix` (restores');
  });

  it('the --fix header does not claim everything goes into settings.json', async () => {
    satisfyFloor();
    await runDoctor(dir, { fix: true, yes: true });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('--fix will:');
    expect(out).not.toContain('--fix will write the role-aware settings floor');
  });
});
