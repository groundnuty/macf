/**
 * `discoverWorkspaces()` — the VM-filesystem workspace scan (DR-037 Decision 4).
 *
 * The host-operational plane's SOURCE: enumerate the agent workspaces that live
 * on THIS box by scanning for the `.macf/` marker under configured root(s),
 * registry-FREE (no repo, no network). It is the eventual `FleetDriver`'s
 * `discoverWorkspaces` method — VM-filesystem-specific, so it lives here in
 * `packages/macf` while the pure record shape + helpers live in macf-core.
 *
 * MARKER-scan is primary: it reveals DEAD agents (a stopped agent has a `.macf/`
 * workspace but no running process). `macf ps` unions the discovered workspaces
 * with the running-process scan to mark each alive/dead. The workspace path is
 * REALPATH-canonicalised so it matches a running process's
 * `readlink /proc/<pid>/cwd` even across a symlinked repo root.
 *
 * All filesystem access goes through an injectable `DiscoveryFs` seam so the
 * scan is unit-testable with a synthetic tree — no real files, no real fs.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  dedupeWorkspaces,
  registryIdentifier,
  splitWorkspaceRoots,
  type WorkspaceRecord,
} from '@groundnuty/macf-core';
import { MacfAgentConfigSchema, findProjectRoot } from './config.js';

/** The `.macf/macf-agent.json` marker that identifies a MACF agent workspace. */
const MARKER_REL = join('.macf', 'macf-agent.json');

/**
 * Directory names never descended into during the scan — build/VCS/editor noise
 * plus `.claude` (worktrees + plugin copies live under it and are NOT their own
 * agent workspaces). Any dotfile dir is skipped too (see `collectWorkspaceDirs`).
 */
const PRUNE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  '.claude',
  '.worktrees',
]);

/**
 * Default recursion depth under each root. Roots are typically a repos parent
 * (`$HOME/repos` → `owner/` → `project/`), so a small bound reaches real
 * workspaces without a full-FS walk (DR-037 Decision 4: "Bound to the configured
 * roots — NOT a full-FS walk"). Descent also stops at any marker (a workspace is
 * a leaf) and at pruned dirs, so the effective cost is far below the raw bound.
 */
const DEFAULT_MAX_DEPTH = 4;

/**
 * Injectable filesystem seam. The default reads the real fs; tests pass a
 * synthetic one. `readDir` / `readFile` swallow errors so an unreadable dir /
 * file degrades to "nothing here", never a throw. `realpath` returns the input
 * unchanged on failure so a broken symlink still yields a usable (if
 * non-canonical) path.
 */
export interface DiscoveryFs {
  readonly exists: (p: string) => boolean;
  readonly isDir: (p: string) => boolean;
  readonly readDir: (p: string) => readonly string[];
  readonly readFile: (p: string) => string | null;
  readonly realpath: (p: string) => string;
}

/** The real filesystem seam. Every accessor degrades to a safe value on error. */
export const defaultDiscoveryFs: DiscoveryFs = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
};

/** Options for `discoverWorkspaces`. All optional; the defaults are canonical. */
export interface DiscoverOptions {
  /**
   * Explicit roots to scan. When omitted, resolved from `MACF_WORKSPACE_ROOT`
   * (colon-separated) or the sensible default (see `resolveWorkspaceRoots`).
   */
  readonly roots?: readonly string[];
  /** Value of `MACF_WORKSPACE_ROOT` (defaults to `process.env`). */
  readonly env?: string | undefined;
  /** cwd used to derive the parent-of-current-workspace default root. */
  readonly cwd?: string;
  /** Max recursion depth under each root (default `DEFAULT_MAX_DEPTH`). */
  readonly maxDepth?: number;
  /** Filesystem seam (default: the real fs). */
  readonly fs?: DiscoveryFs;
}

/**
 * Resolve the roots to scan. Pure w.r.t. its inputs (`findProjectRoot` reads the
 * fs only to derive the default). Precedence:
 *   1. `MACF_WORKSPACE_ROOT` (colon-separated) if set.
 *   2. Sensible default: the PARENT of the current MACF project root (so sibling
 *      workspaces are found) PLUS `$HOME/repos` (the common convention).
 * Overlaps are harmless — discovered records dedupe by canonical path.
 */
export function resolveWorkspaceRoots(
  env: string | undefined,
  cwd: string,
): readonly string[] {
  const fromEnv = splitWorkspaceRoots(env);
  if (fromEnv.length > 0) return fromEnv.map((r) => resolve(r));

  const roots: string[] = [];
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) roots.push(dirname(projectRoot));
  roots.push(join(homedir(), 'repos'));
  // De-dup exact repeats (parent-of-project could equal $HOME/repos).
  return [...new Set(roots)];
}

/**
 * Recursively collect workspace directories (those containing the `.macf/`
 * marker) under `dir`. Stops descending at a marker (a workspace is a leaf),
 * at `maxDepth`, at pruned dirs, and at any dotfile dir.
 */
function collectWorkspaceDirs(
  fs: DiscoveryFs,
  dir: string,
  depth: number,
  maxDepth: number,
  out: string[],
): void {
  if (fs.exists(join(dir, MARKER_REL))) {
    out.push(dir);
    return; // a workspace is a leaf — never descend into it
  }
  if (depth >= maxDepth) return;
  for (const name of fs.readDir(dir)) {
    if (name.startsWith('.') || PRUNE_DIRS.has(name)) continue;
    const child = join(dir, name);
    if (!fs.isDir(child)) continue;
    collectWorkspaceDirs(fs, child, depth + 1, maxDepth, out);
  }
}

/**
 * Parse a workspace dir's `.macf/macf-agent.json` into a `WorkspaceRecord`.
 * Returns null (quietly) on missing / unparseable / schema-invalid config — a
 * bad workspace is skipped, never fatal. The workspace path is realpath-
 * canonicalised so it matches a running process's cwd across symlinks.
 */
export function parseWorkspace(fs: DiscoveryFs, wsDir: string): WorkspaceRecord | null {
  const raw = fs.readFile(join(wsDir, MARKER_REL));
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = MacfAgentConfigSchema.safeParse(json);
  if (!parsed.success) return null;
  const cfg = parsed.data;
  return {
    // Routing label is the registry key (macf#545): `routing_label` when set,
    // else `agent_name`.
    agent: cfg.routing_label ?? cfg.agent_name,
    workspace: fs.realpath(wsDir),
    registry: registryIdentifier(cfg.registry),
    // The fleet-grouping key (macf#710) — see `WorkspaceRecord.project`. Always
    // present: `MacfAgentConfigSchema.project` is a required field.
    project: cfg.project,
    versionPin: cfg.versions?.cli ?? null,
  };
}

/**
 * Discover every MACF agent workspace on this host (DR-037 Decision 4). Scans
 * the configured roots for the `.macf/` marker, parses each workspace's config,
 * and returns canonical, deduped records. Registry-free + network-free.
 */
export function discoverWorkspaces(opts: DiscoverOptions = {}): readonly WorkspaceRecord[] {
  const fs = opts.fs ?? defaultDiscoveryFs;
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env['MACF_WORKSPACE_ROOT'];
  const roots = opts.roots ?? resolveWorkspaceRoots(env, cwd);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const dirs: string[] = [];
  for (const root of roots) {
    collectWorkspaceDirs(fs, resolve(root), 0, maxDepth, dirs);
  }

  const records: WorkspaceRecord[] = [];
  for (const d of dirs) {
    const rec = parseWorkspace(fs, d);
    if (rec) records.push(rec);
  }
  return dedupeWorkspaces(records);
}
