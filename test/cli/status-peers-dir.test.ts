/**
 * Tests for --dir scoping on status and peers commands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { listPeers } from '../../src/cli/commands/peers.js';
import { agentConfigPath } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-dirflag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, overrides: Partial<MacfAgentConfig> = {}): void {
  const cfg: MacfAgentConfig = {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'owner', repo: 'repo' },
    github_app: { app_id: '1', install_id: '2', key_path: 'k' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
    ...overrides,
  };
  mkdirSync(join(dir, '.macf'), { recursive: true });
  writeFileSync(agentConfigPath(dir), JSON.stringify(cfg, null, 2) + '\n');
}

describe('listPeers with --dir', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = tempDir();
    process.env['GH_TOKEN'] = 'test-token';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('uses given projectDir config when provided', async () => {
    writeConfig(dir, {
      project: 'SCOPED',
      registry: { type: 'repo', owner: 'scoped-owner', repo: 'scoped-repo' },
    });

    // Mock fetch: return 200 with empty variables list. Assertion is on the URL used.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total_count: 0, variables: [] }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await listPeers(dir);

    // Verify the URL used the scoped project's path prefix
    const called = fetchMock.mock.calls.map(c => String(c[0])).join('\n');
    expect(called).toContain('/repos/scoped-owner/scoped-repo/');
  });

  it('errors clearly when --dir points to an invalid project', async () => {
    // Create a dir with an invalid/corrupt macf-agent.json
    const bad = join(dir, 'bad');
    mkdirSync(join(bad, '.macf'), { recursive: true });
    writeFileSync(agentConfigPath(bad), '{"invalid": true}');

    await listPeers(bad);

    const calls = errorSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('Could not read'))).toBe(true);
  });
});
