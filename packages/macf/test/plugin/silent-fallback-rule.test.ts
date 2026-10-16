/**
 * Guard: the always-loaded rule `silent-fallback-hazards.md` stays short and
 * its "Instance index" stays in sync with the `### Instance N` headings of
 * the catalogue (`design/silent-fallback-catalog.md`). 177 references cite
 * "Instance N" by number; the index is what keeps each one resolvable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(pkgRoot, '..', '..');
const rule = readFileSync(join(pkgRoot, 'plugin', 'rules', 'silent-fallback-hazards.md'), 'utf-8');
const catalog = readFileSync(join(repoRoot, 'design', 'silent-fallback-catalog.md'), 'utf-8');

function catalogHeadings(): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const m of catalog.matchAll(/^### Instance (\d+)(.*)$/gm)) {
    out.set(Number(m[1]), /^\s*[—–-]+\s*retired\b/i.test(m[2] ?? ''));
  }
  return out;
}

/** Entries of the index: "<N> <description>" separated by " · ". */
function indexEntries(): Map<number, string> {
  const section = rule.split(/^## Instance index$/m)[1];
  expect(section, 'rule must have an "## Instance index" section').toBeDefined();
  const out = new Map<number, string>();
  const paragraphs = (section ?? '').trim().split(/\n\s*\n/);
  for (const part of (paragraphs[paragraphs.length - 1] ?? '').split('·')) {
    const m = part.trim().match(/^(\d+) (.+)$/s);
    if (m) out.set(Number(m[1]), (m[2] ?? '').trim());
  }
  return out;
}

describe('silent-fallback-hazards.md rule — index sync with the catalogue', () => {
  it('lists exactly the instance numbers that are catalogue headings (both directions)', () => {
    const headings = [...catalogHeadings().keys()].sort((a, b) => a - b);
    const indexed = [...indexEntries().keys()].sort((a, b) => a - b);
    expect(indexed).toEqual(headings);
  });

  it('marks an instance retired in the catalogue as "retired" in the index, and only those', () => {
    const idx = indexEntries();
    for (const [n, retired] of catalogHeadings()) {
      const isRetiredInIndex = /^retired\b/i.test(idx.get(n) ?? '');
      expect(isRetiredInIndex, `instance ${n}`).toBe(retired);
    }
  });
});

describe('silent-fallback-hazards.md rule — shape', () => {
  it('is at most 4,000 characters', () => {
    expect(rule.length).toBeLessThanOrEqual(4000);
  });

  it('contains no ** bold', () => {
    expect(rule).not.toContain('**');
  });

  it('names defence patterns A through E', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      expect(rule, `pattern ${letter}`).toMatch(new RegExp(`^- ${letter}: `, 'm'));
    }
  });
});
