/**
 * DR-041 Decision 1 (cross-fleet trust federation, groundnuty/macf#784):
 * builds this channel-server's multi-CA mTLS trust bundle from its own CA +
 * zero-or-more federated fleets' CAs declared in `.github/macf-fleet.json`
 * `federated_cas` (macf-core `guest.ts` schema).
 *
 * v1 = the STATIC committed-bundle tier (DR-041 Decision 1c Tier v1): the
 * bundle is resolved ONCE at process startup from the shared registry (the
 * same GitHub-Variables backing this agent's OWN registry, per DR-006 shared
 * profile scope — a federated fleet's `<PROJECT>_CA_CERT` variable lives in
 * the same registry namespace as this fleet's own, just under a different
 * project prefix). Re-resolved on the next process restart if a federated
 * fleet rotates its CA (documented rotation model: re-commit + notify). The
 * well-known bundle-endpoint + poller tier (rotation-aware, live-fetched) is
 * v2 — documented, not built (backlog groundnuty/macf#783).
 *
 * SECURITY-CRITICAL trust-boundary code. Two invariants this module upholds
 * (DR-041 Decision 1b):
 *
 *  1. **Complete-allow-list, never partial.** The resulting bundle REPLACES
 *     Node's default TLS root store at every consuming site (`https.ts`
 *     inbound `ca:`, `a2a-client.ts` + `notify-peer.ts` outbound `ca:`), so
 *     it MUST carry every CA this agent intends to trust. If a declared
 *     `federated_cas` project's CA is unresolvable (registry read failure,
 *     or the variable is simply absent), this module THROWS rather than
 *     silently omitting that CA from the bundle — a silently-partial bundle
 *     would present as the EXACT same symptom (a guest reading `offline`)
 *     DR-041 exists to fix, with no signal pointing at the real cause. See
 *     `.claude/rules/silent-fallback-hazards.md` — this is Pattern B
 *     (reject-at-the-boundary) applied to a trust-anchor set.
 *  2. **All-or-nothing per fleet-CA, by design.** Federating a fleet's CA
 *     trusts EVERY certificate that CA has signed or will sign — there is
 *     no per-agent or per-skill restriction at this layer (DR-041 Decision
 *     4 explicitly defers finer-grained capability enforcement to a future
 *     capability-token mechanism, NOT this bundle).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MacfError, parseMacfFleetConfig, toVariableSegment } from '@groundnuty/macf-core';
import type { GitHubVariablesClient, Logger } from '@groundnuty/macf-core';

/** Raised when a declared `federated_cas` entry cannot be resolved to a CA PEM. */
export class TrustBundleError extends MacfError {
  constructor(message: string) {
    super('TRUST_BUNDLE_ERROR', message);
    this.name = 'TrustBundleError';
  }
}

/**
 * Read `<workspaceDir>/.github/macf-fleet.json` and return the declared
 * `federated_cas` project list. Pure file-IO + parse — no network.
 *
 * Degrades to `[]` (i.e. "no federation") on every "the file doesn't clearly
 * express federation intent" case: no workspaceDir, absent file, unparseable
 * JSON, or a schema violation. This is the SAFE default for a trust-boundary
 * config — an empty bundle-addition means "trust only my own CA," which is
 * strictly MORE conservative than the pre-#784 behavior, never less. This
 * mirrors `fleet-guests.ts`'s `loadGuestBindings` loud-but-degrade posture
 * for the same file. Contrast with `resolveFederatedCaBundle` below, which
 * FAILS LOUD once a project is unambiguously *declared* — degrading there
 * would silently narrow an operator's explicit trust intent.
 */
export function loadFederatedCaProjects(
  workspaceDir: string | undefined,
  logger: Logger,
): readonly string[] {
  if (workspaceDir === undefined) return [];
  const path = join(workspaceDir, '.github', 'macf-fleet.json');
  if (!existsSync(path)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    logger.warn('trust_bundle_fleet_config_parse_failed', {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }

  try {
    return parseMacfFleetConfig(raw).federated_cas;
  } catch (e) {
    logger.warn('trust_bundle_fleet_config_invalid', {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Resolve `federatedProjects` to their `<PROJECT>_CA_CERT` shared-registry
 * variables and concatenate them onto `ownCaCertPem`, producing the final
 * trust-bundle PEM string threaded to all three mTLS-configuring sites
 * (`https.ts` inbound, `a2a-client.ts` + `notify-peer.ts` outbound).
 *
 * Empty `federatedProjects` short-circuits to `ownCaCertPem` UNCHANGED — the
 * exact pre-#784 single-CA value, byte-for-byte — so the zero-federation
 * path has no observable difference from before this feature existed.
 *
 * THROWS `TrustBundleError` (never returns a partial bundle) when:
 *  - `federatedProjects` is non-empty but `varsClient` is `undefined` (this
 *    agent's registry is DR-024 local-mode, which has no shared-registry
 *    variable to resolve a foreign project's CA from); or
 *  - any declared project's `<PROJECT>_CA_CERT` variable read fails
 *    (network/auth error) or resolves to `null`/empty (variable absent).
 *
 * Exported standalone (no file IO) so tests can exercise every resolution
 * outcome — success, missing-var, read-error, local-mode-with-federation —
 * without needing a real `.github/macf-fleet.json` fixture.
 */
export async function resolveFederatedCaBundle(
  ownCaCertPem: string,
  federatedProjects: readonly string[],
  varsClient: GitHubVariablesClient | undefined,
  logger: Logger,
): Promise<string> {
  if (federatedProjects.length === 0) {
    return ownCaCertPem;
  }

  if (varsClient === undefined) {
    throw new TrustBundleError(
      `DR-041 federated_cas declares ${federatedProjects.length} federated project(s) ` +
        `(${federatedProjects.join(', ')}) but this agent's registry is DR-024 local-mode, ` +
        'which has no shared GitHub-Variables registry to resolve a foreign fleet\'s CA from. ' +
        'Cross-fleet CA federation (DR-041) requires a GitHub-backed registry (repo/org/profile). ' +
        'Remove federated_cas from .github/macf-fleet.json, or switch this agent off local mode.',
    );
  }

  const parts: string[] = [ownCaCertPem];
  for (const project of federatedProjects) {
    const varName = `${toVariableSegment(project)}_CA_CERT`;
    let pem: string | null;
    try {
      pem = await varsClient.readVariable(varName);
    } catch (e) {
      throw new TrustBundleError(
        `DR-041 federated_cas: failed to read registry variable "${varName}" for declared ` +
          `federated project "${project}": ${e instanceof Error ? e.message : String(e)}. ` +
          'Refusing to start with an INCOMPLETE trust bundle (a partial bundle would present ' +
          'as the exact same "guest reads offline" symptom DR-041 fixes, with no signal why).',
      );
    }
    if (pem === null || pem.trim() === '') {
      throw new TrustBundleError(
        `DR-041 federated_cas: registry variable "${varName}" is missing/empty for declared ` +
          `federated project "${project}". Run \`macf certs\` on that project first to publish ` +
          'its CA, or remove the project from federated_cas. Refusing to start with an ' +
          'INCOMPLETE trust bundle.',
      );
    }
    parts.push(pem);
    logger.info('trust_bundle_federated_ca_added', { project, variable: varName });
  }

  return parts.join('\n');
}

/**
 * Full orchestration: load `federated_cas` from the workspace's
 * `.github/macf-fleet.json` (degrade-to-`[]` on absent/malformed — safe
 * default), then resolve + concatenate into the final trust-bundle PEM
 * (fail-loud on an unresolvable DECLARED project — see module doc). This is
 * the single call `server.ts` makes at startup; its result is threaded
 * unchanged to `createHttpsServer`'s `caBundlePem`, `A2aClient`'s
 * `caCertPem`, and `notifyDispatchDeps.caCertPem`.
 */
export async function buildTrustBundlePem(deps: {
  readonly workspaceDir: string | undefined;
  readonly ownCaCertPem: string;
  readonly varsClient: GitHubVariablesClient | undefined;
  readonly logger: Logger;
}): Promise<string> {
  const federatedProjects = loadFederatedCaProjects(deps.workspaceDir, deps.logger);
  return resolveFederatedCaBundle(deps.ownCaCertPem, federatedProjects, deps.varsClient, deps.logger);
}
