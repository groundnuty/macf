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
      project: 'macf',
      versionPin: '0.2.44',
    });
    expect(ok.success).toBe(true);
    const okNull = WorkspaceRecordSchema.safeParse({
      agent: 'code-agent',
      workspace: '/canon/macf',
      registry: 'local',
      project: 'macf',
      versionPin: null,
    });
    expect(okNull.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    expect(
      WorkspaceRecordSchema.safeParse({ agent: 'x', workspace: '/w', registry: 'r' }).success,
    ).toBe(false);
    expect(
      WorkspaceRecordSchema.safeParse({
        agent: 'x',
        workspace: '/w',
        registry: 'r',
        versionPin: null,
      }).success,
    ).toBe(false); // missing `project` (macf#710 — the fleet-grouping key)
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
      { agent: 'a', workspace: '/canon/x', registry: 'r', project: 'p', versionPin: '1.0.0' },
      { agent: 'a-dup', workspace: '/canon/x', registry: 'r', project: 'p', versionPin: '9.9.9' },
      { agent: 'b', workspace: '/canon/y', registry: 'r', project: 'p', versionPin: null },
    ];
    const out = dedupeWorkspaces(recs);
    expect(out).toHaveLength(2);
    expect(out[0]!.agent).toBe('a'); // first wins
    expect(out.map((r) => r.workspace)).toEqual(['/canon/x', '/canon/y']);
  });
});

describe('WorkspaceRecord.project vs registry (macf#710)', () => {
  it('two distinct projects sharing one profile registry render the SAME registry identifier but DIFFERENT project identifiers', () => {
    // The exact substrate shape #710 is about: a `groundnuty` profile registry
    // hosting both the `macf` substrate project and an `icsoc_2026` project.
    // `registryIdentifier` collapses both to `groundnuty` (by design — it names
    // the shared network endpoint, not a fleet); `project` distinguishes them,
    // which is why `fleet upgrade` MUST group by `project`, not `registry`.
    const macfWs: WorkspaceRecord = {
      agent: 'code-agent',
      workspace: '/w/macf',
      registry: 'groundnuty',
      project: 'macf',
      versionPin: '0.2.44',
    };
    const icsocWs: WorkspaceRecord = {
      agent: 'icsoc-agent',
      workspace: '/w/icsoc',
      registry: 'groundnuty',
      project: 'icsoc_2026',
      versionPin: '0.2.44',
    };
    expect(macfWs.registry).toBe(icsocWs.registry); // same registry scope
    expect(macfWs.project).not.toBe(icsocWs.project); // different projects/fleets
  });
});
