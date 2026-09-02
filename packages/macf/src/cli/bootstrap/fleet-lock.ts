/**
 * `fleet.lock` composition + serialization — DR-043 §D5 write-through,
 * Slice 2b increment 4 (groundnuty/macf#838, macf#846 review).
 *
 * `fleet.lock` is the fleet's **observed non-secret state** record (schema:
 * `fleet-manifest.ts::FleetLockSchema`). This module is the WRITER half —
 * nothing reads/parses `fleet.lock` here (that's `parseFleetLock` +
 * `observer.ts`'s `readFleetLock`); this composes + serializes one.
 *
 * **Amendment A §A2 lock precedence, applied to the writer side (the READER
 * side — preferring live reads over the lock — is `observer.ts`'s job,
 * unchanged by this module):** "the lock is authoritative ONLY for what
 * cannot be re-derived from reality... a lock-vs-live conflict... is drift:
 * emit `update` + `confirm_required`, never silently resolve." For a WRITER,
 * that means two things:
 *   1. An agent NOT touched by this apply run carries its PRIOR lock entry
 *      forward verbatim (§D3 Design invariant 4 — create / confirm-mutate /
 *      report-extra, NEVER prune) — this run didn't re-derive it, so it
 *      isn't rewritten as if it had been.
 *   2. When a touched agent's freshly-established `app_id`/`install_id`
 *      DIFFERS from what the prior lock recorded (the "App deleted +
 *      recreated" case A2 names explicitly), that is NOT silently absorbed
 *      into the new lock — {@link composeFleetLock} still records the FRESH
 *      value (§D5: the lock records what apply actually established this
 *      run) but surfaces the change via `identityChanges`, so a caller can
 *      honor A2's "never silently resolve" by treating it as
 *      `confirm_required` (mirrors `plan.ts`'s `update` verb) rather than a
 *      quiet overwrite.
 *
 * Fingerprints ({@link secretFingerprint}) are the OTHER half of §D5's
 * fingerprint-pairing: the registry holds the same fingerprint (readable),
 * the vault (`vault-write.ts`) holds the sealed value, this module's lock
 * holds the mapping between them — RAW secret values are hashed immediately
 * on the way in and never appear in a composed/serialized lock.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FleetLock, FleetLockAgent, FleetLockCollaborator, FleetLockFederatedCa, FleetVersions, ScopeCredentialMarker } from './fleet-manifest.js';
import { FLEET_LOCK_SCHEMA_VERSION, FleetLockSchema, effectiveFleetFingerprints, parseFleetLock } from './fleet-manifest.js';

/**
 * Non-secret SHA-256 fingerprint of a secret value, `sha256:<hex>` — matches
 * the shape already fixed by `fleet-manifest.test.ts`'s `parseFleetLock`
 * fixture (`sha256:abc123` et al., predating this module) and self-describes
 * the algorithm so a future change is a distinguishable new prefix, never a
 * silent reinterpretation of an unlabeled hex string.
 *
 * Deliberately NOT `caCertFingerprint` (`@groundnuty/macf-core`): that
 * helper strips `-----BEGIN CERTIFICATE-----` PEM armor specifically for CA
 * certs. `fleet.lock`'s fingerprints cover a broader set — client secrets,
 * webhook secrets, private-key PEMs (`RSA PRIVATE KEY` armor, not
 * `CERTIFICATE`), the CA key, TS OAuth — so this hashes the raw UTF-8 bytes
 * of whatever string is given, no PEM-specific handling.
 *
 * Full 64-char hex (not truncated) — matches `caCertFingerprint`'s own
 * full-length convention (`@groundnuty/macf-core`'s `certs/ca.ts`). The
 * value is never read or typed by a human, so there is no "hard to eyeball"
 * cost to skipping truncation, and full length keeps collision resistance
 * maximal for what is otherwise a cheap, one-shot computation.
 */
export function secretFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf-8').digest('hex')}`;
}

/**
 * One agent's contribution to `fleet.lock`, as `apply` would assemble it for
 * a SINGLE provisioning run — camelCase per repo convention (the wire
 * shape's snake_case names are `FleetLockAgentSchema`'s concern, produced by
 * {@link composeFleetLock}).
 */
export interface FleetLockAgentUpdate {
  readonly appId: string;
  readonly installId: string;
  /**
   * groundnuty/macf#1296 — `owner/repo` this role was provisioned against
   * THIS run (`FleetAgent.repo`, verbatim). `undefined` for a fleet-level
   * pseudo-role update (`RUNNER_OPS_ROLE`/`ROUTER_APP_ROLE` — neither has a
   * per-manifest-agent repo) or for a caller that updates identity fields
   * only (e.g. `fleet-lock-recorder.ts`'s `deployedVersion`-only write) —
   * `composeFleetLock` carries `previous`'s recorded repo forward
   * unconditionally when this is omitted, same "omitted ≠ clobber" contract
   * {@link FleetLockAgentUpdate.deployedVersion} already establishes.
   */
  readonly repo?: string;
  /**
   * Secret name → RAW value ESTABLISHED THIS RUN (e.g. `client_secret`,
   * `webhook_secret`, `app_private_key`). Never persisted as-is — hashed
   * immediately via {@link secretFingerprint} and merged over the agent's
   * PRIOR fingerprints (a secret name absent from `secrets` this run keeps
   * its previously-recorded fingerprint; §D5 write-through only asserts
   * "written this apply," not "every secret re-established every apply").
   */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly deployedVersion?: string;
}

/** One touched agent's `app_id`/`install_id` diverging from what the prior lock recorded — see module doc §A2. */
export interface FleetLockIdentityChange {
  readonly role: string;
  readonly field: 'app_id' | 'install_id';
  readonly previous: string;
  readonly next: string;
}

export interface ComposeFleetLockInput {
  readonly fleet: string;
  /**
   * The lock read at the START of this apply run — Amendment-A §A2's
   * "fallback labeled unverified." `null` on a fleet's first apply. Any
   * role NOT present in `agentUpdates` carries its entry here forward
   * unchanged (§D3 Design invariant 4 — never prune) — this is what keeps a
   * single-agent re-apply from wiping out every OTHER agent's recorded
   * state.
   */
  readonly previous: FleetLock | null;
  /**
   * Per-agent results THIS run actually established — minted (a brand-new
   * App) or live-reconfirmed (`confirmAppInstallation`) — keyed by `role`.
   * A role absent here is untouched this run.
   */
  readonly agentUpdates: Readonly<Record<string, FleetLockAgentUpdate>>;
  /**
   * Fleet-level secrets established/reconfirmed THIS run (the CA key, the
   * dedicated per-fleet router App's key, the routing-client cert/key, ...)
   * — name → RAW value, fingerprinted + merged over the previous lock's
   * effective fleet-level fingerprints (`effectiveFleetFingerprints`,
   * `fleet-manifest.ts`, groundnuty/macf#1310) the same way per-agent
   * secrets are. NOT Tailscale OAuth — that
   * credential is operator-supplied and read-only from `apply`'s
   * perspective (Amendment C); `apply` never establishes or fingerprints a
   * value it never mints.
   */
  readonly fleetSecrets?: Readonly<Record<string, string>>;
  /** `versions:` observed THIS run (§D6 GitOps steering), merged over `previous.versions` field-by-field. */
  readonly versions?: Partial<FleetVersions>;
  /**
   * groundnuty/macf#1162 — scope-level credential markers THIS run resolved
   * (today: only the router App's `'vault-reused'` cross-fleet-shared-scope
   * outcome — see `ScopeCredentialMarkerSchema`'s doc). Merged over
   * `previous.scope_credentials` BY ROLE, fresh always winning (same
   * "fresh wins, previous carries forward" shape {@link mergeFingerprints}
   * already establishes) — never folded into `agentUpdates`/`agents[]`
   * because that array's `install_id` is required and a vault-reused
   * credential has none to record.
   */
  readonly scopeCredentials?: readonly ScopeCredentialUpdate[];
  /**
   * groundnuty/macf#1230 — the recipient set `apply` is recording THIS
   * run (the manifest's declared `transport.age_recipients`, verbatim,
   * whenever the vault was actually written/reconciled against it this
   * run). `undefined` when this run touched no vault recipient state at
   * all — the untouched-carries-forward convention every other fleet-level
   * field in this module already follows ({@link mergeVersions},
   * {@link mergeFingerprints}). NEVER pass an empty array to mean "nothing
   * to record" — that would collide with the real, distinct meaning `[]`
   * carries here (the manifest legitimately declares zero recipients);
   * omit the field entirely instead.
   */
  readonly ageRecipients?: readonly string[];
  /**
   * groundnuty/macf#1230 — recipient(s) removed THIS run via an
   * ACKNOWLEDGED `transport.age_recipients_narrowing_override` (i.e. the
   * caller already confirmed `age-recipients-narrowing.ts::overrideAcknowledged`
   * held, on the SAME `removedAgeRecipients(...)` set this run's
   * `ageRecipients` narrows against). `undefined` when nothing was removed
   * via an acknowledged override this run — the untouched-carries-forward
   * convention every other fleet-level field in this module follows.
   * Unioned into `previous.age_recipients_removed_by_override` (never
   * replaced, never pruned) — see {@link mergeAgeRecipientsRemovedByOverride}.
   */
  readonly ageRecipientsRemovedByOverride?: readonly string[];
  /**
   * groundnuty/macf#1330 — the last-approved age recipient set THIS run is
   * recording per federated peer (`project` → `FleetLockCollaboratorSchema`).
   * `undefined` when this run touched no federated-collaborator recipient
   * state at all — the same untouched-carries-forward convention
   * {@link ageRecipients} above follows, applied one level down (by
   * `project`, via {@link mergeFederatedCollaborators} — never replace the
   * whole array wholesale the way {@link ageRecipients} replaces THIS
   * fleet's own set, since an update to peer A must never drop peer B's
   * already-recorded entry). There is no live caller of this field yet
   * (`#789`'s fetch — the thing that would tell `apply` a peer's CURRENT
   * set — is not built; `collaborators:` reconciliation is day-2,
   * `plan.ts`'s `skipped_sections`); it exists so a hand-set or
   * future-fetch-set lock entry survives a re-apply instead of being
   * silently dropped the next time this function rebuilds the lock from
   * scratch (the exact #1260/#1328 allowlist-drop shape, one layer up from
   * {@link serializeFleetLock}'s own).
   */
  readonly collaboratorRecipients?: readonly FederatedCollaboratorRecipientsUpdate[];
  /**
   * groundnuty/macf#1389 — the last-approved `ca_bundle` FINGERPRINT THIS run
   * is recording per declared `trust.federated_cas[]` project. `undefined`
   * when this run touched no federated-CA-trust state at all — same
   * untouched-carries-forward convention {@link collaboratorRecipients}
   * immediately above follows, applied to CA trust instead of vault-decrypt
   * recipients ({@link mergeFederatedCaTrust} — never replace the whole
   * array wholesale, since an update to project A must never drop project
   * B's already-recorded entry).
   *
   * A caller includes an entry here ONLY for a project this run actually
   * PUBLISHED a fresh `ca_bundle` for (`federated-ca-trust.ts`'s guard row
   * `'new'`, or a `'changed'` row whose registry variable was manually
   * cleared and re-created this run) — never for a project whose registry
   * leg reported `'already-present'` this run while the manifest's declared
   * bundle DIFFERS from what was last approved (that is the `'changed'`
   * row's whole point: the lock must keep pointing at the OLD approved
   * fingerprint so every subsequent apply keeps surfacing the divergence,
   * rather than silently absorbing an unwritten change into "approved").
   * See `apply-fleet.ts`'s `applyFleet` call site for the exact condition.
   */
  readonly federatedCaTrust?: readonly FederatedCaTrustUpdate[];
}

/**
 * One federated collaborator's recipient-set update (groundnuty/macf#1330)
 * — the camelCase "what apply resolved/approved this run" shape
 * {@link composeFleetLock} turns into a full {@link FleetLockCollaborator}.
 * `ageRecipients` here is the value to RECORD (already approved via
 * `federated-age-recipients.ts`'s guard, if a grant/first-federation
 * required consent) — this type carries no consent state of its own; a
 * caller decides whether to include an entry at all.
 */
export interface FederatedCollaboratorRecipientsUpdate {
  readonly project: string;
  readonly ageRecipients: readonly string[];
}

/**
 * One declared `trust.federated_cas[]` project's freshly-approved `ca_bundle`
 * fingerprint (groundnuty/macf#1389) — the camelCase "what apply
 * resolved/approved this run" shape {@link composeFleetLock} turns into a
 * full {@link FleetLockFederatedCa}. `caBundleFingerprint` is the value to
 * RECORD (already computed via `federated-ca-trust.ts::reconcileFederatedCaTrust`
 * — this type carries no consent state of its own; a caller decides whether
 * to include an entry at all, per {@link ComposeFleetLockInput.federatedCaTrust}'s
 * doc on WHEN that is safe).
 */
export interface FederatedCaTrustUpdate {
  readonly project: string;
  readonly caBundleFingerprint: string;
}

/**
 * One scope-credential marker update — the camelCase "what apply resolved"
 * shape {@link composeFleetLock} turns into a full {@link ScopeCredentialMarker}
 * (adding the fixed `scope`/`held`/`pending` vocabulary). `originFleet`
 * mirrors `ScopeCredentialMarkerSchema.origin_fleet`'s optionality exactly:
 * omitted means the operator has not declared a source yet — the marker is
 * still written (never silently indistinguishable from ownership), just
 * without a name to give the source.
 */
export interface ScopeCredentialUpdate {
  readonly role: string;
  readonly originFleet?: string;
}

export interface ComposeFleetLockResult {
  readonly lock: FleetLock;
  /**
   * Non-empty when a touched agent's fresh `app_id`/`install_id` differs
   * from what `previous` recorded — Amendment-A §A2's "App deleted +
   * recreated" drift case. `lock` still carries the FRESH value (§D5: the
   * lock records what apply actually established), but the caller MUST
   * treat a non-empty list as `confirm_required` (mirrors `plan.ts`'s
   * `update` verb) rather than a quiet overwrite — that is the concrete
   * meaning of A2's "never silently resolve" at the writer boundary.
   */
  readonly identityChanges: readonly FleetLockIdentityChange[];
}

/**
 * Merge a fresh secret-name → RAW-value map into a previously-recorded
 * fingerprint map, hashing on the way in. A name present in `fresh`
 * ALWAYS wins (this run re-established it); a name only in `previous` is
 * carried forward untouched. Returns `undefined` (never `{}`) when the
 * merged result is empty, so a composed lock omits the key entirely rather
 * than writing a vacuous `fingerprints: {}` — `plan.ts`'s
 * `secretFingerprintItem` reads "no fingerprints" as "not yet provisioned."
 */
function mergeFingerprints(
  previous: Readonly<Record<string, string>> | undefined,
  fresh: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...previous };
  if (fresh !== undefined) {
    for (const [name, value] of Object.entries(fresh)) {
      merged[name] = secretFingerprint(value);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge `versions:` field-by-field (never `{ ...previous, ...fresh }`) so
 * the result never depends on object-spread key-presence semantics — an
 * explicit `{ macf: undefined }` in `fresh` (permitted by `Partial<T>`'s
 * typing even though no real caller should send it) must NOT clobber a
 * valid `previous.macf`; building each of the two known fields explicitly
 * is immune to that by construction, not by caller discipline.
 */
function mergeVersions(
  previous: Partial<FleetVersions> | undefined,
  fresh: Partial<FleetVersions> | undefined,
): Partial<FleetVersions> | undefined {
  const out: { macf?: string; actions?: string } = {};
  const macf = fresh?.macf ?? previous?.macf;
  const actions = fresh?.actions ?? previous?.actions;
  if (macf !== undefined) out.macf = macf;
  if (actions !== undefined) out.actions = actions;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge fresh {@link ScopeCredentialUpdate}s into previously-recorded
 * {@link ScopeCredentialMarker}s, BY ROLE (never pruned — same "untouched
 * carries forward" contract every other merge in this module keeps). A
 * role present in `fresh` ALWAYS wins and is rebuilt with the fixed
 * `scope: 'scope-level'` / `held: 'locally'` / `pending: 'scope-store'`
 * vocabulary — this function is the ONLY place that vocabulary is written,
 * so a future caller can never construct a differently-worded marker.
 * Sorted by role for {@link serializeFleetLock}'s determinism contract.
 * Returns `undefined` (never `[]`) when the merged result is empty, same
 * "omit rather than write a vacuous array" convention {@link mergeFingerprints}
 * already establishes.
 */
function mergeScopeCredentials(
  previous: readonly ScopeCredentialMarker[] | undefined,
  fresh: readonly ScopeCredentialUpdate[] | undefined,
): ScopeCredentialMarker[] | undefined {
  const byRole = new Map<string, ScopeCredentialMarker>((previous ?? []).map((m) => [m.role, m]));
  for (const update of fresh ?? []) {
    byRole.set(update.role, {
      role: update.role,
      scope: 'scope-level',
      held: 'locally',
      ...(update.originFleet !== undefined ? { origin_fleet: update.originFleet } : {}),
      pending: 'scope-store',
    });
  }
  const merged = [...byRole.values()].sort((a, b) => a.role.localeCompare(b.role));
  return merged.length > 0 ? merged : undefined;
}

/**
 * Merge fresh {@link FederatedCollaboratorRecipientsUpdate}s into
 * previously-recorded {@link FleetLockCollaborator}s, BY PROJECT (never
 * pruned — same "untouched carries forward" contract {@link mergeScopeCredentials}
 * establishes, applied to `project` instead of `role`). A project present in
 * `fresh` ALWAYS wins WHOLESALE for that one entry (mirrors
 * {@link mergeAgeRecipients}'s own "fresh replaces, never unions" rule —
 * `age_recipients` records the last-approved FACT, not an accumulating
 * history); a project only in `previous` (this run touched a DIFFERENT peer,
 * or none) is carried forward untouched. Sorted by project for
 * {@link serializeFleetLock}'s determinism contract — same reasoning
 * {@link mergeScopeCredentials} sorting by role already applies at this
 * array's sibling level. Returns `undefined` (never `[]`) when the merged
 * result is empty, same "omit rather than write a vacuous array" convention
 * {@link mergeFingerprints} already establishes.
 */
function mergeFederatedCollaborators(
  previous: readonly FleetLockCollaborator[] | undefined,
  fresh: readonly FederatedCollaboratorRecipientsUpdate[] | undefined,
): FleetLockCollaborator[] | undefined {
  const byProject = new Map<string, FleetLockCollaborator>((previous ?? []).map((c) => [c.project, c]));
  for (const update of fresh ?? []) {
    byProject.set(update.project, { project: update.project, age_recipients: [...update.ageRecipients] });
  }
  const merged = [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
  return merged.length > 0 ? merged : undefined;
}

/**
 * Merge fresh {@link FederatedCaTrustUpdate}s into previously-recorded
 * {@link FleetLockFederatedCa}s, BY PROJECT — SAME shape
 * {@link mergeFederatedCollaborators} immediately above establishes, applied
 * to CA-trust fingerprints instead of vault-decrypt recipient sets (groundnuty/
 * macf#1389): a project present in `fresh` ALWAYS wins wholesale for that one
 * entry; a project only in `previous` (this run touched a DIFFERENT
 * project's trust, or none at all) is carried forward untouched, never
 * pruned. Sorted by project for {@link serializeFleetLock}'s determinism
 * contract. Returns `undefined` (never `[]`) when the merged result is
 * empty, same "omit rather than write a vacuous array" convention every
 * other merge in this module establishes.
 */
function mergeFederatedCaTrust(
  previous: readonly FleetLockFederatedCa[] | undefined,
  fresh: readonly FederatedCaTrustUpdate[] | undefined,
): FleetLockFederatedCa[] | undefined {
  const byProject = new Map<string, FleetLockFederatedCa>((previous ?? []).map((c) => [c.project, c]));
  for (const update of fresh ?? []) {
    byProject.set(update.project, { project: update.project, ca_bundle_fingerprint: update.caBundleFingerprint });
  }
  const merged = [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
  return merged.length > 0 ? merged : undefined;
}

/**
 * Merge `age_recipients` (groundnuty/macf#1230) — FRESH, when supplied,
 * REPLACES the recorded set WHOLESALE; it is never merged/unioned with
 * `previous`. This is deliberately different from {@link mergeFingerprints}
 * (which grows a map across runs, one entry per DISTINCT secret name):
 * `age_recipients` records a single authoritative fact — "the set apply
 * last successfully wrote the vault against" — not an accumulating
 * history. A caller that instead unioned fresh with previous would
 * silently defeat the narrowing detection this field exists to feed
 * (`age-recipients-narrowing.ts`, not yet wired): a removed recipient
 * would keep reappearing in every subsequent lock forever, and "recorded
 * minus desired" would never be non-empty again.
 *
 * `undefined` (never `[]`) when NEITHER `fresh` nor `previous` has a value
 * — see {@link FleetLockSchema}'s own doc on this field for the
 * absent-means-unknown / `[]`-means-a-real-empty-set distinction this
 * preserves.
 *
 * Order is PRESERVED, never sorted, in both branches — `transport
 * .age_recipients`'s own doc (`fleet-manifest.ts`) notes position carries
 * real information (the operator's key first, the VM's second); sorting
 * would erase that and make a future refusal message list recipients in
 * an order the operator doesn't recognize from their own `fleet.yaml`.
 */
function mergeAgeRecipients(
  previous: readonly string[] | undefined,
  fresh: readonly string[] | undefined,
): string[] | undefined {
  if (fresh !== undefined) return [...fresh];
  return previous !== undefined ? [...previous] : undefined;
}

/**
 * Merge `age_recipients_removed_by_override` (groundnuty/macf#1230) —
 * UNION with `previous`, never replaced, never pruned: this is an
 * append-only ledger of every recipient EVER removed via an acknowledged
 * override, not a snapshot of the current run (that's what
 * {@link mergeAgeRecipients}'s wholesale-replace already records via
 * `age_recipients` itself). A caller that replaced instead of unioned would
 * lose the historical proof for a recipient removed in an EARLIER run the
 * moment a LATER run recorded a different (or empty) `fresh` value.
 *
 * Deduplicated + sorted (localeCompare) — unlike {@link mergeAgeRecipients},
 * position here carries no meaning (this is a historical SET of removed
 * identities, not a currently-declared ordered list), so sorting is safe and
 * gives deterministic output ({@link serializeFleetLock}'s determinism
 * contract, same reason {@link mergeScopeCredentials} sorts by role).
 *
 * `undefined` (never `[]`) when the merged result is empty — same
 * "omit rather than write a vacuous empty collection" convention every
 * other merge in this module follows.
 */
function mergeAgeRecipientsRemovedByOverride(
  previous: readonly string[] | undefined,
  fresh: readonly string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>(previous ?? []);
  for (const r of fresh ?? []) merged.add(r);
  const sorted = [...merged].sort((a, b) => a.localeCompare(b));
  return sorted.length > 0 ? sorted : undefined;
}

/**
 * Compose a `fleet.lock` from a previously-observed lock (or none) plus what
 * THIS apply run established. Pure — no I/O, no clock, no randomness — and
 * always re-validated via `FleetLockSchema.parse()` before returning: "fail
 * loud on a lock we ourselves built wrong" rather than trusting our own
 * construction logic (DR-043 Slice 2b increment 4 deliverable 1).
 */
export function composeFleetLock(input: ComposeFleetLockInput): ComposeFleetLockResult {
  const previousAgents = new Map<string, FleetLockAgent>((input.previous?.agents ?? []).map((a) => [a.role, a]));
  const roles = new Set<string>([...previousAgents.keys(), ...Object.keys(input.agentUpdates)]);

  const agents: FleetLockAgent[] = [];
  const identityChanges: FleetLockIdentityChange[] = [];

  for (const role of roles) {
    const prev = previousAgents.get(role);
    const update = input.agentUpdates[role];

    if (update === undefined) {
      // Untouched this run — carry forward verbatim (no-prune, §D3 invariant 4).
      if (prev !== undefined) agents.push(prev);
      continue;
    }

    if (prev !== undefined) {
      if (prev.app_id !== update.appId) {
        identityChanges.push({ role, field: 'app_id', previous: prev.app_id, next: update.appId });
      }
      if (prev.install_id !== update.installId) {
        identityChanges.push({ role, field: 'install_id', previous: prev.install_id, next: update.installId });
      }
    }

    const fingerprints = mergeFingerprints(prev?.fingerprints, update.secrets);
    const deployedVersion = update.deployedVersion ?? prev?.deployed_version;
    // groundnuty/macf#1296 — same "fresh wins when supplied, else carry
    // previous forward" shape `deployedVersion` immediately above already
    // uses. NEVER an identity-change candidate (see `FleetLockAgentSchema`'s
    // own doc) — `fleet.yaml`'s `repo` is operator-editable free text, so a
    // changed value here is an intentional re-point, not drift.
    const repo = update.repo ?? prev?.repo;
    agents.push({
      role,
      app_id: update.appId,
      install_id: update.installId,
      ...(repo !== undefined ? { repo } : {}),
      ...(fingerprints !== undefined ? { fingerprints } : {}),
      ...(deployedVersion !== undefined ? { deployed_version: deployedVersion } : {}),
    });
  }
  agents.sort((a, b) => a.role.localeCompare(b.role));

  // groundnuty/macf#1310 — read the OLD key (via `effectiveFleetFingerprints`,
  // which falls back to the deprecated `fingerprints` when `previous` predates
  // the rename), write the NEW one only. This is the "a rename must read the
  // old key and write the new one" contract (#1252's undefined-vs-absent
  // lesson, applied to a key rename instead of a missing field): a fleet
  // whose lock still carries the legacy key gets its values carried forward
  // and merged exactly as before, but the composed lock below never emits
  // the legacy key again — the migration happens transparently the next
  // time this fleet is (re-)applied.
  const fleetFingerprints = mergeFingerprints(effectiveFleetFingerprints(input.previous), input.fleetSecrets);
  const versions = mergeVersions(input.previous?.versions, input.versions);
  const scopeCredentials = mergeScopeCredentials(input.previous?.scope_credentials, input.scopeCredentials);
  const ageRecipients = mergeAgeRecipients(input.previous?.age_recipients, input.ageRecipients);
  const ageRecipientsRemovedByOverride = mergeAgeRecipientsRemovedByOverride(
    input.previous?.age_recipients_removed_by_override,
    input.ageRecipientsRemovedByOverride,
  );
  const collaborators = mergeFederatedCollaborators(input.previous?.collaborators, input.collaboratorRecipients);
  const federatedCaTrust = mergeFederatedCaTrust(input.previous?.federated_ca_trust, input.federatedCaTrust);

  const composed: FleetLock = {
    schema_version: FLEET_LOCK_SCHEMA_VERSION,
    fleet: input.fleet,
    agents,
    ...(versions !== undefined ? { versions } : {}),
    ...(fleetFingerprints !== undefined ? { fleet_fingerprints: fleetFingerprints } : {}),
    ...(scopeCredentials !== undefined ? { scope_credentials: scopeCredentials } : {}),
    ...(ageRecipients !== undefined ? { age_recipients: ageRecipients } : {}),
    ...(ageRecipientsRemovedByOverride !== undefined ? { age_recipients_removed_by_override: ageRecipientsRemovedByOverride } : {}),
    ...(collaborators !== undefined ? { collaborators } : {}),
    ...(federatedCaTrust !== undefined ? { federated_ca_trust: federatedCaTrust } : {}),
  };

  return { lock: FleetLockSchema.parse(composed), identityChanges };
}

function sortRecord(rec: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec).sort(([a], [b]) => a.localeCompare(b))) {
    out[key] = value;
  }
  return out;
}

/** `FleetLockAgent` with its fields in `FleetLockAgentSchema`'s declared order + sorted fingerprint keys. */
function orderedAgent(agent: FleetLockAgent): FleetLockAgent {
  const ordered: {
    role: string;
    app_id: string;
    install_id: string;
    repo?: string;
    fingerprints?: Record<string, string>;
    deployed_version?: string;
  } = { role: agent.role, app_id: agent.app_id, install_id: agent.install_id };
  // groundnuty/macf#1296 — MUST be copied through explicitly: this function
  // hand-builds from a field allowlist (`serializeFleetLock`'s module doc),
  // and a field present on `FleetLockAgentSchema`/`composeFleetLock`'s
  // output but absent from this allowlist is silently dropped before disk
  // (the exact #1260 defect this issue's own AC calls out).
  if (agent.repo !== undefined) ordered.repo = agent.repo;
  if (agent.fingerprints !== undefined) ordered.fingerprints = sortRecord(agent.fingerprints);
  if (agent.deployed_version !== undefined) ordered.deployed_version = agent.deployed_version;
  return ordered;
}

/**
 * `ScopeCredentialMarker` with its fields in `ScopeCredentialMarkerSchema`'s
 * declared order (`role, scope, held, origin_fleet, pending`) — same
 * defensive re-ordering `orderedAgent` applies, in case a caller hand-built
 * one out of order. Uses inline conditional spread (not post-hoc
 * assignment) specifically because the optional field sits BETWEEN two
 * required ones in the declared order — an assign-after-the-fact would put
 * `origin_fleet` last regardless of the schema's declared position.
 */
function orderedScopeCredential(marker: ScopeCredentialMarker): ScopeCredentialMarker {
  return {
    role: marker.role,
    scope: marker.scope,
    held: marker.held,
    ...(marker.origin_fleet !== undefined ? { origin_fleet: marker.origin_fleet } : {}),
    pending: marker.pending,
  };
}

/**
 * `FleetLockCollaborator` with its fields in `FleetLockCollaboratorSchema`'s
 * declared order (groundnuty/macf#1330) — same defensive re-ordering
 * `orderedAgent`/`orderedScopeCredential` apply. `age_recipients` is copied
 * VERBATIM, order preserved (unlike the collaborators ARRAY itself, which
 * `serializeFleetLock` sorts by `project`) — same "position is real
 * information within one recipient set, but not across peers" split the
 * top-level `age_recipients` field's own doc already draws.
 */
function orderedCollaborator(collaborator: FleetLockCollaborator): FleetLockCollaborator {
  return { project: collaborator.project, age_recipients: [...collaborator.age_recipients] };
}

/**
 * `FleetLockFederatedCa` with its fields in `FleetLockFederatedCaSchema`'s
 * declared order (groundnuty/macf#1389) — same defensive re-ordering
 * `orderedCollaborator` applies for its sibling field.
 */
function orderedFederatedCaTrust(entry: FleetLockFederatedCa): FleetLockFederatedCa {
  return { project: entry.project, ca_bundle_fingerprint: entry.ca_bundle_fingerprint };
}

/**
 * Serialize a `FleetLock` deterministically — stable key order (matching
 * `FleetLockSchema`'s declared field order top-to-bottom, `agents[]` sorted
 * by `role`, every fingerprint map sorted by secret name) + a trailing
 * newline, so a re-apply that changes nothing produces a byte-identical
 * file and a re-apply that changes one field produces a minimal diff.
 *
 * Re-validates via `FleetLockSchema.parse()` — this is the boundary a
 * caller could feed a hand-built (not `composeFleetLock`-produced) object
 * through; never trust an unvalidated shape onto disk.
 *
 * JSON, not YAML block style: `fleet.lock` is machine-written-only (per the
 * `fleet-manifest.ts` module doc, "kept in the same YAML-superset format as
 * fleet.yaml... so one parser serves both artifacts") — JSON is valid YAML,
 * so `parseFleetLock`'s existing `yaml`-package parser reads this back with
 * no format-specific writer needed on the other side.
 */
export function serializeFleetLock(lock: FleetLock): string {
  const validated = FleetLockSchema.parse(lock);
  const ordered: {
    schema_version: number;
    fleet: string;
    agents: FleetLockAgent[];
    versions?: Partial<FleetVersions>;
    fleet_fingerprints?: Record<string, string>;
    scope_credentials?: ScopeCredentialMarker[];
    age_recipients?: string[];
    age_recipients_removed_by_override?: string[];
    collaborators?: FleetLockCollaborator[];
    federated_ca_trust?: FleetLockFederatedCa[];
  } = {
    schema_version: validated.schema_version,
    fleet: validated.fleet,
    agents: [...validated.agents].sort((a, b) => a.role.localeCompare(b.role)).map(orderedAgent),
  };
  if (validated.versions !== undefined) ordered.versions = validated.versions;
  // groundnuty/macf#1310 — read EITHER key (a caller could feed this
  // function a hand-built object that still only carries the deprecated
  // `fingerprints` key; this is the boundary that never trusts an
  // unvalidated shape onto disk, so it upgrades on the way out too), write
  // `fleet_fingerprints` ONLY. The legacy key is deliberately absent from
  // this `ordered` allowlist — the same allowlist shape #1260's own
  // regression pin exists for — so a lock re-serialized through this
  // function always finishes migrated, never carrying both keys at once.
  const fleetFingerprints = effectiveFleetFingerprints(validated);
  if (fleetFingerprints !== undefined) ordered.fleet_fingerprints = sortRecord(fleetFingerprints);
  if (validated.scope_credentials !== undefined) {
    ordered.scope_credentials = [...validated.scope_credentials].sort((a, b) => a.role.localeCompare(b.role)).map(orderedScopeCredential);
  }
  // groundnuty/macf#1230 — NOT sorted (unlike every other array field
  // above): position is real information here (mergeAgeRecipients's own
  // doc), so this is a verbatim copy, order preserved.
  if (validated.age_recipients !== undefined) ordered.age_recipients = [...validated.age_recipients];
  // groundnuty/macf#1230 — the append-only override ledger. Already sorted +
  // deduplicated by `mergeAgeRecipientsRemovedByOverride` (unlike
  // `age_recipients` immediately above, position carries no meaning here),
  // so this copy needs no further ordering — same "verbatim copy" shape.
  if (validated.age_recipients_removed_by_override !== undefined) {
    ordered.age_recipients_removed_by_override = [...validated.age_recipients_removed_by_override];
  }
  // groundnuty/macf#1330 — sorted by project (like `scope_credentials` by
  // role above); each entry's OWN `age_recipients` stays verbatim-ordered
  // (`orderedCollaborator`'s own doc).
  if (validated.collaborators !== undefined) {
    ordered.collaborators = [...validated.collaborators].sort((a, b) => a.project.localeCompare(b.project)).map(orderedCollaborator);
  }
  // groundnuty/macf#1389 — sorted by project, same reasoning `collaborators`
  // immediately above already applies; each entry has no verbatim-order
  // sub-field to preserve (`orderedFederatedCaTrust`'s own doc — a single
  // required fingerprint, not an ordered set).
  if (validated.federated_ca_trust !== undefined) {
    ordered.federated_ca_trust = [...validated.federated_ca_trust].sort((a, b) => a.project.localeCompare(b.project)).map(orderedFederatedCaTrust);
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Write a `FleetLock` to disk. Thin I/O leaf (same posture as
 * `observer.ts`'s `gh`-shelling fns / `manifest-exchange.ts`'s `gh` call) —
 * `composeFleetLock` + `serializeFleetLock` carry all the logic and are
 * fully unit-tested without a filesystem; this function is not.
 */
export function writeFleetLock(path: string, lock: FleetLock): void {
  writeFileSync(path, serializeFleetLock(lock), 'utf-8');
}

/**
 * Read + parse a `FleetLock` from an EXACT path (as opposed to
 * `observer.ts::readFleetLock`, which derives the path from a manifest
 * file's directory). Returns `null` when absent or malformed — NEVER throws
 * (same posture as `observer.ts::readFleetLock`, which now delegates here).
 *
 * Added for DR-043 Amendment F (macf#857): `apply-fleet.ts` needs this to
 * read `fleet.lock` back out of a freshly-cloned `<fleet>-control` checkout
 * (a plain directory path, not a manifest file path) so a REUSE run
 * self-heals its `priorLock` from the control repo's own committed history,
 * rather than trusting only whatever the caller passed in.
 */
export function readFleetLockFile(lockPath: string): FleetLock | null {
  if (!existsSync(lockPath)) return null;
  try {
    return parseFleetLock(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}
