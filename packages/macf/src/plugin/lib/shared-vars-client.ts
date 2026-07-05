import { createGitHubClient } from '@groundnuty/macf-core';
import type { GitHubVariablesClient, RegistryConfig } from '@groundnuty/macf-core';

/**
 * Build a `GitHubVariablesClient` over the SAME shared-registry scope backing
 * `createRegistryFromConfig` (`@groundnuty/macf-core`'s `registry/factory.ts`
 * — org/profile/repo path prefixes, mirrored here) — used to resolve a
 * federated cross-fleet guest's `<PROJECT>_CA_CERT` variable (DR-041
 * Amendment B, groundnuty/macf#794). A federated fleet's CA variable lives in
 * this SAME registry namespace, just under a different project prefix, so no
 * separate client construction is needed beyond the path-prefix switch below
 * (same reasoning as `macf-channel-server/src/server.ts`'s `varsClient`
 * reuse for its `/sign` flow — see trust-bundle.ts module doc).
 *
 * Returns `undefined` in DR-024 local-registry mode — there is no shared
 * GitHub-Variables registry to resolve a foreign fleet's CA from.
 * `resolveFederatedCaBundle` / `resolveGuestProbeCaBundle` already document +
 * enforce the resulting "local-mode + declared federation" throw; this
 * function just supplies the `undefined` that triggers it.
 */
export function buildSharedVarsClient(
  registryConfig: RegistryConfig,
  token: string,
): GitHubVariablesClient | undefined {
  switch (registryConfig.type) {
    case 'org':
      return createGitHubClient(`/orgs/${registryConfig.org}`, token);
    case 'profile':
      return createGitHubClient(`/repos/${registryConfig.user}/${registryConfig.user}`, token);
    case 'repo':
      return createGitHubClient(`/repos/${registryConfig.owner}/${registryConfig.repo}`, token);
    case 'local':
      return undefined;
  }
}
