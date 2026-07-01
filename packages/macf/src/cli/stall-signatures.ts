/**
 * Distribution + validation of the stall-signature allowlist
 * (`.claude/.macf/stall-signatures.json`) — DR-037 / groundnuty/macf#686, the
 * config `macf fleet resume` matches an idle agent's pane against.
 *
 * The SCHEMA + the matcher + the fire-cap logic live in `@groundnuty/macf-core`
 * (`stall-signatures.ts`) — the tested reference shared with the devops
 * `resume.sh` bash. This CLI module is the fs seam:
 *   - `seedStallSignaturesConfig` writes the canonical seed when the file is
 *     ABSENT, and validates + surfaces errors when it is PRESENT (preserving
 *     operator edits — the allowlist is operator-tunable).
 *
 * Wired into `macf init` / `macf update` / `macf rules refresh`, mirroring the
 * DR-033 `prompt-responses.json` distribution exactly.
 *
 * **Seed-if-absent, never clobber.** Like `prompt-responses.json` (and unlike the
 * canonical scripts, which are overwritten on every update), the allowlist is
 * operator-curated state — signature strings are best-effort across Claude Code
 * versions and an operator tunes them against the real pane. So `macf update` MUST
 * NOT revert an operator's curated allowlist: on update we only VALIDATE an
 * existing file (loud feedback), never rewrite it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  loadStallSignatures,
  STALL_SIGNATURES_SEED,
  type StallSignatureEntry,
} from '@groundnuty/macf-core';

/** Canonical basename of the stall-signature allowlist within `.claude/.macf/`. */
export const STALL_SIGNATURES_FILENAME = 'stall-signatures.json';

/** Absolute path to a workspace's `stall-signatures.json`. */
export function workspaceStallSignaturesPath(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.claude', '.macf', STALL_SIGNATURES_FILENAME);
}

/**
 * Load + validate a workspace's stall-signature allowlist for `macf fleet resume`.
 * Returns the accepted entries, or `null` when the file is ABSENT (the caller
 * falls back to the canonical seed). THROWS `StallSignaturesError` when the file
 * is present-but-invalid (fail-loud — a malformed allowlist must not silently
 * degrade resume to "matches nothing").
 */
export function loadStallSignaturesFromWorkspace(
  workspaceDir: string,
): readonly StallSignatureEntry[] | null {
  const path = workspaceStallSignaturesPath(workspaceDir);
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  return loadStallSignatures(raw);
}

/** Serialize the canonical seed (each entry carries its own `comment`) as pretty JSON. */
function seedContent(): string {
  return `${JSON.stringify(STALL_SIGNATURES_SEED, null, 2)}\n`;
}

/** Outcome of a `seedStallSignaturesConfig` call, for the caller to report. */
export type SeedStallSignaturesResult =
  | { readonly action: 'seeded'; readonly path: string }
  | { readonly action: 'preserved'; readonly path: string; readonly count: number }
  | { readonly action: 'invalid'; readonly path: string; readonly error: string };

/**
 * Seed (if absent) or validate (if present) the workspace stall-signature allowlist.
 *
 *   - ABSENT → write the canonical seed. `action: 'seeded'`.
 *   - PRESENT + valid → parse + count (never rewrite). `action: 'preserved'`.
 *   - PRESENT + invalid (bad JSON / schema / regex) → `action: 'invalid'` with the
 *     error message. NEVER throws — a typo'd config must not break `macf update`;
 *     the caller warns loudly and proceeds (the watcher/resume ignores it).
 */
export function seedStallSignaturesConfig(workspaceDir: string): SeedStallSignaturesResult {
  const path = workspaceStallSignaturesPath(workspaceDir);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seedContent());
    return { action: 'seeded', path };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const entries = loadStallSignatures(raw);
    return { action: 'preserved', path, count: entries.length };
  } catch (err) {
    // A JSON `SyntaxError` and a `StallSignaturesError` are both Error subclasses
    // — surface either message; never throw (a typo'd config must not break update).
    const error = err instanceof Error ? err.message : String(err);
    return { action: 'invalid', path, error };
  }
}

/**
 * Emit human-facing console output for a `seedStallSignaturesConfig` result —
 * shared by the three call sites so the wording stays consistent.
 */
export function reportSeedStallSignatures(result: SeedStallSignaturesResult): void {
  switch (result.action) {
    case 'seeded':
      console.log(`  Resume: seeded stall-signature allowlist to .claude/.macf/${STALL_SIGNATURES_FILENAME}`);
      return;
    case 'invalid':
      console.warn(
        `  Resume: WARNING — .claude/.macf/${STALL_SIGNATURES_FILENAME} is invalid and ` +
          `will be IGNORED by \`macf fleet resume\`: ${result.error}`,
      );
      return;
    case 'preserved':
      console.log(
        `  Resume: preserved existing .claude/.macf/${STALL_SIGNATURES_FILENAME} ` +
          `(${result.count} signature${result.count === 1 ? '' : 's'})`,
      );
      return;
  }
}
