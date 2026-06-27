/**
 * Marketplace plugin sync — keep the canonical agent plugin
 * (`packages/macf/plugin/`) and the distributed marketplace copy
 * (`groundnuty/macf-marketplace:macf-agent/`) byte-identical across the
 * synced subdirs, so the two trees can't silently drift (groundnuty/macf#605).
 *
 * Background: `macf init` / `macf update` distribute the plugin to consumers by
 * shallow-cloning the marketplace `macf-agent/` subdir (see `plugin-fetcher.ts`),
 * NOT by copying from this monorepo. The marketplace tree therefore has to be
 * re-synced from canonical at release time, or it drifts — it did: the
 * marketplace `hooks/hooks.json` was a stale v0.2.0-era fork missing the #571
 * turn-state hooks and the whole `scripts/` dir, leaving `/health.state` dark on
 * consumers.
 *
 * Synced subdirs (`PLUGIN_SYNC_SUBDIRS`): agents, hooks, scripts, skills.
 * EXCLUDED: `rules/` (ships via the npm CLI `files: ["plugin/rules/"]`),
 * `README.md`, and `.claude-plugin/` (the marketplace manifest, managed
 * separately).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Subdirs mirrored from the canonical `plugin/` to the marketplace
 * `macf-agent/`. `rules/`, `README.md`, and `.claude-plugin/` are intentionally
 * NOT synced (see file header).
 */
export const PLUGIN_SYNC_SUBDIRS = ['agents', 'hooks', 'scripts', 'skills'] as const;

export interface CheckPluginSyncResult {
  /** True iff every synced subdir is byte-identical between the two trees. */
  readonly inSync: boolean;
  /** Relative paths that are missing-in-target, extra-in-target, or differing. */
  readonly mismatches: string[];
}

export interface SyncPluginResult {
  /** Relative paths copied/overwritten into the target. */
  readonly written: string[];
  /** Relative paths removed from the target (stale, not in canonical). */
  readonly removed: string[];
}

/**
 * Recursively list file paths under `dir`, relative to `dir`.
 * Returns `[]` when `dir` is absent (a missing subdir is tolerated, not thrown).
 */
function listFilesRel(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(dir, abs));
    }
  };
  walk(dir);
  return out;
}

/** Byte-equal comparison of two files. */
function filesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Compare the canonical plugin's synced subdirs against the marketplace
 * `macf-agent/` copy. Reports file-set differences (missing / extra) and
 * byte-content differences. A missing subdir on either side is tolerated —
 * its files simply surface as missing-in / extra-in mismatches.
 */
export function checkPluginSync(
  canonicalPluginDir: string,
  targetMacfAgentDir: string,
): CheckPluginSyncResult {
  const mismatches: string[] = [];
  for (const subdir of PLUGIN_SYNC_SUBDIRS) {
    const srcDir = join(canonicalPluginDir, subdir);
    const dstDir = join(targetMacfAgentDir, subdir);
    const srcFiles = listFilesRel(srcDir);
    const dstFiles = new Set(listFilesRel(dstDir));
    for (const rel of srcFiles) {
      const labelled = join(subdir, rel);
      if (!dstFiles.has(rel)) mismatches.push(`${labelled} (missing in target)`);
      else if (!filesEqual(join(srcDir, rel), join(dstDir, rel))) {
        mismatches.push(`${labelled} (content differs)`);
      }
    }
    const srcSet = new Set(srcFiles);
    for (const rel of dstFiles) {
      if (!srcSet.has(rel)) mismatches.push(`${join(subdir, rel)} (extra in target)`);
    }
  }
  mismatches.sort();
  return { inSync: mismatches.length === 0, mismatches };
}

/**
 * Make the marketplace `macf-agent/` copy byte-identical to the canonical
 * plugin across `PLUGIN_SYNC_SUBDIRS`: copy/overwrite canonical files
 * (preserving mode — hook scripts are executable) and remove target files in
 * those subdirs that are not in canonical. Never touches `.claude-plugin/`,
 * `README.md`, or anything outside the synced subdirs.
 */
export function syncPluginToMarketplace(
  canonicalPluginDir: string,
  targetMacfAgentDir: string,
): SyncPluginResult {
  const written: string[] = [];
  const removed: string[] = [];
  for (const subdir of PLUGIN_SYNC_SUBDIRS) {
    const srcDir = join(canonicalPluginDir, subdir);
    const dstDir = join(targetMacfAgentDir, subdir);
    const srcFiles = listFilesRel(srcDir);
    const dstFiles = listFilesRel(dstDir);
    for (const rel of srcFiles) {
      const srcPath = join(srcDir, rel);
      const dstPath = join(dstDir, rel);
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
      chmodSync(dstPath, statSync(srcPath).mode);
      written.push(join(subdir, rel));
    }
    const srcSet = new Set(srcFiles);
    for (const rel of dstFiles) {
      if (!srcSet.has(rel)) {
        rmSync(join(dstDir, rel), { force: true });
        removed.push(join(subdir, rel));
      }
    }
  }
  written.sort();
  removed.sort();
  return { written, removed };
}
