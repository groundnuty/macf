/**
 * Tests for src/discovery.ts — the pure workspace-discovery record + helpers
 * (DR-037 Decision 4). Pure/portable logic lives here in macf-core; the
 * filesystem scan that produces the records is tested in the `macf` package.
 */
import { describe, it, expect } from 'vitest';
import {
  WorkspaceRecordSchema,
  registryIdentifier,
  splitWorkspaceRoots,
  dedupeWorkspaces,
  type WorkspaceRecord,
} from '../src/discovery.js';
import type { RegistryConfig } from '../src/registry/types.js';

describe('WorkspaceRecordSchema', () => {
  it('accepts a well-formed record (versionPin may be null)', () => {
    const ok = WorkspaceRecordSchema.safeParse({
      agent: 'code-agent',
      workspace: '/canon/macf',
      registry: 'groundnuty',
      versionPin: '0.2.44',
    });
    expect(ok.success).toBe(true);
    const okNull = WorkspaceRecordSchema.safeParse({
      agent: 'code-agent',
      workspace: '/canon/macf',
      registry: 'local',
      versionPin: null,
    });
    expect(okNull.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    expect(
      WorkspaceRecordSchema.safeParse({ agent: 'x', workspace: '/w', registry: 'r' }).success,
    ).toBe(false);
  });
});

describe('registryIdentifier', () => {
  it('renders repo scope as owner/repo', () => {
    const cfg: RegistryConfig = { type: 'repo', owner: 'groundnuty', repo: 'macf' };
    expect(registryIdentifier(cfg)).toBe('groundnuty/macf');
  });

  it('renders profile scope as the user (the substrate grouping)', () => {
    const cfg: RegistryConfig = { type: 'profile', user: 'groundnuty' };
    expect(registryIdentifier(cfg)).toBe('groundnuty');
  });

  it('renders org scope as the org name', () => {
    const cfg: RegistryConfig = { type: 'org', org: 'acme' };
    expect(registryIdentifier(cfg)).toBe('acme');
  });

  it('renders local scope as the literal "local" (DR-024)', () => {
    const cfg: RegistryConfig = { type: 'local', path: '/home/u/.macf/registry/macf.json' };
    expect(registryIdentifier(cfg)).toBe('local');
  });
});

describe('splitWorkspaceRoots', () => {
  it('splits a colon-separated value, trimming + dropping empties', () => {
    expect(splitWorkspaceRoots('/a:/b/c: /d ')).toEqual(['/a', '/b/c', '/d']);
  });

  it('returns [] for unset / empty', () => {
    expect(splitWorkspaceRoots(undefined)).toEqual([]);
    expect(splitWorkspaceRoots('')).toEqual([]);
    expect(splitWorkspaceRoots(':: ::')).toEqual([]);
  });
});

describe('dedupeWorkspaces', () => {
  it('keeps the first record per canonical workspace path', () => {
    const recs: WorkspaceRecord[] = [
      { agent: 'a', workspace: '/canon/x', registry: 'r', versionPin: '1.0.0' },
      { agent: 'a-dup', workspace: '/canon/x', registry: 'r', versionPin: '9.9.9' },
      { agent: 'b', workspace: '/canon/y', registry: 'r', versionPin: null },
    ];
    const out = dedupeWorkspaces(recs);
    expect(out).toHaveLength(2);
    expect(out[0]!.agent).toBe('a'); // first wins
    expect(out.map((r) => r.workspace)).toEqual(['/canon/x', '/canon/y']);
  });
});
