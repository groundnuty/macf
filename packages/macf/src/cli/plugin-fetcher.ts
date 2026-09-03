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

export interface ReadInstalledPluginVersionOptions {
  /** Read this absolute plugin dir instead of `workspacePluginDir(workspaceDir)`. */
  readonly targetDir?: string;
}

/**
 * What's actually on disk at `.claude-plugin/plugin.json`'s `version` field
 * — the ground truth a recorded `macf-agent.json` `versions.plugin` pin can
 * be compared against (groundnuty/macf#1419).
 *
 * Three outcomes, deliberately distinct (never collapsed into a plain
 * `string | undefined`): `absent` is the normal first-launch/never-fetched
 * shape; `unreadable` is a corrupt/malformed manifest (unparseable JSON, no
 * `version` string) — a DIFFERENT condition a caller should react to
 * differently (same `absent` vs `unreadable` split Instance 20 forced on
 * the channel-log guards in `silent-fallback-hazards.md`). `present` is the
 * only outcome carrying a `version` a caller may compare against a pin.
 *
 * A single reader shared by every caller that needs this comparison
 * (`macf update`'s repair-fetch trigger; `macf doctor`'s pin-vs-disk check)
 * rather than each re-implementing its own manifest parse — DR-044's own
 * "read the permission map through one path, never a second reader" lesson
 * (`#1000`) applied here to the plugin manifest.
 */
export type InstalledPluginVersionResult =
  | { readonly status: 'absent'; readonly path: string }
  | { readonly status: 'unreadable'; readonly path: string; readonly reason: string }
  | { readonly status: 'present'; readonly path: string; readonly version: string };

/**
 * Read the INSTALLED plugin version from the fetched local
 * `.claude-plugin/plugin.json` copy — never the recorded pin. Verified
 * against real `groundnuty/macf-marketplace` tags (v0.2.55, v0.2.60): the
 * manifest's `version` field tracks the git tag it was fetched at exactly,
 * so this is a reliable observable for "what did the last successful fetch
 * actually install," independent of what `macf-agent.json` claims.
 */
export function readInstalledPluginVersion(
  workspaceDir: string,
  options: ReadInstalledPluginVersionOptions = {},
): InstalledPluginVersionResult {
  const pluginDir = options.targetDir ?? workspacePluginDir(workspaceDir);
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return { status: 'absent', path: manifestPath };

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'unreadable', path: manifestPath, reason: `cannot read ${manifestPath}: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'unreadable', path: manifestPath, reason: `${manifestPath} is not valid JSON: ${msg}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 'unreadable',
      path: manifestPath,
      reason: `${manifestPath} top-level content is not a JSON object`,
    };
  }

  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    return { status: 'unreadable', path: manifestPath, reason: `${manifestPath} has no "version" string field` };
  }
  return { status: 'present', path: manifestPath, version };
}

/** The shape of `plugin.json`'s `mcpServers` block this module reads/strips. */
type McpServersManifest = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface StripPluginMcpServersOptions {
  /** Read/write this absolute plugin dir instead of `workspacePluginDir(workspaceDir)` (macf#889). */
  readonly targetDir?: string;
}

/**
 * Outcome of `stripPluginMcpServers` (groundnuty/macf#1005).
 *
 * `noop` covers every "nothing to do, nothing wrong" case uniformly — dir
 * absent, manifest absent, `mcpServers` already gone (idempotent re-run).
 * `refused` is the loud-refuse case (malformed JSON / unreadable / non-object
 * top-level) — mirrors `McpJsonWriteResult`'s `'refused'` variant in
 * `mcp-json.ts` (same "refuse loudly rather than silently skip content this
 * tool didn't write" contract; silent-fallback-hazards.md is this repo's
 * most-catalogued defect class, so a parse failure must never look like a
 * quiet no-op).
 */
export type StripPluginMcpServersResult =
  | { readonly status: 'stripped'; readonly path: string }
  | { readonly status: 'noop'; readonly path: string }
  | { readonly status: 'refused'; readonly reason: string; readonly path: string };

/**
 * Delete the `mcpServers` key from a workspace's FETCHED (local) copy of
 * `.claude-plugin/plugin.json` (DR-022 Amendment P, groundnuty/macf#995).
 *
 * Amendment P retires the channel-server's plugin-`mcpServers` mount in
 * favor of a project `.mcp.json` `server:macf-agent` entry (see
 * `mcp-json.ts::writeMcpJsonChannelServer`) — a `--plugin-dir`-mounted
 * server's channel id (`plugin:<name>:<server>`) is rejected by the
 * `--dangerously-load-development-channels` dev-flag, so native channel-push
 * never worked while the mount lived here. Leaving `mcpServers` in the local
 * plugin.json copy after the fetch would let Claude Code ALSO spawn a second
 * channel-server child from the plugin mount (for MCP tool calls under the
 * `mcp__plugin_macf-agent_macf-agent__*` namespace) alongside the `.mcp.json`
 * one — a redundant process plus a stale tool namespace nothing pre-approves
 * (see `settings-writer.ts::PLUGIN_MCP_TOOL_PERMISSIONS`, updated to the
 * `.mcp.json` namespace in the same change).
 *
 * **Why this strips the LOCAL fetched copy rather than editing the source:**
 * the canonical plugin manifest is authored in a SEPARATE repo
 * (`groundnuty/macf-marketplace`, per `packages/macf/plugin/README.md`) —
 * this CLI's `fetchPluginToWorkspace` only clones it. Until that repo's own
 * `mcpServers` block is removed, every fetch would otherwise re-introduce it;
 * stripping it here, post-fetch, on every `macf init`/`update` makes the
 * FUNCTIONAL fix apply immediately regardless of marketplace timing, and is
 * a safe no-op once the upstream manifest drops the block itself (`servers`
 * absent → this function no-ops cleanly).
 *
 * **Caller contract (groundnuty/macf#1005):** call this UNCONDITIONALLY on
 * every `macf init`/`update` invocation, not only right after a fetch. The
 * original #995 wiring called this only adjacent to `fetchPluginToWorkspace`
 * — correct for "a fetch always reintroduces the key" but blind to the far
 * more common steady state where the plugin is ALREADY at its pinned
 * version and no fetch happens at all; that workspace never converged. This
 * function is a cheap, idempotent, local read-modify-write — safe to call
 * on every invocation regardless of whether a fetch just ran.
 *
 * Idempotent: `status: 'noop'` when the manifest is absent (dir missing,
 * manifest missing) or already has no `mcpServers` key — re-running against
 * an already-stripped manifest is a silent no-op, never an error. Malformed
 * JSON (or a non-object top-level, or an unreadable file) is `status:
 * 'refused'` with a `reason` — written NOTHING, per the caller contract
 * above. Still call this AFTER `fetchPluginToWorkspace` when a fetch does
 * happen in the same invocation (a re-fetch overwrites the manifest, undoing
 * a prior strip) — same call-order contract the retired
 * `pinChannelServerVersion` had — but never ONLY there.
 */
export function stripPluginMcpServers(
  workspaceDir: string,
  options: StripPluginMcpServersOptions = {},
): StripPluginMcpServersResult {
  const pluginDir = options.targetDir ?? workspacePluginDir(workspaceDir);
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return { status: 'noop', path: manifestPath };

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'refused', reason: `cannot read ${manifestPath}: ${msg}`, path: manifestPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'refused',
      reason: `${manifestPath} is not valid JSON: ${msg}. Fix by hand, then re-run.`,
      path: manifestPath,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 'refused',
      reason: `${manifestPath} top-level content is not a JSON object — refusing to modify content this tool didn't write.`,
      path: manifestPath,
    };
  }

  const manifest = parsed as McpServersManifest;
  if (manifest.mcpServers === undefined) return { status: 'noop', path: manifestPath };
  const { mcpServers: _mcpServers, ...rest } = manifest;
  writeFileSync(manifestPath, JSON.stringify(rest, null, 2) + '\n');
  return { status: 'stripped', path: manifestPath };
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

export interface CopyLocalPluginOptions {
  /** Write to this absolute path instead of `workspacePluginDir(workspaceDir)` (macf#889). */
  readonly targetDir?: string;
}

/**
 * Copy an ALREADY-ON-DISK plugin tree (e.g. this checkout's own
 * `packages/macf/plugin/`) into `<workspace>/.macf/plugin/` — no `git clone`,
 * no network, no tag. Sibling to {@link fetchPluginToWorkspace}, which always
 * goes over the network at a git tag; this is for the one caller (the
 * release script's harness-compat gate, groundnuty/macf#1424) that must
 * validate the ARTIFACT UNDER RELEASE, not a network-versioned copy.
 *
 * Why the network path is the wrong subject for that caller: at release
 * time the new marketplace tag does not exist yet — `release.sh`'s
 * `marketplace` stage tags the plugin with the CLI's version DURING the
 * release — so a `fetchPluginToWorkspace` clone can only ever fetch the
 * PREVIOUSLY published plugin, one version behind the build under test. And
 * on a host that denies anonymous git HTTPS (groundnuty/macf#1423), that
 * clone fails outright rather than silently serving stale content. The
 * plugin these callers actually want to test is sitting on disk already, in
 * this build — this function is a straight recursive copy of it, with no
 * network dependency to fail loudly OR silently.
 *
 * `sourceDir` must exist and be a directory — thrown, not silently no-op'd,
 * matching {@link fetchPluginToWorkspace}'s own fail-loud contract for a
 * missing source. Idempotent: an existing target dir is removed before the
 * copy, so re-running gives a clean replacement (no stale files from a
 * previous call hanging around) — same replace-not-merge contract as
 * {@link fetchPluginToWorkspace}.
 */
export function copyLocalPluginToWorkspace(
  workspaceDir: string,
  sourceDir: string,
  options: CopyLocalPluginOptions = {},
): void {
  const src = resolve(sourceDir);
  const target = options.targetDir ?? workspacePluginDir(workspaceDir);

  if (!existsSync(src) || !lstatSync(src).isDirectory()) {
    throw new Error(
      `--plugin-source "${sourceDir}" does not exist or is not a directory — ` +
      `pass the local plugin tree to copy (e.g. packages/macf/plugin/ in a macf checkout).`,
    );
  }

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  cpSync(src, target, { recursive: true });
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
