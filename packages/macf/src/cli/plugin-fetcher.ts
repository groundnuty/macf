/**
 * Fetch the macf-agent plugin from groundnuty/macf-marketplace at a pinned
 * version and place it at <workspace>/.macf/plugin/.
 *
 * Per DR-013, each workspace gets its own copy of the plugin at a specific
 * version; claude.sh invokes `claude --plugin-dir <workspace>/.macf/plugin`
 * so each agent runs an independent, pinnable plugin. No user-scope install,
 * no cross-project contamination.
 *
 * Mechanism: shallow git clone at the tag, copy the `macf-agent/` subdir
 * into place, remove the clone. Uses `execFileSync` (no shell — safe against
 * injection since args are list form) and `cpSync({recursive: true})` for
 * the copy.
 *
 * Network failures during fetch surface as a thrown Error; callers decide
 * whether to abort setup or warn-and-continue.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from './rules.js';

const DEFAULT_MARKETPLACE_URL = 'https://github.com/groundnuty/macf-marketplace';
const DEFAULT_PLUGIN_SUBDIR = 'macf-agent';

/** The channel-server npm package the plugin's mcpServers launches via npx. */
const CHANNEL_SERVER_PKG = '@groundnuty/macf-channel-server';

/**
 * Plugin-CLI path the `/macf-*` skills invoke, relative to CLAUDE_PLUGIN_ROOT
 * (= the workspace's `.macf/plugin/`). The skills run
 * `node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" …`, so the
 * marketplace plugin (which ships no `dist/`) needs a `dist/` link delivered.
 */
const PLUGIN_CLI_REL = join('plugin', 'bin', 'macf-plugin-cli.js');

export interface FetchPluginOptions {
  /** Override the marketplace git URL (for testing). */
  readonly marketplaceUrl?: string;
  /** Override the subdir inside the marketplace repo (for testing). */
  readonly pluginSubdir?: string;
  /**
   * Write to this absolute path instead of `workspacePluginDir(workspaceDir)`
   * (macf#889) — the caller (`macf update`) resolves the dir `claude.sh`
   * actually MOUNTS via `resolvePluginUpdateTarget` and passes it here so a
   * workspace mounting the `.macf/plugin-cs` variant (DR-005 Decision 6)
   * gets THAT manifest refreshed, not the unmounted `.macf/plugin` default.
   */
  readonly targetDir?: string;
}

/**
 * Path to the target plugin directory inside a workspace.
 */
export function workspacePluginDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.macf', 'plugin');
}

/** The shape of `plugin.json`'s `mcpServers` block this module reads/writes. */
type McpServersManifest = {
  mcpServers?: Record<string, { command?: string; args?: string[] } | undefined>;
};

/**
 * Best-effort read of a plugin dir's `.claude-plugin/plugin.json`. Returns
 * `null` on any absence/parse failure — shared by `pinChannelServerVersion`
 * (write) and `readPinnedChannelServerVersion` (read-back, macf#889) so both
 * agree on what counts as "nothing there to touch."
 */
function readManifest(pluginDir: string): McpServersManifest | null {
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as McpServersManifest;
  } catch {
    return null;
  }
}

export interface PinChannelServerVersionOptions {
  /** Read/write this absolute plugin dir instead of `workspacePluginDir(workspaceDir)` (macf#889). */
  readonly targetDir?: string;
}

/**
 * Pin the channel-server version in the workspace plugin's `mcpServers` args
 * (groundnuty/macf#421).
 *
 * The marketplace plugin ships `args: ["-y", "@groundnuty/macf-channel-server"]`
 * — a BARE npx spec. `npx -y <pkg>` reuses whatever is already in the npx cache
 * (it does NOT re-resolve to latest on a cache hit), so a consumer that ran the
 * channel-server before a version bump keeps serving its stale cached cs even
 * after `macf update` advances the pins — a silent floating-version skew (sister
 * to the no-floating-tags-in-CI directive). Rewrite the bare spec to
 * `@groundnuty/macf-channel-server@<version>` so each launch resolves the exact
 * version the resolved version-set implies.
 *
 * `version` is the channel-server version — the same as the resolved CLI
 * version (cs is published from the monorepo in lockstep with `@groundnuty/macf`),
 * NOT the marketplace plugin tag (which can lag — e.g. plugin v0.2.33 while cs
 * was 0.2.34). Call this AFTER fetchPluginToWorkspace.
 *
 * Idempotent + graceful: re-pins an already-pinned spec to the new version, and
 * no-ops cleanly when the plugin.json is absent, has no `mcpServers`, uses a
 * non-npx command (the legacy `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js` form
 * needs no pin), or carries no channel-server arg. Returns true iff it rewrote.
 */
export function pinChannelServerVersion(
  workspaceDir: string,
  version: string,
  options: PinChannelServerVersionOptions = {},
): boolean {
  const pluginDir = options.targetDir ?? workspacePluginDir(workspaceDir);
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  const manifest = readManifest(pluginDir);
  if (manifest === null) return false;

  const servers = manifest.mcpServers;
  if (!servers || typeof servers !== 'object') return false;

  let changed = false;
  for (const server of Object.values(servers)) {
    // Only the npx-launched form carries an npm spec to pin; the legacy
    // `node dist/server.js` form has no version to drift (AC: no regression).
    if (!server || server.command !== 'npx' || !Array.isArray(server.args)) continue;
    server.args = server.args.map((arg) => {
      if (arg === CHANNEL_SERVER_PKG || arg.startsWith(`${CHANNEL_SERVER_PKG}@`)) {
        const pinned = `${CHANNEL_SERVER_PKG}@${version}`;
        if (arg !== pinned) changed = true;
        return pinned;
      }
      return arg;
    });
  }

  if (changed) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return changed;
}

/**
 * Read back the channel-server version currently pinned in `pluginDir`'s
 * manifest — the read-back half of `pinChannelServerVersion`'s write, used as
 * `macf update`'s post-upgrade result-invariant assertion (macf#889 Pattern
 * A): "the upgrade wrote a file" is not "the write reached the thing being
 * upgraded," which was macf#889's entire failure shape.
 *
 * Returns `null` when there's nothing to compare — manifest absent/malformed,
 * no `mcpServers`, the legacy non-npx form, or no channel-server arg at all.
 * "Nothing to verify" is deliberately NOT a mismatch; callers only flag a
 * problem when a real pin was found and it disagrees with the target.
 */
export function readPinnedChannelServerVersion(pluginDir: string): string | null {
  const manifest = readManifest(pluginDir);
  if (manifest === null) return null;
  const servers = manifest.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  for (const server of Object.values(servers)) {
    if (!server || server.command !== 'npx' || !Array.isArray(server.args)) continue;
    for (const arg of server.args) {
      if (arg.startsWith(`${CHANNEL_SERVER_PKG}@`)) return arg.slice(CHANNEL_SERVER_PKG.length + 1);
    }
  }
  return null;
}

/**
 * Clone macf-marketplace at `v<version>`, extract the plugin subdir to
 * `<workspace>/.macf/plugin/`. Idempotent: an existing plugin dir is
 * removed before the new one is written, so re-running gives a clean
 * replacement (no stale files from a previous version hanging around).
 *
 * Throws if the git clone fails (network down, tag missing, etc.).
 */
export function fetchPluginToWorkspace(
  workspaceDir: string,
  version: string,
  options: FetchPluginOptions = {},
): void {
  const marketplaceUrl = options.marketplaceUrl ?? DEFAULT_MARKETPLACE_URL;
  const pluginSubdir = options.pluginSubdir ?? DEFAULT_PLUGIN_SUBDIR;
  const target = options.targetDir ?? workspacePluginDir(workspaceDir);

  // git tag for plugin versions is `v<semver>` (e.g. v0.1.0).
  const tag = `v${version}`;

  // Use a temp dir for the shallow clone so we can discard everything
  // except the plugin subdir.
  const tmpClone = mkdtempSync(join(tmpdir(), 'macf-plugin-clone-'));

  try {
    execFileSync('git', [
      'clone',
      '--depth', '1',
      '--branch', tag,
      marketplaceUrl,
      tmpClone,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const pluginSrc = join(tmpClone, pluginSubdir);
    if (!existsSync(pluginSrc)) {
      throw new Error(
        `Plugin subdir "${pluginSubdir}" not found in ${marketplaceUrl} at ${tag}. ` +
        `Repo layout may have changed.`,
      );
    }

    // Clean up any existing plugin dir so stale files from a previous
    // version don't linger. Parent .macf/ is created by `macf init`
    // already; we just manage the plugin/ child.
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(target, { recursive: true });

    // Recursive copy. cpSync preserves timestamps and file modes.
    cpSync(pluginSrc, target, { recursive: true });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Plugin subdir')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch plugin from ${marketplaceUrl} at ${tag}: ${msg}. ` +
      `Check network access and that the tag exists.`,
      { cause: err },
    );
  } finally {
    rmSync(tmpClone, { recursive: true, force: true });
  }
}

/**
 * Resolve the running CLI's own `dist/` directory — the one containing the
 * built `plugin/bin/macf-plugin-cli.js`. The CLI source compiles to
 * `<pkg>/dist/cli/...`, so the dist root is `<pkg>/dist`; we derive the
 * package root from `import.meta.url` (via `findCliPackageRoot`) rather than
 * hardcoding the depth from this module, then verify the plugin-CLI entry
 * exists under `dist/` before returning. Returns `null` when no built dist is
 * present (e.g. running from an un-built source checkout) so callers can
 * skip the link rather than create a dangling one.
 */
export function resolveCliDistDir(): string | null {
  let packageRoot: string;
  try {
    packageRoot = findCliPackageRoot();
  } catch {
    return null;
  }
  const distDir = join(packageRoot, 'dist');
  if (!existsSync(join(distDir, PLUGIN_CLI_REL))) return null;
  return distDir;
}

/**
 * True if a filesystem entry exists at `p` — INCLUDING a dangling symlink
 * (which `existsSync` reports false for, since it follows the link). Used to
 * decide whether a prior `.macf/plugin/dist` must be removed before relinking.
 */
function hasFsEntry(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface LinkPluginCliDistOptions {
  /**
   * Override the CLI `dist/` directory to link (for testing). When unset, the
   * running CLI's own dist is resolved from `import.meta.url`.
   */
  readonly cliDistDir?: string;
  /** Link into this absolute plugin dir instead of `workspacePluginDir(workspaceDir)` (macf#889). */
  readonly targetDir?: string;
}

/**
 * Deliver the built plugin-CLI into the workspace plugin dir (issue #676).
 *
 * The marketplace plugin cloned into `<ws>/.macf/plugin/` ships only
 * `agents/ hooks/ scripts/ skills/ .claude-plugin/` — there is NO `dist/`. The
 * `/macf-*` skills, however, run
 * `node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" …` with
 * CLAUDE_PLUGIN_ROOT pointing at `<ws>/.macf/plugin/`, so without a `dist/`
 * there every plugin-CLI skill fails MODULE_NOT_FOUND. The built CLI lives in
 * the installed `@groundnuty/macf` package's own `dist/`.
 *
 * Bridge the two by linking `<ws>/.macf/plugin/dist` → the running CLI's
 * `dist/`. A symlink is primary; a recursive copy is the fallback when symlink
 * creation throws (EPERM / unsupported filesystem). Idempotent: any pre-existing
 * `dist` entry (stale symlink or dir) is removed first, so re-running gives a
 * current link. MUST run AFTER `fetchPluginToWorkspace` populates `.macf/plugin/`
 * (a marketplace re-clone wipes the dir, taking the link with it).
 *
 * No-ops (returns false) when the running CLI has no built dist to point at —
 * `resolveCliDistDir` returns null for an un-built source checkout — so a dev
 * run never plants a dangling link.
 */
export function linkPluginCliDist(
  workspaceDir: string,
  options: LinkPluginCliDistOptions = {},
): boolean {
  const cliDistDir = options.cliDistDir ?? resolveCliDistDir();
  if (cliDistDir === null) return false;

  const pluginDir = options.targetDir ?? workspacePluginDir(workspaceDir);
  if (!existsSync(pluginDir)) return false;

  const target = join(pluginDir, 'dist');

  // Idempotent replace: drop any prior dist entry (stale symlink — even a
  // dangling one — or a real dir) so the result is always a fresh, correct
  // link. `existsSync` follows symlinks (false for a dangling one), so probe
  // with `lstatSync` to catch the broken-link case too. `rmSync` with
  // `force: true` no-ops on absent, so the lstat is purely to gate it.
  if (hasFsEntry(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  try {
    symlinkSync(cliDistDir, target, 'dir');
  } catch {
    // Symlink unsupported / not permitted (some Windows configs, certain FS) —
    // fall back to a recursive copy of the built dist.
    cpSync(cliDistDir, target, { recursive: true });
  }
  return true;
}
