/**
 * The canonical-compute primitive + tier-first dirty-file classifier
 * (DR-040 Decision 3, groundnuty/macf#698 R1).
 *
 * `macf fleet upgrade`'s pre-flight config-dirty gate used to OBJECT
 * unconditionally on any dirty file in `ROLL_TOUCHED_CONFIG_PATTERNS`
 * (macf#725). The common case, empirically validated on the v0.2.48 roll
 * (both code-agent AND science hit it), is a stale-branch workspace whose
 * dirty files ARE EXACTLY what `macf update` would (re)write — a false
 * objection. This module answers, PER FILE and WITHOUT MUTATING the
 * workspace, "is this dirty file's content already what `macf update` would
 * produce right now?" so the roll can auto-resolve (commit) the
 * already-canonical subset and OBJECT only on genuine local deltas.
 *
 * **Per-file-type resolution** (verified against the CLI source, not
 * assumed — see each branch's comment for the exact generator it mirrors):
 *
 * - `.claude/rules/<name>.md` — `computeCanonicalRuleFile` (rules.ts),
 *   the same header-prepend logic `copyCanonicalRules` applies.
 * - `.claude/scripts/<name>` — `computeCanonicalScriptFile` (rules.ts),
 *   the same two-source-dir (legacy ∪ plugin, plugin wins) winner logic
 *   `copyCanonicalScripts` applies.
 * - `.claude/.macf/env.{_helpers,identity,github,certs,registry}` —
 *   `computeCanonicalEnvFileContent` (env-files-update.ts), the exact
 *   generator `refreshEnvFiles` calls for the 5 MACF-MANAGED files.
 * - `.claude/.macf/host-prelude.sh` — `computeCanonicalHostPrelude`
 *   (host-prelude.ts) — re-detects the CURRENT host toolchain (devbox /
 *   brew / none), same as `writeHostPrelude`'s default probe.
 * - `claude.sh` — GENERATED, not fetched: `generateClaudeSh(config)`
 *   (claude-sh.ts) is a pure string generator. Per DR-029 (macf#623),
 *   `macf update` only regenerates it when the ON-DISK file carries the
 *   managed-file header (`hasManagedHeader`) — a hand-authored launcher is
 *   preserved verbatim and NEVER canonical-computable, so a dirty
 *   header-less claude.sh is always `genuine-delta` here too.
 * - `.claude/settings.json` — NOT a standalone regenerate-from-scratch
 *   file: `installGhTokenHook` / `installPluginSkillPermissions` /
 *   `installSandboxFdAllowRead` / `installSandboxExcludedCommands` all
 *   READ the current file and MERGE canonical entries in. "Already
 *   canonical" for this file means applying those 4 transforms to the
 *   CURRENT parsed object is a NO-OP (a fixed point) — see
 *   `classifySettingsJson` below. Because the merge is order- and
 *   key-position-sensitive on write but not semantically, the comparison
 *   is done at the PARSED-OBJECT level (deep-equal, sorted-key stable
 *   stringify), never a byte/string compare — a byte compare would be
 *   fragile to inconsequential key-reordering.
 * - `CLAUDE.md`, `env.local.*` (any directory) — `macf update` NEVER
 *   writes these (verified: no write path in any CLI command for
 *   CLAUDE.md; `env.local.*` is the operator-extension slot sourced but
 *   never generated). Always `genuine-delta` — a dirty one is agent/
 *   operator evolution, never a stale-regen false-positive.
 * - `.claude/rules/project/*.md` (project-tier rules) — fetched over the
 *   network from `MACF_PROJECT_RULES_SOURCE`; not computable offline in
 *   this iteration. Fail-safe `genuine-delta` (a future revision may add
 *   network-aware compute here).
 * - Anything else — unrecognized path; fail-safe `genuine-delta`.
 *
 * **Fail-safe posture**: any error (unreadable file, malformed JSON, a
 * generator throwing) classifies as `genuine-delta`, NEVER
 * `already-canonical` — a wrong `genuine-delta` costs an unnecessary OBJECT
 * (safe, reversible); a wrong `already-canonical` would auto-COMMIT
 * something that wasn't actually canonical (unsafe). See `classifyDirtyFile`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MacfAgentConfig } from '../config.js';
import { generateClaudeSh, hasManagedHeader } from '../claude-sh.js';
import { computeCanonicalRuleFile, computeCanonicalScriptFile } from '../rules.js';
import { computeCanonicalEnvFileContent } from '../env-files-update.js';
import { computeCanonicalHostPrelude } from '../host-prelude.js';
import {
  readSettings,
  canPluginDeliverMigratedHooks,
  applyGhTokenHookTransform,
  applyPluginSkillPermissionsTransform,
  applySandboxFdAllowReadTransform,
  applySandboxExcludedCommandsTransform,
  type Settings,
} from '../settings-writer.js';

/** The result of `computeCanonicalContent` for one file. */
export type CanonicalCompute =
  | { readonly managed: true; readonly content: string }
  | { readonly managed: false };

/** Tier classification for one dirty file (DR-040 Decision 3). */
export type DirtyFileTier = 'already-canonical' | 'genuine-delta';

const RULES_DIR_PREFIX = '.claude/rules/';
const SCRIPTS_DIR_PREFIX = '.claude/scripts/';
const MACF_DIR_PREFIX = '.claude/.macf/';
const SETTINGS_JSON_PATH = '.claude/settings.json';
const CLAUDE_SH_PATH = 'claude.sh';

/** Normalize path separators (defensive — git always emits `/`). */
function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

/**
 * `macf update` NEVER writes `CLAUDE.md` (no write path in any CLI command —
 * verified against `update.ts` + every `cli/commands/*.ts`) or an
 * `env.local.*` operator-extension file (sourced, never generated) — a
 * dirty one is always genuine agent/operator evolution, never a stale-regen
 * false-positive. Basename-matched so this holds regardless of directory
 * (the config-dirty pathspec's bare `env.local.*` entry matches at the repo
 * root today; a workspace nesting it under `.claude/.macf/` per the
 * documented extension convention is covered the same way).
 */
function isNeverWritten(relPath: string): boolean {
  if (relPath === 'CLAUDE.md') return true;
  return basenameOf(relPath).startsWith('env.local.');
}

/**
 * Match `path` against `<prefix><single-path-segment>[<requiredSuffix>]` —
 * i.e. `prefix` followed by EXACTLY one more segment (no further `/`), so a
 * nested subdir (e.g. `.claude/rules/project/foo.md`) does NOT match.
 * Returns the matched segment, or `null` when it doesn't match.
 */
function matchSingleSegment(path: string, prefix: string, requiredSuffix?: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  if (requiredSuffix !== undefined && !rest.endsWith(requiredSuffix)) return null;
  return rest;
}

function readWorkspaceFile(workspaceDir: string, relPath: string): string | null {
  const abs = join(resolve(workspaceDir), relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf-8');
}

/**
 * Compute what `macf update` WOULD write for `relPath` in `workspaceDir`
 * given `config`, WITHOUT writing anything. `managed: false` means either
 * (a) `macf update` never writes this path at all (`CLAUDE.md`,
 * `env.local.*`), or (b) this specific workspace's current state makes it
 * non-canonical-computable right now (a hand-authored `claude.sh` with no
 * managed header — DR-029 preserves it, never regenerates it).
 *
 * `.claude/settings.json` is deliberately NOT handled here — its canonical
 * form is a MERGE fixed point over the CURRENT parsed object, not a
 * standalone regeneratable string (see the module doc comment + the
 * dedicated `classifySettingsJson` in `classifyDirtyFile` below, which does
 * the correct object-level comparison). Returns `{ managed: false }` for it
 * so a caller reaching this function directly doesn't get a misleadingly
 * byte-comparable (and reorder-fragile) string.
 */
export function computeCanonicalContent(
  relPath: string,
  workspaceDir: string,
  config: MacfAgentConfig,
): CanonicalCompute {
  const norm = normalizeRelPath(relPath);

  if (isNeverWritten(norm) || norm === SETTINGS_JSON_PATH) {
    return { managed: false };
  }

  if (norm === CLAUDE_SH_PATH) {
    const current = readWorkspaceFile(workspaceDir, norm);
    if (current === null || !hasManagedHeader(current)) return { managed: false };
    return { managed: true, content: generateClaudeSh(config) };
  }

  const ruleName = matchSingleSegment(norm, RULES_DIR_PREFIX, '.md');
  if (ruleName !== null) {
    const content = computeCanonicalRuleFile(ruleName);
    return content === null ? { managed: false } : { managed: true, content };
  }

  const scriptName = matchSingleSegment(norm, SCRIPTS_DIR_PREFIX);
  if (scriptName !== null) {
    const content = computeCanonicalScriptFile(scriptName);
    return content === null ? { managed: false } : { managed: true, content: content.toString('utf-8') };
  }

  const macfName = matchSingleSegment(norm, MACF_DIR_PREFIX);
  if (macfName !== null) {
    if (macfName === 'host-prelude.sh') {
      return { managed: true, content: computeCanonicalHostPrelude() };
    }
    const envContent = computeCanonicalEnvFileContent(macfName, config);
    return envContent === null ? { managed: false } : { managed: true, content: envContent };
  }

  // Unrecognized path (e.g. `.claude/rules/project/*.md` — network-fetched,
  // not computable offline in this iteration; or anything else outside the
  // known managed set) — fail-safe: not computable here.
  return { managed: false };
}

/** Apply the 4 settings.json merge transforms, in the exact order `update.ts` calls the installXxx writers. */
function applyAllSettingsTransforms(settings: Settings, workspaceDir: string): Settings {
  const delivery = canPluginDeliverMigratedHooks(workspaceDir);
  let out: Settings = settings;
  out = applyGhTokenHookTransform(out, delivery);
  out = applyPluginSkillPermissionsTransform(out);
  out = applySandboxFdAllowReadTransform(out);
  out = applySandboxExcludedCommandsTransform(out);
  return out;
}

/**
 * Stable (sorted-key) JSON stringify for deep-equality comparison of parsed
 * JSON values. Object key ORDER doesn't matter (a `macf update` merge
 * round-trip can legitimately reorder keys without being a semantic change);
 * array ELEMENT order DOES matter (arrays are treated as ordered lists, not
 * sets) — this is the conservative direction: an array-order-only
 * difference reports `genuine-delta`, never a false `already-canonical`.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * `.claude/settings.json`'s tier classification: apply the 4 merge
 * transforms to the CURRENT parsed settings, in-memory, and compare to the
 * input — a fixed point (no-op merge) means the current (dirty) content
 * already IS what `macf update` would produce, i.e. `already-canonical`.
 * `readSettings` throws on malformed JSON — caught by `classifyDirtyFile`'s
 * outer try/catch (fail-safe → `genuine-delta`), never silently treated as
 * empty.
 */
function classifySettingsJson(workspaceDir: string): DirtyFileTier {
  const path = join(resolve(workspaceDir), '.claude', 'settings.json');
  if (!existsSync(path)) return 'genuine-delta';
  const parsed = readSettings(path);
  const transformed = applyAllSettingsTransforms(parsed, workspaceDir);
  return deepEqualJson(parsed, transformed) ? 'already-canonical' : 'genuine-delta';
}

/**
 * Classify one dirty file (a path `listDirtyConfig` reported as uncommitted)
 * as `already-canonical` (its content already equals what `macf update`
 * would write — safe to auto-commit) or `genuine-delta` (a real local
 * difference — must OBJECT, never auto-resolved).
 *
 * **Fail-safe by construction**: an unreadable file, a compute-time throw
 * (malformed JSON, a generator error), or an unrecognized/non-computable
 * path all classify as `genuine-delta` — the safe direction. Only an
 * explicit, successful byte-for-byte (or object-fixed-point, for
 * settings.json) match yields `already-canonical`.
 */
export function classifyDirtyFile(
  relPath: string,
  workspaceDir: string,
  config: MacfAgentConfig,
): DirtyFileTier {
  try {
    const norm = normalizeRelPath(relPath);

    if (norm === SETTINGS_JSON_PATH) {
      return classifySettingsJson(workspaceDir);
    }

    const compute = computeCanonicalContent(norm, workspaceDir, config);
    if (!compute.managed) return 'genuine-delta';

    const current = readWorkspaceFile(workspaceDir, norm);
    if (current === null) return 'genuine-delta';

    return current === compute.content ? 'already-canonical' : 'genuine-delta';
  } catch {
    return 'genuine-delta';
  }
}
