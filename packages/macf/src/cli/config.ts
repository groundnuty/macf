import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RegistryConfigSchema } from '@groundnuty/macf-core';

// --- Paths ---

export const MACF_GLOBAL_DIR = join(homedir(), '.macf');
export const AGENTS_INDEX_PATH = join(MACF_GLOBAL_DIR, 'agents.json');
export const GLOBAL_CONFIG_PATH = join(MACF_GLOBAL_DIR, 'config.json');

/**
 * Validate that a project name is safe for use as a filesystem directory.
 * Allows alphanumeric, hyphen, underscore. Rejects slashes, dots, etc.
 */
export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;
}

function assertValidProject(project: string): void {
  if (!isValidProjectName(project)) {
    throw new Error(
      `Invalid project name "${project}": must match [a-zA-Z0-9_-]+`,
    );
  }
}

/**
 * Per-project CA directory. One subdirectory per project prevents
 * collisions when multiple MACF projects share a machine.
 */
export function caDir(project: string): string {
  assertValidProject(project);
  return join(MACF_GLOBAL_DIR, 'certs', project);
}

export function caCertPath(project: string): string {
  return join(caDir(project), 'ca-cert.pem');
}

export function caKeyPath(project: string): string {
  return join(caDir(project), 'ca-key.pem');
}

/**
 * Extract TokenSource-compatible credentials from a loaded config.
 * Resolves the relative key_path against the project directory so it's
 * absolute when passed to `gh token generate`.
 *
 * Throws if `github_app` is absent — that combination means a local-mode
 * workspace whose caller mistakenly reached for the token-mint path.
 * Callers must dispatch on `registry.type === 'local'` upstream and
 * skip token-mint entirely (DR-024 §"Routing trade-offs").
 */
export function tokenSourceFromConfig(
  projectDir: string,
  config: Pick<MacfAgentConfig, 'github_app'>,
): { readonly appId: string; readonly installId: string; readonly keyPath: string } {
  if (!config.github_app) {
    throw new Error(
      'tokenSourceFromConfig called on a config without a `github_app` block ' +
        '(local-registry mode). Callers must dispatch on registry.type before ' +
        'reaching this helper. See DR-024.',
    );
  }
  return {
    appId: config.github_app.app_id,
    installId: config.github_app.install_id,
    keyPath: resolve(projectDir, config.github_app.key_path),
  };
}

/**
 * Walk up from startDir looking for .macf/macf-agent.json.
 * Returns the project root (the dir CONTAINING .macf/), or null if not found.
 *
 * Same pattern as git's discovery of .git/. Stops at the filesystem root.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  // Loop bounded by filesystem depth — terminates when dirname(dir) === dir (root).
  for (;;) {
    if (existsSync(join(dir, '.macf', 'macf-agent.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectMacfDir(projectDir: string): string {
  return join(projectDir, '.macf');
}

export function agentConfigPath(projectDir: string): string {
  return join(projectMacfDir(projectDir), 'macf-agent.json');
}

export function agentStatePath(projectDir: string): string {
  return join(projectMacfDir(projectDir), 'macf-agent.state.json');
}

export function agentCertPath(projectDir: string): string {
  return join(projectMacfDir(projectDir), 'certs', 'agent-cert.pem');
}

export function agentKeyPath(projectDir: string): string {
  return join(projectMacfDir(projectDir), 'certs', 'agent-key.pem');
}

export function agentLogPath(projectDir: string): string {
  return join(projectMacfDir(projectDir), 'logs', 'channel.log');
}

// --- Agent config (macf-agent.json) ---

// Version pin schema — strings (not enums) so odd pins are allowed if user insists.
export const VersionPinsSchema = z.object({
  cli: z.string(),
  plugin: z.string(),
  actions: z.string(),
});

export type VersionPins = z.infer<typeof VersionPinsSchema>;

export const MacfAgentConfigSchema = z.object({
  project: z.string(),
  agent_name: z.string(),
  agent_role: z.string(),
  // macf#545: the ROUTING identity — registry key + cert CN. Distinct from
  // `agent_name` (the OTEL bot-name / GitHub-attribution identity). An identity
  // is ROUTING iff a peer or the router uses it to ADDRESS or AUTHENTICATE the
  // agent against the registry slot (registry key, cert CN, /health, A2A card
  // name); it is TELEMETRY/ATTRIBUTION iff it merely describes who acted (OTEL,
  // metrics, display) → those stay `agent_name`. Optional; consumers default to
  // `agent_name` (back-compat: inert unless the substrate sets a label that
  // differs from its bot-name, e.g. devops-agent vs macf-devops-agent).
  routing_label: z.string().optional(),
  agent_type: z.enum(['permanent', 'worker']),
  // Registry union comes from registry/types.ts as the single source
  // of truth — previously inlined here with looser constraints (no
  // `.min(1)` on sub-fields). Import-based unifies the schema and
  // adopts the stricter validation automatically. Ultrareview A9.
  registry: RegistryConfigSchema,
  // Optional in local-registry mode (DR-024 / macf#322): the launcher
  // doesn't mint a GitHub App installation token, so APP_ID / INSTALL_ID /
  // KEY_PATH have nothing to point at. All GitHub-mode variants
  // (`registry.type` ∈ `repo`/`org`/`profile`) still require these fields;
  // `init.ts` enforces that pairing at write time.
  github_app: z.object({
    app_id: z.string(),
    install_id: z.string(),
    key_path: z.string(),
    // The App's real bot login (App slug + `[bot]`, e.g. `macf-auditor-agent[bot]`).
    // AUTHORITATIVE identity for the attribution hook (macf#535): `agent_name`
    // is NOT always the App slug (the auditor's agent_name is "auditor" but its
    // slug is macf-auditor-agent), so the hook must not derive the bot login
    // from agent_name. Populated by macf init/doctor (DR-028); optional so
    // pre-existing configs + local-mode stay valid.
    bot_login: z.string().optional(),
  }).optional(),
  // Host the agent advertises in its registry entry (written by the
  // channel server on bind). When unset, claude.sh falls back to
  // 127.0.0.1 — matches the plugin's existing default. Set this to a
  // Tailscale IP / DNS name when the agent is routed-to by an off-box
  // consumer (GHA runner, sibling agent on another machine). Flows to
  // (a) MACF_ADVERTISE_HOST env in claude.sh, (b) SubjectAlternativeName
  // on the agent's mTLS cert so hostname verification succeeds.
  // See macf#178.
  advertise_host: z.string().min(1).optional(),
  // Tmux session + (optional) window for the on-notify wake path
  // (macf#185). When set, the channel server's onNotify handler
  // shells out to `tmux-send-to-claude.sh <session>:<window> <prompt>`
  // after the MCP push, injecting the notification as the TUI's
  // next input turn so a running Claude actually processes the
  // new work. When unset, the wake path auto-detects from `$TMUX`
  // if the server was launched inside a tmux pane; otherwise
  // no-ops silently.
  tmux_session: z.string().min(1).optional(),
  tmux_window: z.string().min(1).optional(),
  // Optional for backward compat: legacy configs (pre-P6) lack this field.
  // `macf init --force` rewrites with resolved versions; `macf update` (PR #5) bumps.
  versions: VersionPinsSchema.optional(),
  // The branch `macf fleet upgrade` / `macf restart-self` are allowed to
  // mutate + relaunch onto (macf#755 canonical-branch guard). Per-workspace
  // override for a legitimate consumer fork whose canonical branch isn't
  // `main`. Optional; `resolveCanonicalBranch` defaults to `'main'` when
  // absent (and this field is itself overridable by `MACF_CANONICAL_BRANCH`
  // env — see that function's priority order).
  canonicalBranch: z.string().min(1).optional(),
  // The operator's own GitHub login (macf#822 Part 2, DR-026 advisory
  // reviewed). Optional — most workspaces leave this unset. When set,
  // exported as MACF_OPERATOR_LOGIN (env.identity) and consumed by
  // `check-lgtm-gate.sh`'s operator-login sanction-comment path: a PR
  // comment authored by THIS login containing the exact marker
  // `[macf-sanction-merge]` clears the LGTM gate even with no formal
  // APPROVED review. Un-forgeable because an agent cannot post a GitHub
  // comment attributed to the operator's own account — the hook verifies
  // a real artifact (the comment's author), not a self-attestation. Unset
  // → the sanction-comment path is off; the gate behaves exactly as it did
  // before #822 Part 2 (non-author APPROVED review or MACF_SKIP_LGTM_CHECK
  // only). See pr-discipline.md §"Operator-sanctioned exception (macf#822)".
  operator_login: z.string().min(1).optional(),
});

export type MacfAgentConfig = z.infer<typeof MacfAgentConfigSchema>;

/** Default canonical branch (macf#755) when neither env nor config override it. */
export const DEFAULT_CANONICAL_BRANCH = 'main';

/**
 * Resolve the branch a workspace's `macf fleet upgrade` / `macf restart-self`
 * mutations + relaunches are allowed to land on (macf#755). Priority order:
 *
 *   1. `MACF_CANONICAL_BRANCH` env override — a deliberate, process-wide
 *      override (e.g. a temporary fleet-wide migration, or a test harness).
 *   2. The workspace's own `macf-agent.json` `canonicalBranch` field — a
 *      per-workspace override for a legitimate consumer fork whose canonical
 *      branch genuinely isn't `main`.
 *   3. `DEFAULT_CANONICAL_BRANCH` (`'main'`).
 *
 * Never throws — `config` may be `null` (an unresolvable workspace) and `env`
 * defaults to `process.env`. Pure w.r.t. its inputs so both `rollFleet`'s
 * driver-level resolution (per-agent, macf-core) and `restart-self`'s
 * standalone resolution (this workspace) share the exact same precedence.
 */
export function resolveCanonicalBranch(
  config: Pick<MacfAgentConfig, 'canonicalBranch'> | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env['MACF_CANONICAL_BRANCH']?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config?.canonicalBranch?.trim();
  if (fromConfig) return fromConfig;
  return DEFAULT_CANONICAL_BRANCH;
}

// --- Agents index (agents.json) ---

export const AgentsIndexSchema = z.object({
  agents: z.array(z.string()),
});

export type AgentsIndex = z.infer<typeof AgentsIndexSchema>;

// --- Global config ---

export const GlobalConfigSchema = z.object({
  default_org: z.string().optional(),
  tailscale_hostname: z.string().optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// --- Read/Write helpers ---

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readAgentConfig(projectDir: string): MacfAgentConfig | null {
  const path = agentConfigPath(projectDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const result = MacfAgentConfigSchema.safeParse(raw);
  if (!result.success) {
    // Previously returned null silently on schema mismatch. That's a
    // silent upgrade cliff: a newer CLI expecting a new required
    // field against an old workspace config yielded no diagnostic —
    // operators saw "workspace skipped" with no explanation. Emit
    // the Zod error to stderr so the schema drift is visible.
    // Ultrareview finding (upgrade cliff).
    const formatted = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    process.stderr.write(
      `Warning: ${path} does not match current schema (run \`macf init --force\` to regenerate):\n${formatted}\n`,
    );
    return null;
  }
  if (!result.data.versions) {
    process.stderr.write(
      `Warning: ${path} has no "versions" section (legacy config). Run \`macf init --force\` to resolve pins.\n`,
    );
  }
  return result.data;
}

export function writeAgentConfig(projectDir: string, config: MacfAgentConfig): void {
  const path = agentConfigPath(projectDir);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

export function readAgentsIndex(): AgentsIndex {
  if (!existsSync(AGENTS_INDEX_PATH)) return { agents: [] };
  try {
    const raw = JSON.parse(readFileSync(AGENTS_INDEX_PATH, 'utf-8'));
    const result = AgentsIndexSchema.safeParse(raw);
    return result.success ? result.data : { agents: [] };
  } catch {
    return { agents: [] };
  }
}

export function writeAgentsIndex(index: AgentsIndex): void {
  ensureDir(AGENTS_INDEX_PATH);
  writeFileSync(AGENTS_INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
}

export function addToAgentsIndex(projectDir: string): void {
  const absPath = resolve(projectDir);
  const index = readAgentsIndex();
  if (!index.agents.includes(absPath)) {
    writeAgentsIndex({ agents: [...index.agents, absPath] });
  }
}

export function readGlobalConfig(): GlobalConfig {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    const result = GlobalConfigSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/**
 * Load all agent configs from the global index.
 * Skips entries with missing or invalid configs.
 */
export function loadAllAgents(): ReadonlyArray<{
  readonly path: string;
  readonly config: MacfAgentConfig;
}> {
  const index = readAgentsIndex();
  const results: Array<{ path: string; config: MacfAgentConfig }> = [];

  for (const agentPath of index.agents) {
    const config = readAgentConfig(agentPath);
    if (config) {
      results.push({ path: agentPath, config });
    }
  }

  return results;
}

/**
 * Same as `loadAllAgents()`, but ALSO includes the project discovered by
 * walking up from `cwd` (defaults to `process.cwd()`) when it isn't
 * already present in the global index.
 *
 * WHY (macf#959): `macf peers` / `macf status`, invoked without `--dir`,
 * drive entirely off the global index at `~/.macf/agents.json` — which is
 * populated only by `macf init` (`addToAgentsIndex`). A workspace whose
 * `.macf/macf-agent.json` genuinely exists but whose absolute path never
 * made it into (or fell out of) that index reads as `agents.length === 0`
 * even though the workspace IS configured — and the caller told the
 * operator to re-run `macf init` on an already-initialised workspace.
 * Confirmed 2026-08-17 (macf#959): `.macf/macf-agent.json` present, four
 * separate `macf peers` invocations spanning windows where the GitHub API
 * was demonstrably reachable, all reporting "No agents configured" — a
 * purely local index-miss, not an API problem (the check never reaches the
 * network; see `listPeers`/`showStatus`).
 *
 * Folding in a cwd walk-up closes the gap without changing what the global
 * index is FOR (aggregating multiple projects registered on one host) — it
 * only widens the set of sources consulted before concluding "nothing is
 * configured." A config discovered this way is exactly as valid as one
 * loaded from the index.
 */
export function loadAllAgentsWithCwdFallback(
  cwd: string = process.cwd(),
): ReadonlyArray<{ readonly path: string; readonly config: MacfAgentConfig }> {
  const fromIndex = loadAllAgents();

  const cwdRoot = findProjectRoot(cwd);
  if (!cwdRoot) return fromIndex;

  const alreadyIncluded = fromIndex.some((a) => resolve(a.path) === cwdRoot);
  if (alreadyIncluded) return fromIndex;

  const cwdConfig = readAgentConfig(cwdRoot);
  if (!cwdConfig) return fromIndex;

  return [...fromIndex, { path: cwdRoot, config: cwdConfig }];
}
