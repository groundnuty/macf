import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

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
  agent_type: z.enum(['permanent', 'worker']),
  registry: z.union([
    z.object({ type: z.literal('org'), org: z.string() }),
    z.object({ type: z.literal('profile'), user: z.string() }),
    z.object({ type: z.literal('repo'), owner: z.string(), repo: z.string() }),
  ]),
  github_app: z.object({
    app_id: z.string(),
    install_id: z.string(),
    key_path: z.string(),
  }),
  // Optional for backward compat: legacy configs (pre-P6) lack this field.
  // `macf init --force` rewrites with resolved versions; `macf update` (PR #5) bumps.
  versions: VersionPinsSchema.optional(),
});

export type MacfAgentConfig = z.infer<typeof MacfAgentConfigSchema>;

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
  if (!result.success) return null;
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
