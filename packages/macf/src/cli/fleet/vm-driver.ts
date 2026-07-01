/**
 * The VM (Linux/macOS) `FleetDriver` implementation (DR-037 Decision 3).
 *
 * Implements the runtime-agnostic `FleetDriver` contract with VM primitives —
 * the registry `/health` probe, the `.macf/`-marker workspace scan, tmux
 * `capture-pane` / `send-keys`, `macf update`, `macf restart-self`, and the
 * `./claude.sh` cold-start. **Nothing VM-specific leaks above the interface**
 * (that's the DR-037 hard rule — the macOS variant + K8s driver drop in later by
 * swapping the driver, never the decision layer).
 *
 * Every side effect flows through the injectable `VmDriverSeams` — tmux, exec,
 * spawn, the registry probe, discovery, and config reads — so the driver is
 * unit-testable WITHOUT real tmux / processes / network. Production wires the
 * real seams via `createVmDriverFromConfig`, which mirrors `fleet status`'s
 * registry + mTLS wiring (`resolveDepsFromRegistry`).
 *
 * The `agent` argument to every verb is the portable ROUTING LABEL. The driver
 * resolves it → workspace + `<project>@<routing-label>` tmux session internally
 * (via `discover()` + a per-workspace config read); that resolution is the
 * runtime-specific part the interface deliberately hides.
 */
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  FleetDriverError,
  createRegistryFromConfig,
  fromVariableSegment,
  generateToken,
  pingAgentHealth,
  toVariableSegment,
  type AgentInfo,
  type FleetAgentState,
  type FleetDriver,
  type FleetState,
  type HealthResponse,
  type WorkspaceRecord,
} from '@groundnuty/macf-core';
import {
  readAgentConfig,
  tokenSourceFromConfig,
  agentCertPath,
  agentKeyPath,
} from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import { discoverWorkspaces } from '../discovery.js';
import { gatherFleetStatus, type FleetProbeFn } from '../commands/fleet.js';

/** Default `capture-pane` content-diff window for the busy gate (ms). */
export const DEFAULT_BUSY_WINDOW_MS = 2000;

/** The identity a target workspace's config yields for session derivation. */
export interface WorkspaceIdentity {
  readonly project?: string;
  readonly routingLabel?: string;
}

/** A resolved target: its workspace dir + canonical tmux session (null if underivable). */
export interface ResolvedTarget {
  readonly workspace: string;
  readonly session: string | null;
}

/**
 * Every side effect the VM driver performs, injected so tests verify the
 * orchestration without real tmux / processes / network. Grouped by surface:
 * routing-probe, host-discovery, tmux, and exec/spawn.
 */
export interface VmDriverSeams {
  /** Registry roster (the routing plane) — `name` + advertised `host:port`. */
  readonly listPeers: () => Promise<readonly { readonly name: string; readonly info: AgentInfo }[]>;
  /** mTLS `/health` probe by endpoint; `null` on any failure. */
  readonly probeHealth: FleetProbeFn;
  /** The registry-free `.macf/`-marker workspace scan (alive ∪ dead). */
  readonly discover: () => readonly WorkspaceRecord[];
  /** Read a target workspace's identity (project + routing label) for session derivation. */
  readonly readConfig: (workspaceDir: string) => WorkspaceIdentity | null;
  /** `tmux has-session -t <session>` — true if the session is live. */
  readonly hasSession: (session: string) => boolean;
  /** `tmux capture-pane -t <session> -p` content, or `null` if unreadable. */
  readonly capturePane: (session: string) => string | null;
  /** Submit `text` into a session's Claude TUI via the canonical tmux-send-to-claude pattern. */
  readonly submit: (session: string, text: string) => void;
  /** Run `bin args` in `cwd`, blocking (throws on non-zero). */
  readonly exec: (bin: string, args: readonly string[], cwd: string) => void;
  /** Spawn `bin args` in `cwd`, DETACHED (outlives this process). */
  readonly spawnDetached: (bin: string, args: readonly string[], cwd: string) => void;
  /** Sleep `ms` (injected so tests don't wait on the busy window). */
  readonly sleep: (ms: number) => Promise<void>;
}

/** Construction options for `createVmDriver`. */
export interface VmDriverOptions {
  /**
   * The DRIVER's own workspace dir — used to locate the canonical
   * `tmux-send-to-claude.sh` helper for `inject`. `submit`'s real impl resolves
   * `<workspaceDir>/.claude/scripts/tmux-send-to-claude.sh`.
   */
  readonly workspaceDir: string;
  /** `capture-pane` content-diff window for the busy gate (default `DEFAULT_BUSY_WINDOW_MS`). */
  readonly busyWindowMs?: number;
  /** The `macf` binary name/path (default `'macf'`, resolved on PATH). */
  readonly macfBin?: string;
  /** The launcher basename spawned by `launch` (default `'claude.sh'`). */
  readonly launcher?: string;
}

/**
 * Map `gatherFleetStatus` rows into the portable `FleetState` (version pulled up).
 *
 * CRITICAL name-form normalization (macf#708): `gatherFleetStatus` sources its
 * `name` from `registry.list('')`, which returns the GitHub-Variables-canonical
 * registry-key SEGMENT (`CODE_AGENT`, `SCIENCE_AGENT` — uppercased, hyphens→`_`).
 * But the `FleetDriver` contract documents `FleetAgentState.name` as the **routing
 * label** (`code-agent`, `science-agent`), and every decision-layer consumer joins
 * on it that way: `planFleetUpgrade` keys `byName` on it, `fleet-reconcile` does
 * `state.agents.find(a => a.name === agent)`, and the CLI verify-green probe does
 * the same — all against a `WorkspaceRecord.agent` / `DesiredAgent.agent` which is
 * the kebab routing label. Passing the SCREAMING_SNAKE form straight through made
 * EVERY join miss, so `fleet upgrade`/`reconcile` false-negatived every alive agent
 * as `offline` even though `fleet status` (which never cross-matches) showed them
 * online. Normalize back to the routing-label form here (idempotent on already-kebab
 * input) so the driver HONORS its interface contract and the joins can't drift.
 */
function toFleetState(
  statuses: readonly { readonly name: string; readonly host: string; readonly port: number; readonly online: boolean; readonly health: HealthResponse | null }[],
): FleetState {
  const agents: FleetAgentState[] = statuses.map((s) => ({
    name: fromVariableSegment(s.name),
    host: s.host,
    port: s.port,
    online: s.online,
    version: s.health?.version ?? null,
    health: s.health,
  }));
  return { agents };
}

/**
 * Resolve `agent` → workspace + `<project>@<routing-label>` session using the
 * discovery scan + a per-workspace config read. Returns `null` when no discovered
 * workspace matches the routing label. The session is `null` when the workspace
 * config carries no `project` (can't derive the canonical name) — callers that
 * need the session treat that as a hard error.
 */
export function resolveTarget(seams: VmDriverSeams, agent: string): ResolvedTarget | null {
  const record = seams.discover().find((r) => r.agent === agent);
  if (!record) return null;
  const id = seams.readConfig(record.workspace);
  const project = id?.project;
  const routingLabel = id?.routingLabel ?? record.agent;
  const session = project ? `${project}@${routingLabel}` : null;
  return { workspace: record.workspace, session };
}

/**
 * Build a VM `FleetDriver` over injectable seams (unit-testable). Production
 * wiring is `createVmDriverFromConfig`.
 */
export function createVmDriver(opts: VmDriverOptions, seams: VmDriverSeams): FleetDriver {
  const busyWindowMs = opts.busyWindowMs ?? DEFAULT_BUSY_WINDOW_MS;
  const macfBin = opts.macfBin ?? 'macf';

  /** Resolve or throw a `FleetDriverError` naming the unresolvable agent. */
  function requireTarget(agent: string): ResolvedTarget {
    const t = resolveTarget(seams, agent);
    if (!t) {
      throw new FleetDriverError(
        `unknown agent '${agent}' — no discovered workspace on this host`,
      );
    }
    return t;
  }

  /** Resolve or throw when the tmux session cannot be derived (no project in config). */
  function requireSession(agent: string): { readonly target: ResolvedTarget; readonly session: string } {
    const target = requireTarget(agent);
    if (!target.session) {
      throw new FleetDriverError(
        `cannot derive the tmux session for '${agent}' — its workspace config has no project`,
      );
    }
    return { target, session: target.session };
  }

  async function probe(): Promise<FleetState> {
    const peers = await seams.listPeers();
    const statuses = await gatherFleetStatus(peers, seams.probeHealth);
    return toFleetState(statuses);
  }

  async function isBusy(agent: string): Promise<boolean> {
    const target = resolveTarget(seams, agent);
    // No workspace, no derivable session, or no live session → dead/absent → not busy.
    if (!target?.session || !seams.hasSession(target.session)) return false;

    const before = seams.capturePane(target.session);
    await seams.sleep(busyWindowMs);
    const after = seams.capturePane(target.session);
    // Unreadable pane on a LIVE session → cannot confirm idle → conservatively
    // BUSY (never restart an agent we can't inspect). Pattern-C content-diff:
    // a change over the window means the agent is producing output / echoing input.
    if (before === null || after === null) return true;
    return before !== after;
  }

  async function capturePane(agent: string): Promise<string | null> {
    const target = resolveTarget(seams, agent);
    // No workspace, no derivable session, or no live session → gone/unreadable →
    // null (the resume decision layer skips it — reconcile launches a dead agent).
    if (!target?.session || !seams.hasSession(target.session)) return null;
    return seams.capturePane(target.session);
  }

  async function upgrade(agent: string): Promise<void> {
    const target = requireTarget(agent);
    seams.exec(macfBin, ['update', '--yes'], target.workspace);
  }

  async function launch(agent: string): Promise<void> {
    const target = requireTarget(agent);
    const launcher = join(target.workspace, opts.launcher ?? 'claude.sh');
    seams.spawnDetached(launcher, [], target.workspace);
  }

  async function restart(agent: string): Promise<void> {
    const target = requireTarget(agent);
    if (target.session && seams.hasSession(target.session)) {
      // ALIVE → graceful: `macf restart-self` in the target workspace (stash +
      // detached relaunch; it resolves the target's own identity from cwd config).
      seams.exec(macfBin, ['restart-self', '--confirm', '--reason', 'fault'], target.workspace);
      return;
    }
    // DEAD → cold-start (DR-037 Decision 3: restart = alive→graceful, dead→launch).
    await launch(agent);
  }

  async function inject(agent: string, text: string): Promise<void> {
    const { session } = requireSession(agent);
    seams.submit(session, text);
  }

  return {
    probe,
    discoverWorkspaces: () => seams.discover(),
    isBusy,
    capturePane,
    upgrade,
    restart,
    inject,
    launch,
  };
}

// --- Real-seam wiring (production) ---

/** Path to the canonical tmux-submit helper inside a driver workspace. */
function tmuxSubmitScript(workspaceDir: string): string {
  return join(workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
}

/**
 * The real VM seams for tmux + exec + spawn, bound to the driver's workspace.
 * The registry-plane seams (`listPeers` / `probeHealth`) are supplied separately
 * by `createVmDriverFromConfig` (they need a minted token + CA cert).
 */
export function createVmExecSeams(
  workspaceDir: string,
): Pick<
  VmDriverSeams,
  'discover' | 'readConfig' | 'hasSession' | 'capturePane' | 'submit' | 'exec' | 'spawnDetached' | 'sleep'
> {
  return {
    discover: () => discoverWorkspaces(),
    readConfig: (dir: string): WorkspaceIdentity | null => {
      const cfg = readAgentConfig(dir);
      if (!cfg) return null;
      return { project: cfg.project, routingLabel: cfg.routing_label ?? cfg.agent_name };
    },
    hasSession: (session: string): boolean => {
      try {
        execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    capturePane: (session: string): string | null => {
      try {
        return execFileSync('tmux', ['capture-pane', '-t', session, '-p'], {
          encoding: 'utf-8',
        });
      } catch {
        return null;
      }
    },
    submit: (session: string, text: string): void => {
      // The ONLY sanctioned prompt-submit path (the C-u + double-Enter quirk).
      execFileSync(tmuxSubmitScript(workspaceDir), [session, text], { stdio: 'ignore' });
    },
    exec: (bin: string, args: readonly string[], cwd: string): void => {
      execFileSync(bin, args as string[], { cwd, stdio: 'inherit' });
    },
    spawnDetached: (bin: string, args: readonly string[], cwd: string): void => {
      const child = spawn(bin, args as string[], { cwd, detached: true, stdio: 'ignore' });
      child.unref();
    },
    sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Wire a production VM driver from a project's config — mints a token, reads the
 * CA cert, and builds the registry roster + mTLS `/health` probe (mirrors
 * `fleet status`'s `resolveDepsFromRegistry`), then binds the real tmux/exec
 * seams. Returns `null` (with a diagnostic on stderr) when the workspace isn't
 * initialised or the CA cert is missing.
 */
export async function createVmDriverFromConfig(
  projectDir: string,
  opts?: Partial<VmDriverOptions>,
): Promise<FleetDriver | null> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return null;
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caCertPem = await client.readVariable(`${toVariableSegment(config.project)}_CA_CERT`);
  if (!caCertPem) {
    console.error('CA certificate not found in registry. Run `macf certs init` first.');
    return null;
  }

  const certPath = agentCertPath(projectDir);
  const keyPath = agentKeyPath(projectDir);
  const probeHealth: FleetProbeFn = (host, port) =>
    pingAgentHealth({ host, port, caCertPem, certPath, keyPath });

  const seams: VmDriverSeams = {
    listPeers: () => registry.list(''),
    probeHealth,
    ...createVmExecSeams(projectDir),
  };
  return createVmDriver({ workspaceDir: projectDir, ...opts }, seams);
}
