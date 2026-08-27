/**
 * Tests for `age-recipients-narrowing.ts` — groundnuty/macf#1230 ("narrowing
 * `age_recipients` is a revocation that does not revoke — refuse it").
 *
 * The decisive pair (per `assert-the-wrong-path.md`): a strict-subset
 * narrowing must be refused (1), and a pure widening must NOT be refused,
 * with zero new friction (2) — (1) alone is satisfiable by a broken
 * implementation that refuses on ANY change, so (2) is load-bearing. The
 * SWAP test below is what actually pins the comparison rule ("recorded
 * minus desired is non-empty", a set difference) against a weaker
 * length-only implementation that would pass both (1) and (2) while missing
 * a same-size recipient replacement.
 *
 * This file covers the PURE predicate only. `bootstrap-apply.test.ts` binds
 * the decisive pair to the real preflight call site — a test asserting only
 * this pure function refuses is not evidence the refusal fires in `apply`.
 */
import { describe, it, expect } from 'vitest';
import {
  AGE_RECIPIENTS_NARROWED_CODE,
  ageRecipientsNarrowedReason,
  checkAgeRecipientsNarrowing,
  overrideAcknowledged,
  removedAgeRecipients,
  ageRecipientsRecordAbsent,
  ageRecipientsRecordAbsentNotice,
} from '../../../src/cli/bootstrap/age-recipients-narrowing.js';
import { AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetLock } from '../../../src/cli/bootstrap/fleet-manifest.js';

/** A minimal, valid, otherwise-empty lock carrying only the `age_recipients` field under test. */
function lockWithRecipients(recipients: readonly string[] | undefined): FleetLock {
  return {
    schema_version: 1,
    fleet: 'icsoc-2026',
    agents: [],
    ...(recipients !== undefined ? { age_recipients: recipients } : {}),
  };
}

describe('checkAgeRecipientsNarrowing — no-lock / no-recorded-set states (never refused; nothing to compare)', () => {
  it('is undefined when priorLock is null — first provision, no recorded set exists yet', () => {
    expect(checkAgeRecipientsNarrowing(['age1a'], null, undefined)).toBeUndefined();
  });

  it('is undefined when the lock predates the age_recipients field (recorded === undefined) — every fleet provisioned before #1252', () => {
    const lock = lockWithRecipients(undefined);
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, undefined)).toBeUndefined();
  });

  it('is undefined when the recorded set is an empty array — nothing was ever granted to compare a removal against', () => {
    const lock = lockWithRecipients([]);
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, undefined)).toBeUndefined();
  });
});

describe('checkAgeRecipientsNarrowing — the decisive pair (groundnuty/macf#1230 AC)', () => {
  it('DECISIVE (1): a strict subset of the recorded set is refused, naming the removed recipient, before any GitHub call (pure/no I/O)', () => {
    const lock = lockWithRecipients(['age1operator', 'age1vm']);
    const result = checkAgeRecipientsNarrowing(['age1operator'], lock, undefined);
    expect(result).toBeDefined();
    expect(result?.code).toBe(AGE_RECIPIENTS_NARROWED_CODE);
    expect(result?.removed).toEqual(['age1vm']);
    expect(result?.message).toContain('age1vm');
    expect(result?.message).toContain('does not revoke');
  });

  it('DECISIVE (2): a superset (widening) is NOT refused — adding a recipient stays completely frictionless', () => {
    const lock = lockWithRecipients(['age1operator']);
    const result = checkAgeRecipientsNarrowing(['age1operator', 'age1vm'], lock, undefined);
    expect(result).toBeUndefined();
  });
});

describe('checkAgeRecipientsNarrowing — additional required states', () => {
  it('an identical set is untouched — no refusal', () => {
    const lock = lockWithRecipients(['age1operator', 'age1vm']);
    expect(checkAgeRecipientsNarrowing(['age1operator', 'age1vm'], lock, undefined)).toBeUndefined();
  });

  it('no lock at all (first provision) — no refusal possible, and that is correct: there is nothing yet to have narrowed FROM', () => {
    expect(checkAgeRecipientsNarrowing([], null, undefined)).toBeUndefined();
  });

  it('a SWAP (drop one recipient, add a different one — same cardinality) is STILL refused: this is what proves the comparison is a set difference, not a length check', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const result = checkAgeRecipientsNarrowing(['age1a', 'age1c'], lock, undefined);
    expect(result).toBeDefined();
    expect(result?.removed).toEqual(['age1b']);
  });

  it('dropping to an empty desired set (the most extreme narrowing) names every removed recipient', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const result = checkAgeRecipientsNarrowing([], lock, undefined);
    expect(result).toBeDefined();
    expect(result?.removed).toEqual(['age1a', 'age1b']);
    expect(result?.message).toContain('age1a');
    expect(result?.message).toContain('age1b');
  });

  it('an override that proceeds: the explicit override present + correctly worded lets the narrowing through, AND the message is never surfaced (no refusal object at all)', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const result = checkAgeRecipientsNarrowing(['age1a'], lock, AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT);
    expect(result).toBeUndefined();
  });
});

describe('checkAgeRecipientsNarrowing — the override must repeat the limitation, not merely permit the action', () => {
  it('a missing override still refuses (the ordinary, no-acknowledgment case)', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, undefined)).toBeDefined();
  });

  it('a WRONG override text (e.g. a bare "true", or a paraphrase) does NOT suppress the refusal — presence alone is not enough', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, 'true')).toBeDefined();
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, 'I acknowledge this')).toBeDefined();
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, 'yes')).toBeDefined();
  });

  it('a stale/edited copy of the real text does NOT suppress the refusal — must match, not merely resemble', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const edited = AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT.replace('rotating the CA', 'rotating the key');
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, edited)).toBeDefined();
  });

  it('whitespace-normalized (not byte-exact) matching tolerates YAML line-folding of the long override string', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const folded = AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT.replace(/ /g, '\n  ');
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, folded)).toBeUndefined();
  });

  it('leading/trailing whitespace around an otherwise-correct override is tolerated', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    expect(checkAgeRecipientsNarrowing(['age1a'], lock, `  ${AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT}  `)).toBeUndefined();
  });

  it('the refusal message itself carries the exact override text to paste — a copy-paste fix, not a guess', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    const result = checkAgeRecipientsNarrowing(['age1a'], lock, undefined);
    expect(result?.message).toContain(AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT);
  });
});

describe('ageRecipientsNarrowedReason — wording', () => {
  it('singular wording for one removed recipient', () => {
    const message = ageRecipientsNarrowedReason(['age1solo']);
    expect(message).toContain('recipient "age1solo"');
    expect(message).not.toContain('recipients "age1solo"');
  });

  it('plural wording for multiple removed recipients', () => {
    const message = ageRecipientsNarrowedReason(['age1a', 'age1b']);
    expect(message).toContain('recipients "age1a", "age1b"');
  });

  it('never suggests re-encryption as the remedy — the issue explicitly forbids "re-encrypt plus a warning"', () => {
    const message = ageRecipientsNarrowedReason(['age1a']);
    // The message DOES mention re-encryption (to explain the limitation), but
    // must never frame it as something `apply` could do to resolve the
    // situation — it must say the opposite.
    expect(message).toContain('not something `apply` can fix by re-encrypting');
    expect(message.toLowerCase()).not.toMatch(/re-encrypt\w* (this|it) (to )?(fix|solve|resolve)/);
    expect(message.toLowerCase()).not.toMatch(/(the fix|the remedy|the solution) is to re-encrypt/);
  });
});

describe('removedAgeRecipients — the shared set-difference `fleet-lock.ts`\'s ledger reuses (groundnuty/macf#1230 AC 4)', () => {
  it('returns [] when nothing is recorded (undefined / predates the field)', () => {
    expect(removedAgeRecipients(['age1a'], null)).toEqual([]);
    expect(removedAgeRecipients(['age1a'], lockWithRecipients(undefined))).toEqual([]);
  });

  it('returns [] when the recorded set is a real empty array', () => {
    expect(removedAgeRecipients(['age1a'], lockWithRecipients([]))).toEqual([]);
  });

  it('returns the removed recipient(s) on a narrowing, agreeing with checkAgeRecipientsNarrowing\'s own `removed`', () => {
    const lock = lockWithRecipients(['age1a', 'age1b']);
    expect(removedAgeRecipients(['age1a'], lock)).toEqual(['age1b']);
  });

  it('returns [] on a pure widening', () => {
    const lock = lockWithRecipients(['age1a']);
    expect(removedAgeRecipients(['age1a', 'age1b'], lock)).toEqual([]);
  });
});

describe('overrideAcknowledged — the shared predicate `fleet-lock.ts`\'s ledger reuses', () => {
  it('false when override is undefined', () => {
    expect(overrideAcknowledged(undefined)).toBe(false);
  });

  it('false on a wrong/paraphrased override', () => {
    expect(overrideAcknowledged('true')).toBe(false);
  });

  it('true on the exact required text', () => {
    expect(overrideAcknowledged(AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT)).toBe(true);
  });

  it('true on a whitespace-normalized (YAML-folded) match', () => {
    expect(overrideAcknowledged(AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT.replace(/ /g, '\n  '))).toBe(true);
  });
});

describe('ageRecipientsRecordAbsent — the third state (groundnuty/macf#1230)', () => {
  it('DECISIVE: no recorded set is UNKNOWN, distinguishable from "compared, nothing removed"', () => {
    // The defect this closes: both cases returned [] from removedAgeRecipients
    // and were indistinguishable at the call site.
    expect(ageRecipientsRecordAbsent(lockWithRecipients(undefined))).toBe(true);
    expect(ageRecipientsRecordAbsent(null)).toBe(true);
  });

  it('DECISIVE: a fleet WITH a recorded set is NOT absent, even when nothing is removed', () => {
    expect(ageRecipientsRecordAbsent(lockWithRecipients(['age1aaa']))).toBe(false);
    expect(removedAgeRecipients(['age1aaa'], lockWithRecipients(['age1aaa']))).toEqual([]);
  });

  it('an empty recorded array is absent — nothing to compare against', () => {
    expect(ageRecipientsRecordAbsent(lockWithRecipients([]))).toBe(true);
  });

  it('the notice names the gap, says it proceeds, and says what closes it', () => {
    const notice = ageRecipientsRecordAbsentNotice();
    expect(notice).toContain('cannot be checked for narrowing');
    expect(notice).toContain('Proceeding');
    expect(notice).toContain('records the');
  });

  // groundnuty/macf#1269 — the notice used to promise "the next apply
  // records the set," which is false for a steady-state fleet: `apply`
  // mints nothing on such a fleet, `settleVault` never reaches
  // `status: 'written'`, and the OLD batched-lock-write guard required
  // exactly that status unconditionally — so "the next apply" (any apply,
  // indefinitely) never actually recorded the set. The corrected text names
  // the real mechanism (`shouldWriteBatchedFleetLock` in `apply-fleet.ts`)
  // instead of a promise that depended on minting something.
  it('DECISIVE (groundnuty/macf#1269): does NOT make the "next apply" promise the fix broke — it names a run that mints nothing', () => {
    const notice = ageRecipientsRecordAbsentNotice();
    expect(notice).not.toContain('next apply records the set');
    expect(notice).toContain('mints no new credentials');
  });
});
