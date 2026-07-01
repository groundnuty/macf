/**
 * Tests for src/cli/discovery.ts — the VM-filesystem workspace scan
 * (DR-037 Decision 4). Offline + deterministic: every test drives the scan
 * through a SYNTHETIC `DiscoveryFs` seam (no real files), so the marker-scan,
 * depth-bounding, pruning, symlink-canonicalisation, and config-parse paths are
 * all exercised against an in-memory tree.
 */
import { describe, it, expect } from 'vitest';
import {
  discoverWorkspaces,
  parseWorkspace,
  resolveWorkspaceRoots,
  type DiscoveryFs,
} from '../../src/cli/discovery.js';

type Node = { readonly kind: 'dir' } | { readonly kind: 'file'; readonly content: string };

/**
 * Build a synthetic `DiscoveryFs` from a flat path→node map. Intermediate dirs
 * are auto-created. `symlinks` maps a path to its canonical target for realpath.
 */
function fakeFs(
  nodes: Record<string, Node>,
  symlinks: Record<string, string> = {},
): DiscoveryFs {
  const tree = new Map<string, Node>();
  const ensureDirs = (p: string): void => {
    const parts = p.split('/').filter((s) => s.length > 0);
    let cur = '';
    for (const part of parts.slice(0, -1)) {
      cur += '/' + part;
      if (!tree.has(cur)) tree.set(cur, { kind: 'dir' });
    }
  };
  for (const [p, n] of Object.entries(nodes)) {
    ensureDirs(p);
    tree.set(p, n);
  }
  return {
    exists: (p) => tree.has(p),
    isDir: (p) => tree.get(p)?.kind === 'dir',
    readDir: (p) => {
      const prefix = p === '/' ? '/' : p + '/';
      const children = new Set<string>();
      for (const key of tree.keys()) {
        if (!key.startsWith(prefix) || key === p) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (name) children.add(name);
      }
      return [...children];
    },
    readFile: (p) => {
      const n = tree.get(p);
      return n && n.kind === 'file' ? n.content : null;
    },
    realpath: (p) => symlinks[p] ?? p,
  };
}

const config = (agent: string, opts: Record<string, unknown> = {}): Node => ({
  kind: 'file',
  content: JSON.stringify({
    project: 'macf',
    agent_name: agent,
    agent_role: agent,
    agent_type: 'permanent',
    registry: { type: 'profile', user: 'groundnuty' },
    versions: { cli: '0.2.44', plugin: '0.2.44', actions: 'v3' },
    ...opts,
  }),
});

describe('parseWorkspace', () => {
  it('parses a workspace config into a canonical record', () => {
    const fs = fakeFs({ '/root/macf/.macf/macf-agent.json': config('code-agent') });
    const rec = parseWorkspace(fs, '/root/macf');
    expect(rec).toEqual({
      agent: 'code-agent',
      workspace: '/root/macf',
      registry: 'groundnuty',
      project: 'macf',
      versionPin: '0.2.44',
    });
  });

  it('carries a DIFFERENT project through even under the SAME profile registry (macf#710)', () => {
    // Two projects (macf substrate + icsoc_2026) sharing one `groundnuty`
    // profile registry must parse to DIFFERENT `project` values so `fleet
    // upgrade` can group them into two separate fleets, each with its own CA.
    const fs = fakeFs({
      '/root/icsoc/.macf/macf-agent.json': config('icsoc-agent', { project: 'icsoc_2026' }),
    });
    const rec = parseWorkspace(fs, '/root/icsoc');
    expect(rec).toEqual({
      agent: 'icsoc-agent',
      workspace: '/root/icsoc',
      registry: 'groundnuty', // SAME registry scope as the macf fixture above
      project: 'icsoc_2026', // DIFFERENT project/fleet
      versionPin: '0.2.44',
    });
  });

  it('prefers routing_label over agent_name (macf#545)', () => {
    const fs = fakeFs({
      '/root/dev/.macf/macf-agent.json': config('macf-devops-agent', {
        routing_label: 'devops-agent',
      }),
    });
    expect(parseWorkspace(fs, '/root/dev')!.agent).toBe('devops-agent');
  });

  it('versionPin is null when the config carries no versions block', () => {
    const fs = fakeFs({
      '/root/legacy/.macf/macf-agent.json': {
        kind: 'file',
        content: JSON.stringify({
          project: 'macf',
          agent_name: 'x',
          agent_role: 'x',
          agent_type: 'permanent',
          registry: { type: 'profile', user: 'groundnuty' },
        }),
      },
    });
    expect(parseWorkspace(fs, '/root/legacy')!.versionPin).toBeNull();
  });

  it('canonicalises the workspace path via realpath (symlinked repo root)', () => {
    const fs = fakeFs(
      { '/home/u/repos/groundnuty/macf/.macf/macf-agent.json': config('code-agent') },
      { '/home/u/repos/groundnuty/macf': '/canon/groundnuty/macf' },
    );
    expect(parseWorkspace(fs, '/home/u/repos/groundnuty/macf')!.workspace).toBe(
      '/canon/groundnuty/macf',
    );
  });

  it('returns null on missing / unparseable / schema-invalid config', () => {
    expect(parseWorkspace(fakeFs({}), '/nope')).toBeNull();
    const bad = fakeFs({ '/w/.macf/macf-agent.json': { kind: 'file', content: '{not json' } });
    expect(parseWorkspace(bad, '/w')).toBeNull();
    const invalid = fakeFs({
      '/w/.macf/macf-agent.json': { kind: 'file', content: JSON.stringify({ project: 'x' }) },
    });
    expect(parseWorkspace(invalid, '/w')).toBeNull();
  });
});

describe('discoverWorkspaces (marker scan)', () => {
  it('finds workspaces one and two levels under a root', () => {
    const fs = fakeFs({
      '/repos/macf/.macf/macf-agent.json': config('code-agent'),
      '/repos/groundnuty/science/.macf/macf-agent.json': config('science-agent'),
      '/repos/unrelated/README.md': { kind: 'file', content: '# hi' },
    });
    const recs = discoverWorkspaces({ roots: ['/repos'], fs });
    expect(recs.map((r) => r.agent).sort()).toEqual(['code-agent', 'science-agent']);
  });

  it('stops descending once a marker is found (worktrees under a workspace ignored)', () => {
    const fs = fakeFs({
      '/repos/macf/.macf/macf-agent.json': config('code-agent'),
      // A worktree that (hypothetically) also had a marker must NOT be surfaced —
      // the scan does not descend into a workspace, and .claude is pruned anyway.
      '/repos/macf/.claude/worktrees/wt/.macf/macf-agent.json': config('ghost'),
    });
    const recs = discoverWorkspaces({ roots: ['/repos'], fs });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.agent).toBe('code-agent');
  });

  it('prunes node_modules / dist / .git and respects maxDepth', () => {
    const fs = fakeFs({
      '/repos/node_modules/pkg/.macf/macf-agent.json': config('nope'),
      '/repos/a/b/c/d/e/deep/.macf/macf-agent.json': config('too-deep'),
      '/repos/a/shallow/.macf/macf-agent.json': config('ok'),
    });
    const recs = discoverWorkspaces({ roots: ['/repos'], fs, maxDepth: 3 });
    expect(recs.map((r) => r.agent)).toEqual(['ok']);
  });

  it('dedupes a workspace discovered under two overlapping roots', () => {
    const fs = fakeFs({ '/repos/groundnuty/macf/.macf/macf-agent.json': config('code-agent') });
    const recs = discoverWorkspaces({
      roots: ['/repos', '/repos/groundnuty'],
      fs,
    });
    expect(recs).toHaveLength(1);
  });

  it('finds a root that is itself a workspace', () => {
    const fs = fakeFs({ '/repos/macf/.macf/macf-agent.json': config('code-agent') });
    expect(discoverWorkspaces({ roots: ['/repos/macf'], fs })).toHaveLength(1);
  });
});

describe('resolveWorkspaceRoots', () => {
  it('uses MACF_WORKSPACE_ROOT (colon-separated) when set', () => {
    expect(resolveWorkspaceRoots('/a:/b', '/somewhere')).toEqual(['/a', '/b']);
  });

  it('falls back to a default set when the env is unset', () => {
    // No MACF project above a random tmp cwd → default is just [$HOME/repos].
    const roots = resolveWorkspaceRoots(undefined, '/definitely/not/a/macf/project/root');
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.some((r) => r.endsWith('/repos'))).toBe(true);
  });
});
