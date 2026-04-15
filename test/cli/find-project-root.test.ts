import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findProjectRoot } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-find-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createMacfProject(dir: string): void {
  mkdirSync(join(dir, '.macf'), { recursive: true });
  writeFileSync(join(dir, '.macf', 'macf-agent.json'), '{}');
}

describe('findProjectRoot', () => {
  let base: string;

  beforeEach(() => { base = tempDir(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('returns cwd when .macf/macf-agent.json exists in cwd', () => {
    createMacfProject(base);
    expect(findProjectRoot(base)).toBe(base);
  });

  it('walks up one level', () => {
    createMacfProject(base);
    const sub = join(base, 'src');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBe(base);
  });

  it('walks up multiple levels', () => {
    createMacfProject(base);
    const deep = join(base, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });

    expect(findProjectRoot(deep)).toBe(base);
  });

  it('returns null when no project found walking up', () => {
    // A temp dir without any .macf/ above it (up to /tmp root).
    const sub = join(base, 'empty-subdir');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBeNull();
  });

  it('ignores bare .macf/ directory without macf-agent.json', () => {
    // e.g., a project that has .macf/logs/ but no macf-agent.json yet
    const bare = join(base, 'bare-project');
    mkdirSync(join(bare, '.macf', 'logs'), { recursive: true });
    const sub = join(bare, 'src');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBeNull();
  });

  it('returns closest ancestor when nested projects exist', () => {
    // Outer project at base, inner project at base/inner
    createMacfProject(base);
    const inner = join(base, 'inner');
    createMacfProject(inner);
    const deep = join(inner, 'src', 'lib');
    mkdirSync(deep, { recursive: true });

    // Should find the closer one, not the outer
    expect(findProjectRoot(deep)).toBe(inner);
  });

  it('resolves relative startDir', () => {
    createMacfProject(base);
    const sub = join(base, 'src');
    mkdirSync(sub, { recursive: true });

    // Relative paths also resolve correctly
    const relative = `${base}/./src`;
    const result = findProjectRoot(relative);
    expect(result).toBe(base);
  });
});
