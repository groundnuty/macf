/**
 * The workspace-discovery record + its pure helpers (DR-037 Decision 4).
 *
 * This is the shared substrate the fleet operational-layer subcommands consume:
 * `macf ps` (alive∪dead enumeration), `macf fleet upgrade` (group-by-PROJECT →
 * fleets — macf#710; a project owns its own CA + registry namespace, so it is
 * the correct grouping key, NOT the coarser `registry` scope), and the watchdog
 * (desired-set reconcile) all read the same primitive.
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
   * The registry this workspace belongs to, as a stable identifier — `owner/repo`
   * (repo scope), the org / profile-user name (org / profile scope), or `local`
   * (DR-024 local-registry mode). Derive via `registryIdentifier`.
   *
   * NOT the fleet-grouping key (macf#710) — a profile/org registry scope is the
   * NETWORK ENDPOINT (e.g. the `groundnuty/groundnuty` GitHub repo backing a
   * profile registry), which multiple DISTINCT projects can share. Each project
   * has its own registry NAMESPACE (`MACF_AGENT_*` vs `ICSOC_2026_AGENT_*`) and
   * its own CA (`MACF_CA_CERT` vs `ICSOC_2026_CA_CERT` — see
   * `createVmDriverFromConfig`'s `${toVariableSegment(config.project)}_CA_CERT`
   * lookup). Grouping by `registry` collapsed distinct projects sharing one
   * profile/org scope into a single fleet, so a driver built from one project's
   * workspace (its CA) was used to probe the other project's agents — wrong CA,
   * false-negative UNREACHABLE. See `project` below for the correct grouping key.
   */
  registry: z.string(),
  /**
   * The project this workspace belongs to (`.macf/macf-agent.json` `project`) —
   * its own CA + registry namespace + version cadence. THE fleet-grouping key
   * (macf#710, superseding the pre-#710 `registry`-based grouping): `fleet
   * upgrade` groups discovered workspaces by this field, so a `groundnuty`
   * profile-registry host running BOTH `macf` and `icsoc_2026` projects
   * discovers as TWO fleets, each rolled with a driver bound to that project's
   * own CA — no cross-project probe mismatch.
   */
  project: z.string(),
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
 * Render a `RegistryConfig` as its stable, human-legible identifier. Pure.
 *
 * - `repo`    → `owner/repo`
 * - `org`     → the org name
 * - `profile` → the profile user name (e.g. every `groundnuty` profile-registry
 *               workspace, REGARDLESS of which project it belongs to, renders
 *               the same identifier here — it names the shared NETWORK ENDPOINT,
 *               not a fleet)
 * - `local`   → `local` (DR-024)
 *
 * NOTE (macf#710): this identifier is NOT the fleet-grouping key — see
 * `WorkspaceRecord.project` for that. Prior to #710, `fleet upgrade` grouped by
 * this identifier (DR-037 Decision 1's original framing), which collapsed
 * distinct projects sharing one profile/org registry scope into a single fleet.
 * `registryIdentifier` remains useful for display + for resolving a genuinely
 * registry-scoped target (e.g. `fleet-resume`'s repo-scoped alert-repo lookup).
 *
 * Org and profile scopes collapse to a bare name; a theoretical `org foo` vs
 * `profile foo` collision is accepted for this heuristic (they are not both
 * used by one host in practice) and keeps the identifier human-legible.
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
