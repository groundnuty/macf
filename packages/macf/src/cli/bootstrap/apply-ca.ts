/**
 * The per-project CA ceremony — DR-043 §D5 / Amendment D phase 2 (groundnuty/
 * macf#838), retiring the `plan.ts::APPLY_UNIMPLEMENTED_REASONS.ca` gap
 * (macf#854): "apply has no CA-provisioning step at all."
 *
 * Two decisions, kept structurally separate so the credential-safety
 * property is easy to audit:
 *
 *   1. **{@link resolveCaCert} — mint-or-reuse, never re-mint.** Decides
 *      whether a fresh CA keypair is needed, reads the value back when one
 *      already exists, and REFUSES (rather than guesses) whenever the
 *      evidence is ambiguous. The private key it may return lives ONLY in
 *      this function's return value and the caller's local variables — it is
 *      NEVER placed on {@link CaApplyOutcome} (the redacted, render-safe
 *      mirror {@link redactCaResolve} produces) or anywhere `FleetApplyResult`
 *      reaches, mirroring `commands/bootstrap-apply.ts`'s `redactIdentity`
 *      precedent for `AgentApplyOutcome.created.credentials`.
 *   2. **{@link publishCaCertLegs} — the SINGLE registry-scope PUBLIC-cert
 *      write (groundnuty/macf#800, superseding the macf#806 two-place
 *      write).** Takes an ALREADY-RESOLVED cert PEM (never a key) and
 *      create-only-writes it ONCE, to the fleet's registry scope, via
 *      `ensure-variable.ts::ensureVariableCreated`. Deliberately a SEPARATE
 *      function from (1) — `apply-fleet.ts` calls this ONLY after confirming
 *      the corresponding key (when freshly minted) is durable in `vault.age`
 *      (§D5 "durable before gate 2," the same ordering discipline applied
 *      here as `apply-agent.ts`'s recovery artifact — see `apply-fleet.ts`'s
 *      module doc for the exact sequencing). Publishing a cert whose key was
 *      never durably persisted would recreate the #799 orphan-cert failure
 *      class the moment the vault write failed on a fresh mint.
 *
 *      **Why not two-place any more (groundnuty/macf#800).** The original
 *      macf#806 design also `createRepoVariable`-wrote the SAME cert to
 *      every router-carrying repo, on the theory that a per-repo reader
 *      needed a per-repo copy. It didn't: `registry-api-path` (the reader's
 *      OWN scope selector, `apply-routing.ts`/`fleet-manifest.ts` — macf#810)
 *      decides where a caller reads from, and `createRepoVariable` here
 *      decided where THIS write landed — two independent paths that macf#800's
 *      thread found conflated more than once. Writing per-repo meant a CA
 *      rotation had to touch N+1 places to stay consistent, and any place it
 *      missed silently kept serving a stale cert — the exact "CA rotation
 *      silently orphans routing" failure macf#800 reports. A single
 *      registry-scope write removes the N+1 requirement entirely: rotate
 *      once, every fleet-scope reader sees it. Pre-existing per-repo copies
 *      from before this change are NOT deleted by this function (or by
 *      anything in `apply`) — see `plan.ts::caRepoItem`'s doc for why they
 *      are rendered as `'orphan'`, not removed.
 *
 * **Never mint twice.** {@link resolveCaCert} treats "a CA cert is already
 * present in the registry" OR "`fleet.lock` already records a `ca_key`
 * fingerprint" as REUSE signals — either alone is sufficient, and an
 * AMBIGUOUS combination (lock says minted, registry says otherwise) REFUSES
 * outright rather than minting a replacement that would silently orphan the
 * already-vaulted key (the exact DR-010-amendment / silent-fallback Instance
 * 16 shape).
 *
 * **The ambiguous case now has a THIRD option, not just refuse-or-mint
 * (groundnuty/macf#978, DR-043 Amendment D phase 3).** `macf fleet
 * deactivate` deletes exactly the registry leg this refusal is about — and
 * never touches `fleet.lock` — so "lock says minted, registry says absent"
 * is not only the orphan-key failure shape, it is also the routine
 * post-deactivate state. When the caller supplies `deps.readVaultCaCert`
 * (wired only when the operator gave BOTH `--vault`/`--identity-key`) and
 * the registry read is a DEFINITE `'absent'` (not `'unknown'` — see below),
 * {@link resolveCaCert} tries the vault FIRST: the cert is public material
 * `deactivate` never removes, so republishing it is a plain `'restored'`
 * reuse — never a re-mint, never the private key leaving the vault. No
 * vault, no identity, an `'unknown'` registry read, or a vault that simply
 * has nothing for this fleet all fall through to the ORIGINAL refusal text,
 * byte-identical.
 *
 * **No-recipient pre-flight (mirrors `apply-fleet.ts::wouldCreateWithNoRecipient`).**
 * A fresh mint is refused OUTRIGHT when `transport.age_recipients` is empty
 * — minting first and discovering there is nowhere to durably store the key
 * would produce a real, unrecoverable CA key existing only in process
 * memory, the fleet-level analogue of the per-agent credential-loss hole
 * DR-043 §D5's Amendment B closed. Unlike the per-agent case, there is no
 * PARTIAL harm to salvage here (an unpublished CA cert has touched nothing
 * external) — refusing before generating any key material at all is strictly
 * simpler and just as safe.
 *
 * `createCA` (`@groundnuty/macf-core`) is REUSED for the actual keypair
 * generation + self-signed X.509 issuance — see {@link realMintCa}'s doc for
 * why its OWN registry-upload path is deliberately never invoked here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { createCA, caCertFingerprint, toVariableSegment } from '@groundnuty/macf-core';
import type { Presence } from './plan.js';
import type { CreateVariableResult } from './variable-write.js';
import { realCreateVariable } from './variable-write.js';
import type { EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated } from './ensure-variable.js';
import { registryPathPrefix } from '../registry-helper.js';

/** `<SEG>_CA_CERT` — the DR two-place-rule variable name (macf#806), same segment derivation `plan.ts::computePlan` already uses. */
export function caCertVariableName(fleetName: string): string {
  return `${toVariableSegment(fleetName)}_CA_CERT`;
}

// --- Mint-or-reuse decision ---

/** The RAW resolve outcome — carries `keyPem` for the `'minted'` variant. NEVER store this on `FleetApplyResult`; use {@link redactCaResolve}'s output there instead. */
export type CaResolveOutcome =
  | { readonly status: 'minted'; readonly certPem: string; readonly keyPem: string }
  | { readonly status: 'reused'; readonly certPem: string }
  /**
   * groundnuty/macf#978 — the registry leg was confirmably ABSENT (not
   * merely unconfirmable) but the cert was recovered from the vault instead
   * of refused. Deliberately its OWN status, not folded into `'reused'`:
   * `'reused'` means "the registry already had it, nothing needed fixing";
   * `'restored'` means "the registry was missing it and this run put it
   * back" — a real, worth-distinguishing action, even though both publish
   * the SAME way (see `apply-fleet.ts`'s `certToPublish` gating, which
   * treats them identically: neither carries a fresh key needing a
   * durability gate). Same shape as `'reused'` (`certPem` only) — restoring
   * NEVER hands back a private key; only the public cert is ever pulled out
   * of the vault on this path.
   */
  | { readonly status: 'restored'; readonly certPem: string }
  | { readonly status: 'failed'; readonly reason: string };

/** Render-safe mirror of {@link CaResolveOutcome} — NEVER carries `certPem`/`keyPem`. This, not the raw outcome, is what `FleetApplyResult.ca.resolve` holds. */
export interface CaApplyOutcome {
  readonly status: 'minted' | 'reused' | 'restored' | 'failed';
  readonly reason?: string;
  /** Non-secret SHA-256 fingerprint of the cert DER (`@groundnuty/macf-core::caCertFingerprint`) — `'minted'`/`'reused'`/`'restored'` only. Safe to log/render; proves nothing about the private key. */
  readonly certFingerprint?: string;
}

/** Strip every credential field before a `CaResolveOutcome` is allowed near `FleetApplyResult` or a `--json` render. Pure. */
export function redactCaResolve(outcome: CaResolveOutcome): CaApplyOutcome {
  switch (outcome.status) {
    case 'minted':
    case 'reused':
    case 'restored':
      return { status: outcome.status, certFingerprint: caCertFingerprint(outcome.certPem) };
    case 'failed':
      return { status: 'failed', reason: outcome.reason };
  }
}

export interface CaMintDeps {
  readonly checkRegistryPresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly readRegistryVariable: (registry: RegistryConfig, name: string) => Promise<string | undefined>;
  readonly mintCa: (project: string) => Promise<{ readonly certPem: string; readonly keyPem: string }>;
  /**
   * groundnuty/macf#978 — the vault-restore fallback for the
   * `lockHasCaKey && registryPresence === 'absent'` refusal below. `undefined`
   * (the default — every existing caller/test that doesn't set this field)
   * means "vault-aware CA restore is NOT engaged this run," the EXACT
   * pre-#978 behaviour: the refusal fires unconditionally, byte-identical.
   *
   * Wired only by `commands/bootstrap-apply.ts::resolveMutateDeps`, and only
   * when the operator supplied BOTH `--vault`/`--identity-key` — mirrors the
   * SAME "vault-aware confirm is opt-in, absent flags means absent feature"
   * contract `resolveVaultAgentPems`/`CreateGuardDeps.resolveKeyPath`
   * (macf#913) already establish, so this is a THIRD instance of that same
   * shape, not a new one.
   *
   * **Contract: NEVER throws.** Any decrypt/parse failure (missing vault,
   * wrong identity, malformed plaintext) MUST be swallowed and reported as
   * `undefined` — the SAME "a failed vault read degrades to the pre-vault-
   * aware behaviour, never a false state" floor `resolveVaultAgentPems`'s own
   * doc establishes (DR-043 Amendment A4, honest-unknown-over-false-present,
   * extended here to honest-refusal-over-false-restore). {@link resolveCaCert}
   * ALSO wraps this call in its own try/catch as defense-in-depth (it never
   * throws by its own contract either), but a caller SHOULD NOT rely on that
   * as the primary safety net.
   *
   * **Contract: never logs.** Any diagnostic about WHY the read failed is the
   * wiring caller's responsibility (see `resolveMutateDeps`'s own
   * implementation) — this function returns only `string | undefined`, never
   * a side-channel.
   */
  readonly readVaultCaCert?: (project: string) => Promise<string | undefined>;
}

async function readExistingCert(registry: RegistryConfig, varName: string, deps: CaMintDeps): Promise<CaResolveOutcome> {
  const certPem = await deps.readRegistryVariable(registry, varName);
  if (certPem === undefined || certPem.trim().length === 0) {
    return {
      status: 'failed',
      reason: `registry var "${varName}" reports present but its value could not be read (empty/unreadable) — refusing to publish an empty cert to any repo leg.`,
    };
  }
  return { status: 'reused', certPem };
}

/**
 * Decide mint-vs-reuse-vs-refuse. See the module doc for the full decision
 * table. NEVER throws — every failure resolves to `status: 'failed'`.
 *
 * @param lockHasCaKey `effectiveFleetFingerprints(fleet.lock)?.ca_key !== undefined`
 *   (groundnuty/macf#1310 — reads `fleet_fingerprints`, falling back to the
 *   deprecated `fingerprints` key for a pre-rename lock) — a PRIOR successful
 *   apply already vaulted a CA key for this fleet.
 * @param recipients `manifest.transport.age_recipients` — the no-recipient
 *   pre-flight input (see module doc).
 */
export async function resolveCaCert(
  fleetName: string,
  registry: RegistryConfig,
  lockHasCaKey: boolean,
  recipients: readonly string[],
  deps: CaMintDeps,
): Promise<CaResolveOutcome> {
  const varName = caCertVariableName(fleetName);

  let registryPresence: Presence;
  try {
    registryPresence = await deps.checkRegistryPresence(registry, varName);
  } catch (err) {
    return { status: 'failed', reason: `could not confirm CA registry-var presence: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (lockHasCaKey) {
    if (registryPresence === 'present') {
      return readExistingCert(registry, varName, deps);
    }

    // groundnuty/macf#978 — try the vault BEFORE refusing, but only for a
    // DEFINITE 'absent' (the `deactivate`-then-`apply` shape this issue
    // fixes) and only when a vault-read dep was actually wired (both
    // --vault/--identity-key supplied this run). An 'unknown' registry read
    // stays on the refusal path unconditionally — Amendment A4's
    // honest-unknown floor: an unconfirmable read is not evidence the cert
    // is gone, so don't spend a vault decrypt chasing a maybe.
    if (registryPresence === 'absent' && deps.readVaultCaCert !== undefined) {
      let vaultCertPem: string | undefined;
      try {
        vaultCertPem = await deps.readVaultCaCert(fleetName);
      } catch {
        // Contract violation by the caller (readVaultCaCert must never
        // throw) — defense-in-depth only; treat exactly like "vault had
        // nothing for this fleet" and fall through to the refusal below.
        vaultCertPem = undefined;
      }
      if (vaultCertPem !== undefined) {
        return { status: 'restored', certPem: vaultCertPem };
      }
    }

    return {
      status: 'failed',
      reason:
        `fleet.lock records a previously-minted CA key, but the registry var "${varName}" is not confirmable ` +
        `present (observed: ${registryPresence}) — refusing to mint a REPLACEMENT (would orphan the already` +
        '-vaulted key). Re-materializing the cert from the vaulted key needs a vault ' +
        'read, not a fresh mint. Investigate manually.',
    };
  }

  if (registryPresence === 'present') {
    // A CA cert exists out-of-band (e.g. `macf certs init` ran separately, or
    // a prior apply published the cert but crashed before the vault write) —
    // reuse it. The private key is NOT recoverable from a public cert; this
    // fleet's vault may be missing it until a manual fix (out of scope here).
    return readExistingCert(registry, varName, deps);
  }
  if (registryPresence === 'unknown') {
    return {
      status: 'failed',
      reason:
        `could not confirm whether registry var "${varName}" already exists (auth / network / rate-limit) — ` +
        'refusing to mint a possibly-duplicate CA. Re-run once the read can complete (an unknown state is ' +
        'never treated as confirmed-present).',
    };
  }

  // registryPresence === 'absent', lockHasCaKey === false — genuinely fresh.
  if (recipients.length === 0) {
    return {
      status: 'failed',
      reason:
        'no CA exists yet for this fleet, but transport.age_recipients is empty — a freshly-minted CA key could ' +
        'NEVER be made durable. Refusing to mint. Mint an age recipient and add it to ' +
        'transport.age_recipients in fleet.yaml, then re-run.',
    };
  }
  const { certPem, keyPem } = await deps.mintCa(fleetName);
  return { status: 'minted', certPem, keyPem };
}

// --- Single registry-scope publish (public cert only — never a key) ---

/**
 * `checkRepoPresence`/`createRepoVariable` are NOT used by
 * {@link publishCaCertLegs} any more (groundnuty/macf#800 — see the module
 * doc's "Why not two-place any more"). They stay on this interface because
 * `apply-routing.ts::RoutingApplyDeps` is `Pick<CaApplyDeps, 'checkRepoPresence'
 * | 'createRepoVariable'>` — a completely different write (`MACF_TRUSTED_ACTORS`)
 * that genuinely IS per-repo, sharing this bag purely for wiring convenience
 * at `apply-fleet.ts`'s single combined `trustDeps` call site. Removing these
 * fields would break that unrelated consumer, not just this one.
 */
export interface CaApplyDeps extends CaMintDeps {
  readonly createRegistryVariable: (registry: RegistryConfig, name: string, value: string) => Promise<CreateVariableResult>;
  readonly checkRepoPresence: (repo: string, name: string) => Promise<Presence>;
  readonly createRepoVariable: (repo: string, name: string, value: string) => Promise<CreateVariableResult>;
}

export interface CaPublishResult {
  readonly registryLeg: EnsureVariableOutcome;
}

/**
 * Create-only SINGLE-scope publish of an ALREADY-RESOLVED cert PEM
 * (groundnuty/macf#800). `certPem` is public material — safe to pass around
 * and log its fingerprint, but this function never receives (and could not
 * leak) a private key. See the module doc for the ordering constraint the
 * CALLER (`apply-fleet.ts`) is responsible for honoring before invoking this
 * on a `'minted'` result.
 *
 * No `repos` parameter (groundnuty/macf#800 dropped it) — this function
 * writes to exactly one place, `registry`, and nowhere else. Pre-existing
 * per-repo `<SEG>_CA_CERT` copies from before this change are left
 * completely untouched by this function (never read, never written, never
 * deleted) — `plan.ts::caRepoItem` is what reports on them now.
 */
export async function publishCaCertLegs(certPem: string, fleetName: string, registry: RegistryConfig, deps: CaApplyDeps): Promise<CaPublishResult> {
  const varName = caCertVariableName(fleetName);
  const registryLeg = await ensureVariableCreated(
    {
      checkPresence: () => deps.checkRegistryPresence(registry, varName),
      create: () => deps.createRegistryVariable(registry, varName, certPem),
    },
    `CA registry var "${varName}"`,
  );
  return { registryLeg };
}

/** The `CaPublishResult` shape for "never attempted this run" (CA resolve failed, or a fresh mint's vault write did not succeed — see `apply-fleet.ts`'s ordering doc). Pure. */
export function skippedCaPublish(reason: string): CaPublishResult {
  return { registryLeg: { status: 'skipped', reason } };
}

// --- Real deps ---

/**
 * Real CA keypair generation — reuses `@groundnuty/macf-core::createCA` for
 * the actual RSA-keypair + self-signed-X.509 issuance (task requirement:
 * build on the existing primitive, don't reimplement crypto). Writes to a
 * SCRATCH dir under `os.tmpdir()` (mirrors `apply-agent.ts::writeScratchPem`
 * — NEVER inside the control-repo checkout, per that module's + `control-
 * repo.ts`'s "phase-3 forward guard" doc sections) and deletes it in
 * `finally` regardless of outcome — the CA private key touches local disk
 * only transiently, for the duration of this one call.
 *
 * `client` is DELIBERATELY OMITTED from the `createCA` call — its optional
 * registry-upload path calls `GitHubVariablesClient.writeVariable`, which
 * (`@groundnuty/macf-core`'s `github-client.ts`) is PATCH-then-POST (upsert)
 * — that violates DR-043's create-only posture (never silently overwrite).
 * This module does its OWN create-only registry-scope publish instead
 * ({@link publishCaCertLegs}) — don't "simplify" this by re-adding a client
 * here.
 */
export async function realMintCa(project: string): Promise<{ readonly certPem: string; readonly keyPem: string }> {
  const dir = mkdtempSync(join(tmpdir(), `macf-bootstrap-ca-${project}-`));
  try {
    const certPath = join(dir, 'ca-cert.pem');
    const keyPath = join(dir, 'ca-key.pem');
    const { certPem, keyPem } = await createCA({ project, certPath, keyPath });
    return { certPem, keyPem };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Real registry-scope create-only write — `registryPathPrefix` + `variable-write.ts::realCreateVariable`. */
export async function realCreateRegistryVariable(registry: RegistryConfig, name: string, value: string): Promise<CreateVariableResult> {
  return realCreateVariable(registryPathPrefix(registry), name, value);
}

/** Real repo-scope create-only write — `variable-write.ts::realCreateVariable` against `repos/<owner>/<repo>`. */
export async function realCreateRepoVariable(repo: string, name: string, value: string): Promise<CreateVariableResult> {
  return realCreateVariable(`repos/${repo}`, name, value);
}
