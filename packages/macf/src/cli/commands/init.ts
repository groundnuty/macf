import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  projectMacfDir, writeAgentConfig, addToAgentsIndex,
  agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor,
  isValidProjectName,
} from '../config.js';
import { createCA, loadCA } from '@groundnuty/macf-core';
import { generateAgentCert } from '@groundnuty/macf-core';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import { seedProjectRulesDir } from '../project-rules.js';
import { installGhTokenHook, installPluginSkillPermissions, installSandboxFdAllowRead, installSandboxExcludedCommands } from '../settings-writer.js';
import { fetchPluginToWorkspace, pinChannelServerVersion } from '../plugin-fetcher.js';
import { writeClaudeSh } from '../claude-sh.js';
import { writeEnvFiles } from '../env-files.js';
import {
  resolveLatestVersions, isValidSemver, isValidActionsRef,
  FALLBACK_VERSIONS, statusMessage,
} from '../version-resolver.js';
import type { MacfAgentConfig, VersionPins } from '../config.js';
import { migrateLocalToGitHub } from './migrate.js';

export interface InitOptions {
  readonly project: string;
  readonly role: string;
  readonly name?: string;
  readonly type?: string;
  /**
   * GitHub App credentials. Required for `repo` / `org` / `profile`
   * registries; not used in `local` registry mode (DR-024 / macf#322).
   * Marked optional so `--local` callers don't have to fabricate
   * placeholder values.
   */
  readonly appId?: string;
  readonly installId?: string;
  readonly keyPath?: string;
  /**
   * Source path of the downloaded App private key (.pem) to INGEST into the
   * conventional destination (`--key-path`, default `~/.macf/keys/<agent>.pem`)
   * with `0600` perms at init time. Closes the macf#530 "pointer set without
   * the thing it points to" papercut — without ingestion the operator must
   * hand-`cp` the key and a wrong path/perm surfaces later as a cryptic
   * `gh` 401, not at init.
   */
  readonly appKey?: string;
  readonly registryType?: string;
  readonly registryOrg?: string;
  readonly registryUser?: string;
  readonly registryRepo?: string;
  /**
   * Absolute path to the local-registry JSON file. Only honored when
   * `registryType === 'local'`. Defaults to
   * `~/.macf/registry/<project>.json` when unset; the operator can
   * override for non-default placement (separate disk, encrypted home,
   * etc.). DR-024 §"Default `path`".
   */
  readonly registryPath?: string;
  /**
   * One-shot migration source: read agent records from this local-registry
   * JSON file and write each into the new GitHub-backed registry. Only
   * honored when `registryType` is `repo`/`org`/`profile`. Rejected
   * combined with `--local` — local→local migration is a no-op (the
   * operator can copy/rename the file directly). DR-024 §"Migration
   * path — local → GitHub mode".
   */
  readonly migrateFrom?: string;
  /**
   * Host the channel server advertises to the registry + includes in
   * its mTLS cert SAN. When unset, launcher falls back to 127.0.0.1
   * (matches plugin default). Operators routing to agents over the
   * network (Tailscale IP / DNS) must set this. See macf#178.
   */
  readonly advertiseHost?: string;
  /**
   * Tmux session + (optional) window for the on-notify wake path
   * (macf#185). When set, the channel server's onNotify shells out
   * to tmux-send-to-claude.sh to inject the notification prompt
   * into a running Claude TUI. When unset, the server auto-detects
   * from $TMUX if launched inside a tmux pane.
   */
  readonly tmuxSession?: string;
  readonly tmuxWindow?: string;
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
 *
 * For `--local` (DR-024 / macf#322) the App-cred checks are skipped —
 * the launcher does not export APP_ID / INSTALL_ID / KEY_PATH in local
 * mode, so the values are unused. The project / role / name allowlist
 * still applies.
 */
function validateInitOpts(opts: InitOptions): void {
  if (!isValidProjectName(opts.project)) {
    throw new Error(
      `project "${opts.project}" must match [a-zA-Z0-9_-]+`,
    );
  }
  // role + name are interpolated into claude.sh shell exports the same
  // way project is. Without this check, `--name 'foo"$(evil)'` would
  // produce an injection-vulnerable launcher. Apply the same allowlist
  // as project — per ultrareview finding C2.
  if (!isValidProjectName(opts.role)) {
    throw new Error(
      `role "${opts.role}" must match [a-zA-Z0-9_-]+`,
    );
  }
  if (opts.name !== undefined && !isValidProjectName(opts.name)) {
    throw new Error(
      `name "${opts.name}" must match [a-zA-Z0-9_-]+`,
    );
  }

  if (opts.registryType === 'local') {
    // Local mode: App-cred fields are not used. Validate `registryPath`
    // if set (must be absolute, no shell-special chars — it ends up in
    // claude.sh's MACF_REGISTRY_PATH export and DR-024 specifies
    // absolute paths).
    if (opts.registryPath !== undefined) {
      if (!isAbsolute(opts.registryPath)) {
        throw new Error(
          `--path "${opts.registryPath}" must be an absolute path (DR-024 §File format)`,
        );
      }
      if (/["$`\\\n\r]/.test(opts.registryPath)) {
        throw new Error(
          `--path "${opts.registryPath}" contains a shell-unsafe character (", $, backtick, backslash, or newline)`,
        );
      }
    }
    return;
  }

  // GitHub-mode App credentials are required + must be safely-shaped
  // for shell-double-quoted template embedding. Error messages name
  // the field literally so the existing test-suite regex matches
  // (init.test.ts line 184: empty appId → /appId/).
  if (opts.appId === undefined || opts.appId === '') {
    throw new Error('appId is required (--app-id; omit only when using --local)');
  }
  if (opts.installId === undefined || opts.installId === '') {
    throw new Error('installId is required (--install-id; omit only when using --local)');
  }
  // keyPath is OPTIONAL (macf#530): when omitted it defaults to the
  // conventional ~/.macf/keys/<agent>.pem in initAgent. Only its *shape* is
  // validated here (when provided), since it embeds in the double-quoted
  // claude.sh KEY_PATH export.
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
  if (opts.keyPath !== undefined && /["$`\\\n\r]/.test(opts.keyPath)) {
    throw new Error(
      `keyPath "${opts.keyPath}" contains a shell-unsafe character (", $, backtick, backslash, or newline)`,
    );
  }
}

/**
 * Default local-registry file path per DR-024:
 * `~/.macf/registry/<project>.json` (operator-overridable via `--path`).
 *
 * Resolves `~` at init time so the on-disk config + claude.sh both carry
 * absolute paths — the launcher can't re-expand `~` after the operator
 * cd's into another repo (cross-repo cwd trap, see coordination.md
 * Token & Git Hygiene §1).
 */
export function defaultLocalRegistryPath(project: string): string {
  return join(homedir(), '.macf', 'registry', `${project}.json`);
}

/**
 * Conventional per-agent App-key destination: `~/.macf/keys/<agent>.pem`
 * (macf#530). Absolute (homedir-rooted) so the token helper resolves it from
 * any cwd — same cross-repo-cwd discipline as the registry path.
 */
export function defaultAgentKeyPath(agentName: string): string {
  return join(homedir(), '.macf', 'keys', `${agentName}.pem`);
}

/**
 * Resolve the destination App-key path and — when `--app-key <src>` is given —
 * INGEST the downloaded private key to it at `0600`. Fails loud at init time:
 *
 *  - `--app-key` pointing at a missing file → throw (operator error, named).
 *  - key absent at the destination after ingestion (no `--app-key`, none
 *    pre-placed) → loud, actionable WARNING — not a throw, because the key may
 *    legitimately be placed out-of-band, but the missing-key state must surface
 *    HERE rather than as a cryptic `gh` 401 later (the macf#530 silent-fallback:
 *    a pointer set without the thing it points to).
 *
 * Idempotent: an existing key at the destination is preserved, never clobbered
 * (key rotation is a deliberate op, not an init side effect).
 *
 * Returns the path to record in `agent_config.github_app.key_path` (the
 * conventional `~/.macf/keys/<agent>.pem` unless `--key-path` overrides).
 */
function ingestAndResolveKeyPath(opts: InitOptions, agentName: string, absDir: string): string {
  const keyPathForConfig = opts.keyPath ?? defaultAgentKeyPath(agentName);
  const destAbs = isAbsolute(keyPathForConfig)
    ? keyPathForConfig
    : resolve(absDir, keyPathForConfig);

  if (opts.appKey !== undefined && opts.appKey !== '') {
    const srcAbs = resolve(opts.appKey);
    if (!existsSync(srcAbs)) {
      throw new Error(
        `--app-key "${opts.appKey}" not found. Download the App private key (.pem) ` +
          `from the GitHub App settings page and pass its path.`,
      );
    }
    if (existsSync(destAbs)) {
      console.log(`  Key: ${destAbs} already exists — preserving (not clobbered by --app-key)`);
    } else {
      mkdirSync(dirname(destAbs), { recursive: true, mode: 0o700 });
      copyFileSync(srcAbs, destAbs);
      chmodSync(destAbs, 0o600);
      console.log(`  Key: ingested App private key → ${destAbs} (chmod 600)`);
    }
  }

  if (!existsSync(destAbs)) {
    console.warn(
      `\n  ⚠ App private key not found at ${destAbs}.\n` +
        `    Pass --app-key <downloaded .pem> to ingest it now, or place the key\n` +
        `    there yourself: cp <downloaded .pem> ${destAbs} && chmod 600 ${destAbs}\n` +
        `    Until then GH_TOKEN minting fails — gh / git push will 401.\n`,
    );
  }

  return keyPathForConfig;
}

/**
 * Local-registry directory perms enforcement per DR-024 §"Filesystem-permission
 * discipline": parent dir is `0700`, CA-key is `0600`. Creates the dir
 * if absent (with `0700` from the start so umask can't widen it). Idempotent —
 * the second agent in the same project finds the dir + chmods it again.
 */
function ensureLocalRegistryDir(registryPath: string): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode is ANDed with umask, so chmod after to guarantee 0700
  // regardless of umask. Same pattern as macf-core's CA dir creation.
  chmodSync(dir, 0o700);
}

/**
 * Local-mode CA file paths (DR-024 §"Cert flow"): co-located with the
 * registry file at `<dir>/<project>.ca.{crt,key}`.
 */
function localCaCertPath(registryPath: string, project: string): string {
  return join(dirname(registryPath), `${project}.ca.crt`);
}

function localCaKeyPath(registryPath: string, project: string): string {
  return join(dirname(registryPath), `${project}.ca.key`);
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

  // DR-024 §"Migration path": `--migrate-from local-to-local` is a no-op
  // (rename/copy the file directly). Reject loud rather than silently
  // ignore; the operator-error case where someone is targeting `--local`
  // and reaching for migration tooling deserves a clear message.
  if (regType === 'local' && opts.migrateFrom !== undefined) {
    throw new Error(
      '--migrate-from cannot be combined with --local; migration only ' +
        'applies when moving INTO a GitHub-backed registry (DR-024 §Migration path).',
    );
  }

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
    case 'local': {
      const path = opts.registryPath ?? defaultLocalRegistryPath(opts.project);
      if (!isAbsolute(path)) {
        // Defense in depth — `validateInitOpts` already caught this case
        // for explicit --path. The default path is always absolute.
        throw new Error(`local registry path must be absolute (got "${path}")`);
      }
      registry = { type: 'local', path };
      break;
    }
    default:
      throw new Error(`Unknown registry type: "${regType}"`);
  }

  // Resolve version pins (explicit flags > network-fetched latest > fallback)
  const versions = await resolveVersions(opts);

  // Resolve the App-key destination and (when --app-key is given) ingest the
  // downloaded key there at 0600, failing loud on a missing key (macf#530).
  // Local-registry mode mints no token, so it has no key.
  const githubKeyPath =
    regType === 'local' ? undefined : ingestAndResolveKeyPath(opts, agentName, absDir);

  // Write agent config. `github_app` is omitted in local-registry mode
  // (DR-024) — the launcher does not mint a token, and the schema marks
  // the field optional to encode that conditional shape.
  const config: MacfAgentConfig = {
    project: opts.project,
    agent_name: agentName,
    agent_role: opts.role,
    agent_type: (opts.type ?? 'permanent') as 'permanent' | 'worker',
    registry,
    ...(regType === 'local'
      ? {}
      : {
          github_app: {
            app_id: opts.appId!,
            install_id: opts.installId!,
            key_path: githubKeyPath!,
          },
        }),
    ...(opts.advertiseHost !== undefined ? { advertise_host: opts.advertiseHost } : {}),
    ...(opts.tmuxSession !== undefined ? { tmux_session: opts.tmuxSession } : {}),
    ...(opts.tmuxWindow !== undefined ? { tmux_window: opts.tmuxWindow } : {}),
    versions,
  };

  writeAgentConfig(absDir, config);

  // Generate per-concern env files BEFORE the launcher so claude.sh's
  // source-loop on `.claude/.macf/env.*` finds them on first invocation
  // (macf#342 PR-B). The thin claude.sh template depends on these files
  // existing — without them, identity / GitHub / certs / registry /
  // telemetry / tmux env exports are all silently absent.
  const envFilesResult = writeEnvFiles(absDir, config);
  console.log(`  Env: wrote ${envFilesResult.written.length} env file(s) to .claude/.macf/`);

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

  // Seed the project-tier rule subdir (.claude/rules/project/) with a generic,
  // format-demonstrating `.example` template (DR-026 §3 / F3, macf#501). Init
  // ships to EVERY deployment, so the seed is deployment-agnostic — it never
  // contains a macf-specific rule. The actual project rules arrive on
  // `macf update` / `macf rules refresh` from MACF_PROJECT_RULES_SOURCE
  // (env.project-rules), which init does NOT fetch (keeps init offline-safe +
  // generic).
  const seeded = seedProjectRulesDir(absDir);
  console.log(`  Rules: seeded project-tier example to .claude/rules/project/${seeded}`);

  // Copy canonical helper scripts (e.g., tmux-send-to-claude.sh) into
  // <workspace>/.claude/scripts/. Hooks in settings.local.json.example
  // call these by relative path.
  const copiedScripts = copyCanonicalScripts(absDir);
  if (copiedScripts.length > 0) {
    console.log(`  Scripts: copied ${copiedScripts.length} helper script(s) to .claude/scripts/`);
  }

  // Install the attribution-trap PreToolUse hook entry in
  // .claude/settings.json (merge-preserving). Per #140, structurally
  // blocks gh / git push calls when GH_TOKEN isn't a ghs_ bot token —
  // behavioral controls recurred the trap 5 times in a single day.
  installGhTokenHook(absDir);
  console.log(`  Hooks: installed gh-token guard in .claude/settings.json`);

  // Pre-approve the 4 macf-agent plugin skills so first-turn
  // invocations (/macf-status, /macf-issues, etc.) don't block on
  // interactive approval dialogs — essential for SessionStart
  // auto-pickup + general agent autonomy. Operator opted into the
  // plugin deliberately via `macf init`; trusting its own skills is
  // a safe default. Non-macf permissions.allow entries preserved.
  // See macf#189 sub-item 2.
  installPluginSkillPermissions(absDir);
  console.log(`  Permissions: pre-approved macf-agent plugin skills`);

  // Add `/proc/self/fd/**` to sandbox.filesystem.allowRead so Claude
  // Code's Bash-tool harness can pass command-input fds to spawned
  // shells without hitting zsh permission-denied. Every MACF agent
  // pre-#200 silently failed every Bash call; this fixes on init.
  installSandboxFdAllowRead(absDir);
  console.log(`  Sandbox: allowRead for /proc/self/fd/** installed`);

  // Install the canonical `sandbox.excludedCommands` set so dev-loop
  // commands (grep, find, bash, etc.) run unsandboxed and don't hit
  // the claude-code#43454 seccomp regression at zsh-init. Operator-
  // authored entries are preserved; opt-out via
  // MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1. See macf#211.
  installSandboxExcludedCommands(absDir);
  console.log(`  Sandbox: excludedCommands canonical set installed`);

  // Fetch the macf-agent plugin at the pinned version and place it at
  // .macf/plugin/ so claude.sh can use --plugin-dir (per DR-013).
  // Network failures here don't abort init — the workspace is usable
  // without the plugin (degrades to rules-only mode), and the user can
  // re-try with `macf update` once connectivity is back.
  try {
    fetchPluginToWorkspace(absDir, versions.plugin);
    // Pin the channel-server version in the mounted mcpServers args so a bare
    // `npx` can't serve a stale cached cs (groundnuty/macf#421). cs ships with
    // the CLI in the monorepo, so the cs version = versions.cli.
    pinChannelServerVersion(absDir, versions.cli);
    console.log(`  Plugin: fetched macf-agent@v${versions.plugin} to .macf/plugin/ (channel-server pinned @${versions.cli})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: plugin fetch failed: ${msg}`);
    console.warn(`  You can retry later with \`macf update\` once the issue is resolved.`);
  }

  // Generate agent cert. Local-registry mode (DR-024) auto-generates a
  // CA on first invocation; subsequent agents in the same project read
  // the existing CA. GitHub mode reads the per-project CA generated by
  // `macf certs init`.
  if (regType === 'local' && registry.type === 'local') {
    await initLocalModeCertsAndRegistry(absDir, registry.path, opts, agentName);
    console.log(`Agent "${agentName}" initialized in ${absDir} (local-registry mode)`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Cert:   ${agentCertPath(absDir)}`);
    console.log(`  Launcher: ${claudeShPath}`);
    console.log(`  Registry: ${registry.path}`);
    return;
  }

  // GitHub-mode cert flow (unchanged).
  const caCertFile = caCertPathFor(opts.project);
  const caKeyFile = caKeyPathFor(opts.project);
  if (existsSync(caCertFile) && existsSync(caKeyFile)) {
    try {
      const ca = loadCA(caCertFile, caKeyFile);
      await generateAgentCert({
        agentName,
        caCertPem: ca.certPem,
        caKeyPem: ca.keyPem,
        ...(opts.advertiseHost !== undefined ? { advertiseHost: opts.advertiseHost } : {}),
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

  // GitHub-mode migration: read agent records from a local-registry
  // JSON file and write each into the new GitHub-backed registry.
  // Runs AFTER agent cert is in place so the new agent can authenticate
  // immediately. Failure is non-fatal — operator can re-run `migrateFrom`
  // on a working install (init bootstrapping their own agent must
  // succeed regardless). DR-024 §"Migration path".
  if (opts.migrateFrom !== undefined) {
    try {
      await migrateLocalToGitHub(absDir, opts.migrateFrom, registry, opts.project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: migration from "${opts.migrateFrom}" failed: ${msg}`);
      console.warn(`  Re-run with \`macf init --migrate-from <path>\` after fixing the source.`);
    }
  }
}

/**
 * Local-registry mode (DR-024) cert + registry-dir bootstrap. Idempotent —
 * a second agent in the same project finds the existing CA and signs
 * its cert against it; no re-initialization or re-prompting.
 *
 * The CA lives next to the registry file at
 * `<registry-dir>/<project>.ca.{crt,key}` per DR-024 §"Cert flow":
 * the operator's filesystem ownership of the registry directory IS the
 * trust proof. No `/sign` round-trip; no GitHub-mediated identity.
 */
async function initLocalModeCertsAndRegistry(
  workspaceDir: string,
  registryPath: string,
  opts: InitOptions,
  agentName: string,
): Promise<void> {
  ensureLocalRegistryDir(registryPath);

  const caCertFile = localCaCertPath(registryPath, opts.project);
  const caKeyFile = localCaKeyPath(registryPath, opts.project);

  let caCertPem: string;
  let caKeyPem: string;

  if (existsSync(caCertFile) && existsSync(caKeyFile)) {
    // Second-or-later agent in this project — read the shared CA. The
    // diagnostic is on stderr (matches CA-key-fallback diagnostics in
    // macf-core/config.ts) so operators see which path was taken
    // without parsing structured output.
    process.stderr.write(
      `  Local registry: reusing existing CA at ${caCertFile}\n`,
    );
    const ca = loadCA(caCertFile, caKeyFile);
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
  } else {
    // First agent in this project — generate CA. Skip `client` (no
    // GitHub variables backend in local mode); CA cert lives only on
    // disk. DR-024 §"Cert flow" first-agent flow.
    process.stderr.write(
      `  Local registry: generating new CA at ${caCertFile}\n`,
    );
    const created = await createCA({
      project: opts.project,
      certPath: caCertFile,
      keyPath: caKeyFile,
    });
    caCertPem = created.certPem;
    caKeyPem = created.keyPem;
  }

  // Lock down the CA-key file mode regardless of which path was taken.
  // `createCA` already writes 0600 but a second-agent path through
  // `loadCA` doesn't re-chmod; chmoding here is idempotent + cheap.
  if (process.platform !== 'win32') {
    chmodSync(caKeyFile, 0o600);
  }

  // Generate this agent's cert against the (new or existing) CA.
  await generateAgentCert({
    agentName,
    caCertPem,
    caKeyPem,
    ...(opts.advertiseHost !== undefined ? { advertiseHost: opts.advertiseHost } : {}),
    certPath: agentCertPath(workspaceDir),
    keyPath: agentKeyPath(workspaceDir),
  });
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
