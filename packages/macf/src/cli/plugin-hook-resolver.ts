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
  const found = new Set<string>();
  const re = /--plugin-dir\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const captured = m[1] ?? m[2] ?? m[3];
    if (captured !== undefined) found.add(captured);
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
