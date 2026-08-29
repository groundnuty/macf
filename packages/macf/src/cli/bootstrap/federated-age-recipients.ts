/**
 * The federated-peer age-recipient reconcile guard — groundnuty/macf#1330,
 * settling the fork `#789` recorded rather than resolved (that issue's own
 * comment thread; ruling quoted below is verbatim from its last comment).
 *
 * **The primitive this closes.** `#789` (safe secret-transport over A2A)
 * deferred on one missing fact: a sender fleet knows a federated peer's
 * TRANSPORT trust (`FleetCollaboratorSchema.ca_bundle`, `#786`) but has no
 * way to learn its AT-REST trust — which age keys may decrypt a vault sealed
 * to it. `federated_cas` (`packages/macf-core/src/guest.ts`) federates only
 * CA trust (who may connect); it carries no recipient key material at all
 * (verified: `age_recipients` occurs zero times in that file, and zero times
 * in `FleetCollaboratorSchema` — see `fleet-manifest.ts`'s own doc on
 * {@link FleetLockCollaboratorSchema} for the corrected-in-thread finding
 * that the schema search space itself needed re-verifying first).
 *
 * **The ruling this module implements, verbatim (`#1330`'s last comment):**
 *
 * ```
 * the CHANNEL   supplies the peer's CURRENT set     (fresh, authenticated, unpinned)
 * fleet.lock    pins the LAST-APPROVED set          (what we agreed to, recorded)
 * the guard     fires on the DIFF between them
 * ```
 *
 * "The manifest declares intent; the lock records fact. A peer's recipient
 * set is not intent — we do not choose it — and not live-only — we must
 * remember what we approved." The four-row matrix the ruling settles on:
 *
 * ```
 * lock has it, live MATCHES   →  noop
 * lock has it, live GREW      →  a grant — enumerate, NAME the added keys, require consent
 * lock has it, live SHRANK    →  the peer revoked; safe, but SAY SO (they may not be reachable)
 * lock has none yet           →  first federation — the whole set is the grant, consent once
 * ```
 *
 * **No new machinery** — this module reuses `#1286`'s enumerate-and-name
 * consent shape (`apply-delete.ts`/`formatDeletionEnumerationLines`'s "name
 * every item, never just a count") and `#1252`'s undefined-means-unknown
 * rule; it does not import `age-recipients-narrowing.ts`'s override
 * mechanism, because that guard's DIRECTION is inverted for a federated
 * peer: *"Narrowing is the hazard locally because it does not revoke.
 * Widening is the hazard federally because it grants. Same field, opposite
 * guard"* (`#1330`, comment 2) — importing the local guard's
 * `age_recipients_narrowing_override` acknowledgment text here would be
 * "saying so in the wrong direction," which the ruling explicitly calls out
 * as worse than saying nothing.
 *
 * **Deliberately NOT wired into `apply`/`plan` in this change.**
 * `FleetCollaboratorSchema`'s reconciliation is still day-2
 * (`plan.ts`'s `skipped_sections`, reason `'reconcile not implemented in
 * v1'`) and `#789`'s fetch — the mechanism that would ask a peer for its
 * CURRENT set over the authenticated channel — does not exist anywhere in
 * this codebase: `packages/macf-channel-server/src` has no endpoint, no A2A
 * method, and no client for it (`/health`, `/notify`, `/sign`,
 * `/.well-known/agent-card.json`, `/a2a/v1` — none reads or serves a
 * recipient set). `#1330`'s own ruling is explicit that this is fine: *"the
 * fetch does not exist yet... build the lock-pinned guard now — it is
 * required under every provenance... let the fetch land when the channel
 * does. A transcribed first value pinned in the lock behaves identically to
 * a fetched one; only its freshness differs."* This module is that guard —
 * a pure function of two already-known sets — with the `live` parameter as
 * the seam a future `#789` fetch (or, meanwhile, an operator transcription)
 * fills in.
 */

/** One of the ruling's four rows, plus the fifth state the matrix presupposes away: the peer could not be asked at all. */
export type FederatedRecipientsRow = 'noop' | 'grant' | 'revoked' | 'first-federation' | 'unknown';

/**
 * The reconcile outcome for one federated peer's recipient set.
 *
 * `recipients` is the set this verdict would have `fleet.lock.collaborators[]`
 * record if accepted — `undefined` ONLY for `'unknown'`, and NEVER coerced to
 * `[]` (an unreachable peer's set is unknown, not empty — `#1252`'s rule,
 * restated for the federated case per `#1330`'s own AC).
 *
 * `sealable` is the "never seal to nobody" floor: `false` whenever
 * `recipients` is `undefined` OR an empty array, REGARDLESS of `row` — a
 * `'revoked'` row that narrows a peer's set to zero is still `false` here
 * even though the row itself is "safe, but say so" (the SHRINK is honest
 * bookkeeping; sealing to an empty set is a separate, always-refused
 * action). A caller building an actual seal-to-recipient operation on top of
 * this module MUST check `sealable`, never merely branch on `row`.
 */
export interface FederatedRecipientsVerdict {
  readonly row: FederatedRecipientsRow;
  readonly project: string;
  /** Recipients present in `live` but absent from `recorded` — non-empty only for `'grant'` / `'first-federation'`. */
  readonly added: readonly string[];
  /** Recipients present in `recorded` but absent from `live` — non-empty only for `'revoked'` (a `'grant'` row MAY also carry a same-diff removal — see this module's doc on swaps). */
  readonly removed: readonly string[];
  /** `true` for `'grant'` and `'first-federation'` — the two rows the ruling requires enumerated-and-named consent for. Never `true` for `'noop'` / `'revoked'` / `'unknown'`. */
  readonly consentRequired: boolean;
  readonly recipients: readonly string[] | undefined;
  readonly sealable: boolean;
}

/**
 * The reconcile guard — a pure function of `recorded` (fleet.lock's
 * last-approved set for this project; `undefined` = never federated/approved
 * yet, honest-unknown, NOT a real empty set) and `live` (the peer's CURRENT
 * set, from wherever the caller obtained it — the `#789` seam; `undefined` =
 * the peer could not be asked at all this run).
 *
 * Row order mirrors the ruling's matrix exactly:
 *
 * 1. `live === undefined` → `'unknown'` — checked FIRST, independent of
 *    `recorded`: an unreachable peer is unknown regardless of whether this
 *    fleet has ever federated it before. `recipients: undefined`,
 *    `sealable: false` — the failure mode this guards against is a caller
 *    silently treating "could not ask" as "asked, got nothing" and sealing
 *    to an empty set (or worse, plaintext-falling-back) as if that were a
 *    legitimate answer.
 * 2. `recorded === undefined` (and `live` known) → `'first-federation'` —
 *    the WHOLE `live` set is the grant (there is nothing to diff against),
 *    consent required once. Still `sealable: false` if `live` is itself `[]`
 *    — a first federation that declares zero recipients is a real, if odd,
 *    fact, not license to seal.
 * 3. Otherwise, a set difference between `recorded` and `live` (identity
 *    comparison — `#1230`'s own "set difference, not a length comparison"
 *    reasoning generalizes here too, so a same-cardinality SWAP is correctly
 *    classified: it always carries at least one ADDED key, so it always
 *    routes through the `'grant'` branch below, never masquerading as a
 *    `'noop'`):
 *    - no difference → `'noop'`, no consent.
 *    - any ADDED key (whether or not something was also removed in the same
 *      diff — a swap) → `'grant'`, consent required, EVERY added key named.
 *      The removed half of a swap is carried in `removed` too (informational
 *      — the peer revoking its own key is never itself the reason for
 *      consent; the grant is).
 *    - only REMOVED keys, nothing added → `'revoked'`, no consent (this is
 *      the peer's own call, not this fleet's), but the verdict still names
 *      what was removed so a caller can say so.
 */
export function reconcileFederatedAgeRecipients(
  project: string,
  recorded: readonly string[] | undefined,
  live: readonly string[] | undefined,
): FederatedRecipientsVerdict {
  if (live === undefined) {
    return { row: 'unknown', project, added: [], removed: [], consentRequired: false, recipients: undefined, sealable: false };
  }

  if (recorded === undefined) {
    return {
      row: 'first-federation',
      project,
      added: [...live],
      removed: [],
      consentRequired: true,
      recipients: [...live],
      sealable: live.length > 0,
    };
  }

  const recordedSet = new Set(recorded);
  const liveSet = new Set(live);
  const added = live.filter((r) => !recordedSet.has(r));
  const removed = recorded.filter((r) => !liveSet.has(r));

  if (added.length === 0 && removed.length === 0) {
    return { row: 'noop', project, added: [], removed: [], consentRequired: false, recipients: [...live], sealable: live.length > 0 };
  }
  if (added.length > 0) {
    return { row: 'grant', project, added, removed, consentRequired: true, recipients: [...live], sealable: live.length > 0 };
  }
  return { row: 'revoked', project, added: [], removed, consentRequired: false, recipients: [...live], sealable: live.length > 0 };
}

/**
 * Render a {@link FederatedRecipientsVerdict} into the consent/notice text a
 * caller shows the operator — the same "enumerate, name each one" discipline
 * `#1286`'s `formatDeletionEnumerationLines` established for delete-verb plan
 * items, applied to a grant of decrypt authority instead of a deletion.
 *
 * Returns `undefined` for `'noop'` — a matching set is not shown at all,
 * mirroring `formatDeletionResultLines`'s "silent when nothing applies"
 * convention (a `'noop'` is not merely low-priority information; it is
 * NOTHING TO SAY, and rendering an empty-content line for it would be noise
 * on every ordinary re-apply).
 */
export function formatFederatedRecipientsNotice(verdict: FederatedRecipientsVerdict): string | undefined {
  const nameList = (keys: readonly string[]): string => keys.map((k) => `"${k}"`).join(', ');
  const sealRefusal = (): string =>
    ' This peer currently has ZERO recorded recipients — nothing can be sealed to it until it adds one back; refusing to seal to nobody.';

  switch (verdict.row) {
    case 'noop':
      return undefined;

    case 'unknown':
      return (
        `federated peer "${verdict.project}": its current age recipient set could not be learned this run ` +
        '(the peer is unreachable, or no fetch mechanism exists yet). This is UNKNOWN, never treated as ' +
        'zero recipients — nothing is recorded, and nothing is sealed to this peer, until it can be asked again.'
      );

    case 'first-federation': {
      const list = verdict.recipients !== undefined && verdict.recipients.length > 0 ? nameList(verdict.recipients) : '(none declared)';
      return (
        `federated peer "${verdict.project}": FIRST FEDERATION — this fleet has never recorded a recipient set ` +
        `for it before. The entire set is a new grant of decrypt authority: ${list}. Confirm before recording it.` +
        (verdict.sealable ? '' : sealRefusal())
      );
    }

    case 'grant': {
      const addedList = nameList(verdict.added);
      const removedNote = verdict.removed.length > 0 ? ` (it also no longer declares: ${nameList(verdict.removed)} — safe, not part of this grant.)` : '';
      return (
        `federated peer "${verdict.project}": its recipient set WIDENED — new key(s) ${addedList} can now decrypt ` +
        'anything this fleet seals to it. This is a grant of decrypt authority to a party this fleet may not have ' +
        `vetted — confirm before recording it.${removedNote}`
      );
    }

    case 'revoked': {
      const removedList = nameList(verdict.removed);
      return (
        `federated peer "${verdict.project}": its recipient set SHRANK — ${removedList} no longer decrypts anything ` +
        "this fleet seals to it. This is the peer's own revocation (not this fleet's call) — proceeding, recorded " +
        `without confirmation.${verdict.sealable ? '' : sealRefusal()}`
      );
    }
  }
}
