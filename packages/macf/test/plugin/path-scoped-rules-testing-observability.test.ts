/**
 * #1465: the test-writing and observability rules load only when a matching
 * file is read, so each must keep valid `paths:` frontmatter on top after the
 * copy step (a managed header above it would silently disable the scoping).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyCanonicalRules } from '../../src/cli/rules.js';

const SCOPED = [
  'assert-the-wrong-path.md',
  'test-timeout-discriminator.md',
  'observability-wiring.md',
];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scoped-rules-'));
  mkdirSync(join(root, '.macf'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe.each(SCOPED)('%s after copyCanonicalRules', (name) => {
  it('keeps frontmatter on the first line with a valid non-empty paths list', () => {
    copyCanonicalRules(root);
    const text = readFileSync(join(root, '.claude', 'rules', name), 'utf-8');
    expect(text.startsWith('---\n')).toBe(true);
    const end = text.indexOf('\n---\n', 4);
    expect(end).toBeGreaterThan(0);
    const fm = parse(text.slice(4, end)) as { paths?: unknown };
    expect(Array.isArray(fm.paths)).toBe(true);
    const paths = fm.paths as unknown[];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(typeof p).toBe('string');
  });
});
