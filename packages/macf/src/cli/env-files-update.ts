/**
 * Update + migration semantics for the per-concern env-file layout
 * (groundnuty/macf#342). PR-C of the 4-PR sequence:
 *
 *   PR-A — pure generators (env-files.ts) [merged ee4604d]
 *   PR-B — thin claude.sh + writeEnvFiles + init wiring [merged b75c7ff]
 *   PR-C (this PR) — `macf update` wiring + monolithic→multi-file
 *                    migration tool + settings.local.json env block compat
 *   PR-D — operator docs
 *
 * Three concerns live here, kept in one module so the refresh pipeline
 * is easy to read end-to-end:
 *
 *   1. `refreshEnvFiles()` — refresh-and-preserve semantics for
 *      macf-managed (overwrite + warn-on-handedit) and operator-managed
 *      (silent no-op when present) env files.
 *
 *   2. `migrateMonolithicClaudeSh()` — auto-migration from the
 *      pre-#342 monolithic claude.sh to the thin source-loop template
 *      + per-concern env files. Detection-gated; runs transparently on
 *      first `macf update` after upgrading to a CLI carrying this code.
 *
 *   3. `detectSettingsLocalEnvKeys()` — surfaces deprecated
 *      `env.MACF_*` / `env.OTEL_*` keys still living in
 *      `.claude/settings.local.json` per Option α (clean break with
 *      deprecation shim). The shim itself is structural — `macf_settings_get`
 *      in env._helpers continues to read these keys at runtime — so
 *      operators have a window to migrate; PR-C only emits the
 *      one-time warning.
 *
 * **Invariant**: this module never deletes operator state. Macf-managed
 * files are overwritten only with the (single source of truth)
 * generator output; operator-managed files (env.telemetry, env.tmux)
 * are preserved unconditionally once they exist; settings.local.json
 * is read-only here (the deprecation warning surfaces them, but no
 * automatic JSON-key migration in this PR — the risk surface is too
 * broad for one change. Operators see the warning and migrate by hand).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MANAGED_ENV_FILES,
  OPERATOR_ENV_FILES,
  writeEnvFiles,
} from './env-files.js';
import { writeClaudeSh } from './claude-sh.js';
import type { MacfAgentConfig } from './config.js';

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------
//
// `MANAGED_ENV_FILES` + `OPERATOR_ENV_FILES` are defined ONCE in
// env-files.ts and imported here (macf#1116) — this module used to carry
// its own copy of the exact same classification, and `writeEnvFiles`
// (init's counterpart, also in env-files.ts) carried none at all. Two
// independent classifications of the same 8-file set drift silently the
// moment a 9th env file is added to one but not the other; importing the
// shared arrays makes that structurally impossible.

/**
 * Compute what `refreshEnvFiles` WOULD write for one of the 5 macf-managed
 * `.claude/.macf/env.*` files, WITHOUT writing anything — the canonical-
 * compute tier-check's per-file-type primitive for the managed env-file set
 * (DR-040 Decision 3 / macf#698 R1). `name` is the basename (e.g.
 * `env.identity`). Returns `null` for a name that isn't one of the 5
 * macf-managed files (e.g. the 3 operator-managed files `env.telemetry` /
 * `env.tmux` / `env.project-rules`, which `macf update` bootstrap-writes only
 * if absent and never overwrites thereafter — not part of the overwrite set
 * `ROLL_TOUCHED_CONFIG_PATTERNS` covers, so the caller's fail-safe default is
 * `genuine-delta`).
 */
export function computeCanonicalEnvFileContent(name: string, config: MacfAgentConfig): string | null {
  const entry = MANAGED_ENV_FILES.find((f) => f.name === name);
  return entry ? entry.generate(config) : null;
}

// ---------------------------------------------------------------------------
// refreshEnvFiles — primary update-time refresh routine
// ---------------------------------------------------------------------------

/**
 * Result of `refreshEnvFiles` — counts that the caller turns into a
 * single-line summary log. Lists kept as readonly arrays of basenames
 * (not absolute paths) so the summary message stays compact and
 * stable across operator filesystems.
 */
export interface RefreshEnvFilesResult {
  readonly refreshed: readonly string[]; // macf-managed files written this run
  readonly preserved: readonly string[]; // operator-managed files left as-is
  readonly bootstrapped: readonly string[]; // operator-managed files newly written
  readonly warnedHandEdits: readonly string[]; // macf-managed files that drifted
}

/**
 * Refresh per-concern env files in `<projectDir>/.claude/.macf/`.
 *
 * Macf-managed files (env._helpers, env.identity, env.github,
 * env.certs, env.registry):
 *   - Absent → write fresh from `generate()`.
 *   - Present + matches fresh output → silent no-op.
 *   - Present + drift → emit one-time warning to stderr (cites
 *     macf#342 + suggests env.local.* / settings.local.json for
 *     overrides) + overwrite with fresh output.
 *
 * Operator-managed files (env.telemetry, env.tmux):
 *   - Absent → bootstrap-write (one-time fresh write so the workspace
 *     starts with a sensible default — operator can edit thereafter).
 *   - Present → SILENT NO-OP. Operator's edits preserved unconditionally.
 *
 * **Why "drift = overwrite + warn" not "preserve + warn"**: the
 * macf-managed files have a managed-file header reserving the right to
 * regenerate them. If an operator hand-edits env.identity to change
 * MACF_AGENT_NAME, the canonical place for that override is
 * settings.local.json `env.MACF_AGENT_NAME` (read at runtime by
 * `macf_settings_get`) — not the generated file. PR-C honors the
 * managed-file contract; the warning gives operators time to move
 * their edit.
 *
 * **Stderr write directly** (not via console.warn) so multiple warnings
 * from one update run aren't intermingled with stdout summary logs.
 * Uses `process.stderr.write` consistent with init.ts's existing
 * stderr-diagnostic style.
 *
 * Creates `.claude/.macf/` if absent (mkdir -p). Returns the result
 * record so the caller logs a summary; does not log itself (separation
 * of concerns: this function decides + writes, caller decides how
 * loudly to report).
 */
export function refreshEnvFiles(
  projectDir: string,
  config: MacfAgentConfig,
): RefreshEnvFilesResult {
  const absDir = resolve(projectDir);
  const envDir = join(absDir, '.claude', '.macf');
  mkdirSync(envDir, { recursive: true });

  const refreshed: string[] = [];
  const preserved: string[] = [];
  const bootstrapped: string[] = [];
  const warnedHandEdits: string[] = [];

  // Macf-managed files: overwrite + warn on hand-edit.
  for (const { name, generate } of MANAGED_ENV_FILES) {
    const path = join(envDir, name);
    const fresh = generate(config);
    if (!existsSync(path)) {
      writeFileSync(path, fresh, { mode: 0o644 });
      refreshed.push(name);
      continue;
    }
    const current = readFileSync(path, 'utf-8');
    if (current === fresh) {
      // Silent no-op — no on-disk change, no log.
      continue;
    }
    // Drift detected. Warn once, then overwrite to honor the
    // managed-file contract.
    process.stderr.write(
      `Warning: hand-edited macf-managed env file detected: .claude/.macf/${name}\n` +
        `  Overwriting with the canonical generator output.\n` +
        `  To customize identity / endpoints, prefer:\n` +
        `    - .claude/settings.local.json \`env\` block (read by macf_settings_get)\n` +
        `    - .claude/.macf/env.local.<name> (sources after canonical files)\n`,
    );
    writeFileSync(path, fresh, { mode: 0o644 });
    refreshed.push(name);
    warnedHandEdits.push(name);
  }

  // Operator-managed files: bootstrap-write if absent; preserve otherwise.
  for (const { name, generate } of OPERATOR_ENV_FILES) {
    const path = join(envDir, name);
    if (existsSync(path)) {
      preserved.push(name);
      continue;
    }
    writeFileSync(path, generate(config), { mode: 0o644 });
    bootstrapped.push(name);
  }

  return { refreshed, preserved, bootstrapped, warnedHandEdits };
}

// ---------------------------------------------------------------------------
// migrateMonolithicClaudeSh — pre-#342 → post-#342 auto-migration
// ---------------------------------------------------------------------------

/**
 * Result of `migrateMonolithicClaudeSh`. `migrated: true` means a
 * monolithic claude.sh was detected and replaced with the thin
 * source-loop template + per-concern env files were written.
 * `migrated: false` carries a `reason` discriminator so the caller can
 * log appropriately or short-circuit downstream work.
 */
export type MigrationResult =
  | { readonly migrated: true }
  | { readonly migrated: false; readonly reason: 'already-migrated' | 'no-claude-sh' | string };

/**
 * Marker for the pre-#342 monolithic claude.sh template: it inlines
 * `export MACF_AGENT_NAME=` directly. The post-#342 thin template
 * sources env files instead — MACF_AGENT_NAME is exported from
 * `.claude/.macf/env.identity`, NOT inline in claude.sh. The
 * source-loop sentinel below is the post-#342 marker for the
 * inverse check (defensive — if both are present the file is in
 * an inconsistent state we shouldn't auto-migrate).
 */
const MONOLITHIC_CLAUDE_SH_MARKER = 'export MACF_AGENT_NAME=';
const THIN_CLAUDE_SH_MARKER = 'for f in "$SCRIPT_DIR/.claude/.macf"/env.*';

/**
 * Detect whether `<projectDir>/claude.sh` is the pre-#342 monolithic
 * template, and if so, migrate it in-place to the thin template +
 * generate the per-concern env files.
 *
 * Detection rules:
 *   - No `claude.sh` at all → `{ migrated: false, reason: 'no-claude-sh' }`.
 *     (init hasn't run; nothing to migrate.)
 *   - `claude.sh` exists + has the source-loop marker (post-#342 thin)
 *     → `{ migrated: false, reason: 'already-migrated' }`.
 *     Silent no-op; downstream `refreshEnvFiles` still runs.
 *   - `claude.sh` exists + has the inline-MACF_AGENT_NAME marker (pre-#342
 *     monolithic) → migrate.
 *   - Anything else (operator-rewritten launcher, third-party edit) →
 *     `{ migrated: false, reason: 'unrecognized-template' }`. Conservative:
 *     don't auto-overwrite something we didn't author. Operator can
 *     run `macf init --force` to opt into the migration explicitly.
 *
 * Migration steps (when migrated=true):
 *   1. `writeEnvFiles(projectDir, config)` — fresh per-concern env files
 *      from the config in `.macf/macf-agent.json`. The JSON is the
 *      source of truth post-migration; we do NOT extract values from
 *      the monolithic claude.sh (the JSON has them already, and parsing
 *      shell to recover values is fragile + unnecessary).
 *   2. `writeClaudeSh(projectDir, config)` — overwrite with the thin
 *      template per PR-B. Thin template depends on env files written
 *      in step 1.
 *
 * **Migration is auto-detected, not opt-in.** Operators upgrading from
 * a CLI carrying the monolithic template to one carrying this code
 * get migrated transparently on first `macf update`. Opt-out is
 * `--no-migrate-env-files` at the CLI layer (handled in update.ts).
 *
 * **Idempotent**: re-running on an already-migrated workspace returns
 * `{ migrated: false, reason: 'already-migrated' }` without writing
 * anything. Safe for repeated `macf update` calls.
 */
export function migrateMonolithicClaudeSh(
  projectDir: string,
  config: MacfAgentConfig,
): MigrationResult {
  const absDir = resolve(projectDir);
  const claudeShPath = join(absDir, 'claude.sh');

  if (!existsSync(claudeShPath)) {
    return { migrated: false, reason: 'no-claude-sh' };
  }

  const content = readFileSync(claudeShPath, 'utf-8');

  // Post-#342 thin template marker present → already migrated.
  if (content.includes(THIN_CLAUDE_SH_MARKER)) {
    return { migrated: false, reason: 'already-migrated' };
  }

  // Pre-#342 monolithic marker absent → unrecognized template (operator
  // hand-edit, third-party launcher). Don't auto-overwrite something we
  // didn't author. Operator can run `macf init --force` to opt into it.
  if (!content.includes(MONOLITHIC_CLAUDE_SH_MARKER)) {
    return { migrated: false, reason: 'unrecognized-template' };
  }

  // Monolithic detected. Migrate.
  writeEnvFiles(absDir, config);
  writeClaudeSh(absDir, config);
  return { migrated: true };
}

// ---------------------------------------------------------------------------
// detectSettingsLocalEnvKeys — Option α deprecation surface
// ---------------------------------------------------------------------------

/**
 * Read `.claude/settings.local.json` and return the list of `env.*`
 * keys whose names start with `MACF_` or `OTEL_`. These are the
 * subset that the multi-file env layout (#342) is replacing —
 * historically operators set them in the JSON env block as a
 * settings-driven override; post-#342 the canonical location is per-
 * concern env files (env.identity for MACF_AGENT_NAME, env.telemetry
 * for OTEL_*, etc.) or the `env.local.*` operator override pattern.
 *
 * **Backward-compat preserved structurally**: `macf_settings_get` in
 * env._helpers (PR-A / PR-B) still reads `env.MACF_*` and `env.OTEL_*`
 * from settings.local.json at runtime. So existing operator overrides
 * keep working — the deprecation warning is the SOFT signal giving
 * operators a window to migrate. Hard removal would be a future PR
 * (Option α §"clean break with deprecation shim" per #342 thread).
 *
 * **No automatic migration of JSON env keys** in this PR. The risk
 * surface is too broad: operators may have intentional layered
 * configurations where the JSON value differs from the file default
 * (e.g., dev endpoint in JSON, prod default baked into file). Auto-
 * moving the value loses that distinction. Manual migration after
 * seeing the warning is the conservative choice; auto-migration can
 * be a future enhancement once the patterns are well-understood.
 *
 * Returns a sorted, deduplicated list of keys (without the `env.`
 * prefix — caller formats them). Empty when settings.local.json is
 * absent / has no `env` block / has no matching keys / is malformed
 * (silent on malformed: settings-writer.ts surfaces parse errors via
 * its other code paths; we don't double-report).
 */
export function detectSettingsLocalEnvKeys(
  projectDir: string,
): readonly string[] {
  const absDir = resolve(projectDir);
  const path = join(absDir, '.claude', 'settings.local.json');
  if (!existsSync(path)) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Don't double-report parse errors here; settings-writer.ts
    // surfaces them via its own paths when it touches the file.
    return [];
  }

  const envBlock = parsed['env'];
  if (envBlock === null || typeof envBlock !== 'object') return [];

  const keys = Object.keys(envBlock as Record<string, unknown>).filter(
    (k) => k.startsWith('MACF_') || k.startsWith('OTEL_'),
  );
  return Array.from(new Set(keys)).sort();
}

/**
 * Format the per-key deprecation warning lines for stderr. Returned as
 * a single multi-line string the caller can emit in one
 * `process.stderr.write`. Empty string when `keys` is empty (caller
 * doesn't have to special-case).
 */
export function formatDeprecationWarning(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const lines = [
    `Warning: deprecated env key(s) in .claude/settings.local.json:`,
  ];
  for (const k of keys) {
    lines.push(`  env.${k}`);
  }
  lines.push(
    `  These are still read at runtime by macf_settings_get (backward-compat),`,
    `  but the canonical location is now .claude/.macf/env.* (or env.local.*`,
    `  for operator overrides).`,
    '',
  );
  return lines.join('\n');
}
