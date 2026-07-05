import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveLatestVersions,
  fetchLatestCliVersion,
  fetchLatestPluginVersion,
  fetchLatestActionsVersion,
  resolveActionsRefToFullTag,
  isImmutableActionsTag,
  isValidSemver,
  isValidActionsRef,
  compareSemver,
  statusMessage,
  FALLBACK_VERSIONS,
} from '../../src/cli/version-resolver.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('isValidSemver', () => {
  it('accepts standard semver', () => {
    expect(isValidSemver('0.1.0')).toBe(true);
    expect(isValidSemver('1.2.3')).toBe(true);
  });

  it('rejects non-semver', () => {
    expect(isValidSemver('v1.0.0')).toBe(false);
    expect(isValidSemver('1.0')).toBe(false);
    expect(isValidSemver('latest')).toBe(false);
    expect(isValidSemver('')).toBe(false);
  });
});

describe('isValidActionsRef', () => {
  it('accepts floating and immutable tags', () => {
    expect(isValidActionsRef('v1')).toBe(true);
    expect(isValidActionsRef('v1.0')).toBe(true);
    expect(isValidActionsRef('v1.0.0')).toBe(true);
  });

  it('accepts main for testing', () => {
    expect(isValidActionsRef('main')).toBe(true);
  });

  it('rejects other refs', () => {
    expect(isValidActionsRef('1.0.0')).toBe(false);
    expect(isValidActionsRef('develop')).toBe(false);
  });
});

describe('compareSemver', () => {
  it('sorts by major first', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.99.99', '2.0.0')).toBeLessThan(0);
  });

  it('sorts by minor when majors match', () => {
    expect(compareSemver('1.2.0', '1.1.99')).toBeGreaterThan(0);
  });

  it('sorts by patch when majors and minors match', () => {
    expect(compareSemver('1.0.5', '1.0.4')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('fetchLatestCliVersion', () => {
  it('returns ok on npm dist-tags.latest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ 'dist-tags': { latest: '1.2.3' } }),
    }) as typeof fetch;

    const result = await fetchLatestCliVersion();
    expect(result).toEqual({ status: 'ok', value: '1.2.3' });
  });

  it('hits the @groundnuty/macf npm package URL (not the @macf/cli typo from #335)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ 'dist-tags': { latest: '0.2.13' } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    await fetchLatestCliVersion();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe('https://registry.npmjs.org/@groundnuty/macf');
    expect(calledUrl).not.toContain('@macf/cli');
  });

  it('returns not_published on HTTP 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toEqual({ status: 'not_published', value: null });
  });

  it('returns network_error on fetch rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    expect(await fetchLatestCliVersion()).toEqual({ status: 'network_error', value: null });
  });

  it('returns invalid_response for non-404 HTTP errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toEqual({ status: 'invalid_response', value: null });
  });

  it('returns invalid_response for malformed payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ 'dist-tags': { latest: 'not-a-version' } }),
    }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toEqual({ status: 'invalid_response', value: null });
  });
});

describe('fetchLatestPluginVersion', () => {
  it('returns ok on /releases/latest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ tag_name: 'v0.1.0' }),
    }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'ok', value: '0.1.0' });
  });

  it('falls back to /tags when /releases/latest returns 404', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.includes('/tags')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => [{ name: 'v0.1.0' }, { name: 'v0.2.0' }, { name: 'v0.1.5' }],
        });
      }
      return Promise.reject(new Error('unexpected URL'));
    }) as typeof fetch;

    expect(await fetchLatestPluginVersion()).toEqual({ status: 'ok', value: '0.2.0' });
  });

  it('returns not_published when both /releases/latest and /tags are 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'not_published', value: null });
  });

  it('returns not_published when /tags returns empty array', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'not_published', value: null });
  });

  it('returns network_error on fetch rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'network_error', value: null });
  });
});

describe('fetchLatestActionsVersion', () => {
  it('returns major-only tag from /releases/latest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ tag_name: 'v1.2.3' }),
    }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toEqual({ status: 'ok', value: 'v1' });
  });

  it('falls back to /tags with major-only extraction', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/releases/latest')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.includes('/tags')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => [
            { name: 'v1.0.0' }, { name: 'v1.0' }, { name: 'v1' },
            { name: 'v2.1.0' }, { name: 'v2.1' }, { name: 'v2' },
          ],
        });
      }
      return Promise.reject(new Error('unexpected'));
    }) as typeof fetch;

    expect(await fetchLatestActionsVersion()).toEqual({ status: 'ok', value: 'v2' });
  });

  it('returns not_published when both endpoints 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toEqual({ status: 'not_published', value: null });
  });

  it('returns network_error on fetch rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toEqual({ status: 'network_error', value: null });
  });
});

describe('resolveLatestVersions', () => {
  it('returns ok for all when all fetches succeed', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '0.2.0' } }) });
      }
      if (url.includes('macf-marketplace/releases/latest')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.3.0' }) });
      }
      if (url.includes('macf-actions/releases/latest')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: 'v2.1.0' }) });
      }
      return Promise.reject(new Error('unexpected URL'));
    }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.versions).toEqual({ cli: '0.2.0', plugin: '0.3.0', actions: 'v2' });
    expect(result.sources).toEqual({ cli: 'ok', plugin: 'ok', actions: 'ok' });
  });

  it('marks each component not_published when every fetch returns 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.versions).toEqual(FALLBACK_VERSIONS);
    expect(result.sources).toEqual({
      cli: 'not_published',
      plugin: 'not_published',
      actions: 'not_published',
    });
  });

  it('mixes statuses per component', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '5.0.0' } }) });
      }
      return Promise.reject(new Error('down'));
    }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.sources.cli).toBe('ok');
    expect(result.sources.plugin).toBe('network_error');
    expect(result.sources.actions).toBe('network_error');
  });

  it('falls back via /tags when /releases/latest returns 404 for GitHub components', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.includes('/releases/latest')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.includes('macf-marketplace/tags')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [{ name: 'v0.1.0' }] });
      }
      if (url.includes('macf-actions/tags')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [{ name: 'v1.0.0' }] });
      }
      return Promise.reject(new Error('unexpected'));
    }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.sources).toEqual({
      cli: 'not_published',
      plugin: 'ok',
      actions: 'ok',
    });
    expect(result.versions.plugin).toBe('0.1.0');
    expect(result.versions.actions).toBe('v1');
  });
});

describe('statusMessage', () => {
  it('produces distinct messages per status', () => {
    expect(statusMessage('cli', 'ok')).toContain('ok');
    expect(statusMessage('cli', 'not_published')).toContain('no published release');
    expect(statusMessage('cli', 'network_error')).toContain('network fetch failed');
    expect(statusMessage('cli', 'invalid_response')).toContain('unexpected response');
    expect(statusMessage('cli', 'rate_limited')).toContain('rate-limited');
    expect(statusMessage('cli', 'rate_limited')).toContain('GH_TOKEN');
  });

  it('includes component name', () => {
    expect(statusMessage('actions', 'not_published')).toContain('actions');
  });
});

describe('GitHub API auth (#186)', () => {
  const originalToken = process.env['GH_TOKEN'];
  afterEach(() => {
    if (originalToken === undefined) delete process.env['GH_TOKEN'];
    else process.env['GH_TOKEN'] = originalToken;
  });

  it('sends Authorization header when GH_TOKEN is set (plugin fetch)', async () => {
    process.env['GH_TOKEN'] = 'ghs_faketoken123';
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
      capturedHeaders.push(opts?.headers ?? {});
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v0.1.0' }),
      });
    }) as typeof fetch;

    await fetchLatestPluginVersion();
    expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer ghs_faketoken123');
  });

  it('omits Authorization header when GH_TOKEN is unset', async () => {
    delete process.env['GH_TOKEN'];
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
      capturedHeaders.push(opts?.headers ?? {});
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v1.0.0' }),
      });
    }) as typeof fetch;

    await fetchLatestActionsVersion();
    expect(capturedHeaders[0]?.['Authorization']).toBeUndefined();
  });

  it('omits Authorization when GH_TOKEN is empty string or literal "null"', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
      capturedHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.0' }) });
    }) as typeof fetch;

    // Empty string — e.g., env expanded from a missing shell var
    process.env['GH_TOKEN'] = '';
    await fetchLatestActionsVersion();
    expect(capturedHeaders[0]?.['Authorization']).toBeUndefined();

    // Literal "null" — the classic attribution-trap fallout from
    // `GH_TOKEN=$(... | jq '.token')` when jq gets no token.
    process.env['GH_TOKEN'] = 'null';
    await fetchLatestActionsVersion();
    expect(capturedHeaders[1]?.['Authorization']).toBeUndefined();
  });

  it('classifies 403 as rate_limited (plugin)', async () => {
    delete process.env['GH_TOKEN'];
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'rate_limited', value: null });
  });

  it('classifies 429 as rate_limited (actions)', async () => {
    delete process.env['GH_TOKEN'];
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toEqual({ status: 'rate_limited', value: null });
  });

  it('classifies 401 as rate_limited (bad auth)', async () => {
    process.env['GH_TOKEN'] = 'bad';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'rate_limited', value: null });
  });

  it('keeps 500 classified as invalid_response (non-auth server error)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toEqual({ status: 'invalid_response', value: null });
  });
});

describe('isImmutableActionsTag', () => {
  it('accepts a three-component tag', () => {
    expect(isImmutableActionsTag('v3.4.1')).toBe(true);
    expect(isImmutableActionsTag('v1.0.0')).toBe(true);
  });

  it('rejects floating major / minor refs and main', () => {
    expect(isImmutableActionsTag('v3')).toBe(false);
    expect(isImmutableActionsTag('v3.4')).toBe(false);
    expect(isImmutableActionsTag('main')).toBe(false);
  });
});

describe('resolveActionsRefToFullTag (macf#797)', () => {
  const tagList = [
    { name: 'v3.4.1' }, { name: 'v3.4.0' }, { name: 'v3.4' }, { name: 'v3.3.0' },
    { name: 'v3.10.0' }, { name: 'v3' }, { name: 'v2.1.0' }, { name: 'v1.3.4' }, { name: 'main' },
  ];

  it('returns an already-immutable tag unchanged WITHOUT a network call', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    expect(await resolveActionsRefToFullTag('v3.4.1')).toBe('v3.4.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for main (no network)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    expect(await resolveActionsRefToFullTag('main')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a bare major to the highest full tag within that major (semver-aware)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => tagList,
    }) as typeof fetch;
    // v3.10.0 must beat v3.4.1 — numeric, not lexicographic.
    expect(await resolveActionsRefToFullTag('v3')).toBe('v3.10.0');
  });

  it('resolves a bare minor to the highest full tag within that minor', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => tagList,
    }) as typeof fetch;
    expect(await resolveActionsRefToFullTag('v3.4')).toBe('v3.4.1');
  });

  it('does not cross a major boundary (v1 never resolves to a v3 tag)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => tagList,
    }) as typeof fetch;
    expect(await resolveActionsRefToFullTag('v1')).toBe('v1.3.4');
  });

  it('returns null when GitHub is unreachable (caller keeps the floating ref)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    expect(await resolveActionsRefToFullTag('v3')).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as typeof fetch;
    expect(await resolveActionsRefToFullTag('v3')).toBeNull();
  });

  it('returns null when no full tag matches the requested major', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => [{ name: 'v3' }, { name: 'v3.4' }, { name: 'main' }],
    }) as typeof fetch;
    // Only floating refs present, no vX.Y.Z → null.
    expect(await resolveActionsRefToFullTag('v3')).toBeNull();
  });
});
