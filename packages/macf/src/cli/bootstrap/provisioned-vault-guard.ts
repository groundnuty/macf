/**
 * Refuse a vault-less re-run of an already-provisioned fleet — DR-043
 * Amendment K3 (a bare `apply` cannot restore what a provisioned fleet needs
 * from its vault) and the setup review's S4.
 *
 * A fresh fleet takes neither `--vault` nor `--identity-key`. A fleet whose
 * `fleet.lock` records a provisioned run already has a `secrets/vault.age`
 * (apply writes lock and vault in one sync), so a run without the flags would
 * rewrite secrets it cannot read back and only then report the gap.
 * "Provisioned" here means the observed lock records at least one agent or an
 * age recipient set; no lock, or an empty one, is a fresh fleet.
 *
 * Pure; reads nothing. The caller passes the lock `observe` already resolved.
 */
import type { FleetLock } from './fleet-manifest.js';
import type { FleetPlanFailure } from './plan.js';

export const PROVISIONED_FLEET_NEEDS_VAULT_CODE = 'provisioned_fleet_needs_vault';

export function isProvisionedFleetLock(lock: FleetLock | null | undefined): boolean {
  if (lock === null || lock === undefined) return false;
  return lock.agents.length > 0 || (lock.age_recipients?.length ?? 0) > 0;
}

export function checkProvisionedFleetNeedsVault(
  lock: FleetLock | null | undefined,
  vaultPath: string | undefined,
  identityKeyPath: string | undefined,
  manifestPath: string,
): FleetPlanFailure | undefined {
  if (vaultPath !== undefined || identityKeyPath !== undefined) return undefined;
  if (!isProvisionedFleetLock(lock)) return undefined;
  return {
    code: PROVISIONED_FLEET_NEEDS_VAULT_CODE,
    message:
      'This fleet is already provisioned: fleet.lock records its agents, so its vault already exists. ' +
      'A run without the vault would rewrite secrets it cannot read back. Nothing was changed. ' +
      `Re-run with both flags: macf bootstrap apply -f ${manifestPath} --vault <path-to-vault.age> --identity-key <path-to-age-identity>`,
  };
}
