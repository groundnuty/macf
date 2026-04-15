#!/usr/bin/env node
import 'reflect-metadata';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { listAgents } from './commands/list.js';
import { cdAgent } from './commands/cd.js';
import { initAgent } from './commands/init.js';
import { update } from './commands/update.js';
import { showStatus } from './commands/status.js';
import { listPeers } from './commands/peers.js';
import { certsInit, certsRecover, certsRotate } from './commands/certs.js';
import { repoInit } from './commands/repo-init.js';
import { findProjectRoot } from './config.js';

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

const program = new Command();

program
  .name('macf')
  .description('Multi-Agent Coordination Framework CLI')
  .version('0.1.0')
  .action(() => {
    listAgents();
  });

program
  .command('init')
  .description('Set up a project directory for an agent')
  .requiredOption('--project <name>', 'Project name (e.g., macf)')
  .requiredOption('--role <role>', 'Agent role (e.g., code-agent)')
  .option('--name <name>', 'Agent name (defaults to role)')
  .option('--type <type>', 'Agent type: permanent or worker', 'permanent')
  .requiredOption('--app-id <id>', 'GitHub App ID')
  .requiredOption('--install-id <id>', 'GitHub App Installation ID')
  .requiredOption('--key-path <path>', 'Path to GitHub App private key')
  .option('--registry-type <type>', 'Registry: org, profile, or repo', 'repo')
  .option('--registry-org <org>', 'Org name (for org registry)')
  .option('--registry-user <user>', 'User name (for profile registry)')
  .option('--registry-repo <repo>', 'owner/repo (for repo registry)')
  .option('--cli-version <semver>', 'Pin @macf/cli version (e.g., 0.1.0)')
  .option('--plugin-version <semver>', 'Pin macf-agent plugin version (e.g., 0.1.0)')
  .option('--actions-version <tag>', 'Pin macf-actions version (e.g., v1, v1.0.0)')
  .option('--dir <path>', 'Project directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    await initAgent(projectDir, {
      project: opts.project,
      role: opts.role,
      name: opts.name,
      type: opts.type,
      appId: opts.appId,
      installId: opts.installId,
      keyPath: opts.keyPath,
      registryType: opts.registryType,
      registryOrg: opts.registryOrg,
      registryUser: opts.registryUser,
      registryRepo: opts.registryRepo,
      cliVersion: opts.cliVersion,
      pluginVersion: opts.pluginVersion,
      actionsVersion: opts.actionsVersion,
    });
  });

program
  .command('update')
  .description('Bump pinned versions in macf-agent.json (cli, plugin, actions)')
  .option('--all', 'Bump all components non-interactively', false)
  .option('--cli', 'Bump only the CLI pin', false)
  .option('--plugin', 'Bump only the plugin pin', false)
  .option('--actions', 'Bump only the actions pin', false)
  .option('--yes', 'Skip confirmation prompts', false)
  .option('--dry-run', 'Show the diff but do not write the config', false)
  .action(async (opts) => {
    const code = await update(requireProjectRoot(), {
      all: opts.all,
      cli: opts.cli,
      plugin: opts.plugin,
      actions: opts.actions,
      yes: opts.yes,
      dryRun: opts.dryRun,
    });
    process.exitCode = code;
  });

program
  .command('status')
  .description('Ping all agents and show status')
  .action(async () => {
    await showStatus();
  });

program
  .command('peers')
  .description('List peers from the registry')
  .action(async () => {
    await listPeers();
  });

const certs = program
  .command('certs')
  .description('Certificate management');

certs
  .command('init')
  .description('Create CA certificate and upload to registry')
  .action(async () => {
    await certsInit(requireProjectRoot());
  });

certs
  .command('recover')
  .description('Recover CA key from encrypted backup in registry')
  .action(async () => {
    await certsRecover(requireProjectRoot());
  });

certs
  .command('rotate')
  .description('Regenerate agent certificate with existing CA')
  .action(async () => {
    await certsRotate(requireProjectRoot());
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
  .option('--force', 'Overwrite existing files', false)
  .option('--dir <path>', 'Target directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    await repoInit(projectDir, {
      repo: opts.repo,
      actionsVersion: opts.actionsVersion,
      agents: opts.agents,
      force: opts.force,
    });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
