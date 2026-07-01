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
import { runRoutingDoctor } from './commands/routing-doctor.js';
import { runRegistryPrune } from './commands/registry-prune.js';
import { runRestartSelfCommand } from './commands/restart-self.js';
import { certsInit, certsRecover, certsRotate, issueRoutingClient } from './commands/certs.js';
import { repoInit } from './commands/repo-init.js';
import { rulesRefresh } from './commands/rules-refresh.js';
import { runDoctor } from './commands/doctor.js';
import { runMonitorCommand } from './commands/monitor.js';
import { runProposeCommand } from './commands/propose.js';
import { selfUpdate } from './commands/self-update.js';
import { findProjectRoot } from './config.js';
import { findCliPackageRoot } from './rules.js';
import { packageVersionDisplay } from '../package-version.js';

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
  .requiredOption('--role <role>', 'Agent role — a canonical role (auditor, code-agent, science-agent, devops-agent, writing-agent) or a custom one. NOTE: the auditor role is the exact string "auditor" (no -agent suffix) — a near-miss silently skips its never-acts safety hook (macf#551).')
  .option('--name <name>', 'Agent name (defaults to role) — the OTEL bot-name / GitHub-attribution identity')
  .option('--routing-label <label>', 'Routing identity (registry key + cert CN), defaults to the agent name. Set only when it must differ from the bot-name, e.g. the substrate (devops-agent vs macf-devops-agent) (macf#545).')
  .option('--type <type>', 'Agent type: permanent or worker', 'permanent')
  // App-cred flags are required only for GitHub-backed registries.
  // `--local` (DR-024 / macf#322) skips token mint entirely; commander
  // can't easily express conditional-required, so accept these as
  // optional and let `validateInitOpts` enforce the pairing per
  // registry-type. Operators get an actionable error from the validator
  // rather than commander's generic missing-required message.
  .option('--app-id <id>', 'GitHub App ID (required for repo/org/profile registries)')
  .option('--install-id <id>', 'GitHub App Installation ID (required for repo/org/profile registries)')
  .option('--key-path <path>', 'Destination the App private key lives at + what env.github points to (repo/org/profile registries). Defaults to ~/.macf/keys/<agent>.pem; pass --app-key to ingest the key here at init.')
  .option('--app-key <path>', 'Source path of the downloaded App private key (.pem) to INGEST into --key-path (default ~/.macf/keys/<agent>.pem) at 0600. Onboarding: create the App -> download the .pem -> macf init --app-key <path> ... (macf#530).')
  .option('--registry-type <type>', 'Registry: repo, org, profile, or local (DR-024)', 'repo')
  .option('--registry-org <org>', 'Org name (for org registry)')
  .option('--registry-user <user>', 'User name (for profile registry)')
  .option('--registry-repo <repo>', 'owner/repo (for repo registry)')
  .option('--local', 'Shorthand for --registry-type local (DR-024). Bootstraps a single-host project without GitHub Apps; auto-generates a local CA at ~/.macf/registry/<project>.ca.{crt,key} on first invocation.')
  .option('--path <path>', 'Absolute path to the local-registry JSON file (only with --local / --registry-type=local). Defaults to ~/.macf/registry/<project>.json.')
  .option('--migrate-from <path>', 'One-shot migrate from a local-registry JSON file into the new GitHub-backed registry (DR-024 §Migration path). Rejected with --local.')
  .option('--advertise-host <host>', 'Host the channel server advertises in its registry entry + includes in its cert SAN (e.g., Tailscale IP). Defaults to 127.0.0.1 when unset.')
  .option('--tmux-session <name>', 'Tmux session name for on-notify wake (macf#185). When set, channel server\'s /notify handler injects the prompt into this tmux session via tmux-send-to-claude.sh after the MCP push. If unset, auto-detects from $TMUX.')
  .option('--tmux-window <idx-or-name>', 'Tmux window index or name within the session (e.g., "0", "cv-architect"). Optional — defaults to the session\'s current window.')
  .option('--cli-version <semver>', 'Pin @macf/cli version (e.g., 0.1.0)')
  .option('--plugin-version <semver>', 'Pin macf-agent plugin version (e.g., 0.1.0)')
  .option('--actions-version <tag>', 'Pin macf-actions version (e.g., v1, v1.0.0)')
  .option('--dir <path>', 'Project directory (defaults to current working directory)')
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
                             (e.g., #60 added --plugin-dir; #283 fixed retired :4318
                             OTLP endpoint). The generated file carries a managed-file
                             warning header.

What the flags actually control:
  --cli       bump versions.cli pin to latest
  --plugin    bump versions.plugin pin + re-fetch .macf/plugin/ if pin bumped
  --actions   bump versions.actions pin to latest
  --all       bump all three non-interactively
  --yes       skip the unified Proceed? prompt; non-interactive bypass
  --confirm   explicit opt-in to the unified preview-then-prompt flow
              (also the default for bare \`macf update\`; --yes overrides)
  --no-migrate-env-files
              skip the macf#342 monolithic→multi-file claude.sh migration
              AND env-file refresh (operator opt-out for hand-modified
              launchers; does NOT roll back already-migrated workspaces)
  --dry-run   show diff + would-bump list, write nothing

Implication for reproducible bootstrap (cv-e2e-test, harness pinning, etc.):
  The CLI BINARY's installed version determines what claude.sh template lands.
  Pin via \`npx -y @groundnuty/macf@<version> update\` instead of bare \`macf update\`
  if the bootstrap needs to use a specific binary version (vs whatever brew/system
  has). See macf#291 for the surfacing context.
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
  .option('--no-migrate-env-files', 'Skip the macf#342 monolithic→multi-file claude.sh migration AND env-file refresh (operator opt-out)')
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
  .description('Fleet roster + interconnect-health (DR-030)');

fleet
  .command('status')
  .description(
    'Roster + LIVE health for every registered agent: NAME / HOST:PORT / ' +
    'online-offline (mTLS /health) / uptime + the present self-report fields ' +
    '(instance_id, cert_expiry warn<30d/crit<7d, and idle/busy state + otel ' +
    'reachability when the agent reports them). Reachable + self-reports only — ' +
    'no inject/delivery probes (those are later DR-030 increments).',
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
  .option('--json', 'Emit the structured per-agent result as JSON (DR-031 watchdog contract)', false)
  .option('--inject', 'INVASIVE Processed-now delivery-proof: routes a real probe + wakes each reachable agent', false)
  .option('--inject-timeout <sec>', 'Per-agent poll budget for --inject, in seconds (default 24)', (v) => parseInt(v, 10))
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runFleetDoctor(resolveProjectDir(opts.dir), {
      json: opts.json,
      inject: opts.inject,
      injectTimeoutSec: opts.injectTimeout,
    });
    process.exitCode = code;
  });

fleet
  .command('install-cron')
  .description(
    'Install a HOST crontab entry that periodically runs the watchdog (`macf ' +
    'fleet reconcile`) — DR-037 / macf#686, porting devops-toolkit fleet/install-cron.sh ' +
    '(DR-006 §A.4). Host-installed so it survives a reboot (the first post-boot sweep ' +
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
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
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
    });
    process.exitCode = code;
  });

fleet
  .command('reconcile')
  .description(
    'The DR-006 desired-state reconciler (DR-037 / macf#686, porting devops-toolkit ' +
    'fleet/reconcile.sh). Probes ACTUAL state (fleet /health) and drives it toward the ' +
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
  .option('--json', 'Emit the structured sweep result as JSON (DR-031 watchdog contract)', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
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
    });
  });

fleet
  .command('resume')
  .description(
    'Nudge a STALLED idle agent to continue, or REPORT a BLOCKED one — DR-037 / ' +
    'macf#686, porting devops-toolkit fleet/resume.sh + stall-signatures.json. An idle ' +
    'agent is one of three things and only its pane tells them apart: idle-CLEAN (no ' +
    'signature) → never touched; idle-STALLED (rate-limit/turn-abort) → NUDGE (resume ' +
    'the SAME session, preserving work); idle-BLOCKED (permission/trust/skill/memory ' +
    'prompt) → REPORT (a durable operator alert, NEVER auto-answered — an authorization ' +
    'decision needs a human, DR-033). SAFETY: allowlist-only (never a blind nudge), ' +
    'idle-gated (never interrupt a busy agent), verify-resumed (a nudge that does not ' +
    'take → back off, don\'t re-spam), fire-capped per episode. The allowlist lives in ' +
    '.claude/.macf/stall-signatures.json (operator-tunable). DRY-RUN BY DEFAULT — prints ' +
    'the plan; --execute nudges / raises alerts.',
  )
  .option('--execute', 'ACTUALLY nudge / raise alerts (else dry-run: print the plan)', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runFleetResumeCommand(resolveProjectDir(opts.dir), {
      execute: Boolean(opts.execute),
    });
    process.exitCode = code;
  });

fleet
  .command('upgrade')
  .description(
    'Rolling framework-version upgrade (DR-037 / macf#682). For each selected ' +
    "fleet (a fleet == one PROJECT, macf#710 — its own CA + registry namespace, " +
    'NOT the coarser registry scope, since one profile/org registry can host ' +
    'several distinct projects), roll every agent whose RUNNING /health.version ' +
    'is behind TARGET, ONE AT A TIME: busy-gate (never interrupt a working agent — ' +
    'skip+report, or --wait for idle) → macf update → restart-self → verify /health.version ' +
    '== target (re-resolving the fresh restart-self endpoint) → next. A bad release HALTS ' +
    'the roll (and stops later fleets) so it cannot brick the fleet. DRY-RUN by default ' +
    '(prints the plan); --execute rolls. TARGET defaults to npm-latest of @groundnuty/macf.',
  )
  .option('--target <version>', 'Target framework version (default: npm-latest of @groundnuty/macf)')
  .option('--fleet <names>', 'Comma-list of fleets (project identifiers) to roll — multi-select, rolled fleet-by-fleet')
  .option('--registry <ids>', 'Comma-list of project identifiers to roll (same selector space as --fleet; historical flag name predates macf#710\'s project-based grouping)')
  .option('--execute', 'ACTUALLY roll the upgrade (default: dry-run — print the plan)', false)
  .option('--wait', 'On a busy agent, poll for idle up to a bound instead of skipping', false)
  .option('--verify-timeout <sec>', 'Per-agent verify-green budget, in seconds (default 120)', (v) => parseInt(v, 10))
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runFleetUpgrade(resolveProjectDir(opts.dir), {
      target: opts.target,
      fleet: opts.fleet,
      registry: opts.registry,
      execute: opts.execute,
      wait: opts.wait,
      verifyTimeoutSec: opts.verifyTimeout,
    });
    process.exitCode = code;
  });

const routing = program
  .command('routing')
  .description('Routing-infra (GitHub delivery plane) interconnect-health (DR-030)');

routing
  .command('doctor')
  .description(
    'Routing-infra interconnect check (DR-030 phase-2): STATIC GitHub-plane checks ' +
    'that the delivery plane is wired right — (1) CALLER-PIN consistency across the ' +
    'App install-set, (2) the #538 split: ROUTABLE (MACF_AGENT_<LABEL> registry key) ' +
    '+ SELF-SKIP (agent-config app_name == bot-login, #566), (3) registration ' +
    'FRESHNESS (registry instance_id == live /health), (4) MACF_CA_CERT present + ' +
    'parses (#563), (5) tmux_session <project>@<routing-label> convention. These prove the ' +
    'PLUMBING, NOT end-to-end delivery (that is --e2e, a later increment). Exits ' +
    'non-zero when DEGRADED.',
  )
  .option('--json', 'Emit the structured per-check result as JSON (DR-031 watchdog contract)', false)
  .option('--expected-pin <pin>', 'Expected macf-actions caller-pin (else the modal pin across the fleet)')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runRoutingDoctor(resolveProjectDir(opts.dir), {
      json: opts.json,
      expectedPin: opts.expectedPin,
    });
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
    'DR-031 piece 3 (be-replaceable): prepare the workspace + spawn a DETACHED ' +
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
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runRestartSelfCommand(resolveProjectDir(opts.dir), {
      reason: opts.reason,
      confirm: opts.confirm,
      dryRun: opts.dryRun,
      json: opts.json,
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
  .description('Mint a CA-signed client cert (CN=routing-action) for the routing Action (macf-actions#8)')
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
    'Note: this command only helps CLI versions >= 0.1.1 (#144); pre-#144 installs were silent.',
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
  .description('Verify the workspace\'s bot token (DR-019) + settings match the role-aware floor (DR-028)')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--fix', 'Write the DR-028 role-settings floor (allow/deny/hooks) + sandbox entries into .claude/settings.json after confirmation', false)
  .option('--yes', 'Skip the --fix confirmation prompt (non-interactive)', false)
  .action(async (opts) => {
    const code = await runDoctor(resolveProjectDir(opts.dir), { fix: opts.fix, yes: opts.yes });
    process.exitCode = code;
  });

program
  .command('monitor')
  .description(
    'Read-only auditor: emit a protocol-health digest for the operator ' +
    '(DR-026 F4). Aggregates open issues/PRs + F2 reflection signals; ' +
    'surfaces drift WITHOUT acting on it. Never mutates GitHub — ' +
    'proposing/actuation is a separate, ratification-gated step (DR-026 G1).',
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
  > read-only report. No issues created/commented/closed/merged. (DR-026 G1)
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
    'Auditor Plan membrane (DR-026 G1): turn F2 reflection signals into ' +
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
      nothing is ever auto-merged or auto-applied (invariants #8 + #9).

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
  .option('--registry-type <type>', 'Registry scope for the v3 router\'s registry-api-path: repo (default), org, or profile (DR-006). v3+ only.', 'repo')
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
