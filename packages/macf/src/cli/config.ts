import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { RegistryConfig } from '@groundnuty/macf-core';
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
 * Same charset guard as {@link assertValidProject}, applied to the
 * `<owner>` path segment (macf#1277) — a GitHub login is a subset of this
 * charset, so this is deliberately permissive rather than a strict
 * GitHub-login validator; its job is filesystem-path safety, not identity
 * validation.
 */
function assertValidOwner(owner: string): void {
  if (!isValidProjectName(owner)) {
    throw new Error(
      `Invalid owner name "${owner}": must match [a-zA-Z0-9_-]+`,
    );
  }
}

/**
 * The GitHub-account namespace a registry lives in — `org`→org,
 * `profile`→user, `repo`→owner. Moved here (from `commands/init.ts`,
 * macf#1277) so every CA-path consumer (`certs.ts`, `init.ts`,
 * `routing-doctor.ts`, plus the generated-launcher templates in
 * `env-files.ts`/`claude-sh.ts`) derives the SAME owner string from the
 * SAME registry config the SAME way, rather than each re-deriving its own
 * copy. Mirrors `bootstrap/fleet-deploy.ts`'s `manifest.owner.account` —
 * this is the standalone-`macf init`-path equivalent, derived from
 * whichever registry variant was actually resolved for this run.
 *
 * `local` registry mode has no owner-account namespace at all (no App, no
 * per-owner filesystem collision surface — DR-024's local CA lives next to
 * the registry FILE, not under `~/.macf/certs/`) — callers must dispatch
 * on `registry.type === 'local'` BEFORE reaching this helper, same as
 * `tokenSourceFromConfig`'s own contract. The throw below fails loud if
 * that invariant is ever broken, rather than silently returning a
 * placeholder owner.
 */
export function ownerAccountFromRegistry(registry: RegistryConfig): string {
  switch (registry.type) {
    case 'org':
      return registry.org;
    case 'profile':
      return registry.user;
    case 'repo':
      return registry.owner;
    case 'local':
      throw new Error('ownerAccountFromRegistry: local registry mode has no owner-account namespace to key on');
  }
}

/**
 * Per-owner, per-project CA directory (macf#1277) —
 * `~/.macf/certs/<owner>/<project>/`. Nested one level deeper than the
 * pre-#1277 shape ({@link legacyProjectCaDir}) for the SAME reason
 * `commands/init.ts::defaultAgentKeyPath` was owner-scoped in macf#1214:
 * a fleet's `<project>` name is not globally unique — one host commonly
 * provisions fleets from DIFFERENT GitHub owners, and two owners can each
 * run a fleet of the same name, colliding on one on-disk CA otherwise
 * (macf#1277's reported incident, one level up from #1214's key
 * collision). `owner` is a directory NESTING, not an invented encoding —
 * same convention as `defaultAgentKeyPath`.
 */
export function caDir(owner: string, project: string): string {
  assertValidOwner(owner);
  assertValidProject(project);
  return join(MACF_GLOBAL_DIR, 'certs', owner, project);
}

export function caCertPath(owner: string, project: string): string {
  return join(caDir(owner, project), 'ca-cert.pem');
}

export function caKeyPath(owner: string, project: string): string {
  return join(caDir(owner, project), 'ca-key.pem');
}

/**
 * The pre-#1277 project-scoped, OWNER-LESS CA directory:
 * `~/.macf/certs/<project>/` — the ONLY generation this path has ever had
 * (unlike the App key, the CA path was already project-scoped before
 * #1277; there is no flatter pre-project-scoped tier to fall back through
 * — see macf#1159's landscape table, which found the CA path "fine" at
 * the time #1157 fleet-scoped the key). Kept as a READ-ONLY back-compat
 * fallback (macf#1157/#1214's "read-old-write-new" decision, applied here
 * one level up): an operator's pre-#1277 fleet CA keeps resolving without
 * a forced migration. Nothing in this codebase ever WRITES here anymore —
 * every fresh materialization lands at the owner-scoped {@link caDir}.
 */
export function legacyProjectCaDir(project: string): string {
  assertValidProject(project);
  return join(MACF_GLOBAL_DIR, 'certs', project);
}

export function legacyProjectCaCertPath(project: string): string {
  return join(legacyProjectCaDir(project), 'ca-cert.pem');
}

export function legacyProjectCaKeyPath(project: string): string {
  return join(legacyProjectCaDir(project), 'ca-key.pem');
}

/**
 * Resolve the EFFECTIVE, EXISTING CA cert+key pair for a project —
 * existence-only "read-old" resolution (no vault to fingerprint-check
 * against at this layer; mirrors `commands/init.ts::ingestAndResolveKeyPath`'s
 * same no-vault, existence-only gating one layer up for the App key).
 * Prefers the owner-scoped conventional location; falls back to the
 * pre-#1277 project-scoped legacy location ONLY when the conventional
 * cert is absent AND a legacy cert is present at the exact anchored path
 * — never a directory scan. Falls back to the conventional (owner-scoped)
 * location when NEITHER exists, so a fresh-mint caller has the correct
 * (new) location to write to; this function itself never writes and never
 * regenerates anything.
 *
 * Used by every operator-facing / generation-time CA reader that has no
 * vault material to compare against: `commands/certs.ts` (init/recover/
 * rotate), `commands/init.ts::issueGithubModeAgentCert`,
 * `commands/routing-doctor.ts`. `bootstrap/fleet-deploy.ts` does NOT use
 * this — it has vault material available and applies its OWN
 * fingerprint-gated resolution (mirroring `resolveDefaultKeyPath`'s
 * fingerprint-gated fallback for the App key), so an unrelated fleet's
 * stale legacy CA is never silently adopted during unattended `fleet
 * deploy` materialization.
 */
export function resolveExistingCaPaths(owner: string, project: string): { readonly certPath: string; readonly keyPath: string } {
  const conventionalCert = caCertPath(owner, project);
  if (existsSync(conventionalCert)) {
    return { certPath: conventionalCert, keyPath: caKeyPath(owner, project) };
  }
  const legacyCert = legacyProjectCaCertPath(project);
  if (existsSync(legacyCert)) {
    return { certPath: legacyCert, keyPath: legacyProjectCaKeyPath(project) };
  }
  return { certPath: conventionalCert, keyPath: caKeyPath(owner, project) };
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
        'reaching this helper.',
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
  // macf#894 — a PRESENT-but-unparsable config (corrupt JSON) used to throw
  // an uncaught SyntaxError straight out of this shared function, crashing
  // every `--dir`-taking command that reads config through it (restart-self,
  // fleet doctor, status, peers, certs, monitor, ...) instead of degrading
  // the same way a schema-invalid config already does below. Malformed JSON
  // and a schema mismatch are both "present but unreadable" from every
  // caller's point of view — treat them alike: warn on stderr, return null,
  // never throw.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `Warning: ${path} is not valid JSON (run \`macf init --force\` to regenerate): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
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
