/**
 * Tests for `federated-ca-trust.ts` — groundnuty/macf#1389's `#1330`-shaped
 * enumerate-and-name consent guard for `trust.federated_cas[].ca_bundle`.
 *
 * The decisive three (per `assert-the-wrong-path.md`): the three rows this
 * guard can produce (noop / new / changed), each pinned against the
 * RENDERED notice text (`formatFederatedCaTrustNotice`), not merely the
 * verdict object's fields — same discipline
 * `federated-age-recipients.test.ts` establishes for its own sibling guard:
 * a single row alone is satisfiable by a guard that always fires (or never
 * fires); reading the rendered output is what actually pins that a NEW
 * project is NAMED and a CHANGED bundle names BOTH the old and new
 * fingerprint.
 */
import { describe, it, expect } from 'vitest';
import { reconcileFederatedCaTrust, formatFederatedCaTrustNotice } from '../../../src/cli/bootstrap/federated-ca-trust.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';
import { caCertVariableName } from '../../../src/cli/bootstrap/apply-ca.js';

describe('reconcileFederatedCaTrust — the decisive three rows (groundnuty/macf#1389)', () => {
  it('DECISIVE (1) noop: recorded fingerprint MATCHES the live bundle\'s — no consent, and NOTHING is rendered', () => {
    const verdict = reconcileFederatedCaTrust('ppam-2026', secretFingerprint('CERT-A'), 'CERT-A');
    expect(verdict.row).toBe('noop');
    expect(verdict.consentRequired).toBe(false);
    expect(formatFederatedCaTrustNotice(verdict)).toBeUndefined();
  });

  // Mutation check performed manually (per assert-the-wrong-path.md — break
  // the diff so a CHANGE reads as a match, confirm a test reading the
  // RENDERED consent output fails): changing `recordedFingerprint ===
  // liveFingerprint` to `true` unconditionally in `reconcileFederatedCaTrust`
  // makes every verdict `'noop'`. The DECISIVE (2) and (3) tests below both
  // fail immediately (`expect(verdict.row).toBe('new'|'changed')`), and —
  // because `formatFederatedCaTrustNotice('noop')` returns `undefined` — the
  // `notice` assertions in those tests fail on `expect(notice).toBeDefined()`
  // too, so the failure is caught at both the verdict-field AND the
  // rendered-text altitude, not merely inferred from one.
  it("DECISIVE (2) new: NO recorded fingerprint (never approved) — consent required, RENDERED output says NEW and names the fingerprint", () => {
    const verdict = reconcileFederatedCaTrust('ppam-2026', undefined, 'GUEST-CERT-PEM');
    expect(verdict.row).toBe('new');
    expect(verdict.consentRequired).toBe(true);
    expect(verdict.recordedFingerprint).toBeUndefined();
    expect(verdict.liveFingerprint).toBe(secretFingerprint('GUEST-CERT-PEM'));
    const notice = formatFederatedCaTrustNotice(verdict);
    expect(notice).toBeDefined();
    expect(notice).toContain('NEW federated-CA trust grant');
    expect(notice).toContain('ppam-2026');
    expect(notice).toContain(secretFingerprint('GUEST-CERT-PEM'));
    expect(notice).toContain(caCertVariableName('ppam-2026'));
  });

  it('DECISIVE (3) changed: recorded fingerprint DIFFERS from the live bundle\'s — consent required, RENDERED output names BOTH fingerprints and says the registry stays unchanged', () => {
    const recorded = secretFingerprint('OLD-CERT-PEM');
    const verdict = reconcileFederatedCaTrust('ppam-2026', recorded, 'NEW-DIFFERENT-CERT-PEM');
    expect(verdict.row).toBe('changed');
    expect(verdict.consentRequired).toBe(true);
    expect(verdict.recordedFingerprint).toBe(recorded);
    expect(verdict.liveFingerprint).toBe(secretFingerprint('NEW-DIFFERENT-CERT-PEM'));
    const notice = formatFederatedCaTrustNotice(verdict);
    expect(notice).toBeDefined();
    expect(notice).toContain('CHANGED');
    expect(notice).toContain(recorded);
    expect(notice).toContain(secretFingerprint('NEW-DIFFERENT-CERT-PEM'));
    expect(notice).toContain('UNCHANGED');
    expect(notice).toContain(caCertVariableName('ppam-2026'));
  });
});

describe('reconcileFederatedCaTrust — never confuses "unrecorded" with "empty"', () => {
  it('recorded === undefined is honestly "new", never coerced into comparing against an empty-string fingerprint', () => {
    const verdict = reconcileFederatedCaTrust('ppam-2026', undefined, '');
    // Even an empty-string bundle (a degenerate manifest) still hashes to a
    // real, non-empty fingerprint — the row is `'new'` because NOTHING was
    // ever recorded, not because the live value happens to be falsy.
    expect(verdict.row).toBe('new');
    expect(verdict.recordedFingerprint).toBeUndefined();
    expect(verdict.liveFingerprint).toBe(secretFingerprint(''));
  });
});

describe('reconcileFederatedCaTrust — determinism (same bundle text, same fingerprint, every time)', () => {
  it('two calls with identical live bundle text always resolve to the same liveFingerprint', () => {
    const a = reconcileFederatedCaTrust('p', undefined, 'CERT-X');
    const b = reconcileFederatedCaTrust('p', undefined, 'CERT-X');
    expect(a.liveFingerprint).toBe(b.liveFingerprint);
  });

  it('a single-byte difference in the bundle text produces a DIFFERENT fingerprint (no accidental noop)', () => {
    const recorded = secretFingerprint('CERT-X');
    const verdict = reconcileFederatedCaTrust('p', recorded, 'CERT-Y');
    expect(verdict.row).toBe('changed');
  });
});
