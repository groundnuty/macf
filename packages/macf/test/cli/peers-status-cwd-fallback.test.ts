/**
 * #959: `macf peers` / `macf status`, invoked WITHOUT `--dir`, must never
 * report "No agents configured" when `.macf/macf-agent.json` exists at (or
 * above) cwd, and an API failure encountered along the way must never
 * masquerade as a configuration verdict or a silently-empty result.
 *
 * Confirmed root cause: both commands drove the "no --dir" branch purely
 * off the global `~/.macf/agents.json` index (populated only by `macf
 * init`) — never consulting cwd at all. A workspace whose config exists
 * locally but never made it into that index read as `agents.length === 0`
 * before any network call ran, so the misreport happened independent of
 * GitHub API health. `loadAllAgentsWithCwdFallback` (config.ts) fixes this
 * by also walking up from cwd; these tests exercise it through the real
 * command entrypoints.
 *
 * These tests temporarily replace the REAL `~/.macf/agents.json` (backed
 * up + restored in afterEach) so the index side is fully controlled — this
 * sandbox is a live, shared MACF workspace whose real index already
 * carries entries from unrelated activity, and `loadAllAgents()` has no
 * injectable seam for it (see the note in config.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { listPeers } from '../../src/cli/commands/peers.js';
import { showStatus } from '../../src/cli/commands/status.js';
import { agentConfigPath, AGENTS_INDEX_PATH, writeAgentsIndex } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-cwd-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const SECRET_SENTINEL = 'ghs_should_never_leak_into_any_message_sentinel';

describe('macf peers / macf status without --dir (#959)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let hadIndex: boolean;
  let originalIndexBytes: string | null;

  beforeEach(() => {
    dir = tempDir();
    process.env['GH_TOKEN'] = SECRET_SENTINEL;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    hadIndex = existsSync(AGENTS_INDEX_PATH);
    originalIndexBytes = hadIndex ? readFileSync(AGENTS_INDEX_PATH, 'utf-8') : null;
    writeAgentsIndex({ agents: [] });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    logSpy.mockRestore();
    errorSpy.mockRestore();

    if (hadIndex && originalIndexBytes !== null) {
      writeFileSync(AGENTS_INDEX_PATH, originalIndexBytes);
    } else if (existsSync(AGENTS_INDEX_PATH)) {
      unlinkSync(AGENTS_INDEX_PATH);
    }
  });

  function loggedText(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0])).join('\n');
  }

  describe('listPeers()', () => {
    it('config genuinely absent (and index empty) -> the `macf init` message, unchanged', async () => {
      process.chdir(dir); // dir has no .macf/ — genuinely unconfigured

      await listPeers();

      expect(loggedText()).toContain('No agents configured. Run `macf init` first.');
    });

    it('config discovered via cwd fallback + API healthy -> normal listing, never "not configured"', async () => {
      writeConfig(dir);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 0, variables: [] }),
        text: async () => '{}',
      }) as unknown as typeof fetch;
      process.chdir(dir);

      await listPeers();

      const logged = loggedText();
      expect(logged).toContain('No peers registered in the registry.');
      expect(logged).not.toMatch(/No agents configured/i);
    });

    it('DECISIVE: config discovered via cwd + API 503 -> API-failure message naming the status, never "not configured"', async () => {
      writeConfig(dir);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'No server is currently available to handle this request.' }),
      }) as unknown as typeof fetch;
      process.chdir(dir);

      await expect(listPeers()).rejects.toThrow(/GitHub API 503/);
      expect(loggedText()).not.toMatch(/No agents configured/i);
    });

    it('network-level failure (no HTTP response) -> attributed message naming the operation, never a bare "fetch failed"', async () => {
      writeConfig(dir);
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
      process.chdir(dir);

      let caught: unknown;
      try {
        await listPeers();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toMatch(/list variables/);
      // The raw undici message is preserved as context, but never BARE —
      // it must always be paired with the operation + "unreachable".
      expect(message).not.toBe('fetch failed');
    });

    it('never leaks GH_TOKEN into a thrown error or a logged message', async () => {
      writeConfig(dir);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      }) as unknown as typeof fetch;
      process.chdir(dir);

      let caught: unknown;
      try {
        await listPeers();
      } catch (err) {
        caught = err;
      }

      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain(SECRET_SENTINEL);
      expect(loggedText()).not.toContain(SECRET_SENTINEL);
    });
  });

  describe('showStatus()', () => {
    it('config genuinely absent (and index empty) -> the `macf init` message, unchanged', async () => {
      process.chdir(dir);

      await showStatus();

      expect(loggedText()).toContain('No agents configured. Run `macf init` first.');
    });

    it('DECISIVE: config discovered via cwd + API 503 -> API-failure message naming the status, never "not configured"', async () => {
      writeConfig(dir);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'No server is currently available to handle this request.' }),
      }) as unknown as typeof fetch;
      process.chdir(dir);

      await expect(showStatus()).rejects.toThrow(/GitHub API 503/);
      expect(loggedText()).not.toMatch(/No agents configured/i);
    });
  });
});
