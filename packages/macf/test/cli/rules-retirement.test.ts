/**
 * #1465 rules-writer prerequisites: (1) the managed header must not push a
 * rule's `---` frontmatter off the top of the file; (2) retired canonical
 * rule names are deleted from workspaces — only managed copies, only through
 * the stale-CLI guard, and `doctor` flags / `--fix` removes leftovers.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyCanonicalAssetsGuarded } from '../../src/cli/canonical-overwrite-guard.js';
import { checkDistributedRuleCurrency, runDoctor } from '../../src/cli/commands/doctor.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import {
  RETIRED_CANONICAL_RULES,
  computeCanonicalRuleFile,
  copyCanonicalRules,
  retireCanonicalRules,
} from '../../src/cli/rules.js';

const FM = '---\npaths:\n  - "src/**/*.ts"\n---\n';
const HEADER_START = '<!--\n  This file is managed by `macf`.';
const MANAGED = `${HEADER_START} Do not edit directly`;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rules-retire-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function rulesDir(): string { return join(root, '.claude', 'rules'); }
function put(name: string, content: string): string {
  mkdirSync(rulesDir(), { recursive: true });
  const p = join(rulesDir(), name);
  writeFileSync(p, content);
  return p;
}
function git(cwd: string, ...a: string[]): void {
  execFileSync('git', a, { cwd, stdio: 'ignore' });
}

describe('managed header vs frontmatter', () => {
  function canonical(files: Record<string, string>): string {
    const dir = join(root, 'canon');
    mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
    return dir;
  }

  it('frontmatter stays byte-identical at the top; header follows it', () => {
    const dir = canonical({ 'a.md': `${FM}# Body\n` });
    const out = computeCanonicalRuleFile('a.md', { canonicalDir: dir }) as string;
    expect(out.startsWith(FM)).toBe(true);
    expect(out.slice(FM.length).startsWith(HEADER_START)).toBe(true);
    expect(out.endsWith('# Body\n')).toBe(true);
    expect(out.match(/This file is managed by/g)).toHaveLength(1);
  });

  it('a rule without frontmatter keeps the header at the very top', () => {
    const dir = canonical({ 'b.md': '# Body\n', 'c.md': '<!-- own header -->\n# C\n' });
    expect((computeCanonicalRuleFile('b.md', { canonicalDir: dir }) as string).startsWith(HEADER_START)).toBe(true);
    expect(computeCanonicalRuleFile('c.md', { canonicalDir: dir })).toBe('<!-- own header -->\n# C\n');
  });

  it('a `---` thematic break that is not frontmatter (no closing ---) is not split', () => {
    const dir = canonical({ 'd.md': '---\njust text, no close\n' });
    expect((computeCanonicalRuleFile('d.md', { canonicalDir: dir }) as string).startsWith(HEADER_START)).toBe(true);
  });

  it('doctor reads a correctly copied frontmatter rule as current', () => {
    const dir = canonical({ 'a.md': `${FM}# Body\n` });
    mkdirSync(join(root, '.macf'), { recursive: true });
    copyCanonicalRules(root, { canonicalDir: dir });
    expect(readFileSync(join(rulesDir(), 'a.md'), 'utf-8').startsWith(FM)).toBe(true);
    const res = checkDistributedRuleCurrency(root, { canonicalDir: dir, retiredRules: [] });
    expect(res.status).toBe('PASS');
    expect(res.findings).toEqual([]);
  });
});

describe('retireCanonicalRules', () => {
  const warn = vi.fn();
  beforeEach(() => warn.mockClear());

  it('deletes a managed retired copy (plain and frontmatter forms)', () => {
    const dir = join(root, 'canon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.md'), '# old\n');
    writeFileSync(join(dir, 'fm.md'), `${FM}# fm\n`);
    copyCanonicalRules(root, { canonicalDir: dir });
    const r = retireCanonicalRules(root, { retired: ['old.md', 'fm.md'], warn });
    expect([...r.removed].sort()).toEqual(['fm.md', 'old.md']);
    expect(existsSync(join(rulesDir(), 'old.md'))).toBe(false);
    expect(existsSync(join(rulesDir(), 'fm.md'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an operator-authored file of a retired name and warns once, naming it', () => {
    const p = put('mine.md', '# my own rules, no header\n');
    const r = retireCanonicalRules(root, { retired: ['mine.md'], warn });
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(['mine.md']);
    expect(readFileSync(p, 'utf-8')).toBe('# my own rules, no header\n');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('mine.md');
  });

  it('keeps a managed file whose name is not retired', () => {
    const dir = join(root, 'canon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'live.md'), '# live\n');
    copyCanonicalRules(root, { canonicalDir: dir });
    retireCanonicalRules(root, { retired: ['other.md'], warn });
    expect(existsSync(join(rulesDir(), 'live.md'))).toBe(true);
  });

  it('is idempotent, and ignores an absent file', () => {
    const dir = join(root, 'canon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.md'), '# old\n');
    copyCanonicalRules(root, { canonicalDir: dir });
    expect(retireCanonicalRules(root, { retired: ['old.md'], warn }).removed).toEqual(['old.md']);
    expect(retireCanonicalRules(root, { retired: ['old.md'], warn })).toEqual({ removed: [], kept: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a retired name that could reach outside .claude/rules/', () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'victim.md'), `${MANAGED}\n`);
    expect(() => retireCanonicalRules(root, { retired: ['../victim.md'], warn })).toThrow();
    expect(existsSync(join(root, '.claude', 'victim.md'))).toBe(true);
  });

  it('the production list starts empty', () => {
    expect(RETIRED_CANONICAL_RULES).toEqual([]);
  });
});

describe('copyCanonicalAssetsGuarded — retirement obeys the guard verdict', () => {
  const logSpy = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('deletes a managed retired copy on proceed', () => {
    const spy = logSpy();
    copyCanonicalRules(root); // real canonical: gives us a genuinely managed file
    const real = put('retired-x.md', computeCanonicalRuleFile('coordination.md') as string);
    const out = copyCanonicalAssetsGuarded(root, { packageRoot: root, canonicalBranch: 'main', retiredRules: ['retired-x.md'] });
    spy.mockRestore();
    expect(out.guard.kind).toBe('proceed');
    expect(out.retiredRules).toEqual(['retired-x.md']);
    expect(existsSync(real)).toBe(false);
  });

  it('deletes nothing when the guard refuses (stale-checkout CLI)', () => {
    const spy = logSpy();
    // A packageRoot that is a git checkout 1 commit behind origin/main, with a
    // rule on disk that differs from what that stale CLI would write.
    const pkg = join(root, 'pkg');
    const origin = join(root, 'origin.git');
    mkdirSync(pkg, { recursive: true });
    git(pkg, 'init', '-q', '-b', 'main');
    for (const kv of [['user.email', 't@e.invalid'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
      git(pkg, 'config', kv[0] as string, kv[1] as string);
    }
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@x/macf', version: '0.0.0' }));
    mkdirSync(join(pkg, 'plugin', 'rules'), { recursive: true });
    mkdirSync(join(pkg, 'plugin', 'scripts'), { recursive: true });
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    writeFileSync(join(pkg, 'plugin', 'rules', 'coordination.md'), '# stale canonical\n');
    git(pkg, 'add', '-A');
    git(pkg, 'commit', '-q', '-m', 'one');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(pkg, 'remote', 'add', 'origin', origin);
    git(pkg, 'push', '-q', 'origin', 'main');
    git(pkg, 'commit', '-q', '--allow-empty', '-m', 'two');
    git(pkg, 'push', '-q', 'origin', 'main');
    git(pkg, 'reset', '-q', '--hard', 'HEAD~1');
    git(pkg, 'fetch', '-q', 'origin');

    put('coordination.md', '# fresher than the stale CLI would write\n');
    const retired = put('retired-x.md', computeCanonicalRuleFile('coordination.md') as string);
    const out = copyCanonicalAssetsGuarded(root, { packageRoot: pkg, canonicalBranch: 'main', retiredRules: ['retired-x.md'] });
    spy.mockRestore();
    expect(out.guard.kind).toBe('refuse');
    expect(out.copied).toBe(false);
    expect(out.retiredRules).toEqual([]);
    expect(existsSync(retired)).toBe(true);
  });
});

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

describe('doctor — retired rule leftovers', () => {
  const list = RETIRED_CANONICAL_RULES as string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    list.push('retired-x.md');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    list.length = 0;
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('flags a managed leftover by name; an operator-authored one is not drift', () => {
    mkdirSync(join(root, '.macf'), { recursive: true });
    copyCanonicalRules(root);
    put('retired-x.md', computeCanonicalRuleFile('coordination.md') as string);
    const res = checkDistributedRuleCurrency(root);
    expect(res.status).toBe('WARN');
    expect(res.findings).toContainEqual({ name: 'retired-x.md', reason: 'retired' });

    put('retired-x.md', '# operator wrote this\n');
    expect(checkDistributedRuleCurrency(root).findings).toEqual([]);
  });

  it('--fix removes the leftover, and the gate trips on that finding alone', async () => {
    writeAgentConfig(root, localConfig());
    list.length = 0; // first --fix run: settle every other floor item
    await runDoctor(root, { fix: true, yes: true });
    copyCanonicalRules(root);
    list.push('retired-x.md');
    const leftover = put('retired-x.md', computeCanonicalRuleFile('coordination.md') as string);
    logSpy.mockClear();

    await runDoctor(root, { fix: true, yes: true });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('retired-x.md');
    expect(out).not.toContain('nothing to fix');
    expect(out).toContain('--fix applied');
    expect(existsSync(leftover)).toBe(false);
  });
});
