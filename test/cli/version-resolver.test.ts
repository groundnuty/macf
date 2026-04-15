import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveLatestVersions,
  fetchLatestCliVersion,
  fetchLatestPluginVersion,
  fetchLatestActionsVersion,
  isValidSemver,
  isValidActionsRef,
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
    expect(isValidSemver('99.9.9')).toBe(true);
  });

  it('rejects non-semver', () => {
    expect(isValidSemver('v1.0.0')).toBe(false); // leading v
    expect(isValidSemver('1.0')).toBe(false);     // missing patch
    expect(isValidSemver('1.0.0-beta')).toBe(false); // prerelease
    expect(isValidSemver('latest')).toBe(false);
    expect(isValidSemver('')).toBe(false);
  });
});

describe('isValidActionsRef', () => {
  it('accepts floating and immutable tags', () => {
    expect(isValidActionsRef('v1')).toBe(true);
    expect(isValidActionsRef('v1.0')).toBe(true);
    expect(isValidActionsRef('v1.0.0')).toBe(true);
    expect(isValidActionsRef('v99.99.99')).toBe(true);
  });

  it('accepts main for testing', () => {
    expect(isValidActionsRef('main')).toBe(true);
  });

  it('rejects other refs', () => {
    expect(isValidActionsRef('1.0.0')).toBe(false); // missing v
    expect(isValidActionsRef('develop')).toBe(false);
    expect(isValidActionsRef('v1.0.0.0')).toBe(false); // too many parts
    expect(isValidActionsRef('')).toBe(false);
  });
});

describe('fetchLatestCliVersion', () => {
  it('returns the dist-tags.latest from npm registry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'dist-tags': { latest: '1.2.3' } }),
    }) as typeof fetch;

    const result = await fetchLatestCliVersion();
    expect(result).toBe('1.2.3');
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    expect(await fetchLatestCliVersion()).toBeNull();
  });

  it('returns null when response is not valid semver', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'dist-tags': { latest: 'not-a-version' } }),
    }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toBeNull();
  });

  it('returns null when dist-tags missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: '@macf/cli' }),
    }) as typeof fetch;
    expect(await fetchLatestCliVersion()).toBeNull();
  });
});

describe('fetchLatestPluginVersion', () => {
  it('returns the tag_name stripped of leading v', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.1.0' }),
    }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toBe('0.1.0');
  });

  it('accepts tags without leading v', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: '0.1.0' }),
    }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toBe('0.1.0');
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toBeNull();
  });

  it('returns null when tag is not semver', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'release-candidate' }),
    }) as typeof fetch;
    expect(await fetchLatestPluginVersion()).toBeNull();
  });
});

describe('fetchLatestActionsVersion', () => {
  it('returns major-only tag (v1 from v1.2.3)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.2.3' }),
    }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toBe('v1');
  });

  it('returns major-only tag (v2 from v2.0)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0' }),
    }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toBe('v2');
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toBeNull();
  });

  it('returns null for invalid tag format', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'release-1' }),
    }) as typeof fetch;
    expect(await fetchLatestActionsVersion()).toBeNull();
  });
});

describe('resolveLatestVersions', () => {
  it('returns network versions when all fetches succeed', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.2.0' } }) });
      }
      if (url.includes('macf-marketplace')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v0.3.0' }) });
      }
      if (url.includes('macf-actions')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v2.1.0' }) });
      }
      return Promise.reject(new Error('unexpected URL'));
    }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.versions).toEqual({
      cli: '0.2.0',
      plugin: '0.3.0',
      actions: 'v2',
    });
    expect(result.sources).toEqual({
      cli: 'network',
      plugin: 'network',
      actions: 'network',
    });
  });

  it('falls back when all fetches fail', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.versions).toEqual(FALLBACK_VERSIONS);
    expect(result.sources).toEqual({
      cli: 'fallback',
      plugin: 'fallback',
      actions: 'fallback',
    });
  });

  it('mixes network and fallback per component', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, json: async () => ({ 'dist-tags': { latest: '5.0.0' } }) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    }) as typeof fetch;

    const result = await resolveLatestVersions();
    expect(result.versions.cli).toBe('5.0.0');
    expect(result.versions.plugin).toBe(FALLBACK_VERSIONS.plugin);
    expect(result.versions.actions).toBe(FALLBACK_VERSIONS.actions);
    expect(result.sources).toEqual({
      cli: 'network',
      plugin: 'fallback',
      actions: 'fallback',
    });
  });
});
