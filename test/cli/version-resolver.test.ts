import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveLatestVersions,
  fetchLatestCliVersion,
  fetchLatestPluginVersion,
  fetchLatestActionsVersion,
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
  });

  it('includes component name', () => {
    expect(statusMessage('actions', 'not_published')).toContain('actions');
  });
});
