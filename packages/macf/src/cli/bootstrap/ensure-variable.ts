/**
 * `ensureVariableCreated` — the create-only "ensure a GitHub Actions
 * variable exists with THIS value" primitive, DR-043 Phase 2b (groundnuty/
 * macf#838 Amendment D phase 2, macf#854's CA/routing gap).
 *
 * Mirrors `apply-repo-init.ts::ensureAgentRepo`'s presence-check-then-create
 * shape exactly: check live presence first; a `'present'` result is left
 * COMPLETELY untouched (no value comparison, no update — value drift is a
 * `plan`-level 'update' item, out of this function's job, see
 * `plan.ts::planItemApplyCoverage`'s routing case); an `'absent'`/`'unknown'`
 * result attempts a create.
 *
 * **Why the create-only guarantee does NOT rest on guessing the duplicate
 * status code (macf#838 Phase 2b review).** `variable-write.ts`'s 409-vs-
 * other-error classification is a best-effort CLASSIFIER, not the source of
 * the safety property. The actual guarantee: a CONFIRMED-`absent` presence
 * whose create attempt still reports `'exists'` is ALWAYS a `'failed'`
 * outcome (a race or a stale read — investigate, never silently accept) —
 * the 409-softening below applies ONLY to the `'unknown'` presence case,
 * where the create attempt IS the authoritative signal (there was no
 * confident prior read to contradict). A wrong guess about the status code
 * degrades to "reported failed when it didn't need to be," never to
 * "silently overwrote" — verifiable from this file alone, no network needed.
 */
import type { Presence } from './plan.js';
import type { CreateVariableResult } from './variable-write.js';

export type EnsureVariableOutcome =
  | { readonly status: 'created' }
  | { readonly status: 'already-present' }
  /** The value to write was never determined this run (e.g. an upstream CA resolve failed) — nothing was attempted. */
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface EnsureVariableDeps {
  readonly checkPresence: () => Promise<Presence>;
  readonly create: () => Promise<CreateVariableResult>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create-only ensure. NEVER throws — every failure path resolves to
 * `status: 'failed'`. `label` is a human-readable identifier for the
 * variable being ensured (folded into the failure reason so a caller
 * juggling many concurrent legs — CA registry + N repo legs, routing on N
 * repos — can tell them apart from the reason string alone).
 */
export async function ensureVariableCreated(deps: EnsureVariableDeps, label: string): Promise<EnsureVariableOutcome> {
  let presence: Presence;
  try {
    presence = await deps.checkPresence();
  } catch (err) {
    return { status: 'failed', reason: `${label}: presence check threw — ${errMessage(err)}` };
  }
  if (presence === 'present') return { status: 'already-present' };

  try {
    const result = await deps.create();
    if (result === 'created') return { status: 'created' };
    // result === 'exists' — see module doc for why the branch below is the
    // ONLY place a duplicate-on-create is accepted, and only for 'unknown'.
    if (presence === 'unknown') return { status: 'already-present' };
    return {
      status: 'failed',
      reason:
        `${label}: presence check reported absent, but the create attempt found it already exists — a race or ` +
        'stale read. Refusing to overwrite (create-only). Investigate the current value manually.',
    };
  } catch (err) {
    return { status: 'failed', reason: `${label}: ${errMessage(err)}` };
  }
}

/** A uniform `'skipped'` outcome for every entry in `repos` — used when the value to write was never determined (see `EnsureVariableOutcome`'s `'skipped'` doc). Pure. */
export function skippedOutcomesFor(repos: readonly string[], reason: string): Readonly<Record<string, EnsureVariableOutcome>> {
  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) out[repo] = { status: 'skipped', reason };
  return out;
}

/**
 * A uniform `'failed'` outcome for every entry in `repos` — the `'failed'`
 * sibling of {@link skippedOutcomesFor}, for a write that was REFUSED
 * outright (a policy precondition wasn't met — e.g. `apply-routing.ts`'s
 * `noRunnerTokenReason`, macf#929) rather than merely "not determined yet."
 * The distinction matters at the exit-code boundary
 * (`commands/bootstrap-apply.ts::applyExitCode`): a `'skipped'` leg is an
 * honest incomplete that does NOT fail the run (mirrors an ordinary
 * register-before-route gap); a `'failed'` leg DOES — same posture as
 * `apply-fleet.ts::noRecipientPreflightFailure`'s pre-flight refusal, which
 * also resolves to `'failed'`, never `'skipped'`. Pure.
 */
export function failedOutcomesFor(repos: readonly string[], reason: string): Readonly<Record<string, EnsureVariableOutcome>> {
  const out: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) out[repo] = { status: 'failed', reason };
  return out;
}
