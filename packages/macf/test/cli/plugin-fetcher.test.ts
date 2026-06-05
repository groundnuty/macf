/**
 * Tests for fetchPluginToWorkspace — clones a local bare git repo standing
 * in for groundnuty/macf-marketplace. Keeps the test self-contained (no
 * network, no fixture branches on real remotes).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPluginToWorkspace, workspacePluginDir, pinChannelServerVersion } from '../../src/cli/plugin-fetcher.js';

/**
 * Build a local bare git repo with the layout of macf-marketplace:
 *   <bare>.git
 *     macf-agent/
 *       manifest.txt
 *       agents/code-agent.md
 *   tags: v0.1.0, v0.2.0
 */
function buildFakeMarketplace(rootDir: string): { bareUrl: string } {
  const bare = join(rootDir, 'marketplace.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);

  // Working clone to populate with content + tags.
  const work = join(rootDir, 'work');
  execFileSync('git', ['clone', bare, work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'test']);
  // Override global signing config: devs with `commit.gpgsign=true` /
  // `tag.gpgsign=true` globally would otherwise make the lightweight
  // `git tag <name>` below promote to a signed annotated tag, which
  // demands `-m <msg>` and fails with "fatal: no tag message?".
  execFileSync('git', ['-C', work, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', work, 'config', 'tag.gpgsign', 'false']);

  const plugin = join(work, 'macf-agent');
  mkdirSync(join(plugin, 'agents'), { recursive: true });
  writeFileSync(join(plugin, 'manifest.txt'), 'v0.1.0\n');
  writeFileSync(join(plugin, 'agents', 'code-agent.md'), '# code-agent v0.1.0\n');

  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'initial']);
  execFileSync('git', ['-C', work, 'tag', 'v0.1.0']);

  // Second version with a different file to prove re-fetch replaces content.
  writeFileSync(join(plugin, 'manifest.txt'), 'v0.2.0\n');
  writeFileSync(join(plugin, 'agents', 'science-agent.md'), '# science-agent v0.2.0\n');
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'v0.2.0 changes']);
  execFileSync('git', ['-C', work, 'tag', 'v0.2.0']);

  execFileSync('git', ['-C', work, 'push', bare, 'main', 'v0.1.0', 'v0.2.0']);

  rmSync(work, { recursive: true, force: true });

  return { bareUrl: `file://${bare}` };
}

describe('fetchPluginToWorkspace', () => {
  let fixtureRoot: string;
  let bareUrl: string;
  let workspace: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'macf-plugin-fixture-'));
    ({ bareUrl } = buildFakeMarketplace(fixtureRoot));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'macf-plugin-workspace-'));
    mkdirSync(join(workspace, '.macf'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('clones and extracts the plugin subdir at the pinned tag', () => {
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });

    const pluginDir = workspacePluginDir(workspace);
    expect(existsSync(pluginDir)).toBe(true);
    expect(readFileSync(join(pluginDir, 'manifest.txt'), 'utf-8')).toBe('v0.1.0\n');
    expect(existsSync(join(pluginDir, 'agents', 'code-agent.md'))).toBe(true);
  });

  it('does not leave the bare repo or .git metadata behind in the workspace', () => {
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });
    const pluginDir = workspacePluginDir(workspace);
    expect(existsSync(join(pluginDir, '.git'))).toBe(false);
  });

  it('replaces the plugin dir on re-fetch (no stale files from old version)', () => {
    // First fetch v0.1.0 — has manifest saying v0.1.0, no science-agent.md.
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });
    const pluginDir = workspacePluginDir(workspace);
    expect(existsSync(join(pluginDir, 'agents', 'science-agent.md'))).toBe(false);

    // Now fetch v0.2.0 — has science-agent.md and manifest "v0.2.0".
    fetchPluginToWorkspace(workspace, '0.2.0', { marketplaceUrl: bareUrl });
    expect(readFileSync(join(pluginDir, 'manifest.txt'), 'utf-8')).toBe('v0.2.0\n');
    expect(existsSync(join(pluginDir, 'agents', 'science-agent.md'))).toBe(true);

    // Downgrade back to v0.1.0 — science-agent.md should be GONE, proving
    // the dir is wiped on re-fetch (not merged).
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });
    expect(existsSync(join(pluginDir, 'agents', 'science-agent.md'))).toBe(false);
    expect(readFileSync(join(pluginDir, 'manifest.txt'), 'utf-8')).toBe('v0.1.0\n');
  });

  it('throws with a helpful error when the tag does not exist', () => {
    expect(() =>
      fetchPluginToWorkspace(workspace, '99.99.99', { marketplaceUrl: bareUrl }),
    ).toThrow(/Failed to fetch plugin/);
  });

  it('throws when the plugin subdir is absent from the marketplace repo', () => {
    // Point at a subdir that the fake marketplace does not contain.
    expect(() =>
      fetchPluginToWorkspace(workspace, '0.1.0', {
        marketplaceUrl: bareUrl,
        pluginSubdir: 'does-not-exist',
      }),
    ).toThrow(/Plugin subdir.*not found/);
  });

  it('creates .macf/plugin even when it did not exist before', () => {
    // Remove the .macf dir we created in beforeEach to simulate a fresh
    // workspace — fetchPluginToWorkspace must mkdir recursively.
    rmSync(join(workspace, '.macf'), { recursive: true, force: true });

    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });

    expect(existsSync(join(workspace, '.macf', 'plugin', 'manifest.txt'))).toBe(true);
  });

  it('preserves file contents byte-for-byte', () => {
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl });
    const pluginDir = workspacePluginDir(workspace);
    const stats = statSync(join(pluginDir, 'manifest.txt'));
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBe('v0.1.0\n'.length);
  });
});

describe('workspacePluginDir', () => {
  it('returns <workspace>/.macf/plugin', () => {
    const ws = '/tmp/whatever';
    expect(workspacePluginDir(ws)).toBe('/tmp/whatever/.macf/plugin');
  });

  it('resolves relative paths', () => {
    const result = workspacePluginDir('./relative');
    expect(result.endsWith('/.macf/plugin')).toBe(true);
    expect(result.startsWith('/')).toBe(true);
  });
});

describe('pinChannelServerVersion (groundnuty/macf#421)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'macf-pin-cs-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  function writeManifest(mcpServers: unknown): string {
    const dir = join(workspacePluginDir(ws), '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'plugin.json');
    writeFileSync(path, JSON.stringify({ name: 'macf-agent', mcpServers }, null, 2));
    return path;
  }
  function readArgs(path: string): string[] {
    const m = JSON.parse(readFileSync(path, 'utf-8'));
    return m.mcpServers['macf-agent'].args;
  }

  it('pins a bare npx channel-server spec to @<version>', () => {
    const path = writeManifest({
      'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server'], env: { MACF_VERSION: '${MACF_VERSION:-}' } },
    });
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(true);
    expect(readArgs(path)).toEqual(['-y', '@groundnuty/macf-channel-server@0.2.34']);
    // env block preserved.
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers['macf-agent'].env).toEqual({ MACF_VERSION: '${MACF_VERSION:-}' });
  });

  it('re-pins an already-pinned spec to the new version', () => {
    const path = writeManifest({
      'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server@0.2.20'] },
    });
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(true);
    expect(readArgs(path)).toEqual(['-y', '@groundnuty/macf-channel-server@0.2.34']);
  });

  it('is idempotent (no rewrite, returns false) when already at the target version', () => {
    writeManifest({
      'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server@0.2.34'] },
    });
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(false);
  });

  it('no-ops on the legacy node dist/server.js form (no npm spec to pin)', () => {
    const path = writeManifest({
      'macf-agent': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'] },
    });
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(false);
    expect(readArgs(path)).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/server.js']);
  });

  it('no-ops (returns false) when the plugin.json is absent', () => {
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(false);
  });

  it('no-ops when there is no mcpServers block', () => {
    const dir = join(workspacePluginDir(ws), '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'macf-agent' }, null, 2));
    expect(pinChannelServerVersion(ws, '0.2.34')).toBe(false);
  });
});
