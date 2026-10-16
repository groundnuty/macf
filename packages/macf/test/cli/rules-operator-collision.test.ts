/**
 * #1476 item 2: a header-less `.claude/rules/<name>.md` that shares a canonical
 * name is operator-authored — copy keeps it (as retirement already does),
 * warns once, reports it, and `doctor` flags it as a collision, not "missing".
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDistributedRuleCurrency, printRuleCurrencySection } from '../../src/cli/commands/doctor.js';
import { copyCanonicalRules, copyCanonicalRulesDetailed } from '../../src/cli/rules.js';
import { copyCanonicalAssetsGuarded } from '../../src/cli/canonical-overwrite-guard.js';

let root: string;
let canon: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rules-collision-'));
  canon = join(root, 'canon');
  mkdirSync(canon, { recursive: true });
  writeFileSync(join(canon, 'pr-discipline.md'), '# Canonical PR discipline\n');
  writeFileSync(join(canon, 'other.md'), '# Other\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const ws = (): string => join(root, 'ws');
const dst = (n: string): string => join(ws(), '.claude', 'rules', n);
function put(n: string, c: string): void {
  mkdirSync(join(ws(), '.claude', 'rules'), { recursive: true });
  writeFileSync(dst(n), c);
}

describe('copyCanonicalRulesDetailed — operator-authored collision', () => {
  it('keeps a header-less file, warns once naming it, and reports it as kept', () => {
    put('pr-discipline.md', '# Commit message format\n');
    const warn = vi.fn();
    const r = copyCanonicalRulesDetailed(ws(), { canonicalDir: canon, warn });
    expect(readFileSync(dst('pr-discipline.md'), 'utf-8')).toBe('# Commit message format\n');
    expect(r.kept).toEqual(['pr-discipline.md']);
    expect(r.copied).toEqual(['other.md']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('.claude/rules/pr-discipline.md');
    expect(warn.mock.calls[0]?.[0]).toMatch(/rename.*delete/i);
  });

  it('overwrites a managed copy', () => {
    copyCanonicalRules(ws(), { canonicalDir: canon });
    writeFileSync(canon + '/pr-discipline.md', '# Canonical v2\n');
    const warn = vi.fn();
    const r = copyCanonicalRulesDetailed(ws(), { canonicalDir: canon, warn });
    expect(readFileSync(dst('pr-discipline.md'), 'utf-8')).toContain('# Canonical v2');
    expect(r.kept).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes a new file when none exists', () => {
    const r = copyCanonicalRulesDetailed(ws(), { canonicalDir: canon, warn: vi.fn() });
    expect(r.copied.sort()).toEqual(['other.md', 'pr-discipline.md']);
    expect(existsSync(dst('pr-discipline.md'))).toBe(true);
  });
});

describe('copyCanonicalAssetsGuarded surfaces the kept file', () => {
  it('reports keptRules and leaves the operator file (real canonical dir)', () => {
    const name = 'pr-discipline.md';
    put(name, '# Template commit rule\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = copyCanonicalAssetsGuarded(ws(), { canonicalBranch: 'main', force: true });
    expect(out.keptRules).toContain(name);
    expect(readFileSync(dst(name), 'utf-8')).toBe('# Template commit rule\n');
  });
});

describe('doctor — collision is its own finding', () => {
  it('reports operator-authored, not missing or stale', () => {
    mkdirSync(join(ws(), '.macf'), { recursive: true });
    put('pr-discipline.md', '# Commit message format\n');
    const r = checkDistributedRuleCurrency(ws(), { canonicalDir: canon });
    expect(r.findings.find((f) => f.name === 'pr-discipline.md')?.reason).toBe('operator-authored');
    expect(r.findings.find((f) => f.name === 'other.md')?.reason).toBe('missing');
    expect(r.detail).toContain('operator-authored');
  });
});

describe('doctor output — a collision alone does not end with the update Fix line', () => {
  const info = { status: 'INFO' as const, detail: 'not a framework checkout' };
  const printed = (findings: { name: string; reason: 'stale' | 'missing' | 'retired' | 'operator-authored' }[]): string => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { lines.push(String(m)); });
    printRuleCurrencySection({ status: 'WARN', checkedCount: 2, totalCount: 2, findings, detail: 'x' }, info);
    vi.restoreAllMocks();
    return lines.join('\n');
  };
  it('a collision-only section prints no `macf update` Fix line, because update keeps the file', () => {
    const out = printed([{ name: 'pr-discipline.md', reason: 'operator-authored' }]);
    expect(out).toContain('collision');
    expect(out).not.toContain('Fix: run');
  });
  it('a stale finding alongside a collision still prints the Fix line', () => {
    const out = printed([{ name: 'pr-discipline.md', reason: 'operator-authored' }, { name: 'other.md', reason: 'stale' }]);
    expect(out).toContain('Fix: run');
  });
});

describe('copyCanonicalRulesDetailed — symlinked destinations', () => {
  it('never writes through a symlink to an operator file outside the rules dir', () => {
    const outside = join(root, 'outside-pr-discipline.md');
    writeFileSync(outside, '# Operator commit rules\n');
    mkdirSync(join(ws(), '.claude', 'rules'), { recursive: true });
    symlinkSync(outside, dst('pr-discipline.md'));
    const warns: string[] = [];
    const r = copyCanonicalRulesDetailed(ws(), { canonicalDir: canon, warn: (m: string) => { warns.push(m); } });
    expect(readFileSync(outside, 'utf-8')).toBe('# Operator commit rules\n');
    expect(r.kept).toContain('pr-discipline.md');
    expect(warns.join('\n')).toContain('symbolic link');
  });
  it('does not create the target of a dangling symlink', () => {
    const missing = join(root, 'nowhere.md');
    mkdirSync(join(ws(), '.claude', 'rules'), { recursive: true });
    symlinkSync(missing, dst('pr-discipline.md'));
    copyCanonicalRulesDetailed(ws(), { canonicalDir: canon, warn: () => {} });
    expect(existsSync(missing)).toBe(false);
  });
});
