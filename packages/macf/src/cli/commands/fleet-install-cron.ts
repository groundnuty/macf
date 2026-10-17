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
 * The crontab line only runs a per-fleet script, `~/.macf/cron/<owner>__<project>.sh`
 * (Ubuntu's cron caps a command at 1000 characters, so the PATH and the paths below
 * cannot live on the line):
 *   <schedule> /bin/sh '<script>' >> '<log>' 2>&1 <marker>
 * The script holds, in order:
 *   0. sets PATH to the installing shell's PATH (cron's PATH is /usr/bin:/bin, which
 *      finds neither `node` for the `macf` shebang nor `claude` in the tmux session
 *      reconcile launches);
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
import {
  existsSync,
  readFileSync,
  accessSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { MacfError } from '@groundnuty/macf-core';
import { PACKAGE_VERSION } from '../../package-version.js';
import { readAgentConfig, ownerAccountFromRegistry, tokenSourceFromConfig } from '../config.js';
import { shellQuote } from '../fleet/launch-command.js';
import { resolveWorkspaceDir, formatWorkspaceDirConflictWarning } from '../workspace-dir.js';

/** Raised on a genuine crontab-write failure (fail-loud, never silent). */
export class FleetInstallCronError extends MacfError {
  constructor(message: string) {
    super('FLEET_INSTALL_CRON_ERROR', message);
    this.name = 'FleetInstallCronError';
  }
}

/**
 * The bare marker older installs wrote (one global string, shared with other
 * tools' watchdog lines). Kept only to recognise legacy lines; new lines carry
 * `watchdogMarker(owner, project)`.
 */
export const WATCHDOG_MARKER = '# macf-watchdog (DR-006)';

/**
 * This fleet's marker, `# macf-watchdog (DR-006) [fleet=<owner>/<project>]`. Two
 * owners can run a fleet of the same project name on one host, so it names both.
 * The brackets stop one name matching inside a longer one; lines are matched by
 * ENDING with it.
 */
export function watchdogMarker(owner: string, project: string): string {
  return `${WATCHDOG_MARKER} [fleet=${owner}/${project}]`;
}

/** Coarse default cadence (DR-006 §A.4 heartbeat cadence). */
export const DEFAULT_SCHEDULE = '*/10 * * * *';

/**
 * The subcommand the cron invokes (DR-037: the cron consumer of reconcile). It
 * runs after the absolute `macf` path, because cron's PATH does not include npm's
 * global bin.
 */
export const RECONCILE_ARGS = 'fleet reconcile';

/** Default host-prelude path, relative to the workspace (DR-029/#599 generator). */
const HOST_PRELUDE_REL = join('.claude', '.macf', 'host-prelude.sh');

/** Per-fleet scripts live here, relative to `$HOME`. */
const CRON_SCRIPT_DIR_REL = join('.macf', 'cron');

/** Refuse a crontab line longer than this; Vixie cron caps a command at 1000. */
export const MAX_CRON_LINE = 900;

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
  /** App creds from `macf-agent.json` `github_app`, else `settings.local.json` `.env`, or null. */
  readonly readAppCreds: () => AppCreds | null;
  /** The installing shell's PATH, baked into the line; null or empty when unset. */
  readonly installPath: () => string | null;
  /** Absolute path of the first `macf` on the installing shell's PATH, or null. */
  readonly resolveMacf: () => string | null;
  /** `<path> --version` of that binary (semver part), or null when it cannot be read. */
  readonly macfVersion: (path: string) => string | null;
  /** True iff the token-mint helper exists + is executable at `path`. */
  readonly helperExists: (path: string) => boolean;
  /** Interactive y/N confirm (default No). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Directory holding the per-fleet scripts (default `$HOME/.macf/cron`). */
  readonly scriptDir: () => string;
  /** Write `content` to `path` atomically, mode 0700, creating its dir 0700. Throws on failure. */
  readonly writeScript: (path: string, content: string) => void;
  /** The script's current content, or null when there is none. */
  readonly readScript: (path: string) => string | null;
  /** Delete the script at `path`; true iff it existed. */
  readonly removeScript: (path: string) => boolean;
  /** Info line to stdout. */
  readonly log: (msg: string) => void;
  /** Warning line to stderr. */
  readonly warn: (msg: string) => void;
}

/** Already-resolved orchestrator input (env/config resolution done upstream). */
export interface RunFleetInstallCronOptions {
  /** The workspace's `macf-agent.json` `project`; scopes the crontab marker. */
  readonly project: string;
  /** The GitHub owner of the fleet's registry; scopes the crontab marker. */
  readonly owner: string;
  /** The running CLI's version; the `macf` baked into the line must match it. */
  readonly cliVersion: string;
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
 * invocation. Order: `--dir` → manifest → routing → execute → restart. `--dir` is
 * always first: reconcile resolves its project from the cwd and cron runs in $HOME.
 * Paths are emitted as quoted shell words. Report-only is the ABSENCE of
 * `--execute` (reconcile's dry-run default).
 */
export function buildReconcileFlags(opts: {
  readonly workspaceDir: string;
  readonly manifest?: string;
  readonly withRouting: boolean;
  readonly execute: boolean;
  readonly allowRestart: boolean;
}): readonly string[] {
  const flags: string[] = ['--dir', shellQuote(opts.workspaceDir)];
  if (opts.manifest) flags.push('--manifest', shellQuote(opts.manifest));
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
  const agentJson = join(args.workspaceDir, '.macf', 'macf-agent.json');
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
        `APP_ID/INSTALL_ID/KEY_PATH not all readable from ${agentJson} or ${settings} — no token ` +
        `baked (fleet-doctor may 401). Pass --no-token to silence.`,
    };
  }

  // Absolutize a relative key path against the workspace (matches claude.sh).
  const keyPath = rawKey.startsWith('/') ? rawKey : join(args.workspaceDir, rawKey);
  const prefix =
    `GH_TOKEN=$(${shellQuote(helper)} --app-id ${appId} --install-id ${installId} ` +
    `--key ${shellQuote(keyPath)}) || exit 1; export GH_TOKEN; `;
  return { prefix };
}

/** All resolved pieces of a cron line (pure input to `buildCronLine`). */
export interface CronLineParts {
  readonly schedule: string;
  /** Absolute path of the per-fleet script the line runs. */
  readonly scriptPath: string;
  readonly logPath: string;
  readonly marker: string;
}

/** Everything the per-fleet script holds (pure input to `buildCronScript`). */
export interface CronScriptParts {
  /** Absolute path of the `macf` binary the script runs. */
  readonly macfPath: string;
  /** The installing shell's PATH, set at the start of the script. */
  readonly installPath: string;
  readonly preludePath: string;
  readonly tokenPrefix: string;
  readonly reconcileFlags: readonly string[];
  readonly marker: string;
}

/**
 * The crontab line:
 *   `<schedule> /bin/sh '<script>' >> '<log>' 2>&1 <marker>`
 * Every path is a quoted shell word.
 */
export function buildCronLine(parts: CronLineParts): string {
  const cmd = `/bin/sh ${shellQuote(parts.scriptPath)} >> ${shellQuote(parts.logPath)} 2>&1`;
  return `${parts.schedule} ${cmd} ${parts.marker}`;
}

/** The per-fleet script: PATH, prelude, token mint, then exec the reconcile. */
export function buildCronScript(parts: CronScriptParts): string {
  const prelude = shellQuote(parts.preludePath);
  const flags = parts.reconcileFlags.length > 0 ? ` ${parts.reconcileFlags.join(' ')}` : '';
  return [
    '#!/bin/sh',
    `${parts.marker} — generated by \`macf fleet install-cron\`; re-run it to change this file.`,
    `PATH=${shellQuote(parts.installPath)}; export PATH`,
    `[ -f ${prelude} ] && . ${prelude}`,
    // The token prefix ends in `; ` and is empty with --no-token.
    ...(parts.tokenPrefix.trim() ? [parts.tokenPrefix.trim()] : []),
    `exec ${shellQuote(parts.macfPath)} ${RECONCILE_ARGS}${flags}`,
    '',
  ].join('\n');
}

/**
 * This fleet's script path under `dir`: `<owner>__<project>.sh`. Owners and fleet
 * names never contain `_`, so the name is unambiguous once `cronNameProblem` passes.
 */
export function cronScriptPath(dir: string, owner: string, project: string): string {
  return join(dir, `${owner}__${project}.sh`);
}

/** Refusal text when the owner or project cannot name a script file, else null. */
export function cronNameProblem(owner: string, project: string): string | null {
  const bad = ([['owner', owner], ['project', project]] as const).find(
    ([, v]) => !/^[A-Za-z0-9.-]+$/.test(v),
  );
  return bad
    ? `macf fleet install-cron: cannot name this fleet's cron script: ${bad[0]} "${bad[1]}" ` +
        'contains characters other than letters, digits, "." and "-".'
    : null;
}

/**
 * True iff `line` holds one of this workspace's own paths as a complete argument:
 * the token helper, or the default host-prelude (a `--no-token` line has only that).
 */
function namesWorkspaceHelper(line: string, workspaceDir: string): boolean {
  return [TOKEN_HELPER_REL, HOST_PRELUDE_REL].some((rel) => {
    const path = join(workspaceDir, rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s'"]|\\$\\()${path}(?=[\\s'";\\]]|$)`).test(line);
  });
}

/** A line is this fleet's if it ends with its marker, or is a legacy line naming its workspace. */
function isOwnedLine(line: string, marker: string, workspaceDir: string): boolean {
  const t = line.trimEnd();
  if (t.endsWith(marker)) return true;
  return t.endsWith(WATCHDOG_MARKER) && namesWorkspaceHelper(line, workspaceDir);
}

/** Legacy bare-marker lines that do NOT belong to this workspace (left untouched). */
export function foreignLegacyLines(existing: string, workspaceDir: string): readonly string[] {
  return existing
    .split('\n')
    .filter((l) => l.trimEnd().endsWith(WATCHDOG_MARKER) && !namesWorkspaceHelper(l, workspaceDir));
}

/** Split a crontab into lines, dropping THIS fleet's line(s) and any blank lines. */
export function stripMarkerLines(
  existing: string,
  marker: string,
  workspaceDir: string,
): readonly string[] {
  return existing
    .split('\n')
    .filter((line) => !isOwnedLine(line, marker, workspaceDir) && line.trim() !== '');
}

/** The crontab after installing `newLine` (idempotent: strips this fleet's prior line). */
export function computeInstalledCrontab(
  existing: string,
  newLine: string,
  marker: string,
  workspaceDir: string,
): string {
  const kept = stripMarkerLines(existing, marker, workspaceDir);
  return [...kept, newLine].join('\n') + '\n';
}

/** The crontab after removing this fleet's line(s); '' when nothing else remains. */
export function computeUninstalledCrontab(
  existing: string,
  marker: string,
  workspaceDir: string,
): string {
  const kept = stripMarkerLines(existing, marker, workspaceDir);
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}

/** One notice naming a legacy line we left alone (cut to ~100 chars). */
function noticeForeignLegacy(
  existing: string,
  workspaceDir: string,
  warn: (msg: string) => void,
): void {
  const foreign = foreignLegacyLines(existing, workspaceDir);
  if (foreign.length === 0) return;
  const first = foreign[0]!.trim();
  const shown = first.length > 100 ? `${first.slice(0, 100)}…` : first;
  const more = foreign.length > 1 ? ` (+${foreign.length - 1} more)` : '';
  warn(
    `NOTE: left a crontab line in place because it does not belong to this fleet${more}: ${shown}`,
  );
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

  const nameProblem = cronNameProblem(opts.owner, opts.project);
  if (nameProblem) {
    deps.warn(nameProblem);
    return 2;
  }

  const existing = deps.readCrontab() ?? '';
  const marker = watchdogMarker(opts.owner, opts.project);
  noticeForeignLegacy(existing, opts.workspaceDir, deps.warn);

  // --- Uninstall path ---
  if (opts.uninstall) {
    const hadLine = existing
      .split('\n')
      .some((l) => isOwnedLine(l, marker, opts.workspaceDir));
    const next = computeUninstalledCrontab(existing, marker, opts.workspaceDir);
    const scriptPath = cronScriptPath(deps.scriptDir(), opts.owner, opts.project);
    if (!hadLine) {
      const removed = !opts.print && deps.removeScript(scriptPath);
      deps.log(
        removed
          ? `No macf-watchdog cron line found; removed ${scriptPath}.`
          : 'No macf-watchdog cron line found — nothing to remove.',
      );
      return 0;
    }
    if (opts.print) {
      deps.log(`Would remove the macf-watchdog cron line and ${scriptPath}; resulting crontab:`);
      deps.log(next.length > 0 ? next.trimEnd() : '(empty)');
      return 0;
    }
    if (!opts.yes && !(await deps.confirm('Remove the macf-watchdog cron line?'))) {
      deps.log('Aborted — crontab unchanged.');
      return 0;
    }
    deps.writeCrontab(next);
    deps.removeScript(scriptPath);
    deps.log('Removed macf-watchdog cron line and script.');
    return 0;
  }

  // --- Install path ---
  const preludePath = opts.prelude ?? join(opts.workspaceDir, HOST_PRELUDE_REL);
  const logPath = opts.log ?? join(homedirOf(deps, opts), WATCHDOG_LOG_REL);

  const macf = checkMacfBinary(opts.cliVersion, deps);
  if (!macf.ok) {
    deps.warn(`macf fleet install-cron: ${macf.message}`);
    return 2;
  }

  const installPath = deps.installPath()?.trim();
  if (!installPath) {
    deps.warn(
      'macf fleet install-cron: PATH is empty here. The cron line sets the installing ' +
        "shell's PATH; run this from a shell with PATH set.",
    );
    return 2;
  }

  const token = buildTokenPrefix({
    noToken: opts.noToken,
    workspaceDir: opts.workspaceDir,
    creds: deps.readAppCreds(),
    helperExists: deps.helperExists,
  });
  if (token.warning) deps.warn(`WARN: ${token.warning}`);

  // Only the crontab line is subject to cron's `%` rule; the script is read by sh.
  const scriptPath = cronScriptPath(deps.scriptDir(), opts.owner, opts.project);
  const percent = findPercentValue([
    ['script', scriptPath],
    ['log', logPath],
  ]);
  if (percent) {
    deps.warn(
      `macf fleet install-cron: cannot install: ${percent} contains "%", which cron treats as ` +
        'the end of the command. Use a path without "%" (for the log, pass --log pointing elsewhere).',
    );
    return 2;
  }

  const reconcileFlags = buildReconcileFlags({
    workspaceDir: opts.workspaceDir,
    manifest: opts.manifest,
    withRouting: opts.withRouting,
    execute: opts.execute,
    allowRestart: opts.allowRestart,
  });

  const line = buildCronLine({ schedule: opts.schedule, scriptPath, logPath, marker });
  if (line.length > MAX_CRON_LINE) {
    const [name, value] =
      scriptPath.length >= logPath.length ? (['script path', scriptPath] as const) : (['log path', logPath] as const);
    deps.warn(
      `macf fleet install-cron: the crontab line is ${line.length} characters; cron caps a command ` +
        `at 1000 and this limit is ${MAX_CRON_LINE}. The longest value is the ${name} (${value.length} ` +
        'characters); use a shorter one (for the log, pass --log).',
    );
    return 2;
  }

  const script = buildCronScript({
    macfPath: macf.path,
    installPath,
    preludePath,
    tokenPrefix: token.prefix,
    reconcileFlags,
    marker,
  });

  const mode = describeMode(opts);

  if (opts.print) {
    deps.log(line);
    deps.log(`Script ${scriptPath}:`);
    deps.log(script.trimEnd());
    return 0;
  }

  deps.log(`Planned macf-watchdog cron line [${mode}]:`);
  deps.log(`  ${line}`);
  deps.log(`Script ${scriptPath}:`);
  deps.log(script.trimEnd());
  if (!opts.yes && !(await deps.confirm('Install this cron line?'))) {
    deps.log('Aborted — crontab unchanged.');
    return 0;
  }

  // Script first: a crontab line must never point at a script that is not there.
  const oldScript = deps.readScript(scriptPath);
  deps.writeScript(scriptPath, script);
  const next = computeInstalledCrontab(existing, line, marker, opts.workspaceDir);
  try {
    deps.writeCrontab(next);
  } catch (err) {
    // The old line still runs; put its old script back (or remove the new one).
    if (oldScript === null) deps.removeScript(scriptPath);
    else deps.writeScript(scriptPath, oldScript);
    throw err;
  }
  deps.log(
    `Installed macf-watchdog cron [${mode}], schedule '${opts.schedule}', script ${scriptPath}, log ${logPath}.`,
  );
  deps.log('Verify: crontab -l | grep macf-watchdog');
  return 0;
}

/** Name of the first value containing `%` (cron ends the command there), or null. */
export function findPercentValue(
  values: ReadonlyArray<readonly [string, string | undefined]>,
): string | null {
  return values.find(([, v]) => v?.includes('%'))?.[0] ?? null;
}

/** Resolve the `macf` cron will run; refuse when absent or a different version. */
export function checkMacfBinary(
  cliVersion: string,
  deps: Pick<FleetInstallCronDeps, 'resolveMacf' | 'macfVersion'>,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
  const fix = `npm install -g @groundnuty/macf@${cliVersion}`;
  const path = deps.resolveMacf();
  if (!path) {
    return {
      ok: false,
      message:
        `no \`macf\` found on PATH. The cron line runs an absolute \`macf\` at this CLI's ` +
        `version (${cliVersion}); install one with: ${fix}`,
    };
  }
  const found = deps.macfVersion(path);
  if (found !== cliVersion) {
    return {
      ok: false,
      message:
        `${path} reports version ${found ?? 'unknown'} but this CLI is ${cliVersion}. ` +
        `Cron must run the same version; install it with: ${fix}`,
    };
  }
  return { ok: true, path };
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
    readAppCreds: () => readAppCreds(workspaceDir),
    installPath: () => process.env['PATH'] ?? null,
    resolveMacf: () => resolveOnPath('macf'),
    macfVersion: (path: string) => {
      try {
        const out = execFileSync(path, ['--version'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out.split('+')[0] || null;
      } catch {
        return null;
      }
    },
    helperExists: (path: string) => {
      try {
        accessSync(path, fsConstants.X_OK);
        return true;
      } catch {
        return existsSync(path);
      }
    },
    confirm: (question: string) => promptYesNo(question),
    scriptDir: () => join(process.env['HOME'] ?? '~', CRON_SCRIPT_DIR_REL),
    writeScript: (path: string, content: string) => {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, content, { mode: 0o700 });
        renameSync(tmp, path);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw new FleetInstallCronError(`failed to write ${path}: ${(err as Error).message}`);
      }
    },
    readScript: (path: string) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
    removeScript: (path: string) => {
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    },
    log: (msg: string) => console.log(msg),
    warn: (msg: string) => console.error(msg),
  };
}

/** First executable `name` on `$PATH`, as an absolute path (like `command -v`). */
function resolveOnPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (!dir || !dir.startsWith('/')) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * App creds for the token bake: `macf-agent.json` `github_app` first (what `macf init`
 * writes), then `settings.local.json` `.env` for older workspaces.
 */
export function readAppCreds(workspaceDir: string): AppCreds | null {
  const config = readAgentConfig(workspaceDir);
  if (config?.github_app) {
    const src = tokenSourceFromConfig(workspaceDir, config);
    return { appId: src.appId, installId: src.installId, keyPath: src.keyPath };
  }
  return readAppCredsFromSettings(workspaceDir);
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

  const config = readAgentConfig(workspaceDir);
  const project = config?.project;
  if (!config || !project) {
    console.error(
      `macf fleet install-cron: no project found in ${workspaceDir}/.macf/macf-agent.json ` +
        '(run `macf init` first). The cron marker is per project, so it cannot be installed.',
    );
    return 2;
  }

  let owner: string;
  try {
    owner = ownerAccountFromRegistry(config.registry);
  } catch {
    console.error(
      `macf fleet install-cron: no registry owner derivable from ${workspaceDir}/.macf/macf-agent.json ` +
        '(`registry` must be org, profile or repo). The cron marker names the owner, so it cannot be installed.',
    );
    return 2;
  }

  const deps = createRealDeps(workspaceDir);
  return runFleetInstallCron(
    {
      project,
      owner,
      cliVersion: PACKAGE_VERSION,
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
