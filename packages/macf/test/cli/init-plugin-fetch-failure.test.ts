/**
 * Tests for the DR-044 Decision 6 fix (groundnuty/macf#1419): a failed
 * plugin fetch during `macf init` must be a REPORTED failure — non-zero
 * exit for the CLI, a named sub-failure for `fleet deploy` — never a
 * silent `console.warn` + a clean `exit 0`.
 *
 * Deliberately does NOT touch the real network (unlike much of
 * `init.test.ts`, which hits the real `groundnuty/macf-marketplace` clone
 * on purpose) — `fetchPluginToWorkspace` is injected via `vi.mock` so both
 * halves of the decisive pair (fetch fails / fetch succeeds) are
 * deterministic regardless of the runner's network reachability. See the
 * commit history on this fix for the concrete cost of NOT doing this: the
 * first version threw on failure, and running the real, network-hitting
 * `init.test.ts` in a sandbox where anonymous git-over-HTTPS to GitHub 401s
 * (exactly `#1419`'s own root cause) turned 56/56 passing into 30 failing —
 * the throw destroyed the same informative outcome the fix exists to
 * preserve. This file's mocks make that irrelevant here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('../../src/cli/plugin-fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/plugin-fetcher.js')>();
  return {
    ...actual,
    fetchPluginToWorkspace: vi.fn(),
    // Real manifest never gets fetched under the mock above, so a real
    // stripPluginMcpServers call would just see an absent file and no-op —
    // fine to leave real. linkPluginCliDist resolves the running CLI's own
    // dist/ via import.meta.url (not built in the test runner); stub it so
    // it doesn't throw.
    linkPluginCliDist: vi.fn(() => false),
  };
});

import { initAgent } from '../../src/cli/commands/init.js';
import { readAgentConfig, agentCertPath } from '../../src/cli/config.js';
import { fetchPluginToWorkspace } from '../../src/cli/plugin-fetcher.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-plugin-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tempRegistryPath(): string {
  const dir = join(tmpdir(), `macf-init-plugin-fail-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return join(dir, 'project.json');
}

/** --local avoids network/App-cred setup entirely (auto-generates its own CA) — the plugin fetch is the ONLY thing under test here. */
const BASE_OPTS = {
  project: 'TEST',
  role: 'code-agent',
  registryType: 'local',
  cliVersion: '0.2.0',
  pluginVersion: '0.1.0',
  actionsVersion: 'v1',
} as const;

describe('macf init — plugin fetch failure is reported, not swallowed (groundnuty/macf#1419)', () => {
  let workspaceDir: string;
  let registryPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspaceDir = tempDir();
    registryPath = tempRegistryPath();
    vi.mocked(fetchPluginToWorkspace).mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(join(registryPath, '..'), { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('DECISIVE (failure half): fetch fails — result reports it, the tag + error are named, the pin is still recorded as intent, and the rest of the workspace still materializes', async () => {
    vi.mocked(fetchPluginToWorkspace).mockImplementation(() => {
      throw new Error('Failed to fetch plugin from https://github.com/groundnuty/macf-marketplace at v0.1.0: HTTP 401');
    });

    const result = await initAgent(workspaceDir, { ...BASE_OPTS, registryPath });

    // The result names the failure — never a silent void.
    expect(result.pluginFetchFailure).toBeDefined();
    expect(result.pluginFetchFailure!.tag).toBe('v0.1.0');
    expect(result.pluginFetchFailure!.detail).toContain('HTTP 401');

    // Interpretation A (see this fix's commit history + report): the
    // recorded pin stays the TARGET/intended version, not "unset" or the
    // observed (nonexistent) install — `macf update`'s repair-fetch needs
    // this value as its OWN fetch target, and the alternative (recording
    // the failure as the pin itself) would defeat that repair path.
    const config = readAgentConfig(workspaceDir);
    expect(config?.versions?.plugin).toBe('0.1.0');

    // The failure is named in the console output too — a human watching
    // the run sees it, not just a script reading the return value.
    const allOut = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(allOut).toContain('WITHOUT its plugin');
    expect(allOut).toContain('v0.1.0');
    expect(allOut).toContain('HTTP 401');
    expect(allOut.toLowerCase()).toContain('macf update');

    // The rest of the workspace materialized fully — a plugin failure must
    // not degrade into a WORSE, half-initialized workspace (this is WHY
    // the fix reports rather than throws).
    expect(existsSync(join(workspaceDir, '.macf', 'macf-agent.json'))).toBe(true);
    expect(existsSync(agentCertPath(workspaceDir))).toBe(true);
    expect(existsSync(join(workspaceDir, 'claude.sh'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.mcp.json'))).toBe(true);

    // Exactly one fetch attempt, with the pinned version — a call-count +
    // call-args assertion (assert-the-wrong-path.md), not merely "it
    // didn't throw".
    expect(fetchPluginToWorkspace).toHaveBeenCalledTimes(1);
    expect(fetchPluginToWorkspace).toHaveBeenCalledWith(workspaceDir, '0.1.0');
  });

  it('DECISIVE (success half): fetch succeeds — result reports no failure, and output is unchanged from the pre-#1419 shape', async () => {
    vi.mocked(fetchPluginToWorkspace).mockImplementation(() => {
      // A real fetch would populate .macf/plugin/ — mock it as a no-op
      // write-nothing success (linkPluginCliDist/stripPluginMcpServers
      // downstream calls tolerate an absent manifest as a no-op).
    });

    const result = await initAgent(workspaceDir, { ...BASE_OPTS, registryPath });

    expect(result.pluginFetchFailure).toBeUndefined();

    const config = readAgentConfig(workspaceDir);
    expect(config?.versions?.plugin).toBe('0.1.0');

    const allOut = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(allOut).not.toContain('WITHOUT its plugin');
    expect(allOut).not.toContain('fetch failed');

    expect(existsSync(join(workspaceDir, '.macf', 'macf-agent.json'))).toBe(true);
    expect(existsSync(agentCertPath(workspaceDir))).toBe(true);

    expect(fetchPluginToWorkspace).toHaveBeenCalledTimes(1);
    expect(fetchPluginToWorkspace).toHaveBeenCalledWith(workspaceDir, '0.1.0');
  });

  it('a non-Error throw (e.g. a plain string) is still coerced to a readable detail, never "[object Object]"', async () => {
    vi.mocked(fetchPluginToWorkspace).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately exercising the String(err) fallback path
      throw 'ENOTFOUND github.com';
    });

    const result = await initAgent(workspaceDir, { ...BASE_OPTS, registryPath });

    expect(result.pluginFetchFailure?.detail).toBe('ENOTFOUND github.com');
  });
});
