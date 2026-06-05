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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_MARKETPLACE_URL = 'https://github.com/groundnuty/macf-marketplace';
const DEFAULT_PLUGIN_SUBDIR = 'macf-agent';

/** The channel-server npm package the plugin's mcpServers launches via npx. */
const CHANNEL_SERVER_PKG = '@groundnuty/macf-channel-server';

export interface FetchPluginOptions {
  /** Override the marketplace git URL (for testing). */
  readonly marketplaceUrl?: string;
  /** Override the subdir inside the marketplace repo (for testing). */
  readonly pluginSubdir?: string;
}

/**
 * Path to the target plugin directory inside a workspace.
 */
export function workspacePluginDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.macf', 'plugin');
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
export function pinChannelServerVersion(workspaceDir: string, version: string): boolean {
  const manifestPath = join(workspacePluginDir(workspaceDir), '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return false;

  let manifest: {
    mcpServers?: Record<string, { command?: string; args?: string[] } | undefined>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    // Malformed manifest — don't clobber it; leave for the operator to fix.
    return false;
  }

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
  const target = workspacePluginDir(workspaceDir);

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
