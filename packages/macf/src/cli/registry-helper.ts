import type { MacfAgentConfig } from './config.js';
import { createGitHubClient } from '@groundnuty/macf-core';
import type { GitHubVariablesClient } from '@groundnuty/macf-core';

/**
 * Build the GitHub Variables API path prefix from agent config.
 */
export function registryPathPrefix(registry: MacfAgentConfig['registry']): string {
  switch (registry.type) {
    case 'org': return `/orgs/${registry.org}`;
    case 'profile': return `/repos/${registry.user}/${registry.user}`;
    case 'repo': return `/repos/${registry.owner}/${registry.repo}`;
    case 'local':
      // DR-024 / macf#322: local mode has no GitHub API path. This
      // helper is only used by GitHub-backed code paths (status,
      // certs, peers, plugin CLI) — those paths will switch on
      // `registry.type === 'local'` upstream in PR-B. Until then,
      // throwing here surfaces any accidental reach-through clearly.
      throw new Error(
        'registryPathPrefix is GitHub-mode-only; local mode bypasses the GitHub Variables API. ' +
          'Callers must dispatch on registry.type before reaching this helper.',
      );
  }
}

/**
 * Create a GitHubVariablesClient from agent config and token.
 */
export function createClientFromConfig(
  registry: MacfAgentConfig['registry'],
  token: string,
): GitHubVariablesClient {
  return createGitHubClient(registryPathPrefix(registry), token);
}

/**
 * Shown when `<SEG>_CA_CERT` is absent from the registry. `fleet deactivate`
 * removes it on purpose, and `certs init` after that would orphan every cert.
 */
export const CA_NOT_IN_REGISTRY_MESSAGE =
  'CA certificate not found in registry. If this fleet was deactivated, restore it with ' +
  '`macf bootstrap apply`; for a fleet that has no CA yet, run `macf certs init`.';
