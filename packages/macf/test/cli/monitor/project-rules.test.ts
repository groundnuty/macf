/**
 * Tests for the defensive project-tier rule count (macf#502, DR-026 F4).
 *
 * F3 (`project-rules.ts`) is not on this branch, so the Monitor must check the
 * filesystem directly and tolerate the directory being absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { countProjectRules } from '../../../src/cli/monitor/run.js';

describe('countProjectRules', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `macf-pr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns 0 when .claude/rules/project is absent (F3 not merged)', () => {
    expect(countProjectRules(dir)).toBe(0);
  });

  it('counts only .md files in the project rules dir', () => {
    const pdir = join(dir, '.claude', 'rules', 'project');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'r1.md'), '# rule 1');
    writeFileSync(join(pdir, 'r2.md'), '# rule 2');
    writeFileSync(join(pdir, 'notes.txt'), 'ignored');
    expect(countProjectRules(dir)).toBe(2);
  });
});
