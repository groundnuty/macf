/**
 * macf doctor — verify the workspace's bot token satisfies the MACF App
 * permission doctrine (DR-019).
 *
 * GitHub's installation-token response body includes the permissions
 * granted to the installation, so we don't need to probe individual
 * endpoints: one `gh token generate` (without --token-only) gives us
 * the full permission map. Compare against the required set; print a
 * formatted checklist; exit 0 if satisfied, 1 if not.
 *
 * This is the automated counterpart to DR-019's manual verification
 * section. Run at onboarding time or whenever routing breaks for a
 * reason that smells like a missing permission (401 on a specific
 * endpoint while others work — see coordination.md Token & Git Hygiene
 * for the attribution-trap class this prevents).
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import {
  getHookCommands,
  getPermissionsAllow,
  getPermissionsDeny,
  getSandboxAllowRead,
  installGhTokenHook,
  installPluginSkillPermissions,
  installSandboxExcludedCommands,
  installSandboxFdAllowRead,
  SANDBOX_FD_READ_PATTERN,
} from '../settings-writer.js';
import {
  expectedAllowForRole,
  expectedHooksForRole,
  ROLE_FLOOR_DENY,
  isKnownRole,
} from '../role-settings-model.js';

/**
 * One required permission entry from DR-019.
 */
export interface RequiredPermission {
  readonly name: string;
  readonly level: 'read' | 'write';
  readonly why: string;
}

/**
 * DR-019 permission doctrine. Keep in sync with
 * design/decisions/DR-019-app-permissions.md and
 * templates/macf-app-manifest.json.
 *
 * Names here are GitHub's CANONICAL API names (as returned by
 * `GET /app/installations/:id` in the `permissions` field), which
 * differ from the App settings UI labels for some entries — notably
 * Variables → `actions_variables`. We use canonical names everywhere
 * to avoid false negatives (an installation with `actions_variables`
 * would be flagged as missing `variables` if we used the UI label).
 */
export const MACF_REQUIRED_PERMISSIONS: readonly RequiredPermission[] = [
  { name: 'metadata',          level: 'read',  why: 'Mandatory by GitHub — cannot be omitted' },
  { name: 'contents',          level: 'write', why: 'Push commits, PRs to feature branches' },
  { name: 'issues',            level: 'write', why: 'Comment, label, edit issues — primary coordination surface' },
  { name: 'pull_requests',     level: 'write', why: 'Create/merge PRs, submit reviews' },
  { name: 'actions_variables', level: 'write', why: 'Agent registry lives in repo/org/user variables (UI label: Variables)' },
  { name: 'workflows',         level: 'write', why: 'macf repo-init writes .github/workflows/' },
  { name: 'actions',           level: 'read',  why: 'gh run list / view --log-failed for self-debug' },
];

export interface DoctorFinding {
  /** Missing: the token has no entry at all for this permission. */
  readonly missing: readonly RequiredPermission[];
  /** Present but at a lower level than required (`read` where we want `write`). */
  readonly insufficient: readonly {
    readonly required: RequiredPermission;
    readonly actual: string;
  }[];
}

/**
 * Pure comparison: given the actual permission map from a token response,
 * return what's missing or insufficient against MACF_REQUIRED_PERMISSIONS.
 */
export function diffPermissions(actual: Readonly<Record<string, string>>): DoctorFinding {
  const missing: RequiredPermission[] = [];
  const insufficient: { required: RequiredPermission; actual: string }[] = [];
  for (const req of MACF_REQUIRED_PERMISSIONS) {
    const actualLevel = actual[req.name];
    if (!actualLevel) {
      missing.push(req);
      continue;
    }
    // 'write' required but only 'read' granted is a gap; the reverse
    // ('read' required with 'write' granted) is fine — user exceeds.
    if (req.level === 'write' && actualLevel === 'read') {
      insufficient.push({ required: req, actual: actualLevel });
    }
  }
  return { missing, insufficient };
}

/**
 * Symbol + label for the output table. Exported so tests can assert on it.
 */
export function formatPermissionRow(
  req: RequiredPermission,
  actual: string | undefined,
): string {
  const name = req.name.padEnd(15);
  const required = `${req.level}`.padEnd(6);
  if (!actual) {
    return `✗ ${name} required=${required} actual=MISSING    — ${req.why}`;
  }
  const actualStr = actual.padEnd(6);
  if (req.level === 'write' && actual === 'read') {
    return `⚠ ${name} required=${required} actual=${actualStr} — need write, have read`;
  }
  return `✓ ${name} required=${required} actual=${actualStr}`;
}

/**
 * Result of the sandbox-filesystem check (macf#202). PASS iff the
 * workspace's `.claude/settings.json` has `/proc/self/fd` in
 * `sandbox.filesystem.allowRead`. FAIL if absent, or if reading the
 * file threw (malformed JSON → we don't silently report PASS).
 *
 * Note: an earlier CLI version wrote `/proc/self/fd/**` (glob) which
 * the sandbox treated as a literal — silently didn't match; macf#208
 * corrected the pattern to bare `/proc/self/fd`.
 */
export interface SandboxFdCheck {
  readonly status: 'PASS' | 'FAIL';
  /** Human-readable diagnostic — e.g. JSON parse error message. Empty on PASS. */
  readonly detail: string;
}

/**
 * Pure check: does this workspace's `.claude/settings.json` contain
 * the `/proc/self/fd` sandbox pattern? See macf#200 for why this
 * matters (without it every Bash tool call fails on the harness fd),
 * and macf#208 for why the pattern is bare (not a glob).
 *
 * Uses `getSandboxAllowRead` from `settings-writer.ts` so the JSON-
 * read + deep-narrow logic lives in one place. Malformed JSON
 * surfaces as a FAIL with the parse error in `detail` — operator
 * still needs to see what broke.
 */
export function checkSandboxFdAllowRead(workspaceDir: string): SandboxFdCheck {
  let allowRead: readonly string[];
  try {
    allowRead = getSandboxAllowRead(workspaceDir);
  } catch (err) {
    return { status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  }
  if (allowRead.includes(SANDBOX_FD_READ_PATTERN)) {
    return { status: 'PASS', detail: '' };
  }
  return {
    status: 'FAIL',
    detail: `allowRead does not contain ${SANDBOX_FD_READ_PATTERN} — run \`macf update\` to refresh`,
  };
}

/**
 * Tools whose absence from `permissions.allow` blocks autonomous
 * coordination — Claude Code prompts the operator on each first
 * invocation, stalling agents that can't dismiss the prompt.
 *
 * Surfaced empirically during cv-e2e-test rehearsal #11b
 * (2026-04-30): cv-architect on `groundnuty/academic-resume` blocked
 * mid-test on a Write tool prompt because the workspace's
 * `permissions.allow` lacked `Write`. Sister CV agent
 * `cv-project-archaeologist` had the entry; this was operator-
 * authored drift.
 */
export const AUTONOMY_REQUIRED_TOOLS: readonly string[] = ['Write', 'Edit'];

/**
 * Returns true if `allow` grants the named tool unrestricted use:
 *   - Bare tool name (`"Write"`) — Claude Code's "tool only" form
 *   - Glob form (`"Write(*)"`)
 *
 * Scoped patterns like `Write(/specific/path)` are NOT considered
 * "fully present" — they cover only that path; calls to other paths
 * still prompt. Conservative-by-design: an operator with scoped Write
 * still gets a warning that surfaces the partial coverage.
 */
export function isToolFullyAllowed(allow: readonly string[], tool: string): boolean {
  return allow.includes(tool) || allow.includes(`${tool}(*)`);
}

/**
 * Returns true if `deny` has any entry referencing the named tool —
 * either bare (`"Write"`) or scoped (`"Write(/path)"`). Used to
 * contextualise an allow-list gap as deliberate (security-driven,
 * common in operator-restricted workspaces) rather than accidental
 * drift. Soft signal — doctor still warns, just with a different
 * framing.
 */
export function hasToolDeny(deny: readonly string[], tool: string): boolean {
  for (const entry of deny) {
    if (entry === tool || entry.startsWith(`${tool}(`)) return true;
  }
  return false;
}

/**
 * One per-tool finding from the permissions-allow check.
 *
 * `severity`:
 *   - `WARN` — tool absent but Bash fallback exists (Edit absent, OR
 *     Write absent + Bash present). Autonomous coordination still works
 *     for code paths that use Bash; tool-using paths prompt.
 *   - `INFO` — tool absent AND deny rule exists. Treated as deliberate
 *     operator decision (security posture) rather than drift. Surfaces
 *     the gap so it's visible, but doesn't recommend fix.
 *   - `BLOCK` — tool absent AND no fallback (Write + Edit + Bash all
 *     absent). Autonomous coordination fails entirely on first agentic
 *     file op.
 *
 * Doctor exit code is unchanged by this check (per #296 AC: warn-only,
 * no error). Severity drives output formatting + remediation suggestion.
 */
export interface PermissionFinding {
  readonly tool: string;
  readonly severity: 'WARN' | 'INFO' | 'BLOCK';
  readonly hasBashFallback: boolean;
  readonly hasDenyRule: boolean;
  readonly message: string;
  readonly remediation: string;
}

/**
 * Result of the permissions-allow check (macf#296). `findings` lists
 * one entry per missing autonomy-required tool; `status` summarises
 * across them — `PASS` if no findings, `WARN` if any non-INFO finding,
 * `INFO` if all findings are deliberate-deny cases.
 */
export interface PermissionsAllowCheckResult {
  readonly status: 'PASS' | 'WARN' | 'INFO';
  readonly findings: readonly PermissionFinding[];
  /** Set when the JSON was malformed; `findings` will be empty. */
  readonly readError?: string;
}

/**
 * Check that `permissions.allow` grants the autonomy-required tools
 * (`Write`, `Edit`). For each absent tool, build a `PermissionFinding`
 * with severity tuned to the failure mode (BLOCK if no Bash fallback,
 * WARN if Bash works, INFO if a deny rule signals deliberate scope).
 *
 * Sister CV reference: cv-project-archaeologist's settings.json has
 * Write+Edit; academic-resume drifted without them. Surfaces here at
 * health-check time rather than mid-coordination block.
 *
 * Schema reference: Claude Code permissions.allow accepts both bare
 * tool names ("Write") and patterned forms ("Write(*)", "Write(/path)").
 * Verified against the canonical settings.json schema documented in
 * Claude Code's update-config skill (stable form across recent versions).
 */
export function checkPermissionsAllow(workspaceDir: string): PermissionsAllowCheckResult {
  let allow: readonly string[];
  let deny: readonly string[];
  try {
    allow = getPermissionsAllow(workspaceDir);
    deny = getPermissionsDeny(workspaceDir);
  } catch (err) {
    return {
      status: 'WARN',
      findings: [],
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  const hasBashFallback = isToolFullyAllowed(allow, 'Bash');
  const findings: PermissionFinding[] = [];

  for (const tool of AUTONOMY_REQUIRED_TOOLS) {
    if (isToolFullyAllowed(allow, tool)) continue;

    const hasDenyRule = hasToolDeny(deny, tool);
    const isWrite = tool === 'Write';

    let severity: PermissionFinding['severity'];
    let message: string;
    if (hasDenyRule) {
      severity = 'INFO';
      message =
        `${tool} absent from permissions.allow; deny rule present — likely deliberate scope ` +
        `(security posture). Autonomous file ops via ${tool} will prompt; agents can fall ` +
        `back to Bash where allowed.`;
    } else if (isWrite && !hasBashFallback) {
      severity = 'BLOCK';
      message =
        `Write absent AND Bash absent — autonomous file creation impossible. ` +
        `Agents will block on every Write/Bash invocation waiting for operator click-through.`;
    } else {
      severity = 'WARN';
      message =
        `${tool} absent from permissions.allow — autonomous ${tool} tool calls fire interactive ` +
        `permission prompts. Sister CV agent cv-project-archaeologist has this entry; if this ` +
        `workspace is also a CV/coordination consumer, the gap is likely operator-authored drift ` +
        `(empirical incident: cv-e2e-test rehearsal #11b 2026-04-30).` +
        (isWrite ? ' Bash fallback is present, so file-write via shell still works (degraded autonomy).' : '');
    }

    const remediation =
      `Add to .claude/settings.json under permissions.allow: "${tool}" (bare; allows all paths) ` +
      `OR "${tool}(*)" (glob form). For scoped use, prefer "${tool}(/path/*)" patterns + matching ` +
      `deny rules for sensitive paths.`;

    findings.push({
      tool,
      severity,
      hasBashFallback,
      hasDenyRule,
      message,
      remediation,
    });
  }

  if (findings.length === 0) return { status: 'PASS', findings: [] };
  const allInfo = findings.every((f) => f.severity === 'INFO');
  return { status: allInfo ? 'INFO' : 'WARN', findings };
}

/**
 * Format a non-leaking error message when `gh token generate --jwt` returns
 * output that doesn't look like a JWT. Shows only the first 6 characters
 * plus length — enough to distinguish empty / error-message / binary-garbage
 * / genuinely-wrong-prefix, without exposing credential material if the
 * branch fires on a genuinely-valid JWT due to a locale/whitespace/plugin
 * edge case. See #86. Exported for unit tests.
 */
export function describeNonJwtOutput(jwt: string): string {
  const safePrefix = jwt.length > 0 ? jwt.slice(0, 6) : '(empty)';
  return (
    `gh token generate --jwt returned unexpected output ` +
    `(prefix='${safePrefix}', length=${jwt.length})`
  );
}

/**
 * Fetch the installation's GRANTED permissions by querying
 * `GET /app/installations/:id` with an App JWT. We do NOT use the
 * install-token response's `permissions` field here — it doesn't
 * surface all granted permissions (verified empirically: an App with
 * `actions_variables: write` may report an incomplete set in the
 * install-token response but the full set via JWT query). See
 * discussion on issue #74 for the evidence.
 */
export async function fetchInstallationPermissions(
  appId: string,
  installId: string,
  keyPath: string,
): Promise<Record<string, string>> {
  // Get a JWT signed with the App's private key. `gh token generate --jwt`
  // does the RS256 signing for us, avoiding a Node crypto reimplementation.
  let jwt: string;
  try {
    jwt = execFileSync('gh', [
      'token', 'generate',
      '--app-id', appId,
      '--key', keyPath,
      '--jwt',
      '--token-only',
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh token generate --jwt failed: ${msg}. ` +
      `See coordination.md Token & Git Hygiene for diagnostics.`,
      { cause: err },
    );
  }
  if (!jwt.startsWith('eyJ')) {
    throw new Error(describeNonJwtOutput(jwt));
  }

  const response = await fetch(`https://api.github.com/app/installations/${installId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(
      `GET /app/installations/${installId} returned ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await response.json()) as { permissions?: unknown };
  if (!parsed.permissions || typeof parsed.permissions !== 'object') {
    throw new Error('/app/installations/:id response missing `permissions` field');
  }
  return parsed.permissions as Record<string, string>;
}

/**
 * One finding from the DR-028 role-settings check.
 *
 * `severity`:
 *   - `ERROR` — a model-`required` item is absent. Today this is exactly the
 *     auditor's `check-auditor-never-acts.sh` hook (DR-026 F1): its absence is
 *     a missing structural safety invariant, not cosmetic drift, so it
 *     influences the doctor exit code (see `runDoctor`).
 *   - `WARN` — a recommended floor item (allow/deny/hook) is absent. Drift the
 *     operator can `--fix` or `macf update`; does NOT affect the exit code,
 *     matching the macf#296 permissions-allow check's warn-only discipline.
 */
export interface RoleSettingFinding {
  readonly category: 'allow' | 'deny' | 'hook';
  /** The expected entry — an allow/deny pattern or a hook command string. */
  readonly item: string;
  readonly severity: 'ERROR' | 'WARN';
  readonly message: string;
}

/**
 * Result of the DR-028 role-settings check (`checkRoleSettings`). `findings`
 * lists one entry per absent floor/role item; `status` summarises across them —
 * `ERROR` if any required item is missing, `WARN` if any recommended item is,
 * `PASS` otherwise. `readError` is set when settings JSON was malformed (then
 * `findings` is empty and `status` is `WARN`, mirroring `checkPermissionsAllow`).
 */
export interface RoleSettingsCheckResult {
  readonly status: 'PASS' | 'WARN' | 'ERROR';
  readonly role: string;
  readonly findings: readonly RoleSettingFinding[];
  /**
   * False when `role` is not a framework-recognized role (`KNOWN_ROLES`,
   * macf#551) — a custom role validated against the floor only. The report
   * surfaces this (INFO) so a typo on a delta-bearing safety role (e.g.
   * `auditor-agent` vs `auditor`) is visible rather than silently floor-only.
   */
  readonly roleKnown: boolean;
  readonly readError?: string;
}

/**
 * Does `allow` grant the expected floor entry? `Bash(*)` (or any `Bash(...)`
 * form) is satisfied by ANY broad Bash grant — DR-028 doctrine is that narrow
 * `Bash(...)` patterns are defeated by `$GH_TOKEN`/`$MACF_WORKSPACE_DIR`
 * expansion, so a workspace carrying bare `Bash` or `Bash(*)` satisfies the
 * floor's Bash need. Bare tool names (`Read`, `Write`, …) accept the bare or
 * `(*)` glob form via `isToolFullyAllowed`. Other patterned entries (e.g. a
 * role-delta MCP allow string) require an exact match.
 */
function allowSatisfies(allow: readonly string[], expected: string): boolean {
  if (expected === 'Bash' || expected.startsWith('Bash(')) {
    return isToolFullyAllowed(allow, 'Bash');
  }
  if (!expected.includes('(')) {
    return isToolFullyAllowed(allow, expected);
  }
  return allow.includes(expected);
}

function allowFindings(allow: readonly string[], role: string): RoleSettingFinding[] {
  const findings: RoleSettingFinding[] = [];
  for (const expected of expectedAllowForRole(role)) {
    if (!allowSatisfies(allow, expected)) {
      findings.push({
        category: 'allow',
        item: expected,
        severity: 'WARN',
        message: `floor allow entry "${expected}" absent from permissions.allow`,
      });
    }
  }
  return findings;
}

function denyFindings(deny: readonly string[]): RoleSettingFinding[] {
  const findings: RoleSettingFinding[] = [];
  for (const entry of ROLE_FLOOR_DENY) {
    if (!deny.includes(entry)) {
      findings.push({
        category: 'deny',
        item: entry,
        severity: 'WARN',
        message: `floor deny entry "${entry}" absent from permissions.deny`,
      });
    }
  }
  return findings;
}

function hookFindings(commands: readonly string[], role: string): RoleSettingFinding[] {
  const findings: RoleSettingFinding[] = [];
  for (const hook of expectedHooksForRole(role)) {
    if (commands.includes(hook.command)) continue;
    const where = `${hook.event}${hook.matcher ? ` / ${hook.matcher}` : ''}`;
    findings.push({
      category: 'hook',
      item: hook.command,
      severity: hook.required ? 'ERROR' : 'WARN',
      message: `${hook.required ? 'REQUIRED hook' : 'hook'} (${where}) not wired in settings`,
    });
  }
  return findings;
}

/**
 * DR-028 increment 2: validate `.claude/settings.json` (merged with
 * settings.local.json) against the role-aware expected-settings model for
 * `role`. Compares the effective allow/deny/hooks to `expectedAllowForRole` +
 * `ROLE_FLOOR_DENY` + `expectedHooksForRole`. A missing model-`required` hook
 * (the auditor's never-acts hook) is an `ERROR`; everything else is `WARN`
 * drift. Robust to malformed settings (try/catch → `readError`), like
 * `checkPermissionsAllow`.
 */
export function checkRoleSettings(workspaceDir: string, role: string): RoleSettingsCheckResult {
  let allow: readonly string[];
  let deny: readonly string[];
  let commands: readonly string[];
  try {
    allow = getPermissionsAllow(workspaceDir);
    deny = getPermissionsDeny(workspaceDir);
    commands = getHookCommands(workspaceDir);
  } catch (err) {
    return {
      status: 'WARN',
      role,
      findings: [],
      roleKnown: isKnownRole(role),
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  const findings: RoleSettingFinding[] = [
    ...allowFindings(allow, role),
    ...denyFindings(deny),
    ...hookFindings(commands, role),
  ];

  const status: RoleSettingsCheckResult['status'] =
    findings.some((f) => f.severity === 'ERROR') ? 'ERROR'
    : findings.length > 0 ? 'WARN'
    : 'PASS';
  return { status, role, findings, roleKnown: isKnownRole(role) };
}

/**
 * Infer the workspace's role from `macf-agent.json` (`agent_role`). Returns
 * `null` when indeterminable (no config / no role) — the doctor then WARNs and
 * skips role-settings validation rather than guessing a role.
 */
export function inferRole(workspaceDir: string): string | null {
  return readAgentConfig(workspaceDir)?.agent_role ?? null;
}

/** Prompt the operator for a y/N confirmation on stdin. Default = No. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Print the DR-028 "Role settings" report section for the given check. */
function printRoleSettingsSection(role: string | null, check: RoleSettingsCheckResult | null): void {
  console.log('');
  console.log('Role settings (DR-028)');
  console.log('──────────────────────────────────────────────────────────────');
  if (!role || !check) {
    console.log('  ⚠ role indeterminable — skipping role-settings validation');
    console.log('    (no macf-agent.json / no agent_role; run `macf init` first)');
    return;
  }
  if (check.readError) {
    console.log(`  ⚠ could not parse .claude/settings.json: ${check.readError}`);
    return;
  }
  // macf#551: surface a non-canonical role so a typo on a delta-bearing safety
  // role (e.g. `auditor-agent` vs the exact `auditor`, which would silently skip
  // the never-acts hook + its ERROR) is visible rather than degrading to
  // floor-only without a signal.
  if (!check.roleKnown) {
    console.log(
      `  ℹ role "${role}" is not a canonical MACF role — validated against the floor only.`,
    );
    console.log(
      '    If this should be a delta-bearing role (e.g. the auditor → exact "auditor", no -agent suffix), check for a typo.',
    );
  }
  if (check.status === 'PASS') {
    console.log(`  ✓ role "${role}" settings match the DR-028 floor + role deltas  [PASS]`);
    return;
  }
  const errors = check.findings.filter((f) => f.severity === 'ERROR');
  const warns = check.findings.filter((f) => f.severity === 'WARN');
  const symbol = check.status === 'ERROR' ? '✗' : '⚠';
  console.log(
    `  ${symbol} role "${role}": ${errors.length} error(s), ${warns.length} drift item(s)  [${check.status}]`,
  );
  for (const f of check.findings) {
    const fs = f.severity === 'ERROR' ? '✗' : '⚠';
    console.log(`    ${fs} [${f.category}] ${f.message}`);
  }
  console.log('    Fix: run `macf doctor --fix` (writes the floor after confirmation) or `macf update`.');
}

/** Options for `runDoctor`. */
export interface RunDoctorOptions {
  /** Write the DR-028 floor (allow/deny/hooks) + sandbox entries after consent. */
  readonly fix?: boolean;
  /** Skip the `--fix` confirmation prompt (non-interactive). */
  readonly yes?: boolean;
}

/**
 * Main entry for `macf doctor`. Prints the DR-019 token report, the sandbox-fd
 * + macf#296 permissions checks, and the DR-028 role-settings report; returns
 * the shell exit code.
 *
 * Exit-code discipline:
 *   - DR-019 missing/insufficient permission → 1 (unchanged).
 *   - Sandbox fd FAIL → 1 (unchanged).
 *   - DR-028 role-settings ERROR (auditor never-acts hook absent) → 1. This is
 *     a missing structural safety invariant, treated like a missing required
 *     permission. Plain WARN drift (allow/deny/hook gaps) does NOT affect the
 *     exit code — same warn-only posture as the macf#296 permissions check.
 *   - A failed/unreachable DR-019 token check is non-fatal to the rest of the
 *     report (so `--fix` of the local settings floor still runs offline) but
 *     still contributes 1 to the exit code.
 */
export async function runDoctor(projectDir: string, opts?: RunDoctorOptions): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }

  // DR-019 token/permission check. Local-registry mode (DR-024) has no App, so
  // there's nothing to mint — skip it. A network/token failure is recorded but
  // non-fatal so the local-settings sections (+ `--fix`) still run offline.
  let permissions: Record<string, string> | null = null;
  let tokenError: string | null = null;
  let tokenSkipped = false;
  if (config.registry.type === 'local') {
    tokenSkipped = true;
  } else {
    try {
      const source = tokenSourceFromConfig(projectDir, config);
      permissions = await fetchInstallationPermissions(
        source.appId, source.installId, source.keyPath,
      );
    } catch (err) {
      tokenError = err instanceof Error ? err.message : String(err);
    }
  }

  console.log('MACF doctor report');
  console.log('──────────────────────────────────────────────────────────────');
  let permissionsFailed = false;
  if (tokenSkipped) {
    console.log('  ℹ local-registry mode (DR-024) — no GitHub App; DR-019 token check skipped.');
  } else if (tokenError || !permissions) {
    permissionsFailed = true;
    console.error(`  ✗ DR-019 token check failed: ${tokenError ?? 'unknown error'}`);
    console.error('    See coordination.md Token & Git Hygiene for diagnostics.');
  } else {
    const finding = diffPermissions(permissions);
    for (const req of MACF_REQUIRED_PERMISSIONS) {
      console.log(`  ${formatPermissionRow(req, permissions[req.name])}`);
    }
    console.log('');

    const totalRequired = MACF_REQUIRED_PERMISSIONS.length;
    const satisfied = totalRequired - finding.missing.length - finding.insufficient.length;
    const status = finding.missing.length === 0 && finding.insufficient.length === 0
      ? '✓ all required permissions present'
      : `✗ ${finding.missing.length + finding.insufficient.length} of ${totalRequired} required permissions missing or insufficient`;
    console.log(`  ${status} (${satisfied}/${totalRequired} satisfied)`);

    if (finding.missing.length > 0) {
      console.log('');
      console.log('Missing:');
      for (const req of finding.missing) {
        console.log(`  - ${req.name}: ${req.level} — ${req.why}`);
      }
    }
    if (finding.insufficient.length > 0) {
      console.log('');
      console.log('Insufficient:');
      for (const { required, actual } of finding.insufficient) {
        console.log(`  - ${required.name}: have ${actual}, need ${required.level} — ${required.why}`);
      }
    }
    if (finding.missing.length > 0 || finding.insufficient.length > 0) {
      console.log('');
      console.log('See design/decisions/DR-019-app-permissions.md for the full doctrine,');
      console.log('and GitHub → Settings → Developer settings → GitHub Apps → <your App> → Permissions');
      console.log('to update the App. Users with the App installed must accept the new permissions.');
      permissionsFailed = true;
    }
  }

  console.log('');
  console.log('Sandbox filesystem (macf#200)');
  console.log('──────────────────────────────────────────────────────────────');
  let sandboxCheck = checkSandboxFdAllowRead(projectDir);
  printSandboxSection(sandboxCheck);

  console.log('');
  console.log('Workspace permissions (macf#296)');
  console.log('──────────────────────────────────────────────────────────────');
  let permsCheck = checkPermissionsAllow(projectDir);
  printPermissionsAllowSection(permsCheck);

  const role = inferRole(projectDir);
  let roleCheck = role ? checkRoleSettings(projectDir, role) : null;
  printRoleSettingsSection(role, roleCheck);

  // --fix: the existing install emitters ARE the fix (DR-028) — they write the
  // floor merge-preservingly. Detect drift read-only above, then (on consent)
  // call them + re-run the checks. NEVER write without consent.
  if (opts?.fix) {
    const needsFix =
      (roleCheck !== null && roleCheck.status !== 'PASS') ||
      sandboxCheck.status === 'FAIL' ||
      permsCheck.status === 'WARN';
    if (!needsFix) {
      console.log('');
      console.log('--fix: nothing to fix — settings already satisfy the floor.');
    } else {
      console.log('');
      console.log('--fix will write the DR-028 floor into .claude/settings.json:');
      console.log('  - permissions.allow/deny floor (installPluginSkillPermissions)');
      console.log('  - PreToolUse/PostToolUse/UserPromptSubmit/PreCompact hooks (installGhTokenHook)');
      console.log('  - sandbox.filesystem.allowRead + sandbox.excludedCommands');
      console.log('  Existing operator-authored entries are preserved (merge, dedup).');
      const consent = opts.yes ? true : await promptYesNo('Proceed?');
      if (!consent) {
        console.log('Aborted — no changes written.');
      } else {
        installPluginSkillPermissions(projectDir);
        installGhTokenHook(projectDir);
        installSandboxFdAllowRead(projectDir);
        installSandboxExcludedCommands(projectDir);
        sandboxCheck = checkSandboxFdAllowRead(projectDir);
        permsCheck = checkPermissionsAllow(projectDir);
        roleCheck = role ? checkRoleSettings(projectDir, role) : null;
        console.log('');
        console.log('--fix applied. Re-check:');
        printSandboxSection(sandboxCheck);
        printPermissionsAllowSection(permsCheck);
        printRoleSettingsSection(role, roleCheck);
      }
    }
  }

  const sandboxFailed = sandboxCheck.status === 'FAIL';
  const roleErrored = roleCheck?.status === 'ERROR';
  return permissionsFailed || sandboxFailed || roleErrored ? 1 : 0;
}

/** Print the macf#200 sandbox-fd report line(s) for `check`. */
function printSandboxSection(check: SandboxFdCheck): void {
  if (check.status === 'PASS') {
    console.log(`  ✓ sandbox.filesystem.allowRead contains ${SANDBOX_FD_READ_PATTERN}  [PASS]`);
  } else {
    console.log(`  ✗ sandbox.filesystem.allowRead missing ${SANDBOX_FD_READ_PATTERN}   [FAIL — run \`macf update\` to fix]`);
    if (check.detail) console.log(`    ${check.detail}`);
  }
}

/** Print the macf#296 permissions-allow report line(s) for `check`. */
function printPermissionsAllowSection(check: PermissionsAllowCheckResult): void {
  if (check.readError) {
    console.log(`  ⚠ could not parse .claude/settings.json: ${check.readError}`);
  } else if (check.status === 'PASS') {
    console.log(`  ✓ permissions.allow grants Write + Edit (autonomous coordination unblocked)  [PASS]`);
  } else {
    const summary = check.status === 'INFO'
      ? `ℹ ${check.findings.length} autonomy-required tool(s) absent (deny rules present — likely deliberate)  [INFO]`
      : `⚠ ${check.findings.length} autonomy-required tool(s) absent or scoped  [WARN]`;
    console.log(`  ${summary}`);
    for (const f of check.findings) {
      const symbol = f.severity === 'BLOCK' ? '✗' : (f.severity === 'WARN' ? '⚠' : 'ℹ');
      console.log(`    ${symbol} ${f.tool}: ${f.message}`);
      console.log(`      Fix: ${f.remediation}`);
    }
  }
}
