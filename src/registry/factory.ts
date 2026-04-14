import type { Registry, RegistryConfig } from './types.js';
import { createGitHubClient } from './github-client.js';
import { createRegistry } from './registry.js';

/**
 * Creates a Registry from config. The registry type determines
 * the GitHub API path prefix:
 *   - org:     /orgs/{org}
 *   - profile: /repos/{user}/{user}  (user's profile repo)
 *   - repo:    /repos/{owner}/{repo}
 */
export function createRegistryFromConfig(
  config: RegistryConfig,
  project: string,
  token: string,
): Registry {
  let pathPrefix: string;

  switch (config.type) {
    case 'org':
      pathPrefix = `/orgs/${config.org}`;
      break;
    case 'profile':
      pathPrefix = `/repos/${config.user}/${config.user}`;
      break;
    case 'repo':
      pathPrefix = `/repos/${config.owner}/${config.repo}`;
      break;
  }

  const client = createGitHubClient(pathPrefix, token);
  return createRegistry(client, project);
}
