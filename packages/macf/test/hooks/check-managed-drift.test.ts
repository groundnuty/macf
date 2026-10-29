/**
 * Tests for `plugin/scripts/check-managed-drift.sh` — the SessionStart hook
 * (groundnuty/macf#1525) that re-hashes the files listed in
 * `.macf/managed-hashes.json` and tells the agent when any is missing or
 * changed. Quiet when clean, and quiet when there is no record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';
import { recordManagedHashes, findManagedDrift } from '../../src/cli/managed-hashes.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-managed-drift.sh');

function runHook(workspace: string): { stdout: string; status: number | null } {
  const r = spawnSync('bash', [HOOK_SCRIPT], {
    input: '{"source":"resume"}',
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace, MACF_SKIP_MANAGED_DRIFT_CHECK: '' },
  });
  return { stdout: r.stdout, status: r.status };
}

describe('check-managed-drift.sh (#1525)', () => {
  let ws: string;
  const rule = (n: string): string => `.claude/rules/${n}`;

  function writeManaged(names: readonly string[]): void {
    mkdirSync(join(ws, '.claude', 'rules'), { recursive: true });
    for (const n of names) writeFileSync(join(ws, rule(n)), `content of ${n}\n`);
    recordManagedHashes(ws, names.map(rule));
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'macf-managed-drift-'));
    mkdirSync(join(ws, '.macf'), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('is quiet on a clean workspace', () => {
    writeManaged(['a.md', 'b.md']);
    const r = runHook(ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('reports a deleted managed rule', () => {
    writeManaged(['a.md', 'b.md']);
    unlinkSync(join(ws, rule('a.md')));
    const r = runHook(ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      'MACF: 1 managed files are missing or changed (.claude/rules/a.md). Run macf update to restore them, and tell the operator.\n',
    );
  });

  it('reports a modified managed rule', () => {
    writeManaged(['a.md', 'b.md']);
    writeFileSync(join(ws, rule('b.md')), 'edited\n');
    const r = runHook(ws);
    expect(r.stdout).toContain('1 managed files are missing or changed (.claude/rules/b.md)');
  });

  it('is quiet when there is no managed-hashes.json', () => {
    const r = runHook(ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is quiet when managed-hashes.json is unreadable JSON', () => {
    writeFileSync(join(ws, '.macf', 'managed-hashes.json'), '{ not json');
    const r = runHook(ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('lists at most 5 paths, then "and N more"', () => {
    const names = ['f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md', 'f6.md', 'f7.md'];
    writeManaged(names);
    for (const n of names) unlinkSync(join(ws, rule(n)));
    const r = runHook(ws);
    expect(r.stdout).toContain('7 managed files are missing or changed (');
    expect(r.stdout).toContain('.claude/rules/f5.md, and 2 more)');
    expect(r.stdout).not.toContain('f6.md');
  });

  it('findManagedDrift (macf doctor) agrees with the hook', () => {
    expect(findManagedDrift(ws)).toBeNull();
    writeManaged(['a.md', 'b.md']);
    expect(findManagedDrift(ws)).toEqual([]);
    unlinkSync(join(ws, rule('a.md')));
    writeFileSync(join(ws, rule('b.md')), 'edited\n');
    expect(findManagedDrift(ws)?.sort()).toEqual([rule('a.md'), rule('b.md')]);
  });
});
