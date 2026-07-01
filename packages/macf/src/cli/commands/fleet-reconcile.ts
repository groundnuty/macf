/**
 * `macf fleet reconcile` — the DR-006 desired-state reconciler, promoted to the
 * CLI (DR-037 / macf#686), porting the devops reference `fleet/reconcile.sh`.
 *
 * This file is the THIN production wiring around the runtime-agnostic decision
 * engine (`reconcileFleet` in `@groundnuty/macf-core`): it resolves the DESIRED
 * set (a `desired-agents.yaml` manifest if present, else the host's discovered
 * workspaces), builds the VM `FleetDriver` (`createVmDriverFromConfig`), binds a
 * filesystem-backed cross-sweep state store + a `gh issue create` Tier-3 alert +
 * a file self-heartbeat, then runs one sweep. The ladder / gates / backoff /
 * stagger all live in the engine — nothing runtime-specific here beyond the seam
 * bodies. DRY-RUN BY DEFAULT (`--execute` acts).
 *
 * The cron consumer is `macf fleet install-cron` (DR-037: `watchdog` is the cron
 * consumer of `fleet reconcile`, not a separate noun).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  reconcileFleet,
  resolveReconcileConfig,
  parseDesiredAgents,
  EMPTY_RECONCILE_STATE,
  type DesiredAgent,
  type FleetDriver,
  type ReconcileAgentState,
  type ReconcileDeps,
  type ReconcileHeartbeat,
  type ReconcileResult,
  type ReconcileStateStore,
} from '@groundnuty/macf-core';
import { createVmDriverFromConfig } from '../fleet/vm-driver.js';

/** `--json` watchdog-contract schema version (mirrors fleet doctor / restart-self). */
export const FLEET_RECONCILE_JSON_SCHEMA_VERSION = 1;

/** The state directories, defaulting under `$HOME/.macf` (reference-parity, overridable). */
export interface ReconcileStateDirs {
  /** Cross-sweep escalation/backoff/alert state (`<agent>.json`). */
  readonly stateDir: string;
  /** Per-agent last-exit-code files (written by the launch wrapper; read here). */
  readonly lastExitDir: string;
  /** Explicit operator `paused` sentinels (existence = desired-down). */
  readonly pausedDir: string;
}

/** Resolve the state dirs from CLI overrides + env + the `$HOME/.macf` defaults. */
export function resolveStateDirs(
  opts: FleetReconcileCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): ReconcileStateDirs {
  const home = env['HOME'] ?? '~';
  const base = join(home, '.macf');
  return {
    stateDir: opts.stateDir ?? env['MACF_WATCHDOG_STATE'] ?? join(base, 'watchdog-state'),
    lastExitDir: opts.lastExitDir ?? env['MACF_LAST_EXIT_DIR'] ?? join(base, 'last-exit'),
    pausedDir: opts.pausedDir ?? env['MACF_PAUSED_DIR'] ?? join(base, 'paused'),
  };
}

/** Resolve the desired-agents manifest path (CLI > env > `$HOME/.macf/desired-agents.yaml`). */
export function resolveManifestPath(
  opts: FleetReconcileCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env['HOME'] ?? '~';
  return opts.manifest ?? env['MACF_DESIRED_AGENTS'] ?? join(home, '.macf', 'desired-agents.yaml');
}

/**
 * The DESIRED set: parse the manifest if it exists (operator-owned truth), else
 * FALL BACK to the host's discovered workspaces (DR-037 Decision 4 — a fresh box
 * with no manifest still reconciles its discovered agents). Unlike the reference
 * (which FATALs on a missing manifest), the fallback keeps the reconciler usable
 * before an operator writes the manifest.
 */
export function resolveDesired(
  manifestPath: string,
  driver: FleetDriver,
): { readonly desired: readonly DesiredAgent[]; readonly source: string } {
  if (existsSync(manifestPath)) {
    const desired = parseDesiredAgents(readFileSync(manifestPath, 'utf-8'));
    return { desired, source: `manifest ${manifestPath}` };
  }
  const desired = driver
    .discoverWorkspaces()
    .map((w) => ({ agent: w.agent, workspace: w.workspace }));
  return { desired, source: 'discovered workspaces (no manifest)' };
}

// --- filesystem state store -------------------------------------------------

/** Only the cross-sweep-mutable fields are persisted; lastExit/paused are read-only inputs. */
interface PersistedState {
  readonly deafSweeps: number;
  readonly restartAttempts: number;
  readonly backoffUntil: number;
  readonly alertOpen: boolean;
}

/** Parse a persisted state JSON (defensive — a corrupt/partial file degrades to zeros). */
function readPersisted(path: string): PersistedState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PersistedState>;
    return {
      deafSweeps: Number(raw.deafSweeps ?? 0),
      restartAttempts: Number(raw.restartAttempts ?? 0),
      backoffUntil: Number(raw.backoffUntil ?? 0),
      alertOpen: Boolean(raw.alertOpen ?? false),
    };
  } catch {
    return { deafSweeps: 0, restartAttempts: 0, backoffUntil: 0, alertOpen: false };
  }
}

/** Read an integer from a text file, or `null` when absent/unparseable. */
function readIntFile(path: string): number | null {
  try {
    const n = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * A filesystem-backed `ReconcileStateStore`: mutable escalation state as
 * `<stateDir>/<agent>.json`, `lastExit` from `<lastExitDir>/<agent>` (written by
 * the launch wrapper, out of band), `paused` from the `<pausedDir>/<agent>`
 * sentinel. Writes/resets are trusted to be execute-gated by the engine.
 */
export function createFsStateStore(dirs: ReconcileStateDirs): ReconcileStateStore {
  const statePath = (agent: string): string => join(dirs.stateDir, `${sanitize(agent)}.json`);
  return {
    read: (agent: string): ReconcileAgentState => {
      const persisted = existsSync(statePath(agent))
        ? readPersisted(statePath(agent))
        : { deafSweeps: 0, restartAttempts: 0, backoffUntil: 0, alertOpen: false };
      return {
        ...EMPTY_RECONCILE_STATE,
        ...persisted,
        lastExit: readIntFile(join(dirs.lastExitDir, sanitize(agent))),
        paused: existsSync(join(dirs.pausedDir, sanitize(agent))),
      };
    },
    write: (agent: string, state: ReconcileAgentState): void => {
      mkdirSync(dirs.stateDir, { recursive: true });
      const persisted: PersistedState = {
        deafSweeps: state.deafSweeps,
        restartAttempts: state.restartAttempts,
        backoffUntil: state.backoffUntil,
        alertOpen: state.alertOpen,
      };
      writeFileSync(statePath(agent), JSON.stringify(persisted));
    },
    reset: (agent: string): void => {
      rmSync(statePath(agent), { force: true });
    },
  };
}

/** Keep an agent label filesystem-safe (routing labels are kebab, but be defensive). */
function sanitize(agent: string): string {
  return agent.replace(/[^A-Za-z0-9._-]/g, '_');
}

// --- seams (alert + heartbeat) ----------------------------------------------

/** The default watchdog self-heartbeat file. */
export function defaultHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? '~';
  return env['MACF_WATCHDOG_HEARTBEAT'] ?? join(home, '.macf', 'watchdog-heartbeat');
}

/**
 * The Tier-3 alert seam (DR-037: a `gh issue create`, DECISION-LAYER — not a
 * driver method). Best-effort: the issue is filed in the runner workspace's repo
 * (gh infers it from the git remote), and any failure only WARNs — an alert
 * hiccup must never fail the sweep. Dedup is the engine's `alertOpen` sentinel.
 */
export function createGhAlert(workspaceDir: string, warn: (msg: string) => void): ReconcileDeps['alert'] {
  return async (agent: string, reason: string): Promise<void> => {
    try {
      execFileSync(
        'gh',
        [
          'issue',
          'create',
          '--title',
          `[fleet-watchdog] ${agent} needs attention`,
          '--body',
          `The fleet watchdog (macf fleet reconcile) escalated \`${agent}\` to Tier-3.\n\nReason: ${reason}\n\n(Auto-filed; dedup'd per failure episode.)`,
        ],
        { cwd: workspaceDir, stdio: 'ignore' },
      );
    } catch (err) {
      warn(`fleet reconcile: Tier-3 alert for ${agent} could not be filed (gh issue create): ${(err as Error).message}`);
    }
  };
}

/** The self-heartbeat seam — stamp that THIS sweep ran (the who-watches-the-watchdog signal). */
export function createFileHeartbeat(path: string, warn: (msg: string) => void): ReconcileDeps['heartbeat'] {
  return async (info: ReconcileHeartbeat): Promise<void> => {
    try {
      const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      if (dir) mkdirSync(dir, { recursive: true });
      const iso = new Date(info.at).toISOString();
      writeFileSync(path, `${iso} reconcile rc=${info.rc} restart=${info.restartEnabled ? 'on' : 'off'}\n`);
    } catch (err) {
      warn(`fleet reconcile: heartbeat write failed: ${(err as Error).message}`);
    }
  };
}

// --- CLI surface ------------------------------------------------------------

export interface FleetReconcileCliOptions {
  readonly execute?: boolean;
  readonly allowRestart?: boolean;
  /**
   * Accepted for cron/install-cron compatibility. The routing-doctor
   * registration-freshness second probe reads fields not exposed by
   * `FleetDriver.probe()`, so it is RESERVED (no-op) in this driver-agnostic
   * port — mesh reachability is the reconcile signal. See the file header.
   */
  readonly withRouting?: boolean;
  readonly manifest?: string;
  readonly stateDir?: string;
  readonly lastExitDir?: string;
  readonly pausedDir?: string;
  readonly heartbeatFile?: string;
  readonly json?: boolean;
  readonly dir?: string;
}

/** Render the `--json` watchdog-contract object. */
function toJson(result: ReconcileResult, source: string, execute: boolean): string {
  return JSON.stringify(
    {
      schema_version: FLEET_RECONCILE_JSON_SCHEMA_VERSION,
      mode: execute ? 'execute' : 'dry-run',
      desired_source: source,
      rc: result.rc,
      agents: result.rows,
    },
    null,
    2,
  );
}

/**
 * `macf fleet reconcile` entry point — wire the real driver + fs store + seams,
 * resolve the desired set, run one sweep. Returns the shell exit code (0 no
 * action / 1 action taken-or-needed / 2 precondition or probe failure).
 */
export async function runFleetReconcileCommand(
  projectDir: string,
  cliOpts: FleetReconcileCliOptions,
): Promise<number> {
  const workspaceDir = process.env['MACF_WORKSPACE_DIR']?.trim() || projectDir;
  const driver = await createVmDriverFromConfig(workspaceDir);
  if (!driver) return 2; // createVmDriverFromConfig already logged the reason

  const manifestPath = resolveManifestPath(cliOpts);
  const { desired, source } = resolveDesired(manifestPath, driver);
  if (desired.length === 0) {
    console.error(
      `fleet reconcile: no desired agents (${source}). Write ${manifestPath} or run \`macf init\` in the agent workspaces.`,
    );
    return 2;
  }

  const config = resolveReconcileConfig({
    execute: cliOpts.execute === true,
    allowRestart: cliOpts.allowRestart === true,
  });
  const dirs = resolveStateDirs(cliOpts);
  const heartbeatPath = cliOpts.heartbeatFile ?? defaultHeartbeatPath();
  const warn = (msg: string): void => console.error(msg);

  const deps: ReconcileDeps = {
    driver,
    store: createFsStateStore(dirs),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    alert: createGhAlert(workspaceDir, warn),
    heartbeat: createFileHeartbeat(heartbeatPath, warn),
    log: (line) => {
      if (!cliOpts.json) console.log(line);
    },
  };

  if (!cliOpts.json) console.log(`reconcile desired from: ${source}\n`);
  const result = await reconcileFleet(desired, deps, config);
  if (cliOpts.json) console.log(toJson(result, source, config.execute));
  return result.rc;
}

/** Test seam — list persisted state files (used to assert cross-sweep persistence). */
export function listStateFiles(stateDir: string): readonly string[] {
  try {
    return readdirSync(stateDir);
  } catch {
    return [];
  }
}
