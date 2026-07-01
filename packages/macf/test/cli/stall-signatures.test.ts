/**
 * Tests for the stall-signature config distribution seam (DR-037, macf#686):
 * seed-if-absent, validate-if-present, never-clobber. The SCHEMA + matcher live
 * in @groundnuty/macf-core (tested there); this covers only the fs behaviour +
 * the workspace loader `macf fleet resume` reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStallSignatures } from '@groundnuty/macf-core';
import {
  seedStallSignaturesConfig,
  loadStallSignaturesFromWorkspace,
  workspaceStallSignaturesPath,
  STALL_SIGNATURES_FILENAME,
} from '../../src/cli/stall-signatures.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'macf-stall-signatures-'));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('workspaceStallSignaturesPath', () => {
  it('resolves to .claude/.macf/stall-signatures.json', () => {
    expect(workspaceStallSignaturesPath(workspace)).toBe(
      join(workspace, '.claude', '.macf', STALL_SIGNATURES_FILENAME),
    );
  });
});

describe('seedStallSignaturesConfig — absent', () => {
  it('writes the canonical seed (the 5 reference signatures) and creates .claude/.macf/', () => {
    const result = seedStallSignaturesConfig(workspace);
    expect(result.action).toBe('seeded');
    const path = workspaceStallSignaturesPath(workspace);
    expect(existsSync(path)).toBe(true);

    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const entries = loadStallSignatures(raw);
    expect(entries.map((e) => e.name)).toEqual([
      'rate-limit', 'turn-aborted', 'permission-prompt', 'trust-folder-prompt', 'skill-or-memory-prompt',
    ]);
  });
});

describe('seedStallSignaturesConfig — present (never clobber)', () => {
  it('preserves an existing operator-edited file, only validating it', () => {
    const path = workspaceStallSignaturesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    const operatorConfig = JSON.stringify([
      { name: 'my-stall', signature: 'my custom marker', action: 'nudge', nudge: 'go' },
    ]);
    writeFileSync(path, operatorConfig);

    const result = seedStallSignaturesConfig(workspace);
    expect(result.action).toBe('preserved');
    if (result.action === 'preserved') expect(result.count).toBe(1);
    // Byte-for-byte preserved.
    expect(readFileSync(path, 'utf-8')).toBe(operatorConfig);
  });

  it('surfaces an invalid file without throwing (update must not break)', () => {
    const path = workspaceStallSignaturesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(path, '{ not valid json');
    const result = seedStallSignaturesConfig(workspace);
    expect(result.action).toBe('invalid');
  });

  it('flags an uncompilable-regex entry as invalid', () => {
    const path = workspaceStallSignaturesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(path, JSON.stringify([{ name: 'bad', signature: '(' }]));
    const result = seedStallSignaturesConfig(workspace);
    expect(result.action).toBe('invalid');
  });
});

describe('loadStallSignaturesFromWorkspace', () => {
  it('returns null when the file is absent (caller falls back to the seed)', () => {
    expect(loadStallSignaturesFromWorkspace(workspace)).toBeNull();
  });

  it('loads + returns the entries when present', () => {
    seedStallSignaturesConfig(workspace);
    const entries = loadStallSignaturesFromWorkspace(workspace);
    expect(entries?.map((e) => e.name)).toContain('rate-limit');
  });

  it('throws (fail-loud) on a present-but-invalid file', () => {
    const path = workspaceStallSignaturesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(path, JSON.stringify([{ name: 'bad', signature: '(' }]));
    expect(() => loadStallSignaturesFromWorkspace(workspace)).toThrow();
  });
});
