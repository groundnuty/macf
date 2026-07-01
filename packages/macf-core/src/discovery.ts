/**
 * The workspace-discovery record + its pure helpers (DR-037 Decision 4).
 *
 * This is the shared substrate the fleet operational-layer subcommands consume:
 * `macf ps` (alive∪dead enumeration), `macf fleet upgrade` (group-by-registry →
 * fleets), and the watchdog (desired-set reconcile) all read the same primitive.
 *
 * The record shape + the RUNTIME-and-CLI-independent helpers live HERE in
 * macf-core (DR-037 OQ2 — pure/portable logic in macf-core); the VM-filesystem
 * scan that PRODUCES the records is `discoverWorkspaces()` in `packages/macf`
 * (it's `/proc`- and FS-topology-specific, so it stays driver-side).
 *
 * The host-operational plane is registry-FREE (DR-037 Decision 1/4): records are
 * sourced by scanning the filesystem for the `.macf/` marker, NOT by querying any
 * registry. This is a search-path *discovery*, not a fourth drift-prone source of
 * truth (`check-before-propose §4`).
 */
import { z } from 'zod';
import type { RegistryConfig } from './registry/types.js';

/**
 * One discovered agent workspace on a host — the unit of the host-operational
 * plane. Registry-free; produced by the `.macf/`-marker filesystem scan.
 */
export const WorkspaceRecordSchema = z.object({
  /** The agent's ROUTING label (registry key), e.g. `code-agent` (macf#545). */
  agent: z.string(),
  /**
   * Absolute, symlink-CANONICAL path to the workspace directory (the dir that
   * contains `.macf/`). Canonical so it can be matched against a running
   * process's `readlink /proc/<pid>/cwd` even across a symlinked repo root.
   */
  workspace: z.string(),
  /**
   * The registry this workspace belongs to, as a stable GROUPING identifier —
   * `owner/repo` (repo scope), the org / profile-user name (org / profile
   * scope), or `local` (DR-024 local-registry mode). A "fleet" == a registry,
   * so `fleet upgrade` groups by this field. Derive via `registryIdentifier`.
   */
  registry: z.string(),
  /**
   * The workspace's pinned framework version (`.macf/macf-agent.json`
   * `versions.cli`), or `null` when the config carries no pin (legacy / pre-P6).
   * This is the ON-DISK pin — legible with NO process running, so a DEAD agent
   * still reports a version (DR-037 Decision 5, the pinned-vs-running split).
   */
  versionPin: z.string().nullable(),
});

export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/**
 * Render a `RegistryConfig` as its stable fleet-grouping identifier (a "fleet"
 * == a registry — DR-037 Decision 1). Pure.
 *
 * - `repo`    → `owner/repo`
 * - `org`     → the org name
 * - `profile` → the profile user name (the substrate case: every `groundnuty`
 *               profile-registry workspace groups into one fleet)
 * - `local`   → `local` (DR-024)
 *
 * Org and profile scopes collapse to a bare name; a theoretical `org foo` vs
 * `profile foo` collision is accepted for this grouping heuristic (they are not
 * both used by one host in practice) and keeps the identifier human-legible.
 */
export function registryIdentifier(config: RegistryConfig): string {
  switch (config.type) {
    case 'repo':
      return `${config.owner}/${config.repo}`;
    case 'org':
      return config.org;
    case 'profile':
      return config.user;
    case 'local':
      return 'local';
  }
}

/**
 * Split a `MACF_WORKSPACE_ROOT` env value into individual root paths. Pure.
 * Colon-separated (PATH-style), trimmed, empties dropped. An unset / empty
 * value yields `[]` so the caller can fall back to its sensible default.
 */
export function splitWorkspaceRoots(envValue: string | undefined | null): readonly string[] {
  if (!envValue) return [];
  return envValue
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * De-duplicate workspace records by their canonical `workspace` path, keeping
 * first occurrence. Pure. Overlapping discovery roots (e.g. `$HOME/repos` and
 * the parent-of-the-current-workspace) surface the same workspace twice; the
 * records carry canonical paths so string-equality dedup is exact.
 */
export function dedupeWorkspaces(
  records: readonly WorkspaceRecord[],
): readonly WorkspaceRecord[] {
  const seen = new Set<string>();
  const out: WorkspaceRecord[] = [];
  for (const r of records) {
    if (seen.has(r.workspace)) continue;
    seen.add(r.workspace);
    out.push(r);
  }
  return out;
}
