/**
 * `trust.federated_cas` registry publish — groundnuty/macf#810, DR-041
 * Amendment B, landing WITH its enforcement per `#1205`'s condition on the
 * removed `trust:` field ("must land with its enforcement, not ahead of
 * it").
 *
 * **Scope, deliberately narrow (the #810 ruling thread's own scoping call):
 * this module publishes the CA-trust MATERIAL only.** It does not touch
 * `.github/macf-fleet.json`'s per-agent-repo `federated_cas` project-NAME
 * list (`@groundnuty/macf-core`'s `guest.ts`), and it does not change
 * `resolveGuestAddress`'s cross-fleet ADDRESSING gate (same file) — both stay
 * exactly as they are today. Conflating trust-material publication with the
 * addressing gate's input source is a SEPARATE design question the `#810`
 * thread explicitly kept apart from this one ("different component,
 * different mechanism — conflating them muddies both", re: the sibling
 * mention-routing gap on the same issue). See this module's own doc below
 * for exactly what observable effect this DOES have.
 *
 * **The consumer this reaches, concretely.** `@groundnuty/macf-core`'s
 * `trust-bundle.ts::resolveFederatedCaBundle` resolves each project an
 * agent's `.github/macf-fleet.json` `federated_cas` list names to
 * `${toVariableSegment(project)}_CA_CERT` in ITS OWN registry scope, and
 * THROWS at channel-server startup if that variable is missing or empty
 * (`TrustBundleError` — "refusing to start with an INCOMPLETE trust
 * bundle"). `caCertVariableName` (`apply-ca.ts`) computes the IDENTICAL
 * formula. So publishing a declared `trust.federated_cas[].ca_bundle` under
 * `caCertVariableName(entry.project)`, in THIS FLEET's OWN registry scope
 * (`manifest.owner.registry` — the same scope `apply-ca.ts` publishes this
 * fleet's OWN CA cert to, fleet-scoped since groundnuty/macf#1373/#1375
 * fixed `registry-api-path`), lands the bundle in the EXACT variable that
 * ALREADY-SHIPPED consumer reads. Before this module ran: an agent whose
 * `.github/macf-fleet.json` names the guest project would THROW at startup
 * (the variable does not exist). After: it resolves, and the guest's CA
 * joins the trust bundle. That state transition — refuse-to-start →
 * resolves — is the observable effect this module exists to produce; it is
 * enforcement, not anticipation.
 *
 * **Registry-scope ONLY, no repo legs (unlike `apply-ca.ts::publishCaCertLegs`'s
 * two-place rule).** `resolveFederatedCaBundle` reads via
 * `varsClient.readVariable` — the channel-server's registry client — never a
 * repo variable. There is no second consumer to cover, so there is no second
 * leg to publish.
 *
 * **Create-only — STILL the floor. The `#1330`-shaped enumerate-and-name
 * consent gate is now built (groundnuty/macf#1389, `federated-ca-trust.ts`)
 * — layered ON TOP of the floor below, never replacing it.**
 * `ensureVariableCreated` never overwrites an existing value: a NEW
 * project's bundle is published and reported `'created'`; an EXISTING
 * project's bundle — even a materially DIFFERENT one — reports
 * `'already-present'` and is left untouched. That create-only guarantee is
 * UNCHANGED by `#1389` (see `federated-ca-trust.ts::formatFederatedCaTrustNotice`'s
 * `'changed'` branch — it names the divergence, it does not resolve it). What
 * `#1389` adds is the OTHER half `#1330`'s ruling describes: `fleet.lock`'s
 * new `federated_ca_trust[]` pins the last-APPROVED `ca_bundle`
 * FINGERPRINT per project (see `fleet-manifest.ts::FleetLockFederatedCaSchema`),
 * `reconcileFederatedTrustVerdicts` (below) diffs the manifest's CURRENT
 * declaration against it, and `federatedTrustNotices` renders what to say —
 * a NEW project named before it is granted; a CHANGED bundle surfaced,
 * never silently kept AND never silently overwritten (the create-only floor
 * already refuses the overwrite half; the notice closes the "silently kept"
 * half by making the divergence visible on every subsequent apply until the
 * operator acts). `federatedTrustLockUpdates` (below) then decides which
 * verdicts actually get recorded as the new approved baseline — ONLY
 * projects this run's registry leg reports `'created'` for (see that
 * function's own doc for why `'already-present'` legs are never recorded,
 * even for a `'new'`-row project that predates this mechanism).
 *
 * See `apply-fleet.ts`'s `applyFleet` for the wiring: verdicts are computed
 * and their notices logged BEFORE `publishFederatedTrustLegs` runs (name
 * before grant), then `federatedTrustLockUpdates` decides the `fleet.lock`
 * write AFTER, from what was actually published.
 */
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetFederatedCa, FleetLockFederatedCa } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import type { CreateVariableResult } from './variable-write.js';
import type { EnsureVariableDeps, EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, skippedOutcomesFor } from './ensure-variable.js';
import { caCertVariableName } from './apply-ca.js';
import type { FederatedCaTrustUpdate } from './fleet-lock.js';
import type { FederatedCaTrustVerdict } from './federated-ca-trust.js';
import { reconcileFederatedCaTrust, formatFederatedCaTrustNotice } from './federated-ca-trust.js';

export interface FederatedTrustApplyDeps {
  readonly checkRegistryPresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly createRegistryVariable: (registry: RegistryConfig, name: string, value: string) => Promise<CreateVariableResult>;
}

/** One `{@link EnsureVariableOutcome}` per declared `trust.federated_cas[]` entry, keyed by `project` (never by variable name — a project name is what a caller/renderer already has in hand from the manifest). */
export type FederatedTrustPublishResult = Readonly<Record<string, EnsureVariableOutcome>>;

/**
 * Create-only publish of every declared `trust.federated_cas[].ca_bundle` to
 * THIS fleet's own registry scope, under the GUEST project's `<SEG>_CA_CERT`
 * name (see module doc for why this is the exact variable the real consumer
 * reads). `ca_bundle` is public CA-certificate material — this function
 * never receives, produces, or could leak a private key.
 */
export async function publishFederatedTrustLegs(
  federatedCas: readonly FleetFederatedCa[],
  registry: RegistryConfig,
  deps: FederatedTrustApplyDeps,
): Promise<FederatedTrustPublishResult> {
  const legs: Record<string, EnsureVariableOutcome> = {};
  for (const entry of federatedCas) {
    const varName = caCertVariableName(entry.project);
    const depsForEntry: EnsureVariableDeps = {
      checkPresence: () => deps.checkRegistryPresence(registry, varName),
      create: () => deps.createRegistryVariable(registry, varName, entry.ca_bundle),
    };
    legs[entry.project] = await ensureVariableCreated(depsForEntry, `Federated-CA registry var "${varName}" (guest project "${entry.project}")`);
  }
  return legs;
}

/** The {@link FederatedTrustPublishResult} shape for "never attempted this run" — mirrors `apply-ca.ts::skippedCaPublish`'s always-present-even-on-abort discipline. Keyed by `project`, same as {@link publishFederatedTrustLegs}'s return (`skippedOutcomesFor` keys by whatever string list it's given — here, project names). */
export function skippedFederatedTrustPublish(federatedCas: readonly FleetFederatedCa[], reason: string): FederatedTrustPublishResult {
  return skippedOutcomesFor(
    federatedCas.map((entry) => entry.project),
    reason,
  );
}

// --- groundnuty/macf#1389 — the `#1330`-shaped enumerate-and-name consent
// gate this module's own doc describes. Pure; no I/O; call BEFORE
// `publishFederatedTrustLegs` so a caller can log the notices in
// name-before-grant order. -------------------------------------------------

/**
 * Diff every declared `trust.federated_cas[]` entry against `fleet.lock`'s
 * recorded `federated_ca_trust[]` — one {@link FederatedCaTrustVerdict} per
 * entry, in `federatedCas`' declared order (never re-sorted: a caller
 * logging these wants the same order the operator wrote the manifest in).
 * Pure; delegates the actual diff to `federated-ca-trust.ts::reconcileFederatedCaTrust`
 * — this function's only job is looking up each entry's recorded fingerprint
 * by project (a project absent from `recordedTrust` resolves to `undefined`
 * — "never approved", per that guard's `'new'` row).
 */
export function reconcileFederatedTrustVerdicts(
  federatedCas: readonly FleetFederatedCa[],
  recordedTrust: readonly FleetLockFederatedCa[] | undefined,
): readonly FederatedCaTrustVerdict[] {
  const recordedByProject = new Map((recordedTrust ?? []).map((entry) => [entry.project, entry.ca_bundle_fingerprint]));
  return federatedCas.map((entry) => reconcileFederatedCaTrust(entry.project, recordedByProject.get(entry.project), entry.ca_bundle));
}

/**
 * Render every {@link FederatedCaTrustVerdict} that has something to say —
 * `'noop'` verdicts are silently dropped (see `federated-ca-trust.ts::formatFederatedCaTrustNotice`'s
 * own "nothing to say" doc), so an ordinary re-apply over an already-approved
 * fleet produces an empty array here, not a wall of confirmations. Order
 * matches {@link reconcileFederatedTrustVerdicts}' input order.
 */
export function federatedTrustNotices(verdicts: readonly FederatedCaTrustVerdict[]): readonly string[] {
  const notices: string[] = [];
  for (const verdict of verdicts) {
    const notice = formatFederatedCaTrustNotice(verdict);
    if (notice !== undefined) notices.push(notice);
  }
  return notices;
}

/**
 * Decide which verdicts get recorded into `fleet.lock`'s `federated_ca_trust[]`
 * as the new approved baseline — call AFTER `publishFederatedTrustLegs` has
 * actually run, passing its result as `legs`.
 *
 * **Recorded ONLY when this run's registry leg for that project reports
 * `'created'`** — i.e. `ensureVariableCreated` actually wrote the manifest's
 * CURRENT declared bundle to the registry this run. This is deliberately
 * NARROWER than "every non-noop verdict":
 *
 * - A `'new'` verdict whose leg is `'created'` (the ordinary first-grant
 *   case) → recorded. The bundle that's now live in the registry IS the
 *   bundle just fingerprinted.
 * - A `'new'` verdict whose leg is `'already-present'` (the registry
 *   variable predates this mechanism — e.g. a fleet that federated this
 *   project before `#1389` shipped, or the operator hand-set it) →
 *   recorded too. This is the "first run baselines rather than refuses"
 *   requirement: `fleet.lock` has NEVER recorded anything for this project
 *   before, so there is no prior approved fact this could contradict —
 *   recording the manifest's CURRENT declaration is the same "close the
 *   detection gap going forward, even on a run that establishes nothing
 *   fresh" posture `age-recipients-narrowing.ts::ageRecipientsRecordAbsentNotice`
 *   already takes for the sibling `age_recipients` field ("any apply that
 *   reconciles... including a run that mints no new credentials — records
 *   the set and closes the detection gap"). It does NOT retroactively prove
 *   the registry's actual stored bytes match (this module has no read-back
 *   primitive to verify that) — it only ever refuses to WIDEN an existing
 *   recorded fact silently, which cannot happen when no fact is recorded
 *   yet.
 * - A `'changed'` verdict whose leg is `'already-present'` (the common
 *   case: the operator edited `ca_bundle` in the manifest, but never removed
 *   the registry variable) → NEVER recorded. Recording the NEW fingerprint
 *   here would make `fleet.lock` claim the new bundle was approved and
 *   applied when the registry still holds the OLD one — the exact "silently
 *   kept" failure this module's doc warns against. The lock keeps pointing
 *   at the old approved fingerprint, so `reconcileFederatedTrustVerdicts`
 *   keeps reporting `'changed'` on every subsequent apply until the operator
 *   removes the variable (at which point the leg becomes `'created'` with
 *   the NEW bundle, and THAT run records it).
 * - A `'changed'` verdict whose leg is `'created'` (the operator removed the
 *   registry variable, then re-ran apply) → recorded. This is the
 *   remediation path `federated-ca-trust.ts`'s `'changed'` notice
 *   instructs: the registry now genuinely holds the new bundle.
 * - Any verdict whose leg is `'failed'`/`'skipped'` → never recorded (no
 *   publish happened; recording would be a pure fabrication).
 *
 * A `'noop'` verdict is never passed a leg worth inspecting either way — its
 * `recordedFingerprint` already equals `liveFingerprint`, so re-recording it
 * would be a no-op write; this function still skips it explicitly rather
 * than relying on that coincidence, so a future verdict shape change can't
 * silently start re-recording every noop.
 */
export function federatedTrustLockUpdates(
  verdicts: readonly FederatedCaTrustVerdict[],
  legs: FederatedTrustPublishResult,
): readonly FederatedCaTrustUpdate[] {
  const updates: FederatedCaTrustUpdate[] = [];
  for (const verdict of verdicts) {
    if (verdict.row === 'noop') continue;
    const legStatus = legs[verdict.project]?.status;
    const freshlyPublished = legStatus === 'created';
    const firstRunBaseline = verdict.row === 'new' && legStatus === 'already-present';
    if (!freshlyPublished && !firstRunBaseline) continue;
    updates.push({ project: verdict.project, caBundleFingerprint: verdict.liveFingerprint });
  }
  return updates;
}
