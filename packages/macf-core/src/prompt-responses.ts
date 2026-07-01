/**
 * Interactive-prompt auto-responder — config schema, the Inv-2 ceremony-only
 * classifier, and the pure Inv-1/Inv-3 frame matcher (DR-033, groundnuty/macf#645).
 *
 * SAFETY-CRITICAL. This module holds the *pure* logic behind the auto-responder:
 * the config the operator curates in `.claude/.macf/prompt-responses.json`, the
 * rules for what may go on the allowlist, and the frame-matching that decides
 * whether a captured tmux pane is a KNOWN ceremony prompt we may answer. The
 * shell watcher (`scripts/macf-prompt-watcher.sh`) reimplements the SAME
 * algorithm in bash+jq for runtime; this module is the tested reference spec +
 * the validator the CLI runs at `macf init/update/rules refresh`. The two MUST
 * stay in lockstep — a change here is a change there.
 *
 * The three constitutional invariants (DR-033 §Decision):
 *
 *   Inv 1 — allowlist-only. Only auto-answer a prompt matching a vetted entry.
 *     An unrecognized prompt-like frame → the caller ALERTs and does NOT answer.
 *     `matchPromptFrame` returns `unknown-prompt` for that case; the watcher
 *     turns it into a loud forensic-log + stderr alert. Silence-on-unknown beats
 *     a wrong answer.
 *
 *   Inv 2 — ceremony-acks ONLY. The config loader HARD-REFUSES (drops) any entry
 *     whose signature material contains an authorization/destructive substring
 *     (`delete` / `overwrite` / `trust`) and LOUD-WARNS (keeps, operator-owned
 *     risk) on `(y/n)` / `allow` / `permission` / `grant`. This constrains what
 *     may go ON the allowlist — the stronger sibling of Inv 1.
 *
 *   Inv 3 — the signature GUARANTEES the `send` still means the intended option.
 *     A structured signature (`frame_contains` + `option_text` at the `send`
 *     ordinal's rendered position) — NOT a fragile substring. A menu reorder /
 *     reword / insert breaks the match → falls through to Inv 1 (alert, don't
 *     answer) rather than firing a now-wrong ordinal. The signature is not "what
 *     prompt is this"; it is "is the world still exactly as the `send` assumes".
 */
import { z } from 'zod';
import { MacfError } from './errors.js';

/** Config schema version. Bump on a breaking shape change. */
export const PROMPT_RESPONSES_SCHEMA_VERSION = '1' as const;

/**
 * Inv 2 — HARD-REFUSE substrings. An entry whose signature material contains any
 * of these (case-insensitive) is DROPPED at load: the auto-responder must never
 * answer a destructive-confirmation or a folder/tool-trust prompt, even if an
 * operator tries to allowlist it (DR-033 OQ1 lean: hard-refuse the most
 * dangerous). Kept in lockstep with `PROMPT_REFUSE_SUBSTRINGS` in the watcher.
 * `revoke`/`remove` are the security/destructive siblings of `delete`/`trust`
 * ("revoke token?" / "remove collaborator?") — same never-even-if-allowlisted
 * class (science review of macf#645).
 */
export const PROMPT_REFUSE_SUBSTRINGS = ['delete', 'overwrite', 'trust', 'revoke', 'remove'] as const;

/**
 * Inv 2 — LOUD-WARN substrings. An entry whose signature material contains any
 * of these is KEPT (operator-owned risk) but flagged loudly at load: these lean
 * authorization-shaped, so the operator should confirm they meant a ceremony ack
 * and not a permission grant. Kept in lockstep with the watcher.
 */
export const PROMPT_WARN_SUBSTRINGS = ['(y/n)', 'allow', 'permission', 'grant'] as const;

/** Thrown when the prompt-responses config fails schema validation. */
export class PromptResponderError extends MacfError {
  constructor(message: string) {
    super('PROMPT_RESPONDER_ERROR', message);
    this.name = 'PromptResponderError';
  }
}

/**
 * A single allowlist entry — the STRUCTURED signature that resolves DR-033 OQ2
 * (Inv 3). `frame_contains` identifies WHICH prompt (all substrings must be
 * present); `option_text` is the EXACT rendered text at the `send` ordinal's
 * line, so `send`↔option binding is machine-checkable, not a fragile substring.
 *
 *   - `frame_contains` — substrings that MUST ALL be present in the captured
 *     frame (Inv 1 identity). Requiring all present also doubles as the
 *     "wait for the full frame rendered" gate.
 *   - `option_text` — the exact rendered option text at the `send` position
 *     (Inv 3 binding). Must appear on a menu line numbered `send`.
 *   - `send` — the keystroke(s) to send, typically a menu ordinal ("1" / "2").
 *   - `verify_contains` — OPTIONAL expected substring of the POST-answer
 *     next-screen (Inv-A "verify the RIGHT outcome"). When set, the watcher
 *     asserts it appears after sending; when unset the watcher verifies
 *     signature-clearance only + logs that the outcome check was weaker.
 *   - `max_fires` — per-prompt fire cap (default 1). An auto-responder that
 *     fires repeatedly on a recurring pattern is itself a hazard.
 *
 * `.strict()` so an operator typo in a field name (e.g. `frame_contain`) is a
 * loud validation error, not a silently-ignored field.
 */
export const PromptResponseEntrySchema = z
  .object({
    name: z.string().min(1),
    frame_contains: z.array(z.string().min(1)).min(1),
    option_text: z.string().min(1),
    send: z.string().min(1),
    verify_contains: z.string().min(1).optional(),
    max_fires: z.number().int().positive().default(1),
  })
  .strict();
export type PromptResponseEntry = z.infer<typeof PromptResponseEntrySchema>;

/**
 * The whole config. Top-level is deliberately NON-strict (unknown keys stripped,
 * not rejected) so the shipped seed can carry a `_comment` operator-note field
 * without failing validation. Entries stay strict.
 */
export const PromptResponsesConfigSchema = z.object({
  schema_version: z.literal(PROMPT_RESPONSES_SCHEMA_VERSION),
  entries: z.array(PromptResponseEntrySchema).default([]),
});
export type PromptResponsesConfig = z.infer<typeof PromptResponsesConfigSchema>;

/** Inv-2 classification of a single entry's signature material. */
export type SignatureClass = 'refuse' | 'warn' | 'ok';

/**
 * The signature material Inv-2 classification scans: the entry's identifying
 * fields, lowercased + joined. Deliberately includes `name` + every
 * `frame_contains` needle + `option_text` — an authorization-shaped substring
 * anywhere in what the entry MATCHES ON is enough to refuse/warn.
 */
function signatureText(entry: PromptResponseEntry): string {
  return [entry.name, ...entry.frame_contains, entry.option_text].join('\n').toLowerCase();
}

/** First refuse/warn substring present in the entry, or undefined. */
function firstSubstring(entry: PromptResponseEntry, list: readonly string[]): string | undefined {
  const hay = signatureText(entry);
  return list.find((s) => hay.includes(s));
}

/**
 * Classify an entry against the Inv-2 substring lists. `refuse` wins over `warn`
 * (the destructive/trust list is checked first). Substring match is intentional
 * and over-refuse-safe: better to reject a benignly-worded entry than to admit a
 * dangerous one.
 */
export function classifyPromptSignature(entry: PromptResponseEntry): SignatureClass {
  if (firstSubstring(entry, PROMPT_REFUSE_SUBSTRINGS) !== undefined) return 'refuse';
  if (firstSubstring(entry, PROMPT_WARN_SUBSTRINGS) !== undefined) return 'warn';
  return 'ok';
}

/** One refused/warned entry + the substring that triggered the classification. */
export interface ClassifiedEntry {
  readonly entry: PromptResponseEntry;
  readonly matched: string;
}

/**
 * The result of loading + Inv-2-filtering a config: the `accepted` entries the
 * watcher may act on (refused entries DROPPED per Inv 2 hard-refuse), plus the
 * `refused` + `warned` lists so the caller can surface them loudly.
 */
export interface LoadedPromptResponses {
  readonly accepted: readonly PromptResponseEntry[];
  readonly refused: readonly ClassifiedEntry[];
  readonly warned: readonly ClassifiedEntry[];
}

/**
 * Validate + Inv-2-filter a parsed config object. Throws `PromptResponderError`
 * on a schema-invalid shape (loud — never silently proceed on a malformed
 * config). Refuse-classified entries are dropped from `accepted`; warn-classified
 * entries stay in `accepted` (operator-owned risk) but are also listed in
 * `warned`.
 */
export function loadPromptResponses(raw: unknown): LoadedPromptResponses {
  const parsed = PromptResponsesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PromptResponderError(
      `prompt-responses config is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const accepted: PromptResponseEntry[] = [];
  const refused: ClassifiedEntry[] = [];
  const warned: ClassifiedEntry[] = [];
  for (const entry of parsed.data.entries) {
    const cls = classifyPromptSignature(entry);
    if (cls === 'refuse') {
      refused.push({ entry, matched: firstSubstring(entry, PROMPT_REFUSE_SUBSTRINGS) ?? '' });
      continue; // Inv 2 hard-refuse: DROP — never expose to the matcher.
    }
    if (cls === 'warn') {
      warned.push({ entry, matched: firstSubstring(entry, PROMPT_WARN_SUBSTRINGS) ?? '' });
    }
    accepted.push(entry);
  }
  return { accepted, refused, warned };
}

/**
 * Prompt-like frame detector (Inv 1). A frame that matches no allowlist entry
 * but LOOKS like an interactive prompt (a `❯` selector or a `(y/n)`-style
 * confirmation) is the dangerous case: an unknown prompt we must NOT answer.
 * Broad on purpose — false-positive (alert on a non-prompt) is cheap; a
 * false-negative (miss a real unknown prompt) is the hazard.
 *
 * `❯` is overloaded (groundnuty/macf#729): it is BOTH the menu-selection
 * cursor on a real numbered ceremony prompt (`❯ 1. Yes`) AND the Claude Code
 * free-form input-box cursor (`❯ <queued/typed text>`). A bare `frame.includes('❯')`
 * misclassified a queued message in the input box as an unknown prompt,
 * firing repeated ALERT spam. Match only when `❯` sits directly on a
 * NUMBERED OPTION line — that excludes the free-form input box (whose text
 * after `❯` is not `[0-9]+[.)]`) while still catching real numbered menus.
 * Kept in lockstep with the watcher's bash `_looks_prompt_like`.
 */
export function looksPromptLike(frame: string): boolean {
  if (/❯[ \t]*[0-9]+[.)]/.test(frame)) return true;
  return /\((?:y\/n|y\/N|Y\/n)\)|\[(?:y\/N|Y\/n|y\/n)\]/.test(frame);
}

/**
 * Inv 3 binding: does `optionText` render on a menu line numbered `send`?
 *
 * For a numeric `send` (the common menu-ordinal case), the line containing
 * `optionText` must, after stripping any leading selector glyph / whitespace
 * (`❯ 1. …`), START with the `send` ordinal followed by a boundary — so a menu
 * reorder that moves `optionText` to a differently-numbered line breaks the
 * match. For a non-numeric `send` there is no ordinal to bind to, so presence of
 * `optionText` is the binding (weaker; the seeds + realistic launch menus are
 * numbered).
 */
export function optionOnSendLine(frame: string, optionText: string, send: string): boolean {
  const numeric = /^[0-9]+$/.test(send);
  for (const line of frame.split(/\r?\n/)) {
    if (!line.includes(optionText)) continue;
    if (!numeric) return true;
    // Strip the leading run of non-alphanumeric chars (whitespace + any
    // selector glyph, incl. multibyte `❯`), then require the line to START with
    // `send` followed by a non-alphanumeric boundary (or end-of-line), so `1`
    // matches `1.` / `1)` / `1 ` but NOT `10`. Kept identical to the watcher's
    // awk `_option_on_send_line`.
    const stripped = line.replace(/^[^0-9A-Za-z]+/, '');
    if (!stripped.startsWith(send)) continue;
    const rest = stripped.charAt(send.length); // '' when send is the whole token
    if (rest === '' || !/[0-9A-Za-z]/.test(rest)) return true;
  }
  return false;
}

/**
 * Does the frame match this specific allowlist entry? All `frame_contains`
 * present (Inv 1 identity + full-render gate) AND `option_text` present AND
 * `option_text` on a line numbered `send` (Inv 3 binding).
 */
export function entryMatchesFrame(frame: string, entry: PromptResponseEntry): boolean {
  for (const needle of entry.frame_contains) {
    if (!frame.includes(needle)) return false;
  }
  if (!frame.includes(entry.option_text)) return false;
  return optionOnSendLine(frame, entry.option_text, entry.send);
}

/** Outcome of matching a captured frame against the accepted allowlist. */
export type MatchResult =
  | { readonly kind: 'match'; readonly entry: PromptResponseEntry }
  | { readonly kind: 'unknown-prompt' }
  | { readonly kind: 'none' };

/**
 * Match a captured tmux frame against the accepted allowlist (Inv 1 + Inv 3).
 * Returns the first matching entry; else `unknown-prompt` when the frame looks
 * prompt-like (→ caller alerts, never answers); else `none` (no prompt / the
 * agent's own output).
 */
export function matchPromptFrame(
  frame: string,
  entries: readonly PromptResponseEntry[],
): MatchResult {
  for (const entry of entries) {
    if (entryMatchesFrame(frame, entry)) return { kind: 'match', entry };
  }
  return looksPromptLike(frame) ? { kind: 'unknown-prompt' } : { kind: 'none' };
}

/** Per-prompt fire cap (Inv operational guard): may this entry fire again? */
export function canFire(entry: PromptResponseEntry, firedCount: number): boolean {
  return firedCount < entry.max_fires;
}

/**
 * Outcome verification after a send (DR-033 "verify the RIGHT outcome"):
 *   - `not-cleared` — the same signature STILL matches: the send had no effect
 *     (the RC typed-but-no-Enter hazard, silent-fallback Instance 3). Retry/alert.
 *   - `wrong-outcome` — signature cleared BUT `verify_contains` (the expected
 *     next-screen marker) is absent: a *wrong* answer also clears the prompt.
 *   - `ok` — signature cleared AND `verify_contains` present.
 *   - `weak-ok` — signature cleared, no `verify_contains` configured: the
 *     watcher can only confirm clearance, not correctness (logged as weaker).
 */
export type VerifyResult = 'ok' | 'weak-ok' | 'not-cleared' | 'wrong-outcome';

export function verifyOutcome(afterFrame: string, entry: PromptResponseEntry): VerifyResult {
  if (entryMatchesFrame(afterFrame, entry)) return 'not-cleared';
  if (entry.verify_contains !== undefined) {
    return afterFrame.includes(entry.verify_contains) ? 'ok' : 'wrong-outcome';
  }
  return 'weak-ok';
}

/**
 * The canonical seed config `macf init` writes when no `prompt-responses.json`
 * exists yet. Two ceremony-ack entries vetted to Inv 2 (neither signature
 * contains a refuse/warn substring). The exact rendered text of a launch prompt
 * can only be confirmed by an OPERATOR live-verify (the prompts don't render in
 * `-p` mode), so a seed that doesn't exactly match a real prompt fails SAFE —
 * the frame falls through to Inv 1 (unknown-prompt alert), never a wrong answer.
 * Operators tune the exact `frame_contains` / `option_text` against the real
 * pane, then the ceremony auto-clears.
 */
export const PROMPT_RESPONSES_SEED: PromptResponsesConfig = {
  schema_version: PROMPT_RESPONSES_SCHEMA_VERSION,
  entries: [
    {
      name: 'dev-channels',
      frame_contains: ['I am using this for local development'],
      option_text: 'I am using this for local development',
      send: '1',
      max_fires: 1,
    },
    {
      name: 'resume-summary',
      frame_contains: ['Resume full session as-is'],
      option_text: 'Resume full session as-is',
      send: '2',
      max_fires: 1,
    },
  ],
};
