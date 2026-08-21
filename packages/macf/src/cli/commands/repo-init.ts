import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateToken } from '@groundnuty/macf-core';
import type { RegistryConfig, TokenSource } from '@groundnuty/macf-core';
import { registryPathPrefix } from '../registry-helper.js';
import { isValidProjectName } from '../config.js';
import { resolveActionsRefToFullTag, isImmutableActionsTag } from '../version-resolver.js';

export interface RepoInitOptions {
  readonly repo?: string;
  readonly actionsVersion: string;
  readonly agents?: string;
  readonly force: boolean;
  /**
   * Explicit App credentials for the label-creation token mint (groundnuty/macf#920)
   * — threaded by `apply-repo-init.ts` from a freshly-created App's in-memory
   * credentials so `generateToken` doesn't have to fall back to ambient
   * `GH_TOKEN`/`APP_ID`/`INSTALL_ID`/`KEY_PATH` env vars (which a Mac-side
   * `macf bootstrap apply` run never has — it operates as the OPERATOR, not
   * as the just-minted bot). Omitted (the default) preserves the exact
   * pre-#920 behavior: `generateToken()` falls through its own env-var
   * chain, degrading to a `labels: {status:'skipped'}` outcome when none of
   * those are set — the normal case for an interactive `macf repo-init`
   * run before an App/token exists yet.
   */
  readonly tokenSource?: TokenSource;
  /**
   * Optional shared tmux session name. When provided alongside 2+ agents,
   * all agents share this session and each is given a `tmux_window` equal
   * to the agent name. Omit or combine with a single agent to get the
   * legacy "session per agent, no window" layout.
   */
  readonly sessionName?: string;
  /**
   * Project name passed to the v3 reusable workflow's required `project`
   * input (macf#566). Defaults to the repo name. Must match the `project`
   * field in the agents' `.macf/macf-agent.json` — it derives the
   * `<PROJECT_SEG>_AGENT_<NAME>` registry-variable + `<PROJECT_SEG>_CA_CERT`
   * lookups. Only consumed when the pinned actions version is v3+.
   */
  readonly project?: string;
  /**
   * Registry scope for the v3 reusable workflow's `registry-api-path` input
   * (DR-006). One of `repo` (default), `org`, or `profile`. Mirrors
   * `macf init`'s `--registry-type`. Only consumed when the pinned actions
   * version is v3+; v1.x routing reads addressing from agent-config.json,
   * not the registry.
   */
  readonly registryType?: string;
  /** Org login for `--registry-type org`. */
  readonly registryOrg?: string;
  /** User login for `--registry-type profile`. */
  readonly registryUser?: string;
}

/**
 * Parse the major version from a macf-actions pin (`v3`, `v3.3.0`, `v1.2`).
 * Returns null when the ref is not a `vN[.N[.N]]` tag (e.g. a branch name).
 */
function parseActionsMajor(version: string): number | null {
  const match = /^v(\d+)(?:\.\d+){0,2}$/.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * The v3 reusable workflow (`agent-router.yml@v3+`) requires the `project`
 * input and resolves addressing from the MACF registry via `registry-api-path`
 * (macf#566). v1.x/v2.x callers must NOT pass those inputs — the v1 reusable
 * workflow declares no `workflow_call.inputs`, so an unknown `with:` key is a
 * hard error. Gate the `with:` block on a v3+ pin.
 *
 * `main` (the macf-actions default branch) currently tracks the v3 contract,
 * so it is treated as v3+.
 */
export function isV3PlusActionsVersion(version: string): boolean {
  if (version === 'main') return true;
  const major = parseActionsMajor(version);
  return major !== null && major >= 3;
}

/**
 * Build the registry config that the v3 caller's `registry-api-path` is
 * derived from. Mirrors `macf init`'s `--registry-type` switch + reuses the
 * canonical `registryPathPrefix` mapping (DR-006). `local` registries have no
 * GitHub-Actions routing path, so they are rejected here.
 */
function buildRoutingRegistry(
  opts: RepoInitOptions,
  owner: string,
  repoName: string,
): RegistryConfig {
  const regType = opts.registryType ?? 'repo';
  switch (regType) {
    case 'org':
      if (!opts.registryOrg) throw new Error('--registry-org required for org registry');
      return { type: 'org', org: opts.registryOrg };
    case 'profile':
      if (!opts.registryUser) throw new Error('--registry-user required for profile registry');
      return { type: 'profile', user: opts.registryUser };
    case 'repo':
      return { type: 'repo', owner, repo: repoName };
    case 'local':
      throw new Error(
        'local registry has no GitHub-Actions routing path; macf-actions v3 routing ' +
          'requires a GitHub-backed registry. Use --registry-type repo (default), org, or profile.',
      );
    default:
      throw new Error(`Unknown registry type: "${regType}" (expected repo, org, or profile)`);
  }
}

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/**
 * The outcome of `repoInit`'s label-creation step (groundnuty/macf#920).
 * `'skipped'` is the pre-#920 degrade (no usable token — informational, not
 * fatal, for the plain interactive CLI); `'ok'`/`'partial-failure'`
 * distinguish "every expected label is now present" from "some label POST
 * genuinely failed" so a caller with a stake in routing actually working
 * (`apply-repo-init.ts`) can tell the two apart instead of both reading as
 * "repo-init succeeded."
 */
export type LabelsOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'ok'; readonly created: readonly string[]; readonly existed: readonly string[] }
  | { readonly status: 'partial-failure'; readonly created: readonly string[]; readonly existed: readonly string[]; readonly failed: readonly string[] };

export interface RepoInitResult {
  readonly workflow: 'created' | 'skipped';
  readonly config: 'created' | 'updated' | 'skipped';
  readonly labels: LabelsOutcome;
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

/**
 * Inputs threaded into the v3 reusable workflow's `with:` block (macf#566).
 * `registryApiPath` is the DR-006 API-path prefix (no trailing
 * `/actions/variables`), e.g. `/repos/<user>/<user>` for profile scope.
 */
export interface V3WorkflowInputs {
  readonly project: string;
  readonly registryApiPath: string;
}

export function generateWorkflow(
  actionsVersion: string,
  v3Inputs?: V3WorkflowInputs,
): string {
  const lines = [
    'name: Agent Router',
    'on:',
    '  issues:',
    '    types: [labeled, closed]',
    '  issue_comment:',
    '    types: [created]',
    // macf#980: synchronize + ready_for_review added alongside opened. A PR
    // opened while mergeStateStatus DIRTY produces ZERO workflow runs at all
    // (GitHub can't build the merge ref pull_request events test), so opened
    // — the only trigger before this fix — is unreachable for that PR's
    // whole life; a later force-push only emits synchronize, which wasn't
    // subscribed. ready_for_review closes the parallel draft->ready gap
    // (#942's disclosure ladder recommends opening a PR as --draft, and a
    // draft marked ready never routed either). See the gate job below for
    // the notification-storm suppression this addition requires.
    '  pull_request:',
    '    types: [opened, ready_for_review, synchronize]',
    '  pull_request_review:',
    '    types: [submitted]',
    // CI-completion routing (macf-actions#6, v1.3+/v3+): notify an agent when a
    // PR's checks finish. Inert on older pins (the reusable workflow's
    // route-by-ci-completion job simply doesn't fire); present so the generated
    // router is byte-consistent with macf's own committed router.
    '  check_suite:',
    '    types: [completed]',
    // The caller MUST grant at least what the reusable workflow's jobs declare,
    // or the reusable-workflow call fails at composition with `startup_failure`
    // — every event is dropped and NOTHING routes. This was the icsoc-2026
    // routing outage (macf#797): a bootstrap-generated router with NO
    // permissions block silently never routed a single event from setup until
    // an operator noticed days later. `checks: read` backs the check_suite
    // CI-completion job (without it that job 403s inside the reusable workflow).
    // Mirrors macf's own committed .github/workflows/agent-router.yml.
    'permissions:',
    '  contents: read',
    '  issues: write',
    '  pull-requests: read',
    '  checks: read',
    'jobs:',
    // ─── ROUTE GATE (macf#980) ───
    // synchronize fires on EVERY push to the PR head, and route-by-mention
    // (inside the reusable workflow) re-scans the PR body for @mentions on
    // every pull_request event with no action-type discrimination — so a
    // naive, unconditional synchronize subscription would re-notify the
    // reviewer on every push during ordinary review iteration. Worse than
    // the bug it fixes. This gate restores RECOVERY-ONLY semantics for
    // synchronize: route only when NO prior pull_request-triggered "Agent
    // Router" run exists for the PR's head branch — mirroring the
    // operator's own diagnostic (`gh run list --workflow "Agent Router"
    // --json event,headBranch --jq 'select(.headBranch=="<branch>")'`). A
    // rebase that resolves the DIRTY state (or any push that is the FIRST
    // to reach a valid merge ref) is then the natural, self-healing
    // recovery.
    //
    // opened and ready_for_review are NOT gated — they always route,
    // unconditionally, same as opened did before this change. Gating
    // ready_for_review on "no prior run" would wrongly suppress it whenever
    // opened already fired for that PR — which it does today even for
    // draft PRs (route-by-mention doesn't discriminate on draft state), so
    // a question-carrying draft (per #942) would still be silenced at the
    // exact moment (ready_for_review) this fix exists to unblock.
    //
    // Also closes a synchronize/ready_for_review exposure macf#872 found in
    // opened: the caller's secrets: inherit fails the reusable-workflow
    // CALL OUTRIGHT for Dependabot-authored pull_request events (Dependabot
    // PRs get no repository-secrets access — a GitHub security control, not
    // a misconfiguration), so route: would fail at composition before any
    // step runs. Scoped to non-opened actions only, so opened's existing
    // behaviour — including its own pre-existing #872 exposure — stays
    // byte-identical; extending the guard to opened is a smaller, separate
    // follow-up (#872 tracks the general case).
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      actions: read',
    '    outputs:',
    '      should-route: ${{ steps.decide.outputs.should-route }}',
    '    steps:',
    '      - name: Decide whether to invoke the router',
    '        id: decide',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          REPO: ${{ github.repository }}',
    '          EVENT_NAME: ${{ github.event_name }}',
    '          ACTION: ${{ github.event.action }}',
    '          ACTOR: ${{ github.actor }}',
    '          HEAD_REF: ${{ github.head_ref }}',
    '          RUN_ID: ${{ github.run_id }}',
    '        run: |',
    '          set -euo pipefail',
    '',
    '          # Only pull_request events need gating — every other trigger',
    '          # (issues, issue_comment, pull_request_review, check_suite) is',
    '          # unaffected by this fix and always routes.',
    '          if [ "$EVENT_NAME" != "pull_request" ]; then',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            exit 0',
    '          fi',
    '',
    '          # #872: skip Dependabot-authored events on the actions THIS fix',
    "          # adds. `opened`'s existing (pre-#980) Dependabot exposure is left",
    '          # unchanged — see the job-level comment above.',
    '          if [ "$ACTION" != "opened" ] && [ "$ACTOR" = "dependabot[bot]" ]; then',
    '            echo "should-route=false" >> "$GITHUB_OUTPUT"',
    '            echo "skip: dependabot[bot] actor on a non-opened pull_request action"',
    '            exit 0',
    '          fi',
    '',
    '          # opened + ready_for_review: always route, unconditionally.',
    '          if [ "$ACTION" != "synchronize" ]; then',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            exit 0',
    '          fi',
    '',
    '          # synchronize: recovery-only. Route only if no PRIOR pull_request-',
    '          # triggered "Agent Router" run exists for this branch, EXCLUDING',
    '          # the run this step is itself executing in (that run already',
    '          # appears in `gh run list` — without excluding RUN_ID the query',
    '          # always finds >=1 and the gate would ALWAYS suppress, permanently',
    '          # defeating the recovery path this fix exists to restore).',
    '          PRIOR_COUNT=$(gh run list --repo "$REPO" --workflow agent-router.yml \\',
    '            --branch "$HEAD_REF" --event pull_request --json databaseId \\',
    '            | jq --arg run_id "$RUN_ID" \'[.[] | select((.databaseId | tostring) != $run_id)] | length\')',
    '',
    '          if [ "${PRIOR_COUNT:-0}" -gt 0 ]; then',
    '            echo "should-route=false" >> "$GITHUB_OUTPUT"',
    '            echo "skip: $PRIOR_COUNT prior Agent Router run(s) already exist for branch $HEAD_REF — recovery-only semantics suppress this synchronize"',
    '          else',
    '            echo "should-route=true" >> "$GITHUB_OUTPUT"',
    '            echo "route: no prior Agent Router run for branch $HEAD_REF — recovery synchronize"',
    '          fi',
    '  route:',
    '    needs: gate',
    "    if: needs.gate.outputs.should-route == 'true'",
    `    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@${actionsVersion}`,
  ];
  // The v3+ reusable workflow requires `project` and resolves addressing from
  // the registry via `registry-api-path` (macf#566). v1.x/v2.x callers must
  // omit `with:` entirely — those workflows declare no `workflow_call.inputs`,
  // and an unknown input is a hard error. Gate strictly on a v3+ pin.
  if (v3Inputs && isV3PlusActionsVersion(actionsVersion)) {
    lines.push('    with:');
    lines.push(`      project: ${v3Inputs.project}`);
    lines.push(`      registry-api-path: ${v3Inputs.registryApiPath}`);
  }
  lines.push('    secrets: inherit');
  lines.push('');
  return lines.join('\n');
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
  /**
   * Stage-2 (v1.x SSH-router) send-target: the router SSHes in and sends to
   * `${tmux_session}` (or `${tmux_session}:${tmux_window}`). Load-bearing for
   * v1.x routing (which reads addressing from this file), but VESTIGIAL on v3+
   * where routing resolves the channel endpoint from the MACF registry instead.
   * Omitted from the generated template on a v3+ pin (macf#678) so `macf routing
   * doctor`'s SESSION check reads `absent` (= PASS) rather than the false
   * `tmux_session "<label>" != "<project>@<routing-label>"` WARN — the field held
   * the bare label, never the canonical `<project>@<routing-label>` session name.
   */
  tmux_session?: string;
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
  readonly owner?: string;
  readonly repo?: string;
  /**
   * Routing "project" (macf#806). When present, a freshly-created entry's
   * `app_name` becomes `<project>-<agent>` — the GitHub App handle per
   * DR-032 (the App handle carries the `<project>-` prefix; the bare
   * `<agent>` is only the routing label/agent-config key). This is the
   * SAME value threaded into the v3 caller's `with.project` input
   * (`opts.project ?? repoName`), so a repo's agent-config.json and its
   * router agree on which project's Apps they address. Omitted (legacy
   * callers, or callers with no notion of "project") → `app_name` stays
   * the bare agent/routing label, matching pre-#806 behavior.
   */
  readonly project?: string;
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
  omitTmuxSession = false,
): AgentConfigEntry {
  const sshUser = 'ubuntu';
  // app_name is the GitHub App handle used by the router to resolve mention/
  // review participants (`${app_name}[bot]`) — NOT just a routing label. Per
  // DR-032, the App handle is `<project>-<agent>`; the bare `<agent>` is only
  // the routing-label/agent-config key. When the caller knows the project
  // (macf#806), prefix it; legacy/no-project callers keep the pre-#806
  // unprefixed default. Never append `[bot]` here — the router appends it.
  const appName = defaults?.project ? `${defaults.project}-${agent}` : agent;
  const entry: AgentConfigEntry = {
    app_name: appName,
    host: '<agent-host-ip>',
    // v3+ (registry-routed): omit the vestigial Stage-2 send-target (macf#678).
    ...(omitTmuxSession ? {} : { tmux_session: useWindows ? sessionName! : agent }),
    ssh_user: sshUser,
    tmux_bin: 'tmux',
    ssh_key_secret: 'AGENT_SSH_KEY',
  };
  if (useWindows && !omitTmuxSession) entry.tmux_window = agent;
  // Default workspace_dir = /home/<ssh_user>/repos/<owner>/<repo>. Covers
  // the common case where agents are cloned into ~/repos/<owner>/<repo>
  // on the host. Users override per-agent if their layout differs.
  if (defaults?.owner && defaults?.repo) {
    entry.workspace_dir = `/home/${sshUser}/repos/${defaults.owner}/${defaults.repo}`;
  }
  return entry;
}

export function generateAgentConfig(
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
  omitTmuxSession = false,
): string {
  if (agents.length === 0) {
    return JSON.stringify({
      agents: {
        '<agent-name>': {
          app_name: '<github-app-name>',
          host: '<agent-host-ip>',
          // v3+ (registry-routed) omits the vestigial Stage-2 send-target (macf#678).
          ...(omitTmuxSession ? {} : { tmux_session: '<tmux-session-name>' }),
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
    agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults, omitTmuxSession);
  }
  return JSON.stringify({
    agents: agentEntries,
    label_to_status: { ...DEFAULT_LABEL_TO_STATUS },
  }, null, 2) + '\n';
}

/**
 * DR-032 double-prefix repair (macf#791/#805). Before the bootstrap SKILL's
 * naming guidance was corrected, operators were told the agent NAME *was*
 * the GitHub App handle, so `--agents` got invoked with the already-prefixed
 * form (`<project>-<agent>`) and the map KEY itself ended up carrying the
 * project prefix instead of the bare routing label. `agent-config.json`'s
 * key is exactly what `route-by-label` looks the issue's clean `<role>-agent`
 * label up against — a lingering double-prefixed key means the lookup
 * silently misses (`route-by-label` skips with `exit 0`, "not an agent
 * label"), with no error anywhere (see `silent-fallback-hazards.md`). A
 * separate 2026-06-27 rename pass fixed cert CN / registry keys / tmux
 * sessions on the live icsoc-2026 fleet but missed this file, so the stale
 * key can still be sitting in an already-committed agent-config.json.
 *
 * Scope is deliberately narrow: only agents named in THIS run's `--agents`
 * list are considered (mirrors the "agents not in --agents are left alone"
 * contract of `patchAgentConfig` itself) — a blind `<project>-` prefix strip
 * over every existing key would risk false-positiving on a legitimately
 * named agent that happens to start with the project's name. And a clean
 * key is never clobbered by a stale duplicate: if both `<agent>` and
 * `<project>-<agent>` are present, the clean entry's data wins and the
 * stale duplicate is left for the operator to clean up by hand (no data is
 * silently discarded here, no destructive migration is invented — the
 * mutation is a rename, applied only when it is unambiguously safe).
 */
function normalizeDoublePrefixedKeys(
  agents: Record<string, AgentConfigEntry>,
  agentList: readonly string[],
  project: string | undefined,
): void {
  if (!project) return; // can't distinguish "double-prefixed" from "legitimately named" without it
  for (const agent of agentList) {
    if (agent in agents) continue; // clean key already present — never overwritten by a stale duplicate
    const staleKey = `${project}-${agent}`;
    if (staleKey === agent) continue; // degenerate empty-project guard
    const stale = agents[staleKey];
    if (!stale) continue;
    agents[agent] = stale;
    delete agents[staleKey];
  }
}

/**
 * Merge-preserving regenerate for #76: update only tmux_session/tmux_window
 * fields from user input, preserve app_name/host/ssh_key_secret/ssh_user
 * /tmux_bin/unknown-fields, preserve top-level label_to_status and extras.
 * Agents not in the --agents list are left alone.
 *
 * When `omitTmuxSession` is set (a v3+ registry-routed pin, macf#678) the patch
 * DELETES the vestigial `tmux_session`/`tmux_window` from re-patched entries so a
 * substrate agent re-running `macf repo-init` at v3 sheds the leftover Stage-2
 * send-target — clearing `macf routing doctor`'s false SESSION WARN.
 *
 * Before touching any entry, also repairs a DR-032 double-prefixed key left
 * over from a pre-fix bootstrap run or an incomplete rename pass (macf#805)
 * — see `normalizeDoublePrefixedKeys` above.
 */
export function patchAgentConfig(
  existingJson: string,
  agents: readonly string[],
  sessionName?: string,
  defaults?: AgentEntryDefaults,
  omitTmuxSession = false,
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

  // Repair any DR-032 double-prefixed key BEFORE the merge loop below reads
  // `parsed.agents[agent]` — normalizing in place here means the loop's
  // existing-entry lookup transparently finds the (now-renamed) entry and
  // preserves its fields, same as any other pre-existing agent (macf#805).
  normalizeDoublePrefixedKeys(parsed.agents, agents, defaults?.project);

  const useWindows = !!sessionName && agents.length > 1;
  const agentEntries: Record<string, AgentConfigEntry> = { ...parsed.agents };

  for (const agent of agents) {
    const existing = parsed.agents[agent];
    if (!existing) {
      agentEntries[agent] = makeAgentEntry(agent, useWindows, sessionName, defaults, omitTmuxSession);
      continue;
    }
    const patched: AgentConfigEntry = { ...existing };
    if (omitTmuxSession) {
      // v3+ (registry-routed): shed the vestigial Stage-2 send-target (macf#678).
      delete patched.tmux_session;
      delete patched.tmux_window;
    } else {
      patched.tmux_session = useWindows ? sessionName! : agent;
      if (useWindows) {
        patched.tmux_window = agent;
      } else {
        delete patched.tmux_window;
      }
    }
    if (!patched.ssh_key_secret) patched.ssh_key_secret = 'AGENT_SSH_KEY';
    // Inject workspace_dir default for old entries that lack it, so
    // existing configs self-upgrade to enable helper invocation without
    // requiring a hand-edit. Users can customize afterwards.
    if (!patched.workspace_dir && defaults?.owner && defaults?.repo) {
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
): Promise<RepoInitResult> {
  const absDir = resolve(projectDir);

  validateVersion(opts.actionsVersion);

  // macf#797 + operator decision 2026-07-05: the router pin must be an
  // IMMUTABLE full tag (`v3.4.1`), not a floating major/minor (`v3`/`v3.4`),
  // so a fleet never silently receives a behavioral change within a major
  // (floating `@v3` currently even lags `@v3.4.1`; behavioral shifts like
  // v3.4.0 origin-routing ship inside the major). Resolve a floating v3+ ref
  // to the latest full tag at generation time. Degrade LOUDLY — keep the
  // floating ref + warn — if GitHub is unreachable, rather than hard-fail,
  // since repo-init otherwise tolerates offline (e.g. label creation is
  // skipped without a token). Legacy v1.x/v2.x pins (operator-authored
  // substrate routers, not bootstrap-generated) are left untouched.
  let pinnedVersion = opts.actionsVersion;
  if (
    isV3PlusActionsVersion(opts.actionsVersion) &&
    !isImmutableActionsTag(opts.actionsVersion) &&
    opts.actionsVersion !== 'main'
  ) {
    const resolved = await resolveActionsRefToFullTag(opts.actionsVersion);
    if (resolved) {
      pinnedVersion = resolved;
      process.stderr.write(
        `✓ Pinned router to immutable ${resolved} (resolved from floating "${opts.actionsVersion}").\n`,
      );
    } else {
      process.stderr.write(
        `Warning: could not resolve "${opts.actionsVersion}" to an immutable full tag ` +
          `(GitHub unreachable or no matching vX.Y.Z). The router will pin the FLOATING ref ` +
          `"${opts.actionsVersion}", which can silently receive behavioral changes. ` +
          `Re-run with --actions-version vX.Y.Z to pin immutably.\n`,
      );
    }
  }

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

  // Resolve the routing "project" once — it feeds BOTH the v3 caller's
  // `with.project` input AND the agent-config.json `app_name` (macf#806): per
  // DR-032 the GitHub App handle is `<project>-<agent>`, and that's true
  // regardless of router major version (a v1.x-routed fleet still registers
  // its Apps under the prefixed handle). Computed unconditionally so
  // `app_name` is correct even on a v1.x/legacy pin.
  const project = opts.project ?? repoName!;

  // macf#566: a v3+ pin needs the `project` + `registry-api-path` inputs in the
  // generated caller; a v1.x pin must omit them. Resolve the v3 inputs only
  // when the pin is v3+ so `repo-init --actions-version v1.x` still emits a
  // valid v1 caller.
  let v3Inputs: V3WorkflowInputs | undefined;
  if (isV3PlusActionsVersion(pinnedVersion)) {
    if (!isValidProjectName(project)) {
      throw new Error(`Invalid project name "${project}": must match [a-zA-Z0-9_-]+`);
    }
    const registry = buildRoutingRegistry(opts, owner!, repoName!);
    v3Inputs = { project, registryApiPath: registryPathPrefix(registry) };
  }

  const workflowResult = writeFileSafe(
    workflowPath,
    generateWorkflow(pinnedVersion, v3Inputs),
    opts.force,
  );

  // Agent-config handling: always merge-preserve when the file exists,
  // regardless of --force (#82). Previously --force was required even to
  // add new agents to an existing config; the "fresh template wins"
  // semantic was a UX trap — users running `macf repo-init --agents foo`
  // on an existing repo saw "Skipping existing file" and thought agents
  // were scaffolded when nothing changed.
  //
  // --force now only controls the workflow file (agent-router.yml) — the
  // workflow is regenerated from scratch (no fields to preserve), so the
  // old "don't overwrite" guard still makes sense there.
  //
  // Patch is safe to call repeatedly: unchanged inputs produce the same
  // output (idempotent), new agents are added, existing agent entries
  // preserve app_name/host/ssh_key_secret/ssh_user/tmux_bin/workspace_dir,
  // and top-level label_to_status + unknown keys pass through. `project`
  // (macf#806) makes freshly-created entries' `app_name` the DR-032 App
  // handle (`<project>-<agent>`) instead of the bare routing label —
  // required for `route-by-mention`/`route-by-pr-review-state` to resolve
  // `${app_name}[bot]` against the participant's actual GitHub login.
  const entryDefaults: AgentEntryDefaults = { owner: owner!, repo: repoName!, project };
  // v3+ routing resolves the channel endpoint from the MACF registry, so the
  // agent-config.json `tmux_session` send-target is vestigial and only drives a
  // false `macf routing doctor` SESSION WARN — omit it on v3+ (macf#678). v1.x
  // still reads addressing from this file, so keep it there.
  const omitTmuxSession = isV3PlusActionsVersion(opts.actionsVersion);
  let configResult: 'created' | 'updated' | 'skipped';
  if (existsSync(configPath)) {
    const patched = patchAgentConfig(
      readFileSync(configPath, 'utf-8'),
      agentList,
      opts.sessionName,
      entryDefaults,
      omitTmuxSession,
    );
    writeFileSync(configPath, patched);
    configResult = 'updated';
  } else {
    const fresh = generateAgentConfig(agentList, opts.sessionName, entryDefaults, omitTmuxSession);
    const writeRes = writeFileSafe(configPath, fresh, false);
    configResult = writeRes;  // 'created' (file didn't exist) is the expected path
  }

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
    token = await generateToken(opts.tokenSource);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Warning: could not generate token (${reason}). Skipping label creation.\n`);
    const labels: LabelsOutcome = { status: 'skipped', reason };
    printResults(workflowResult, configResult, labels);
    printNextSteps(configResult, agentList);
    return { workflow: workflowResult, config: configResult, labels };
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

  // groundnuty/macf#920 — `failed` is NOT swallowed into the same "success"
  // shape as `created`/`existed`: a caller that threaded a real tokenSource
  // (i.e. can actually tell whether this run COULD have succeeded) needs to
  // distinguish "every expected label is present" from "the API rejected
  // some of them" — see `apply-repo-init.ts`'s use of this field.
  const labels: LabelsOutcome = failed.length === 0 ? { status: 'ok', created, existed } : { status: 'partial-failure', created, existed, failed };

  printResults(workflowResult, configResult, labels);
  printNextSteps(configResult, agentList);
  return { workflow: workflowResult, config: configResult, labels };
}

function printResults(
  workflowResult: 'created' | 'skipped',
  configResult: 'created' | 'updated' | 'skipped',
  labels: LabelsOutcome,
): void {
  if (workflowResult === 'created') console.log('✓ Created .github/workflows/agent-router.yml');
  if (configResult === 'created') console.log('✓ Created .github/agent-config.json');
  if (configResult === 'updated') console.log('✓ Patched .github/agent-config.json (preserving existing entries)');
  if (labels.status === 'skipped') return; // the "Skipping label creation" warning was already printed at the call site
  if (labels.created.length > 0) console.log(`✓ Created labels: ${labels.created.join(', ')}`);
  if (labels.existed.length > 0) console.log(`  Labels already exist: ${labels.existed.join(', ')}`);
  if (labels.status === 'partial-failure') console.error(`✗ Failed to create labels: ${labels.failed.join(', ')}`);
}

function printNextSteps(
  configResult: 'created' | 'updated' | 'skipped',
  agentList: readonly string[],
): void {
  console.log('\nNext steps:\n');
  if (configResult === 'created' && agentList.length === 0) {
    console.log('  1. Edit .github/agent-config.json to set your agents\' hosts and tmux sessions');
  } else if (configResult === 'created') {
    console.log('  1. Edit .github/agent-config.json and replace <agent-host-ip> placeholders');
  } else if (configResult === 'updated') {
    console.log('  1. Review .github/agent-config.json — existing entries preserved, only tmux fields updated');
  }
  console.log('  2. Set repo secrets (Settings → Secrets and variables → Actions):');
  console.log('       - AGENT_SSH_KEY: SSH private key for connecting to agent hosts');
  console.log('       - TS_OAUTH_CLIENT_ID: Tailscale OAuth client ID');
  console.log('       - TS_OAUTH_SECRET: Tailscale OAuth secret');
  console.log('  3. Install your agent GitHub Apps on this repo');
  console.log('  4. Commit and push: git add .github/ && git commit -m "chore: bootstrap MACF routing"');
}
