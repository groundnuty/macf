import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitHubClient, GitHubApiError } from '../../src/registry/github-client.js';

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

describe('createGitHubClient', () => {
  const client = createGitHubClient('/repos/owner/repo', 'test-token');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('writeVariable', () => {
    it('updates existing variable with PATCH', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(204, null));

      await client.writeVariable('MY_VAR', 'my-value');

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]![0]).toContain('/actions/variables/MY_VAR');
      expect(mockFetch.mock.calls[0]![1]!.method).toBe('PATCH');
    });

    it('URL-encodes variable names in fetch URLs (#109 H2)', async () => {
      // Belt-and-suspenders: current callers pass names through
      // toVariableSegment (URL-safe already), but a future caller that
      // forgets should not produce a malformed URL or silently hit an
      // adjacent variable. Use a name with chars that change under
      // encodeURIComponent to verify encoding is applied.
      mockFetch.mockResolvedValueOnce(jsonResponse(204, null));

      await client.writeVariable('WEIRD NAME/Foo', 'v');

      const url = mockFetch.mock.calls[0]![0] as string;
      // Space becomes %20, slash becomes %2F.
      expect(url).toContain('WEIRD%20NAME%2FFoo');
      expect(url).not.toContain('WEIRD NAME/Foo');
    });

    it('creates new variable with POST when PATCH returns 404', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
        .mockResolvedValueOnce(jsonResponse(201, null));

      await client.writeVariable('NEW_VAR', 'new-value');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![1]!.method).toBe('POST');
      const body = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      expect(body.name).toBe('NEW_VAR');
      expect(body.value).toBe('new-value');
    });

    it('throws GitHubApiError on PATCH failure (non-404)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(403, { message: 'Forbidden' }));

      await expect(client.writeVariable('V', 'x')).rejects.toThrow(GitHubApiError);
    });

    it('throws GitHubApiError when POST also fails', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(404, {}))
        .mockResolvedValueOnce(jsonResponse(422, { message: 'Validation failed' }));

      await expect(client.writeVariable('V', 'x')).rejects.toThrow(GitHubApiError);
    });
  });

  describe('readVariable', () => {
    it('returns value when variable exists', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        name: 'MY_VAR',
        value: 'my-value',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }));

      const result = await client.readVariable('MY_VAR');
      expect(result).toBe('my-value');
    });

    it('returns null when variable not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));

      const result = await client.readVariable('MISSING');
      expect(result).toBeNull();
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { message: 'Server Error' }));

      await expect(client.readVariable('V')).rejects.toThrow(GitHubApiError);
    });
  });

  // #959: node's built-in fetch throws a bare `TypeError: fetch failed` on
  // any network-level failure (no HTTP response received at all) — as
  // opposed to the HTTP-status failures above, which already produce a
  // well-attributed GitHubApiError. This is the specific class the
  // operator observed as an unattributed "Error: fetch failed" with no
  // indication of which GitHub call was attempted.
  describe('network-level failures (no HTTP response)', () => {
    it('wraps a rejected fetch as a GitHubApiError naming the operation, never a bare "fetch failed"', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      try {
        await client.listVariables();
        expect.unreachable('expected listVariables to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as Error).message).toMatch(/list variables/);
      }
    });

    it('uses status 0 to mark "no HTTP response", distinct from any real GitHub status', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      try {
        await client.readVariable('V');
        expect.unreachable('expected readVariable to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as InstanceType<typeof GitHubApiError>).status).toBe(0);
      }
    });

    it('names the specific operation for writeVariable / deleteVariable too', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(client.writeVariable('V', 'x')).rejects.toThrow(/update variable V/);

      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(client.deleteVariable('V')).rejects.toThrow(/delete variable V/);
    });

    it('never embeds the bearer token in the wrapped error message', async () => {
      const secretClient = createGitHubClient('/repos/owner/repo', 'ghs_super_secret_token_value');
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      try {
        await secretClient.listVariables();
        expect.unreachable('expected listVariables to throw');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain('ghs_super_secret_token_value');
      }
    });

    // macf#1144: the previous message wrapped `err.message` (always the
    // literal "fetch failed" — worthless) inside an asserted "(network
    // error: ...)" diagnosis, which conflated "no route at all" with
    // "proxy not honored" with "a real outage". Surface the underlying
    // `err.cause.code` (the real signal undici attaches — EAI_AGAIN,
    // ENETUNREACH, ECONNREFUSED, ...) verbatim instead, and don't claim a
    // diagnosis the wrapper cannot back up.
    it('surfaces the underlying err.cause.code, not a generic "network error" label', async () => {
      const dnsFailure = new TypeError('fetch failed');
      (dnsFailure as { cause?: unknown }).cause = { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN api.github.com' };
      mockFetch.mockRejectedValueOnce(dnsFailure);

      try {
        await client.listVariables();
        expect.unreachable('expected listVariables to throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('EAI_AGAIN');
        expect(message).not.toContain('network error');
      }
    });

    it('falls back to err.cause.message when there is no err.cause.code', async () => {
      const err2 = new TypeError('fetch failed');
      (err2 as { cause?: unknown }).cause = { message: 'some other undici-wrapped failure' };
      mockFetch.mockRejectedValueOnce(err2);

      await expect(client.listVariables()).rejects.toThrow(/some other undici-wrapped failure/);
    });
  });

  describe('listVariables', () => {
    it('returns all variables', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        total_count: 2,
        variables: [
          { name: 'VAR1', value: 'val1', created_at: '', updated_at: '' },
          { name: 'VAR2', value: 'val2', created_at: '', updated_at: '' },
        ],
      }));

      const result = await client.listVariables();
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('VAR1');
      expect(result[1]!.value).toBe('val2');
    });

    it('paginates when more variables than per_page', async () => {
      // First page: 30 vars, total_count 32
      const page1Vars = Array.from({ length: 30 }, (_, i) => ({
        name: `VAR_${i}`, value: `val_${i}`, created_at: '', updated_at: '',
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        total_count: 32,
        variables: page1Vars,
      }));

      // Second page: 2 vars
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        total_count: 32,
        variables: [
          { name: 'VAR_30', value: 'val_30', created_at: '', updated_at: '' },
          { name: 'VAR_31', value: 'val_31', created_at: '', updated_at: '' },
        ],
      }));

      const result = await client.listVariables();
      expect(result).toHaveLength(32);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(403, { message: 'Forbidden' }));

      await expect(client.listVariables()).rejects.toThrow(GitHubApiError);
    });
  });

  describe('deleteVariable', () => {
    it('deletes successfully', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(204, null));

      await expect(client.deleteVariable('MY_VAR')).resolves.toBeUndefined();
    });

    it('succeeds when variable already gone (404)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(404, null));

      await expect(client.deleteVariable('MISSING')).resolves.toBeUndefined();
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { message: 'Error' }));

      await expect(client.deleteVariable('V')).rejects.toThrow(GitHubApiError);
    });
  });

  describe('URL construction', () => {
    it('uses org path prefix correctly', async () => {
      const orgClient = createGitHubClient('/orgs/my-org', 'token');
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        name: 'V', value: 'x', created_at: '', updated_at: '',
      }));

      await orgClient.readVariable('V');

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://api.github.com/orgs/my-org/actions/variables/V',
      );
    });

    it('includes Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {
        name: 'V', value: 'x', created_at: '', updated_at: '',
      }));

      await client.readVariable('V');

      const fetchHeaders = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(fetchHeaders['Authorization']).toBe('Bearer test-token');
    });
  });
});
