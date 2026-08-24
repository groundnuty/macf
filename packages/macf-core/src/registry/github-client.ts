import type { GitHubVariablesClient } from './types.js';
import { MacfError } from '../errors.js';
import { proxyAwareFetch } from '../proxy-fetch.js';

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

/**
 * WHY (macf#959): node's built-in `fetch` (undici) throws a bare
 * `TypeError: fetch failed` on any network-level failure (DNS, connection
 * refused, TLS, timeout) — no HTTP response is ever received, so the
 * `res.ok` checks below never run and this class of failure was
 * previously unwrapped: it reached the CLI's top-level catch-all
 * (`index.ts`) as literally "Error: fetch failed" — no API name, no
 * operation, indistinguishable at a glance from a local config problem.
 * Wrap every call so a network-level failure is attributed the same way
 * an HTTP-status failure already is via GitHubApiError. Status `0` marks
 * "no HTTP response was received" (never a real GitHub status code), so
 * existing status-comparisons (e.g. macf-channel-server's
 * refresh-aware-client checking `err.status === 401`) safely fall through
 * instead of misreading a network outage as an auth failure.
 *
 * WHY proxyAwareFetch, not the bare global fetch (macf#1144): Node's fetch
 * does not honor HTTP_PROXY/HTTPS_PROXY, unlike `gh` — an operator behind
 * a forward proxy saw every `gh` call succeed while this exact function's
 * fetch failed, which made the failure look host-specific rather than
 * proxy-specific. See proxy-fetch.ts's module doc for the full story.
 *
 * WHY `err.cause` rather than `err.message` for the diagnostic text
 * (macf#1144): undici's `TypeError: fetch failed` message is always the
 * literal string "fetch failed" — worthless on its own. The actual reason
 * (DNS failure, connection refused, timeout, proxy auth failure, ...) is
 * nested in `err.cause` as a Node system-error-ish object with `.code`
 * (e.g. `EAI_AGAIN`, `ENETUNREACH`, `ECONNREFUSED`). Surfacing that code
 * verbatim, rather than wrapping it in an asserted diagnosis like "network
 * error", lets the caller (or the human reading the message) tell "no
 * route at all" apart from "route exists but proxy wasn't honored" apart
 * from "a real remote outage" — this function cannot itself distinguish
 * those, so it must not claim to.
 */
async function fetchOrThrow(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await proxyAwareFetch(url, init);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
    const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
    const causeMessage = typeof cause?.message === 'string' ? cause.message : undefined;
    const detail = causeCode ?? causeMessage ?? error.message;
    throw new GitHubApiError(0, `unreachable — could not ${operation}: ${detail}`);
  }
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
      const patchRes = await fetchOrThrow(`${baseUrl}/${encodeName(name)}`, {
        method: 'PATCH',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }, `update variable ${name}`);

      if (patchRes.ok) return;

      // Variable doesn't exist yet — create with POST
      if (patchRes.status === 404) {
        const postRes = await fetchOrThrow(baseUrl, {
          method: 'POST',
          headers: { ...headers(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value }),
        }, `create variable ${name}`);

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
      const res = await fetchOrThrow(`${baseUrl}/${encodeName(name)}`, {
        method: 'GET',
        headers: headers(token),
      }, `read variable ${name}`);

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
        const res = await fetchOrThrow(`${baseUrl}?per_page=${perPage}&page=${page}`, {
          method: 'GET',
          headers: headers(token),
        }, 'list variables');

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
      const res = await fetchOrThrow(`${baseUrl}/${encodeName(name)}`, {
        method: 'DELETE',
        headers: headers(token),
      }, `delete variable ${name}`);

      // 204 = deleted, 404 = already gone — both OK
      if (res.status === 204 || res.status === 404) return;

      throw new GitHubApiError(
        res.status,
        `Failed to delete variable ${name}: ${await res.text()}`,
      );
    },
  };
}
