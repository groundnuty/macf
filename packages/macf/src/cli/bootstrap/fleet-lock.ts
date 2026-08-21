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
import type { FleetLock, FleetLockAgent, FleetVersions } from './fleet-manifest.js';
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
    agents.push({
      role,
      app_id: update.appId,
      install_id: update.installId,
      ...(fingerprints !== undefined ? { fingerprints } : {}),
      ...(deployedVersion !== undefined ? { deployed_version: deployedVersion } : {}),
    });
  }
  agents.sort((a, b) => a.role.localeCompare(b.role));

  const fingerprints = mergeFingerprints(input.previous?.fingerprints, input.fleetSecrets);
  const versions = mergeVersions(input.previous?.versions, input.versions);

  const composed: FleetLock = {
    schema_version: FLEET_LOCK_SCHEMA_VERSION,
    fleet: input.fleet,
    agents,
    ...(versions !== undefined ? { versions } : {}),
    ...(fingerprints !== undefined ? { fingerprints } : {}),
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
    fingerprints?: Record<string, string>;
    deployed_version?: string;
  } = { role: agent.role, app_id: agent.app_id, install_id: agent.install_id };
  if (agent.fingerprints !== undefined) ordered.fingerprints = sortRecord(agent.fingerprints);
  if (agent.deployed_version !== undefined) ordered.deployed_version = agent.deployed_version;
  return ordered;
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
  } = {
    schema_version: validated.schema_version,
    fleet: validated.fleet,
    agents: [...validated.agents].sort((a, b) => a.role.localeCompare(b.role)).map(orderedAgent),
  };
  if (validated.versions !== undefined) ordered.versions = validated.versions;
  if (validated.fingerprints !== undefined) ordered.fingerprints = sortRecord(validated.fingerprints);
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
