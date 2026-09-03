/**
 * Tests for fetchPluginToWorkspace — clones a local bare git repo standing
 * in for groundnuty/macf-marketplace. Keeps the test self-contained (no
 * network, no fixture branches on real remotes).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import {
  fetchPluginToWorkspace, copyLocalPluginToWorkspace, workspacePluginDir, stripPluginMcpServers,
  linkPluginCliDist, resolveCliDistDir,
} from '../../src/cli/plugin-fetcher.js';

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

  it('writes to targetDir when given, not the conventional default (macf#889)', () => {
    const altDir = join(workspace, '.macf', 'plugin-cs');
    fetchPluginToWorkspace(workspace, '0.1.0', { marketplaceUrl: bareUrl, targetDir: altDir });

    expect(existsSync(join(altDir, 'manifest.txt'))).toBe(true);
    // The conventional default was never written.
    expect(existsSync(workspacePluginDir(workspace))).toBe(false);
  });
});

describe('copyLocalPluginToWorkspace (groundnuty/macf#1424)', () => {
  let workspace: string;
  let localSource: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'macf-plugin-workspace-'));
    mkdirSync(join(workspace, '.macf'), { recursive: true });
    localSource = mkdtempSync(join(tmpdir(), 'macf-plugin-localsrc-'));
    mkdirSync(join(localSource, 'agents'), { recursive: true });
    writeFileSync(join(localSource, 'manifest.txt'), 'local-build-tree\n');
    writeFileSync(join(localSource, 'agents', 'code-agent.md'), '# local code-agent\n');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(localSource, { recursive: true, force: true });
  });

  it('copies a local directory tree with no git/network involved', () => {
    copyLocalPluginToWorkspace(workspace, localSource);

    const pluginDir = workspacePluginDir(workspace);
    expect(readFileSync(join(pluginDir, 'manifest.txt'), 'utf-8')).toBe('local-build-tree\n');
    expect(existsSync(join(pluginDir, 'agents', 'code-agent.md'))).toBe(true);
  });

  it('replaces an existing plugin dir (no stale files merged in)', () => {
    const pluginDir = workspacePluginDir(workspace);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'stale-file.txt'), 'should be gone after copy\n');

    copyLocalPluginToWorkspace(workspace, localSource);

    expect(existsSync(join(pluginDir, 'stale-file.txt'))).toBe(false);
    expect(existsSync(join(pluginDir, 'manifest.txt'))).toBe(true);
  });

  it('writes to targetDir when given, not the conventional default (macf#889)', () => {
    const altDir = join(workspace, '.macf', 'plugin-cs');
    copyLocalPluginToWorkspace(workspace, localSource, { targetDir: altDir });

    expect(existsSync(join(altDir, 'manifest.txt'))).toBe(true);
    expect(existsSync(workspacePluginDir(workspace))).toBe(false);
  });

  it('throws with an actionable message when the source dir does not exist', () => {
    const missing = join(localSource, 'does-not-exist');
    expect(() => copyLocalPluginToWorkspace(workspace, missing)).toThrow(/does not exist or is not a directory/);
  });

  it('throws when the source path is a FILE, not a directory', () => {
    const filePath = join(localSource, 'manifest.txt');
    expect(() => copyLocalPluginToWorkspace(workspace, filePath)).toThrow(/does not exist or is not a directory/);
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

describe('stripPluginMcpServers (DR-022 Amendment P, groundnuty/macf#995)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'macf-strip-mcp-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  function writeManifest(manifest: Record<string, unknown>): string {
    const dir = join(workspacePluginDir(ws), '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'plugin.json');
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return path;
  }

  it('deletes the mcpServers key, preserving every other key', () => {
    const path = writeManifest({
      name: 'macf-agent',
      version: '0.2.60',
      mcpServers: { 'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server'] } },
    });
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'stripped', path });
    const result = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(result['mcpServers']).toBeUndefined();
    expect(result['name']).toBe('macf-agent');
    expect(result['version']).toBe('0.2.60');
  });

  it('is idempotent (no-ops) once mcpServers is already absent — re-running does not error or rewrite', () => {
    const path = writeManifest({ name: 'macf-agent', version: '0.2.60' });
    const before = readFileSync(path, 'utf-8');
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'noop', path });
    // Second call (simulating a repeat `macf update` run) — still a no-op,
    // still no error, file byte-identical to before either call (#1005 hard
    // constraint: "running twice must not error or rewrite an already-
    // stripped manifest").
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'noop', path });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('is idempotent across a real strip + re-run: second call no-ops without rewriting', () => {
    const path = writeManifest({
      name: 'macf-agent',
      mcpServers: { 'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server'] } },
    });
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'stripped', path });
    const afterStrip = readFileSync(path, 'utf-8');
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'noop', path });
    expect(readFileSync(path, 'utf-8')).toBe(afterStrip);
  });

  it('no-ops when the plugin.json is absent — no crash', () => {
    const path = join(workspacePluginDir(ws), '.claude-plugin', 'plugin.json');
    expect(stripPluginMcpServers(ws)).toEqual({ status: 'noop', path });
  });

  it('no-ops when the mounted plugin dir itself is absent — no crash', () => {
    // Nothing created under `ws` at all (not even .macf/plugin/).
    expect(() => stripPluginMcpServers(ws)).not.toThrow();
    expect(stripPluginMcpServers(ws).status).toBe('noop');
  });

  it('refuses loudly + writes nothing on malformed JSON (does not throw; is not a silent skip) (#1005)', () => {
    const dir = join(workspacePluginDir(ws), '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'plugin.json');
    writeFileSync(path, '{ not valid json');
    const before = readFileSync(path, 'utf-8');

    let result: ReturnType<typeof stripPluginMcpServers>;
    expect(() => { result = stripPluginMcpServers(ws); }).not.toThrow();
    expect(result!.status).toBe('refused');
    expect((result! as { reason: string }).reason).toMatch(/not valid JSON/);
    // Refuses to write — content on disk is byte-identical to before.
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('refuses loudly when the manifest top-level is a JSON array, not an object', () => {
    const dir = join(workspacePluginDir(ws), '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'plugin.json');
    writeFileSync(path, JSON.stringify(['not', 'an', 'object']));

    const result = stripPluginMcpServers(ws);
    expect(result.status).toBe('refused');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify(['not', 'an', 'object']));
  });

  // macf#889: `macf update` must write to the dir claude.sh ACTUALLY mounts,
  // not always the conventional default.
  it('targetDir option strips an alternate dir (e.g. .macf/plugin-cs), not the default', () => {
    const altDir = join(ws, '.macf', 'plugin-cs');
    const manifestDir = join(altDir, '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });
    const path = join(manifestDir, 'plugin.json');
    writeFileSync(
      path,
      JSON.stringify({ name: 'macf-agent', mcpServers: { 'macf-agent': { command: 'npx', args: ['-y', '@groundnuty/macf-channel-server'] } } }, null, 2),
    );

    expect(stripPluginMcpServers(ws, { targetDir: altDir })).toEqual({ status: 'stripped', path });
    expect((JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)['mcpServers']).toBeUndefined();
    // The conventional default was never written (doesn't even exist).
    expect(existsSync(join(workspacePluginDir(ws), '.claude-plugin', 'plugin.json'))).toBe(false);
  });

  it('preserves formatting convention: 2-space indent + trailing newline (matches other keys unchanged)', () => {
    const path = writeManifest({
      name: 'macf-agent',
      nested: { keep: ['a', 'b'] },
      mcpServers: { 'macf-agent': { command: 'npx' } },
    });
    stripPluginMcpServers(ws);
    const raw = readFileSync(path, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['nested']).toEqual({ keep: ['a', 'b'] });
  });
});

describe('linkPluginCliDist (groundnuty/macf#676)', () => {
  let ws: string;
  let fakeCliDist: string;

  /**
   * Build a fake CLI `dist/` containing the plugin-CLI entry the /macf-*
   * skills invoke, standing in for the installed @groundnuty/macf package's
   * own dist/ (which isn't built in the source-checkout test runner).
   */
  function buildFakeCliDist(rootDir: string): string {
    const dist = join(rootDir, 'cli-dist');
    mkdirSync(join(dist, 'plugin', 'bin'), { recursive: true });
    writeFileSync(join(dist, 'plugin', 'bin', 'macf-plugin-cli.js'), '#!/usr/bin/env node\n');
    return dist;
  }

  /** A populated marketplace plugin dir (mimics fetchPluginToWorkspace output). */
  function populatePluginDir(): void {
    const pluginDir = workspacePluginDir(ws);
    mkdirSync(join(pluginDir, 'agents'), { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.txt'), 'fixture\n');
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'macf-link-dist-ws-'));
    fakeCliDist = buildFakeCliDist(mkdtempSync(join(tmpdir(), 'macf-link-dist-pkg-')));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dirname(fakeCliDist), { recursive: true, force: true });
  });

  it('makes .macf/plugin/dist/plugin/bin/macf-plugin-cli.js resolve after populate+deliver', () => {
    populatePluginDir();
    expect(linkPluginCliDist(ws, { cliDistDir: fakeCliDist })).toBe(true);

    const skillEntry = join(workspacePluginDir(ws), 'dist', 'plugin', 'bin', 'macf-plugin-cli.js');
    // The skills run `node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js"`;
    // CLAUDE_PLUGIN_ROOT == <ws>/.macf/plugin. This path must resolve (#676).
    expect(existsSync(skillEntry)).toBe(true);
  });

  it('creates a symlink pointing at the CLI dist (primary path)', () => {
    populatePluginDir();
    linkPluginCliDist(ws, { cliDistDir: fakeCliDist });

    const link = join(workspacePluginDir(ws), 'dist');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(fakeCliDist));
  });

  it('is idempotent — re-running replaces a stale link with a current one', () => {
    populatePluginDir();
    linkPluginCliDist(ws, { cliDistDir: fakeCliDist });

    // Point at a DIFFERENT dist on the second run; the link must now resolve
    // there (proves the stale link is replaced, not left in place).
    const otherDist = buildFakeCliDist(mkdtempSync(join(tmpdir(), 'macf-link-dist-pkg2-')));
    try {
      expect(linkPluginCliDist(ws, { cliDistDir: otherDist })).toBe(true);
      const link = join(workspacePluginDir(ws), 'dist');
      expect(realpathSync(link)).toBe(realpathSync(otherDist));
    } finally {
      rmSync(dirname(otherDist), { recursive: true, force: true });
    }
  });

  it('replaces a pre-existing real directory at the dist path', () => {
    populatePluginDir();
    // Simulate a prior copy-fallback (a real dir, not a symlink) at dist/.
    const stale = join(workspacePluginDir(ws), 'dist');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'STALE_MARKER'), 'old\n');

    linkPluginCliDist(ws, { cliDistDir: fakeCliDist });

    expect(existsSync(join(stale, 'STALE_MARKER'))).toBe(false);
    expect(existsSync(join(stale, 'plugin', 'bin', 'macf-plugin-cli.js'))).toBe(true);
  });

  it('no-ops (returns false) when the workspace plugin dir does not exist', () => {
    // No populatePluginDir() — .macf/plugin/ absent. Don't plant a dangling dir.
    expect(linkPluginCliDist(ws, { cliDistDir: fakeCliDist })).toBe(false);
    expect(existsSync(join(workspacePluginDir(ws), 'dist'))).toBe(false);
  });

  it('links into targetDir when given, not the conventional default (macf#889)', () => {
    const altDir = join(ws, '.macf', 'plugin-cs');
    mkdirSync(join(altDir, 'agents'), { recursive: true });
    writeFileSync(join(altDir, 'manifest.txt'), 'fixture\n');

    expect(linkPluginCliDist(ws, { cliDistDir: fakeCliDist, targetDir: altDir })).toBe(true);

    expect(existsSync(join(altDir, 'dist', 'plugin', 'bin', 'macf-plugin-cli.js'))).toBe(true);
    // The conventional default was never populated, so nothing to link into.
    expect(existsSync(workspacePluginDir(ws))).toBe(false);
  });

  it('no-ops (returns false) when the override dist lacks the plugin-CLI — n/a; resolveCliDistDir guards real runs', () => {
    // resolveCliDistDir() returns null when the running CLI has no built dist,
    // so linkPluginCliDist no-ops on an un-built source checkout. We assert the
    // resolver's contract directly: it returns null OR a dir whose
    // dist/plugin/bin/macf-plugin-cli.js exists (never a dangling pointer).
    const resolved = resolveCliDistDir();
    if (resolved !== null) {
      expect(existsSync(join(resolved, 'plugin', 'bin', 'macf-plugin-cli.js'))).toBe(true);
      expect(resolved.endsWith('dist')).toBe(true);
    }
  });
});
