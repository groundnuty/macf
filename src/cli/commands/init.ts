import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  projectMacfDir, writeAgentConfig, addToAgentsIndex,
  agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor,
} from '../config.js';
import { loadCA } from '../../certs/ca.js';
import { generateAgentCert } from '../../certs/agent-cert.js';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import {
  resolveLatestVersions, isValidSemver, isValidActionsRef,
  FALLBACK_VERSIONS, statusMessage,
} from '../version-resolver.js';
import type { MacfAgentConfig, VersionPins } from '../config.js';

export interface InitOptions {
  readonly project: string;
  readonly role: string;
  readonly name?: string;
  readonly type?: string;
  readonly appId: string;
  readonly installId: string;
  readonly keyPath: string;
  readonly registryType?: string;
  readonly registryOrg?: string;
  readonly registryUser?: string;
  readonly registryRepo?: string;
  readonly cliVersion?: string;
  readonly pluginVersion?: string;
  readonly actionsVersion?: string;
}

/**
 * Resolve version pins: explicit flags > network-fetched latest > hardcoded fallback.
 * Validates any explicit flag against format pattern.
 */
async function resolveVersions(opts: InitOptions): Promise<VersionPins> {
  if (opts.cliVersion && !isValidSemver(opts.cliVersion)) {
    throw new Error(`--cli-version must be semver (e.g., 0.1.0), got "${opts.cliVersion}"`);
  }
  if (opts.pluginVersion && !isValidSemver(opts.pluginVersion)) {
    throw new Error(`--plugin-version must be semver (e.g., 0.1.0), got "${opts.pluginVersion}"`);
  }
  if (opts.actionsVersion && !isValidActionsRef(opts.actionsVersion)) {
    throw new Error(`--actions-version must be a tag ref (v1, v1.0, v1.0.0), got "${opts.actionsVersion}"`);
  }

  // Skip the network fetch if all three flags are explicitly set
  const allSet = opts.cliVersion && opts.pluginVersion && opts.actionsVersion;
  if (allSet) {
    return {
      cli: opts.cliVersion!,
      plugin: opts.pluginVersion!,
      actions: opts.actionsVersion!,
    };
  }

  let resolved;
  try {
    resolved = await resolveLatestVersions();
    // Print one targeted message per non-ok component so the user sees the
    // actual reason (no release, network down, malformed response) instead
    // of a single vague "network fetch failed".
    const notOk = Object.entries(resolved.sources)
      .filter(([, status]) => status !== 'ok');
    if (notOk.length > 0) {
      process.stderr.write('Warning: using default versions for some components:\n');
      for (const [component, status] of notOk) {
        process.stderr.write(`  - ${statusMessage(component, status)}\n`);
      }
    }
  } catch {
    process.stderr.write(
      'Warning: version resolution failed entirely, using hardcoded fallbacks\n',
    );
    resolved = {
      versions: FALLBACK_VERSIONS,
      sources: {
        cli: 'network_error' as const,
        plugin: 'network_error' as const,
        actions: 'network_error' as const,
      },
    };
  }

  return {
    cli: opts.cliVersion ?? resolved.versions.cli,
    plugin: opts.pluginVersion ?? resolved.versions.plugin,
    actions: opts.actionsVersion ?? resolved.versions.actions,
  };
}

/**
 * Set up a project directory for an agent.
 */
export async function initAgent(projectDir: string, opts: InitOptions): Promise<void> {
  const absDir = resolve(projectDir);
  const macfDir = projectMacfDir(absDir);
  const agentName = opts.name ?? opts.role;

  // Create directory structure
  mkdirSync(join(macfDir, 'certs'), { recursive: true });
  mkdirSync(join(macfDir, 'logs'), { recursive: true });
  mkdirSync(join(macfDir, 'plugin'), { recursive: true });

  // Build registry config
  let registry: MacfAgentConfig['registry'];
  const regType = opts.registryType ?? 'repo';

  switch (regType) {
    case 'org':
      if (!opts.registryOrg) throw new Error('--registry-org required for org registry');
      registry = { type: 'org', org: opts.registryOrg };
      break;
    case 'profile':
      if (!opts.registryUser) throw new Error('--registry-user required for profile registry');
      registry = { type: 'profile', user: opts.registryUser };
      break;
    case 'repo': {
      const repo = opts.registryRepo ?? detectRepoFromGit(absDir);
      if (!repo) throw new Error('--registry-repo required (or run from a git repo with a GitHub remote)');
      const parts = repo.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
      }
      registry = { type: 'repo', owner: parts[0], repo: parts[1] };
      break;
    }
    default:
      throw new Error(`Unknown registry type: "${regType}"`);
  }

  // Resolve version pins (explicit flags > network-fetched latest > fallback)
  const versions = await resolveVersions(opts);

  // Write agent config
  const config: MacfAgentConfig = {
    project: opts.project,
    agent_name: agentName,
    agent_role: opts.role,
    agent_type: (opts.type ?? 'permanent') as 'permanent' | 'worker',
    registry,
    github_app: {
      app_id: opts.appId,
      install_id: opts.installId,
      key_path: opts.keyPath,
    },
    versions,
  };

  writeAgentConfig(absDir, config);

  // Generate claude.sh launcher
  const claudeSh = generateClaudeSh(config);
  const claudeShPath = join(absDir, 'claude.sh');
  writeFileSync(claudeShPath, claudeSh, { mode: 0o755 });

  // Add .macf/ to .gitignore
  updateGitignore(absDir);

  // Register in global index
  addToAgentsIndex(absDir);

  // Copy canonical coordination rules into <workspace>/.claude/rules/
  // (single source of truth shipped with the CLI; refreshed by `macf update`)
  const copiedRules = copyCanonicalRules(absDir);
  if (copiedRules.length > 0) {
    console.log(`  Rules: copied ${copiedRules.length} canonical rule file(s) to .claude/rules/`);
  }

  // Copy canonical helper scripts (e.g., tmux-send-to-claude.sh) into
  // <workspace>/.claude/scripts/. Hooks in settings.local.json.example
  // call these by relative path.
  const copiedScripts = copyCanonicalScripts(absDir);
  if (copiedScripts.length > 0) {
    console.log(`  Scripts: copied ${copiedScripts.length} helper script(s) to .claude/scripts/`);
  }

  // Generate agent cert if CA key is available locally (per-project)
  const caCertFile = caCertPathFor(opts.project);
  const caKeyFile = caKeyPathFor(opts.project);
  if (existsSync(caCertFile) && existsSync(caKeyFile)) {
    try {
      const ca = loadCA(caCertFile, caKeyFile);
      await generateAgentCert({
        agentName,
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        certPath: agentCertPath(absDir),
        keyPath: agentKeyPath(absDir),
      });
      console.log(`Agent "${agentName}" initialized in ${absDir}`);
      console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
      console.log(`  Cert:   ${agentCertPath(absDir)}`);
      console.log(`  Launcher: ${claudeShPath}`);
    } catch (err) {
      console.warn(`  Warning: cert generation failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`Agent "${agentName}" initialized in ${absDir} (no cert — run macf certs rotate)`);
    }
  } else {
    console.log(`Agent "${agentName}" initialized in ${absDir}`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Launcher: ${claudeShPath}`);
    console.log(`\n  No CA found locally. To generate agent cert:`);
    console.log(`    macf certs init     (if first agent — creates CA)`);
    console.log(`    macf certs rotate   (if CA already exists)`);
  }
}

function generateClaudeSh(config: MacfAgentConfig): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `# MACF Agent Launcher: ${config.agent_name}`,
    '# Generated by macf init',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    '',
    `export MACF_AGENT_NAME="${config.agent_name}"`,
    `export MACF_PROJECT="${config.project}"`,
    `export MACF_AGENT_TYPE="${config.agent_type}"`,
    `export MACF_AGENT_ROLE="${config.agent_role}"`,
    `export APP_ID="${config.github_app.app_id}"`,
    `export INSTALL_ID="${config.github_app.install_id}"`,
    `export KEY_PATH="${config.github_app.key_path}"`,
    `export MACF_CA_CERT="$HOME/.macf/certs/${config.project}/ca-cert.pem"`,
    'export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"',
    'export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"',
    'export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"',
    'export MACF_DEBUG="${MACF_DEBUG:-false}"',
    '',
    'export GH_TOKEN=$(gh token generate --app-id "$APP_ID" --installation-id "$INSTALL_ID" --key "$KEY_PATH" | jq -r \'.token\')',
    '',
    `export GIT_AUTHOR_NAME="${config.agent_name}[bot]"`,
    `export GIT_COMMITTER_NAME="${config.agent_name}[bot]"`,
    '',
    `echo "Starting ${config.agent_name} (${config.agent_role})..."`,
    'exec claude "$@"',
    '',
  ].join('\n');
}

function updateGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  const entry = '.macf/';

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      appendFileSync(gitignorePath, `\n# MACF agent data\n${entry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `# MACF agent data\n${entry}\n`);
  }
}

/**
 * Detect owner/repo from git remote. Uses execFileSync (safe — no shell injection).
 */
function detectRepoFromGit(dir: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
    if (match) return `${match[1]}/${match[2]}`;
    return null;
  } catch {
    return null;
  }
}
