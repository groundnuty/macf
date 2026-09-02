/**
 * `trust.federated_cas` widening-consent guard — groundnuty/macf#1389,
 * closing the gap `apply-federated-trust.ts`'s own module doc named:
 * *"Create-only — the widening-guard FLOOR, not the full `#1330`
 * enumerate-and-name consent gate... Building that fuller consent gate is
 * left to a follow-up increment."* This module is that follow-up.
 *
 * **Reuses `federated-age-recipients.ts`'s (`#1330`) pattern, adapted to a
 * DIFFERENT shape of value.** `#1330`'s ruling: *"the CHANNEL supplies the
 * peer's CURRENT set (fresh, authenticated, unpinned); `fleet.lock` pins the
 * LAST-APPROVED set (what we agreed to, recorded); the guard fires on the
 * DIFF between them."* Applied here: the MANIFEST (`trust.federated_cas[].ca_bundle`,
 * declared by the operator, always known — no live fetch needed, unlike
 * `#1330`'s peer-recipient set) supplies the CURRENT value; `fleet.lock`'s
 * new `federated_ca_trust[]` pins the LAST-APPROVED fingerprint; this guard
 * fires on the diff.
 *
 * **Why a SCALAR fingerprint diff, not `#1330`'s SET diff — a domain
 * difference, not a different mechanism.** `#1330` reconciles a per-peer SET
 * of recipient keys (grow / shrink / swap all meaningful). A `ca_bundle` is
 * ONE declared value per project — it either matches what was last approved
 * or it does not. There is no "shrink" analogue (removing a project from
 * `trust.federated_cas[]` simply stops this fleet from iterating it — see
 * `apply-federated-trust.ts`'s own doc on why a stale registry entry is a
 * SEPARATE, deliberately out-of-scope concern) and no "swap within a set"
 * case. So the row vocabulary here is `noop` / `new` / `changed` — three
 * rows where `#1330` needed five (`noop` / `grant` / `revoked` /
 * `first-federation` / `unknown`) — but the STRUCTURE (diff recorded vs
 * live, name what's granted, never silently resolve a widening) is
 * identical. Per this issue's own instruction: reuse the pattern, do not
 * invent a second one.
 *
 * **No `unknown` row.** `#1330` needed one because the peer's live set could
 * be genuinely unreachable (no fetch mechanism exists — `#789`). A
 * `ca_bundle` has no such gap: it is read directly from the manifest
 * `apply`/`plan` already parsed, so "live" is always known. The nearest
 * `#1330` analogue to a missing LOCK-side record is not `unknown` — it is
 * `#1330`'s `first-federation` row (`recorded === undefined`), which this
 * module's `new` row mirrors: the ENTIRE live value is the grant, named
 * once, then recorded as the approved baseline.
 *
 * **Fingerprint, not the raw bundle — see `fleet-manifest.ts::FleetLockFederatedCaSchema`'s
 * own doc for why.** This module hashes via `fleet-lock.ts::secretFingerprint`
 * (used for non-secret PEM material elsewhere too — that helper's own doc
 * notes it hashes "the raw UTF-8 bytes of whatever string is given," secret
 * or not) purely so `reconcileFederatedCaTrust` and whatever wrote
 * `fleet.lock`'s recorded value are guaranteed to agree on the SAME digest
 * function — never re-derive the comparison with a different hash.
 *
 * **Pure — no I/O, no registry read.** Mirrors `federated-age-recipients.ts`'s
 * own "a pure function of two already-known values" shape. A caller wires
 * this against `fleet.lock`'s `federated_ca_trust[]` (recorded) and the
 * manifest's `trust.federated_cas[]` (live) — see `apply-fleet.ts`'s
 * `applyFleet` (logs the notice BEFORE calling `publishFederatedTrustLegs`,
 * so a NEW project is named before it is granted) and
 * `commands/bootstrap-apply.ts` (renders the same notices ahead of a real
 * run, mirroring `age-recipients-narrowing.ts::ageRecipientsRecordAbsentNotice`'s
 * plan-preview placement).
 */
import { secretFingerprint } from './fleet-lock.js';
import { caCertVariableName } from './apply-ca.js';

/** The three rows this guard can produce — see this module's doc for why three, not `#1330`'s five. */
export type FederatedCaTrustRow = 'noop' | 'new' | 'changed';

/**
 * The reconcile outcome for one declared `trust.federated_cas[]` entry.
 *
 * `consentRequired` is `true` for `new` and `changed` — the two rows this
 * guard names before anything is granted (`new`) or refuses to silently
 * absorb (`changed`); `false` for `noop`. Mirrors
 * `FederatedRecipientsVerdict.consentRequired`'s own doc (`#1330`) — "the
 * closest existing vocabulary for 'not silent'" (`plan.ts`'s own phrase for
 * `confirm_required`).
 */
export interface FederatedCaTrustVerdict {
  readonly row: FederatedCaTrustRow;
  readonly project: string;
  /** `sha256:<hex>` fingerprint of the manifest's CURRENT declared `ca_bundle` for this project — always known (see module doc: no live-fetch gap here). */
  readonly liveFingerprint: string;
  /** `fleet.lock`'s recorded fingerprint for this project. `undefined` ONLY for `row === 'new'` — never coerced to `''` (mirrors `#1330`'s `recorded === undefined` → `first-federation` handling: absence is a distinct, honest "never approved," not a comparable empty value). */
  readonly recordedFingerprint: string | undefined;
  readonly consentRequired: boolean;
}

/**
 * The guard — a pure function of `recordedFingerprint` (`fleet.lock`'s
 * `federated_ca_trust[]` entry for this project, `undefined` = never
 * approved/recorded yet) and `liveCaBundle` (the manifest's CURRENT
 * `trust.federated_cas[].ca_bundle` for this project — always known, unlike
 * `#1330`'s peer-fetched set).
 *
 * 1. `recordedFingerprint === undefined` → `'new'` — the whole declared
 *    bundle is the grant, consent required once (mirrors `#1330`'s
 *    `first-federation` row).
 * 2. `recordedFingerprint === liveFingerprint` → `'noop'`, no consent — the
 *    common, silent case on every ordinary re-apply.
 * 3. Otherwise → `'changed'`, consent required — the declared bundle
 *    diverges from what was last approved. Unlike `#1330`'s `grant` row
 *    (which is followed by an actual widen), THIS row's caller
 *    (`apply-federated-trust.ts`) never auto-grants the change: the
 *    create-only floor already refuses to overwrite an existing registry
 *    variable, so a `'changed'` verdict is surfaced, never silently applied
 *    — see `formatFederatedCaTrustNotice`'s `'changed'` branch for the exact
 *    remediation text.
 */
export function reconcileFederatedCaTrust(project: string, recordedFingerprint: string | undefined, liveCaBundle: string): FederatedCaTrustVerdict {
  const liveFingerprint = secretFingerprint(liveCaBundle);

  if (recordedFingerprint === undefined) {
    return { row: 'new', project, liveFingerprint, recordedFingerprint: undefined, consentRequired: true };
  }
  if (recordedFingerprint === liveFingerprint) {
    return { row: 'noop', project, liveFingerprint, recordedFingerprint, consentRequired: false };
  }
  return { row: 'changed', project, liveFingerprint, recordedFingerprint, consentRequired: true };
}

/**
 * Render a {@link FederatedCaTrustVerdict} into the notice text a caller
 * prints (plan preview AND the real apply's log, per this module's doc) —
 * same "enumerate, name it, never just a count" discipline
 * `federated-age-recipients.ts::formatFederatedRecipientsNotice` establishes
 * for the sibling `#1330` guard.
 *
 * Returns `undefined` for `'noop'` — matches that sibling's "nothing to say"
 * convention: a matching bundle is not shown at all, so an ordinary re-apply
 * over an already-approved fleet stays silent.
 */
export function formatFederatedCaTrustNotice(verdict: FederatedCaTrustVerdict): string | undefined {
  const varName = caCertVariableName(verdict.project);

  switch (verdict.row) {
    case 'noop':
      return undefined;

    case 'new':
      // Deliberately does NOT assert "publishing it now" — this notice is
      // computed and logged BEFORE the registry create call runs (name
      // before grant), so it cannot know whether that call will actually
      // create the variable (the ordinary case) or find it ALREADY present
      // (a fleet federating this project before #1389 shipped, or an
      // operator hand-set copy — `federatedTrustLockUpdates`'s own doc,
      // "first run baselines rather than refuses"). Both outcomes result in
      // this fingerprint becoming the recorded approved baseline; only the
      // registry WRITE differs, and this text stays neutral on that.
      return (
        `federated peer "${verdict.project}": NEW federated-CA trust grant — this fleet has never recorded an ` +
        `approved ca_bundle for it before (fingerprint ${verdict.liveFingerprint}). This is a grant of CA trust to ` +
        `a party this fleet may not have vetted: any agent trusting this fleet's routing scope will now accept ` +
        `mTLS connections signed by this CA. Registry variable "${varName}" will be created from it if not already ` +
        'present (create-only), and this fingerprint will be recorded as the approved baseline either way.'
      );

    case 'changed':
      return (
        `federated peer "${verdict.project}": its declared ca_bundle CHANGED since it was last approved (recorded ` +
        `${verdict.recordedFingerprint}, manifest now declares ${verdict.liveFingerprint}). This is a widening of ` +
        `trust to DIFFERENT CA material, never silently granted: the existing registry variable "${varName}" is ` +
        'left UNCHANGED (create-only floor — apply never overwrites it). To grant the new bundle, remove ' +
        `"${varName}" from this fleet's registry scope first, then re-run apply; it will be re-created from the ` +
        'new bundle and recorded as the new approved baseline.'
      );
  }
}
