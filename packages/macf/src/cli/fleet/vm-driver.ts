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
  ROLL_TOUCHED_CONFIG_PATTERNS,
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
  resolveCanonicalBranch,
  tokenSourceFromConfig,
  agentCertPath,
  agentKeyPath,
  type MacfAgentConfig,
} from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import { discoverWorkspaces } from '../discovery.js';
import { gatherFleetStatus, type FleetProbeFn } from '../commands/fleet.js';
import { classifyDirtyFile } from './canonical-compute.js';
import {
  acquireLock as acquireMaintenanceLock,
  releaseLock as releaseMaintenanceLock,
  resolveMaintenanceLockConfig,
  startHeartbeatLoop,
  type MaintenanceLockConfig,
} from './maintenance-lock.js';

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
  /**
   * The pre-flight config-dirty check (macf#722 Fix B) — `true` when
   * `workspaceDir` has uncommitted TRACKED changes on the roll's
   * touched-config surface (`ROLL_TOUCHED_CONFIG_PATTERNS`).
   * Real impl: `git status --porcelain -- <patterns>` in `workspaceDir`.
   */
  readonly isConfigDirty: (workspaceDir: string) => boolean;
  /**
   * The pre-flight config-dirty check's LIST form (macf#725) — the exact
   * uncommitted paths on the roll's touched-config surface, empty when clean.
   * Real impl: `git status --porcelain -- <patterns>` in `workspaceDir`, one
   * path per line (status-prefix stripped).
   */
  readonly listDirtyConfig: (workspaceDir: string) => readonly string[];
  /**
   * The canonical-branch guard's CURRENT-branch read (macf#755) — `git branch
   * --show-current` semantics: the branch name, or `null` on detached HEAD
   * (empty output) / any git failure. Real impl: `git branch --show-current`
   * in `workspaceDir`.
   */
  readonly currentBranch: (workspaceDir: string) => string | null;
  /**
   * Post-upgrade: list ALL currently-modified tracked files in `workspaceDir`
   * (macf#725) — used to report what `macf update` regenerated. NOT scoped to
   * the touched-config patterns (macf update can touch other managed files
   * too). Real impl: `git status --porcelain` (no pathspec), one path per
   * line. Best-effort — callers treat an inspection failure as an empty list.
   */
  readonly listModifiedFiles: (workspaceDir: string) => readonly string[];
  /**
   * Read a workspace's FULL agent config (DR-040 Decision 3 / macf#698 R1) —
   * the canonical-compute primitive needs it to regenerate `claude.sh` /
   * the managed env files / etc. Distinct from `readConfig` above (which only
   * surfaces `project` + `routingLabel` for session-name derivation). `null`
   * when the workspace has no `macf-agent.json` (or it's unreadable) —
   * callers fail-safe to `genuine-delta` in that case.
   */
  readonly readFullConfig: (workspaceDir: string) => MacfAgentConfig | null;
  /**
   * Commit exactly `files` in `workspaceDir` (DR-040 Decision 3 / macf#698
   * R1) — the auto-resolve half of the tier-first config-dirty gate. A no-op
   * when `files` is empty OR when `git add` stages nothing (e.g. the file
   * was already committed by the time this runs) — never throws on
   * "nothing to commit". Real impl: `git add -- <files>` then `git commit`
   * with a fixed, DR-040-referencing message, ONLY if `git diff --cached`
   * shows staged changes.
   */
  readonly commitCanonicalFiles: (workspaceDir: string, files: readonly string[]) => void;
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
  /**
   * Maintenance-lock config (DR-040 Decision 4, macf#752) — defaults to
   * env-resolved (`resolveMaintenanceLockConfig()`) so production honors the
   * SAME `MACF_MAINT_LOCK_*` env vars as `fleet/maintenance-lock.sh` (the
   * bash reference this driver's lock format interops with —
   * macf-devops-toolkit#158/#159). Overridable so tests point at an isolated
   * tmp dir without mutating `process.env`.
   */
  readonly maintenanceLock?: MaintenanceLockConfig;
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
  // DR-040 Decision 4 (macf#752) — resolved ONCE at driver-construction time.
  // The lock keys directly on the agent's ROUTING LABEL (no workspace
  // resolution needed, unlike upgrade/restart/inject) — matching the bash
  // contract's `$MAINT_LOCK_DIR/<agent>.lock` shape exactly.
  const lockConfig = opts.maintenanceLock ?? resolveMaintenanceLockConfig();

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

  async function isConfigDirty(agent: string): Promise<boolean> {
    const target = resolveTarget(seams, agent);
    // Unknown agent → nothing to check (mirrors isBusy's dead/unknown → false).
    if (!target) return false;
    return seams.isConfigDirty(target.workspace);
  }

  async function listDirtyConfig(agent: string): Promise<readonly string[]> {
    const target = resolveTarget(seams, agent);
    // Unknown agent → nothing to check (mirrors isConfigDirty's unknown → false).
    if (!target) return [];
    return seams.listDirtyConfig(target.workspace);
  }

  /**
   * The canonical-branch guard's CURRENT-branch read (macf#755). Unknown
   * agent → `null` (unresolvable is treated identically to detached HEAD by
   * the branch-gate — both are "never a safe mutate+relaunch target").
   */
  async function currentBranch(agent: string): Promise<string | null> {
    const target = resolveTarget(seams, agent);
    if (!target) return null;
    return seams.currentBranch(target.workspace);
  }

  /**
   * The canonical-branch guard's CANONICAL-branch resolution (macf#755) —
   * `resolveCanonicalBranch` against the agent's own `macf-agent.json` (env
   * override still applies even for an unresolvable agent / missing config;
   * only the per-workspace `canonicalBranch` field needs a readable config).
   */
  async function canonicalBranch(agent: string): Promise<string> {
    const target = resolveTarget(seams, agent);
    const config = target ? seams.readFullConfig(target.workspace) : null;
    return resolveCanonicalBranch(config, process.env);
  }

  /**
   * The tiered form (DR-040 Decision 3 / macf#698 R1): resolve the agent's
   * workspace + full config, reuse `listDirtyConfig`'s raw list, and classify
   * EACH path via the canonical-compute primitive (`classifyDirtyFile`).
   * Unknown agent / unresolvable config → everything classifies as
   * genuine-delta (fail-safe — never auto-resolve without a config to
   * compute canonical content against).
   */
  async function classifyDirtyConfig(
    agent: string,
  ): Promise<{ readonly alreadyCanonical: readonly string[]; readonly genuineDelta: readonly string[] }> {
    const target = resolveTarget(seams, agent);
    if (!target) return { alreadyCanonical: [], genuineDelta: [] };

    const dirty = seams.listDirtyConfig(target.workspace);
    if (dirty.length === 0) return { alreadyCanonical: [], genuineDelta: [] };

    const config = seams.readFullConfig(target.workspace);
    if (!config) {
      // No macf-agent.json (or unreadable) → can't compute canonical content
      // for anything → every dirty file fails safe to genuine-delta.
      return { alreadyCanonical: [], genuineDelta: dirty };
    }

    const alreadyCanonical: string[] = [];
    const genuineDelta: string[] = [];
    for (const file of dirty) {
      const tier = classifyDirtyFile(file, target.workspace, config);
      (tier === 'already-canonical' ? alreadyCanonical : genuineDelta).push(file);
    }
    return { alreadyCanonical, genuineDelta };
  }

  /**
   * Commit exactly `files` in the agent's workspace (DR-040 Decision 3 /
   * macf#698 R1). Unknown agent / empty `files` → no-op.
   */
  async function autoResolveCanonical(agent: string, files: readonly string[]): Promise<void> {
    if (files.length === 0) return;
    const target = resolveTarget(seams, agent);
    if (!target) return;
    seams.commitCanonicalFiles(target.workspace, files);
  }

  async function listModifiedFiles(agent: string): Promise<readonly string[]> {
    const target = resolveTarget(seams, agent);
    if (!target) return [];
    return seams.listModifiedFiles(target.workspace);
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

  async function restart(agent: string, restartOpts?: { readonly leaveConfigUncommitted?: boolean }): Promise<void> {
    const target = requireTarget(agent);
    if (target.session && seams.hasSession(target.session)) {
      // ALIVE → graceful: `macf restart-self` in the target workspace (stash +
      // detached relaunch; it resolves the target's own identity from cwd config).
      // `leaveConfigUncommitted` (macf#725) only reaches here when the CALLER
      // (rollFleet) is completing a transaction it already gated pre-flight —
      // thread it so restart-self relaunches WITHOUT stashing (and without
      // refusing on) macf update's own regeneration.
      const args = ['restart-self', '--confirm', '--reason', 'fault'];
      if (restartOpts?.leaveConfigUncommitted) args.push('--leave-config-uncommitted');
      seams.exec(macfBin, args, target.workspace);
      return;
    }
    // DEAD → cold-start (DR-037 Decision 3: restart = alive→graceful, dead→launch).
    await launch(agent);
  }

  async function inject(agent: string, text: string): Promise<void> {
    const { session } = requireSession(agent);
    seams.submit(session, text);
  }

  // --- DR-040 Decision 4 (macf#752) — maintenance-lock SET-side verbs ---
  // No workspace/session resolution needed: the lock keys directly on the
  // agent's routing label, matching the bash contract exactly. Real fs I/O
  // lives in `maintenance-lock.ts` (interop-verified against the bash
  // reference); this is just the driver-level glue.

  async function acquireLock(agent: string, targetVersion: string): Promise<void> {
    acquireMaintenanceLock(lockConfig.dir, agent, targetVersion);
  }

  async function releaseLock(agent: string): Promise<void> {
    releaseMaintenanceLock(lockConfig.dir, agent);
  }

  function startHeartbeat(agent: string): () => void {
    return startHeartbeatLoop(lockConfig.dir, agent, lockConfig.heartbeatIntervalSec, lockConfig.heartbeatMaxS);
  }

  return {
    probe,
    discoverWorkspaces: () => seams.discover(),
    isBusy,
    isConfigDirty,
    listDirtyConfig,
    currentBranch,
    canonicalBranch,
    classifyDirtyConfig,
    autoResolveCanonical,
    capturePane,
    upgrade,
    restart,
    inject,
    launch,
    listModifiedFiles,
    acquireLock,
    releaseLock,
    startHeartbeat,
  };
}

// --- Real-seam wiring (production) ---

/** Path to the canonical tmux-submit helper inside a driver workspace. */
function tmuxSubmitScript(workspaceDir: string): string {
  return join(workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
}

/**
 * Parse `git status --porcelain` lines into bare paths — strips the 2-char
 * status code + following space (` M path`, `M  path`, `?? path`, …). Shared
 * by `listDirtyConfig` + `listModifiedFiles` (macf#725).
 */
function parsePorcelainPaths(out: string): readonly string[] {
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0);
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
  | 'discover'
  | 'readConfig'
  | 'hasSession'
  | 'capturePane'
  | 'submit'
  | 'exec'
  | 'spawnDetached'
  | 'sleep'
  | 'isConfigDirty'
  | 'listDirtyConfig'
  | 'currentBranch'
  | 'listModifiedFiles'
  | 'readFullConfig'
  | 'commitCanonicalFiles'
> {
  return {
    discover: () => discoverWorkspaces(),
    isConfigDirty: (dir: string): boolean => {
      try {
        // Tracked-only (macf#722 Fix B): untracked config files are not yet an
        // operator-vs-macf-update conflict — mirrors restart-self's own
        // `--untracked-files=no` stash-trigger predicate. Pathspecs use git's
        // default fnmatch (no `:(glob)` magic needed — `**`/`*` already match
        // across path separators under the default pathspec semantics).
        const out = execFileSync(
          'git',
          [
            'status',
            '--porcelain',
            '--untracked-files=no',
            '--',
            ...ROLL_TOUCHED_CONFIG_PATTERNS,
          ],
          { cwd: dir, encoding: 'utf-8' },
        );
        return out.trim().length > 0;
      } catch {
        // Not a git repo / git unavailable / any other failure → fail-open
        // (never block a roll on an inspection failure; mirrors capturePane's
        // fail-to-null posture for infra-failure cases).
        return false;
      }
    },
    listDirtyConfig: (dir: string): readonly string[] => {
      try {
        // Same predicate as isConfigDirty (tracked-only, touched-config-surface
        // scoped) — returns the actual paths instead of a boolean (macf#725).
        const out = execFileSync(
          'git',
          [
            'status',
            '--porcelain',
            '--untracked-files=no',
            '--',
            ...ROLL_TOUCHED_CONFIG_PATTERNS,
          ],
          { cwd: dir, encoding: 'utf-8' },
        );
        return parsePorcelainPaths(out);
      } catch {
        // Fail-open (empty == clean), matching isConfigDirty's fail-open posture.
        return [];
      }
    },
    listModifiedFiles: (dir: string): readonly string[] => {
      try {
        // NOT scoped to the touched-config patterns — reports everything `macf
        // update` may have regenerated in the workspace (macf#725).
        const out = execFileSync(
          'git',
          ['status', '--porcelain', '--untracked-files=no'],
          { cwd: dir, encoding: 'utf-8' },
        );
        return parsePorcelainPaths(out);
      } catch {
        // Best-effort diagnostic read — never throw on it.
        return [];
      }
    },
    currentBranch: (dir: string): string | null => {
      try {
        // `git branch --show-current` prints the branch name, or an EMPTY
        // line on detached HEAD — normalize empty to `null` (macf#755: the
        // branch-gate treats detached HEAD as non-canonical).
        const out = execFileSync('git', ['branch', '--show-current'], {
          cwd: dir,
          encoding: 'utf-8',
        }).trim();
        return out.length > 0 ? out : null;
      } catch {
        // Not a git repo / git unavailable → null, same as detached HEAD —
        // never a safe mutate+relaunch target either way.
        return null;
      }
    },
    readConfig: (dir: string): WorkspaceIdentity | null => {
      const cfg = readAgentConfig(dir);
      if (!cfg) return null;
      return { project: cfg.project, routingLabel: cfg.routing_label ?? cfg.agent_name };
    },
    readFullConfig: (dir: string): MacfAgentConfig | null => readAgentConfig(dir),
    commitCanonicalFiles: (dir: string, files: readonly string[]): void => {
      if (files.length === 0) return;
      try {
        execFileSync('git', ['add', '--', ...files], { cwd: dir, stdio: 'ignore' });
        // Nothing staged (e.g. the file was already committed by the time
        // this runs) → `git diff --cached --quiet` exits 0 → no-op, never
        // attempt a commit with nothing to commit.
        execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dir });
        return;
      } catch {
        // `git diff --cached --quiet` exits 1 when there ARE staged changes
        // (the normal, expected case) — fall through to commit. Any OTHER
        // failure (git add itself failing, not a repo, etc.) also lands here;
        // the commit attempt below will itself fail-safe (best-effort,
        // never throws upward — see the outer try/catch).
      }
      try {
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            'chore(config): commit already-canonical macf-update regen (auto-resolved, DR-040 Decision 3 tier-first)',
          ],
          { cwd: dir, stdio: 'ignore' },
        );
      } catch {
        // Best-effort: never block the roll on a commit failure here — the
        // files stay dirty and the NEXT roll's pre-flight re-classifies them
        // (still already-canonical, tries again) rather than aborting this one.
      }
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
