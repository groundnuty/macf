#!/usr/bin/env node
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { listAgents } from './commands/list.js';
import { cdAgent } from './commands/cd.js';
import { initAgent } from './commands/init.js';
import { update } from './commands/update.js';
import { showStatus } from './commands/status.js';
import { listPeers } from './commands/peers.js';
import { runPs } from './commands/ps.js';
import { runFleetStatus } from './commands/fleet.js';
import { runFleetDoctor } from './commands/fleet-doctor.js';
import { runFleetInstallCronCommand, DEFAULT_SCHEDULE } from './commands/fleet-install-cron.js';
import { runFleetReconcileCommand } from './commands/fleet-reconcile.js';
import { runFleetResumeCommand } from './commands/fleet-resume.js';
import { runFleetUpgrade } from './commands/fleet-upgrade.js';
import { runFleetDeactivate, runFleetArchive } from './commands/fleet-teardown.js';
import { runFleetDeleteApps, runFleetDestroy, DESTROY_ENV_ACK_VAR } from './commands/fleet-teardown-destructive.js';
import { runFleetDeploy } from './commands/fleet-deploy.js';
import { runBootstrapPlan } from './commands/bootstrap.js';
import { runBootstrapApply } from './commands/bootstrap-apply.js';
import { writeOperatorSecretsFileTemplate } from './bootstrap/operator-secrets-file.js';
import { runBootstrapStatus } from './commands/bootstrap-status.js';
import { runBootstrapControlRepoInit } from './commands/bootstrap-control-repo-init.js';
import { runManifestScaffold } from './commands/bootstrap-manifest-scaffold.js';
import { runRoutingDoctor } from './commands/routing-doctor.js';
import { runRoutingE2e } from './commands/routing-e2e.js';
import { runRunnerAudit } from './commands/runner-audit.js';
import { runRunnerDeclarationCheck } from './commands/runner-declaration-check.js';
import { runRegistryPrune } from './commands/registry-prune.js';
import { runRestartSelfCommand } from './commands/restart-self.js';
import { certsInit, certsRecover, certsRotate, issueRoutingClient } from './commands/certs.js';
import { repoInit } from './commands/repo-init.js';
import { rulesRefresh } from './commands/rules-refresh.js';
import { runDoctor } from './commands/doctor.js';
import { runWhoami } from './commands/whoami.js';
import { runMonitorCommand } from './commands/monitor.js';
import { runProposeCommand } from './commands/propose.js';
import { selfUpdate } from './commands/self-update.js';
import { findProjectRoot } from './config.js';
import { findCliPackageRoot } from './rules.js';
import { packageVersionDisplay } from '../package-version.js';
import { isDirExplicit } from './workspace-dir.js';

/**
 * Resolve the project directory for project-scoped commands.
 * Walks up from cwd looking for .macf/macf-agent.json. Exits with a clear
 * error if not found. Commands that bootstrap new projects (init, repo-init)
 * use `--dir` or cwd directly instead of this.
 */
function requireProjectRoot(): string {
  const dir = findProjectRoot(process.cwd());
  if (!dir) {
    console.error(
      'Not in a MACF project (no .macf/macf-agent.json found walking up from cwd).\n' +
      'Either cd into a project or run `macf init` first.',
    );
    process.exit(1);
  }
  return dir;
}

/**
 * Validate an explicit --dir value: resolve and confirm it contains
 * .macf/macf-agent.json. No walk-up — the user gave an exact path.
 */
function validateProjectDir(path: string): string {
  const abs = resolve(path);
  if (!existsSync(join(abs, '.macf', 'macf-agent.json'))) {
    console.error(`Not a MACF project: ${abs} has no .macf/macf-agent.json`);
    process.exit(1);
  }
  return abs;
}

/**
 * Resolve the project directory from either --dir (explicit) or auto-discovery.
 * Explicit --dir wins. Both paths exit with a clear error if no project is found.
 */
function resolveProjectDir(optsDir: string | undefined): string {
  return optsDir ? validateProjectDir(optsDir) : requireProjectRoot();
}

const program = new Command();

program
  .name('macf')
  .description('Multi-Agent Coordination Framework CLI')
  .version(packageVersionDisplay())
  .action(() => {
    listAgents();
  });

program
  .command('init')
  .description('Set up a project directory for an agent')
  .requiredOption('--project <name>', 'Project name (e.g., macf)')
  .requiredOption('--role <role>', 'Agent role — a canonical role (auditor, code-agent, science-agent, devops-agent, writing-agent) or a custom one. NOTE: the auditor role is the exact string "auditor" (no -agent suffix) — a near-miss silently skips its never-acts safety hook.')
  .option('--name <name>', 'Agent name (defaults to role) — the OTEL bot-name / GitHub-attribution identity')
  .option('--routing-label <label>', 'Routing identity (registry key + cert CN), defaults to the agent name. Set only when it must differ from the bot-name, e.g. the substrate (devops-agent vs macf-devops-agent).')
  .option('--type <type>', 'Agent type: permanent or worker', 'permanent')
  // App-cred flags are required only for GitHub-backed registries.
  // `--local` (DR-024 / macf#322) skips token mint entirely; commander
  // can't easily express conditional-required, so accept these as
  // optional and let `validateInitOpts` enforce the pairing per
  // registry-type. Operators get an actionable error from the validator
  // rather than commander's generic missing-required message.
  .option('--app-id <id>', 'GitHub App ID (required for repo/org/profile registries)')
  .option('--install-id <id>', 'GitHub App Installation ID (required for repo/org/profile registries)')
  .option('--key-path <path>', 'Destination the App private key lives at + what env.github points to (repo/org/profile registries). Defaults to ~/.macf/keys/<owner>/<project>/<agent>.pem; pass --app-key to ingest the key here at init.')
  .option('--app-key <path>', 'Source path of the downloaded App private key (.pem) to INGEST into --key-path (default ~/.macf/keys/<owner>/<project>/<agent>.pem) at 0600. Onboarding: create the App -> download the .pem -> macf init --app-key <path> ....')
  .option('--registry-type <type>', 'Registry: repo, org, profile, or local', 'repo')
  .option('--registry-org <org>', 'Org name (for org registry)')
  .option('--registry-user <user>', 'User name (for profile registry)')
  .option('--registry-repo <repo>', 'owner/repo (for repo registry)')
  .option('--local', 'Shorthand for --registry-type local. Bootstraps a single-host project without GitHub Apps; auto-generates a local CA at ~/.macf/registry/<project>.ca.{crt,key} on first invocation.')
  .option('--path <path>', 'Absolute path to the local-registry JSON file (only with --local / --registry-type=local). Defaults to ~/.macf/registry/<project>.json.')
  .option('--migrate-from <path>', 'One-shot migrate from a local-registry JSON file into the new GitHub-backed registry (one-way; the old file is left untouched). Rejected with --local.')
  .option('--advertise-host <host>', 'Host the channel server advertises in its registry entry + includes in its cert SAN (e.g., Tailscale IP). Defaults to 127.0.0.1 when unset.')
  .option('--tmux-session <name>', 'Tmux session name for on-notify wake. When set, channel server\'s /notify handler injects the prompt into this tmux session via tmux-send-to-claude.sh after the MCP push. If unset, auto-detects from $TMUX.')
  .option('--tmux-window <idx-or-name>', 'Tmux window index or name within the session (e.g., "0", "cv-architect"). Optional — defaults to the session\'s current window.')
  .option('--cli-version <semver>', 'Pin @macf/cli version (e.g., 0.1.0)')
  .option('--plugin-version <semver>', 'Pin macf-agent plugin version (e.g., 0.1.0)')
  .option('--actions-version <tag>', 'Pin macf-actions version (e.g., v1, v1.0.0)')
  .option('--dir <path>', 'Project directory (defaults to current working directory)')
  .option(
    '--force',
    'Overwrite an existing hand-authored claude.sh (one with no macf managed-file header). ' +
      'Without this, init refuses when it finds one rather than silently clobbering it. ' +
      'Does not affect a fresh workspace or an already macf-managed claude.sh — those are ' +
      'always written/refreshed regardless.',
    false,
  )
  // Commander's `--no-<flag>` convention auto-defaults `opts.agentsIndex` to
  // `true` (registered) — deliberately NO explicit 3rd-arg default here.
  // An explicit `false` 3rd arg on a `--no-` option conflicts with
  // commander's own convention and pins the value regardless of whether
  // the flag was passed (macf#347 — reproduced + fixed for
  // --no-migrate-env-files; same shape, same fix).
  .option(
    '--no-agents-index',
    'Skip registering this workspace in the global cross-project agents ' +
      'index (~/.macf/agents.json). For a scoped/ephemeral init — a CI ' +
      'harness check, a scratch validation workspace — that should not ' +
      'become discoverable via `macf status`/`macf peers`/`macf list` on ' +
      'this host. Ordinary invocations register as before.',
  )
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    // `--local` is the discoverable shorthand for `--registry-type local`
    // (locked-in option 2 per macf#322 thread). Both flow into the same
    // LocalRegistryConfig at init time. The flag wins if both forms are
    // supplied with conflicting values; they almost always agree.
    const registryType = opts.local ? 'local' : opts.registryType;
    await initAgent(projectDir, {
      project: opts.project,
      role: opts.role,
      name: opts.name,
      routingLabel: opts.routingLabel,
      type: opts.type,
      appId: opts.appId,
      installId: opts.installId,
      keyPath: opts.keyPath,
      appKey: opts.appKey,
      registryType,
      registryOrg: opts.registryOrg,
      registryUser: opts.registryUser,
      registryRepo: opts.registryRepo,
      registryPath: opts.path,
      migrateFrom: opts.migrateFrom,
      advertiseHost: opts.advertiseHost,
      tmuxSession: opts.tmuxSession,
      tmuxWindow: opts.tmuxWindow,
      cliVersion: opts.cliVersion,
      pluginVersion: opts.pluginVersion,
      actionsVersion: opts.actionsVersion,
      force: opts.force,
      agentsIndex: opts.agentsIndex,
    });
  });

program
  .command('update')
  .description(
    'Refresh canonical assets + bump pinned versions. ' +
    'ALWAYS regenerates claude.sh, coordination rules, helper scripts, ' +
    'sandbox + hook entries from the installed CLI (template-evolution sync; ' +
    'independent of the --cli/--plugin/--actions selection). The flags below ' +
    'gate ONLY which version pins in macf-agent.json get bumped + when the ' +
    'plugin dir gets re-fetched. See `update --help` notes below for details.',
  )
  .addHelpText('after', `
Important — what gets refreshed UNCONDITIONALLY (independent of --cli/--plugin/--actions):
  - .claude/scripts/        helper scripts (macf-gh-token.sh, check-gh-token.sh, etc.)
  - .claude/rules/          coordination.md + other canonical rules
  - .claude/settings.json   gh-token PreToolUse hook + plugin-skill permissions +
                             sandbox.filesystem.allowRead + sandbox.excludedCommands
                             entries (merge-preserving — operator-authored entries kept)
  - claude.sh               regenerated from the installed CLI's launcher template
                             so template-evolution lands without re-running \`macf init\`
                             (it has, for example, picked up a new launcher flag and
                             fixed a retired OTLP endpoint port in the past). The
                             generated file carries a managed-file warning header.

What the flags actually control:
  --cli       bump versions.cli pin to latest
  --plugin    bump versions.plugin pin + re-fetch .macf/plugin/ if pin bumped
  --actions   bump versions.actions pin to latest
  --all       bump all three non-interactively
  --yes       skip the unified Proceed? prompt; non-interactive bypass
  --confirm   explicit opt-in to the unified preview-then-prompt flow
              (also the default for bare \`macf update\`; --yes overrides)
  --no-migrate-env-files
              skip the monolithic-to-multi-file claude.sh migration
              AND env-file refresh (operator opt-out for hand-modified
              launchers; does NOT roll back already-migrated workspaces)
  --dry-run   show diff + would-bump list, write nothing

Implication for reproducible bootstrap (cv-e2e-test, harness pinning, etc.):
  The CLI BINARY's installed version determines what claude.sh template lands.
  Pin via \`npx -y @groundnuty/macf@<version> update\` instead of bare \`macf update\`
  if the bootstrap needs to use a specific binary version (vs whatever brew/system
  has).
`)
  .option('--all', 'Bump all version pins non-interactively', false)
  .option('--cli', 'Bump only the CLI version pin', false)
  .option('--plugin', 'Bump only the plugin version pin (+ re-fetch .macf/plugin/ if bumped)', false)
  .option('--actions', 'Bump only the macf-actions version pin', false)
  .option('--yes', 'Skip the unified Proceed? prompt; non-interactive bypass', false)
  .option('--confirm', 'Explicit opt-in to the unified preview-then-prompt flow (also the default; --yes overrides)', false)
  // Commander's `--no-<flag>` convention auto-defaults `opts.migrateEnvFiles`
  // to `true` (migration enabled) + the flag flips it to `false` when passed.
  // Pre-#347 this option had an explicit `false` 3rd-arg default which
  // CONFLICTED with the `--no-` convention and made `opts.migrateEnvFiles`
  // always-`false` regardless of whether the flag was passed → migration
  // block in update.ts skipped on every invocation. Empirically reproduced
  // via commander v14. The fix is to omit the explicit 3rd arg so the
  // canonical `--no-` semantic holds. See macf#347.
  .option('--no-migrate-env-files', 'Skip the monolithic-to-multi-file claude.sh migration AND env-file refresh (operator opt-out)')
  .option('--dry-run', 'Show the diff but do not write the config', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    // Commander's --no-<flag> convention: opts.migrateEnvFiles = true by
    // default (auto-set when --no-migrate-env-files is registered without
    // an explicit 3rd-arg default per macf#347 fix); --no-migrate-env-files
    // flips it to false. Translate to the more intuitive opt-out shape
    // used inside `update()`.
    const noMigrateEnvFiles = opts.migrateEnvFiles === false;
    const code = await update(resolveProjectDir(opts.dir), {
      all: opts.all,
      cli: opts.cli,
      plugin: opts.plugin,
      actions: opts.actions,
      yes: opts.yes,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
      noMigrateEnvFiles,
    });
    process.exitCode = code;
  });

program
  .command('status')
  .description('Ping all agents and show status')
  .option('--dir <path>', 'Scope to a specific project (defaults to all agents in global index)')
  .action(async (opts) => {
    const dir = opts.dir ? validateProjectDir(opts.dir) : undefined;
    await showStatus(dir);
  });

program
  .command('peers')
  .description('List peers from the registry')
  .option('--dir <path>', 'Scope to a specific project (defaults to all agents in global index)')
  .action(async (opts) => {
    const dir = opts.dir ? validateProjectDir(opts.dir) : undefined;
    await listPeers(dir);
  });

program
  .command('ps')
  .description(
    'List MACF agents on this host — ALIVE (running claude / channel-server, ' +
    'keyed by cwd + identity) UNION DEAD (discovered .macf/ workspaces with no ' +
    'process). Registry-free local scan; Linux + macOS. Set MACF_WORKSPACE_ROOT ' +
    'to override the scan roots.',
  )
  .option('--json', 'Emit the structured alive∪dead entry list as JSON for automation', false)
  .action((opts) => {
    process.exitCode = runPs(undefined, { json: Boolean(opts.json) });
  });

const fleet = program
  .command('fleet')
  .description('Fleet roster + interconnect-health');

fleet
  .command('status')
  .description(
    'Roster + LIVE health for every registered agent: NAME / HOST:PORT / ' +
    'online-offline (mTLS /health) / uptime + the present self-report fields ' +
    '(instance_id, cert_expiry warn<30d/crit<7d, and idle/busy state + otel ' +
    'reachability when the agent reports them). Reachable + self-reports only — ' +
    'no inject/delivery probes (those are a planned future addition).',
  )
  .option('--json', 'Emit the structured roster as JSON for automation', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runFleetStatus(resolveProjectDir(opts.dir), { json: opts.json });
    process.exitCode = code;
  });

fleet
  .command('doctor')
  .description(
    'Mesh-interconnect test per registered agent. DEFAULT (non-invasive): ' +
    'REACHABLE (mTLS /health answers) + ACCEPTED (diagnostic mTLS /notify ACK — ' +
    '200 + ack + correlation-token echo) — proves protocol-reaches-server ONLY. ' +
    'With --inject (INVASIVE): also PROCESSED — routes a REAL marker-bearing /notify ' +
    'to each reachable agent, WAKING it, then matches the echoed run_id off ' +
    '/health.last_processed to prove the full deliver→process chain. --inject is the ' +
    'IDLE-agent fallback (prefer passive last_processed for a busy agent); a timeout ' +
    'is UNCONFIRMED (possibly busy), NOT a gap. Exits non-zero when DEGRADED ' +
    '(Reachable+Accepted; PROCESSED does not affect the verdict).',
  )
  .option('--json', 'Emit the structured per-agent result as JSON (for scripting/automation)', false)
  .option('--inject', 'INVASIVE Processed-now delivery-proof: routes a real probe + wakes each reachable agent', false)
  .option('--inject-timeout <sec>', 'Per-agent poll budget for --inject, in seconds (default 24)', (v) => parseInt(v, 10))
  .option(
    '--dir <path>',
    'Project directory (defaults to auto-discovery from cwd). Scheduler-safe: unlike ' +
      'other `fleet` subcommands, resolution failure here never calls process.exit() directly — ' +
      'under --json it always emits a valid, non-empty JSON {error} object on stdout + a nonzero exit.',
  )
  .option(
    '--manifest <path>',
    'Also check each manifest agent’s declared role against the workspace routing label ' +
      'discovered on this host, per agent — never a single collapsed verdict. Reports unknown ' +
      '(not clean) when a workspace cannot be found or read. Omit to skip this check entirely.',
  )
  .action(async (opts) => {
    // NOTE: unlike the other `fleet` subcommands (which call resolveProjectDir()
    // here and process.exit(1) on failure BEFORE json-handling even runs), `fleet
    // doctor` passes the raw --dir value straight through. Resolution happens
    // INSIDE runFleetDoctor (resolveFleetDoctorProjectDir) so a --json consumer
    // always gets a valid JSON error object instead of empty stdout (macf#830).
    const code = await runFleetDoctor(opts.dir, {
      json: opts.json,
      inject: opts.inject,
      injectTimeoutSec: opts.injectTimeout,
      manifest: opts.manifest,
    });
    process.exitCode = code;
  });

fleet
  .command('install-cron')
  .description(
    'Install a HOST crontab entry that periodically runs the watchdog (`macf ' +
    'fleet reconcile`), porting devops-toolkit\'s fleet/install-cron.sh. ' +
    'Host-installed so it survives a reboot (the first post-boot sweep ' +
    'launches the desired fleet from a cold box). The generated line sources the ' +
    'host-prelude (cron has a bare env), mints a FRESH GH_TOKEN fail-loud (cron has no ' +
    'ambient token), then runs reconcile, appending to a log. SAFE DEFAULT: REPORT-ONLY ' +
    '(the line omits --execute → reconcile logs decisions, acts on nothing); pass ' +
    '--execute to act. IDEMPOTENT: marker-guarded — a re-run replaces the macf-watchdog ' +
    'line, never duplicates. --uninstall removes only that line. Shows the planned change ' +
    '+ confirms (--yes bypasses; --print previews without touching crontab).',
  )
  .option('--schedule <cron>', `Cron schedule expression (default '${DEFAULT_SCHEDULE}')`)
  .option('--execute', 'Install an ACTING line (default: report-only/dry-run)', false)
  .option('--allow-restart', 'Also forward --allow-restart to reconcile (Tier-2 graceful-restart)', false)
  .option('--with-routing', 'Also forward --with-routing to reconcile (routing-doctor freshness probe)', false)
  .option('--manifest <path>', 'Forward --manifest <path> to reconcile (desired-set manifest)')
  .option('--no-token', 'Do NOT bake a GH_TOKEN mint into the cron (operator provides it)')
  .option('--uninstall', 'Remove the macf-watchdog cron line', false)
  .option('--print', 'Print the line that WOULD be installed and exit — never touches crontab', false)
  .option('--prelude <path>', 'Override the host-prelude path sourced before reconcile')
  .option('--log <path>', 'Override the watchdog log path')
  .option('--yes', 'Skip the confirmation prompt (non-interactive)', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd). An explicit --dir WINS over MACF_WORKSPACE_DIR — pass it to target a workspace other than your own.')
  .action(async (opts) => {
    // macf#1123 — same capture as restart-self's (macf#888), threaded via the
    // shared isDirExplicit rather than re-derived: without it, MACF_WORKSPACE_DIR
    // unconditionally overrides an explicit --dir inside the command below.
    const dirExplicit = isDirExplicit(opts);
    const code = await runFleetInstallCronCommand(resolveProjectDir(opts.dir), {
      schedule: opts.schedule,
      execute: opts.execute,
      allowRestart: opts.allowRestart,
      withRouting: opts.withRouting,
      manifest: opts.manifest,
      token: opts.token,
      uninstall: opts.uninstall,
      print: opts.print,
      prelude: opts.prelude,
      log: opts.log,
      yes: opts.yes,
      dirExplicit,
    });
    process.exitCode = code;
  });

fleet
  .command('reconcile')
  .description(
    'The desired-state reconciler, porting devops-toolkit\'s fleet/reconcile.sh. ' +
    'Probes ACTUAL state (fleet /health) and drives it toward the ' +
    'operator-owned DESIRED set (a desired-agents.yaml manifest if present, else the ' +
    "host's discovered workspaces): desired-and-down → LAUNCH; desired-and-deaf → HEAL " +
    'via the tiered ladder (Tier-1 gated inject → Tier-2 graceful-restart [--allow-restart] → ' +
    'Tier-3 gh-issue alert); desired-down (paused sentinel OR last-exit==0 /exit) → SKIP. ' +
    'Guards: aliveness-gate (NEVER restart a busy agent), EXPONENTIAL restart-backoff + ' +
    'stuck-in-backoff escalation (never restart-storm), launch-stagger (space cold-starts), ' +
    'and a self-heartbeat. DRY-RUN BY DEFAULT — logs decisions, acts on nothing; pass ' +
    '--execute to act. The cron consumer is `macf fleet install-cron`.',
  )
  .option('--execute', 'ACTUALLY act (launch/inject/restart/alert/heartbeat). Default: dry-run.', false)
  .option('--allow-restart', 'Enable Tier-2 graceful-restart (operator sign-off; default held)', false)
  .option('--with-routing', 'Accepted for cron compatibility (routing-freshness probe RESERVED in this port)', false)
  .option('--manifest <path>', 'desired-agents.yaml (default: $HOME/.macf/desired-agents.yaml, else discovery)')
  .option('--state-dir <dir>', 'Cross-sweep escalation/backoff/alert state dir (default: $HOME/.macf/watchdog-state)')
  .option('--last-exit-dir <dir>', 'Per-agent last-exit-code dir (default: $HOME/.macf/last-exit)')
  .option('--paused-dir <dir>', 'Paused-sentinel dir (default: $HOME/.macf/paused)')
  .option('--heartbeat-file <path>', 'Watchdog self-heartbeat file (default: $HOME/.macf/watchdog-heartbeat)')
  .option('--json', 'Emit the structured sweep result as JSON (for scripting/automation)', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd). An explicit --dir WINS over MACF_WORKSPACE_DIR — pass it to target a workspace other than your own.')
  .action(async (opts) => {
    // macf#1123 — see the install-cron action above for why this capture exists.
    const dirExplicit = isDirExplicit(opts);
    process.exitCode = await runFleetReconcileCommand(resolveProjectDir(opts.dir), {
      execute: opts.execute,
      allowRestart: opts.allowRestart,
      withRouting: opts.withRouting,
      manifest: opts.manifest,
      stateDir: opts.stateDir,
      lastExitDir: opts.lastExitDir,
      pausedDir: opts.pausedDir,
      heartbeatFile: opts.heartbeatFile,
      json: opts.json,
      dirExplicit,
    });
  });

fleet
  .command('resume')
  .description(
    'Nudge a STALLED idle agent to continue, or REPORT a BLOCKED one — ' +
    'porting devops-toolkit\'s fleet/resume.sh + stall-signatures.json. An idle ' +
    'agent is one of three things and only its pane tells them apart: idle-CLEAN (no ' +
    'signature) → never touched; idle-STALLED (rate-limit/turn-abort) → NUDGE (resume ' +
    'the SAME session, preserving work); idle-BLOCKED (permission/trust/skill/memory ' +
    'prompt) → REPORT (a durable operator alert, NEVER auto-answered — an authorization ' +
    'decision needs a human). SAFETY: allowlist-only (never a blind nudge), ' +
    'idle-gated (never interrupt a busy agent), verify-resumed (a nudge that does not ' +
    'take → back off, don\'t re-spam), fire-capped per episode. The allowlist lives in ' +
    '.claude/.macf/stall-signatures.json (operator-tunable). DRY-RUN BY DEFAULT — prints ' +
    'the plan; --execute nudges / raises alerts.',
  )
  .option('--execute', 'ACTUALLY nudge / raise alerts (else dry-run: print the plan)', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd). An explicit --dir WINS over MACF_WORKSPACE_DIR — pass it to target a workspace other than your own.')
  .action(async (opts) => {
    // macf#1123 — see the install-cron action above for why this capture exists.
    const dirExplicit = isDirExplicit(opts);
    const code = await runFleetResumeCommand(resolveProjectDir(opts.dir), {
      execute: Boolean(opts.execute),
      dirExplicit,
    });
    process.exitCode = code;
  });

fleet
  .command('upgrade')
  .description(
    'Rolling framework-version upgrade. For each selected fleet (a ' +
    "fleet == one PROJECT — its own CA + registry namespace, NOT the " +
    'coarser registry scope, since one profile/org registry can host several ' +
    'distinct projects), roll every agent whose RUNNING /health.version is ' +
    'behind TARGET, ONE AT A TIME: pre-flight gates (config-dirty — OBJECTS ' +
    'with the exact uncommitted-file list + an agent-directed message, doing ' +
    'NOTHING to that agent, unless --force; then busy — never interrupt a ' +
    'working agent, skip+report or --wait for idle) → macf update → ' +
    'restart-self (relaunches WITHOUT stashing its own regeneration — left ' +
    'uncommitted for the relaunched agent to see) → verify /health.version == ' +
    'target (re-resolving the fresh restart-self endpoint on EACH poll, over a ' +
    'relaunch-aware grace budget) → report the regenerated files + next. When ' +
    'an agent comes back reachable but still on its OLD version, its own ' +
    'LAUNCH PIN discriminates the cause: pin already matches ' +
    'target → `bad-release` (a genuine crash-loop) → HALTS the roll (and ' +
    'later fleets — a bad release cannot brick the fleet); pin asks for a ' +
    'DIFFERENT version → `stale-pin` (the launcher, not the release, never ' +
    'asked for the upgrade) → skips that ONE agent and CONTINUES (no other ' +
    'agent is endangered); pin unreadable → treated conservatively as ' +
    '`bad-release` (HALTS) with a message naming the uncertainty. Never ' +
    'confirmed green within the grace at all (down / unreachable / an ' +
    'unrecognized version) → `relaunch-unconfirmed` → HALTS, unchanged. ' +
    'Reconcile after an OBJECT is MANUAL this iteration: resolve the flagged ' +
    'files, then re-run. DRY-RUN by default (prints the plan); --execute ' +
    'rolls. TARGET defaults to npm-latest of @groundnuty/macf.',
  )
  .option('--target <version>', 'Target framework version (default: npm-latest of @groundnuty/macf)')
  .option('--fleet <names>', 'Comma-list of fleets (project identifiers) to roll — multi-select, rolled fleet-by-fleet')
  .option('--registry <ids>', 'Comma-list of project identifiers to roll (same selector space as --fleet; historical flag name predates the current project-based grouping)')
  .option('--execute', 'ACTUALLY roll the upgrade (default: dry-run — print the plan)', false)
  .option('--wait', 'On a busy agent, poll for idle up to a bound instead of skipping', false)
  .option('--verify-timeout <sec>', 'Per-agent verify-green budget, in seconds (default 120)', (v) => parseInt(v, 10))
  .option(
    '--force',
    'Roll an agent even if its config surface (claude.sh, .claude/rules/**, ' +
      '.claude/scripts/**, .claude/settings.json, the managed .claude/.macf/env.* ' +
      '+ host-prelude.sh, CLAUDE.md, env.local.*) is dirty PRE-flight — bypasses the pre-flight ' +
      'config-dirty OBJECT gate. The bypassed agent\'s restart still leaves the ' +
      'config surface uncommitted (same as the normal path), it does not stash it.',
    false,
  )
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option(
    '-f, --file <path>',
    'Path to the fleet.yaml manifest — when given, a confirmed ' +
      "verify-green records that agent's deployed_version into the control repo's fleet.lock; " +
      'omitted = unchanged (no write). Same flag as `fleet deactivate`/`archive`.',
  )
  .action(async (opts) => {
    const code = await runFleetUpgrade(resolveProjectDir(opts.dir), {
      target: opts.target,
      fleet: opts.fleet,
      registry: opts.registry,
      execute: opts.execute,
      wait: opts.wait,
      verifyTimeoutSec: opts.verifyTimeout,
      force: opts.force,
      file: opts.file,
    });
    process.exitCode = code;
  });

fleet
  .command('deactivate')
  .description(
    'The fleet teardown ladder\'s FIRST reversible rung: deregister the fleet ' +
    'from the registry. Removes ONLY org/account-scope registry presence (the `<SEG>_CA_CERT` registry ' +
    'leg, every agent\'s `<SEG>_AGENT_<ROLE>` registration, `<SEG>_FEDERATED_CAS`) by EXACT KEY — never a ' +
    'prefix sweep. Repo-scoped variables/secrets, the vault, the repos, and the GitHub Apps are ALL left ' +
    'untouched — revival is `apply` away, zero browser clicks. ' +
    'Refuses on a foreign/unconfirmed control repo. Shows the exact target set + current registry state ' +
    'before any mutation (--yes skips the interactive confirmation). A LIVE agent ' +
    'discoverable on THIS host is asked to exit gracefully (the native `/exit`) and lets its own ' +
    '`shutdown.ts` deregister clear its slot; direct deletion is only the fallback for an agent with no ' +
    'live owner; an agent this host cannot discover is reported `unknown`, never assumed stopped (a fleet ' +
    'may span hosts). Never SIGKILL.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--yes', 'Skip the interactive confirmation prompt', false)
  .option('--json', 'Emit the structured result as JSON', false)
  .option('--dir <path>', 'Host-local dir to locate the tmux-submit helper from (default: cwd) — agent-stop only, any macf workspace works')
  .action(async (opts) => {
    const code = await runFleetDeactivate({ file: opts.file, yes: opts.yes, json: opts.json, dir: opts.dir });
    process.exitCode = code;
  });

fleet
  .command('archive')
  .description(
    'The fleet teardown ladder\'s SECOND reversible rung: `deactivate` + archives ' +
    'the `<fleet>-control` repo and every agent repo (`archived: true` via the GitHub API — read-only, ' +
    'reversible). Cumulative by design (an archived-but-still-registered fleet would be incoherent). ' +
    'Revival: un-archive (an `apply` run un-archives its own control repo on approval — see `bootstrap ' +
    'apply`\'s control-repo-archived confirm-required plan item) + `apply`, still zero browser clicks. ' +
    'NEVER deletes anything — `delete-apps` / `destroy` are separate, deliberately harder-to-reach verbs, ' +
    'not flags on this one.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--yes', 'Skip the interactive confirmation prompt', false)
  .option('--json', 'Emit the structured result as JSON', false)
  .option('--dir <path>', 'Host-local dir to locate the tmux-submit helper from (default: cwd) — agent-stop only, any macf workspace works')
  .action(async (opts) => {
    const code = await runFleetArchive({ file: opts.file, yes: opts.yes, json: opts.json, dir: opts.dir });
    process.exitCode = code;
  });

fleet
  .command('delete-apps')
  .description(
    'The fleet teardown ladder\'s THIRD rung: `archive` + deletes the per-agent ' +
    'GitHub App identities, freeing their globally-unique names. GitHub has NO REST endpoint to delete a ' +
    'App registration (verified against current GitHub docs — see `app-identity-removal.ts`) — this ' +
    'command reports EVERY App that still needs manual deletion (Settings → Developer settings → GitHub ' +
    'Apps → Advanced → Delete GitHub App) and best-effort opens the browser there. Revival cost: 2 clicks/agent ' +
    'to recreate + `apply`. NEVER exits 0 while any App identity remains undeleted — "report what could not ' +
    'be done, never exit green."',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--yes', 'Skip the interactive confirmation prompt', false)
  .option('--json', 'Emit the structured result as JSON', false)
  .action(async (opts) => {
    const code = await runFleetDeleteApps({ file: opts.file, yes: opts.yes, json: opts.json });
    process.exitCode = code;
  });

fleet
  .command('destroy')
  .description(
    'The fleet teardown ladder\'s TERMINAL rung: `delete-apps`\'s registry + App-identity ' +
    'work, PLUS deleting the repositories DIRECTLY (never archive-then-delete — pointless work for something ' +
    'about to be destroyed). History gone forever; full re-provision is the only way back. FRICTION IS THE ' +
    'FEATURE (operator directive: never allow easy repo removal) — requires ALL THREE of `--destroy-repositories`, ' +
    `typing the exact fleet name at the interactive prompt, and the environment acknowledgment ` +
    `${DESTROY_ENV_ACK_VAR}=1. Refuses on a foreign/unconfirmed control repo, same as every other rung. ` +
    'Optionally, with EXPLICIT opt-in via --shred-age-key + --age-identity <path>, cryptographically shreds ' +
    'the operator\'s age private key afterward — the single action with NO recovery whatsoever, and it also ' +
    'makes `deactivate`/`archive` non-revivable for this fleet (their free-revival depends on the vault still ' +
    'being decryptable). Never implied by any other flag.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--destroy-repositories', 'Required acknowledgment 1 of 3 — implied by nothing else', false)
  .option(
    '--shred-age-key',
    'OPT-IN ONLY, never implied: after destroying, cryptographically shred the age identity at --age-identity. ' +
      'NO recovery whatsoever. Best-effort (overwrite + unlink) — not a forensic guarantee against backups/snapshots.',
    false,
  )
  .option('--age-identity <path>', 'Path to the operator\'s age private-key file — REQUIRED when --shred-age-key is passed')
  .option('--json', 'Emit the structured result as JSON', false)
  .action(async (opts) => {
    // The env-acknowledgment itself is read INSIDE runFleetDestroy (via its
    // injectable, wiring-pinned `readEnv` dep) — never resolved here into a
    // plain boolean, so the read stays inside the tested surface. See
    // `fleet-teardown-destructive.ts`'s `FleetDestroyDeps.readEnv` doc.
    const code = await runFleetDestroy({
      file: opts.file,
      destroyRepositories: opts.destroyRepositories,
      shredAgeKey: opts.shredAgeKey,
      ageIdentity: opts.ageIdentity,
      json: opts.json,
    });
    process.exitCode = code;
  });

fleet
  .command('deploy')
  .description(
    'Materialize ONE agent\'s workspace from an already-provisioned fleet\'s vault — the gap between ' +
    '`bootstrap apply` ("provisioned") and a running agent ("running"). Decrypts secrets/vault.age (operator-' +
    'privileged — the same custody boundary as `bootstrap plan --vault`), extracts this role\'s app_id/' +
    'install_id/private-key, clones its repo into --dir (or the manifest\'s deploy_path) if not already present, ' +
    'atomically writes the App key at 0600 to the conventional ~/.macf/keys/<owner>/<fleet>/<role>.pem (never overwritten once ' +
    'present AND its fingerprint matches the vault\'s — a mismatch, e.g. a key left over from a destroyed-and-' +
    'rebuilt fleet, refuses loud instead of minting with it; see --force-key), and re-materializes the ' +
    'per-project CA the same way on a fingerprint mismatch (see --force-ca) — a rebuild rotates BOTH ' +
    'by construction, so when BOTH are stale the refusal names both flags together in ONE message rather than ' +
    'the operator discovering the second refusal only after fixing the first. Then delegates the rest to the ' +
    'real `macf init` — never reimplemented. Idempotent: an already-materialized workspace or matching key is ' +
    'left untouched, reported as skipped. Never touches the vault\'s write side (read-only-' +
    'decryptable) and never deploys anything not already recorded in the vault (refuses rather ' +
    'than guesses on a missing/partial credential).',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .requiredOption('--agent <role>', 'The agent role to deploy (must match one of manifest.agents[].role)')
  .option(
    '--identity-key <path>',
    'age identity (private key) file to decrypt the vault with. Required — no default exists for an age identity path.',
  )
  .option(
    '--vault <path>',
    'Path to the fleet\'s secrets/vault.age. Optional — defaults to <fleet.yaml dir>/secrets/vault.age (the ' +
      'control-repo layout).',
  )
  .option('--dir <path>', 'Workspace directory to materialize (defaults to the agent\'s deploy_path in fleet.yaml)')
  .option(
    '--force-key',
    'On App-key fingerprint mismatch (e.g. a stale key from a destroyed-and-rebuilt fleet), re-materialize the ' +
      'on-disk key from the vault instead of refusing)',
    false,
  )
  .option(
    '--force-ca',
    'On per-project CA fingerprint mismatch (e.g. a stale CA from a destroyed-and-rebuilt fleet), re-materialize ' +
      'the on-disk CA from the vault instead of refusing)',
    false,
  )
  .option('--json', 'Emit the structured result as JSON', false)
  .action(async (opts) => {
    const code = await runFleetDeploy({
      file: opts.file,
      agent: opts.agent,
      identityKey: opts.identityKey,
      vault: opts.vault,
      dir: opts.dir,
      forceKey: opts.forceKey,
      forceCa: opts.forceCa,
      json: opts.json,
    });
    process.exitCode = code;
  });

const bootstrap = program
  .command('bootstrap')
  .description('Declarative fleet provisioning from a fleet.yaml manifest');

bootstrap
  .command('plan')
  .description(
    'READ-ONLY: parse fleet.yaml, observe current GitHub-side state (best-effort — no App ' +
    'JWT exists yet, so App/install existence is read from fleet.lock only), and render the ' +
    '3-verb reconcile plan (create / confirm-then-update / report-extra — NEVER delete). ' +
    'Manifest sections not yet reconciled in v1 (collaborators, versions ' +
    'steering) are surfaced as an explicit SKIPPED line, never a silent no-op. No apply, ' +
    'no mutation, no browser.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--json', 'Emit the structured plan as JSON', false)
  .option(
    '--vault <path>',
    'Path to a fleet\'s secrets/vault.age — with --identity-key, lifts per-agent/CA observation into the ' +
      'vault-aware confirm tier. Operator-privileged use only; omit for the ' +
      'vault-free default.',
  )
  .option('--identity-key <path>', 'age identity (private key) file to decrypt --vault with. Required together with --vault.')
  .option(
    '--secrets-file <path>',
    'Path to a per-FLEET operator secrets file (plain KEY=value) — reports which source ' +
      'will supply each key `apply` will need, before any gate opens. Optional.',
  )
  .option('--scope-secrets-file <path>', 'Path to a per-SCOPE operator secrets file, shared across a fleet\'s org/account. Lower precedence than --secrets-file.')
  .action(async (opts) => {
    const code = await runBootstrapPlan({
      file: opts.file,
      json: opts.json,
      vaultPath: opts.vault,
      identityKeyPath: opts.identityKey,
      secretsFilePath: opts.secretsFile,
      scopeSecretsFilePath: opts.scopeSecretsFile,
    });
    process.exitCode = code;
  });

bootstrap
  .command('status')
  .description(
    'READ-ONLY: renders OBSERVED fleet state — no diff, nothing stored. Same ' +
    'provisioning observation `plan` uses (Apps, installs, repos, CA both DR two-place legs, routing-client ' +
    'secrets, control repo, versions), plus each declared agent\'s registry-registration identity ' +
    '(host:port/instance_id/last_heartbeat). Live agent LIVENESS (online/uptime/cert_expiry) is NOT observable ' +
    'from this operator-privileged plane (no agent client cert, by design) — use `macf fleet status` from a ' +
    'deployed agent workspace for that. Every unobservable fact renders honest `unknown`, never `absent`. ' +
    'No mutation, no consent gates, no fleet.lock write.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--json', 'Emit the structured status as JSON', false)
  .option(
    '--vault <path>',
    'Path to a fleet\'s secrets/vault.age — with --identity-key, lifts per-agent/CA observation into the ' +
      'vault-aware confirm tier, same as `bootstrap plan --vault`. Operator-' +
      'privileged use only; omit for the vault-free default (vault-dependent rows render `unknown`).',
  )
  .option('--identity-key <path>', 'age identity (private key) file to decrypt --vault with. Required together with --vault.')
  .action(async (opts) => {
    const code = await runBootstrapStatus({
      file: opts.file,
      json: opts.json,
      vaultPath: opts.vault,
      identityKeyPath: opts.identityKey,
    });
    process.exitCode = code;
  });

bootstrap
  .command('apply')
  .description(
    'Provision the fleet declared in fleet.yaml. `--dry-run` renders the ' +
    'read-only plan plus the exact GitHub App manifests that would be submitted — mutates nothing. ' +
    'Without `--dry-run`: shows the same plan-approve-once artifact, obtains ONE operator approval ' +
    '(`--yes` skips the prompt for automation), then drives confirm-before-create -> consent gate 1 ' +
    '(App-manifest creation) -> consent gate 2 (install) -> repo-init -> the single whole-payload ' +
    'vault write -> fleet.lock, per agent. Never silently creates a duplicate App (confirm-before-' +
    'create guard) and never silently overwrites an existing vault (fails loud unless ' +
    'MACF_BOOTSTRAP_VAULT_VERSION=1).',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--dry-run', 'Render the plan + would-be App manifests; mutate nothing', false)
  .option('--yes', 'Skip the interactive plan-approval prompt (the one non-interactive escape from the plan-approve-once flow)', false)
  .option('--json', 'Emit the structured result as JSON', false)
  .option(
    '--vault <path>',
    'Path to a fleet\'s secrets/vault.age — with --identity-key, confirms a role WITH a prior fleet.lock ' +
      'entry live against GitHub BEFORE deciding whether to open consent gate 1. ' +
      'Operator-privileged use only; omit for the vault-free default.',
  )
  .option('--identity-key <path>', 'age identity (private key) file to decrypt --vault with. Required together with --vault.')
  .option(
    '--runner-token <token>',
    'GitHub Actions runner-registration token — required when routing.runner declares ' +
      'runs_on: "self-hosted"; licenses apply to POLL for a usable self-hosted runner before writing ' +
      'MACF_TRUSTED_ACTORS (never substitutes for that live check). Falls back to MACF_BOOTSTRAP_RUNNER_TOKEN ' +
      'when unset. Get one with: gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token',
  )
  .option(
    '--ts-oauth-client-id <id>',
    'Tailscale OAuth client ID — required together with --ts-oauth-secret when transport.tailscale_oauth_required ' +
      'is declared and neither flag/env value nor an already-vaulted value is available. A fresh org has no vault ' +
      'to read this from at all; this flag supplies it directly, no --vault/--identity-key needed. Falls back to ' +
      'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID when unset. Never written to fleet.yaml or vault.age.',
  )
  .option(
    '--ts-oauth-secret <secret>',
    'Tailscale OAuth client secret — the pair to --ts-oauth-client-id; both or neither. Falls back to ' +
      'MACF_BOOTSTRAP_TS_OAUTH_SECRET when unset. Never logged, never echoed in --json output.',
  )
  .option(
    '--secrets-file <path>',
    'Path to a per-FLEET operator secrets file (plain KEY=value) — one file instead of a flag per credential. ' +
      'Resolution per key: CLI flag > this file > --scope-secrets-file > env. Run `macf bootstrap secrets ' +
      'template` for the list of keys it can carry. Optional — its absence is the normal case.',
  )
  .option(
    '--scope-secrets-file <path>',
    'Path to a per-SCOPE operator secrets file, shared across every fleet on the same org/account — the tier ' +
      'meant to carry the common case (set once, every fleet inherits it). Lower precedence than ' +
      '--secrets-file; still above env.',
  )
  .option(
    '--no-deploy',
    'Skip the default per-agent deploy phase that otherwise runs after the GitHub phase above ' +
      '(needs --vault + --identity-key; without them the deploy phase is skipped anyway, loudly). Restores ' +
      'the previous GitHub-only apply, for multi-host fleets (deploy runs per-host via `macf fleet ' +
      'deploy`) or operators who want the two phases apart.',
  )
  .action(async (opts) => {
    const code = await runBootstrapApply({
      file: opts.file,
      dryRun: opts.dryRun,
      yes: opts.yes,
      json: opts.json,
      vaultPath: opts.vault,
      identityKeyPath: opts.identityKey,
      runnerToken: opts.runnerToken,
      tsOauthClientId: opts.tsOauthClientId,
      tsOauthSecret: opts.tsOauthSecret,
      secretsFilePath: opts.secretsFile,
      scopeSecretsFilePath: opts.scopeSecretsFile,
      deploy: opts.deploy,
    });
    process.exitCode = code;
  });

const bootstrapSecrets = bootstrap
  .command('secrets')
  .description(
    'The operator secrets file — one plain KEY=value file instead of a flag per ' +
      'credential, passed to `bootstrap apply`/`plan` via --secrets-file (per-fleet) and/or ' +
      '--scope-secrets-file (per-scope, shared across a fleet\'s org/account).',
  );

bootstrapSecrets
  .command('template')
  .description(
    'Write the operator-secrets-file template: every key apply can consume, what each is for, and how to ' +
      'obtain it — fill in the blanks and pass the result as --secrets-file or --scope-secrets-file. Refuses ' +
      'to overwrite an existing file. Ensures the containing directory\'s .gitignore covers it, so the file ' +
      'is never accidentally committed.',
  )
  .option('--out <path>', 'Where to write the template', 'secrets.env.template')
  .action((opts) => {
    const path = resolve(opts.out);
    const result = writeOperatorSecretsFileTemplate(path);
    if (result.created) {
      console.log(`Wrote operator secrets template to ${path} (gitignored).`);
    } else {
      console.error(`Refusing to overwrite existing file: ${path}`);
      process.exitCode = 1;
    }
  });

const bootstrapControlRepo = bootstrap
  .command('control-repo')
  .description('Scoped operations against a fleet\'s per-fleet control-plane repo, independent of the per-agent identity plane.');

bootstrapControlRepo
  .command('init')
  .description(
    'Create-or-reuse ONLY the fleet\'s control-plane repo and commit fleet.yaml as its first act — the ' +
    'migration path for a fleet that was provisioned before the control-plane-repo layout existed (no ' +
    '`fleet.lock`, no committed manifest, Apps/repos already real on GitHub). Runs the SAME step this repo ' +
    'always runs first, in isolation: never opens a consent gate, never touches an agent\'s App, install, ' +
    'repo, or fleet.lock, never touches the vault. Idempotent — a fleet whose control repo already matches ' +
    'this manifest is reported as already-migrated with no changes made. An existing-but-archived control ' +
    'repo is refused, not silently revived.',
  )
  .requiredOption('-f, --file <path>', 'Path to the fleet.yaml manifest')
  .option('--json', 'Emit the structured result as JSON', false)
  .action(async (opts) => {
    const code = await runBootstrapControlRepoInit({ file: opts.file, json: opts.json });
    process.exitCode = code;
  });

const bootstrapManifest = bootstrap
  .command('manifest')
  .description('Draft a fleet.yaml from live GitHub state, for a fleet that predates the manifest.');

bootstrapManifest
  .command('scaffold')
  .description(
    'READ-ONLY: draft a fleet.yaml from live GitHub state via the SAME observer `bootstrap plan` diffs a ' +
    'manifest against. Every field it could not confirm is an explicit TODO (an omitted key plus a comment), ' +
    'never a guess — versions and transport.age_recipients are ALWAYS TODO by design (declaring either would ' +
    'convert today\'s observation into tomorrow\'s enforced intent, or falsely claim "no key yet" for an ' +
    'already-provisioned fleet). A clean parse of the output proves well-formedness only, never correctness — ' +
    'a scaffold checked against the same observation it was built from agrees with itself by construction. ' +
    'Never writes to a repo: stdout, or --out to a LOCAL file only.',
  )
  .requiredOption('--owner <account>', 'The GitHub org or user login that owns the fleet')
  .requiredOption('--fleet <name>', 'The fleet name (metadata.name) — lowercase kebab-case')
  .option(
    '--agent <role=owner/repo>',
    'One declared agent: role=owner/repo. Repeatable; at least one required. Role<->repo binding cannot be ' +
      'discovered live (it needs an install token this credential-free tool never holds) — supply it.',
    (value: string, previous: readonly string[]) => [...previous, value],
    [] as readonly string[],
  )
  .option('--json', 'Emit the structured draft as JSON', false)
  .option('--out <path>', 'Also write the draft to this LOCAL file path (never a repo — committing is `bootstrap control-repo init`\'s job)')
  .option(
    '--vault <path>',
    'Path to the fleet\'s secrets/vault.age — with --identity-key, lifts transport.tailscale_oauth_required into ' +
      'the derived tier and reports the vault\'s recipient-stanza COUNT (never the recipient identities ' +
      'themselves) in the age_recipients TODO comment. Operator-privileged use only; omit for the vault-free default.',
  )
  .option('--identity-key <path>', 'age identity (private key) file to decrypt --vault with. Required together with --vault.')
  .action(async (opts) => {
    const code = await runManifestScaffold({
      owner: opts.owner,
      fleet: opts.fleet,
      agent: opts.agent,
      json: opts.json,
      out: opts.out,
      vaultPath: opts.vault,
      identityKeyPath: opts.identityKey,
    });
    process.exitCode = code;
  });

const routing = program
  .command('routing')
  .description('Routing-infra (GitHub delivery plane) interconnect-health');

routing
  .command('doctor')
  .description(
    'Routing-infra interconnect check: STATIC GitHub-plane checks ' +
    'that the delivery plane is wired right — (1) CALLER-PIN consistency across the ' +
    'App install-set, (2) the ROUTABLE (MACF_AGENT_<LABEL> registry key) ' +
    'vs SELF-SKIP (agent-config app_name == bot-login) split, (3) registration ' +
    'FRESHNESS (registry instance_id == live /health), (4) MACF_CA_CERT present + ' +
    'parses, (5) tmux_session <project>@<routing-label> convention. These prove the ' +
    'PLUMBING, NOT end-to-end delivery. Exits non-zero when DEGRADED. Pass --e2e for the ' +
    'CAPABILITY test instead: files a real issue on --target-repo, labels it there (the full ' +
    'router path, not a direct channel-server POST), and polls for the recipient recording ' +
    'delivery -- a RED result there needs no checklist of what to check, it just needs the ' +
    'message to not arrive, and names the stage the chain stopped at.',
  )
  .option('--json', 'Emit the structured per-check result as JSON (for scripting/automation)', false)
  .option('--expected-pin <pin>', 'Expected macf-actions caller-pin (else the modal pin across the fleet)')
  .option(
    '--manifest <path>',
    'Path to a local fleet.yaml — supplies the AUTHORITATIVE desired macf-actions pin ' +
      '(versions.actions) for the pin-CORRECTNESS check, distinct from the modal-agreement ' +
      'consistency check above. Omit to auto-discover from the fleet\'s control repo (if any ' +
      'is reachable in this run\'s install-set); absent either way renders correctness honest-' +
      'unknown, never a pass.',
  )
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--e2e', 'Run the routing CAPABILITY probe instead of the static checks (requires --target-repo)', false)
  .option('--target-repo <owner/repo>', 'The --e2e probe target: files + labels the probe issue on THIS repo')
  .option('--target-label <label>', '--e2e: which routing label to probe (default: the target repo\'s sole configured label)')
  .option('--e2e-timeout-sec <n>', '--e2e: how long to wait for the delivery receipt before giving up (default 180)', (v) => Number(v))
  .action(async (opts) => {
    if (opts.e2e) {
      if (!opts.targetRepo) {
        console.error('--e2e requires --target-repo <owner/repo> (the repo the probe issue is filed + labeled on).');
        process.exitCode = 1;
        return;
      }
      const code = await runRoutingE2e(resolveProjectDir(opts.dir), {
        json: opts.json,
        targetRepo: opts.targetRepo,
        targetLabel: opts.targetLabel,
        timeoutSec: opts.e2eTimeoutSec,
      });
      process.exitCode = code;
      return;
    }
    const code = await runRoutingDoctor(resolveProjectDir(opts.dir), {
      json: opts.json,
      expectedPin: opts.expectedPin,
      manifestPath: opts.manifest,
    });
    process.exitCode = code;
  });

routing
  .command('runner-audit')
  .description(
    'After-the-fact check: reads ACTUAL runner names/groups from each --repo\'s recent agent-router.yml ' +
    'run history (never the requested labels) and reports any non-exempt job that landed on a metered ' +
    'GitHub-hosted runner. pick-runner is the one named exemption (hosted by design). Exit code is ' +
    'non-zero on ANY violation OR unreadable run/job history -- an honest-unknown never reads as clean.',
  )
  .option('--repo <owner/repo>', 'Repo to audit (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
  .option('--json', 'Emit the structured per-repo report as JSON', false)
  .option('--max-runs <n>', 'How many of the most recent runs to check per repo (default 20)', (v) => Number(v))
  .action(async (opts) => {
    const code = await runRunnerAudit({ repos: opts.repo, json: opts.json, maxRuns: opts.maxRuns });
    process.exitCode = code;
  });

routing
  .command('runner-declaration-check')
  .description(
    'Provision-time check: for each --repo, reads the INSTALLED agent-router.yml and reports whether a ' +
    '"--runs-on self-hosted" declaration can actually reach macf-actions\' pick-runner job (which "with:" inputs ' +
    'it passes vs what the reusable workflow accepts). Advisory only -- never called by plan/apply, exit code is ' +
    'non-zero on a confirmed mismatch OR an unreadable installed workflow.',
  )
  .option('--repo <owner/repo>', 'Repo to check (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
  .option('--runs-on <value>', 'The fleet\'s declared routing.runner.runs_on value (e.g. "self-hosted")')
  .option('--json', 'Emit the structured per-repo finding as JSON', false)
  .action(async (opts) => {
    const code = await runRunnerDeclarationCheck({ repos: opts.repo, runsOn: opts.runsOn, json: opts.json });
    process.exitCode = code;
  });

const registry = program
  .command('registry')
  .description('Registry maintenance');

registry
  .command('prune')
  .description(
    'mTLS-/health-check each registry entry and remove ONLY confirmed-dead ones ' +
    '(refused/timeout after a retry). Consent required (default No); --yes bypasses.',
  )
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--yes', 'Skip the confirmation prompt (non-interactive)', false)
  .action(async (opts) => {
    const code = await runRegistryPrune(resolveProjectDir(opts.dir), { yes: opts.yes });
    process.exitCode = code;
  });

program
  .command('restart-self')
  .description(
    'Prepare the workspace (be-replaceable design) + spawn a DETACHED ' +
    'relauncher that OUTLIVES this session, so a watchdog (or the agent) can ' +
    'trigger a clean restart without losing work. DRY-RUN BY DEFAULT — emits the ' +
    'plan (marked-stash, RESUME-note, relauncher cmd, session to kill) and does ' +
    'NOTHING without --confirm. With --confirm: marked-stash any uncommitted ' +
    'tracked changes -> RESUME-note -> spawn detached relauncher -> kill the ' +
    'current tmux session (the restart trigger).',
  )
  .option('--reason <fault|upgrade|manual>', 'Restart driver (fault/upgrade/manual)', 'manual')
  .option('--confirm', 'Actually act (otherwise dry-run)', false)
  .option('--dry-run', 'Force dry-run even with --confirm (the safer wins)', false)
  .option('--json', 'Emit the structured plan/result as JSON', false)
  .option(
    '--force',
    'Bypass the STANDALONE config-surface stash-refusal guard — ' +
      'proceed (and STASH, same as any other dirt) even when claude.sh, ' +
      '.claude/rules/**, .claude/scripts/**, .claude/settings.json, the ' +
      'managed .claude/.macf/env.* + host-prelude.sh, CLAUDE.md, or env.local.* ' +
      'are dirty. Same effect as ' +
      'MACF_RESTART_STASH_CONFIG=1.',
    false,
  )
  .option(
    '--leave-config-uncommitted',
    'Roll-path flag (set by `macf fleet upgrade`\'s driver — not ' +
      'intended for direct operator use): skip the config-surface guard ' +
      'entirely and LEAVE the config surface uncommitted instead of ' +
      'stashing it (any other tracked dirt still stashes normally). Same ' +
      'effect as MACF_RESTART_LEAVE_CONFIG_UNCOMMITTED=1.',
    false,
  )
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd). An explicit --dir WINS over MACF_WORKSPACE_DIR — pass it to target a workspace other than your own.')
  .action(async (opts) => {
    // macf#888 — capture "was --dir passed" BEFORE `resolveProjectDir`
    // collapses the explicit-vs-auto-discovered paths into the same string
    // shape. `--dir <path>` above has no commander default (3rd arg), so
    // `opts.dir` is `undefined` exactly when the flag is absent — that's the
    // only reliable "explicit" signal (macf#347: a resolved path is truthy
    // either way and can't be used to infer this). Threaded via the shared
    // `isDirExplicit` (macf#1123) so the other three `--dir`-taking fleet
    // commands below reuse the identical predicate rather than re-deriving it.
    const dirExplicit = isDirExplicit(opts);
    const code = await runRestartSelfCommand(resolveProjectDir(opts.dir), {
      reason: opts.reason,
      confirm: opts.confirm,
      dryRun: opts.dryRun,
      json: opts.json,
      force: opts.force,
      leaveConfigUncommitted: opts.leaveConfigUncommitted,
      dirExplicit,
    });
    process.exitCode = code;
  });

const certs = program
  .command('certs')
  .description('Certificate management');

certs
  .command('init')
  .description('Create CA certificate and upload to registry')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsInit(resolveProjectDir(opts.dir));
  });

certs
  .command('recover')
  .description('Recover CA key from encrypted backup in registry')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsRecover(resolveProjectDir(opts.dir));
  });

certs
  .command('rotate')
  .description('Regenerate agent certificate with existing CA')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsRotate(resolveProjectDir(opts.dir));
  });

certs
  .command('issue-routing-client')
  .description('Mint a CA-signed client cert (CN=routing-action) for the routing Action')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--out-dir <path>', 'Write cert/key files here instead of printing to stdout')
  .option('--validity-days <n>', 'Cert validity in days (default 365; warns above 730)')
  .action(async (opts) => {
    const validityDays = opts.validityDays ? Number(opts.validityDays) : undefined;
    await issueRoutingClient(resolveProjectDir(opts.dir), {
      outDir: opts.outDir,
      validityDays,
    });
  });

program
  .command('self-update')
  .description(
    'Pull origin/main + rebuild the installed CLI\'s dist/ (for npm-link dev installs). ' +
    'Note: this command only helps CLI versions >= 0.1.1; older installs failed silently.',
  )
  .action(() => {
    try {
      selfUpdate(findCliPackageRoot());
    } catch (err) {
      console.error(`self-update failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Verify the workspace\'s bot token + settings match the role-aware floor')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--fix', 'Write the role-settings floor (allow/deny/hooks) + sandbox entries into .claude/settings.json after confirmation', false)
  .option('--yes', 'Skip the --fix confirmation prompt (non-interactive)', false)
  .action(async (opts) => {
    const code = await runDoctor(resolveProjectDir(opts.dir), { fix: opts.fix, yes: opts.yes });
    process.exitCode = code;
  });

program
  .command('whoami')
  .description(
    'Deterministic self-discovery: identity fields sourced from ' +
    '.macf/macf-agent.json or the MACF_*/APP_ID/INSTALL_ID/KEY_PATH environment — ' +
    'never inferred. A field neither source resolves reports "unknown", not a guess. ' +
    'Unlike most --dir commands this does NOT require .macf/macf-agent.json to exist: ' +
    'a linked-worktree worker (Agent(isolation:"worktree")) has only the inherited env.',
  )
  .option('--dir <path>', 'Directory to inspect (defaults to cwd; need not be a MACF project)')
  .option('--json', 'Emit the structured report as JSON for automation', false)
  .option('--no-resolve-bot-login', 'Skip the best-effort network GET /app bot_login resolution')
  .option('--no-resolve-peers', 'Skip the best-effort network peer-registry read')
  .action(async (opts) => {
    const dir = resolve(opts.dir ?? process.cwd());
    const code = await runWhoami(dir, {
      json: Boolean(opts.json),
      resolveBotLogin: opts.resolveBotLogin,
      resolvePeers: opts.resolvePeers,
    });
    process.exitCode = code;
  });

program
  .command('monitor')
  .description(
    'Read-only auditor: emit a protocol-health digest for the operator ' +
    'Aggregates open issues/PRs + reflection signals; ' +
    'surfaces drift WITHOUT acting on it. Never mutates GitHub — ' +
    'proposing/actuation is a separate, ratification-gated step.',
  )
  .addHelpText('after', `
This command is STRICTLY READ-ONLY. It issues only GitHub reads (gh issue/pr
list) + local-file reads, and writes only the digest artifact (stdout or
--output). It never creates, comments on, closes, edits, or merges anything.

Sample digest shape:

  # Protocol-Health Digest — macf
  - Repo: \`groundnuty/macf\`
  - Generated at: 2026-06-16T12:00:00Z
  - Stale threshold: 14 days
  ## Stale issues
  ### code-agent
  - #439 — register CAS/If-Match TOCTOU (40d open)
  ## PRs awaiting action
  ### Approved, unmerged
  - #511 — feat: route-receipt reconciler
  ## Aggregated reflection signals
  ### proposed_tier: canonical
  - silent-fallback last-mile gap [key: \`send-neq-receipt\`] (×2 agents)
  ## Summary
  - Open issues: 6 (stale: 1)
  ...
  > read-only report. No issues created/commented/closed/merged.
`)
  .option('--repo <owner/repo>', 'Target GitHub repo (defaults to the project\'s repo registry config)')
  .option('--since <days>', 'Stale threshold in days (open issues older than this are flagged)', '14')
  .option('--output <file>', 'Write the digest to this file instead of stdout')
  .option('--reflections-dir <path>', 'Directory of F2 reflection JSONL ledgers (default <project>/.claude/.macf/reflections)')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const sinceRaw = Number(opts.since);
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 14;
    const code = await runMonitorCommand(resolveProjectDir(opts.dir), {
      repo: opts.repo,
      since,
      output: opts.output,
      reflectionsDir: opts.reflectionsDir,
    });
    process.exitCode = code;
  });

program
  .command('propose')
  .description(
    'Auditor Plan membrane: turn reflection signals into ' +
    'RATIFIABLE rule-evolution proposals. DRY-RUN BY DEFAULT — emits a report ' +
    'and opens NOTHING. Only --file opens ratifiable auditor-proposal issues ' +
    '(create-only). The operator ratifies; the auditor never merges/applies.',
  )
  .addHelpText('after', `
TWO MODES — the distinction is load-bearing:

  (default) DRY-RUN
      Prints a Markdown report of candidate proposals + a HELD (N<threshold)
      section to stdout (or --output). Performs ZERO GitHub writes. Opens
      NOTHING. This is the safe default — run it to preview before --file.

  --file    OPEN RATIFIABLE ARTIFACTS
      Opens ONE 'auditor-proposal' issue per promoted candidate via a
      create-only seam (no merge/close/edit method exists). Needs a bot token
      (configured MACF project or GH_TOKEN). The operator ratifies each issue;
      nothing is ever auto-merged or auto-applied.

THREE SAFETY GATES (the whole safety model):
  1. N>1 = distinct AGENTS, not occurrences. A candidate promotes only when it
     recurs across >= --min-agents DISTINCT agents (default 2 / $MACF_PROPOSE_MIN_AGENTS).
     5 hits from ONE agent = N=1 -> HELD (reflection != verification).
  2. Dry-run by default (see above).
  3. No-auto-drop on invariant-touch. Candidates touching/relaxing a protected
     invariant are SURFACED + HIGH-RISK-flagged, NEVER code-dropped — the
     amendment clause lets the auditor PROPOSE an operator-ratified amendment.
     The operator (v1-manual) judges weaken-vs-amend.
`)
  .option('--repo <owner/repo>', 'Target GitHub repo (required for --file; defaults to project repo registry config when present)')
  .option('--min-agents <n>', 'Distinct-agent promotion threshold (GATE 1). Default $MACF_PROPOSE_MIN_AGENTS or 2')
  .option('--reflections-dir <path>', 'Directory of F2 reflection JSONL ledgers (default <dir>/.claude/.macf/reflections)')
  .option('--repo-root <path>', 'Framework-source repo root holding design/protected-invariants.md (default: discovered by walking up)')
  .option('--output <file>', 'Write the report to this file instead of stdout')
  .option('--file', 'Open ratifiable auditor-proposal issues (create-only). DEFAULT OFF — without this, opens NOTHING.', false)
  .option('--dir <path>', 'Project / workspace directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    const envMin = process.env['MACF_PROPOSE_MIN_AGENTS'];
    let minAgents: number | undefined;
    if (opts.minAgents !== undefined) {
      const n = Number(opts.minAgents);
      minAgents = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
    } else if (envMin !== undefined) {
      const n = Number(envMin);
      minAgents = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
    }
    const code = await runProposeCommand({
      repo: opts.repo,
      minAgents,
      reflectionsDir: opts.reflectionsDir,
      repoRoot: opts.repoRoot,
      output: opts.output,
      file: opts.file === true,
      projectDir,
    });
    process.exitCode = code;
  });

const rules = program
  .command('rules')
  .description('Canonical coordination rules distribution');

rules
  .command('refresh')
  .description('Copy canonical rules + helper scripts into a workspace\'s .claude/ (does NOT require macf init)')
  .option('--dir <path>', 'Target workspace directory (defaults to current working directory)')
  .action((opts) => {
    const target = opts.dir ? resolve(opts.dir) : process.cwd();
    try {
      rulesRefresh(target);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('cd <agent-name>')
  .description('Print agent project path (for shell: cd $(macf cd code-agent))')
  .action((agentName: string) => {
    cdAgent(agentName);
  });

program
  .command('repo-init')
  .description('Bootstrap a repo for MACF routing (generates workflow + config, creates labels)')
  .option('--repo <owner/repo>', 'Target GitHub repo (defaults to current dir\'s origin remote)')
  .option('--actions-version <version>', 'macf-actions tag to pin to', 'v1')
  .option('--agents <list>', 'Comma-separated agent names to scaffold (e.g., code-agent,science-agent)')
  .option('--session-name <name>', 'Shared tmux session name; when set with multiple --agents, each agent gets a window inside this session')
  .option('--project <name>', 'Project name for the v3 router caller\'s required `project` input (defaults to the repo name). Must match the agents\' macf-agent.json project. v3+ only.')
  .option('--registry-type <type>', 'Registry scope for the v3 router\'s registry-api-path: repo, org, or profile. v3+ only. ' +
    'Omitted (the common case): derived from a live GitHub owner-type check — org scope for an Organization owner, ' +
    'profile scope for a User owner — never the self-pointing repo scope.')
  .option('--registry-org <org>', 'Org login (for --registry-type org)')
  .option('--registry-user <user>', 'User login (for --registry-type profile)')
  .option('--force', 'Overwrite existing files', false)
  .option('--dir <path>', 'Target directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    await repoInit(projectDir, {
      repo: opts.repo,
      actionsVersion: opts.actionsVersion,
      agents: opts.agents,
      sessionName: opts.sessionName,
      project: opts.project,
      registryType: opts.registryType,
      registryOrg: opts.registryOrg,
      registryUser: opts.registryUser,
      force: opts.force,
    });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
