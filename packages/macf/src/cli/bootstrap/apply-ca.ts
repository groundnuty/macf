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
 *   2. **{@link publishCaCertLegs} — the two-place PUBLIC-cert write
 *      (macf#806).** Takes an ALREADY-RESOLVED cert PEM (never a key) and
 *      create-only-writes it to the registry + every given repo via
 *      `ensure-variable.ts::ensureVariableCreated`. Deliberately a SEPARATE
 *      function from (1) — `apply-fleet.ts` calls this ONLY after confirming
 *      the corresponding key (when freshly minted) is durable in `vault.age`
 *      (§D5 "durable before gate 2," the same ordering discipline applied
 *      here as `apply-agent.ts`'s recovery artifact — see `apply-fleet.ts`'s
 *      module doc for the exact sequencing). Publishing a cert whose key was
 *      never durably persisted would recreate the #799 orphan-cert failure
 *      class the moment the vault write failed on a fresh mint.
 *
 * **Never mint twice.** {@link resolveCaCert} treats "a CA cert is already
 * present in the registry" OR "`fleet.lock` already records a `ca_key`
 * fingerprint" as REUSE signals — either alone is sufficient, and an
 * AMBIGUOUS combination (lock says minted, registry says otherwise) REFUSES
 * outright rather than minting a replacement that would silently orphan the
 * already-vaulted key (the exact DR-010-amendment / silent-fallback Instance
 * 16 shape). Re-materializing from an orphaned vault key is DR-043 Amendment
 * D phase 3+ (vault-read) scope — out of this increment.
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
import type { EnsureVariableDeps, EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, skippedOutcomesFor } from './ensure-variable.js';
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
  | { readonly status: 'failed'; readonly reason: string };

/** Render-safe mirror of {@link CaResolveOutcome} — NEVER carries `certPem`/`keyPem`. This, not the raw outcome, is what `FleetApplyResult.ca.resolve` holds. */
export interface CaApplyOutcome {
  readonly status: 'minted' | 'reused' | 'failed';
  readonly reason?: string;
  /** Non-secret SHA-256 fingerprint of the cert DER (`@groundnuty/macf-core::caCertFingerprint`) — `'minted'`/`'reused'` only. Safe to log/render; proves nothing about the private key. */
  readonly certFingerprint?: string;
}

/** Strip every credential field before a `CaResolveOutcome` is allowed near `FleetApplyResult` or a `--json` render. Pure. */
export function redactCaResolve(outcome: CaResolveOutcome): CaApplyOutcome {
  switch (outcome.status) {
    case 'minted':
    case 'reused':
      return { status: outcome.status, certFingerprint: caCertFingerprint(outcome.certPem) };
    case 'failed':
      return { status: 'failed', reason: outcome.reason };
  }
}

export interface CaMintDeps {
  readonly checkRegistryPresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly readRegistryVariable: (registry: RegistryConfig, name: string) => Promise<string | undefined>;
  readonly mintCa: (project: string) => Promise<{ readonly certPem: string; readonly keyPem: string }>;
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
 * @param lockHasCaKey `fleet.lock.fingerprints.ca_key !== undefined` — a
 *   PRIOR successful apply already vaulted a CA key for this fleet.
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
    if (registryPresence !== 'present') {
      return {
        status: 'failed',
        reason:
          `fleet.lock records a previously-minted CA key, but the registry var "${varName}" is not confirmable ` +
          `present (observed: ${registryPresence}) — refusing to mint a REPLACEMENT (would orphan the already` +
          '-vaulted key, the #799 failure class). Re-materializing the cert from the vaulted key needs a vault ' +
          'read (DR-043 Amendment D phase 3+), not a fresh mint. Investigate manually.',
      };
    }
    return readExistingCert(registry, varName, deps);
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
        'refusing to mint a possibly-duplicate CA. Re-run once the read can complete (DR-043 Amendment A4 ' +
        'honest-unknown-over-false-present).',
    };
  }

  // registryPresence === 'absent', lockHasCaKey === false — genuinely fresh.
  if (recipients.length === 0) {
    return {
      status: 'failed',
      reason:
        'no CA exists yet for this fleet, but transport.age_recipients is empty — a freshly-minted CA key could ' +
        'NEVER be made durable (DR-043 §D5). Refusing to mint. Mint an age recipient and add it to ' +
        'transport.age_recipients in fleet.yaml, then re-run.',
    };
  }
  const { certPem, keyPem } = await deps.mintCa(fleetName);
  return { status: 'minted', certPem, keyPem };
}

// --- Two-place publish (public cert only — never a key) ---

export interface CaApplyDeps extends CaMintDeps {
  readonly createRegistryVariable: (registry: RegistryConfig, name: string, value: string) => Promise<CreateVariableResult>;
  readonly checkRepoPresence: (repo: string, name: string) => Promise<Presence>;
  readonly createRepoVariable: (repo: string, name: string, value: string) => Promise<CreateVariableResult>;
}

export interface CaPublishResult {
  readonly registryLeg: EnsureVariableOutcome;
  readonly repoLegs: Readonly<Record<string, EnsureVariableOutcome>>;
}

/**
 * Create-only two-place publish of an ALREADY-RESOLVED cert PEM (macf#806).
 * `certPem` is public material — safe to pass around and log its fingerprint,
 * but this function never receives (and could not leak) a private key. See
 * the module doc for the ordering constraint the CALLER (`apply-fleet.ts`)
 * is responsible for honoring before invoking this on a `'minted'` result.
 */
export async function publishCaCertLegs(
  certPem: string,
  fleetName: string,
  registry: RegistryConfig,
  repos: readonly string[],
  deps: CaApplyDeps,
): Promise<CaPublishResult> {
  const varName = caCertVariableName(fleetName);
  const registryLeg = await ensureVariableCreated(
    {
      checkPresence: () => deps.checkRegistryPresence(registry, varName),
      create: () => deps.createRegistryVariable(registry, varName, certPem),
    },
    `CA registry var "${varName}"`,
  );
  const repoLegs: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const depsForRepo: EnsureVariableDeps = {
      checkPresence: () => deps.checkRepoPresence(repo, varName),
      create: () => deps.createRepoVariable(repo, varName, certPem),
    };
    repoLegs[repo] = await ensureVariableCreated(depsForRepo, `CA repo var "${varName}" on "${repo}"`);
  }
  return { registryLeg, repoLegs };
}

/** The `CaPublishResult` shape for "never attempted this run" (CA resolve failed, or a fresh mint's vault write did not succeed — see `apply-fleet.ts`'s ordering doc). Pure. */
export function skippedCaPublish(repos: readonly string[], reason: string): CaPublishResult {
  return { registryLeg: { status: 'skipped', reason }, repoLegs: skippedOutcomesFor(repos, reason) };
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
 * This module does its OWN create-only two-place publish instead
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
