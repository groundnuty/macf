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
import type { FleetLock, FleetLockAgent, FleetVersions, ScopeCredentialMarker } from './fleet-manifest.js';
import { FLEET_LOCK_SCHEMA_VERSION, FleetLockSchema, parseFleetLock } from './fleet-manifest.js';

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
   * — name → RAW value, fingerprinted + merged over `previous.fingerprints`
   * the same way per-agent secrets are. NOT Tailscale OAuth — that
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

  const fingerprints = mergeFingerprints(input.previous?.fingerprints, input.fleetSecrets);
  const versions = mergeVersions(input.previous?.versions, input.versions);
  const scopeCredentials = mergeScopeCredentials(input.previous?.scope_credentials, input.scopeCredentials);
  const ageRecipients = mergeAgeRecipients(input.previous?.age_recipients, input.ageRecipients);
  const ageRecipientsRemovedByOverride = mergeAgeRecipientsRemovedByOverride(
    input.previous?.age_recipients_removed_by_override,
    input.ageRecipientsRemovedByOverride,
  );

  const composed: FleetLock = {
    schema_version: FLEET_LOCK_SCHEMA_VERSION,
    fleet: input.fleet,
    agents,
    ...(versions !== undefined ? { versions } : {}),
    ...(fingerprints !== undefined ? { fingerprints } : {}),
    ...(scopeCredentials !== undefined ? { scope_credentials: scopeCredentials } : {}),
    ...(ageRecipients !== undefined ? { age_recipients: ageRecipients } : {}),
    ...(ageRecipientsRemovedByOverride !== undefined ? { age_recipients_removed_by_override: ageRecipientsRemovedByOverride } : {}),
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
    fingerprints?: Record<string, string>;
    scope_credentials?: ScopeCredentialMarker[];
    age_recipients?: string[];
    age_recipients_removed_by_override?: string[];
  } = {
    schema_version: validated.schema_version,
    fleet: validated.fleet,
    agents: [...validated.agents].sort((a, b) => a.role.localeCompare(b.role)).map(orderedAgent),
  };
  if (validated.versions !== undefined) ordered.versions = validated.versions;
  if (validated.fingerprints !== undefined) ordered.fingerprints = sortRecord(validated.fingerprints);
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
