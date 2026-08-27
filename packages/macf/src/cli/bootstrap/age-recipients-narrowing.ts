/**
 * `transport.age_recipients` narrowing pre-flight — groundnuty/macf#1230.
 * Mirrors `registry-scope-preflight.ts`'s shape (macf#999): a pure,
 * manifest-and-lock-only check callable before ANY observe/plan-render/
 * consent-gate work. `commands/bootstrap-apply.ts` calls
 * {@link checkAgeRecipientsNarrowing} directly, at the same call site
 * `checkRegistryScopePreflight` occupies, to actually refuse.
 *
 * **The defect this refuses.** `transport.age_recipients` lists the keys
 * that can decrypt the fleet vault. Narrowing that list does not take
 * access away from the removed recipient: the EXISTING vault stays
 * decryptable by the removed key, re-encrypting protects only FUTURE
 * copies, and anyone holding a prior copy (a backup, a checkout, a laptop)
 * keeps access permanently. That is inherent to the cryptography, not a gap
 * in `apply` — but the manifest READS as a revocation, and an operator
 * narrowing the list will reasonably believe access was withdrawn. The
 * operator's ruling (macf#1230) is REFUSE, not "re-encrypt and warn":
 * re-encryption is the action that *looks* like it solves the problem and
 * does not, so implementing it here would make the field read even more
 * like a working revocation than it does today. Real revocation requires
 * rotating the CA and re-issuing everything the old vault protected
 * (`#867`'s ladder) — a manifest edit cannot do it.
 *
 * **Compares against `fleet.lock`'s RECORDED set, never the live vault.**
 * `plan.ts::vaultRecipientsItem` (DR-043 §D5, macf#957) already compares
 * the manifest against the vault's OBSERVED age-header stanza COUNT — but
 * that comparison (a) only runs when `--vault`/`--identity-key` were given
 * this run (the vault-free default is the common case) and (b) is a COUNT,
 * not an identity — it can tell "fewer stanzas" from "more stanzas" but
 * never tells you WHICH recipient a shrink dropped. This module's
 * comparison needs neither a vault nor a decrypt: `fleet.lock`'s
 * `age_recipients` field (`fleet-manifest.ts::FleetLockSchema`) records the
 * actual recipient PUBLIC KEYS `apply` last applied, so this check runs
 * from two local files (`fleet.yaml` + `fleet.lock`) alone, every run,
 * regardless of vault flags — and it can name the exact recipient(s)
 * removed, per AC 6, because it compares identities, not counts.
 *
 * **Not in conflict with `vaultRecipientsItem`** — the two are different
 * axes checked at different times, and BOTH stay wired: this check fires
 * from `fleet.lock` alone, unconditionally; `vaultRecipientsItem` fires
 * from a LIVE vault read, only when one was attempted, and its own
 * "MORE stanzas than declared" branch already refuses to auto-shrink
 * (`update`+`confirm_required`, never a silent re-encrypt) — see that
 * function's doc. Neither branch is touched by this module; a `fleet.lock`
 * that predates the `age_recipients` field (every fleet provisioned before
 * groundnuty/macf#1252) makes THIS check a no-op (nothing recorded to
 * compare against) — `vaultRecipientsItem` remains the only live signal
 * for such a fleet until one `apply` run writes the field.
 *
 * **The comparison rule: refuse iff the recorded set has a member the
 * desired set lacks — a set difference, not a length comparison.** A pure
 * length check (`desired.length < recorded.length`) would miss a SWAP
 * (drop recipient B, add recipient C in the same edit): the length is
 * unchanged, but B's access was just as silently "revoked" (i.e. not
 * really) as in a pure narrowing. The defect is about ANY recipient losing
 * declared trust, not about the set getting numerically smaller — so
 * "recorded minus desired is non-empty" is the correct predicate, and it
 * subsumes strict-subset narrowing as one case. A pure widening (desired a
 * superset of recorded) has an EMPTY removed-set and is never refused —
 * per AC 5, adding a recipient must stay completely frictionless, not even
 * a notice.
 */
import type { FleetLock } from './fleet-manifest.js';
import { AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT } from './fleet-manifest.js';

/** Distinct from `REGISTRY_SCOPE_UNSATISFIABLE_CODE` / `'app_name_too_long'` / `'vault_flags_incomplete'` — lets a caller/log tell this argument-boundary refusal apart from its siblings. */
export const AGE_RECIPIENTS_NARROWED_CODE = 'age_recipients_narrowed';

/**
 * The shape `commands/bootstrap-apply.ts::renderFailure` and `plan.ts`'s own
 * `FleetPlanFailure` both accept — see `registry-scope-preflight.ts::RegistryScopeConflict`'s
 * doc for why this is defined locally rather than imported from either.
 */
export interface AgeRecipientsNarrowingConflict {
  readonly code: typeof AGE_RECIPIENTS_NARROWED_CODE;
  readonly message: string;
  /** The recipient(s) present in `fleet.lock`'s recorded set but absent from the desired manifest set — named explicitly per AC 6, never just "the set shrank." */
  readonly removed: readonly string[];
}

/**
 * The recorded-minus-desired set difference this whole module is built on —
 * extracted so `fleet-lock.ts`'s ledger-write path (macf#1230 AC 4) can ask
 * the SAME question `checkAgeRecipientsNarrowing` refuses on, without
 * duplicating the predicate. Pure; zero I/O.
 *
 * Returns `[]` (never refuses-shaped) whenever there is nothing recorded to
 * compare against (`priorLock` absent, or its lock predates the
 * `age_recipients` field, or it legitimately recorded an empty set) — same
 * "`undefined`/`[]` recorded means nothing removable" reasoning
 * {@link checkAgeRecipientsNarrowing} uses.
 */
export function removedAgeRecipients(desired: readonly string[], priorLock: FleetLock | null): readonly string[] {
  const recorded = priorLock?.age_recipients;
  if (recorded === undefined || recorded.length === 0) return [];

  const desiredSet = new Set(desired);
  return recorded.filter((r) => !desiredSet.has(r));
}

/**
 * Whitespace-normalize for the override-text comparison — collapse any run
 * of whitespace (including YAML line-folding newlines) to a single space
 * and trim the ends. Deliberately NOT a byte-exact `===`: YAML block/folded
 * scalars can reflow a long string's internal line breaks without changing
 * its meaning, and a byte-exact requirement would give an operator who
 * copied {@link AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT} correctly (verbatim,
 * meaning-preserving) a cryptic "doesn't match" refusal anyway — the exact
 * operator-hostile-surface failure mode this fleet's last 14 consent-gate
 * defects were about. This is NOT a fuzzy/approximate match — it still
 * requires the SAME words in the SAME order, just tolerant of how much
 * whitespace separates them.
 */
function normalizeOverrideText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

const NORMALIZED_OVERRIDE_TEXT = normalizeOverrideText(AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT);

/**
 * `true` when `override` is present and (whitespace-normalized) matches the
 * required acknowledgment text exactly. `undefined`/absent is NOT an
 * override — that is the ordinary "operator hasn't acknowledged anything"
 * case, distinct from "operator supplied SOMETHING but it's wrong" (a stale
 * copy, a paraphrase, `"true"`) — both produce `false` here, but the
 * refusal message this module builds treats them identically on purpose
 * (either way, the correct next step is "paste the exact text").
 *
 * Exported (not module-private) so `fleet-lock.ts`'s ledger-write path can
 * ask the identical question this module refuses on, rather than
 * re-deriving "was the override actually valid" from a weaker signal (e.g.
 * "is the field merely present") — see that module's call site doc.
 */
export function overrideAcknowledged(override: string | undefined): boolean {
  return override !== undefined && normalizeOverrideText(override) === NORMALIZED_OVERRIDE_TEXT;
}

/**
 * The macf#1230 pre-flight. `undefined` (no refusal) when:
 *   - `priorLock` is `null`/has no recorded `age_recipients` (first
 *     provision, or a lock predating this field — nothing to compare
 *     against, and that absence is honest, not a false-clean "matches");
 *   - the recorded set has NO member absent from `desired` (identical,
 *     or a pure widening — see this module's doc for why a set
 *     difference, not a length comparison, is the correct predicate);
 *   - a narrowing exists but `override` is present and matches
 *     {@link AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT} exactly
 *     (whitespace-normalized).
 *
 * Otherwise returns a conflict naming every removed recipient. Pure; zero
 * I/O; safe to call before ANY provisioning step — same "assert the gate
 * seam is never invoked" contract `checkAppNameLengths`/
 * `checkRegistryScopePreflight` establish.
 */
/**
 * groundnuty/macf#1230 — TRUE when this fleet's lock records no recipient set,
 * so a narrowing CANNOT be detected. Distinct from "compared, nothing removed":
 * the honest-unknown floor at this guard's boundary. An absent record is
 * `unknown`, NOT `unchanged`, and must not silently permit a narrowing it
 * cannot see. Refusing here would block every pre-#1252 fleet's next apply —
 * worse than the exposure — so the caller PROCEEDS and says so.
 */
export function ageRecipientsRecordAbsent(priorLock: FleetLock | null): boolean {
  const recorded = priorLock?.age_recipients;
  return recorded === undefined || recorded.length === 0;
}

/**
 * The advisory a caller emits when {@link ageRecipientsRecordAbsent} holds —
 * names the gap and what closes it, rather than passing silently.
 */
export function ageRecipientsRecordAbsentNotice(): string {
  return (
    'transport.age_recipients cannot be checked for narrowing: this fleet\'s lock records no ' +
    'recipient set, so there is nothing to compare against. Proceeding — but if this run REMOVES ' +
    'a recipient, that removal is neither detected nor recorded, and re-encryption would not ' +
    'revoke access to vault copies already held. The next apply records the set and closes the gap.'
  );
}

export function checkAgeRecipientsNarrowing(
  desired: readonly string[],
  priorLock: FleetLock | null,
  override: string | undefined,
): AgeRecipientsNarrowingConflict | undefined {
  const removed = removedAgeRecipients(desired, priorLock);
  if (removed.length === 0) return undefined;

  if (overrideAcknowledged(override)) return undefined;

  return { code: AGE_RECIPIENTS_NARROWED_CODE, removed, message: ageRecipientsNarrowedReason(removed) };
}

/**
 * The refusal text — names every removed recipient (AC 6), states plainly
 * WHY (re-encryption does not revoke access to copies already held, per AC
 * 2), and gives the exact override text to paste (AC 3) rather than making
 * the operator guess the required wording or its field name.
 */
export function ageRecipientsNarrowedReason(removed: readonly string[]): string {
  const list = removed.map((r) => `"${r}"`).join(', ');
  const plural = removed.length > 1;
  return (
    `transport.age_recipients no longer declares ${plural ? 'recipients' : 'recipient'} ${list}, which ` +
    `fleet.lock records as previously granted — refused. Narrowing this list does not revoke ${plural ? 'their' : 'its'} ` +
    'decrypt access to the EXISTING vault: re-encrypting protects only future copies, and any prior copy already held ' +
    `(a backup, a checkout, a laptop) stays readable by ${plural ? 'them' : 'it'} permanently. This is inherent to the ` +
    'cryptography, not something `apply` can fix by re-encrypting — real revocation requires rotating the CA and ' +
    're-issuing everything the old vault protected. If you understand this and want to proceed anyway, add this exact ' +
    'text (copy-paste, do not paraphrase) to fleet.yaml:\n\n' +
    `transport:\n  age_recipients_narrowing_override: "${AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT}"`
  );
}
