/**
 * Tests for `federated-age-recipients.ts` — groundnuty/macf#1330's
 * lock-pinned reconcile guard for a federated peer's age recipient set.
 *
 * The decisive four (per `assert-the-wrong-path.md`): the four rows of the
 * ruling's matrix (noop / grant / revoked / first-federation), each pinned
 * against the RENDERED consent text (`formatFederatedRecipientsNotice`), not
 * merely the verdict object's fields — a single row alone is satisfiable by
 * a guard that always fires (or never fires); reading the rendered output
 * is what actually pins that a GROW names the added keys and a SHRINK says
 * so, per #1330's own instruction: "reading the RENDERED consent output
 * fails" is the mutation bar, not a helper's return value.
 *
 * Plus: an unreachable peer is `unknown`, never coerced to an empty set
 * (#1252's rule, restated for the federated case) — and a set that would
 * seal to nobody refuses (`sealable: false`), independent of which row
 * produced it.
 */
import { describe, it, expect } from 'vitest';
import { reconcileFederatedAgeRecipients, formatFederatedRecipientsNotice } from '../../../src/cli/bootstrap/federated-age-recipients.js';

describe('reconcileFederatedAgeRecipients — the decisive four rows (groundnuty/macf#1330)', () => {
  it('DECISIVE (1) noop: lock has it, live MATCHES — no consent, and NOTHING is rendered', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a', 'age1b'], ['age1a', 'age1b']);
    expect(verdict.row).toBe('noop');
    expect(verdict.consentRequired).toBe(false);
    expect(verdict.added).toEqual([]);
    expect(verdict.removed).toEqual([]);
    expect(formatFederatedRecipientsNotice(verdict)).toBeUndefined();
  });

  // Mutation check performed manually (per assert-the-wrong-path.md /
  // #1330's own instruction — break the diff so a GROW reads as a match,
  // confirm a test reading the RENDERED consent output fails), two mutations:
  //
  // (a) `if (added.length > 0)` -> `if (false)` in
  //     `reconcileFederatedAgeRecipients`: `verdict.row` falls through to
  //     `'revoked'`, and — surprisingly, verified rather than assumed —
  //     `verdict.added` ALSO reads `[]` (the fallback `return` statement
  //     hardcodes `added: []` rather than reusing the already-computed
  //     variable), so this mutation is caught even by a `row`/`added`-only
  //     assertion. Confirmed by actually running it, not inferred: the
  //     failure landed at `expect(verdict.row).toBe('grant')`, not at the
  //     notice assertion — the first draft of this comment guessed
  //     otherwise and was wrong (per `verify-before-claim.md`).
  //
  // (b) DECISIVE for THIS test's own claim — `nameList(verdict.added)` ->
  //     `nameList([])` inside `formatFederatedRecipientsNotice`'s `'grant'`
  //     case ONLY (the reconcile guard itself untouched, so `verdict.row`
  //     is `'grant'` and `verdict.added` is correctly `['age1new']`): the
  //     `row`/`added`/`consentRequired` assertions above all still PASS
  //     under this mutation, and only `expect(notice).toContain('age1new')`
  //     fails (`Received: "...new key(s)  can now decrypt..."`, added-list
  //     rendered empty). This is the mutation that proves the rendered-text
  //     assertion is load-bearing — a test reading only the verdict's return
  //     value would NOT have caught it.
  it('DECISIVE (2) grant: lock has it, live GREW — consent required, and the RENDERED output NAMES the added key', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], ['age1a', 'age1new']);
    expect(verdict.row).toBe('grant');
    expect(verdict.consentRequired).toBe(true);
    expect(verdict.added).toEqual(['age1new']);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toBeDefined();
    expect(notice).toContain('age1new');
    expect(notice).toContain('WIDENED');
  });

  it('DECISIVE (3) revoked: lock has it, live SHRANK — proceeds without consent, and the RENDERED output SAYS SO, naming the removed key', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a', 'age1gone'], ['age1a']);
    expect(verdict.row).toBe('revoked');
    expect(verdict.consentRequired).toBe(false);
    expect(verdict.removed).toEqual(['age1gone']);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toBeDefined();
    expect(notice).toContain('age1gone');
    expect(notice).toContain('SHRANK');
  });

  it('DECISIVE (4) first-federation: lock has NONE yet — consent once, and the RENDERED output names the WHOLE set', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', undefined, ['age1a', 'age1b']);
    expect(verdict.row).toBe('first-federation');
    expect(verdict.consentRequired).toBe(true);
    expect(verdict.added).toEqual(['age1a', 'age1b']);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toBeDefined();
    expect(notice).toContain('age1a');
    expect(notice).toContain('age1b');
    expect(notice).toContain('FIRST FEDERATION');
  });
});

describe('reconcileFederatedAgeRecipients — honest-unknown (an unreachable peer is UNKNOWN, never an empty set)', () => {
  it('DECISIVE: live === undefined produces row "unknown" with recipients === undefined, NEVER []', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], undefined);
    expect(verdict.row).toBe('unknown');
    expect(verdict.recipients).toBeUndefined();
    // The explicit distinction the AC requires: not merely falsy, but
    // literally undefined — a caller checking `?? []` would silently
    // coalesce this into the dangerous "record nothing changed" reading.
    expect(verdict.recipients === undefined).toBe(true);
    expect(Array.isArray(verdict.recipients)).toBe(false);
  });

  it('unknown holds regardless of whether a set was ever recorded before (checked BEFORE the recorded/first-federation branch)', () => {
    const withPriorRecord = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], undefined);
    const withNoPriorRecord = reconcileFederatedAgeRecipients('ppam-2026', undefined, undefined);
    expect(withPriorRecord.row).toBe('unknown');
    expect(withNoPriorRecord.row).toBe('unknown');
  });

  it('unknown is never sealable and requires no consent (there is nothing to consent to)', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], undefined);
    expect(verdict.sealable).toBe(false);
    expect(verdict.consentRequired).toBe(false);
  });

  it('the rendered notice for unknown asserts UNKNOWN as the state — never claims the set actually IS empty/zero as a fact', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], undefined);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toContain('UNKNOWN');
    // The message explicitly contrasts "unknown" against "treated as zero" —
    // that contrast is the correct, honest wording (mirrors
    // ageRecipientsRecordAbsentNotice's own "never claims the recipient set
    // IS wrong" discipline). What it must NOT do is assert the set itself
    // IS empty as an observed fact.
    expect(notice?.toLowerCase()).not.toMatch(/the set is (empty|zero)/);
    expect(notice?.toLowerCase()).not.toMatch(/has zero recipients/);
  });
});

describe('reconcileFederatedAgeRecipients — never seal to nobody (a resolved empty set always refuses, whichever row produced it)', () => {
  it('a SHRANK-to-empty set is still "safe, but say so" as a row (revoked, no consent) but is UNSEALABLE', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1a'], []);
    expect(verdict.row).toBe('revoked');
    expect(verdict.consentRequired).toBe(false); // the shrink itself is still the peer's own call
    expect(verdict.sealable).toBe(false); // but nothing may be sealed against the result
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toContain('refusing to seal to nobody');
  });

  it('a first-federation that declares zero recipients is a real fact, still consent-required, but UNSEALABLE', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', undefined, []);
    expect(verdict.row).toBe('first-federation');
    expect(verdict.consentRequired).toBe(true);
    expect(verdict.sealable).toBe(false);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toContain('refusing to seal to nobody');
  });

  it('a noop where both recorded and live are empty is still UNSEALABLE, even though nothing changed', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', [], []);
    expect(verdict.row).toBe('noop');
    expect(verdict.sealable).toBe(false);
    // noop renders nothing at all, by design — the refusal is carried on
    // the verdict object for a caller to check, not narrated every re-apply.
    expect(formatFederatedRecipientsNotice(verdict)).toBeUndefined();
  });

  it('a non-empty resolved set is sealable in every row that produces one', () => {
    expect(reconcileFederatedAgeRecipients('p', ['a'], ['a']).sealable).toBe(true);
    expect(reconcileFederatedAgeRecipients('p', ['a'], ['a', 'b']).sealable).toBe(true);
    expect(reconcileFederatedAgeRecipients('p', ['a', 'b'], ['a']).sealable).toBe(true);
    expect(reconcileFederatedAgeRecipients('p', undefined, ['a']).sealable).toBe(true);
  });
});

describe('reconcileFederatedAgeRecipients — the swap case (same cardinality, add + remove together)', () => {
  it('a same-size swap (drop one, add a different one) is classified GRANT, not noop — the added key is what matters here, not the count', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1old'], ['age1new']);
    expect(verdict.row).toBe('grant');
    expect(verdict.added).toEqual(['age1new']);
    expect(verdict.removed).toEqual(['age1old']);
    expect(verdict.consentRequired).toBe(true);
  });

  it('the rendered notice for a swap names the added key as the grant AND mentions the removed key as informational, not as a reason for consent', () => {
    const verdict = reconcileFederatedAgeRecipients('ppam-2026', ['age1old'], ['age1new']);
    const notice = formatFederatedRecipientsNotice(verdict);
    expect(notice).toContain('age1new');
    expect(notice).toContain('age1old');
    expect(notice).toContain('safe, not part of this grant');
  });
});
