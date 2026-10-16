/**
 * groundnuty/macf#1477 — restart-self's stash leaves macf's own files alone.
 * Real git, real `createRealDeps().stash`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealDeps } from '../../src/cli/commands/restart-self.js';

const BLOCK = '\n# MACF agent data\n.macf/\n.claude/rules/\n.claude/scripts/\n';
let repo: string;

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

/** A deployed workspace: the macf ignore block and audit log appended, never committed. */
function deployed(): void {
  repo = mkdtempSync(join(tmpdir(), 'macf-stash-'));
  git('init', '--initial-branch=main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, '.claude', 'audit.log'), 'a\n');
  writeFileSync(join(repo, 'work.txt'), 'one\n');
  git('add', '.');
  git('commit', '-m', 'template');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n' + BLOCK);
  writeFileSync(join(repo, '.claude', 'audit.log'), 'a\nb\n');
}

describe.each([
  ['plain stash (standalone --force)', undefined],
  ['excludeConfigSurface (roll path)', { excludeConfigSurface: true }],
])('restart-self stash, %s', (_name, opts) => {
  it('leaves .gitignore and audit.log in the tree, still stashes other work', () => {
    deployed();
    writeFileSync(join(repo, 'work.txt'), 'two\n');
    const res = createRealDeps(repo).stash('macf-restart-self/t/upgrade', opts);

    expect(res.stashed).toBe(true);
    expect(readFileSync(join(repo, '.gitignore'), 'utf-8')).toContain('# MACF agent data');
    expect(readFileSync(join(repo, '.claude', 'audit.log'), 'utf-8')).toBe('a\nb\n');
    expect(readFileSync(join(repo, 'work.txt'), 'utf-8')).toBe('one\n');
    const stashed = git('stash', 'show', '--name-only', 'stash@{0}').trim().split('\n');
    expect(stashed).toEqual(['work.txt']);
    // The ignore block still hides the certs directory.
    mkdirSync(join(repo, '.macf', 'certs'), { recursive: true });
    expect(() => git('check-ignore', '.macf/certs')).not.toThrow();
  });

  it('with ONLY macf files dirty it stashes nothing (no pathspec error)', () => {
    deployed();
    const res = createRealDeps(repo).stash('macf-restart-self/t/upgrade', opts);
    expect(res.stashed).toBe(false);
    expect(git('stash', 'list').trim()).toBe('');
    expect(readFileSync(join(repo, '.gitignore'), 'utf-8')).toContain('.macf/');
  });
});
