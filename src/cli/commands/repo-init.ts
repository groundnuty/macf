import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateToken } from '../../token.js';

export interface RepoInitOptions {
  readonly repo?: string;
  readonly actionsVersion: string;
  readonly agents?: string;
  readonly force: boolean;
  /**
   * Optional shared tmux session name. When provided alongside 2+ agents,
   * all agents share this session and each is given a `tmux_window` equal
   * to the agent name. Omit or combine with a single agent to get the
   * legacy "session per agent, no window" layout.
   */
  readonly sessionName?: string;
}

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const STATUS_LABELS: readonly LabelSpec[] = [
  { name: 'in-progress', color: 'fbca04', description: 'Actively being worked on' },
  { name: 'in-review', color: '0e8a16', description: 'PR created, awaiting review' },
  { name: 'blocked', color: 'e11d48', description: 'Needs help or input' },
  { name: 'agent-offline', color: 'b60205', description: 'Agent VM unreachable' },
];

const AGENT_LABEL_COLOR = '1d76db';

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Detect owner/repo from git remote. Uses execFileSync (no shell injection).
 */
function detectRepoFromGit(cwd: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
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

function validateVersion(version: string): void {
  const validPatterns = [/^v\d+$/, /^v\d+\.\d+$/, /^v\d+\.\d+\.\d+$/];
  const isTag = validPatterns.some(p => p.test(version));
  if (!isTag && version !== 'main') {
    process.stderr.write(
      `Warning: "${version}" is not a tag ref. Production repos should pin to a tag (v1, v1.0, or v1.0.0).\n`,
    );
  }
}

export function generateWorkflow(actionsVersion: string): string {
  return [
    'name: Agent Router',
    'on:',
    '  issues:',
    '    types: [labeled, closed]',
    '  issue_comment:',
    '    types: [created]',
    '  pull_request:',
    '    types: [opened]',
    '  pull_request_review:',
    '    types: [submitted]',
    'jobs:',
    '  route:',
    `    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@${actionsVersion}`,
    '    secrets: inherit',
    '',
  ].join('\n');
}

/**
 * Agent-config entry schema.
 *
 * `tmux_window` is optional: when present the routing workflow sends to
 * `${tmux_session}:${tmux_window}` (per-agent window inside a shared
 * session); when absent it sends to just `${tmux_session}` (legacy layout,
 * one session per agent). See groundnuty/macf#69 and the matching workflow
 * support in `groundnuty/macf-actions` v1.1.
 */
interface AgentConfigEntry {
  app_name: string;
  host: string;
  tmux_session: string;
  tmux_window?: string;
  ssh_user: string;
  tmux_bin: string;
  ssh_key_secret: string;
  /**
   * Absolute path to the agent's workspace on the remote host. When set,
   * the routing workflow invokes `$workspace_dir/.claude/scripts/tmux-send-to-claude.sh`
   * (the canonical helper shipped by #56/#61) instead of inlining the
   * tmux-submit pattern. See groundnuty/macf#71 + macf-actions v1.2.
   * Optional: absent → routing falls back to the inline pattern
   * (backward compatible with pre-v1.2 agent-router.yml).
   */
  workspace_dir?: string;
}

/**
 * Options passed to generate/patch helpers so they can compute sensible
 * default values for new entries. Owner/repo come from `--repo`; ssh_user
 * defaults to 'ubuntu' matching the other template defaults.
 */
export interface AgentEntryDefaults {
  readonly owner: string;
  readonly repo: string;
}

const DEFAULT_LABEL_TO_STATUS: Readonly<Record<string, string>> = {
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'blocked': 'Blocked',
};

interface AgentConfigFile {
  agents: Record<string, AgentConfigEntry>;
  label_to_status?: Record<string, string>;
  [key: string]: unknown;
}

function makeAgentEntry(
  agent: string,
  useWindows: boolean,
  sessionName: string | undefined,
  defaults?: AgentEntryDefaults,
): AgentConfigEntry {
  const sshUser = 'ubuntu';
  const entry: AgentConfigEntry = {
    app_name: agent,
    host: '<agent-host-ip>',
    tmux_session: useWindows ? sessionName! : agent,
    ssh_user: sshUser,
    tmux_bin: 'tmux',
    ssh_key_secret: 'AGENT_SSH_KEY',
  };
  if (useWindows) entry.tmux_window = agent;
  // Default workspace_dir = /home/<ssh_user>/repos/<owner>/<repo>. Covers
  // the common case where agents are cloned into ~/repos/<owner>/<repo>
  // on the host. Users override per-agent if their layout differs.
  if (defaults) {
    entry.workspace_dir = `/home/${sshUser}/repos/${defaults.owner}/${defaults.repo}`;
  }
  return entry;
}

export function generateAgentConfig(
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
): string {
  if (agents.length === 0) {
    return JSON.stringify({
      agents: {
        '<agent-name>': {
          app_name: '<github-app-name>',
          host: '<agent-host-ip>',
          tmux_session: '<tmux-session-name>',
          ssh_user: 'ubuntu',
          tmux_bin: 'tmux',
          ssh_key_secret: 'AGENT_SSH_KEY',
          workspace_dir: '/home/ubuntu/repos/<owner>/<repo>',
        },
      },
      label_to_status: { ...DEFAULT_LABEL_TO_STATUS },
    }, null, 2) + '\n';
  }

  const useWindows = !!sessionName && agents.length > 1;

  const agentEntries: Record<string, AgentConfigEntry> = {};
  for (const agent of agents) {
    agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults);
  }
  return JSON.stringify({
    agents: agentEntries,
    label_to_status: { ...DEFAULT_LABEL_TO_STATUS },
  }, null, 2) + '\n';
}

/**
 * Merge-preserving regenerate for #76: update only tmux_session/tmux_window
 * fields from user input, preserve app_name/host/ssh_key_secret/ssh_user
 * /tmux_bin/unknown-fields, preserve top-level label_to_status and extras.
 * Agents not in the --agents list are left alone.
 */
export function patchAgentConfig(
  existingJson: string,
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
): string {
  let parsed: AgentConfigFile;
  try {
    parsed = JSON.parse(existingJson) as AgentConfigFile;
  } catch {
    throw new Error('Existing agent-config.json is not valid JSON; aborting rather than overwrite.');
  }
  if (!parsed.agents || typeof parsed.agents !== 'object') {
    throw new Error('Existing agent-config.json has no `agents` object; aborting.');
  }

  const useWindows = !!sessionName && agents.length > 1;
  const agentEntries: Record<string, AgentConfigEntry> = { ...parsed.agents };

  for (const agent of agents) {
    const existing = parsed.agents[agent];
    if (!existing) {
      agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults);
      continue;
    }
    const patched: AgentConfigEntry = { ...existing };
    patched.tmux_session = useWindows ? sessionName! : agent;
    if (useWindows) {
      patched.tmux_window = agent;
    } else {
      delete patched.tmux_window;
    }
    if (!patched.ssh_key_secret) patched.ssh_key_secret = 'AGENT_SSH_KEY';
    // Inject workspace_dir default for old entries that lack it, so
    // existing configs self-upgrade to enable helper invocation without
    // requiring a hand-edit. Users can customize afterwards.
    if (!patched.workspace_dir && defaults) {
      patched.workspace_dir = `/home/${patched.ssh_user || 'ubuntu'}/repos/${defaults.owner}/${defaults.repo}`;
    }
    agentEntries[agent] = patched;
  }

  const out: AgentConfigFile = { ...parsed, agents: agentEntries };
  if (!out.label_to_status) {
    out.label_to_status = { ...DEFAULT_LABEL_TO_STATUS };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

export async function createLabel(
  owner: string,
  repo: string,
  token: string,
  spec: LabelSpec,
): Promise<'created' | 'exists' | 'failed'> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: spec.name,
      color: spec.color,
      description: spec.description,
    }),
  });

  if (res.status === 201) return 'created';
  if (res.status === 422) return 'exists';
  return 'failed';
}

function writeFileSafe(path: string, content: string, force: boolean): 'created' | 'skipped' {
  if (existsSync(path) && !force) {
    process.stderr.write(`Skipping existing file (use --force to overwrite): ${path}\n`);
    return 'skipped';
  }
  ensureDir(path);
  writeFileSync(path, content);
  return 'created';
}

/**
 * Bootstrap a repo for MACF routing.
 */
export async function repoInit(
  projectDir: string,
  opts: RepoInitOptions,
): Promise<void> {
  const absDir = resolve(projectDir);

  validateVersion(opts.actionsVersion);

  const repo = opts.repo ?? detectRepoFromGit(absDir);
  if (!repo) {
    throw new Error(
      '--repo required (or run from a git repo with a GitHub origin remote)',
    );
  }
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
  }
  const [owner, repoName] = parts;

  const agentList = opts.agents ? opts.agents.split(',').map(s => s.trim()).filter(Boolean) : [];

  const workflowPath = join(absDir, '.github', 'workflows', 'agent-router.yml');
  const configPath = join(absDir, '.github', 'agent-config.json');

  const workflowResult = writeFileSafe(
    workflowPath,
    generateWorkflow(opts.actionsVersion),
    opts.force,
  );
  // Merge-preserving (#76): if the config already exists and --force is
  // passed, patch tmux fields + inject missing defaults rather than
  // clobbering user-customized app_name/host/ssh_key_secret/etc.
  // Pass owner/repo so new entries AND old entries missing workspace_dir
  // get a sensible default (see #71).
  const entryDefaults: AgentEntryDefaults = { owner: owner!, repo: repoName! };
  const configContent = existsSync(configPath) && opts.force
    ? patchAgentConfig(readFileSync(configPath, 'utf-8'), agentList, opts.sessionName, entryDefaults)
    : generateAgentConfig(agentList, opts.sessionName, entryDefaults);
  const configResult = writeFileSafe(configPath, configContent, opts.force);

  const allLabels: LabelSpec[] = [...STATUS_LABELS];
  for (const agent of agentList) {
    allLabels.push({
      name: agent,
      color: AGENT_LABEL_COLOR,
      description: `Assigned to ${agent}[bot]`,
    });
  }

  let token: string;
  try {
    token = await generateToken();
  } catch (err) {
    process.stderr.write(
      `Warning: could not generate token (${err instanceof Error ? err.message : 'unknown'}). Skipping label creation.\n`,
    );
    printResults(workflowResult, configResult, [], [], []);
    printNextSteps(configResult, agentList);
    return;
  }

  const created: string[] = [];
  const existed: string[] = [];
  const failed: string[] = [];

  for (const spec of allLabels) {
    const result = await createLabel(owner, repoName, token, spec);
    if (result === 'created') created.push(spec.name);
    else if (result === 'exists') existed.push(spec.name);
    else failed.push(spec.name);
  }

  printResults(workflowResult, configResult, created, existed, failed);
  printNextSteps(configResult, agentList);
}

function printResults(
  workflowResult: 'created' | 'skipped',
  configResult: 'created' | 'skipped',
  created: readonly string[],
  existed: readonly string[],
  failed: readonly string[],
): void {
  if (workflowResult === 'created') console.log('✓ Created .github/workflows/agent-router.yml');
  if (configResult === 'created') console.log('✓ Created .github/agent-config.json');
  if (created.length > 0) console.log(`✓ Created labels: ${created.join(', ')}`);
  if (existed.length > 0) console.log(`  Labels already exist: ${existed.join(', ')}`);
  if (failed.length > 0) console.error(`✗ Failed to create labels: ${failed.join(', ')}`);
}

function printNextSteps(
  configResult: 'created' | 'skipped',
  agentList: readonly string[],
): void {
  console.log('\nNext steps:\n');
  if (configResult === 'created' && agentList.length === 0) {
    console.log('  1. Edit .github/agent-config.json to set your agents\' hosts and tmux sessions');
  } else if (configResult === 'created') {
    console.log('  1. Edit .github/agent-config.json and replace <agent-host-ip> placeholders');
  }
  console.log('  2. Set repo secrets (Settings → Secrets and variables → Actions):');
  console.log('       - AGENT_SSH_KEY: SSH private key for connecting to agent hosts');
  console.log('       - TS_OAUTH_CLIENT_ID: Tailscale OAuth client ID');
  console.log('       - TS_OAUTH_SECRET: Tailscale OAuth secret');
  console.log('  3. Install your agent GitHub Apps on this repo');
  console.log('  4. Commit and push: git add .github/ && git commit -m "chore: bootstrap MACF routing"');
}
