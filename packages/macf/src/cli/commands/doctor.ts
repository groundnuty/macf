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
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { readAgentConfig, resolveCanonicalBranch, tokenSourceFromConfig, writeAgentConfig } from '../config.js';
import type { MacfAgentConfig } from '../config.js';
import { defaultProcReader, scanMacfProcesses } from '../proc-scan.js';
import type { ProcReader } from '../proc-scan.js';
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
import {
  readHooksMapEntries,
  resolvePluginDirFromClaudeSh,
} from '../plugin-hook-resolver.js';
import type { HookMatchEntry, PluginDirResolution } from '../plugin-hook-resolver.js';

// Re-exported for backward compatibility — `resolvePluginDirFromClaudeSh` +
// `PluginDirResolution` moved to `plugin-hook-resolver.ts` (DR-039 Amendment B,
// groundnuty/macf#743 review) so `settings-writer.ts` can reuse the SAME
// resolver without a settings-writer.ts → doctor.ts → settings-writer.ts
// import cycle (doctor.ts already imports `installGhTokenHook` FROM
// settings-writer.ts, above). `doctor.test.ts` still imports both names from
// `doctor.js` — this re-export keeps that surface unchanged.
export { resolvePluginDirFromClaudeSh };
export type { PluginDirResolution };

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
 * Derive the App's bot-LOGIN from its slug: `<slug>[bot]` (DR-028 / macf#535).
 * Idempotent — tolerates a slug that already carries the `[bot]` suffix (some
 * API responses / operator-pasted values do), matching the same tolerance the
 * shipped `check-gh-attribution.sh` hook applies when reading this field back
 * (`${BOT_LOGIN%"[bot]"}[bot]`).
 */
export function deriveBotLogin(slug: string): string {
  if (!slug || slug.trim() === '') {
    throw new Error('deriveBotLogin: slug must not be empty');
  }
  const bare = slug.endsWith('[bot]') ? slug.slice(0, -'[bot]'.length) : slug;
  return `${bare}[bot]`;
}

/**
 * Format a non-leaking error message when `GET /app` returns a body that
 * doesn't look like the expected `{ slug: string, ... }` shape. Mirrors
 * `describeNonJwtOutput` — shows only a short prefix + length, never the
 * full unexpected body (which could carry a JWT-adjacent secret echoed back
 * by a misbehaving proxy, or just be noisy).
 */
export function describeNonAppSlugOutput(body: string): string {
  const safePrefix = body.length > 0 ? body.slice(0, 6) : '(empty)';
  return (
    `GET /app response did not contain a usable \`slug\` field ` +
    `(prefix='${safePrefix}', length=${body.length})`
  );
}

/**
 * Resolve the GitHub App's slug via `GET /app` (Get the authenticated app),
 * authenticated with an App JWT — the same JWT-mint step
 * `fetchInstallationPermissions` already performs, reused here rather than
 * re-implementing RS256 signing. `GET /app` needs only the JWT (no
 * installation-scoped permission), so this resolves even for an App whose
 * installation permissions are still being provisioned.
 *
 * The response's `slug` IS the App's bot-login stem — GitHub mints the bot
 * user as `<slug>[bot]` for every App installation; see DR-028 / macf#535.
 */
export async function fetchAppSlug(appId: string, keyPath: string): Promise<string> {
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

  const response = await fetch('https://api.github.com/app', {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`GET /app returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const bodyText = await response.text();
  let parsed: { slug?: unknown };
  try {
    parsed = JSON.parse(bodyText) as { slug?: unknown };
  } catch {
    throw new Error(describeNonAppSlugOutput(bodyText));
  }
  if (typeof parsed.slug !== 'string' || parsed.slug.trim() === '') {
    throw new Error(describeNonAppSlugOutput(bodyText));
  }
  return parsed.slug;
}

/**
 * Result of the `github_app.bot_login` presence check (DR-028 / macf#535 /
 * macf#707). `bot_login` is the AUTHORITATIVE identity the shipped
 * `check-gh-attribution.sh` PostToolUse hook compares against; when it's
 * null the hook silently falls back to a non-authoritative `agent_name`
 * guess (tolerated per macf#535, since `agent_name` isn't always the App
 * slug) — meaning the attribution guard is effectively inert. See
 * `packages/macf/scripts/check-gh-attribution.sh` lines ~151-170.
 *
 *   - `PASS` — `bot_login` is populated (non-empty string).
 *   - `WARN` — `github_app` is present but `bot_login` is missing/empty.
 *     Repairable via `macf doctor --fix` or re-running `macf init`.
 *   - `INFO` — no `github_app` block at all (local-registry / DR-024 mode).
 *     Nothing to populate; not a gap.
 */
export interface BotLoginCheckResult {
  readonly status: 'PASS' | 'WARN' | 'INFO';
  readonly detail: string;
}

/**
 * Pure detection: does `config.github_app.bot_login` hold a usable value?
 * Independent of `agent_name` by construction — this function never reads
 * or derives from `agent_name` (AC #3: populating `bot_login` must not
 * ripple into the OTEL `gen_ai.agent.name` / cert-CN identity surface).
 */
export function checkBotLogin(config: MacfAgentConfig): BotLoginCheckResult {
  if (!config.github_app) {
    return {
      status: 'INFO',
      detail: 'local-registry mode (DR-024) — no GitHub App; bot_login check skipped',
    };
  }
  const botLogin = config.github_app.bot_login;
  if (botLogin && botLogin.trim() !== '') {
    return { status: 'PASS', detail: `github_app.bot_login = ${botLogin}` };
  }
  return {
    status: 'WARN',
    detail:
      'github_app.bot_login is unset — attribution hook inert (check-gh-attribution.sh falls ' +
      'back to a non-authoritative agent_name guess, per macf#535). Repair via `macf doctor --fix` ' +
      'or by re-running `macf init`.',
  };
}

/**
 * Repair: resolve the App slug via `fetchAppSlug` and write
 * `github_app.bot_login` back to `macf-agent.json`, leaving every other
 * field (notably `agent_name`) untouched. Returns the resolved login on
 * success. Throws on any network/gh failure — callers decide how to
 * surface that (doctor's `--fix` path logs + continues; init's best-effort
 * call catches + warns, per the plugin-fetch precedent in `init.ts`).
 */
export async function repairBotLogin(
  projectDir: string,
  config: MacfAgentConfig,
): Promise<string> {
  if (!config.github_app) {
    throw new Error('repairBotLogin called on a config without a `github_app` block (local mode)');
  }
  const source = tokenSourceFromConfig(projectDir, config);
  const slug = await fetchAppSlug(source.appId, source.keyPath);
  const botLogin = deriveBotLogin(slug);
  writeAgentConfig(projectDir, {
    ...config,
    github_app: { ...config.github_app, bot_login: botLogin },
  });
  return botLogin;
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

/**
 * Result of the OTEL launch-boundary probe (macf#554/#556).
 *
 *   - `PASS` — the claude process whose cwd IS this workspace exports
 *     `OTEL_EXPORTER_OTLP_ENDPOINT` (telemetry will flow).
 *   - `WARN` — that process exists but lacks the endpoint (a REAL stale/missing
 *     launch-env: traces silently won't export). Warn-only — does not affect the
 *     exit code, matching the macf#296 permissions check's discipline.
 *   - `INFO` — no claude process for this workspace is running, or `/proc` is
 *     unavailable (non-Linux). Nothing to assert; skip.
 */
export interface OtelLaunchCheck {
  readonly status: 'PASS' | 'WARN' | 'INFO';
  readonly detail: string;
}

/** Normalise a path for cwd comparison (absolute, no trailing slash). */
function normalizeDir(p: string): string {
  const abs = resolve(p);
  return abs.length > 1 && abs.endsWith('/') ? abs.slice(0, -1) : abs;
}

/**
 * Pattern-A launch-boundary probe: find the running `claude` process whose
 * `/proc/<pid>/cwd` EQUALS this workspace dir — the cwd disambiguation is the
 * whole point; a multi-tenant host runs many `claude`s and a `head -1` grab
 * would assert against the wrong one — then assert its environ carries
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. The `ProcReader` is injectable for tests; the
 * default reads real `/proc`. See macf#556 for the misdiagnosis this prevents.
 */
export function checkOtelLaunchBoundary(
  workspaceDir: string,
  reader: ProcReader = defaultProcReader,
): OtelLaunchCheck {
  if (!reader.available()) {
    return {
      status: 'INFO',
      detail: '/proc unavailable (non-Linux host) — cannot probe the launch boundary',
    };
  }
  const target = normalizeDir(workspaceDir);
  const match = scanMacfProcesses(reader).find(
    (p) => p.kind === 'claude' && p.cwd !== null && normalizeDir(p.cwd) === target,
  );
  if (!match) {
    return {
      status: 'INFO',
      detail: `no running claude process has cwd == ${target} — skipping launch-boundary probe`,
    };
  }
  if (match.otelEndpoint && match.otelEndpoint.length > 0) {
    return {
      status: 'PASS',
      detail: `claude pid ${match.pid} exports OTEL_EXPORTER_OTLP_ENDPOINT=${match.otelEndpoint}`,
    };
  }
  return {
    status: 'WARN',
    detail:
      `claude pid ${match.pid} (cwd ${target}) has NO OTEL_EXPORTER_OTLP_ENDPOINT in its ` +
      `environ — telemetry will NOT be exported. Relaunch via claude.sh with the endpoint set.`,
  };
}

/**
 * Result of the canonical-branch check (macf#755) — the branch-guard's
 * DETECT half (Pattern A): surface non-canonical-branch drift as a doctor
 * WARN *before* a `macf fleet upgrade` / `macf restart-self` hits it and
 * refuses (or, pre-#755, would have silently mutated the wrong branch).
 *
 *   - `PASS` — the workspace's current branch matches its resolved canonical
 *     branch (`resolveCanonicalBranch`).
 *   - `WARN` — a different branch, a detached HEAD, or an unresolvable
 *     branch (all non-canonical) — a fleet-upgrade/relaunch would mutate the
 *     wrong branch. Warn-only — does not affect the exit code, matching the
 *     macf#296 / OTEL-launch-boundary checks' detect-only discipline.
 */
export interface CanonicalBranchCheckResult {
  readonly status: 'PASS' | 'WARN';
  readonly detail: string;
}

/**
 * Read `workspaceDir`'s current git branch (`git branch --show-current`
 * semantics — macf#755, matching the VM `FleetDriver.currentBranch` seam).
 * `null` on detached HEAD (empty output) or any git failure — both are
 * non-canonical to the caller.
 */
export function readCurrentBranch(workspaceDir: string): string | null {
  try {
    const out = execFileSync('git', ['branch', '--show-current'], {
      cwd: workspaceDir,
      encoding: 'utf-8',
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Pure check: does `currentBranch` match `config`'s resolved canonical
 * branch? `currentBranch` is injected (via `readCurrentBranch` in
 * production) so tests don't need a real git repo — same seam-injection
 * style as `checkOtelLaunchBoundary`'s `ProcReader`.
 */
export function checkCanonicalBranch(
  config: MacfAgentConfig | null,
  currentBranch: string | null,
): CanonicalBranchCheckResult {
  const canonical = resolveCanonicalBranch(config);
  if (currentBranch !== null && currentBranch === canonical) {
    return { status: 'PASS', detail: `workspace is on its canonical branch \`${canonical}\`` };
  }
  const branchDesc =
    currentBranch === null ? 'a detached HEAD (or an unresolvable branch)' : `branch \`${currentBranch}\``;
  return {
    status: 'WARN',
    detail:
      `workspace on non-canonical ${branchDesc} (expected \`${canonical}\`) — a fleet-upgrade/relaunch ` +
      `would mutate the wrong branch; switch to \`${canonical}\` or set canonicalBranch`,
  };
}

/**
 * DR-039 Decision 1 — the load-bearing hook-set `macf doctor` asserts is
 * actually present in the agent's EFFECTIVE hook registration (the union of
 * `.claude/settings.json` + the LOADED plugin's `hooks/hooks.json`). Pattern A:
 * assert the result-invariant (the hook is registered), don't trust that the
 * delivery channel (a full plugin load, an un-stashed settings.json) carried
 * it. Catches a stripped launcher (the plugin-cs bug that triggered this DR —
 * a `--plugin-dir` pointing at a hooks-less plugin variant silently drops
 * every plugin-owned hook), a bad stash, or an agent-edit that dropped a
 * hook — LOUDLY, at a deterministic checkpoint, instead of a distant silent
 * symptom (a lost handoff, a mis-attribution). See
 * `design/decisions/DR-039-hook-delivery-and-presence-guarantee.md`.
 *
 * This is READ-ONLY detection + report — no repair action is taken here (the
 * DR's open question 1 leans "warn + offer repair", not silent auto-repair;
 * see `printLoadBearingHooksSection`'s remediation text). The single-source
 * migration (Decision 2: retire plugin-cs, stop hand-wiring settings.json
 * duplicates) is a separate slice, NOT implemented by this check.
 */
export interface LoadBearingHookSpec {
  readonly name: string;
  /**
   * `mcp_tool` hooks match by exact `tool` name; `command` hooks match by
   * substring against the hook's `command` string — tolerates the
   * `$CLAUDE_PROJECT_DIR` (settings.json) vs `${CLAUDE_PLUGIN_ROOT}` (plugin
   * hooks.json) path-prefix variance between the two delivery channels.
   */
  readonly kind: 'command' | 'mcp_tool';
  readonly match: string;
  /**
   * Event(s) this hook is expected on — informational (report text only).
   * Presence is asserted regardless of which event it's actually wired to,
   * per DR-039's "err toward not-false-alarming" posture (a hook registered
   * under a slightly different event is still evidence the delivery channel
   * carried it, and this check's job is presence, not event-correctness).
   */
  readonly events: readonly string[];
  readonly citation: string;
}

/**
 * The load-bearing hook-set from `design/decisions/DR-039-hook-delivery-and-presence-guarantee.md`
 * §"The load-bearing hook-set the doctor asserts", plus `check-channel-alive`
 * (macf#734, merged after the DR was ratified — the DR text explicitly notes
 * it joins the asserted set).
 */
export const DR039_LOAD_BEARING_HOOKS: readonly LoadBearingHookSpec[] = [
  {
    name: 'checkpoint_to_memory',
    kind: 'mcp_tool',
    match: 'checkpoint_to_memory',
    events: ['PreCompact'],
    citation: 'DR-034 session-handoff memory write — its absence was the DR-039 trigger incident',
  },
  {
    name: 'check-gh-attribution',
    kind: 'command',
    match: 'check-gh-attribution.sh',
    events: ['PostToolUse'],
    citation: 'macf#491 — attribution-trap result-invariant backstop',
  },
  {
    name: 'harvest-reflection',
    kind: 'command',
    match: 'harvest-reflection.sh',
    events: ['PreCompact'],
    citation: 'macf#500 — reflection-staging harvest at compaction',
  },
  {
    name: 'check-gh-token',
    kind: 'command',
    match: 'check-gh-token.sh',
    events: ['PreToolUse'],
    citation: 'macf#140 — gh-token attribution-trap guard',
  },
  {
    name: 'check-mention-routing',
    kind: 'command',
    match: 'check-mention-routing.sh',
    events: ['PreToolUse'],
    citation: 'macf#244 / macf#272 — mention-routing-hygiene guard',
  },
  {
    name: 'check-lgtm-gate',
    kind: 'command',
    match: 'check-lgtm-gate.sh',
    events: ['PreToolUse'],
    citation: 'macf#270 — no-LGTM-no-merge guard',
  },
  {
    name: 'check-close-keyword',
    kind: 'command',
    match: 'check-close-keyword.sh',
    events: ['PreToolUse'],
    citation: 'macf#431 — auto-close-keyword guard',
  },
  {
    name: 'check-channel-alive',
    kind: 'command',
    match: 'check-channel-alive.sh',
    events: ['SessionStart', 'UserPromptSubmit'],
    citation: 'macf#734 — channel-server liveness guard',
  },
];

/**
 * `HookMatchEntry`, `extractHookMatchEntries`, and `readHooksMapEntries`
 * moved to `../plugin-hook-resolver.js` (DR-039 Amendment B, groundnuty/macf#743
 * review) so `settings-writer.ts` can reuse them without an import cycle —
 * see the module-level comment there + the re-export note at the top of
 * this file. `readHooksMapEntries` is imported above; used below.
 */

/**
 * Every command/mcp_tool hook entry across `.claude/settings.json` +
 * `.claude/settings.local.json` — both contribute to Claude Code's merged
 * hook set, same two files `getHookCommands` already reads for the DR-028
 * role-settings check.
 */
function readSettingsHookEntries(workspaceDir: string): HookMatchEntry[] {
  const claudeDir = join(resolve(workspaceDir), '.claude');
  const result: HookMatchEntry[] = [];
  for (const file of ['settings.json', 'settings.local.json'] as const) {
    result.push(...readHooksMapEntries(join(claudeDir, file)));
  }
  return result;
}

/**
 * `PluginDirResolution` + `resolvePluginDirFromClaudeSh` moved to
 * `../plugin-hook-resolver.js` (see the re-export note at the top of this
 * file) — imported above, re-exported for `doctor.test.ts` compatibility.
 */

/**
 * The agent's effective hook registration — the union DR-039 asserts
 * against: `.claude/settings.json` (+ `settings.local.json`) hooks, PLUS the
 * `hooks.json` of whichever plugin dir `claude.sh` actually loads.
 */
export interface EffectiveHookConfig {
  readonly entries: readonly HookMatchEntry[];
  readonly pluginDirResolution: PluginDirResolution;
  /**
   * The `hooks.json` path actually consulted — the resolved dir's, or the
   * default-fallback path when the plugin dir wasn't cleanly determinable.
   */
  readonly pluginHooksJsonPath: string;
  /**
   * True when the plugin dir could not be cleanly determined from
   * `claude.sh`, so the default `.macf/plugin` location was checked instead
   * (in ADDITION to settings.json — "err toward not-false-alarming").
   */
  readonly usedDefaultFallback: boolean;
}

export function getEffectiveHookConfig(workspaceDir: string): EffectiveHookConfig {
  const settingsEntries = readSettingsHookEntries(workspaceDir);
  const pluginDirResolution = resolvePluginDirFromClaudeSh(workspaceDir);

  const usedDefaultFallback = !pluginDirResolution.determinable || !pluginDirResolution.dir;
  const pluginDir = usedDefaultFallback
    ? join(resolve(workspaceDir), '.macf', 'plugin')
    : (pluginDirResolution.dir as string);
  const pluginHooksJsonPath = join(pluginDir, 'hooks', 'hooks.json');
  const pluginEntries = readHooksMapEntries(pluginHooksJsonPath);

  return {
    entries: [...settingsEntries, ...pluginEntries],
    pluginDirResolution,
    pluginHooksJsonPath,
    usedDefaultFallback,
  };
}

/** One load-bearing hook DR-039 found absent from the effective config. */
export interface LoadBearingHookFinding {
  readonly name: string;
  readonly citation: string;
}

/**
 * Result of the DR-039 load-bearing-hook-set assertion. `status` is `WARN`
 * (not `ERROR`/exit-code-affecting) when any hook is missing — matching the
 * doctor's existing warn-only posture for detect-only checks (OTEL launch
 * boundary, bot_login, permissions-allow); `INFO` when the workspace isn't a
 * `macf init`-managed one at all (nothing to assert).
 */
export interface LoadBearingHooksCheckResult {
  readonly status: 'PASS' | 'WARN' | 'INFO';
  readonly presentCount: number;
  readonly totalCount: number;
  /** The load-bearing hooks NOT found in the effective config. Empty on PASS/INFO. */
  readonly missing: readonly LoadBearingHookFinding[];
  readonly detail: string;
}

function hookIsPresent(spec: LoadBearingHookSpec, entries: readonly HookMatchEntry[]): boolean {
  return entries.some((e) => {
    if (spec.kind === 'mcp_tool') return e.kind === 'mcp_tool' && e.value === spec.match;
    return e.kind === 'command' && e.value.includes(spec.match);
  });
}

/**
 * DR-039 Decision 1: assert the load-bearing hook-set (`DR039_LOAD_BEARING_HOOKS`)
 * is present in the agent's EFFECTIVE hook registration (`getEffectiveHookConfig`).
 * Skips gracefully (`INFO`) when the workspace has no `.macf/` dir at all — not a
 * `macf init`-managed workspace (a local dev checkout, a non-agent workspace,
 * etc.) — so a non-standard workspace doesn't get false-alarmed. DR-024
 * (local-registry) workspaces DO still get the full assertion: they carry
 * `.macf/plugin` + `.claude/settings.json` like any other macf-init'd
 * workspace, and their load-bearing hooks matter just as much (DR-024 changes
 * how the registry/App token is sourced, not how hooks are delivered).
 */
export function checkLoadBearingHooks(workspaceDir: string): LoadBearingHooksCheckResult {
  const absDir = resolve(workspaceDir);
  if (!existsSync(join(absDir, '.macf'))) {
    return {
      status: 'INFO',
      presentCount: 0,
      totalCount: DR039_LOAD_BEARING_HOOKS.length,
      missing: [],
      detail:
        'no .macf/ directory — not a macf-init-managed workspace; skipping the DR-039 ' +
        'hook-presence assertion',
    };
  }

  const config = getEffectiveHookConfig(workspaceDir);
  const missing: LoadBearingHookFinding[] = [];
  for (const spec of DR039_LOAD_BEARING_HOOKS) {
    if (!hookIsPresent(spec, config.entries)) {
      missing.push({ name: spec.name, citation: spec.citation });
    }
  }
  const presentCount = DR039_LOAD_BEARING_HOOKS.length - missing.length;
  const detail = config.usedDefaultFallback
    ? `plugin dir not cleanly determinable from claude.sh (${config.pluginDirResolution.detail}) — ` +
      'checked default .macf/plugin/hooks/hooks.json + settings.json'
    : `loaded plugin dir: ${config.pluginDirResolution.dir}`;

  return {
    status: missing.length === 0 ? 'PASS' : 'WARN',
    presentCount,
    totalCount: DR039_LOAD_BEARING_HOOKS.length,
    missing,
    detail,
  };
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

  console.log('');
  console.log('OTEL launch boundary (macf#554/#556)');
  console.log('──────────────────────────────────────────────────────────────');
  printOtelLaunchSection(checkOtelLaunchBoundary(projectDir));

  console.log('');
  console.log('Canonical branch (macf#755)');
  console.log('──────────────────────────────────────────────────────────────');
  printCanonicalBranchSection(checkCanonicalBranch(config, readCurrentBranch(projectDir)));

  console.log('');
  console.log('Attribution identity (DR-028 / macf#535 / macf#707)');
  console.log('──────────────────────────────────────────────────────────────');
  let botLoginCheck = checkBotLogin(config);
  printBotLoginSection(botLoginCheck);

  console.log('');
  console.log('Load-bearing hooks (DR-039)');
  console.log('──────────────────────────────────────────────────────────────');
  printLoadBearingHooksSection(checkLoadBearingHooks(projectDir));

  // --fix: the existing install emitters ARE the fix (DR-028) — they write the
  // floor merge-preservingly. Detect drift read-only above, then (on consent)
  // call them + re-run the checks. NEVER write without consent.
  if (opts?.fix) {
    const needsFix =
      (roleCheck !== null && roleCheck.status !== 'PASS') ||
      sandboxCheck.status === 'FAIL' ||
      permsCheck.status === 'WARN' ||
      botLoginCheck.status === 'WARN';
    if (!needsFix) {
      console.log('');
      console.log('--fix: nothing to fix — settings already satisfy the floor.');
    } else {
      console.log('');
      console.log('--fix will write the DR-028 floor into .claude/settings.json:');
      console.log('  - permissions.allow/deny floor (installPluginSkillPermissions)');
      console.log('  - PreToolUse/PostToolUse/UserPromptSubmit/PreCompact/SessionStart hooks (installGhTokenHook)');
      console.log('  - sandbox.filesystem.allowRead + sandbox.excludedCommands');
      if (botLoginCheck.status === 'WARN') {
        console.log('  - github_app.bot_login in macf-agent.json (resolves the App slug via GET /app)');
      }
      console.log('  Existing operator-authored entries are preserved (merge, dedup).');
      const consent = opts.yes ? true : await promptYesNo('Proceed?');
      if (!consent) {
        console.log('Aborted — no changes written.');
      } else {
        installPluginSkillPermissions(projectDir);
        installGhTokenHook(projectDir);
        installSandboxFdAllowRead(projectDir);
        installSandboxExcludedCommands(projectDir);
        if (botLoginCheck.status === 'WARN') {
          try {
            const botLogin = await repairBotLogin(projectDir, config);
            console.log(`  Attribution: resolved + wrote github_app.bot_login = ${botLogin}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  Warning: bot_login repair failed: ${msg}`);
            console.warn('    App-slug resolution needs a valid App JWT (gh token generate --jwt) and network');
            console.warn('    access to api.github.com — check the App ID / key path if this persists.');
          }
        }
        sandboxCheck = checkSandboxFdAllowRead(projectDir);
        permsCheck = checkPermissionsAllow(projectDir);
        roleCheck = role ? checkRoleSettings(projectDir, role) : null;
        botLoginCheck = checkBotLogin(readAgentConfig(projectDir) ?? config);
        console.log('');
        console.log('--fix applied. Re-check:');
        printSandboxSection(sandboxCheck);
        printPermissionsAllowSection(permsCheck);
        printRoleSettingsSection(role, roleCheck);
        printBotLoginSection(botLoginCheck);
      }
    }
  }

  const sandboxFailed = sandboxCheck.status === 'FAIL';
  const roleErrored = roleCheck?.status === 'ERROR';
  return permissionsFailed || sandboxFailed || roleErrored ? 1 : 0;
}

/** Print the macf#554/#556 OTEL launch-boundary report line for `check`. */
function printOtelLaunchSection(check: OtelLaunchCheck): void {
  if (check.status === 'PASS') {
    console.log(`  ✓ ${check.detail}  [PASS]`);
  } else if (check.status === 'WARN') {
    console.log(`  ⚠ ${check.detail}  [WARN]`);
  } else {
    console.log(`  ℹ ${check.detail}  [INFO]`);
  }
}

/** Print the macf#755 canonical-branch report line for `check`. */
function printCanonicalBranchSection(check: CanonicalBranchCheckResult): void {
  if (check.status === 'PASS') {
    console.log(`  ✓ ${check.detail}  [PASS]`);
  } else {
    console.log(`  ⚠ ${check.detail}  [WARN]`);
    console.log('    Fix: switch the workspace to its canonical branch, or set canonicalBranch in macf-agent.json.');
  }
}

/** Print the DR-028 / macf#535 / macf#707 bot-login report line for `check`. */
function printBotLoginSection(check: BotLoginCheckResult): void {
  if (check.status === 'PASS') {
    console.log(`  ✓ ${check.detail}  [PASS]`);
  } else if (check.status === 'WARN') {
    console.log(`  ⚠ ${check.detail}  [WARN]`);
    console.log('    Fix: run `macf doctor --fix` (resolves the App slug via GET /app) or re-run `macf init`.');
  } else {
    console.log(`  ℹ ${check.detail}  [INFO]`);
  }
}

/** Print the DR-039 load-bearing-hook-set report section for `check`. */
function printLoadBearingHooksSection(check: LoadBearingHooksCheckResult): void {
  if (check.status === 'INFO') {
    console.log(`  ℹ ${check.detail}  [INFO]`);
    return;
  }
  console.log(`  (${check.detail})`);
  if (check.status === 'PASS') {
    console.log(`  ✓ ${check.presentCount}/${check.totalCount} load-bearing hooks registered  [PASS]`);
    return;
  }
  console.log(
    `  ⚠ ${check.presentCount}/${check.totalCount} load-bearing hooks registered — ` +
    `${check.missing.length} MISSING  [WARN]`,
  );
  for (const m of check.missing) {
    console.log(`    ✗ ${m.name} — ${m.citation}`);
  }
  console.log(
    '    Fix: re-run `macf update` (or `macf init --force`) to restore the full plugin + settings ' +
    'floor. A stripped --plugin-dir (a hooks-less plugin variant), a bad stash, or a hand-edit can ' +
    'drop these silently — see design/decisions/DR-039-hook-delivery-and-presence-guarantee.md.',
  );
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
