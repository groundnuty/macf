import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  projectMacfDir, writeAgentConfig, addToAgentsIndex,
  agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor,
  isValidProjectName,
} from '../config.js';
import { loadCA } from '../../certs/ca.js';
import { generateAgentCert } from '../../certs/agent-cert.js';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import { fetchPluginToWorkspace } from '../plugin-fetcher.js';
import { writeClaudeSh } from '../claude-sh.js';
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
 * Validate fields that end up embedded verbatim in `claude.sh` via a
 * shell double-quoted template literal (`export APP_ID="${appId}"`,
 * etc.). Reject inputs containing characters that would break quoting
 * or trigger shell expansion. Runs before any workspace state is
 * written so bad inputs fail early, not after partial init. (#105)
 */
function validateInitOpts(opts: InitOptions): void {
  if (!isValidProjectName(opts.project)) {
    throw new Error(
      `project "${opts.project}" must match [a-zA-Z0-9_-]+`,
    );
  }
  if (!/^\d+$/.test(opts.appId)) {
    throw new Error(
      `appId "${opts.appId}" must be numeric (GitHub App IDs are digits only)`,
    );
  }
  if (!/^\d+$/.test(opts.installId)) {
    throw new Error(
      `installId "${opts.installId}" must be numeric (GitHub installation IDs are digits only)`,
    );
  }
  // Shell-dangerous chars inside double-quoted context. `\` escapes in
  // double quotes; include it to avoid any sub-expansion surprise.
  if (/["$`\\\n\r]/.test(opts.keyPath)) {
    throw new Error(
      `keyPath "${opts.keyPath}" contains a shell-unsafe character (", $, backtick, backslash, or newline)`,
    );
  }
}

/**
 * Set up a project directory for an agent.
 */
export async function initAgent(projectDir: string, opts: InitOptions): Promise<void> {
  validateInitOpts(opts);

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

  // Generate claude.sh launcher.
  const claudeShPath = writeClaudeSh(absDir, config);

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

  // Fetch the macf-agent plugin at the pinned version and place it at
  // .macf/plugin/ so claude.sh can use --plugin-dir (per DR-013).
  // Network failures here don't abort init — the workspace is usable
  // without the plugin (degrades to rules-only mode), and the user can
  // re-try with `macf update` once connectivity is back.
  try {
    fetchPluginToWorkspace(absDir, versions.plugin);
    console.log(`  Plugin: fetched macf-agent@v${versions.plugin} to .macf/plugin/`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: plugin fetch failed: ${msg}`);
    console.warn(`  You can retry later with \`macf update\` once the issue is resolved.`);
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
