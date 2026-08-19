/**
 * Tests for macf update command — PR #5 of P6 expansion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Stub the plugin fetcher for the whole file — otherwise any test that
// bumps a pin would trigger a real `git clone` of groundnuty/macf-marketplace,
// making tests network-dependent and slow. workspacePluginDir still returns
// a real path so the repair-case predicate can inspect it.
vi.mock('../../src/cli/plugin-fetcher.js', () => ({
  fetchPluginToWorkspace: vi.fn(),
  workspacePluginDir: (dir: string) => join(dir, '.macf', 'plugin'),
  // DR-022 Amendment P / groundnuty/macf#995 successor to the retired
  // pinChannelServerVersion — strips mcpServers from the (mocked, never
  // really fetched) local plugin.json copy.
  stripPluginMcpServers: vi.fn(() => false),
  // Stub the #676 dist-link delivery — it resolves the running CLI's own dist
  // via import.meta.url, which isn't built in the test runner; a no-op keeps
  // the update flow under test without touching the filesystem.
  linkPluginCliDist: vi.fn(() => false),
}));

// `.mcp.json` writing (groundnuty/macf#995) is REAL pure-fs code (no
// network, no git clone) — left UNMOCKED by default so the decisive
// retrofit test below asserts against a genuine on-disk file. Only
// `readMcpJsonChannelServerVersion` is wrapped in `vi.fn()` (delegating to
// the real implementation by default) so the ONE Pattern-A-mismatch test
// can override a single call via `mockReturnValueOnce` — same shape the
// retired `readPinnedChannelServerVersion` mock served.
vi.mock('../../src/cli/mcp-json.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/mcp-json.js')>();
  return {
    ...actual,
    readMcpJsonChannelServerVersion: vi.fn(actual.readMcpJsonChannelServerVersion),
  };
});

// Stub `node:readline.createInterface` so tests can drive the unified
// Proceed? prompt (macf#334) without attaching to real stdin. Tests set
// `mockPromptAnswer` before invoking `update` to feed the prompt.
let mockPromptAnswer = '';
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_message: string, cb: (answer: string) => void) => cb(mockPromptAnswer),
    close: () => undefined,
  }),
}));

import { update, buildDiff, renderDiff } from '../../src/cli/commands/update.js';
import { agentConfigPath } from '../../src/cli/config.js';
import { fetchPluginToWorkspace, stripPluginMcpServers, linkPluginCliDist } from '../../src/cli/plugin-fetcher.js';
import { mcpJsonPath, readMcpJsonChannelServerVersion, MCP_SERVER_NAME } from '../../src/cli/mcp-json.js';
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

  it('preserves fetch-status distinction, not collapsed to fetch_failed (#111 C2)', () => {
    // Pre-#111: not_published and network_error both became
    // 'fetch_failed'. Post-fix: each non-ok source preserves its
    // specific state so operators don't investigate non-issues
    // (\"not yet published\" ≠ \"network down\").
    const resolved: ResolvedVersions = {
      versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
      sources: { cli: 'not_published', plugin: 'ok', actions: 'network_error' },
    };
    const diff = buildDiff({ cli: '0.1.0', plugin: '0.1.0', actions: 'v1' }, resolved);
    expect(diff[0]!.status).toBe('not_published');
    expect(diff[1]!.status).toBe('same');
    expect(diff[2]!.status).toBe('network_error');
  });

  it('propagates invalid_response as its own status', () => {
    const resolved: ResolvedVersions = {
      versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
      sources: { cli: 'invalid_response', plugin: 'ok', actions: 'ok' },
    };
    const diff = buildDiff({ cli: '0.1.0', plugin: '0.1.0', actions: 'v1' }, resolved);
    expect(diff[0]!.status).toBe('invalid_response');
  });
});

describe('renderDiff status messages (#111 C2)', () => {
  it('renders not_published with a distinct not-yet-published message', () => {
    const output = renderDiff([
      { component: 'cli', current: '0.1.0', latest: '0.1.0', status: 'not_published' },
    ]);
    expect(output).toMatch(/not yet published|not published/i);
    // Must not look like a network failure.
    expect(output).not.toMatch(/fetch failed|network/i);
  });

  it('renders network_error with a fetch-failed / network message', () => {
    const output = renderDiff([
      { component: 'cli', current: '0.1.0', latest: '0.1.0', status: 'network_error' },
    ]);
    expect(output).toMatch(/fetch failed|network/i);
    expect(output).not.toMatch(/not yet published/i);
  });

  it('renders invalid_response distinctly', () => {
    const output = renderDiff([
      { component: 'cli', current: '0.1.0', latest: '0.1.0', status: 'invalid_response' },
    ]);
    expect(output).toMatch(/unexpected response|invalid response/i);
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

  // #382: mock fetch to stabilize the legacy-config path. Even though
  // the legacy branch short-circuits before `resolveLatestVersions()`
  // is called (the `if (!config.versions) return 1` at update.ts:409),
  // the update path before that exit still runs `migrateCaKeyToV2`,
  // which calls `client.readVariable(...)` → `fetch(api.github.com/...)`
  // on its way to a 401/403 with the fake test credentials. In publish
  // CI, that fetch can take seconds to fail. Stub `globalThis.fetch` so
  // every outbound HTTP request short-circuits to a fast 404, keeping
  // the test under the default 5s vitest timeout. Restored in afterEach.
  // Replaces the 30s per-test timeout lift in PR #380.
  it('returns 1 when config has no versions section (legacy)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as typeof fetch;
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

  it('surfaces skipped-due-to-fetch-failure rows in summary instead of silent "up to date" (#335)', async () => {
    writeConfig(dir, { cli: '0.1.0', plugin: '0.2.0', actions: 'v2' });
    // cli URL returns 404 (simulating pre-fix wrong-URL OR genuine not-published)
    // plugin + actions return values matching current → status `same`
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.includes('macf-marketplace')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v0.2.0' }) });
      }
      if (url.includes('macf-actions')) {
        return Promise.resolve({ ok: true, json: async () => ({ tag_name: 'v2' }) });
      }
      return Promise.reject(new Error('unexpected URL'));
    }) as typeof fetch;

    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
    expect(code).toBe(0);

    const allLogs = logSpy.mock.calls.flat().join('\n');
    // The new summary message must surface the skipped pin explicitly
    expect(allLogs).toContain('Skipped due to fetch failure');
    expect(allLogs).toContain('cli');
    expect(allLogs).toContain('not_published');
    // The misleading bare "Everything is up to date" should NOT appear
    expect(allLogs).not.toMatch(/^Everything is up to date\.$/m);
  });

  it('still prints bare "Everything is up to date" when all 3 components are ok + same (no regression)', async () => {
    writeConfig(dir, { cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
    mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

    const code = await update(dir, { all: true, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
    expect(code).toBe(0);

    const allLogs = logSpy.mock.calls.flat().join('\n');
    expect(allLogs).toMatch(/Everything is up to date/);
    expect(allLogs).not.toContain('Skipped due to fetch failure');
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

  describe('unified preview-then-prompt flow (#334)', () => {
    it('bare `macf update` shows preview + Proceed? prompt; "y" applies all bumps', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = 'y';

      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
      expect(code).toBe(0);

      // Preview surfaced
      const allLogs = logSpy.mock.calls.flat().join('\n');
      expect(allLogs).toContain('This run will bump:');
      expect(allLogs).toContain('cli: 0.1.0 → 0.3.0');
      expect(allLogs).toContain('plugin: 0.1.0 → 0.2.0');
      expect(allLogs).toContain('actions: v1 → v2');

      // All 3 bumps applied
      const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
      expect(cfg.versions).toEqual({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
    });

    it('bare `macf update` with "n" answer leaves config unchanged', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = 'n';

      const before = readFileSync(agentConfigPath(dir), 'utf-8');
      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
      const after = readFileSync(agentConfigPath(dir), 'utf-8');

      expect(code).toBe(0);
      expect(after).toBe(before);
      expect(logSpy.mock.calls.flat().join('\n')).toContain('No changes. Exiting.');
    });

    it('bare `macf update` with empty answer (default N) leaves config unchanged', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = '';

      const before = readFileSync(agentConfigPath(dir), 'utf-8');
      await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
      const after = readFileSync(agentConfigPath(dir), 'utf-8');

      expect(after).toBe(before);
    });

    it('--confirm flag is explicit alias for the unified flow (no behavioral change vs bare)', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = 'yes';

      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false, confirm: true });
      expect(code).toBe(0);

      // Preview rendered (the prompt itself goes to stderr via readline,
      // not captured here; presence of preview header confirms the flow ran).
      const allLogs = logSpy.mock.calls.flat().join('\n');
      expect(allLogs).toContain('This run will bump:');

      const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
      expect(cfg.versions.cli).toBe('0.3.0');
    });

    it('--yes bypasses the prompt entirely (no preview header)', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = 'n';  // would say no IF prompted; but --yes bypasses

      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: true, dryRun: false });
      expect(code).toBe(0);

      const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
      expect(cfg.versions).toEqual({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });

      // No preview header rendered (--yes bypasses the entire prompt flow)
      const allLogs = logSpy.mock.calls.flat().join('\n');
      expect(allLogs).not.toContain('This run will bump:');
    });

    it('explicit selection (--cli alone) bypasses prompt for backward compat', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.2.0', actions: 'v2' });
      mockPromptAnswer = 'n';  // would say no IF prompted

      const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: false, dryRun: false });
      expect(code).toBe(0);

      const cfg = JSON.parse(readFileSync(agentConfigPath(dir), 'utf-8'));
      // cli bumped; plugin/actions unchanged (not in selection)
      expect(cfg.versions.cli).toBe('0.3.0');
      expect(cfg.versions.plugin).toBe('0.1.0');
      expect(cfg.versions.actions).toBe('v1');
    });
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

  it('refreshes canonical rules even when everything is up to date (#52 follow-up)', async () => {
    // This is the bug: previously copyCanonicalRules only ran after a
    // successful writeAgentConfig, so workspaces with matching pins never
    // got new rules even though the installed CLI shipped updated ones.
    // After the fix, the copy runs right after readAgentConfig succeeds.
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    expect(code).toBe(0);

    // Should have coordination.md even though no version bump happened.
    expect(existsSync(join(dir, '.claude', 'rules', 'coordination.md'))).toBe(true);
    // And the tmux helper script.
    expect(existsSync(join(dir, '.claude', 'scripts', 'tmux-send-to-claude.sh'))).toBe(true);
  });

  it('refreshes canonical rules even with legacy config (no versions section)', async () => {
    // Stale workspaces without a versions section should still get current
    // rules — users shouldn't have to run `macf init --force` just to pick
    // up updated coordination rules.
    writeConfig(dir); // legacy: no versions

    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    // Still returns 1 because versions are required for the pin-bump flow,
    // but the asset refresh should have happened first.
    expect(code).toBe(1);
    expect(existsSync(join(dir, '.claude', 'rules', 'coordination.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'scripts', 'tmux-send-to-claude.sh'))).toBe(true);
  });

  it('re-fetches plugin when .macf/plugin/ is present but empty (#62 repair)', async () => {
    // Workspace init'd before PR #60 merged: .macf/plugin/ exists as an
    // empty directory. existsSync is true, but pluginDirNeedsRepair must
    // still treat it as broken.
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
    // Nothing bumped — same versions returned by the "latest" fetch.
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

    vi.mocked(fetchPluginToWorkspace).mockClear();
    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    expect(code).toBe(0);

    // Repair case: fetch should have been invoked exactly once with the
    // pinned version even though nothing was bumped, targeting the resolved
    // (default, since claude.sh mounts `.macf/plugin` here) plugin dir
    // (macf#889 — the target is now explicit, not implicit).
    expect(fetchPluginToWorkspace).toHaveBeenCalledTimes(1);
    expect(fetchPluginToWorkspace).toHaveBeenCalledWith(
      dir, '0.1.0', { targetDir: join(dir, '.macf', 'plugin') },
    );
  });

  it('does not re-fetch plugin when .macf/plugin/ is populated and no bump happens', async () => {
    // Healthy workspace: .macf/plugin/ has content, pins match latest.
    // Should short-circuit without any plugin refresh.
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
    writeFileSync(join(dir, '.macf', 'plugin', 'manifest.txt'), 'v0.1.0\n');
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

    vi.mocked(fetchPluginToWorkspace).mockClear();
    await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

    expect(fetchPluginToWorkspace).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // macf#889: the roll must write to the plugin dir claude.sh ACTUALLY
  // MOUNTS, not the conventional `.macf/plugin` default — plus the
  // post-upgrade result-invariant assertion (Pattern A).
  // ---------------------------------------------------------------------
  describe('mounted-plugin-dir resolution (#889)', () => {
    /** A hand-authored (no managed-header) claude.sh mounting `plugDirName`. */
    function writeHandAuthoredLauncher(plugDirName: string | null): void {
      const flag = plugDirName === null ? '' : `--plugin-dir "$SCRIPT_DIR/.macf/${plugDirName}" `;
      writeFileSync(
        join(dir, 'claude.sh'),
        '#!/usr/bin/env bash\n' +
          '# Hand-wired substrate launcher (DR-005 Decision 6) — no macf managed-header.\n' +
          'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
          `exec claude ${flag}"$@"\n`,
        { mode: 0o755 },
      );
    }

    beforeEach(() => {
      vi.mocked(fetchPluginToWorkspace).mockClear();
      vi.mocked(stripPluginMcpServers).mockClear();
      vi.mocked(linkPluginCliDist).mockClear();
      vi.mocked(readMcpJsonChannelServerVersion).mockClear();
    });

    it('claude.sh mounts the default .macf/plugin — that dir is updated (existing behaviour preserved)', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      // No claude.sh pre-seeded — the canonical template mounts .macf/plugin.
      // Pre-populate it so the #62 repair-fetch path doesn't also fire — real
      // dir needed since the mocked fetchPluginToWorkspace never actually
      // creates one. This is a CLI-only bump (plugin: false), so neither
      // fetchPluginToWorkspace NOR stripPluginMcpServers fire (both are
      // paired with an actual re-fetch, macf#995) — the mount-resolution
      // proof for a component-agnostic write is `linkPluginCliDist`
      // (unconditional on pluginTarget.dir existing) + `.mcp.json`'s pin
      // (unconditional on config.versions, independent of pluginTarget
      // entirely).
      mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
      writeFileSync(join(dir, '.macf', 'plugin', 'manifest.txt'), 'seed\n');
      mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });

      const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });
      expect(code).toBe(0);

      expect(linkPluginCliDist).toHaveBeenCalledWith(
        dir, { targetDir: join(dir, '.macf', 'plugin') },
      );
      // .mcp.json is independent of plugin-mount resolution — it always
      // lands at the workspace root, pinned to the bumped CLI version.
      expect(existsSync(mcpJsonPath(dir))).toBe(true);
      expect(readMcpJsonChannelServerVersion(dir)).toBe('0.3.0');
    });

    it('claude.sh mounts .macf/plugin-cs — plugin-cs is updated, not the default', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      writeHandAuthoredLauncher('plugin-cs');
      // Pre-populate plugin-cs so the #62 repair-fetch path doesn't also fire.
      mkdirSync(join(dir, '.macf', 'plugin-cs'), { recursive: true });
      writeFileSync(join(dir, '.macf', 'plugin-cs', 'manifest.txt'), 'seed\n');
      mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });

      const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });
      expect(code).toBe(0);

      expect(linkPluginCliDist).toHaveBeenCalledWith(
        dir, { targetDir: join(dir, '.macf', 'plugin-cs') },
      );
      // The unmounted default must never be touched by this run.
      const defaultDir = join(dir, '.macf', 'plugin');
      for (const call of vi.mocked(linkPluginCliDist).mock.calls) {
        expect(call[1]).not.toEqual({ targetDir: defaultDir });
      }
      for (const call of vi.mocked(fetchPluginToWorkspace).mock.calls) {
        expect(call[2]).not.toEqual({ targetDir: defaultDir });
      }
    });

    it('both .macf/plugin and .macf/plugin-cs present — the MOUNTED one wins + warns naming both paths', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
        writeHandAuthoredLauncher('plugin-cs');
        mkdirSync(join(dir, '.macf', 'plugin-cs'), { recursive: true });
        writeFileSync(join(dir, '.macf', 'plugin-cs', 'manifest.txt'), 'seed\n');
        // The unmounted default ALSO exists on disk (the macf#889 "loaded gun" shape).
        mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
        writeFileSync(join(dir, '.macf', 'plugin', 'manifest.txt'), 'stale\n');
        mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });

        const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });
        expect(code).toBe(0);

        expect(linkPluginCliDist).toHaveBeenCalledWith(
          dir, { targetDir: join(dir, '.macf', 'plugin-cs') },
        );
        // Names BOTH paths (AC2) so an operator/agent can see the unmounted
        // default is deliberately left alone, not silently drifting.
        const warnOut = warnSpy.mock.calls.flat().join('\n');
        expect(warnOut).toContain(join(dir, '.macf', 'plugin-cs'));
        expect(warnOut).toContain(join(dir, '.macf', 'plugin'));
        expect(warnOut).toMatch(/macf#889/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('mounted plugin dir undeterminable (no --plugin-dir at all) — loud refusal, no silent default update', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      writeHandAuthoredLauncher(null); // no --plugin-dir flag anywhere
      // The conventional default exists as an empty dir — a naive fallback
      // would "repair-fetch" it. It must be left alone instead.
      mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
      mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });

      const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });
      expect(code).toBe(0); // loud, but non-blocking — asset refresh etc. still succeeded

      expect(fetchPluginToWorkspace).not.toHaveBeenCalled();
      expect(stripPluginMcpServers).not.toHaveBeenCalled();
      const errOut = errorSpy.mock.calls.flat().join('\n');
      expect(errOut).toMatch(/cannot determine which plugin dir claude\.sh mounts/);
      expect(errOut).toMatch(/macf#889/);
      // .mcp.json is UNAFFECTED by plugin-mount undeterminability — it's not
      // resolved through pluginTarget at all (macf#995).
      expect(existsSync(mcpJsonPath(dir))).toBe(true);
    });

    it('post-update verification fails LOUDLY on a deliberately mismatched .mcp.json pin (Pattern A, macf#889/#995)', async () => {
      writeConfig(dir, { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' });
      mkdirSync(join(dir, '.macf', 'plugin'), { recursive: true });
      writeFileSync(join(dir, '.macf', 'plugin', 'manifest.txt'), 'seed\n');
      mockFetchReturning({ cli: '0.3.0', plugin: '0.1.0', actions: 'v1' });
      // Simulate the write not reaching .mcp.json: the read-back reports the
      // OLD version even after the real write "ran" (one-shot override —
      // readMcpJsonChannelServerVersion is otherwise the real implementation).
      vi.mocked(readMcpJsonChannelServerVersion).mockReturnValueOnce('0.1.0');

      const code = await update(dir, { all: false, cli: true, plugin: false, actions: false, yes: true, dryRun: false });

      // Loud, but non-blocking (see the code comment at the assertion site:
      // `upgrade()`'s driver shells this via execFileSync({stdio:'inherit'}),
      // which throws on non-zero — a hard failure here would abort the
      // roll's upgrade→restart transaction mid-flight).
      expect(code).toBe(0);
      const errOut = errorSpy.mock.calls.flat().join('\n');
      expect(errOut).toMatch(/FATAL/);
      expect(errOut).toContain('@0.1.0');
      expect(errOut).toContain('@0.3.0');
      expect(errOut).toMatch(/macf#889/);
    });
  });

  // groundnuty/macf#995 (DR-022 Amendment P) — THE DECISIVE test. A fresh
  // `macf init`-only test would pass while every EXISTING fleet workspace
  // stayed deaf to native channel routing; this proves `macf update` alone,
  // on a workspace that predates the change entirely, adds the mount.
  describe('.mcp.json retrofit (DR-022 Amendment P, groundnuty/macf#995)', () => {
    it('update on a workspace with NO .mcp.json adds it, merge-not-clobber for one with other servers, refuses on malformed', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      expect(existsSync(mcpJsonPath(dir))).toBe(false);

      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
      expect(code).toBe(0);

      expect(existsSync(mcpJsonPath(dir))).toBe(true);
      const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
      expect(written.mcpServers[MCP_SERVER_NAME].command).toBe('npx');
      expect(written.mcpServers[MCP_SERVER_NAME].args).toContain('@groundnuty/macf-channel-server@0.2.0');
    });

    it('merges into an operator-authored .mcp.json with OTHER servers, preserving them (never clobbers)', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      writeFileSync(
        mcpJsonPath(dir),
        JSON.stringify({ mcpServers: { 'operator-tool': { command: 'node', args: ['other.js'] } } }, null, 2) + '\n',
      );

      const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
      expect(code).toBe(0);

      const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
      expect(written.mcpServers['operator-tool']).toEqual({ command: 'node', args: ['other.js'] });
      expect(written.mcpServers[MCP_SERVER_NAME].command).toBe('npx');
    });

    it('refuses loudly + writes nothing when .mcp.json is malformed JSON', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        writeFileSync(mcpJsonPath(dir), '{ not valid json');
        const before = readFileSync(mcpJsonPath(dir), 'utf-8');

        const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
        expect(code).toBe(0); // loud warn, non-blocking — matches the plugin-fetch-failure posture

        expect(readFileSync(mcpJsonPath(dir), 'utf-8')).toBe(before);
        const warnOut = warnSpy.mock.calls.flat().join('\n');
        expect(warnOut).toMatch(/\.mcp\.json not written/);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('regenerates a macf-managed (header-carrying) stale claude.sh on every update, even when nothing is bumped (#63)', async () => {
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    // Seed a stale BUT macf-managed claude.sh (carries the managed-header,
    // as every macf-generated launcher does) that's otherwise out of date.
    // DR-029 / macf#623: managed launchers are still refreshed.
    const shPath = join(dir, 'claude.sh');
    writeFileSync(
      shPath,
      '#!/usr/bin/env bash\n' +
        '# This file is managed by `macf`. Do not edit directly — edits are\n' +
        '# overwritten on the next `macf update`.\n' +
        '# stale launcher\nexec claude "$@"\n',
      { mode: 0o755 },
    );
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

    await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

    const regenerated = readFileSync(shPath, 'utf-8');
    expect(regenerated).not.toContain('stale launcher');
    expect(regenerated).toContain('--plugin-dir "$SCRIPT_DIR/.macf/plugin"');
    expect(regenerated).toContain('managed by `macf`');
  });

  it('regenerates a macf-managed claude.sh even for legacy config without versions section', async () => {
    // Regenerate shouldn't depend on versions — legacy workspaces still
    // benefit from getting the current launcher template. Seed a managed
    // (header-carrying) stale launcher so the DR-029 regenerate path fires.
    writeConfig(dir); // legacy, no versions
    const shPath = join(dir, 'claude.sh');
    writeFileSync(
      shPath,
      '#!/usr/bin/env bash\n' +
        '# This file is managed by `macf`. Do not edit directly — edits are\n' +
        '# legacy launcher\n',
      { mode: 0o755 },
    );

    const code = await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });
    expect(code).toBe(1); // still errors on missing versions

    const regenerated = readFileSync(shPath, 'utf-8');
    expect(regenerated).not.toContain('legacy launcher');
    expect(regenerated).toContain('--plugin-dir');
  });

  it('preserves a hand-authored (header-LESS) claude.sh + warns, never clobbers (DR-029 / #623)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      // Seed a hand-authored launcher with NO macf managed-header — shape
      // mirrors the framework repo's own claude.sh.
      const shPath = join(dir, 'claude.sh');
      const handAuthored =
        '#!/bin/bash\n' +
        '# Launcher for macf-code-agent\n' +
        'set -euo pipefail\n' +
        'CLAUDE_BIN="${CLAUDE_BIN:-claude}"\n' +
        'exec "$CLAUDE_BIN" "$@"\n';
      writeFileSync(shPath, handAuthored, { mode: 0o755 });

      await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

      // Content preserved byte-for-byte — NOT overwritten by the template.
      expect(readFileSync(shPath, 'utf-8')).toBe(handAuthored);
      // Drift-aware warning surfaced.
      const warnOut = warnSpy.mock.calls.flat().join('\n');
      expect(warnOut).toMatch(/Preserved hand-authored claude\.sh/);
      expect(warnOut).toMatch(/managed-header/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('generates claude.sh fresh when absent (no preserve when nothing to preserve) (#623)', async () => {
    writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
    // No claude.sh on disk to start.
    const shPath = join(dir, 'claude.sh');
    expect(existsSync(shPath)).toBe(false);

    await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

    const generated = readFileSync(shPath, 'utf-8');
    expect(generated).toContain('managed by `macf`');
    expect(generated).toContain('--plugin-dir "$SCRIPT_DIR/.macf/plugin"');
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

  // ---------------------------------------------------------------------
  // macf#342 PR-C: env-file refresh + monolithic migration
  // ---------------------------------------------------------------------

  describe('env-file refresh + migration (#342 PR-C)', () => {
    it('writes per-concern env files on update (.claude/.macf/env.*)', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });

      await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

      const envDir = join(dir, '.claude', '.macf');
      for (const name of [
        'env._helpers',
        'env.identity',
        'env.github',
        'env.certs',
        'env.registry',
        'env.telemetry',
        'env.tmux',
      ]) {
        expect(existsSync(join(envDir, name))).toBe(true);
      }
    });

    it('preserves operator-managed env.telemetry across updates', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      // Pre-seed an operator-edited env.telemetry
      mkdirSync(join(dir, '.claude', '.macf'), { recursive: true });
      const customTelemetry =
        '# Operator override\nexport OTEL_EXPORTER_OTLP_ENDPOINT="http://my-collector:4318"\n';
      const path = join(dir, '.claude', '.macf', 'env.telemetry');
      writeFileSync(path, customTelemetry);

      await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

      // Operator content preserved unchanged
      expect(readFileSync(path, 'utf-8')).toBe(customTelemetry);
    });

    it('overwrites + warns on hand-edited macf-managed env.identity', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        // Pre-seed a hand-edited macf-managed file
        mkdirSync(join(dir, '.claude', '.macf'), { recursive: true });
        const path = join(dir, '.claude', '.macf', 'env.identity');
        writeFileSync(path, '# operator hand-edit\nexport HACK=1\n');

        await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

        // Hand-edit replaced with canonical generator output
        const after = readFileSync(path, 'utf-8');
        expect(after).not.toContain('HACK=1');
        expect(after).toContain('MACF_PROJECT="TEST"');
        // Warning surfaced on stderr
        const stderrOut = stderrSpy.mock.calls.flat().join('\n');
        expect(stderrOut).toMatch(/hand-edited macf-managed/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('migrates a monolithic claude.sh on first update (env files appear)', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      // Pre-seed a monolithic-shaped claude.sh. Real pre-#342 monolithic
      // launchers carried the macf managed-header, so include it — without it
      // the DR-029 (#623) preserve path would treat the stub as hand-authored
      // and skip migration.
      const shPath = join(dir, 'claude.sh');
      writeFileSync(
        shPath,
        '#!/usr/bin/env bash\nset -euo pipefail\n' +
          '# This file is managed by `macf`. Do not edit directly — edits are\n' +
          'export MACF_AGENT_NAME="test-agent"\nexec claude "$@"\n',
        { mode: 0o755 },
      );

      await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

      // Thin template marker present after update (writeClaudeSh OR migration both produce it)
      const sh = readFileSync(shPath, 'utf-8');
      expect(sh).toContain('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
      // env files present
      expect(existsSync(join(dir, '.claude', '.macf', 'env.identity'))).toBe(true);
      expect(existsSync(join(dir, '.claude', '.macf', 'env.github'))).toBe(true);
    });

    it('emits deprecation warning when settings.local.json carries env.MACF_OTEL_ENDPOINT', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
        // Pre-seed settings.local.json with a deprecated env key
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(
          join(dir, '.claude', 'settings.local.json'),
          JSON.stringify(
            { env: { MACF_OTEL_ENDPOINT: 'http://orzech-dev-agents-monitoring.tail491af.ts.net:4318' } },
            null,
            2,
          ),
        );

        await update(dir, { all: false, cli: false, plugin: false, actions: false, yes: false, dryRun: false });

        const stderrOut = stderrSpy.mock.calls.flat().join('\n');
        expect(stderrOut).toMatch(/env\.MACF_OTEL_ENDPOINT/);
        expect(stderrOut).toMatch(/macf#342/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('--no-migrate-env-files skips migration + claude.sh refresh + env-file refresh as a unit', async () => {
      writeConfig(dir, { cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      mockFetchReturning({ cli: '0.2.0', plugin: '0.1.0', actions: 'v1' });
      // Pre-seed an operator-customized claude.sh
      const customLauncher =
        '#!/usr/bin/env bash\n# operator-custom monolithic launcher\nexec claude "$@"\n';
      writeFileSync(join(dir, 'claude.sh'), customLauncher, { mode: 0o755 });

      await update(dir, {
        all: false,
        cli: false,
        plugin: false,
        actions: false,
        yes: false,
        dryRun: false,
        noMigrateEnvFiles: true,
      });

      // claude.sh preserved (the three coupled steps all skipped as a
      // unit so the launcher doesn't end up thin without env files).
      expect(readFileSync(join(dir, 'claude.sh'), 'utf-8')).toBe(customLauncher);
      // No env files written under .claude/.macf/ either.
      expect(existsSync(join(dir, '.claude', '.macf', 'env.identity'))).toBe(false);
    });
  });
});
