import type { GitHubVariablesClient } from './types.js';
import { MacfError } from '../errors.js';

export class GitHubApiError extends MacfError {
  readonly status: number;

  constructor(status: number, message: string) {
    super('GITHUB_API_ERROR', `GitHub API ${status}: ${message}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

const API_BASE = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

interface GitHubVariable {
  readonly name: string;
  readonly value: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GitHubVariableList {
  readonly total_count: number;
  readonly variables: readonly GitHubVariable[];
}

/**
 * Creates a GitHub Variables API client for a given URL path prefix.
 *
 * @param pathPrefix - e.g. "/orgs/my-org" or "/repos/owner/repo"
 * @param token - GitHub API token
 */
export function createGitHubClient(
  pathPrefix: string,
  token: string,
): GitHubVariablesClient {
  const baseUrl = `${API_BASE}${pathPrefix}/actions/variables`;

  // Belt-and-suspenders: every caller currently runs names through
  // toVariableSegment (uppercase + underscores + digits, URL-safe),
  // but encoding here defends against a future caller forgetting the
  // sanitizer — raw interpolation would silently produce a malformed
  // URL or hit an adjacent variable. (#109 H2)
  const encodeName = (name: string): string => encodeURIComponent(name);

  return {
    async writeVariable(name: string, value: string): Promise<void> {
      // Try PATCH (update) first
      const patchRes = await fetch(`${baseUrl}/${encodeName(name)}`, {
        method: 'PATCH',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });

      if (patchRes.ok) return;

      // Variable doesn't exist yet — create with POST
      if (patchRes.status === 404) {
        const postRes = await fetch(baseUrl, {
          method: 'POST',
          headers: { ...headers(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value }),
        });

        if (postRes.ok) return;

        throw new GitHubApiError(
          postRes.status,
          `Failed to create variable ${name}: ${await postRes.text()}`,
        );
      }

      throw new GitHubApiError(
        patchRes.status,
        `Failed to update variable ${name}: ${await patchRes.text()}`,
      );
    },

    async readVariable(name: string): Promise<string | null> {
      const res = await fetch(`${baseUrl}/${encodeName(name)}`, {
        method: 'GET',
        headers: headers(token),
      });

      if (res.status === 404) return null;

      if (!res.ok) {
        throw new GitHubApiError(
          res.status,
          `Failed to read variable ${name}: ${await res.text()}`,
        );
      }

      const data = await res.json() as GitHubVariable;
      return data.value;
    },

    async listVariables(): Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>> {
      const results: Array<{ name: string; value: string }> = [];
      let page = 1;
      const perPage = 30;

      // Paginate through all variables
      for (;;) {
        const res = await fetch(`${baseUrl}?per_page=${perPage}&page=${page}`, {
          method: 'GET',
          headers: headers(token),
        });

        if (!res.ok) {
          throw new GitHubApiError(
            res.status,
            `Failed to list variables: ${await res.text()}`,
          );
        }

        const data = await res.json() as GitHubVariableList;
        for (const v of data.variables) {
          results.push({ name: v.name, value: v.value });
        }

        if (results.length >= data.total_count || data.variables.length < perPage) {
          break;
        }
        page++;
      }

      return results;
    },

    async deleteVariable(name: string): Promise<void> {
      const res = await fetch(`${baseUrl}/${encodeName(name)}`, {
        method: 'DELETE',
        headers: headers(token),
      });

      // 204 = deleted, 404 = already gone — both OK
      if (res.status === 204 || res.status === 404) return;

      throw new GitHubApiError(
        res.status,
        `Failed to delete variable ${name}: ${await res.text()}`,
      );
    },
  };
}
