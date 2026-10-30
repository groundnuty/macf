/**
 * Apply's input refusals, run by `macf bootstrap preflight` through the SAME
 * functions `runBootstrapApply` calls (never a re-implementation). Each
 * check that apply makes before it plans or writes anything, and whose
 * answer depends only on inputs preflight can read, is listed in
 * {@link APPLY_INPUT_REFUSALS} and wired below. A secret VALUE never appears
 * in a check's text.
 */
import { dirname, join } from 'node:path';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { parseFleetLock } from './fleet-manifest.js';
import type { PreflightCheck, PreflightDeps, PreflightOptions } from './preflight.js';
import { checkVaultFlagsComplete } from './plan.js';
import {
  TS_OAUTH_CLIENT_ID_ENV_VAR,
  TS_OAUTH_SECRET_ENV_VAR,
  checkTsOauthFlagsComplete,
  resolvedTsOauthPair,
  validateTsOauthPair,
} from './apply-routing-secrets.js';
import { checkAppNameLengths } from './apply-runner-ops.js';
import { checkRegistryScopePreflight } from './registry-scope-preflight.js';
import { checkAgeRecipientsNarrowing } from './age-recipients-narrowing.js';
import { checkProvisionedFleetNeedsVault } from './provisioned-vault-guard.js';
import { resolveOperatorInput } from './operator-secrets-file.js';
import { noRecipientReason, wouldCreateWithNoRecipient } from './apply-fleet.js';

export interface ApplyRefusalEntry {
  readonly id: string;
  /** The function apply calls, as it appears in the source. */
  readonly applyFunction: string;
  readonly included: boolean;
  /** One clause: why it is excluded, or what it reads when included. */
  readonly reason: string;
}

/**
 * Every refusal `runBootstrapApply` makes before the plan is confirmed, plus
 * the age-recipient refusal in `applyFleet`. A source-shape test reads the
 * start of `runBootstrapApply` and fails when a check function there is not
 * named here, and a guard test feeds every included entry a refused input.
 */
export const APPLY_INPUT_REFUSALS: readonly ApplyRefusalEntry[] = [
  { id: 'apply-vault-flags', applyFunction: 'checkVaultFlagsComplete', included: true, reason: 'the --vault and --identity-key flags' },
  { id: 'secrets-file', applyFunction: 'readOperatorSecretsFile', included: true, reason: 'the secrets file, read through the injected file reader' },
  { id: 'apply-ts-oauth-incomplete', applyFunction: 'checkTsOauthFlagsComplete', included: true, reason: 'the two Tailscale OAuth values from the secrets file and environment' },
  { id: 'apply-ts-oauth-malformed', applyFunction: 'validateTsOauthPair', included: true, reason: 'the Tailscale OAuth pair' },
  { id: 'apply-app-name-length', applyFunction: 'checkAppNameLengths', included: true, reason: 'the manifest' },
  { id: 'apply-registry-scope', applyFunction: 'checkRegistryScopePreflight', included: true, reason: 'owner.registry in the manifest' },
  { id: 'apply-age-recipients-narrowing', applyFunction: 'checkAgeRecipientsNarrowing', included: true, reason: 'transport.age_recipients and the local fleet.lock' },
  { id: 'secret-keys', applyFunction: 'missingRequiredOperatorInputs', included: true, reason: 'the required secrets keys, when no vault flags are given' },
  { id: 'apply-runner-token', applyFunction: 'checkRunnerTokenPreflight', included: false, reason: 'apply only warns; the runner endpoint check covers the same need' },
  { id: 'apply-tailscale-vault', applyFunction: 'checkTailscaleOauthPreflight', included: false, reason: 'needs the vault decrypted; preflight never decrypts it' },
  { id: 'apply-provisioned-needs-vault', applyFunction: 'checkProvisionedFleetNeedsVault', included: true, reason: 'the local fleet.lock and the vault flags' },
  { id: 'apply-age-recipients-empty', applyFunction: 'wouldCreateWithNoRecipient', included: true, reason: 'transport.age_recipients, the agent roles and the local fleet.lock' },
];

export function readLocalFleetLock(deps: PreflightDeps, manifestFile: string): FleetLock | null {
  const text = deps.readText(join(dirname(manifestFile), 'fleet.lock'));
  if (text === undefined) return null;
  try {
    return parseFleetLock(text);
  } catch {
    return null;
  }
}

function result(id: string, group: PreflightCheck['group'], failure: { readonly message: string } | undefined, okDetail: string, fix: string): PreflightCheck {
  return failure === undefined ? { id, group, status: 'ok', detail: okDetail } : { id, group, status: 'wrong', detail: failure.message, fix };
}

/** The Tailscale pair as apply resolves it: secrets file, then environment. */
export function resolveTsOauthInputs(deps: PreflightDeps, values: Readonly<Record<string, string>> | undefined): { readonly clientId: string | undefined; readonly secret: string | undefined } {
  return {
    clientId: resolveOperatorInput(TS_OAUTH_CLIENT_ID_ENV_VAR, undefined, values, undefined, deps.env).value,
    secret: resolveOperatorInput(TS_OAUTH_SECRET_ENV_VAR, undefined, values, undefined, deps.env).value,
  };
}

function tsOauthChecks(deps: PreflightDeps, values: Readonly<Record<string, string>> | undefined): readonly PreflightCheck[] {
  const { clientId, secret } = resolveTsOauthInputs(deps, values);
  const incomplete = checkTsOauthFlagsComplete(clientId, secret);
  const out = [result('apply-ts-oauth-incomplete', 'secrets', incomplete, 'the Tailscale OAuth values are both set or both unset', `set both ${TS_OAUTH_CLIENT_ID_ENV_VAR} and ${TS_OAUTH_SECRET_ENV_VAR} in secrets.env, or neither`)];
  const pair = resolvedTsOauthPair(clientId, secret);
  if (pair !== undefined) {
    out.push(result('apply-ts-oauth-malformed', 'secrets', validateTsOauthPair(pair.clientId, pair.secret), 'the Tailscale OAuth pair has the expected shape', 'put the real client id and secret from the Tailscale admin console in secrets.env'));
  }
  return out;
}

function ageRecipientsEmptyCheck(manifest: FleetManifest, lock: FleetLock | null): readonly PreflightCheck[] {
  const recipients = manifest.transport.age_recipients;
  if (recipients.length > 0) return [];
  const fix = 'run age-keygen and put its public key in transport.age_recipients in fleet.yaml';
  for (const agent of manifest.agents) {
    const prior = lock?.agents.find((a) => a.role === agent.role);
    if (wouldCreateWithNoRecipient(prior, recipients)) {
      return [{ id: 'apply-age-recipients-empty', group: 'manifest', status: 'wrong', detail: noRecipientReason(agent.role), fix }];
    }
  }
  return [{ id: 'apply-age-recipients-empty', group: 'manifest', status: 'ok', detail: 'transport.age_recipients is empty, but every agent already has a fleet.lock entry' }];
}

/** The refusals that read the manifest and the flags (not the secrets): run after the manifest parses. */
export function applyManifestRefusalChecks(deps: PreflightDeps, manifest: FleetManifest, opts: PreflightOptions): readonly PreflightCheck[] {
  const lock = readLocalFleetLock(deps, opts.file);
  const out: PreflightCheck[] = [];
  const names = checkAppNameLengths(manifest);
  out.push(result('apply-app-name-length', 'manifest', names.ok ? undefined : { message: names.reason }, 'every planned App name fits GitHub\'s limit', 'shorten metadata.name or the agent roles in fleet.yaml'));
  out.push(result('apply-registry-scope', 'manifest', checkRegistryScopePreflight(manifest.owner), 'owner.registry is a type apply can provision', 'use registry type repo or profile in fleet.yaml'));
  out.push(
    result(
      'apply-age-recipients-narrowing',
      'manifest',
      checkAgeRecipientsNarrowing(manifest.transport.age_recipients, lock, manifest.transport.age_recipients_narrowing_override),
      'transport.age_recipients does not drop a recipient that fleet.lock records',
      'restore the removed recipient in transport.age_recipients, or add the override text apply prints',
    ),
  );
  out.push(...ageRecipientsEmptyCheck(manifest, lock));
  out.push(
    result(
      'apply-provisioned-needs-vault',
      'identity',
      checkProvisionedFleetNeedsVault(lock, opts.vaultPath, opts.identityKeyPath, opts.file),
      'the fleet is not provisioned yet, or the vault flags were given',
      'pass --vault and --identity-key to preflight and to apply',
    ),
  );
  return out;
}

/** The refusals that read the vault flags and the secrets values: run even when the manifest does not parse. */
export function applyFlagRefusalChecks(deps: PreflightDeps, opts: PreflightOptions, values: Readonly<Record<string, string>> | undefined): readonly PreflightCheck[] {
  const out: PreflightCheck[] = [];
  // A lone --identity-key is also the fresh-run recipient check, so the pair is judged once --vault is given.
  if (opts.vaultPath !== undefined) {
    out.push(result('apply-vault-flags', 'identity', checkVaultFlagsComplete(opts.vaultPath, opts.identityKeyPath), '--vault and --identity-key are given together', 'give --identity-key with --vault, to preflight and to apply'));
  }
  out.push(...tsOauthChecks(deps, values));
  return out;
}
