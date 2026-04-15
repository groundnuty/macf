/**
 * Tests for macf update command — PR #5 of P6 expansion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { update, buildDiff, renderDiff } from '../../src/cli/commands/update.js';
import { agentConfigPath } from '../../src/cli/config.js';
import type { ResolvedVersions } from '../../src/cli/version-resolver.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, versions?: { cli: string; plugin: string; actions: string }): void {
  const cfg: Partial<MacfAgentConfig> = {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'o', repo: 'r' },
    github_app: { app_id: '1', install_id: '2', key_path: 'k' },
  };
  if (versions) cfg.versions = versions;
  mkdirSync(join(dir, '.macf'), { recursive: true });
  writeFileSync(agentConfigPath(dir), JSON.stringify(cfg, null, 2) + '\n');
}

describe('buildDiff', () => {
  it('marks out-of-date components as update', () => {
    const resolved: ResolvedVersions = {
      versions: { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' },
      sources: { cli: 'ok', plugin: 'ok', actions: 'ok' },
    };
    const diff = buildDiff({ cli: '0.1.0', plugin: '0.1.0', actions: 'v1' }, resolved);
    expect(diff[0]).toEqual({ component: 'cli', current: '0.1.0', latest: '0.2.0', status: 'update' });
    expect(diff[1]).toEqual({ component: 'plugin', current: '0.1.0', latest: '0.1.0', status: 'same' });
    expect(diff[2]).toEqual({ component: 'actions', current: 'v1', latest: 'v1', status: 'same' });
  });

  it('marks fetch failures as fetch_failed', () => {
    const resolved: ResolvedVersions = {
      versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
      sources: { cli: 'not_published', plugin: 'ok', actions: 'network_error' },
    };
    const diff = buildDiff({ cli: '0.1.0', plugin: '0.1.0', actions: 'v1' }, resolved);
    expect(diff[0]!.status).toBe('fetch_failed');
    expect(diff[1]!.status).toBe('same');
    expect(diff[2]!.status).toBe('fetch_failed');
  });
});

describe('renderDiff', () => {
  it('produces a header and rows', () => {
    const output = renderDiff([
      { component: 'cli', current: '0.1.0', latest: '0.2.0', status: 'update' },
      { component: 'plugin', current: '0.1.0', latest: '0.1.0', status: 'same' },
    ]);
    expect(output).toContain('Component');
    expect(output).toContain('cli');
    expect(output).toContain('0.1.0');
    expect(output).toContain('0.2.0');
    expect(output).toContain('update available');
    expect(output).toContain('up to date');
  });
});

describe('update command', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = tempDir();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function mockFetchReturning(versions: { cli: string; plugin: string; actions: string }): void {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: true, json: async () => ({ 'dist-tags': { latest: versions.cli } }) });
      }
      if (url.includes('macf-marketplace')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: `v${versions.plugin}` }) });
      }
      if (url.includes('macf-actions')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: versions.actions }) });
      }
      return Promise.reject(new Error('unexpected URL'));
    }) as typeof fetch;
  }

  it('returns 1 with clear error when config missing', async () => {
    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('macf init'));
  });

  it('returns 1 when config has no versions section (legacy)', async () => {
    writeConfig(dir); // no versions
    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    expect(code).toBe(1);
    const calls = errorSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => s.includes('macf init --force'))).toBe(true);
  });

  it('returns 0 and does not write when everything is up to date', async () => {
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

    const before = readFileSync(agentConfigPath(dir), 'utf-8');
    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    const after = readFileSync(agentConfigPath(dir), 'utf-8');

    expect(code).toBe(0);
    expect(after).toBe(before); // unchanged
    expect(logSpy.mock.calls.flat().join('\n')).toContain('up to date');
  });

  it('--all --yes bumps all out-of-date components', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
    expect(cfg.versions).toEqual({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
  });

  it('--cli --yes bumps only cli', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
    expect(cfg.versions.cli).toBe('0.3.0');
    expect(cfg.versions.plugin).toBe('0.1.0'); // unchanged
    expect(cfg.versions.actions).toBe('v1'); // unchanged
  });

  it('--dry-run shows diff but does not write', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    const before = readFileSync(agentConfigPath(dir), 'utf-8');
    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: true });
    const after = readFileSync(agentConfigPath(dir), 'utf-8');

    expect(code).toBe(0);
    expect(after).toBe(before); // unchanged
    expect(logSpy.mock.calls.flat().join('\n')).toContain('dry-run');
  });

  it('returns 1 when all fetches fail', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as typeof fetch;

    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not fetch'));
  });

  it('--all with nothing out-of-date is a no-op exit 0', async () => {
    writeConfig(dir, { cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    const before = readFileSync(agentConfigPath(dir), 'utf-8');
    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
    const after = readFileSync(agentConfigPath(dir), 'utf-8');

    expect(code).toBe(0);
    expect(after).toBe(before);
  });

  it('combines --cli and --plugin flags', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    await update(dir, { all: false, cli: true, plugin: true, actions: false, yes: true, dryRun: false });

    const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
    expect(cfg.versions.cli).toBe('0.3.0');
    expect(cfg.versions.plugin).toBe('0.2.0');
    expect(cfg.versions.actions).toBe('v1'); // not selected
  });

  it('preserves unrelated config fields when writing', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });

    await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });

    const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
    expect(cfg.project).toBe('TEST');
    expect(cfg.agent_name).toBe('test-agent');
    expect(cfg.registry).toEqual({ type: 'repo', owner: 'o', repo: 'r' });
    expect(cfg.github_app).toEqual({ app_id: '1', install_id: '2', key_path: 'k' });
  });
});
