/**
 * Tests for PR #4 — version pinning in macf init.
 * Focused on the new --cli-version / --plugin-version / --actions-version flags
 * and the backward-compat reader behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initAgent } from '../../src/cli/commands/init.js';
import { readAgentConfig, agentConfigPath } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-versions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const originalFetch = globalThis.fetch;

describe('macf init — version pinning', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    // Default: mock network as down → fall back
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as typeof fetch;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it('writes versions section with fallback defaults when offline', async () => {
    await initAgent(dir, {
      project: 'TEST', role: 'code-agent',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
    });

    const config = readAgentConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.versions).toEqual({
      cli: '0.1.0',
      plugin: '0.1.0',
      actions: 'v1',
    });
  });

  it('uses network-fetched versions when available', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.5.0' } }) });
      }
      if (url.includes('macf-marketplace')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v0.3.0' }) });
      }
      if (url.includes('macf-actions')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v2.1.0' }) });
      }
      return Promise.reject(new Error('unexpected'));
    }) as typeof fetch;

    await initAgent(dir, {
      project: 'TEST', role: 'code-agent',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
    });

    const config = readAgentConfig(dir);
    expect(config!.versions).toEqual({
      cli: '0.5.0',
      plugin: '0.3.0',
      actions: 'v2',
    });
  });

  it('honors explicit --cli-version flag', async () => {
    await initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      cliVersion: '9.9.9',
    });

    const config = readAgentConfig(dir);
    expect(config!.versions!.cli).toBe('9.9.9');
  });

  it('honors explicit --actions-version flag', async () => {
    await initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      actionsVersion: 'v2.0.0',
    });

    const config = readAgentConfig(dir);
    expect(config!.versions!.actions).toBe('v2.0.0');
  });

  it('skips network fetch when all three version flags are given', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      cliVersion: '1.2.3',
      pluginVersion: '4.5.6',
      actionsVersion: 'v7',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const config = readAgentConfig(dir);
    expect(config!.versions).toEqual({ cli: '1.2.3', plugin: '4.5.6', actions: 'v7' });
  });

  it('rejects invalid --cli-version format', async () => {
    await expect(initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      cliVersion: 'not-semver',
    })).rejects.toThrow('semver');
  });

  it('rejects invalid --plugin-version format', async () => {
    await expect(initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      pluginVersion: 'v1.0',
    })).rejects.toThrow('semver');
  });

  it('rejects invalid --actions-version format', async () => {
    await expect(initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      actionsVersion: 'branch-name',
    })).rejects.toThrow('tag ref');
  });

  it('accepts "main" as actions-version for testing', async () => {
    await initAgent(dir, {
      project: 'TEST', role: 'a',
      appId: '1', installId: '2', keyPath: 'k.pem',
      registryType: 'repo', registryRepo: 'o/r',
      actionsVersion: 'main',
    });

    const config = readAgentConfig(dir);
    expect(config!.versions!.actions).toBe('main');
  });
});

describe('backward compat — legacy configs without versions', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads legacy config without versions section', () => {
    // Write a legacy config by hand (no versions field)
    const legacyPath = agentConfigPath(dir);
    mkdirSync(join(dir, '.macf'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      project: 'TEST',
      agent_name: 'old-agent',
      agent_role: 'old-agent',
      agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      github_app: { app_id: '1', install_id: '2', key_path: 'k.pem' },
    }, null, 2));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = readAgentConfig(dir);
    stderrSpy.mockRestore();

    expect(config).not.toBeNull();
    expect(config!.agent_name).toBe('old-agent');
    expect(config!.versions).toBeUndefined();
  });

  it('warns when reading a legacy config', () => {
    const legacyPath = agentConfigPath(dir);
    mkdirSync(join(dir, '.macf'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      project: 'TEST', agent_name: 'a', agent_role: 'a', agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      github_app: { app_id: '1', install_id: '2', key_path: 'k' },
    }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    readAgentConfig(dir);
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    stderrSpy.mockRestore();

    expect(calls.some(c => c.includes('versions'))).toBe(true);
    expect(calls.some(c => c.includes('legacy config'))).toBe(true);
  });

  it('rejects malformed versions field (not a string)', () => {
    const legacyPath = agentConfigPath(dir);
    mkdirSync(join(dir, '.macf'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      project: 'TEST', agent_name: 'a', agent_role: 'a', agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      github_app: { app_id: '1', install_id: '2', key_path: 'k' },
      versions: { cli: 123, plugin: '0.1.0', actions: 'v1' }, // cli is number, invalid
    }));

    const config = readAgentConfig(dir);
    expect(config).toBeNull(); // safeParse fails
  });

  it('accepts valid versions field', () => {
    const legacyPath = agentConfigPath(dir);
    mkdirSync(join(dir, '.macf'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      project: 'TEST', agent_name: 'a', agent_role: 'a', agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      github_app: { app_id: '1', install_id: '2', key_path: 'k' },
      versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
    }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = readAgentConfig(dir);
    stderrSpy.mockRestore();

    expect(config).not.toBeNull();
    expect(config!.versions).toEqual({ cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    // No warning expected
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
