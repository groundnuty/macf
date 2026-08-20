/**
 * Registry-SCOPE integration coverage for `deregisterConditional` — filed
 * alongside the macf#1035 investigation, which asked "check the repo-scope
 * hypothesis first" (the live fleet is repo-scoped; `#627`'s stdin wiring
 * predates repo-scoped registries entirely, so a scope-specific mismatch
 * would fail in exactly the silent shape #1035 reported).
 *
 * `deregister-conditional.test.ts` already covers the instance-id guard
 * against a MOCKED `GitHubVariablesClient` (scope-agnostic by construction —
 * `createRegistry` never inspects the URL shape). `github-client.test.ts`
 * separately covers `createGitHubClient`'s HTTP layer against ONE hardcoded
 * `/repos/owner/repo` prefix. Neither closes the gap end-to-end: does
 * `deregisterConditional` actually reach the correct, scope-specific DELETE
 * URL for each of the three GitHub-backed registry scopes server.ts builds
 * (repo / profile / org — see server.ts's `signPathPrefix` switch)?
 *
 * This file answers that directly: `createGitHubClient(pathPrefix, token)`
 * wired into `createRegistry`, fetch mocked, for all three scopes. Result
 * (macf#1035 diagnosis): deregister behaves IDENTICALLY across all three —
 * the scope-mismatch hypothesis is NOT the cause of the observed failure.
 * The real root cause (a stale-value race in shutdown.ts's once-guard, plus
 * an unhandled SIGHUP) is process-lifecycle, not registry-layer — see
 * `packages/macf-channel-server/test/shutdown-real-process.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitHubClient } from '../../src/registry/github-client.js';
import { createRegistry } from '../../src/registry/registry.js';
import type { AgentInfo } from '../../src/registry/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const OURS: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'inst-ours',
  started: '2026-08-01T00:00:00Z',
};

const NEWER: AgentInfo = {
  ...OURS,
  instance_id: 'inst-newer-takeover',
};

// The three GitHub-backed registry scopes server.ts constructs (DR-024 /
// macf#999 repo-scoped registries). "profile" is `/repos/<user>/<user>` —
// structurally a repo path, included anyway since #1035 called it out
// explicitly and it exercises a distinct pathPrefix string.
const SCOPES: ReadonlyArray<{ readonly label: string; readonly pathPrefix: string }> = [
  { label: 'repo (the live fleet shape, macf#999)', pathPrefix: '/repos/groundnuty/macf-experiment' },
  { label: 'profile', pathPrefix: '/repos/macf-bot-user/macf-bot-user' },
  { label: 'org', pathPrefix: '/orgs/groundnuty' },
];

describe.each(SCOPES)('deregisterConditional over $label scope', ({ pathPrefix }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the slot at the scope-correct URL when the instance_id still matches', async () => {
    // readVariable (pre-delete compare)
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { name: 'MACF_EXPERIMENT_AGENT_CODE_AGENT', value: JSON.stringify(OURS), created_at: '', updated_at: '' }),
    );
    // deleteVariable
    mockFetch.mockResolvedValueOnce(jsonResponse(204, null));

    const client = createGitHubClient(pathPrefix, 'ghs_test_token');
    const registry = createRegistry(client, 'macf-experiment');

    const result = await registry.deregisterConditional('code_agent', 'inst-ours');

    expect(result).toEqual({ deregistered: true, reason: 'deleted' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const deleteCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(deleteCall[0]).toBe(`https://api.github.com${pathPrefix}/actions/variables/MACF_EXPERIMENT_AGENT_CODE_AGENT`);
    expect(deleteCall[1].method).toBe('DELETE');
  });

  it('is a NO-OP (never calls DELETE) when a newer instance owns the slot — THE guard', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { name: 'MACF_EXPERIMENT_AGENT_CODE_AGENT', value: JSON.stringify(NEWER), created_at: '', updated_at: '' }),
    );

    const client = createGitHubClient(pathPrefix, 'ghs_test_token');
    const registry = createRegistry(client, 'macf-experiment');

    const result = await registry.deregisterConditional('code_agent', 'inst-ours');

    expect(result).toEqual({ deregistered: false, reason: 'not-ours' });
    // Only the read happened — no DELETE was ever issued against a live peer.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
