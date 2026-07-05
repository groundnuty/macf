/**
 * Tests for src/trust-bundle.ts — DR-041 Decision 1 (groundnuty/macf#784)
 * cross-fleet multi-CA trust bundle resolution.
 *
 * Pure-logic tests only (fakes for the registry client + real-but-throwaway
 * temp files for the `.github/macf-fleet.json` read) — no real TLS here. The
 * empirical "does Node's `ca` array/bundle actually authorize a foreign-CA
 * peer cert" confirm (DR-041 Decision 1b's load-bearing Step-1 gate) lives in
 * `test/trust-bundle-mtls.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GitHubVariablesClient, Logger } from '@groundnuty/macf-core';
import {
  buildTrustBundlePem,
  loadFederatedCaProjects,
  resolveFederatedCaBundle,
  TrustBundleError,
} from '../src/trust-bundle.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeVarsClient(vars: Record<string, string | null>): GitHubVariablesClient {
  return {
    readVariable: async (name: string) => (name in vars ? vars[name]! : null),
    writeVariable: async () => undefined,
    listVariables: async () => [],
    deleteVariable: async () => undefined,
  };
}

function fakeThrowingVarsClient(err: Error): GitHubVariablesClient {
  return {
    readVariable: async () => { throw err; },
    writeVariable: async () => undefined,
    listVariables: async () => [],
    deleteVariable: async () => undefined,
  };
}

describe('loadFederatedCaProjects', () => {
  it('returns [] when workspaceDir is undefined', () => {
    expect(loadFederatedCaProjects(undefined, makeLogger())).toEqual([]);
  });

  it('returns [] when .github/macf-fleet.json does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      expect(loadFederatedCaProjects(dir, makeLogger())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the declared federated_cas list from a valid fleet config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(
        join(dir, '.github', 'macf-fleet.json'),
        JSON.stringify({ federated_cas: ['ppam-2026', 'icsoc-2026'] }),
      );
      expect(loadFederatedCaProjects(dir, makeLogger())).toEqual(['ppam-2026', 'icsoc-2026']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (never throws) on malformed JSON — the SAFE default for a trust config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), '{ not valid json');
      const logger = makeLogger();
      expect(loadFederatedCaProjects(dir, logger)).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'trust_bundle_fleet_config_parse_failed',
        expect.objectContaining({ path: expect.stringContaining('macf-fleet.json') }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to [] (never throws) on a schema violation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      // federated_cas entries must be strings per the schema.
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), JSON.stringify({ federated_cas: [123] }));
      const logger = makeLogger();
      expect(loadFederatedCaProjects(dir, logger)).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'trust_bundle_fleet_config_invalid',
        expect.objectContaining({ path: expect.stringContaining('macf-fleet.json') }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a routing_fleet-only marker with no guests/federated_cas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), JSON.stringify({ routing_fleet: false }));
      expect(loadFederatedCaProjects(dir, makeLogger())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveFederatedCaBundle', () => {
  it('returns ownCaCertPem UNCHANGED (byte-for-byte) when federatedProjects is empty', async () => {
    const own = '-----BEGIN CERTIFICATE-----\nOWN\n-----END CERTIFICATE-----\n';
    const result = await resolveFederatedCaBundle(own, [], undefined, makeLogger());
    expect(result).toBe(own);
  });

  it('concatenates own + resolved federated CA PEMs, in declared order', async () => {
    const own = '-----BEGIN CERTIFICATE-----\nOWN\n-----END CERTIFICATE-----\n';
    const foreign = '-----BEGIN CERTIFICATE-----\nFOREIGN\n-----END CERTIFICATE-----\n';
    const client = fakeVarsClient({ PPAM_2026_CA_CERT: foreign });
    const result = await resolveFederatedCaBundle(own, ['ppam-2026'], client, makeLogger());
    expect(result).toBe(`${own}\n${foreign}`);
  });

  it('resolves the registry variable name via toVariableSegment (hyphens -> underscores, uppercased)', async () => {
    const own = 'OWN-PEM';
    const foreign = 'FOREIGN-PEM';
    const readVariable = vi.fn(async (name: string) => (name === 'MULTI_WORD_PROJECT_CA_CERT' ? foreign : null));
    const client: GitHubVariablesClient = {
      readVariable,
      writeVariable: async () => undefined,
      listVariables: async () => [],
      deleteVariable: async () => undefined,
    };
    const result = await resolveFederatedCaBundle(own, ['multi-word-project'], client, makeLogger());
    expect(readVariable).toHaveBeenCalledWith('MULTI_WORD_PROJECT_CA_CERT');
    expect(result).toBe(`${own}\n${foreign}`);
  });

  it('federates MULTIPLE declared projects, appending each in order', async () => {
    const own = 'OWN';
    const client = fakeVarsClient({
      PPAM_2026_CA_CERT: 'PPAM-CA',
      ICSOC_2026_CA_CERT: 'ICSOC-CA',
    });
    const result = await resolveFederatedCaBundle(own, ['ppam-2026', 'icsoc-2026'], client, makeLogger());
    expect(result).toBe('OWN\nPPAM-CA\nICSOC-CA');
  });

  it('THROWS TrustBundleError when federatedProjects is non-empty but varsClient is undefined (local-registry mode)', async () => {
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], undefined, makeLogger()),
    ).rejects.toThrow(TrustBundleError);
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], undefined, makeLogger()),
    ).rejects.toThrow(/local-mode/);
  });

  it('THROWS TrustBundleError (never returns a partial bundle) when a declared project\'s CA variable is missing (null)', async () => {
    const client = fakeVarsClient({}); // readVariable resolves null for anything
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], client, makeLogger()),
    ).rejects.toThrow(TrustBundleError);
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], client, makeLogger()),
    ).rejects.toThrow(/PPAM_2026_CA_CERT/);
  });

  it('THROWS TrustBundleError when a declared project\'s CA variable is an empty string', async () => {
    const client = fakeVarsClient({ PPAM_2026_CA_CERT: '' });
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], client, makeLogger()),
    ).rejects.toThrow(TrustBundleError);
  });

  it('THROWS TrustBundleError (wrapping the cause) when the registry read itself fails (network/auth error)', async () => {
    const client = fakeThrowingVarsClient(new Error('GitHub API 500'));
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], client, makeLogger()),
    ).rejects.toThrow(TrustBundleError);
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026'], client, makeLogger()),
    ).rejects.toThrow(/GitHub API 500/);
  });

  it('a partial multi-project failure throws before returning ANY bundle (no silent partial allow-list)', async () => {
    // First project resolves; second is missing. The whole call must reject —
    // never return a bundle containing only the first project's CA.
    const client = fakeVarsClient({ PPAM_2026_CA_CERT: 'PPAM-CA' });
    await expect(
      resolveFederatedCaBundle('OWN', ['ppam-2026', 'icsoc-2026'], client, makeLogger()),
    ).rejects.toThrow(TrustBundleError);
  });

  it('TrustBundleError carries the canonical MacfError code', async () => {
    let caught: unknown;
    try {
      await resolveFederatedCaBundle('OWN', ['ppam-2026'], undefined, makeLogger());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TrustBundleError);
    expect((caught as TrustBundleError).code).toBe('TRUST_BUNDLE_ERROR');
  });
});

describe('buildTrustBundlePem (full orchestration)', () => {
  it('zero-federation workspace (no .github/macf-fleet.json) returns ownCaCertPem unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      const own = 'OWN-CA-PEM';
      const result = await buildTrustBundlePem({
        workspaceDir: dir,
        ownCaCertPem: own,
        varsClient: undefined,
        logger: makeLogger(),
      });
      expect(result).toBe(own);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end: fleet config declares federated_cas, resolves + concatenates via the injected varsClient', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), JSON.stringify({ federated_cas: ['ppam-2026'] }));
      const own = 'OWN-CA-PEM';
      const client = fakeVarsClient({ PPAM_2026_CA_CERT: 'PPAM-CA-PEM' });
      const result = await buildTrustBundlePem({
        workspaceDir: dir,
        ownCaCertPem: own,
        varsClient: client,
        logger: makeLogger(),
      });
      expect(result).toBe('OWN-CA-PEM\nPPAM-CA-PEM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end: local-registry mode (no varsClient) + declared federated_cas throws loud at startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-trust-bundle-'));
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'macf-fleet.json'), JSON.stringify({ federated_cas: ['ppam-2026'] }));
      await expect(
        buildTrustBundlePem({
          workspaceDir: dir,
          ownCaCertPem: 'OWN-CA-PEM',
          varsClient: undefined,
          logger: makeLogger(),
        }),
      ).rejects.toThrow(TrustBundleError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
