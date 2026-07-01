/**
 * Stall-signature allowlist — config schema, the pure pane-matcher, and the
 * per-action fire-cap logic behind `macf fleet resume` (DR-037 / groundnuty/macf#686,
 * porting `groundnuty/macf-devops-toolkit:fleet/resume.sh` + `stall-signatures.json`).
 *
 * SAFETY-CRITICAL. `macf fleet resume` acts on an IDLE agent — an idle agent is one
 * of three things and only the pane tells them apart (operator, 2026-06-28):
 *
 *   - idle-CLEAN (no signature matched)      → legitimately idle/done → DO NOTHING.
 *   - idle-STALLED (rate-limit / turn-abort) → `action: nudge` — resume the SAME
 *     session (a nudge preserves in-progress work; a restart loses it + re-hits a
 *     rate-limit). The gentlest recovery.
 *   - idle-BLOCKED (permission / trust /     → `action: report` — a DURABLE operator
 *     skill / memory prompt)                   alert, NEVER auto-answered (an
 *                                              authorization decision needs a human;
 *                                              DR-033 ceremony-not-authorization).
 *
 * The safety contract is the sibling of DR-033's: **allowlist-only, never a blind
 * nudge.** We act ONLY on an idle agent whose recent pane matches a KNOWN, vetted
 * signature. An unmatched idle pane is legitimately idle/done → never touched (no
 * spam). An unknown-but-blocking prompt falls through to no-match → skip; the
 * operator adds a `report` signature as the TUI evolves (the allowlist is DATA).
 *
 * This module holds the PURE logic — the config the operator curates in
 * `.claude/.macf/stall-signatures.json`, the schema/validator the CLI runs at
 * `macf init/update/rules refresh`, and the frame-matcher the `fleet resume`
 * decision layer drives off. The tested reference is the devops `resume.sh` bash
 * (which reimplements the same match-then-dispatch in bash + jq); the two MUST
 * stay in lockstep.
 */
import { z } from 'zod';
import { MacfError } from './errors.js';

/** A matched stall's dispatched action: nudge a stalled agent, or report a blocked one. */
export const STALL_ACTIONS = ['nudge', 'report'] as const;
export type StallAction = (typeof STALL_ACTIONS)[number];

/**
 * Per-action default fire cap when an entry omits `max_fires` — a nudge is a
 * gentle repeatable resume (retry a few times, then escalate), a report is a
 * one-shot durable alert per episode (re-alerting spams the operator). Mirrors
 * the devops `resume.sh` defaults (`nudge`=3, `report`=1).
 */
export const DEFAULT_NUDGE_MAX_FIRES = 3;
export const DEFAULT_REPORT_MAX_FIRES = 1;

/** Thrown when the stall-signatures config fails schema / regex validation. */
export class StallSignaturesError extends MacfError {
  constructor(message: string) {
    super('STALL_SIGNATURES_ERROR', message);
    this.name = 'StallSignaturesError';
  }
}

/**
 * A single stall-signature allowlist entry.
 *
 *   - `name` — the signature's stable identifier (rendered in the plan / the
 *     alert title, so a fire-cap counter can key off it).
 *   - `signature` — a regular-expression source matched CASE-INSENSITIVELY against
 *     the captured idle pane (the ERE the devops bash greps with `grep -qiE`; the
 *     seeds' alternation/`\?`/`\.` forms are JS-RegExp-compatible). Validated for
 *     compilability at load — a malformed pattern is a LOUD config error, never a
 *     silent non-match.
 *   - `action` — `nudge` (resume a stalled agent) or `report` (durable alert for a
 *     blocked agent; NEVER auto-answered). Defaults to `nudge`.
 *   - `nudge` — the text sent into the TUI for `action: nudge` (default: a generic
 *     "please continue").
 *   - `report` — the operator-facing summary for `action: report` (default: a
 *     generic "blocked on an operator-input prompt").
 *   - `max_fires` — per-episode fire cap; omitted → the per-action default.
 *   - `comment` — operator documentation (why this signature; caveats). Ignored by
 *     the matcher; kept in the schema so the seed's `comment` fields validate.
 *
 * `.strict()` so an operator typo in a field name (e.g. `signatures`) is a loud
 * validation error, not a silently-ignored field.
 */
export const StallSignatureEntrySchema = z
  .object({
    name: z.string().min(1),
    signature: z.string().min(1),
    action: z.enum(STALL_ACTIONS).default('nudge'),
    nudge: z.string().min(1).optional(),
    report: z.string().min(1).optional(),
    max_fires: z.number().int().positive().optional(),
    comment: z.string().optional(),
  })
  .strict();
export type StallSignatureEntry = z.infer<typeof StallSignatureEntrySchema>;

/**
 * The whole config: a bare array of entries — the exact shape of the devops
 * `fleet/stall-signatures.json` reference (so the two files are interchangeable).
 */
export const StallSignaturesConfigSchema = z.array(StallSignatureEntrySchema);
export type StallSignaturesConfig = z.infer<typeof StallSignaturesConfigSchema>;

/**
 * Validate + regex-check a parsed config. Throws `StallSignaturesError` on a
 * schema-invalid shape OR an uncompilable `signature` (loud — a malformed
 * allowlist must never silently degrade to "matches nothing"). Returns the
 * accepted entries.
 */
export function loadStallSignatures(raw: unknown): readonly StallSignatureEntry[] {
  const parsed = StallSignaturesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StallSignaturesError(
      `stall-signatures config is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  for (const entry of parsed.data) {
    try {
      // Validate compilability up front (fail-loud). Case-insensitive to mirror
      // the devops `grep -iE`.
      new RegExp(entry.signature, 'i');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new StallSignaturesError(
        `stall-signatures entry "${entry.name}" has an invalid regex signature: ${msg}`,
      );
    }
  }
  return parsed.data;
}

/**
 * The per-episode fire cap for an entry — its explicit `max_fires`, else the
 * per-action default (nudge 3 / report 1).
 */
export function resolveMaxFires(entry: StallSignatureEntry): number {
  if (entry.max_fires !== undefined) return entry.max_fires;
  return entry.action === 'report' ? DEFAULT_REPORT_MAX_FIRES : DEFAULT_NUDGE_MAX_FIRES;
}

/** Fire-cap guard: may this stall-signature fire again given its prior fire count? */
export function canFireStall(entry: StallSignatureEntry, firedCount: number): boolean {
  return firedCount < resolveMaxFires(entry);
}

/**
 * First allowlist entry whose `signature` regex matches the captured pane
 * (case-insensitive), or `null` when the pane matches nothing — the idle-CLEAN
 * case the caller treats as "legitimately idle/done, never touched". Pure.
 *
 * A signature that fails to compile is skipped (defensively) rather than
 * throwing here — `loadStallSignatures` is the fail-loud gate; the matcher stays
 * total so a single bad entry never breaks a whole sweep.
 */
export function matchStallSignature(
  pane: string,
  entries: readonly StallSignatureEntry[],
): StallSignatureEntry | null {
  for (const entry of entries) {
    let re: RegExp;
    try {
      re = new RegExp(entry.signature, 'i');
    } catch {
      continue;
    }
    if (re.test(pane)) return entry;
  }
  return null;
}

/**
 * The canonical seed `macf init` writes when no `stall-signatures.json` exists.
 * Ported verbatim from `groundnuty/macf-devops-toolkit:fleet/stall-signatures.json`
 * (the tested reference). Two `nudge` signatures (transient rate-limit / turn-abort
 * — resume the same session) and three `report` signatures (permission / trust /
 * skill-or-memory prompts — authorization decisions that must NEVER be
 * auto-answered, only surfaced as a durable operator alert).
 *
 * Signature strings are best-effort across Claude Code versions — the allowlist is
 * DATA; an operator tunes it against the real pane as the TUI evolves. An imperfect
 * signature fails SAFE (falls through to no-match → the agent is left untouched,
 * never a wrong action).
 */
export const STALL_SIGNATURES_SEED: StallSignaturesConfig = [
  {
    name: 'rate-limit',
    signature: '(temporarily limiting requests|Rate limited|API Error.*limiting)',
    action: 'nudge',
    nudge:
      'You appear to have stalled on a transient API rate-limit (server-side, not ' +
      'your usage quota). The limit should have cleared — please continue your work ' +
      'where you left off.',
    max_fires: 4,
    comment:
      'Anthropic server-side capacity throttle (NOT the account quota). Leaves the ' +
      'agent idle mid-flow. Nudge resumes the SAME session (preserves work); restart ' +
      'would lose it + re-hit the limit. verify-resumed self-corrects a nudge into a ' +
      'still-active throttle (back off + retry).',
  },
  {
    name: 'turn-aborted',
    signature: '(Request was aborted|aborted by user|API Error: Connection error)',
    action: 'nudge',
    nudge: 'Your last turn aborted before completing. Please continue your work where you left off.',
    max_fires: 3,
    comment:
      'A turn that died on a transient connection/abort error, leaving the agent ' +
      'idle. Same resume-not-restart logic.',
  },
  {
    name: 'permission-prompt',
    signature: '(Do you want to proceed\\?|Do you want to make this edit\\?|Do you want to create|Yes, and don.t ask again)',
    action: 'report',
    report:
      'blocked on a tool-permission prompt ("Do you want to proceed?") — needs the ' +
      'operator to approve/deny. Cannot be auto-answered (an authorization decision, ' +
      'per DR-033 ceremony-not-authorization).',
    max_fires: 1,
    comment:
      'Claude Code tool-permission dialog. action=report (NOT nudge/answer): ' +
      'authorization prompts require human judgment, so the correct automation is to ' +
      'make the silent block LOUD, never to answer it. macf-devops-toolkit#132.',
  },
  {
    name: 'trust-folder-prompt',
    signature: '(Do you trust the files in this folder\\?|trust the files in this)',
    action: 'report',
    report:
      'blocked on a folder-trust prompt — needs the operator to confirm trust. ' +
      'Authorization decision; cannot be auto-answered.',
    max_fires: 1,
    comment: "Claude Code 'trust this folder' dialog on a new/changed workspace. action=report. #132.",
  },
  {
    name: 'skill-or-memory-prompt',
    signature: '(Allow .* to run\\?|Save this to memory\\?|Add this to memory\\?|Allow this skill)',
    action: 'report',
    report:
      'blocked on a skill-approval or memory-accept prompt — needs the operator\'s ' +
      'decision. Cannot be auto-answered.',
    max_fires: 1,
    comment:
      'Skill-approval / memory-accept dialogs. action=report. Signature strings are ' +
      'best-effort across CC versions — the allowlist is DATA, tune as the TUI evolves. #132.',
  },
];
