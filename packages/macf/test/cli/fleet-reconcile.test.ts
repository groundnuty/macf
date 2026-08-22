/**
 * Tests for the `macf fleet reconcile` production wiring (DR-037 / macf#686) —
 * the pieces the runtime-agnostic engine (`@groundnuty/macf-core`
 * `reconcileFleet`, tested exhaustively in macf-core) does NOT cover: the
 * filesystem-backed state store, the manifest/desired resolution, and the
 * heartbeat seam. All against a real tmp dir (no network / no tmux).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetDriver, ReconcileResult, WorkspaceRecord } from '@groundnuty/macf-core';
import { resolveWorkspaceDir } from '../../src/cli/workspace-dir.js';
import {
  resolveStateDirs,
  resolveManifestPath,
  resolveDesired,
  createFsStateStore,
  createFileHeartbeat,
  defaultHeartbeatPath,
  listStateFiles,
  runFleetReconcileCommand,
  toJson,
} from '../../src/cli/commands/fleet-reconcile.js';

// macf#1123 — `createVmDriverFromConfig` is the seam `runFleetReconcileCommand`
// binds its resolved workspaceDir into. Mocking it leaves every OTHER test
// in this file (all against real tmp dirs / pure helpers, no vm-driver
// import) unaffected.
vi.mock('../../src/cli/fleet/vm-driver.js', () => ({
  createVmDriverFromConfig: vi.fn(),
}));
import { createVmDriverFromConfig } from '../../src/cli/fleet/vm-driver.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'macf-reconcile-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- path resolution --------------------------------------------------------

describe('resolveStateDirs', () => {
  it('defaults under $HOME/.macf', () => {
    const dirs = resolveStateDirs({}, { HOME: '/home/x' });
    expect(dirs.stateDir).toBe('/home/x/.macf/watchdog-state');
    expect(dirs.lastExitDir).toBe('/home/x/.macf/last-exit');
    expect(dirs.pausedDir).toBe('/home/x/.macf/paused');
  });
  it('CLI overrides win over env + default', () => {
    const dirs = resolveStateDirs(
      { stateDir: '/s', pausedDir: '/p' },
      { HOME: '/home/x', MACF_LAST_EXIT_DIR: '/le' },
    );
    expect(dirs.stateDir).toBe('/s');
    expect(dirs.lastExitDir).toBe('/le'); // env used when no CLI override
    expect(dirs.pausedDir).toBe('/p');
  });
});

describe('resolveManifestPath', () => {
  it('CLI > env > default', () => {
    expect(resolveManifestPath({ manifest: '/m.yaml' }, { HOME: '/h' })).toBe('/m.yaml');
    expect(resolveManifestPath({}, { HOME: '/h', MACF_DESIRED_AGENTS: '/e.yaml' })).toBe('/e.yaml');
    expect(resolveManifestPath({}, { HOME: '/h' })).toBe('/h/.macf/desired-agents.yaml');
  });
});

describe('defaultHeartbeatPath', () => {
  it('defaults under $HOME/.macf, env overrides', () => {
    expect(defaultHeartbeatPath({ HOME: '/h' })).toBe('/h/.macf/watchdog-heartbeat');
    expect(defaultHeartbeatPath({ HOME: '/h', MACF_WATCHDOG_HEARTBEAT: '/hb' })).toBe('/hb');
  });
});

// --- desired resolution -----------------------------------------------------

const WS: WorkspaceRecord[] = [
  { agent: 'devops-agent', workspace: '/w/devops', registry: 'groundnuty', project: 'macf', versionPin: '0.2.41' },
  { agent: 'code-agent', workspace: '/w/macf', registry: 'groundnuty', project: 'macf', versionPin: '0.2.41' },
];

function stubDriver(workspaces: readonly WorkspaceRecord[]): FleetDriver {
  return {
    probe: async () => ({ agents: [] }),
    discoverWorkspaces: () => workspaces,
    isBusy: async () => false,
    upgrade: async () => {},
    restart: async () => {},
    inject: async () => {},
    launch: async () => {},
  };
}

describe('resolveDesired', () => {
  it('parses the manifest when present', () => {
    const manifest = join(root, 'desired.yaml');
    writeFileSync(
      manifest,
      'agents:\n  - agent: devops-agent\n    workspace: /home/ubuntu/repos/groundnuty/macf-devops-toolkit\n',
    );
    const { desired, source } = resolveDesired(manifest, stubDriver(WS));
    expect(desired).toEqual([{ agent: 'devops-agent', workspace: '/home/ubuntu/repos/groundnuty/macf-devops-toolkit' }]);
    expect(source).toContain('manifest');
  });

  it('falls back to discovered workspaces when the manifest is absent', () => {
    const { desired, source } = resolveDesired(join(root, 'missing.yaml'), stubDriver(WS));
    expect(desired).toEqual([
      { agent: 'devops-agent', workspace: '/w/devops' },
      { agent: 'code-agent', workspace: '/w/macf' },
    ]);
    expect(source).toContain('discovered workspaces');
  });
});

// --- filesystem state store -------------------------------------------------

describe('createFsStateStore', () => {
  function dirs() {
    return {
      stateDir: join(root, 'state'),
      lastExitDir: join(root, 'last-exit'),
      pausedDir: join(root, 'paused'),
    };
  }

  it('reads the empty state for an unknown agent', () => {
    const store = createFsStateStore(dirs());
    expect(store.read('ghost')).toEqual({
      deafSweeps: 0,
      restartAttempts: 0,
      backoffUntil: 0,
      alertOpen: false,
      lastExit: null,
      paused: false,
    });
  });

  it('round-trips persisted escalation state (write → read)', () => {
    const store = createFsStateStore(dirs());
    store.write('devops-agent', {
      deafSweeps: 2,
      restartAttempts: 1,
      backoffUntil: 12345,
      alertOpen: true,
      lastExit: null,
      paused: false,
    });
    const back = store.read('devops-agent');
    expect(back.deafSweeps).toBe(2);
    expect(back.restartAttempts).toBe(1);
    expect(back.backoffUntil).toBe(12345);
    expect(back.alertOpen).toBe(true);
  });

  it('reads lastExit from the last-exit file', () => {
    const d = dirs();
    mkdirSync(d.lastExitDir, { recursive: true });
    writeFileSync(join(d.lastExitDir, 'code-agent'), '0\n');
    expect(createFsStateStore(d).read('code-agent').lastExit).toBe(0);
  });

  it('reads paused from the paused sentinel', () => {
    const d = dirs();
    mkdirSync(d.pausedDir, { recursive: true });
    writeFileSync(join(d.pausedDir, 'auditor-agent'), '');
    expect(createFsStateStore(d).read('auditor-agent').paused).toBe(true);
  });

  it('reset removes the persisted state file', () => {
    const d = dirs();
    const store = createFsStateStore(d);
    store.write('devops-agent', {
      deafSweeps: 3,
      restartAttempts: 0,
      backoffUntil: 0,
      alertOpen: false,
      lastExit: null,
      paused: false,
    });
    expect(listStateFiles(d.stateDir)).toContain('devops-agent.json');
    store.reset('devops-agent');
    expect(listStateFiles(d.stateDir)).not.toContain('devops-agent.json');
    expect(store.read('devops-agent').deafSweeps).toBe(0);
  });
});

// --- heartbeat --------------------------------------------------------------

describe('createFileHeartbeat', () => {
  it('writes an rc-bearing heartbeat line', async () => {
    const path = join(root, 'hb', 'watchdog-heartbeat');
    const hb = createFileHeartbeat(path, () => {});
    await hb({ rc: 1, at: 1_780_000_000_000, restartEnabled: true });
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('reconcile rc=1 restart=on');
  });
});

// --- --dir vs ambient MACF_WORKSPACE_DIR (macf#1123) ------------------------

describe('runFleetReconcileCommand — --dir vs ambient MACF_WORKSPACE_DIR (macf#1123)', () => {
  const ORIGINAL_ENV = process.env['MACF_WORKSPACE_DIR'];
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(createVmDriverFromConfig).mockReset();
    vi.mocked(createVmDriverFromConfig).mockResolvedValue(null); // short-circuits before resolveDesired/etc.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    if (ORIGINAL_ENV === undefined) delete process.env['MACF_WORKSPACE_DIR'];
    else process.env['MACF_WORKSPACE_DIR'] = ORIGINAL_ENV;
  });

  // Decisive per assert-the-wrong-path.md: asserted by the ARGUMENT the
  // driver-binding seam actually received (rc==2 either way — the mock
  // resolves to null regardless of which workspace was targeted).
  it('THE REGRESSION: --dir <B> with MACF_WORKSPACE_DIR=<A> set binds the driver to B, not A', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    const rc = await runFleetReconcileCommand('/target-b', { execute: false, dirExplicit: true });
    expect(rc).toBe(2);
    expect(vi.mocked(createVmDriverFromConfig).mock.calls[0]?.[0]).toBe('/target-b');
  });

  it('the --dir vs env disagreement is REPORTED, not swallowed', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    await runFleetReconcileCommand('/target-b', { execute: false, dirExplicit: true });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('/caller-a'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('/target-b'));
  });

  it('no --dir: the ambient MACF_WORKSPACE_DIR default still applies (ordinary in-session case unbroken)', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    await runFleetReconcileCommand('/auto-discovered', { execute: false });
    expect(vi.mocked(createVmDriverFromConfig).mock.calls[0]?.[0]).toBe('/caller-a');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('no --dir, no env: falls back to the auto-discovered projectDir', async () => {
    delete process.env['MACF_WORKSPACE_DIR'];
    await runFleetReconcileCommand('/auto-discovered', { execute: false });
    expect(vi.mocked(createVmDriverFromConfig).mock.calls[0]?.[0]).toBe('/auto-discovered');
  });
});

// --- --json exposes the conflict, not just stderr (macf#1123) ---------------

describe('toJson — --json watchdog-contract carries workspace_dir / identity_source / workspace_dir_conflict (macf#1123)', () => {
  const RESULT: ReconcileResult = { rc: 0, rows: [] };

  it('a --dir/env conflict is visible to a --json consumer, not just stderr', () => {
    const resolved = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/caller-a' } as NodeJS.ProcessEnv);
    const parsed = JSON.parse(toJson(RESULT, 'discovered workspaces (no manifest)', false, resolved)) as Record<string, unknown>;
    expect(parsed['workspace_dir']).toBe('/target-b');
    expect(parsed['identity_source']).toBe('dir-flag');
    expect(parsed['workspace_dir_conflict']).toBe('/caller-a');
  });

  it('the ordinary no-conflict case reports workspace_dir_conflict: null (not omitted, not undefined)', () => {
    const resolved = resolveWorkspaceDir('/proj', false, {} as NodeJS.ProcessEnv);
    const parsed = JSON.parse(toJson(RESULT, 'discovered workspaces (no manifest)', false, resolved)) as Record<string, unknown>;
    expect(parsed['workspace_dir']).toBe('/proj');
    expect(parsed['identity_source']).toBe('cwd-discovery');
    expect(parsed['workspace_dir_conflict']).toBeNull();
  });

  it('schema_version is unchanged (additive fields, same precedent as restart-self macf#888/#893)', () => {
    const resolved = resolveWorkspaceDir('/proj', false, {} as NodeJS.ProcessEnv);
    const parsed = JSON.parse(toJson(RESULT, 'discovered workspaces (no manifest)', false, resolved)) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(1);
  });
});
