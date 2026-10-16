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
});
