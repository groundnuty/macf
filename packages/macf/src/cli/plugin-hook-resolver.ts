/**
 * Shared plugin-dir resolution + hooks.json parsing helpers.
 *
 * Extracted out of `commands/doctor.ts` (where DR-039 Decision 1 —
 * groundnuty/macf#739 — originally introduced them for the `macf doctor`
 * load-bearing-hook-presence assertion) into this dependency-free module so
 * `settings-writer.ts` can reuse the SAME resolver for its own DR-039
 * self-guard (groundnuty/macf#743 science-agent review — verify the plugin
 * can actually deliver the migrated hook set BEFORE stripping the
 * settings.json fallback copy).
 *
 * Why a new module instead of importing straight from `doctor.ts`:
 * `doctor.ts` already imports `installGhTokenHook` (and friends) FROM
 * `settings-writer.ts`. Having `settings-writer.ts` import back from
 * `doctor.ts` would create an import cycle. `doctor.ts` re-exports the
 * names below so its existing public surface (and `doctor.test.ts`'s
 * imports) are unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workspacePluginDir } from './plugin-fetcher.js';

/**
 * One hook registration found while scanning a settings.json / hooks.json
 * file's `hooks` map — either a bash `command` string or an `mcp_tool` name.
 */
export interface HookMatchEntry {
  readonly kind: 'command' | 'mcp_tool';
  readonly value: string;
}

/**
 * Extract every command/mcp_tool hook entry out of a parsed `hooks` map,
 * regardless of event name — matches BOTH Claude Code's settings.json shape
 * and the plugin's `hooks.json` shape (`{ "<Event>": [{ "hooks": [{ type,
 * command|tool }] }] }`).
 */
export function extractHookMatchEntries(hooksMap: unknown): HookMatchEntry[] {
  const result: HookMatchEntry[] = [];
  if (!hooksMap || typeof hooksMap !== 'object') return result;
  for (const entries of Object.values(hooksMap as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const hooks = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (!h || typeof h !== 'object') continue;
        const type = (h as { type?: unknown }).type;
        if (type === 'mcp_tool') {
          const tool = (h as { tool?: unknown }).tool;
          if (typeof tool === 'string') result.push({ kind: 'mcp_tool', value: tool });
        } else {
          const command = (h as { command?: unknown }).command;
          if (typeof command === 'string') result.push({ kind: 'command', value: command });
        }
      }
    }
  }
  return result;
}

/**
 * Best-effort read of a JSON file's top-level `hooks` map. Returns `[]` on
 * any absence/parse failure — callers treat "no entries found" as the
 * uniform not-present signal (a missing file and an empty/malformed one
 * both mean "can't confirm the hook is registered here").
 */
export function readHooksMapEntries(jsonPath: string): HookMatchEntry[] {
  if (!existsSync(jsonPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { hooks?: unknown };
    return extractHookMatchEntries(parsed.hooks);
  } catch {
    return [];
  }
}

/** Result of trying to determine which plugin dir `claude.sh` actually mounts. */
export interface PluginDirResolution {
  /** Absolute resolved path, or `null` if not cleanly determinable. */
  readonly dir: string | null;
  readonly determinable: boolean;
  readonly detail: string;
}

/**
 * Parse the workspace's `claude.sh` for its `--plugin-dir "<path>"` argument
 * and resolve it to an absolute path (substituting `$SCRIPT_DIR` /
 * `${SCRIPT_DIR}` — the launcher's own name for the workspace root, see
 * `claude-sh.ts`'s `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`
 * — with `workspaceDir`).
 *
 * Returns `determinable: false` when `claude.sh` is absent, unreadable, has
 * no `--plugin-dir` flag at all, or has MULTIPLE distinct `--plugin-dir`
 * values (an ambiguous/hand-edited launcher) — callers fall back to their
 * own posture for the undeterminable case (see `getEffectiveHookConfig` in
 * `doctor.ts` for the "err toward not-false-alarming" fallback-to-default,
 * and `canPluginDeliverMigratedHooks` in `settings-writer.ts` for the
 * opposite "err toward keeping the fallback" posture).
 */
export function resolvePluginDirFromClaudeSh(workspaceDir: string): PluginDirResolution {
  const absDir = resolve(workspaceDir);
  const claudeShPath = join(absDir, 'claude.sh');
  if (!existsSync(claudeShPath)) {
    return { dir: null, determinable: false, detail: 'no claude.sh found in workspace' };
  }
  let content: string;
  try {
    content = readFileSync(claudeShPath, 'utf-8');
  } catch (err) {
    return {
      dir: null,
      determinable: false,
      detail: `could not read claude.sh: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Match double-quoted, single-quoted, OR bare/unquoted forms — a
  // hand-authored launcher (macf#739 follow-up hardening, science-agent
  // review) may use `--plugin-dir "$X"` (canonical), `--plugin-dir '$X'`, or
  // `--plugin-dir $X` (unquoted var / bare path, no embedded whitespace).
  // Double-quote checked first so the canonical form's exact prior behavior
  // is unchanged; the unquoted `(\S+)` alternative is a catch-all fallback
  // that only matches when neither quote form applies at that position.
  // Match per-line, skipping comment lines (macf#756): a `--plugin-dir`
  // MENTIONED in a claude.sh comment — e.g. the canonical channels-enablement
  // note whose line ends "...the --plugin-dir" — is documentation, not an
  // actual flag. Two guards together: (1) skip lines that are comments
  // (first non-whitespace char is `#`), and (2) `[^\S\r\n]+` (same-line
  // whitespace only, never `\s+` which spans newlines) so a `--plugin-dir` at
  // the END of a line can't greedily grab the NEXT line's leading token (the
  // exact bug: a trailing-`--plugin-dir` comment matched the next line's `#`,
  // yielding a spurious second "value" and a false "multiple values" verdict).
  const found = new Set<string>();
  const re = /--plugin-dir[^\S\r\n]+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    for (const m of line.matchAll(re)) {
      const captured = m[1] ?? m[2] ?? m[3];
      if (captured !== undefined) found.add(captured);
    }
  }
  if (found.size === 0) {
    return { dir: null, determinable: false, detail: 'claude.sh has no --plugin-dir flag' };
  }
  if (found.size > 1) {
    return {
      dir: null,
      determinable: false,
      detail: `claude.sh has multiple distinct --plugin-dir values: ${[...found].join(', ')}`,
    };
  }
  const raw = [...found][0] as string;
  const substituted = raw.replace(/\$\{SCRIPT_DIR\}|\$SCRIPT_DIR/g, absDir);
  return {
    dir: resolve(substituted),
    determinable: true,
    detail: `resolved from claude.sh --plugin-dir "${raw}"`,
  };
}

/**
 * Where `macf update`'s plugin-touching steps (repair-fetch, version-pin
 * write, dist-link) should actually WRITE (macf#889).
 *
 * `dir` is `null` exactly when `determinable` is `false` — callers MUST
 * treat that as a loud refusal, never a silent fallback to the conventional
 * `.macf/plugin` default. `divergesFromDefault` is `true` when the resolved
 * mount is a DIFFERENT directory than that default (e.g. the mcpServers-only
 * `.macf/plugin-cs` variant, DR-005 Decision 6 / macf#533) — callers should
 * warn naming both paths so an operator/agent can see the unmounted default
 * is being left alone, not silently drifting.
 */
export interface PluginUpdateTarget {
  readonly dir: string | null;
  readonly determinable: boolean;
  readonly detail: string;
  readonly divergesFromDefault: boolean;
}

/**
 * Resolve the plugin dir `macf update` should write to — the one
 * `claude.sh --plugin-dir` actually MOUNTS, never the conventional
 * `.macf/plugin` default assumed unconditionally pre-macf#889.
 *
 * Root cause this closes: a substrate workspace hand-wired onto the
 * mcpServers-only `.macf/plugin-cs` variant (DR-005 Decision 6 / macf#533)
 * had its `.macf/plugin/` bumped by every `macf update` roll while the
 * MOUNTED `plugin-cs` manifest silently rotted at whatever version it was
 * last hand-pinned to — `devops-agent` ran a real, unmistakable 0.2.47
 * process while `macf fleet status` (which reads the config pin, not the
 * mounted manifest) reported the newer target.
 *
 * Reuses `resolvePluginDirFromClaudeSh` — the SAME resolver `macf doctor`
 * (macf#756) and `canPluginDeliverMigratedHooks` (macf#743) already use, so
 * every plugin-dir-aware call site agrees on which plugin is "the loaded
 * one." Deliberately does NOT fall back to the default when undeterminable
 * (claude.sh absent/unreadable, no `--plugin-dir`, multiple distinct
 * `--plugin-dir` values) — an honest refusal beats a confident update of a
 * manifest nobody mounts, which is exactly the failure macf#889 reports.
 */
export function resolvePluginUpdateTarget(workspaceDir: string): PluginUpdateTarget {
  const resolution = resolvePluginDirFromClaudeSh(workspaceDir);
  if (!resolution.determinable || resolution.dir === null) {
    return { dir: null, determinable: false, detail: resolution.detail, divergesFromDefault: false };
  }
  const defaultDir = resolve(workspacePluginDir(workspaceDir));
  return {
    dir: resolution.dir,
    determinable: true,
    detail: resolution.detail,
    divergesFromDefault: resolution.dir !== defaultDir,
  };
}
