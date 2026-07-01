/**
 * Distribution + validation of the interactive-prompt auto-responder config
 * (`.claude/.macf/prompt-responses.json`) — DR-033, groundnuty/macf#645.
 *
 * The SCHEMA + the Inv-2 classifier + the frame matcher live in
 * `@groundnuty/macf-core` (`prompt-responses.ts`) — the tested reference logic
 * shared with the runtime shell watcher. This CLI module is the fs seam:
 *   - `seedPromptResponsesConfig` writes the canonical seed when the file is
 *     ABSENT, and validates + surfaces Inv-2 refusals/warnings when it is
 *     PRESENT (preserving operator edits — the config is operator-extensible).
 *
 * Wired into `macf init` / `macf update` / `macf rules refresh`, mirroring the
 * canonical-scripts + project-rules-seed distribution.
 *
 * **Seed-if-absent, never clobber.** Unlike the canonical scripts (overwritten
 * on every update so a CLI bump propagates), the config is operator-curated
 * state (like `env.telemetry` / `env.tmux`), so `macf update` MUST NOT revert an
 * operator's careful allowlist. On update we only VALIDATE an existing file
 * (loud Inv-2 feedback), never rewrite it. A signature drift is caught at
 * runtime by the watcher's unknown-prompt alert, and the operator updates the
 * entry — the DR's operator-owned model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  loadPromptResponses,
  PROMPT_RESPONSES_SEED,
  type LoadedPromptResponses,
} from '@groundnuty/macf-core';

/** Canonical basename of the auto-responder config within `.claude/.macf/`. */
export const PROMPT_RESPONSES_FILENAME = 'prompt-responses.json';

/** Absolute path to a workspace's `prompt-responses.json`. */
export function workspacePromptResponsesPath(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.claude', '.macf', PROMPT_RESPONSES_FILENAME);
}

/**
 * Operator-facing note embedded in the seed as a top-level `_comment` (stripped
 * by the schema on load — the config object is non-strict). Explains the
 * operator-tunable + live-verify-only nature.
 */
const SEED_COMMENT =
  'Interactive-prompt auto-responder allowlist (DR-033 / groundnuty/macf#645). ' +
  'ONLY vetted ceremony prompts are auto-answered; unknown prompt-like frames are ' +
  'alerted, never answered (Inv 1). Entries whose signature contains delete/overwrite/trust ' +
  'are hard-refused at load; (y/n)/allow/permission/grant are loud-warned (Inv 2). ' +
  'The exact prompt text can only be confirmed by an operator live-launch (the prompts do ' +
  'not render in `claude -p`), so tune frame_contains/option_text against the real pane — ' +
  'an imperfect signature fails SAFE (falls through to an unknown-prompt alert, never a ' +
  'wrong answer). Set verify_contains to a post-answer next-screen marker for full ' +
  'outcome verification. Disable the watcher entirely with MACF_PROMPT_AUTORESPOND_DISABLED=1.';

/** Serialize the canonical seed (with the operator `_comment`) as pretty JSON. */
function seedContent(): string {
  return `${JSON.stringify({ _comment: SEED_COMMENT, ...PROMPT_RESPONSES_SEED }, null, 2)}\n`;
}

/** Outcome of a `seedPromptResponsesConfig` call, for the caller to report. */
export type SeedPromptResponsesResult =
  | { readonly action: 'seeded'; readonly path: string }
  | { readonly action: 'preserved'; readonly path: string; readonly loaded: LoadedPromptResponses }
  | { readonly action: 'invalid'; readonly path: string; readonly error: string };

/**
 * Seed (if absent) or validate (if present) the workspace auto-responder config.
 *
 *   - ABSENT → write the canonical seed. `action: 'seeded'`.
 *   - PRESENT + valid → parse + Inv-2-classify (never rewrite). `action:
 *     'preserved'` with the loaded accepted/refused/warned split so the caller
 *     can print loud Inv-2 feedback.
 *   - PRESENT + invalid (bad JSON / schema) → `action: 'invalid'` with the error
 *     message. NEVER throws — a typo'd config must not break `macf update`; the
 *     caller warns loudly and proceeds.
 */
export function seedPromptResponsesConfig(workspaceDir: string): SeedPromptResponsesResult {
  const path = workspacePromptResponsesPath(workspaceDir);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seedContent());
    return { action: 'seeded', path };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const loaded = loadPromptResponses(raw);
    return { action: 'preserved', path, loaded };
  } catch (err) {
    // Both a JSON `SyntaxError` and a schema `PromptResponderError` are Error
    // subclasses — surface either message; never throw (a typo'd config must
    // not break `macf update`).
    const error = err instanceof Error ? err.message : String(err);
    return { action: 'invalid', path, error };
  }
}

/**
 * Emit human-facing console output for a `seedPromptResponsesConfig` result —
 * the loud Inv-2 surface at `macf init/update/rules refresh` time. Shared by the
 * three call sites so the wording stays consistent.
 */
export function reportSeedPromptResponses(result: SeedPromptResponsesResult): void {
  switch (result.action) {
    case 'seeded':
      console.log(`  Prompts: seeded auto-responder config to .claude/.macf/${PROMPT_RESPONSES_FILENAME}`);
      return;
    case 'invalid':
      console.warn(
        `  Prompts: WARNING — .claude/.macf/${PROMPT_RESPONSES_FILENAME} is invalid and ` +
          `will be IGNORED by the watcher: ${result.error}`,
      );
      return;
    case 'preserved': {
      const { accepted, refused, warned } = result.loaded;
      console.log(
        `  Prompts: preserved existing .claude/.macf/${PROMPT_RESPONSES_FILENAME} ` +
          `(${accepted.length} accepted entr${accepted.length === 1 ? 'y' : 'ies'})`,
      );
      for (const r of refused) {
        console.warn(
          `  Prompts: REFUSED entry "${r.entry.name}" — signature contains ` +
            `authorization/destructive substring "${r.matched}" (Inv 2 hard-refuse; entry dropped)`,
        );
      }
      for (const w of warned) {
        console.warn(
          `  Prompts: WARN entry "${w.entry.name}" — signature contains ` +
            `authorization-shaped substring "${w.matched}" (Inv 2 loud-warn; kept, operator-owned risk)`,
        );
      }
      return;
    }
  }
}
