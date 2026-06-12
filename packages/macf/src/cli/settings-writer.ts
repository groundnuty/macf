/**
 * Merge-preserving writer for `<workspace>/.claude/settings.json`.
 *
 * Per #140, the attribution-trap PreToolUse hook (`check-gh-token.sh`)
 * needs a settings.json entry to actually fire. Workspaces may have
 * operator-authored settings there already (other hooks, env vars,
 * model preferences) — this module reads the existing JSON (default
 * `{}`), installs the MACF hook entry, and writes back without
 * clobbering unrelated keys.
 *
 * Identification of MACF-managed entries is by command-string match
 * on the hook script's filename (`check-gh-token.sh`). A stale entry
 * from an older CLI version is refreshed in place; non-MACF entries
 * and other hook event types (SessionStart, Stop, etc.) are preserved
 * verbatim.
 *
 * Malformed settings.json throws — we refuse to silently overwrite
 * bad JSON because that would erase user content if they hand-edited
 * broken syntax.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The command path written into settings.json. Uses
 * `$CLAUDE_PROJECT_DIR` (substituted by Claude Code at hook-dispatch
 * time to the workspace root) rather than a workspace-relative path
 * because Claude Code invokes hooks with cwd = the tool's spawn dir.
 * If the agent has `cd`'d into a subdir before a Bash call, a
 * relative path resolves against the subdir and the script is "not
 * found" — generating noise and (worse) silently skipping the
 * attribution-trap check (#140). See macf#232 for the bug report and
 * macf-devops-toolkit `74c0af2` / macf-science-agent `cf7cbcf` /
 * macf-testbed `1e3ee8e` for the precedent fix landings on workspace
 * templates the day this was filed.
 *
 * Migration: `installGhTokenHook` re-writes the entry on every call,
 * matching prior MACF entries by `check-gh-token.sh` basename
 * (`isMacfManagedCommand`) — so the legacy relative-path form is
 * dropped + replaced with the absolute form on the next `macf init` /
 * `macf update` / `macf rules refresh` cycle. No legacy-pattern list
 * is needed (unlike `MACF_LEGACY_FD_PATTERNS` which compares strings
 * literally) because the basename matcher is path-agnostic.
 */
export const MACF_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-token.sh';

/**
 * Mention-routing-hygiene hook command (groundnuty/macf#244 + #272).
 * Blocks `gh issue comment` / `gh pr comment` / `gh issue close --comment`
 * invocations whose `--body` contains raw `@<bot>[bot]` mentions in
 * describing-context (mid-line, not backticked). Implements
 * `mention-routing-hygiene.md` §5 enforcement structurally; codification
 * alone produced ~80% catch rate (see science-agent's research note
 * `2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md`).
 */
export const MACF_MENTION_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-mention-routing.sh';

/**
 * LGTM-gate hook command (groundnuty/macf#270 — DR-023 UC-2). Blocks
 * `gh pr merge` invocations when the target PR has no non-author
 * APPROVED review on record. Implements `pr-discipline.md` "no LGTM
 * = no merge" structurally (rule codified via macf#262 / PR #263).
 *
 * Per the DR-023 amendment (PR #279), this is a bash command-type
 * hook — NOT `type: "mcp_tool"`. PreToolUse-blocking semantics +
 * mcp_tool's non-blocking-on-disconnect failure mode are structurally
 * incompatible; bash form fires uniformly across substrate (no
 * macf-agent MCP server) AND consumer workspaces. UC-4 (PR #275)
 * demonstrated the bash-form path empirically; UC-2 mirrors it.
 */
export const MACF_LGTM_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-lgtm-gate.sh';

/**
 * Close-keyword-guard hook command (groundnuty/macf#431). Blocks
 * `gh pr create` / `gh pr edit` invocations whose body / title contains a
 * GitHub auto-close keyword (`close`/`closes`/`closed`/`fix`/`fixes`/`fixed`/
 * `resolve`/`resolves`/`resolved`) adjacent to an issue ref (`#N` or
 * `owner/repo#N`) filed by ANOTHER agent — which would auto-close that
 * issue on merge, bypassing reporter-owns-closure (coordination.md
 * §Issue Lifecycle 1). The parser is negation-/context-blind, so cognitive
 * discipline proved insufficient (4 self-inflicted recurrences:
 * macf#316/#410/#430). Path-2 structural backstop; sister to the #140 /
 * #244+#272 / #270 hooks. Discriminator is issue authorship (self-filed
 * `Closes #own` passes); override via MACF_SKIP_CLOSE_CHECK=1.
 */
export const MACF_CLOSE_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-close-keyword.sh';

/**
 * The UserPromptSubmit turn-ack receipt hook (groundnuty/macf#444 Option D,
 * piece 2). When the router injects a prompt carrying the correlation marker
 * `[macf-route:<run_id>:<agent>]` (macf-actions piece 1), this hook fires on
 * submit and emits a `turn_processed` OTel span — making a routed ping that
 * BECAME A TURN observable, so a dropped one surfaces as a missing span
 * (closes the #437 send≠receipt gap). Unlike the PreToolUse `check-*` hooks
 * this is NOT a blocker (it observes, never `exit 2`s) and is registered
 * `async: true` so it adds no turn latency. No-op on non-routed prompts.
 */
export const MACF_TURN_RECEIPT_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/emit-turn-receipt.sh';

/**
 * Attribution-result PostToolUse hook command (groundnuty/macf#489). After a
 * `gh`-write Bash op (`gh issue/pr comment`, `gh issue/pr create`,
 * `gh issue/pr close --comment`), this hook reads the just-written resource
 * back from GitHub and warns LOUDLY (PostToolUse `exit 2`) if it was authored
 * by the operator's USER account rather than the bot — the silent-fallback
 * Instance-12 attribution trap. It is the result-invariant backstop to the
 * #140 PreToolUse `check-gh-token.sh`: that one catches the missing-bot-token
 * shape BEFORE the call; this one catches a slipped write AFTER the fact.
 *
 * PostToolUse CANNOT block (the tool already ran), so this is registered on
 * the `PostToolUse` event (matcher `Bash`), NOT `PreToolUse`. Fail-open:
 * every uncertain branch in the script exits 0; only a CONFIRMED
 * user-authored write fires `exit 2`. Override: MACF_SKIP_ATTRIBUTION_CHECK=1.
 */
export const MACF_ATTRIBUTION_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-attribution.sh';

/**
 * The hook filenames used to identify MACF-managed entries on refresh.
 * Matched by path-end equality (see isMacfManagedCommand) so operator
 * files with a similar-but-distinct basename are not misclassified.
 */
const MACF_HOOK_FILENAMES: readonly string[] = [
  'check-gh-token.sh',
  'check-mention-routing.sh',
  'check-lgtm-gate.sh',
  'check-close-keyword.sh',
  'emit-turn-receipt.sh',
  'check-gh-attribution.sh',
];

/**
 * True iff the command string represents one of our managed hooks — i.e.
 * the command invokes a file whose basename equals any MACF_HOOK_FILENAMES
 * entry (ignoring any trailing flags/arguments). Defensive against
 * operator-authored commands that happen to contain our filename as a
 * substring (e.g. `./my-check-gh-token.sh-wrapper --flag`).
 */
function isMacfManagedCommand(command: string): boolean {
  // Take the program path (first whitespace-delimited token), then
  // extract its basename. `/a/b/check-gh-token.sh --v2` → `check-gh-token.sh`.
  const program = command.trim().split(/\s+/)[0] ?? '';
  const slash = program.lastIndexOf('/');
  const basename = slash >= 0 ? program.slice(slash + 1) : program;
  return MACF_HOOK_FILENAMES.includes(basename);
}

interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
  // groundnuty/macf#444: the turn-ack receipt hook runs async so it never
  // adds turn latency (and a slow/absent OTLP endpoint can't block the turn).
  readonly async?: boolean;
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

interface Settings {
  hooks?: {
    PreToolUse?: HookEntry[];
    PostToolUse?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed .claude/settings.json at ${path}: ${(err as Error).message}. ` +
        `Fix the JSON by hand, then re-run the command.`,
      { cause: err },
    );
  }
}

/**
 * Permission patterns pre-approving the `macf-agent` plugin skills.
 * Without these, every first invocation of a skill (e.g. `/macf-status`
 * during the SessionStart auto-pickup hook) fires an interactive
 * approval dialog — blocking autonomy for the time operator takes to
 * click through. See macf#189 sub-item 2 (bilateral e2e demo friction
 * point: operator had to approve 4-5 dialogs per fresh workspace).
 *
 * Concrete patterns (not a wildcard `Skill(macf-agent:*)`): operator
 * deliberately installed the plugin at v0.1.N, so pre-trusting THE
 * SKILLS CURRENTLY KNOWN TO EXIST at this CLI version is safe. A
 * future plugin version adding new skills would need a `macf update`
 * run — which refreshes these patterns from the updated constant —
 * before the new skills auto-approve. Wildcard would auto-approve
 * anything shipped under the plugin namespace including future
 * unreviewed additions; we opt out of that security posture.
 *
 * Keep in lockstep with the skills shipped by
 * `groundnuty/macf-marketplace/macf-agent/skills/`. When plugin adds
 * a skill, add its pattern here + bump CLI version. macf#350 added
 * `macf-notify-peer` (operator-driven cross-agent messaging slash-command).
 */
export const PLUGIN_SKILL_PERMISSIONS: readonly string[] = [
  'Skill(macf-agent:macf-status)',
  'Skill(macf-agent:macf-issues)',
  'Skill(macf-agent:macf-peers)',
  'Skill(macf-agent:macf-ping)',
  'Skill(macf-agent:macf-notify-peer)',
];

/**
 * Permission patterns pre-approving the MCP tools that
 * `@groundnuty/macf-channel-server` registers on the plugin's
 * `macf-agent` MCP server. Without these, every first invocation of
 * `notify_peer` or `checkpoint_to_memory` (autonomous agent calls AND
 * operator-driven coordination) fires an interactive approval dialog,
 * blocking the Stop-hook autonomy contract from DR-023 UC-1 + UC-3.
 *
 * macf#349: operator-witnessed 2026-05-04 on PPAM 2026 macbook —
 * cross-agent `notify_peer` worked but each fresh workspace prompted
 * "Yes, and don't ask again for plugin:macf-agent:macf-agent -
 * notify_peer commands" before delivery. Sister-bug to macf#189
 * sub-item 2 (skill pre-approval) but for the MCP-tool surface that
 * the original install-time pre-approval missed.
 *
 * Pattern format: `mcp__plugin_<plugin-name>_<server-key>__<tool-name>`.
 * Plugin name = `macf-agent` (per the canonical manifest in
 * `groundnuty/macf-marketplace:macf-agent/.claude-plugin/plugin.json` `name`
 * field — the repo copy was removed as vestigial per macf#426; marketplace is
 * source). Server key = `macf-agent` (per that manifest's `mcpServers.macf-agent`
 * map key). Tool names match the channel-server's `mcp.mcp.registerTool(...)`
 * first-arg in `packages/macf-channel-server/src/server.ts`.
 *
 * Keep in lockstep with the channel-server's tool registration list.
 * When a new tool is added to the channel-server, add its pattern here
 * + bump CLI version. Operators on older CLIs gate the new tool on
 * one-time approval until they `macf update`.
 */
export const PLUGIN_MCP_TOOL_PERMISSIONS: readonly string[] = [
  'mcp__plugin_macf-agent_macf-agent__notify_peer',
  'mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory',
];

/**
 * Sandbox filesystem read-allow pattern for Claude Code's Bash-tool
 * harness. Every Bash invocation's spawned shell reads `/proc/self/fd/3`
 * (or higher fds in future builds) for stdin / command-input passed
 * by the harness. Without this pattern in the sandbox allowlist, the
 * read is denied → `zsh:4: permission denied: /proc/self/fd/3` →
 * every Bash tool call fails (or falls back to
 * `dangerouslyDisableSandbox`, defeating isolation). Hit every MACF
 * agent before macf#200.
 *
 * Claude Code's `sandbox.filesystem.allowRead` takes **literal path
 * prefixes**, not globs. Bare `/proc/self/fd` matches every
 * descriptor at any depth (`/proc/self/fd/3`, `/proc/self/fd/4`, ...)
 * via prefix semantics. An earlier draft used `/proc/self/fd/**` on
 * the assumption it was a glob; it isn't — the double-star was
 * treated as a literal and didn't match. See macf#208 for the
 * empirical surfacing of the bug.
 */
export const SANDBOX_FD_READ_PATTERN = '/proc/self/fd';

/**
 * Read `.claude/settings.json`'s `sandbox.filesystem.allowRead` array
 * as a list of strings. Returns an empty array if the file doesn't
 * exist or the nested shape is absent/alien. Throws on malformed
 * JSON — consistent with `installSandboxFdAllowRead`'s posture (we
 * don't silently treat a broken file as "no entries"; that would
 * mask operator-authored state).
 *
 * Used by `macf doctor` (macf#202) to report whether the workspace
 * has the `/proc/self/fd` prefix pattern without duplicating the
 * JSON-read + deep-narrow logic in two places.
 */
export function getSandboxAllowRead(workspaceDir: string): readonly string[] {
  const absDir = resolve(workspaceDir);
  const path = join(absDir, '.claude', 'settings.json');
  const settings = readSettings(path);
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const filesystemRaw = (sandboxRaw['filesystem'] as Record<string, unknown> | undefined) ?? {};
  const list = filesystemRaw['allowRead'];
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}

/**
 * Read `permissions.<key>` from a single settings file path. Returns an
 * empty array if the file is absent, no `permissions` block, or the array
 * isn't a string list. Throws on malformed JSON via `readSettings`.
 *
 * Internal helper — `getPermissionsAllow` / `getPermissionsDeny` use this
 * to read each scope (settings.json + settings.local.json) before
 * merging.
 */
function readPermissionsArray(filePath: string, key: 'allow' | 'deny'): readonly string[] {
  const settings = readSettings(filePath);
  const permissionsRaw = (settings['permissions'] as Record<string, unknown> | undefined) ?? {};
  const list = permissionsRaw[key];
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}

/**
 * Read the workspace-effective `permissions.allow` array — merge of
 * `.claude/settings.json` + `.claude/settings.local.json` (macf#305).
 *
 * Per Claude Code's canonical settings semantics, `permissions.allow` /
 * `deny` / `ask` arrays MERGE/concatenate across scopes (not replace —
 * opposite to scalar settings which higher-priority scopes replace).
 * The doctor's effective-permissions check therefore unions both
 * scopes; an entry present in EITHER file counts as granted.
 *
 * Duplicates are removed. Empty array if neither file exists. Throws
 * on malformed JSON in either file (the path is in the error message,
 * surfacing which file failed to parse).
 *
 * Used by `macf doctor` (macf#296 / #298) to surface allow-list gaps
 * that would block autonomous coordination — specifically Write/Edit
 * absence causing interactive permission prompts mid-test. Pre-#305
 * the helper read settings.json only; this caused false-positive WARNs
 * on workspaces where operators canonically placed Write/Edit in
 * settings.local.json (as cv-architect / cv-project-archaeologist did
 * after the macf#302 substrate-side drift workaround).
 */
export function getPermissionsAllow(workspaceDir: string): readonly string[] {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const main = readPermissionsArray(join(claudeDir, 'settings.json'), 'allow');
  const local = readPermissionsArray(join(claudeDir, 'settings.local.json'), 'allow');
  return Array.from(new Set([...main, ...local]));
}

/**
 * Read the workspace-effective `permissions.deny` array — sister to
 * `getPermissionsAllow`. Same merge semantics: union of
 * settings.json + settings.local.json deny arrays, deduped (macf#305).
 *
 * Used to detect operator-authored deny rules that contextualise an
 * allow-list gap as deliberate (security-driven) rather than
 * accidental drift. A deny rule in EITHER scope counts; the doctor's
 * INFO-severity classification fires on the union.
 */
export function getPermissionsDeny(workspaceDir: string): readonly string[] {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const main = readPermissionsArray(join(claudeDir, 'settings.json'), 'deny');
  const local = readPermissionsArray(join(claudeDir, 'settings.local.json'), 'deny');
  return Array.from(new Set([...main, ...local]));
}

/**
 * Legacy MACF-managed patterns that earlier CLI versions wrote to
 * `allowRead`. Dropped from the array before installing the current
 * `SANDBOX_FD_READ_PATTERN` — the `/**` glob suffix was treated
 * literally by the sandbox (not as a glob) and silently didn't
 * match, leaving the fd read denied. See macf#208.
 */
const MACF_LEGACY_FD_PATTERNS: readonly string[] = [
  '/proc/self/fd/**',
];

/**
 * Install (or refresh) the `/proc/self/fd` entry in
 * `.claude/settings.json`'s `sandbox.filesystem.allowRead` array.
 * Creates each nested key if absent. Idempotent — repeated calls
 * don't duplicate. Operator-authored `allowRead` entries are
 * preserved; stale MACF-managed patterns (see
 * MACF_LEGACY_FD_PATTERNS) are dropped before the current pattern
 * is installed.
 *
 * Opt-out: if `MACF_SANDBOX_FD_FIX_SKIP` is `1` or `true` at call
 * time (during `macf init` / `macf update`), no change is made. Lets
 * operators manage their own sandbox block entirely. Accepts both
 * shapes to stay aligned with `MACF_OTEL_DISABLED` (see
 * `claude-sh.ts` — same family of opt-out env knobs).
 *
 * See macf#200 (original fd-deny bug), macf#208 (pattern-literal fix).
 */
export function installSandboxFdAllowRead(workspaceDir: string): void {
  const skip = process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  if (skip === '1' || skip === 'true') return;

  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  // Narrow the deep-nested read; operator-authored alien shapes at
  // any level default to a fresh empty branch rather than throwing.
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const filesystemRaw = (sandboxRaw['filesystem'] as Record<string, unknown> | undefined) ?? {};
  const existingAllow = Array.isArray(filesystemRaw['allowRead'])
    ? (filesystemRaw['allowRead'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  // Preserve operator-authored entries; drop any known-legacy MACF
  // patterns so the workspace ends up with exactly the current one.
  const preserved = existingAllow.filter(
    (entry) => !MACF_LEGACY_FD_PATTERNS.includes(entry),
  );

  // Idempotent short-circuit: only skip if the current pattern is
  // already present AND there's no legacy pattern to clean up.
  if (preserved.length === existingAllow.length && preserved.includes(SANDBOX_FD_READ_PATTERN)) {
    return;
  }

  const allowRead = preserved.includes(SANDBOX_FD_READ_PATTERN)
    ? preserved
    : [...preserved, SANDBOX_FD_READ_PATTERN];

  const updated: Settings = {
    ...settings,
    sandbox: {
      ...sandboxRaw,
      filesystem: {
        ...filesystemRaw,
        allowRead,
      },
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Canonical MACF-managed `sandbox.excludedCommands` entries.
 *
 * Per macf#211 + claude-code#43454: Claude Code 2.1.92+ has a seccomp
 * regression on Linux that breaks Bash inside the sandbox during the
 * shell's own startup (it reads from `/proc/self/fd/3` even before
 * user-code runs). Adding common dev-loop commands to
 * `excludedCommands` runs them unsandboxed, sidestepping the
 * regression while keeping sandbox protection for everything else.
 *
 * Three command classes:
 *
 *  - **Search/read** (`grep`, `rg`, `find`, `head`, `tail`, `cat`,
 *    `ls`, `wc`, `sort`, `awk`, `sed`, `diff`, `which`) — Bash tool's
 *    primary dev-loop commands; no side effects beyond the file view
 *    Claude already has via the `Read` tool.
 *  - **Shell wrappers** (`bash:*`, `sh:*`, `xargs:*`) — agent-
 *    composed shell pipelines; sandboxed versions fail at zsh-init
 *    even when the inner command is a no-op.
 *  - **Low-blast-radius filesystem mutations** (`mkdir:*`, `cp:*`,
 *    `touch:*`) — non-destructive create/copy. Higher-blast-radius
 *    mutations (`rm:*`, `mv:*`) are intentionally NOT in the list:
 *    keeping them sandboxed limits accidental damage paths.
 *
 * Plus the build-loop subset that was already canonical pre-#211:
 * `ssh:*`, `scp:*`, `rsync:*`, `devbox:*`, `nix:*`, `git:*`,
 * `gpg:*`, `gpg-agent:*`, `gh:*`, `npx:*`, `npm:*`, `node:*`,
 * `make:*`, `tmux:*`, `jq:*`, `openssl:*`. These were applied by
 * hand in operator workspaces; #211 bundles them into the canonical
 * set so `macf init` / `macf update` install them consistently.
 *
 * Keep this list in lockstep with `plugin/rules/coordination.md`'s
 * sandbox section (the operator-facing doc) — both are sources of
 * truth and any drift confuses operators reading either.
 */
export const SANDBOX_EXCLUDED_COMMANDS: readonly string[] = [
  // Build-loop / deployment
  'ssh:*',
  'scp:*',
  'rsync:*',
  'devbox:*',
  'nix:*',
  'git:*',
  'gpg:*',
  'gpg-agent:*',
  'gh:*',
  'npx:*',
  'npm:*',
  'node:*',
  'make:*',
  'tmux:*',
  'jq:*',
  'openssl:*',
  // Search/read dev-loop
  'grep:*',
  'rg:*',
  'find:*',
  'head:*',
  'tail:*',
  'cat:*',
  'ls:*',
  'wc:*',
  'sort:*',
  'awk:*',
  'sed:*',
  'diff:*',
  'which:*',
  // Shell wrappers (subprocesses fail at zsh-init under the
  // regression even when the inner command is a no-op)
  'bash:*',
  'sh:*',
  'xargs:*',
  // Low-blast-radius filesystem mutations. `rm:*` + `mv:*`
  // intentionally excluded — keep destructive ops sandboxed.
  'mkdir:*',
  'cp:*',
  'touch:*',
];

/**
 * Legacy MACF-managed `sandbox.excludedCommands` entries. Currently
 * empty — #211 is the first managed cycle. Future CLI versions can
 * append here when the canonical set drops a previously-managed
 * command, so `installSandboxExcludedCommands` removes those entries
 * from operator workspaces on next refresh.
 */
const MACF_LEGACY_EXCLUDED_COMMANDS: readonly string[] = [];

/**
 * Install (or refresh) the canonical MACF entries in
 * `.claude/settings.json`'s `sandbox.excludedCommands` array.
 * Idempotent: repeated calls don't duplicate.
 *
 * Operator-authored entries are preserved verbatim. Stale MACF-
 * managed entries (anything in MACF_LEGACY_EXCLUDED_COMMANDS) are
 * dropped before the current set is installed; current MACF entries
 * already present in the operator's list are left in their original
 * position rather than re-appended.
 *
 * Opt-out: `MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1|true` skips the
 * install entirely. Aligned with the
 * `MACF_SANDBOX_FD_FIX_SKIP` / `MACF_OTEL_DISABLED` family of opt-out
 * env knobs.
 *
 * See macf#211 (this issue), claude-code#43454 (upstream
 * regression), macf#200 / #208 (precedent fd allowRead pattern).
 */
export function installSandboxExcludedCommands(workspaceDir: string): void {
  const skip = process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'];
  if (skip === '1' || skip === 'true') return;

  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  // Mirror installSandboxFdAllowRead's deep-narrow shape — operator-
  // authored alien shapes default to fresh empty branches.
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const existing = Array.isArray(sandboxRaw['excludedCommands'])
    ? (sandboxRaw['excludedCommands'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  // Drop legacy MACF-managed entries, preserve everything else
  // (operator-authored AND current-MACF entries already present).
  const preserved = existing.filter(
    (entry) => !MACF_LEGACY_EXCLUDED_COMMANDS.includes(entry),
  );

  // Merge in the current canonical set. Skip duplicates so an
  // entry the operator already has stays in its original position
  // rather than being re-appended at the end.
  const merged = [...preserved];
  for (const entry of SANDBOX_EXCLUDED_COMMANDS) {
    if (!merged.includes(entry)) merged.push(entry);
  }

  // Idempotent short-circuit: nothing changed → skip the write.
  const sameLength = merged.length === existing.length;
  const sameContent = sameLength && merged.every((v, i) => v === existing[i]);
  if (sameContent) return;

  const updated: Settings = {
    ...settings,
    sandbox: {
      ...sandboxRaw,
      excludedCommands: merged,
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Read `.claude/settings.json`'s `sandbox.excludedCommands` array as
 * a list of strings. Returns an empty array if the file doesn't
 * exist or the nested shape is absent/alien. Mirrors
 * `getSandboxAllowRead` — used by `macf doctor` (follow-up under
 * #211 step 2) once it wires the parity check in.
 */
export function getSandboxExcludedCommands(workspaceDir: string): readonly string[] {
  const absDir = resolve(workspaceDir);
  const path = join(absDir, '.claude', 'settings.json');
  const settings = readSettings(path);
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const list = sandboxRaw['excludedCommands'];
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}

/**
 * Pattern that identifies MACF-managed skill-permission entries on
 * refresh. Any pattern starting with `Skill(macf-agent:` is
 * considered ours; mismatches are preserved verbatim.
 */
const MACF_SKILL_PATTERN_PREFIX = 'Skill(macf-agent:';

/**
 * Pattern that identifies MACF-managed MCP-tool-permission entries on
 * refresh (macf#349). Any pattern starting with this prefix is
 * considered ours; mismatches are preserved verbatim. Same lockstep
 * semantic as `MACF_SKILL_PATTERN_PREFIX`: drop-and-replace on each
 * `installPluginSkillPermissions` call so a since-removed channel-server
 * tool's pre-approval doesn't linger.
 */
const MACF_MCP_TOOL_PATTERN_PREFIX = 'mcp__plugin_macf-agent_macf-agent__';

/**
 * Install (or refresh) the MACF plugin-skill + MCP-tool pre-approval
 * entries in `.claude/settings.json`'s `permissions.allow` array.
 * Idempotent: stale entries (e.g. from a prior CLI version that listed
 * a since-removed skill or MCP tool) are dropped + replaced with the
 * current set. Non-MACF entries in `permissions.allow` are preserved.
 *
 * Two pre-approval surfaces installed in lockstep:
 *
 * 1. **Skill permissions** (`PLUGIN_SKILL_PERMISSIONS`) — pre-trust the
 *    4 plugin slash-commands (macf-status / macf-issues / macf-peers /
 *    macf-ping). See macf#189 sub-item 2.
 *
 * 2. **MCP tool permissions** (`PLUGIN_MCP_TOOL_PERMISSIONS`) — pre-trust
 *    the 2 channel-server MCP tools (notify_peer / checkpoint_to_memory).
 *    See macf#349. Without this, every first invocation of `notify_peer`
 *    fires an interactive approval dialog — blocking the Stop-hook
 *    autonomy contract from DR-023 UC-1 + UC-3.
 *
 * Both surfaces are MACF-managed: stale entries from prior CLI
 * versions get cleaned up via prefix-match drop. Operator-authored
 * patterns (like a wildcard `mcp__*` set up via Claude Code's "yes
 * and don't ask again" flow) are preserved verbatim.
 *
 * Creates the `.claude/` directory + settings.json if missing.
 */
export function installPluginSkillPermissions(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const existingAllow = Array.isArray(settings['permissions'] && (settings['permissions'] as { allow?: unknown })['allow'])
    ? ((settings['permissions'] as { allow: readonly string[] }).allow)
    : [];

  // Drop any prior MACF-managed entries so we install the current list
  // fresh (handles "skill or MCP tool was removed in plugin v0.1.N"
  // case — otherwise the stale pre-approval lingers forever).
  const preserved = existingAllow.filter((entry) => {
    if (typeof entry !== 'string') return true;
    if (entry.startsWith(MACF_SKILL_PATTERN_PREFIX)) return false;
    if (entry.startsWith(MACF_MCP_TOOL_PATTERN_PREFIX)) return false;
    return true;
  });

  const allow: string[] = [
    ...preserved,
    ...PLUGIN_SKILL_PERMISSIONS,
    ...PLUGIN_MCP_TOOL_PERMISSIONS,
  ];

  const existingPermissions = (settings['permissions'] as Record<string, unknown> | undefined) ?? {};
  const updated: Settings = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Install (or refresh) the MACF PreToolUse hook entries in
 * `<workspaceDir>/.claude/settings.json`. Currently installs:
 *   - `check-gh-token.sh` (groundnuty/macf#140 — attribution-trap defense)
 *   - `check-mention-routing.sh` (groundnuty/macf#244 + #272 — routing
 *     leak detector for raw `@<bot>[bot]` in describing-context)
 *   - `check-lgtm-gate.sh` (groundnuty/macf#270 — DR-023 UC-2; blocks
 *     `gh pr merge` when no non-author APPROVED review exists)
 *   - `check-close-keyword.sh` (groundnuty/macf#431 — blocks `gh pr
 *     create`/`edit` that would auto-close another agent's issue via a
 *     close-keyword adjacent to its ref)
 *
 * Plus, on the PostToolUse event:
 *   - `check-gh-attribution.sh` (groundnuty/macf#489 — after a `gh`-write
 *     op, reads the resource back from GitHub and warns (`exit 2`) if it
 *     was authored by the operator's user account instead of the bot;
 *     the result-invariant backstop to the #140 PreToolUse token check)
 *
 * And, on the UserPromptSubmit event:
 *   - `emit-turn-receipt.sh` (groundnuty/macf#444 — async turn-ack span)
 *
 * Creates the `.claude/` directory and the file if either is missing.
 * Idempotent: repeated calls don't duplicate entries.
 *
 * The PreToolUse + PostToolUse hooks share `matcher: "Bash"` because Claude
 * Code's matcher field gates which tool fires the hook; the wrapped-command
 * detection (gh vs git-push for token, gh issue/pr comment for routing,
 * gh pr merge for LGTM, gh-write for attribution) happens INSIDE each script.
 * Distinct entries per script keep them independently upgradeable +
 * diagnosable in `gh issue list` style settings audits.
 */
export function installGhTokenHook(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];
  const postToolUse = hooks.PostToolUse ?? [];
  const userPromptSubmit = hooks.UserPromptSubmit ?? [];

  // Drop any prior MACF-managed entries (any hook file in
  // MACF_HOOK_FILENAMES) so we can replace them cleanly — guards against
  // stale flags from older CLI versions + handles renames/additions to
  // the canonical hook set. Match by path-end equality so an
  // operator-authored file with a similar-but-distinct name
  // (e.g. `my-check-gh-token.sh-helper.sh`) doesn't get misclassified
  // as ours and accidentally clobbered.
  const preserved = preToolUse.filter(
    (entry) => !entry.hooks.some((h) => isMacfManagedCommand(h.command)),
  );

  const macfEntries: readonly HookEntry[] = [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_HOOK_COMMAND }],
    },
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_MENTION_HOOK_COMMAND }],
    },
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_LGTM_HOOK_COMMAND }],
    },
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_CLOSE_HOOK_COMMAND }],
    },
  ];

  // PostToolUse: the attribution-result hook (groundnuty/macf#489). Same
  // preserve-then-replace discipline as PreToolUse above — drop any prior
  // MACF-managed PostToolUse entry (by MACF_HOOK_FILENAMES basename) and
  // re-add ours, leaving operator-authored PostToolUse hooks intact. It runs
  // on the `PostToolUse` event (NOT PreToolUse) because it inspects the tool's
  // OUTPUT — the resource is already written; the hook reads it back from
  // GitHub and warns (`exit 2`) on a user-attributed write.
  const preservedPost = postToolUse.filter(
    (entry) => !entry.hooks.some((h) => isMacfManagedCommand(h.command)),
  );
  const macfPostEntries: readonly HookEntry[] = [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_ATTRIBUTION_HOOK_COMMAND }],
    },
  ];

  // UserPromptSubmit: the turn-ack receipt hook (groundnuty/macf#444). Same
  // preserve-then-replace discipline as PreToolUse above — drop any prior
  // MACF-managed UserPromptSubmit entry (by MACF_HOOK_FILENAMES basename) and
  // re-add ours, leaving operator-authored UserPromptSubmit hooks intact. No
  // `matcher` (UserPromptSubmit isn't tool-gated); `async: true` so it never
  // adds turn latency.
  const preservedUps = userPromptSubmit.filter(
    (entry) => !entry.hooks.some((h) => isMacfManagedCommand(h.command)),
  );
  const macfUpsEntries: readonly HookEntry[] = [
    {
      hooks: [{ type: 'command', command: MACF_TURN_RECEIPT_HOOK_COMMAND, async: true }],
    },
  ];

  const updated: Settings = {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [...preserved, ...macfEntries],
      PostToolUse: [...preservedPost, ...macfPostEntries],
      UserPromptSubmit: [...preservedUps, ...macfUpsEntries],
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}
