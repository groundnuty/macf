/**
 * Tests for the `macf fleet reconcile` production wiring (DR-037 / macf#686) —
 * the pieces the runtime-agnostic engine (`@groundnuty/macf-core`
 * `reconcileFleet`, tested exhaustively in macf-core) does NOT cover: the
 * filesystem-backed state store, the manifest/desired resolution, and the
 * heartbeat seam. All against a real tmp dir (no network / no tmux).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetDriver, WorkspaceRecord } from '@groundnuty/macf-core';
import {
  resolveStateDirs,
  resolveManifestPath,
  resolveDesired,
  createFsStateStore,
  createFileHeartbeat,
  defaultHeartbeatPath,
  listStateFiles,
} from '../../src/cli/commands/fleet-reconcile.js';

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
  { agent: 'devops-agent', workspace: '/w/devops', registry: 'groundnuty', versionPin: '0.2.41' },
  { agent: 'code-agent', workspace: '/w/macf', registry: 'groundnuty', versionPin: '0.2.41' },
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
