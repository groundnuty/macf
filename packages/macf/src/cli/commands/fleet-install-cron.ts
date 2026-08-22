/**
 * `macf fleet install-cron` — DR-037 subcommand: install the watchdog cron.
 *
 * Ports `groundnuty/macf-devops-toolkit:fleet/install-cron.sh` (DR-006 §A.4) as a
 * native-TypeScript `macf` subcommand (DR-037 Decision 6 — reimplement, don't
 * wrap). It installs a HOST crontab entry that periodically runs the watchdog —
 * i.e. `macf fleet reconcile` (DR-037: `watchdog` is the cron consumer of
 * `fleet reconcile`, not a separate noun).
 *
 * Why host-installed (DR-006 §A.4): the user crontab survives a VM reboot, so the
 * first post-boot sweep launches the whole desired fleet from a cold box — the
 * reconciler IS the reboot-recovery + one-command launch-all. claude.sh-on-launch
 * can't install it (on cold-boot nothing launches to install it).
 *
 * The generated cron line, in order:
 *   1. sources the host-prelude IF present (cron's bare env lacks the toolchain —
 *      the CLI / tmux / gh; DR-029/#599 host-prelude generator, DR-031 bootstrap);
 *   2. mints a FRESH `GH_TOKEN` fail-loud (cron has no ambient token; the watchdog's
 *      `fleet doctor` reads `MACF_CA_CERT` from the registry → needs auth; a failed
 *      mint aborts the sweep rather than running blind into a 401). The `$(...)` is
 *      a literal in the crontab so cron evaluates it at RUN time (fresh each sweep);
 *      the App creds are resolved NOW (fixed) from `settings.local.json`;
 *   3. runs `macf fleet reconcile`, appending stdout+stderr to the log.
 *
 * SAFE DEFAULT: report-only (dry-run) — the installed line runs `macf fleet
 * reconcile` WITHOUT `--execute`, so it logs decisions and acts on nothing. The
 * operator watches the log for a few cycles, then re-runs with `--execute` to act.
 *
 * IDEMPOTENT: the line carries a stable marker comment; a re-run strips the
 * existing macf-watchdog line and re-adds — never duplicates. `--uninstall`
 * removes only that line, preserving the rest of the crontab.
 *
 * ALL side effects (crontab read/write, settings read, confirm prompt) flow
 * through `FleetInstallCronDeps` so the orchestrator is unit-testable with fakes
 * (no real crontab mutation). Production wires the real deps via `createRealDeps`.
 *
 * Refs: DR-037 (fleet operational-layer as canonical CLI), macf#686,
 *       macf-devops-toolkit DR-006 §A.4.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MacfError } from '@groundnuty/macf-core';
import { resolveWorkspaceDir, formatWorkspaceDirConflictWarning } from '../workspace-dir.js';

/** Raised on a genuine crontab-write failure (fail-loud, never silent). */
export class FleetInstallCronError extends MacfError {
  constructor(message: string) {
    super('FLEET_INSTALL_CRON_ERROR', message);
    this.name = 'FleetInstallCronError';
  }
}

/** The stable marker that guards idempotency — a re-run strips lines carrying it. */
export const WATCHDOG_MARKER = '# macf-watchdog (DR-006)';

/** Coarse default cadence (DR-006 §A.4 heartbeat cadence). */
export const DEFAULT_SCHEDULE = '*/10 * * * *';

/** The command string the cron invokes (DR-037: the cron consumer of reconcile). */
export const RECONCILE_INVOCATION = 'macf fleet reconcile';

/** Default host-prelude path, relative to the workspace (DR-029/#599 generator). */
const HOST_PRELUDE_REL = join('.claude', '.macf', 'host-prelude.sh');

/** Default watchdog log path, relative to `$HOME` (host-global; DR-006 §A.4). */
const WATCHDOG_LOG_REL = join('.macf', 'watchdog.log');

/** The token-mint helper, relative to the workspace (macf#161 canonical helper). */
const TOKEN_HELPER_REL = join('.claude', 'scripts', 'macf-gh-token.sh');

/** GitHub App creds read from `settings.local.json`'s `env` block for the token bake. */
export interface AppCreds {
  readonly appId?: string;
  readonly installId?: string;
  readonly keyPath?: string;
}

/**
 * Every side effect the orchestrator performs, injected so tests verify the
 * install/uninstall flow WITHOUT touching the real crontab.
 */
export interface FleetInstallCronDeps {
  /** `crontab -l` — current crontab content, or null when there is none. */
  readonly readCrontab: () => string | null;
  /** `crontab -` — replace the crontab with `content`. Throws on failure. */
  readonly writeCrontab: (content: string) => void;
  /** True iff the `crontab` binary is on PATH. */
  readonly crontabAvailable: () => boolean;
  /** App creds from `<workspace>/.claude/settings.local.json` `.env`, or null. */
  readonly readAppCreds: () => AppCreds | null;
  /** True iff the token-mint helper exists + is executable at `path`. */
  readonly helperExists: (path: string) => boolean;
  /** Interactive y/N confirm (default No). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Info line to stdout. */
  readonly log: (msg: string) => void;
  /** Warning line to stderr. */
  readonly warn: (msg: string) => void;
}

/** Already-resolved orchestrator input (env/config resolution done upstream). */
export interface RunFleetInstallCronOptions {
  /** Absolute workspace dir (holds `claude.sh`, `.claude/scripts`, `settings.local.json`). */
  readonly workspaceDir: string;
  /** Cron schedule expression. */
  readonly schedule: string;
  /** When false (default) the cron runs reconcile report-only (no `--execute`). */
  readonly execute: boolean;
  /** Forward `--allow-restart` to reconcile (enables Tier-2 graceful-restart). */
  readonly allowRestart: boolean;
  /** Forward `--with-routing` to reconcile (routing-doctor freshness probe). */
  readonly withRouting: boolean;
  /** Forward `--manifest <path>` to reconcile (desired-set manifest). */
  readonly manifest?: string;
  /** Skip baking the GH_TOKEN mint (operator supplies it another way). */
  readonly noToken: boolean;
  /** Remove the macf-watchdog line instead of installing. */
  readonly uninstall: boolean;
  /** Print the line that WOULD be installed and exit — never touches crontab. */
  readonly print: boolean;
  /** Skip the confirm prompt (non-interactive). */
  readonly yes: boolean;
  /** Override the host-prelude path (default `<workspace>/.claude/.macf/host-prelude.sh`). */
  readonly prelude?: string;
  /** Override the watchdog log path (default `$HOME/.macf/watchdog.log`). */
  readonly log?: string;
}

// --- Pure builders (the unit-test core) ---

/**
 * Build the reconcile flag list forwarded into the cron's `macf fleet reconcile`
 * invocation. Order mirrors the reference: manifest → routing → execute → restart.
 * Report-only is the ABSENCE of `--execute` (reconcile's dry-run default).
 */
export function buildReconcileFlags(opts: {
  readonly manifest?: string;
  readonly withRouting: boolean;
  readonly execute: boolean;
  readonly allowRestart: boolean;
}): readonly string[] {
  const flags: string[] = [];
  if (opts.manifest) flags.push('--manifest', opts.manifest);
  if (opts.withRouting) flags.push('--with-routing');
  if (opts.execute) flags.push('--execute');
  if (opts.allowRestart) flags.push('--allow-restart');
  return flags;
}

/**
 * Compute the fail-loud token-mint prefix baked into the cron line, resolving the
 * App creds NOW. Returns an empty prefix (with a loud warning) when the helper or
 * creds are missing — so a missing-cred install degrades to "no token baked"
 * rather than a broken cron line. `--no-token` skips unconditionally.
 *
 * The prefix keeps `$(...)` LITERAL so cron mints a fresh token at RUN time; the
 * `|| exit 1` aborts the sweep on a mint failure (fail-loud, never run blind).
 */
export function buildTokenPrefix(args: {
  readonly noToken: boolean;
  readonly workspaceDir: string;
  readonly creds: AppCreds | null;
  readonly helperExists: (path: string) => boolean;
}): { readonly prefix: string; readonly warning?: string } {
  if (args.noToken) return { prefix: '' };

  const helper = join(args.workspaceDir, TOKEN_HELPER_REL);
  const settings = join(args.workspaceDir, '.claude', 'settings.local.json');
  if (!args.helperExists(helper)) {
    return {
      prefix: '',
      warning:
        `token helper missing (${helper}) — no token baked (fleet-doctor may 401). ` +
        `Pass --no-token to silence.`,
    };
  }

  const appId = args.creds?.appId?.trim();
  const installId = args.creds?.installId?.trim();
  const rawKey = args.creds?.keyPath?.trim();
  if (!appId || !installId || !rawKey) {
    return {
      prefix: '',
      warning:
        `APP_ID/INSTALL_ID/KEY_PATH not all readable from ${settings} — no token ` +
        `baked (fleet-doctor may 401). Pass --no-token to silence.`,
    };
  }

  // Absolutize a relative key path against the workspace (matches claude.sh).
  const keyPath = rawKey.startsWith('/') ? rawKey : join(args.workspaceDir, rawKey);
  const prefix =
    `GH_TOKEN=$(${helper} --app-id ${appId} --install-id ${installId} ` +
    `--key ${keyPath}) || exit 1; export GH_TOKEN; `;
  return { prefix };
}

/** All resolved pieces of a cron line (pure input to `buildCronLine`). */
export interface CronLineParts {
  readonly schedule: string;
  readonly preludePath: string;
  readonly tokenPrefix: string;
  readonly reconcileFlags: readonly string[];
  readonly logPath: string;
  readonly marker: string;
}

/**
 * Assemble the full crontab line:
 *   `<schedule> [ -f <prelude> ] && . <prelude>; <token>macf fleet reconcile <flags> >> <log> 2>&1 <marker>`
 */
export function buildCronLine(parts: CronLineParts): string {
  const prelude = `[ -f ${parts.preludePath} ] && . ${parts.preludePath}; `;
  const flags = parts.reconcileFlags.length > 0 ? ` ${parts.reconcileFlags.join(' ')}` : '';
  const cmd =
    `${prelude}${parts.tokenPrefix}${RECONCILE_INVOCATION}${flags} ` +
    `>> ${parts.logPath} 2>&1`;
  return `${parts.schedule} ${cmd} ${parts.marker}`;
}

/** Split a crontab into lines, dropping the marker line(s) and any blank lines. */
export function stripMarkerLines(existing: string, marker: string): readonly string[] {
  return existing
    .split('\n')
    .filter((line) => !line.includes(marker) && line.trim() !== '');
}

/** The crontab after installing `newLine` (idempotent: strips any prior marker line). */
export function computeInstalledCrontab(
  existing: string,
  newLine: string,
  marker: string,
): string {
  const kept = stripMarkerLines(existing, marker);
  return [...kept, newLine].join('\n') + '\n';
}

/** The crontab after removing the marker line(s); '' when nothing else remains. */
export function computeUninstalledCrontab(existing: string, marker: string): string {
  const kept = stripMarkerLines(existing, marker);
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}

// --- Orchestrator (pure control flow over injected deps) ---

/**
 * Install (or uninstall) the macf-watchdog cron line. Returns the shell exit code.
 * Report-only by DEFAULT (the installed line omits `--execute`). Idempotent.
 */
export async function runFleetInstallCron(
  opts: RunFleetInstallCronOptions,
  deps: FleetInstallCronDeps,
): Promise<number> {
  if (!deps.crontabAvailable()) {
    deps.warn('macf fleet install-cron: `crontab` not found on PATH. Cannot manage cron.');
    return 2;
  }

  const existing = deps.readCrontab() ?? '';

  // --- Uninstall path ---
  if (opts.uninstall) {
    const hadLine = existing.split('\n').some((l) => l.includes(WATCHDOG_MARKER));
    const next = computeUninstalledCrontab(existing, WATCHDOG_MARKER);
    if (!hadLine) {
      deps.log('No macf-watchdog cron line found — nothing to remove.');
      return 0;
    }
    if (opts.print) {
      deps.log('Would remove the macf-watchdog cron line; resulting crontab:');
      deps.log(next.length > 0 ? next.trimEnd() : '(empty)');
      return 0;
    }
    if (!opts.yes && !(await deps.confirm('Remove the macf-watchdog cron line?'))) {
      deps.log('Aborted — crontab unchanged.');
      return 0;
    }
    deps.writeCrontab(next);
    deps.log('Removed macf-watchdog cron line.');
    return 0;
  }

  // --- Install path ---
  const preludePath = opts.prelude ?? join(opts.workspaceDir, HOST_PRELUDE_REL);
  const logPath = opts.log ?? join(homedirOf(deps, opts), WATCHDOG_LOG_REL);

  const token = buildTokenPrefix({
    noToken: opts.noToken,
    workspaceDir: opts.workspaceDir,
    creds: deps.readAppCreds(),
    helperExists: deps.helperExists,
  });
  if (token.warning) deps.warn(`WARN: ${token.warning}`);

  const reconcileFlags = buildReconcileFlags({
    manifest: opts.manifest,
    withRouting: opts.withRouting,
    execute: opts.execute,
    allowRestart: opts.allowRestart,
  });

  const line = buildCronLine({
    schedule: opts.schedule,
    preludePath,
    tokenPrefix: token.prefix,
    reconcileFlags,
    logPath,
    marker: WATCHDOG_MARKER,
  });

  const mode = describeMode(opts);

  if (opts.print) {
    deps.log(line);
    return 0;
  }

  deps.log(`Planned macf-watchdog cron line [${mode}]:`);
  deps.log(`  ${line}`);
  if (!opts.yes && !(await deps.confirm('Install this cron line?'))) {
    deps.log('Aborted — crontab unchanged.');
    return 0;
  }

  const next = computeInstalledCrontab(existing, line, WATCHDOG_MARKER);
  deps.writeCrontab(next);
  deps.log(
    `Installed macf-watchdog cron [${mode}], schedule '${opts.schedule}', log ${logPath}.`,
  );
  deps.log('Verify: crontab -l | grep macf-watchdog');
  return 0;
}

/** Human-readable install mode for the confirmation/summary lines. */
function describeMode(opts: RunFleetInstallCronOptions): string {
  if (!opts.execute) return 'REPORT-ONLY (dry-run)';
  return opts.allowRestart ? 'EXECUTE + restart' : 'EXECUTE';
}

/** `$HOME` for the default log path; deps-free (env only), overridable via --log. */
function homedirOf(_deps: FleetInstallCronDeps, _opts: RunFleetInstallCronOptions): string {
  return process.env['HOME'] ?? '~';
}

// --- Real-deps factory (production wiring) ---

/** Real side effects bound to a workspace dir. */
export function createRealDeps(workspaceDir: string): FleetInstallCronDeps {
  return {
    readCrontab: () => {
      try {
        return execFileSync('crontab', ['-l'], { encoding: 'utf-8' });
      } catch {
        // Non-zero when there is no crontab for the user — treat as empty.
        return null;
      }
    },
    writeCrontab: (content: string) => {
      try {
        execFileSync('crontab', ['-'], { input: content, encoding: 'utf-8' });
      } catch (err) {
        throw new FleetInstallCronError(
          `failed to write crontab: ${(err as Error).message}`,
        );
      }
    },
    crontabAvailable: () => {
      try {
        execFileSync('command', ['-v', 'crontab'], { shell: '/bin/sh', stdio: 'ignore' });
        return true;
      } catch {
        // Fallback: `command` builtin isn't a real binary on all systems; probe crontab directly.
        try {
          execFileSync('crontab', ['-l'], { stdio: 'ignore' });
          return true;
        } catch (err) {
          // Exit 1 (no crontab) still proves the binary exists; ENOENT means it doesn't.
          return (err as NodeJS.ErrnoException).code !== 'ENOENT';
        }
      }
    },
    readAppCreds: () => readAppCredsFromSettings(workspaceDir),
    helperExists: (path: string) => {
      try {
        accessSync(path, fsConstants.X_OK);
        return true;
      } catch {
        return existsSync(path);
      }
    },
    confirm: (question: string) => promptYesNo(question),
    log: (msg: string) => console.log(msg),
    warn: (msg: string) => console.error(msg),
  };
}

/** Read `.env.{APP_ID,INSTALL_ID,KEY_PATH}` from the workspace's settings.local.json. */
export function readAppCredsFromSettings(workspaceDir: string): AppCreds | null {
  const path = join(workspaceDir, '.claude', 'settings.local.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { env?: Record<string, unknown> };
    const env = raw.env ?? {};
    return {
      appId: typeof env['APP_ID'] === 'string' ? env['APP_ID'] : undefined,
      installId: typeof env['INSTALL_ID'] === 'string' ? env['INSTALL_ID'] : undefined,
      keyPath: typeof env['KEY_PATH'] === 'string' ? env['KEY_PATH'] : undefined,
    };
  } catch {
    return null;
  }
}

/** Prompt the operator for a y/N confirmation on stdin. Default = No. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// --- Command entry point (env/config resolution + real deps) ---

/** CLI-surface options (commander-parsed). */
export interface FleetInstallCronCliOptions {
  readonly schedule?: string;
  readonly execute?: boolean;
  readonly allowRestart?: boolean;
  readonly withRouting?: boolean;
  readonly manifest?: string;
  /** commander maps `--no-token` to `token: false`; we invert to `noToken`. */
  readonly token?: boolean;
  readonly uninstall?: boolean;
  readonly print?: boolean;
  readonly yes?: boolean;
  readonly prelude?: string;
  readonly log?: string;
  /**
   * True iff the caller passed `--dir` on argv (macf#1123, threading
   * `restart-self`'s macf#888 `dirExplicit` pattern via the shared
   * `isDirExplicit`/`resolveWorkspaceDir` in `../workspace-dir.js`). Without
   * this, an explicit `--dir <other-workspace>` silently loses to the
   * caller's own ambient `MACF_WORKSPACE_DIR` below.
   */
  readonly dirExplicit?: boolean;
}

/** `macf fleet install-cron` entry point — resolves the workspace, wires real deps. */
export async function runFleetInstallCronCommand(
  projectDir: string,
  cliOpts: FleetInstallCronCliOptions,
): Promise<number> {
  const resolved = resolveWorkspaceDir(projectDir, cliOpts.dirExplicit === true);
  const conflictWarning = formatWorkspaceDirConflictWarning('fleet install-cron', resolved);
  if (conflictWarning) console.error(conflictWarning);
  const workspaceDir = resolved.workspaceDir;

  const deps = createRealDeps(workspaceDir);
  return runFleetInstallCron(
    {
      workspaceDir,
      schedule: cliOpts.schedule?.trim() || DEFAULT_SCHEDULE,
      execute: Boolean(cliOpts.execute),
      allowRestart: Boolean(cliOpts.allowRestart),
      withRouting: Boolean(cliOpts.withRouting),
      manifest: cliOpts.manifest?.trim() || undefined,
      noToken: cliOpts.token === false,
      uninstall: Boolean(cliOpts.uninstall),
      print: Boolean(cliOpts.print),
      yes: Boolean(cliOpts.yes),
      prelude: cliOpts.prelude?.trim() || undefined,
      log: cliOpts.log?.trim() || undefined,
    },
    deps,
  );
}
