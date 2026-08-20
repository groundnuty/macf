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
import { readHooksMapEntries, resolvePluginDirFromClaudeSh } from './plugin-hook-resolver.js';
import { MCP_SERVER_NAME } from './mcp-json.js';

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
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** this hook's
 * REGISTRATION single-sourced into the plugin's `hooks/hooks.json` —
 * `installGhTokenHook` no longer writes it into settings.json. The
 * constant is retained for migration cleanup — `isMacfManagedCommand`
 * still recognizes + strips a legacy settings.json copy on refresh.
 *
 * **DR-039 phase 2 (groundnuty/macf#698):** the SCRIPT itself also moved —
 * it now lives at `packages/macf/plugin/scripts/check-gh-token.sh` (tamper-
 * resistant: the plugin invokes it via `${CLAUDE_PLUGIN_ROOT}/scripts/`, so
 * this constant is NO LONGER the command string the plugin's hooks.json
 * entry matches verbatim — see the plugin-hooks single-source lockstep
 * test's dedicated `${CLAUDE_PLUGIN_ROOT}` assertions instead). This
 * constant now scopes to ONLY the settings.json/`.claude/scripts/`
 * hand-wired-compat path: migration cleanup (above) and any still-hand-wired
 * substrate workspace that references the compat copy `copyCanonicalScripts`
 * distributes.
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
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json`. Per DR-039 phase 2 (groundnuty/macf#698) the
 * SCRIPT also moved into `packages/macf/plugin/scripts/` — the plugin's
 * hooks.json entry no longer matches this constant verbatim (it now uses
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`). Retained here ONLY for migration-cleanup
 * + the settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
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
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json`. Per DR-039 phase 2 (groundnuty/macf#698) the
 * SCRIPT also moved into `packages/macf/plugin/scripts/` — the plugin's
 * hooks.json entry no longer matches this constant verbatim (it now uses
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`). Retained here ONLY for migration-cleanup
 * + the settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
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
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json`. Per DR-039 phase 2 (groundnuty/macf#698) the
 * SCRIPT also moved into `packages/macf/plugin/scripts/` — the plugin's
 * hooks.json entry no longer matches this constant verbatim (it now uses
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`). Retained here ONLY for migration-cleanup
 * + the settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
 */
export const MACF_CLOSE_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-close-keyword.sh';

/**
 * Auditor-never-acts hook command (groundnuty/macf#499 — DR-026 F1). Blocks
 * state-mutating `gh` ops (`gh pr merge` / `gh issue close` / `gh pr close`)
 * when the active identity is the auditor (`MACF_AGENT_ROLE=auditor`), while
 * leaving the propose verbs (`gh issue/pr create|comment`) untouched. For every
 * NON-auditor identity the hook is inert (`exit 0` before any parsing), so
 * fleet-wide distribution via `macf init` / `macf update` is a no-op everywhere
 * except the auditor.
 *
 * Why structural and not permission-based: a GitHub App's `pull_requests:write`
 * grants merge+close TOGETHER with open-PR — there is no "open-a-PR-but-not-
 * merge" scope to express the auditor's write-proposals-only boundary, so it
 * must be enforced at tool-call time. Sister to the #140 / #244+#272 / #270 /
 * #431 PreToolUse hooks; override via MACF_SKIP_AUDITOR_ACT_CHECK=1.
 */
export const MACF_AUDITOR_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-auditor-never-acts.sh';

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
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json`. Per DR-039 phase 2 (groundnuty/macf#698) the
 * SCRIPT also moved into `packages/macf/plugin/scripts/` — the plugin's
 * hooks.json entry no longer matches this constant verbatim (it now uses
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`). Retained here ONLY for migration-cleanup
 * + the settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
 */
export const MACF_ATTRIBUTION_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-attribution.sh';

/**
 * Reflection-harvest PreCompact hook command (groundnuty/macf#500 — DR-026 F2).
 * At compaction (auto OR manual `/compact`), this hook harvests the agent's
 * *staged* reflection (`.claude/.macf/reflections/pending.json`, maintained
 * incrementally per `reflection-staging.md`), wraps it in the versioned
 * reflection-schema envelope (`@groundnuty/macf-core` `ReflectionRecordSchema`),
 * appends it as one line to a local per-session JSONL ledger, and clears the
 * stage. F4's Monitor reads the ledger back.
 *
 * It runs on the `PreCompact` event (matcher-less, like SessionStart / Stop /
 * UserPromptSubmit). Per DR-023 §UC-3 it is observational + NON-BLOCKING: the
 * script ALWAYS `exit 0` (even on internal error) so it can never delay/block
 * compaction. Fast + local; no network. Override: MACF_SKIP_REFLECTION_HARVEST=1.
 *
 * Distinct from the plugin's existing PreCompact `checkpoint_to_memory`
 * mcp_tool entry (DR-023 §UC-3 session-checkpoint): that ships via the plugin
 * `hooks.json` mcp_tool path; THIS is a bash command-type hook that ALSO now
 * ships via the plugin's `hooks.json` (see the DR-039 note below) — both
 * coexist on the PreCompact event there.
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json` (no longer written into settings.json by
 * `installGhTokenHook`). Per DR-039 phase 2 (groundnuty/macf#698) the SCRIPT
 * also moved into `packages/macf/plugin/scripts/` — the plugin's hooks.json
 * entry no longer matches this constant verbatim (it now uses
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`). Retained here ONLY for migration-cleanup
 * + the settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
 */
export const MACF_REFLECTION_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/harvest-reflection.sh';

/**
 * Channels-enabled-guard SessionStart hook command (groundnuty/macf#633). At
 * session start, this hook reads the macf-agent MCP server's own startup log
 * back and warns LOUDLY into the agent's context when channel notifications are
 * OFF for the session — the result-invariant (Pattern A) backstop to macf#632
 * (which ENABLES channels in claude.sh). When channels are silently off (wrong
 * flag value, old claude, opt-out, or a bare `claude` launch that bypassed
 * claude.sh) every routed issue/PR/mention is dropped with no signal; this
 * guard surfaces that so the agent stops trusting "no pings = idle".
 *
 * It runs on the `SessionStart` event (matcher-less, like UserPromptSubmit /
 * PreCompact). OBSERVATIONAL + NON-BLOCKING: the script ALWAYS exits 0 (fail
 * open on a missing/unreadable log, a poll timeout, or any internal error) so
 * it can never block a session. STDOUT is injected into the agent's context —
 * that is how the warning reaches the agent. Override: MACF_SKIP_CHANNELS_CHECK=1.
 *
 * Distributed via `macf init` / `macf update` / `macf rules refresh` like the
 * other check-*.sh hooks (CLI-shipped, NOT a plugin hook — so it needs no
 * marketplace re-tag to land).
 */
export const MACF_CHANNELS_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channels-enabled.sh';

/**
 * Channel-alive liveness-guard hook command (groundnuty/macf#734). Registered
 * on BOTH the `SessionStart` and `UserPromptSubmit` events: it probes THIS
 * agent's own channel-server `/health` endpoint over mTLS (endpoint learned
 * from the newest `server_started` line in the agent's own channel.log; certs
 * from MACF_CA_CERT/MACF_AGENT_CERT/MACF_AGENT_KEY) and warns LOUDLY into the
 * agent's context when it does NOT respond — the missing detect-half
 * check-channels-enabled.sh (#633) doesn't cover: that guard asserts native
 * channel-push is ENABLED for the session (a one-time config/flag question);
 * this guard asserts the channel-server PROCESS is still alive right now,
 * re-checked periodically through the session. Motivated by a real incident:
 * an agent's channel-server process died and went unnoticed for ~55 minutes
 * because the Claude Code TUI (a separate process) kept working fine.
 *
 * Throttled via a local timestamp file (`.claude/.macf/.channel-alive-last-check`)
 * so the mTLS probe doesn't fire on every single turn — SessionStart always
 * probes (fresh session); UserPromptSubmit is bounded to roughly once per 5
 * minutes. OBSERVATIONAL + NON-BLOCKING: the script ALWAYS exits 0 (fail open
 * on a missing log, missing certs, missing curl, or any internal error) so it
 * can never block a turn or a session. Override: MACF_SKIP_CHANNEL_ALIVE_CHECK=1.
 *
 * Distributed via `macf init` / `macf update` / `macf rules refresh` to
 * `.claude/scripts/` for the hand-wired-compat path (see the DR-039 phase 2
 * note below for the plugin-mounted copy that's actually load-bearing).
 *
 * **DR-039 Decision 2 (groundnuty/macf#731/#739):** single-sourced into the
 * plugin's `hooks/hooks.json` (registered on BOTH SessionStart AND
 * UserPromptSubmit there, mirroring the dual registration this comment
 * describes) — no longer written into settings.json by `installGhTokenHook`.
 * Per DR-039 phase 2 (groundnuty/macf#698) the SCRIPT also moved into
 * `packages/macf/plugin/scripts/` — the plugin's hooks.json entry no longer
 * matches this constant verbatim (it now uses `${CLAUDE_PLUGIN_ROOT}/scripts/`
 * on both events). Retained here ONLY for migration-cleanup + the
 * settings.json/`.claude/scripts/` hand-wired-compat path (see
 * `MACF_HOOK_COMMAND`'s comment above).
 */
export const MACF_CHANNEL_ALIVE_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channel-alive.sh';

/**
 * The hook filenames used to identify MACF-managed entries on refresh.
 * Matched by path-end equality (see isMacfManagedCommand) so operator
 * files with a similar-but-distinct basename are not misclassified.
 *
 * Per DR-039 Decision 2 (groundnuty/macf#731/#739), 7 of these 10 filenames
 * (check-gh-token / check-mention-routing / check-lgtm-gate /
 * check-close-keyword / check-gh-attribution / harvest-reflection /
 * check-channel-alive) are no longer RE-ADDED by `installGhTokenHook` — their
 * registration single-sourced into the plugin's `hooks/hooks.json`. They stay
 * in this list so the preserve-filter keeps recognizing + stripping a legacy
 * settings.json copy left over from a pre-migration CLI version (migration
 * cleanup is idempotent: nothing to strip on an already-migrated workspace).
 * The remaining 3 (check-auditor-never-acts / emit-turn-receipt /
 * check-channels-enabled) are still actively re-installed hand-wired hooks.
 */
const MACF_HOOK_FILENAMES: readonly string[] = [
  'check-gh-token.sh',
  'check-mention-routing.sh',
  'check-lgtm-gate.sh',
  'check-close-keyword.sh',
  'check-auditor-never-acts.sh',
  'emit-turn-receipt.sh',
  'check-gh-attribution.sh',
  'harvest-reflection.sh',
  'check-channels-enabled.sh',
  'check-channel-alive.sh',
];

/**
 * The subset of `MACF_HOOK_FILENAMES` DR-039 Decision 2 single-sourced into
 * the plugin's `hooks/hooks.json` — the 7 filenames `installGhTokenHook` no
 * longer RE-ADDS. This is the exact set the self-guard below
 * (`canPluginDeliverMigratedHooks`) checks for in the loaded plugin's own
 * `hooks.json` before permitting a strip of a legacy settings.json copy.
 * Kept as its own constant (rather than re-deriving from MACF_HOOK_FILENAMES)
 * because the 3 hand-wired filenames (check-auditor-never-acts /
 * emit-turn-receipt / check-channels-enabled) are unconditionally
 * stripped-then-replaced regardless of plugin-delivery capability — only
 * these 7 are gated.
 */
const MIGRATED_HOOK_FILENAMES: readonly string[] = [
  'check-gh-token.sh',
  'check-mention-routing.sh',
  'check-lgtm-gate.sh',
  'check-close-keyword.sh',
  'check-gh-attribution.sh',
  'harvest-reflection.sh',
  'check-channel-alive.sh',
];

/**
 * Extract the program's basename from a hook command string — the first
 * whitespace-delimited token, path-stripped. `/a/b/check-gh-token.sh --v2`
 * → `check-gh-token.sh`. Shared by `isMacfManagedCommand` (full 10-name set)
 * and `isMigratedHookCommand` (the 7-name migrated subset) so both matchers
 * apply the identical path-end-equality discriminator.
 */
function basenameOfCommand(command: string | undefined): string {
  // A hook entry need not have a `command` — a `type: "mcp_tool"` hook (e.g. a
  // hand-wired PreCompact `checkpoint_to_memory`) has `server`/`tool`/`input`
  // and NO `command`. Every caller passes `hook.command`, which the settings
  // shape types as `string` but is `undefined` at runtime for those entries.
  // Guard here (the shared chokepoint) so the DR-039 hook-strip migration
  // treats a non-command hook as "not a managed command" (never stripped)
  // rather than crashing on `undefined.trim()` (groundnuty/macf#757).
  if (typeof command !== 'string') return '';
  const program = command.trim().split(/\s+/)[0] ?? '';
  const slash = program.lastIndexOf('/');
  return slash >= 0 ? program.slice(slash + 1) : program;
}

/**
 * True iff the command string represents one of our managed hooks — i.e.
 * the command invokes a file whose basename equals any MACF_HOOK_FILENAMES
 * entry (ignoring any trailing flags/arguments). Defensive against
 * operator-authored commands that happen to contain our filename as a
 * substring (e.g. `./my-check-gh-token.sh-wrapper --flag`).
 */
function isMacfManagedCommand(command: string | undefined): boolean {
  return MACF_HOOK_FILENAMES.includes(basenameOfCommand(command));
}

/**
 * True iff the command string represents one of the 7 DR-039 Decision 2
 * migrated hooks (the subset of MACF_HOOK_FILENAMES single-sourced into the
 * plugin's hooks.json). Used by the self-guard to distinguish "strip only if
 * the plugin can deliver" entries from the 3 hand-wired hooks that are
 * always stripped-then-replaced unconditionally.
 */
function isMigratedHookCommand(command: string | undefined): boolean {
  return MIGRATED_HOOK_FILENAMES.includes(basenameOfCommand(command));
}

/**
 * Result of `canPluginDeliverMigratedHooks` — whether the EFFECTIVE loaded
 * plugin (per `resolvePluginDirFromClaudeSh`) registers the full DR-039
 * Decision 2 migrated hook set, plus a human-readable reason.
 */
export interface PluginDeliveryCheck {
  readonly canDeliver: boolean;
  readonly detail: string;
}

/**
 * DR-039 Amendment B self-guard (groundnuty/macf#743 science-agent review):
 * before `installGhTokenHook` strips a now-plugin-owned hook out of
 * settings.json, verify the POSITIVE invariant that the effective loaded
 * plugin can actually deliver the migrated hook set — don't strip on the
 * assumption that "the migration says the plugin owns it now" is always
 * true for THIS workspace's launcher. Mirrors the DR-037 Amendment B lesson
 * (verify "can deliver" BEFORE removing a fallback) applied here to the
 * DR-039 Decision 2 hook-strip instead of the fleet-reconcile path. Without
 * this guard, a hooks-less-plugin launcher (e.g. devops's `plugin-cs` relic
 * — a `--plugin-dir` pointing at a stripped/minimal plugin variant with no
 * `hooks/hooks.json` entries) gets its hand-wired settings.json copies
 * stripped on the next `macf update`, landing in a TOTAL hook-loss gap:
 * neither settings.json nor the plugin delivers the guard.
 *
 * Reuses the SAME plugin-dir resolver `macf doctor`'s DR-039 Decision 1
 * assertion uses (`resolvePluginDirFromClaudeSh`, extracted to
 * `plugin-hook-resolver.ts` precisely so this module and `doctor.ts` share
 * one resolver and can never silently disagree about which plugin is "the
 * loaded one"). Deliberately inspects ONLY the plugin's own `hooks.json` —
 * NOT the settings.json union `doctor.ts`'s `getEffectiveHookConfig`
 * computes — because settings.json is exactly what we're about to strip;
 * folding it into "can deliver" would be circular (a not-yet-stripped
 * legacy copy would count as "the plugin can deliver" even when it can't).
 *
 * Fail-safe: any ambiguity (claude.sh absent/unreadable, no --plugin-dir,
 * multiple distinct --plugin-dir values) is treated as "cannot confirm
 * delivery" → `canDeliver: false` → the caller defers the strip. This is
 * the OPPOSITE default from `doctor.ts`'s own "err toward not-false-alarming"
 * fallback-to-default posture (`getEffectiveHookConfig` checks the default
 * `.macf/plugin` location when the launcher is ambiguous, to avoid a false
 * WARN) — here the cost of erring the other way is a total hook-loss gap
 * (a hooks-less plugin PLUS a stripped settings.json), so ambiguity must
 * resolve toward KEEPING the hand-wired copies, never toward assuming a
 * default plugin dir is fine.
 */
export function canPluginDeliverMigratedHooks(workspaceDir: string): PluginDeliveryCheck {
  const resolution = resolvePluginDirFromClaudeSh(workspaceDir);
  if (!resolution.determinable || !resolution.dir) {
    return {
      canDeliver: false,
      detail:
        `plugin dir not cleanly determinable from claude.sh (${resolution.detail}) — ` +
        'cannot confirm the effective plugin delivers the migrated hook set',
    };
  }
  const hooksJsonPath = join(resolution.dir, 'hooks', 'hooks.json');
  const entries = readHooksMapEntries(hooksJsonPath);
  const missing = MIGRATED_HOOK_FILENAMES.filter(
    (filename) => !entries.some((e) => e.kind === 'command' && e.value.includes(filename)),
  );
  if (missing.length > 0) {
    return {
      canDeliver: false,
      detail: `loaded plugin (${resolution.dir}) does not register: ${missing.join(', ')}`,
    };
  }
  return {
    canDeliver: true,
    detail: `loaded plugin (${resolution.dir}) registers the full migrated hook set`,
  };
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

/**
 * Exported (DR-040 Decision 3 / macf#698 R1): the canonical-compute tier-check
 * (`packages/macf/src/cli/fleet/canonical-compute.ts`) needs this shape to
 * parse a workspace's on-disk `.claude/settings.json` and feed it through the
 * SAME transform functions this module's `installXxx` writers use, so the
 * dry-run "would `macf update` change this file" check is byte-for-byte the
 * same logic as the real write path — never a re-implementation that can drift.
 */
export interface Settings {
  hooks?: {
    PreToolUse?: HookEntry[];
    PostToolUse?: HookEntry[];
    PreCompact?: HookEntry[];
    SessionStart?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
  };
  /**
   * Pre-approved `.mcp.json` MCP servers (DR-022 Amendment P,
   * groundnuty/macf#995) — skips Claude Code's server-approval prompt for
   * a non-plugin MCP server. Written/merged by
   * `applyPluginSkillPermissionsTransform`.
   */
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

/**
 * Exported (DR-040 Decision 3 / macf#698 R1) — the canonical-compute tier-check
 * reads a workspace's settings.json with the exact same malformed-JSON-throws
 * semantics as the real writers (never silently treats broken JSON as `{}`).
 */
export function readSettings(path: string): Settings {
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
/**
 * DR-028 universal floor `allow` tools (every role). Broad `Bash(*)` — narrow
 * patterns are defeated by `$GH_TOKEN`/`$MACF_WORKSPACE_DIR` "simple_expansion";
 * the real defense is the `deny` floor + the PreToolUse hooks, NOT
 * allow-narrowing. `Write`/`Edit` close the memory-edit prompt. Defined here
 * (zero deps) so `role-settings-model.ts` re-exports it without an import cycle
 * (that module imports the hook constants FROM here). See
 * `design/decisions/DR-028-expected-settings-per-role.md`.
 */
export const ROLE_FLOOR_ALLOW: readonly string[] = [
  'Bash(*)',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
];

/**
 * DR-028 universal floor `deny` — the real guardrail (seeded from devops's set,
 * the most complete of the three working agents): credential/secret reads +
 * config/dotfile writes + dangerous commands.
 *
 * **Only `Edit(<path>)` for the config/dotfile-write section — never
 * `Write(<path>)` (groundnuty/macf#1067).** Per Claude Code's permissions
 * docs ("Configure permissions" § Read and Edit): "Claude Code checks file
 * permissions against `Edit(path)` and `Read(path)` rules only. If you
 * write a path rule for `Write`, `NotebookEdit`, `Glob`, or the legacy
 * `MultiEdit` tool instead, Claude Code accepts the rule but never
 * consults it" — and prints a startup warning naming the dead rule on
 * every launch. `Edit(path)` alone is sufficient: "`Edit` rules apply to
 * all built-in tools that edit files" (Write, NotebookEdit, Glob,
 * MultiEdit included). This array used to carry a `Write(<path>)` +
 * `Edit(<path>)` PAIR per credential path — the `Write()` half never did
 * anything and only produced startup-warning noise; it has been dropped.
 * See `MACF_LEGACY_DENY_WRITE_PATTERNS` below for the existing-workspace
 * convergence story (a workspace provisioned before this fix carries the
 * stale `Write(<path>)` entries in its settings.json and needs them
 * actively stripped on `macf update` / `doctor --fix`, not just omitted
 * from the new canonical list).
 */
export const ROLE_FLOOR_DENY: readonly string[] = [
  // credential / secret reads
  'Read(~/.ssh/id_*)',
  'Read(~/.ssh/*.pem)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.kube/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.netrc)',
  'Read(~/.config/gh/**)',
  'Read(~/.bash_history)',
  'Read(~/.zsh_history)',
  // config / dotfile writes — Edit(path) only; see doc comment above.
  'Edit(~/.claude/settings.json)',
  'Edit(~/.claude.json)',
  'Edit(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Edit(~/.gnupg/**)',
  'Edit(~/.kube/**)',
  'Edit(~/.config/gcloud/**)',
  'Edit(~/.gitconfig)',
  'Edit(~/.npmrc)',
  'Edit(~/.pypirc)',
  'Edit(~/.docker/config.json)',
  'Edit(~/.netrc)',
  'Edit(~/.config/gh/**)',
  'Edit(~/.bashrc)',
  'Edit(~/.zshrc)',
  'Edit(~/.profile)',
  'Edit(~/.bash_profile)',
  'Edit(~/.zprofile)',
  'Edit(~/.zshenv)',
  // dangerous commands
  'Bash(sudo *)',
  'Bash(rm -rf /)',
  'Bash(git push --force*)',
  'Bash(git push * --force*)',
  'Bash(git push -f)',
  'Bash(git push -f *)',
  'Bash(git push * -f)',
  'Bash(git push * -f *)',
  'Bash(git commit --no-verify *)',
  'Bash(git commit -n *)',
];

export const PLUGIN_SKILL_PERMISSIONS: readonly string[] = [
  'Skill(macf-agent:macf-status)',
  'Skill(macf-agent:macf-issues)',
  'Skill(macf-agent:macf-peers)',
  'Skill(macf-agent:macf-ping)',
  'Skill(macf-agent:macf-notify-peer)',
];

/**
 * Permission patterns pre-approving the MCP tools that
 * `@groundnuty/macf-channel-server` registers on the `macf-agent` MCP
 * server. Without these, every first invocation of `notify_peer` or
 * `checkpoint_to_memory` (autonomous agent calls AND operator-driven
 * coordination) fires an interactive approval dialog, blocking the
 * Stop-hook autonomy contract from DR-023 UC-1 + UC-3.
 *
 * macf#349: operator-witnessed 2026-05-04 on PPAM 2026 macbook —
 * cross-agent `notify_peer` worked but each fresh workspace prompted
 * "Yes, and don't ask again for plugin:macf-agent:macf-agent -
 * notify_peer commands" before delivery. Sister-bug to macf#189
 * sub-item 2 (skill pre-approval) but for the MCP-tool surface that
 * the original install-time pre-approval missed.
 *
 * **Pattern format flipped to `mcp__<server-key>__<tool-name>` (DR-022
 * Amendment P, groundnuty/macf#995).** Through macf#889 the channel-server
 * mounted via the plugin's `mcpServers` (`mcp__plugin_<plugin-name>_
 * <server-key>__<tool-name>`); Amendment P moved it to a project
 * `.mcp.json` `server:macf-agent` entry (`mcp-json.ts`), and Claude Code's
 * MCP tool namespace for a manually-configured server drops the `plugin_`
 * infix entirely — `mcp__macf-agent__<tool-name>`. Server key = `macf-agent`
 * (per `mcp-json.ts::MCP_SERVER_NAME`, the SAME key `.mcp.json`'s
 * `mcpServers` map uses). Tool names match the channel-server's
 * `mcp.mcp.registerTool(...)` first-arg in
 * `packages/macf-channel-server/src/server.ts`.
 *
 * Keep in lockstep with the channel-server's tool registration list.
 * When a new tool is added to the channel-server, add its pattern here
 * + bump CLI version. Operators on older CLIs gate the new tool on
 * one-time approval until they `macf update`.
 */
export const PLUGIN_MCP_TOOL_PERMISSIONS: readonly string[] = [
  'mcp__macf-agent__notify_peer',
  'mcp__macf-agent__checkpoint_to_memory',
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
 * Read the workspace-effective set of hook command strings — the union of
 * `.claude/settings.json` + `.claude/settings.local.json` across EVERY hook
 * event (PreToolUse / PostToolUse / UserPromptSubmit / PreCompact / …). The
 * order-/event-agnostic command list is what `macf doctor` (DR-028) validates
 * against the role model: the model identifies a wired hook by its command
 * string (the same identity `installGhTokenHook` writes), not by which event
 * array it lives in, so a flat deduped command set is the right comparison
 * surface. Throws on malformed JSON in either file (via `readSettings`).
 */
export function getHookCommands(workspaceDir: string): readonly string[] {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const commands: string[] = [];
  for (const file of ['settings.json', 'settings.local.json'] as const) {
    const settings = readSettings(join(claudeDir, file));
    const hooks = settings.hooks ?? {};
    for (const event of Object.keys(hooks)) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of entry.hooks ?? []) {
          if (typeof h.command === 'string') commands.push(h.command);
        }
      }
    }
  }
  return Array.from(new Set(commands));
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
/**
 * Pure transform: apply the canonical `sandbox.filesystem.allowRead` entry to
 * a parsed `settings` object. Exported (DR-040 Decision 3 / macf#698 R1) so
 * the canonical-compute tier-check can apply this SAME logic in-memory
 * (without writing) to classify a dirty settings.json as already-canonical
 * vs genuine-delta. Operator-authored entries preserved; legacy MACF patterns
 * (`MACF_LEGACY_FD_PATTERNS`) dropped before the current pattern is added.
 */
export function applySandboxFdAllowReadTransform(settings: Settings): Settings {
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

  const allowRead = preserved.includes(SANDBOX_FD_READ_PATTERN)
    ? preserved
    : [...preserved, SANDBOX_FD_READ_PATTERN];

  return {
    ...settings,
    sandbox: {
      ...sandboxRaw,
      filesystem: {
        ...filesystemRaw,
        allowRead,
      },
    },
  };
}

export function installSandboxFdAllowRead(workspaceDir: string): void {
  const skip = process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  if (skip === '1' || skip === 'true') return;

  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const filesystemRaw = (sandboxRaw['filesystem'] as Record<string, unknown> | undefined) ?? {};
  const existingAllow = Array.isArray(filesystemRaw['allowRead'])
    ? (filesystemRaw['allowRead'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const preserved = existingAllow.filter(
    (entry) => !MACF_LEGACY_FD_PATTERNS.includes(entry),
  );

  // Idempotent short-circuit: only skip if the current pattern is
  // already present AND there's no legacy pattern to clean up.
  if (preserved.length === existingAllow.length && preserved.includes(SANDBOX_FD_READ_PATTERN)) {
    return;
  }

  const updated = applySandboxFdAllowReadTransform(settings);
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
/**
 * Pure transform: apply the canonical `sandbox.excludedCommands` merge to a
 * parsed `settings` object. Exported (DR-040 Decision 3 / macf#698 R1) so the
 * canonical-compute tier-check can apply this SAME logic in-memory (without
 * writing). Preserves operator-authored entries + already-present MACF
 * entries in position; drops legacy MACF entries; appends missing canonical
 * entries.
 */
export function applySandboxExcludedCommandsTransform(settings: Settings): Settings {
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

  return {
    ...settings,
    sandbox: {
      ...sandboxRaw,
      excludedCommands: merged,
    },
  };
}

export function installSandboxExcludedCommands(workspaceDir: string): void {
  const skip = process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'];
  if (skip === '1' || skip === 'true') return;

  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const existing = Array.isArray(sandboxRaw['excludedCommands'])
    ? (sandboxRaw['excludedCommands'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const preserved = existing.filter(
    (entry) => !MACF_LEGACY_EXCLUDED_COMMANDS.includes(entry),
  );
  const merged = [...preserved];
  for (const entry of SANDBOX_EXCLUDED_COMMANDS) {
    if (!merged.includes(entry)) merged.push(entry);
  }

  // Idempotent short-circuit: nothing changed → skip the write.
  const sameLength = merged.length === existing.length;
  const sameContent = sameLength && merged.every((v, i) => v === existing[i]);
  if (sameContent) return;

  const updated = applySandboxExcludedCommandsTransform(settings);
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
const MACF_MCP_TOOL_PATTERN_PREFIX = 'mcp__macf-agent__';

/**
 * The PRE-macf#995 pattern prefix (plugin-mounted namespace, DR-022
 * Amendment P). Kept ONLY so the drop-and-replace below also strips a
 * workspace's stale pre-migration entries — without this, an
 * already-init'd workspace's old `mcp__plugin_macf-agent_macf-agent__*`
 * patterns would fail to match the NEW `MACF_MCP_TOOL_PATTERN_PREFIX` and
 * be mistaken for operator-authored (preserved forever instead of cleaned
 * up). Same migration-cleanup shape as `MACF_HOOK_FILENAMES` /
 * `isMacfManagedCommand` elsewhere in this file.
 */
const MACF_LEGACY_MCP_TOOL_PATTERN_PREFIX = 'mcp__plugin_macf-agent_macf-agent__';

/**
 * Superseded `Write(<credential-path>)` deny entries earlier CLI versions
 * wrote into `ROLE_FLOOR_DENY` alongside a paired `Edit(<same-path>)` entry
 * (groundnuty/macf#1067). Claude Code's file-permission check consults only
 * `Edit(path)` + `Read(path)` rules; a `Write(path)` entry is accepted into
 * settings.json but never consulted, and Claude Code prints a startup
 * warning naming it as ineffective on every agent launch. The paired
 * `Edit(<path>)` entry already provides the real protection (`Edit` rules
 * cover all built-in file-editing tools for that path — Write, NotebookEdit,
 * Glob, MultiEdit), so dropping the `Write()` half from the canonical list
 * doesn't weaken anything.
 *
 * Listed here (distinct from the canonical `ROLE_FLOOR_DENY` above) so an
 * ALREADY-provisioned workspace's stale copy of these entries is actively
 * stripped on `macf update` / `doctor --fix`, not just silently omitted
 * from the new canonical list. Without this, the union-preserve merge below
 * can't tell "a canonical entry this CLI version superseded" from "a
 * genuine operator-authored deny on some other path" — the stale entry
 * would be treated as the latter and preserved forever. Same migration-
 * cleanup shape as `MACF_LEGACY_MCP_TOOL_PATTERN_PREFIX` /
 * `MACF_LEGACY_FD_PATTERNS` elsewhere in this file.
 *
 * Exported so `doctor.ts` can flag PRESENCE of any of these as drift (not
 * just absence of the canonical floor) — otherwise `macf doctor` reports a
 * stale-but-otherwise-compliant workspace as PASS (it already has all 39
 * current `ROLE_FLOOR_DENY` entries; `denyFindings` only checks for missing
 * entries, never superseded ones) and `doctor --fix`'s `needsFix` gate never
 * trips, so `--fix` never calls the emitter that would strip them. `macf
 * update` still converges unconditionally regardless of this — see
 * `commands/update.ts`.
 */
export const MACF_LEGACY_DENY_WRITE_PATTERNS: readonly string[] = [
  'Write(~/.claude/settings.json)',
  'Write(~/.claude.json)',
  'Write(~/.ssh/**)',
  'Write(~/.aws/**)',
  'Write(~/.gnupg/**)',
  'Write(~/.kube/**)',
  'Write(~/.config/gcloud/**)',
  'Write(~/.gitconfig)',
  'Write(~/.npmrc)',
  'Write(~/.pypirc)',
  'Write(~/.docker/config.json)',
  'Write(~/.netrc)',
  'Write(~/.config/gh/**)',
  'Write(~/.bashrc)',
  'Write(~/.zshrc)',
  'Write(~/.profile)',
  'Write(~/.bash_profile)',
  'Write(~/.zprofile)',
  'Write(~/.zshenv)',
];

/**
 * Install (or refresh) the MACF plugin-skill + MCP-tool pre-approval
 * entries in `.claude/settings.json` (kept-named for back-compat — see
 * `installGhTokenHook`'s doc comment for the same naming convention; this
 * function now manages a THIRD settings.json surface alongside its
 * original two). Idempotent: stale entries (e.g. from a prior CLI version
 * that listed a since-removed skill or MCP tool, or the pre-macf#995
 * plugin-mounted MCP-tool namespace) are dropped + replaced with the
 * current set. Non-MACF entries are preserved.
 *
 * Three pre-approval surfaces installed in lockstep:
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
 * 3. **`enabledMcpjsonServers`** (DR-022 Amendment P, groundnuty/macf#995) —
 *    pre-approve the `.mcp.json` `macf-agent` server ITSELF, so launch
 *    doesn't stall on Claude Code's server-approval prompt for a
 *    non-plugin MCP server. Merge-preserving (ensures `macf-agent` is
 *    present in the array; never overwrites operator-added entries) rather
 *    than drop-and-replace, since this array isn't scoped to MACF-managed
 *    patterns the way `permissions.allow` is.
 *
 * All three surfaces are MACF-managed: stale entries from prior CLI
 * versions get cleaned up via prefix-match drop (surfaces 1+2) or
 * presence-merge (surface 3). Operator-authored patterns (like a wildcard
 * `mcp__*` set up via Claude Code's "yes and don't ask again" flow, or an
 * operator's own `.mcp.json` server enabled here) are preserved verbatim.
 *
 * Creates the `.claude/` directory + settings.json if missing.
 */
/**
 * Pure transform: apply the canonical plugin-skill + MCP-tool pre-approval
 * merge (+ the DR-028 role floor) to a parsed `settings` object. Exported
 * (DR-040 Decision 3 / macf#698 R1) so the canonical-compute tier-check can
 * apply this SAME logic in-memory (without writing).
 */
export function applyPluginSkillPermissionsTransform(settings: Settings): Settings {
  const existingAllow = Array.isArray(settings['permissions'] && (settings['permissions'] as { allow?: unknown })['allow'])
    ? ((settings['permissions'] as { allow: readonly string[] }).allow)
    : [];

  // Drop any prior MACF-managed entries so we install the current list
  // fresh (handles "skill or MCP tool was removed in plugin v0.1.N"
  // case — otherwise the stale pre-approval lingers forever). Also drops
  // the PRE-macf#995 legacy MCP-tool pattern prefix (DR-022 Amendment P) —
  // a workspace updating from before the mount moved would otherwise keep
  // a dead `mcp__plugin_macf-agent_macf-agent__*` entry forever, mistaken
  // for operator-authored.
  const preserved = existingAllow.filter((entry) => {
    if (typeof entry !== 'string') return true;
    if (entry.startsWith(MACF_SKILL_PATTERN_PREFIX)) return false;
    if (entry.startsWith(MACF_MCP_TOOL_PATTERN_PREFIX)) return false;
    if (entry.startsWith(MACF_LEGACY_MCP_TOOL_PATTERN_PREFIX)) return false;
    return true;
  });

  // DR-028 (macf#534): emit the role-aware floor — not just skill/mcp perms.
  // `Bash(*)` + Read/Write/Edit/etc close the "pure-init agent prompts on every
  // command" + the memory-edit gaps; `deny` is the real guardrail. Dedup so a
  // workspace whose hand-wired settings already carry the floor (the substrate)
  // doesn't double entries. Floor + plugin perms FIRST, then preserved operator
  // extras (minus the stale macf-managed skill/mcp entries dropped above + any
  // floor entry already present, to avoid duplicates).
  const floorAndPlugin = [
    ...ROLE_FLOOR_ALLOW,
    ...PLUGIN_SKILL_PERMISSIONS,
    ...PLUGIN_MCP_TOOL_PERMISSIONS,
  ];
  const floorSet = new Set<string>(floorAndPlugin);
  const allow: string[] = [
    ...floorAndPlugin,
    ...preserved.filter((e) => !(typeof e === 'string' && floorSet.has(e))),
  ];

  // DR-028 deny floor — union with operator-authored deny entries (preserve
  // extras, dedup, idempotent on re-run). Drop superseded MACF-managed
  // `Write(<credential-path>)` entries first (groundnuty/macf#1067) — those
  // are no longer in ROLE_FLOOR_DENY (replaced by the already-paired
  // `Edit(<path>)` entry, the form Claude Code actually consults), so
  // without this explicit strip an already-provisioned workspace's stale
  // copies would be mistaken for operator-authored and preserved forever.
  const existingDeny = Array.isArray(
    settings['permissions'] && (settings['permissions'] as { deny?: unknown })['deny'],
  )
    ? (settings['permissions'] as { deny: readonly string[] }).deny
    : [];
  const legacyDenyWriteSet = new Set<string>(MACF_LEGACY_DENY_WRITE_PATTERNS);
  const preservedDeny = existingDeny.filter(
    (e) => !(typeof e === 'string' && legacyDenyWriteSet.has(e)),
  );
  const denySet = new Set<string>(ROLE_FLOOR_DENY);
  const deny: string[] = [
    ...ROLE_FLOOR_DENY,
    ...preservedDeny.filter((e) => !(typeof e === 'string' && denySet.has(e))),
  ];

  const existingPermissions = (settings['permissions'] as Record<string, unknown> | undefined) ?? {};

  // Pre-approve the .mcp.json macf-agent server itself (DR-022 Amendment P,
  // groundnuty/macf#995) — without this, EVERY launch stalls on the
  // server-approval prompt Claude Code shows for a non-plugin `.mcp.json`
  // MCP server before it will connect. Merge-preserving: an operator may
  // have their own `.mcp.json` servers already enabled here (macf#995's
  // merge-not-clobber contract applies to this array too) — ensure
  // `macf-agent` is present, never overwrite the whole array.
  const existingEnabledMcpServers = Array.isArray(settings['enabledMcpjsonServers'])
    ? (settings['enabledMcpjsonServers'] as readonly unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  const enabledMcpjsonServers = existingEnabledMcpServers.includes(MCP_SERVER_NAME)
    ? existingEnabledMcpServers
    : [...existingEnabledMcpServers, MCP_SERVER_NAME];

  return {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
      deny,
    },
    enabledMcpjsonServers,
  };
}

export function installPluginSkillPermissions(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const updated = applyPluginSkillPermissionsTransform(settings);
  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Install (or refresh) the MACF hook entries that remain HAND-WIRED in
 * `<workspaceDir>/.claude/settings.json` after the DR-039 Decision 2
 * single-source migration (groundnuty/macf#731/#739). Currently installs:
 *   - `check-auditor-never-acts.sh` (groundnuty/macf#499 — DR-026 F1; when
 *     `MACF_AGENT_ROLE=auditor`, blocks state-mutating `gh pr merge` /
 *     `gh issue close` / `gh pr close`; inert for every non-auditor identity)
 *     — PreToolUse, matcher `Bash`.
 *   - `emit-turn-receipt.sh` (groundnuty/macf#444 — async turn-ack span) —
 *     UserPromptSubmit, matcher-less, `async: true`.
 *   - `check-channels-enabled.sh` (groundnuty/macf#633 — reads the macf-agent
 *     MCP server's startup log back and warns LOUDLY into the agent's context
 *     when channel notifications are OFF, the result-invariant backstop to the
 *     macf#632 claude.sh flag) — SessionStart, matcher-less, NON-BLOCKING.
 *
 * **DR-039 Decision 2 single-sourced the REST of the load-bearing hook set
 * INTO THE PLUGIN's `hooks/hooks.json`** — this function no longer writes:
 *   - `check-gh-token.sh` / `check-mention-routing.sh` / `check-lgtm-gate.sh` /
 *     `check-close-keyword.sh` (previously PreToolUse, matcher `Bash`)
 *   - `check-gh-attribution.sh` (previously PostToolUse, matcher `Bash`)
 *   - `harvest-reflection.sh` (previously PreCompact, matcher-less)
 *   - `check-channel-alive.sh` (previously SessionStart + UserPromptSubmit,
 *     matcher-less)
 *
 * Those 7 hooks are now REGISTERED by the plugin, delivered to every
 * workspace via `macf init` / `macf update`'s always-load-the-full-plugin
 * fetch (`fetchPluginToWorkspace`) — no `macf init`/`update` code change was
 * needed there, since the CLI never produced a stripped/minimal plugin
 * variant to begin with (that variant — "plugin-cs" — was always a
 * hand-authored substrate relic, never CLI-generated).
 *
 * **DR-039 phase 2 (groundnuty/macf#698) went further: their SCRIPTS also
 * moved INTO THE PLUGIN** (`packages/macf/plugin/scripts/*.sh`), invoked via
 * `${CLAUDE_PLUGIN_ROOT}/scripts/` — tamper-resistant, since an agent editing
 * its workspace `.claude/scripts/` copy no longer changes what the plugin
 * actually runs (Decision 2's original "scripts stay path-invoked;
 * registration single-sources" split is thus superseded for these 7 —
 * `copyCanonicalScripts` still writes a `.claude/scripts/` compat copy for
 * hand-wired substrate hooks + non-plugin-init'd workspaces, but that copy is
 * no longer what the plugin-mounted hook executes). `macf doctor`'s DR-039
 * assertion (`checkLoadBearingHooks`) verifies presence across the UNION of
 * settings.json + the plugin's hooks.json by substring-matching the script's
 * basename — path-prefix-agnostic, so this migration is invisible to that
 * check either way.
 *
 * **Migration cleanup is idempotent and atomic with the switch:** the
 * preserve-then-replace discipline below still recognizes any of the 7
 * migrated filenames (via `MACF_HOOK_FILENAMES` / `isMacfManagedCommand`) and
 * STRIPS a legacy settings.json copy left over from a pre-migration CLI
 * version — it just does not re-add them. So a single `macf update` run both
 * starts delivering the hook via the plugin (already true for any init'd
 * workspace) AND removes the old settings.json duplicate in the same pass —
 * there is no window where a workspace has both (doubling) or neither (gap).
 * Re-running against an already-migrated workspace is a clean no-op for the
 * migrated events (nothing to strip, nothing to add).
 *
 * Operator-authored (non-MACF) hook entries on every event are ALWAYS
 * preserved verbatim — the discriminator is `isMacfManagedCommand`, which
 * matches by exact basename against `MACF_HOOK_FILENAMES`, never by "clear
 * everything in this event's array."
 *
 * **DR-039 Amendment B self-guard (groundnuty/macf#743 review):** the strip
 * of the 7 migrated filenames above is itself GATED on
 * `canPluginDeliverMigratedHooks` — see that function's doc comment. When the
 * effective loaded plugin cannot deliver the migrated set (a hooks-less
 * plugin variant, an ambiguous/unresolvable `--plugin-dir`), any EXISTING
 * legacy settings.json copies of those 7 filenames are left in place instead
 * of being stripped, and a `console.warn` surfaces the deferral. This does
 * NOT install fresh copies of the 7 on a brand-new workspace that never had
 * them (that would re-litigate DR-039 Decision 2 itself) — it only prevents
 * stripping an EXISTING hand-wired fallback into a gap. The 3 still-hand-wired
 * hooks (auditor / turn-receipt / channels-enabled) are unaffected by the
 * guard — they are always stripped-then-replaced unconditionally, same as
 * before this amendment.
 *
 * Creates the `.claude/` directory and the file if either is missing.
 * Idempotent: repeated calls don't duplicate entries.
 */
/**
 * True iff `settings` carries a hand-wired entry (on ANY hook event) for one
 * of the 7 DR-039 Decision 2 migrated filenames. Exported (DR-040 Decision 3
 * / macf#698 R1) — shared by `installGhTokenHook`'s warn-decision and the
 * canonical-compute tier-check (which needs the identical predicate to decide
 * whether the pure transform below is even reachable-different).
 */
export function hasDeferredMigratedHookEntry(settings: Settings): boolean {
  const hooks = settings.hooks ?? {};
  const all = [
    ...(hooks.PreToolUse ?? []),
    ...(hooks.PostToolUse ?? []),
    ...(hooks.UserPromptSubmit ?? []),
    ...(hooks.PreCompact ?? []),
    ...(hooks.SessionStart ?? []),
  ];
  return all.some((entry) => entry.hooks.some((h) => isMigratedHookCommand(h.command)));
}

/**
 * Pure transform: apply the canonical gh-token/auditor/turn-receipt/channels
 * hook-registration merge to a parsed `settings` object, given an
 * already-resolved `delivery` capability check (DR-039 Amendment B self-guard
 * — see `canPluginDeliverMigratedHooks`). Exported (DR-040 Decision 3 /
 * macf#698 R1) so the canonical-compute tier-check can apply this SAME logic
 * in-memory (without writing, without re-triggering the console.warn — that
 * side effect stays in `installGhTokenHook` below).
 */
export function applyGhTokenHookTransform(settings: Settings, delivery: PluginDeliveryCheck): Settings {
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];
  const postToolUse = hooks.PostToolUse ?? [];
  const userPromptSubmit = hooks.UserPromptSubmit ?? [];
  const preCompact = hooks.PreCompact ?? [];
  const sessionStart = hooks.SessionStart ?? [];

  // DR-039 Amendment B self-guard: only strip a migrated-hook entry (one of
  // MIGRATED_HOOK_FILENAMES) when the effective loaded plugin can actually
  // deliver the full set. The 3 hand-wired filenames are always eligible for
  // strip-then-replace regardless of plugin-delivery capability.
  const shouldStrip = (command: string | undefined): boolean => {
    if (!isMacfManagedCommand(command)) return false;
    if (isMigratedHookCommand(command)) return delivery.canDeliver;
    return true;
  };

  // PreToolUse: check-auditor-never-acts.sh always remains hand-wired. The
  // preserve-filter (matching by MACF_HOOK_FILENAMES basename, gated per
  // shouldStrip above) strips a legacy settings.json copy of check-gh-token /
  // check-mention-routing / check-lgtm-gate / check-close-keyword (now
  // plugin-owned, DR-039 Decision 2) on refresh ONLY when the plugin can
  // deliver them; operator-authored PreToolUse hooks are untouched either way.
  const preserved = preToolUse.filter(
    (entry) => !entry.hooks.some((h) => shouldStrip(h.command)),
  );
  const macfEntries: readonly HookEntry[] = [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: MACF_AUDITOR_HOOK_COMMAND }],
    },
  ];

  // PostToolUse: check-gh-attribution.sh moved to the plugin (DR-039 Decision
  // 2) — no MACF-managed PostToolUse hook remains hand-wired here. The
  // preserve-filter strips a legacy settings.json copy on refresh only when
  // the plugin can deliver it (self-guard); operator-authored PostToolUse
  // hooks are untouched either way.
  const preservedPost = postToolUse.filter(
    (entry) => !entry.hooks.some((h) => shouldStrip(h.command)),
  );
  const macfPostEntries: readonly HookEntry[] = [];

  // UserPromptSubmit: emit-turn-receipt.sh remains hand-wired (async, no
  // matcher). check-channel-alive.sh moved to the plugin (DR-039 Decision 2),
  // registered there on BOTH SessionStart (unthrottled) and UserPromptSubmit
  // (throttled) — the same dual-registration shape this function used to
  // install directly. Strip is gated per the self-guard.
  const preservedUps = userPromptSubmit.filter(
    (entry) => !entry.hooks.some((h) => shouldStrip(h.command)),
  );
  const macfUpsEntries: readonly HookEntry[] = [
    {
      hooks: [{ type: 'command', command: MACF_TURN_RECEIPT_HOOK_COMMAND, async: true }],
    },
  ];

  // PreCompact: harvest-reflection.sh moved to the plugin (DR-039 Decision 2)
  // — no MACF-managed PreCompact hook remains hand-wired here (the plugin's
  // checkpoint_to_memory + notify_peer mcp_tool entries AND harvest-reflection
  // now all live together in the plugin's hooks.json). An operator's own
  // settings.json PreCompact bash hook is preserved. Strip is gated per the
  // self-guard.
  const preservedCompact = preCompact.filter(
    (entry) => !entry.hooks.some((h) => shouldStrip(h.command)),
  );
  const macfCompactEntries: readonly HookEntry[] = [];

  // SessionStart: check-channels-enabled.sh remains hand-wired (matcher-less,
  // NON-BLOCKING). check-channel-alive.sh moved to the plugin (DR-039
  // Decision 2) — see the UserPromptSubmit comment above for its new home;
  // strip is gated per the self-guard. Intent-note (science-agent forward
  // note, #743 review): check-channels-enabled.sh (#633) stays hand-wired as
  // the REACTIVE detect-half (warns after a push was attempted-and-skipped),
  // while check-channel-alive.sh (#734) is plugin-owned as the PROACTIVE
  // liveness probe (checks the channel-server process is alive right now).
  // The asymmetry — one hand-wired, one plugin-owned — is intentional for
  // now; folding both onto the same delivery channel is a separate,
  // not-yet-decided DR-039 follow-up, not something this amendment resolves.
  const preservedSession = sessionStart.filter(
    (entry) => !entry.hooks.some((h) => shouldStrip(h.command)),
  );
  const macfSessionEntries: readonly HookEntry[] = [
    {
      hooks: [{ type: 'command', command: MACF_CHANNELS_HOOK_COMMAND }],
    },
  ];

  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [...preserved, ...macfEntries],
      PostToolUse: [...preservedPost, ...macfPostEntries],
      UserPromptSubmit: [...preservedUps, ...macfUpsEntries],
      PreCompact: [...preservedCompact, ...macfCompactEntries],
      SessionStart: [...preservedSession, ...macfSessionEntries],
    },
  };
}

export function installGhTokenHook(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);

  // DR-039 Amendment B self-guard: only strip a migrated-hook entry when the
  // effective loaded plugin can actually deliver the full set.
  const delivery = canPluginDeliverMigratedHooks(workspaceDir);
  // Only warn when there was something ACTUALLY deferred (an existing
  // migrated-hook entry kept in place) — a fresh/never-hand-wired workspace
  // has nothing to defer, so staying silent there avoids spamming every
  // `macf init`/`update` run on a workspace that will never carry these.
  if (!delivery.canDeliver && hasDeferredMigratedHookEntry(settings)) {
    console.warn(
      "macf: deferring hook-strip: effective plugin can't deliver the load-bearing set — " +
        'keeping hand-wired copies; fix the launcher to load the full .macf/plugin, see DR-039 ' +
        `(${delivery.detail}).`,
    );
  }

  const updated = applyGhTokenHookTransform(settings, delivery);
  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Canonical role-aware SessionStart work-pickup hook command
 * (groundnuty/macf#768). Canonicalizes the "check pending issues at session
 * start, then nudge yourself to pick them up" behavior agents had
 * previously hand-rolled (with duplicated `gh issue list` logic + a buggy
 * single-`Enter` tmux submit) in their gitignored `settings.local.json`.
 *
 * THIN BY DESIGN: the hook script does NOT hand-roll a GitHub query — it
 * delegates the entire queue-discovery + inbox-drain + coordination.md
 * §Communication 5 sweep-injection to the plugin's OWN `issues` command (the
 * exact command backing the `/macf-issues` skill; see
 * `plugin/skills/macf-issues/SKILL.md`), which already mints its own fresh
 * token via the refresh-aware client (macf#338). Only the SUBMIT step is
 * bash — the Claude Code TUI's multi-line-input Enter quirk has no
 * non-bash equivalent — and it goes through the sanctioned
 * `tmux-send-to-claude.sh` 2-step-Enter helper, never an inline
 * `tmux send-keys ... Enter` (which silently fails to submit).
 *
 * ROLE-AWARE DEFAULT (DR-026): auto-pickup defaults ON for every actuator
 * role (code/science/devops/writing + the exp-* variants) and OFF for the
 * auditor — the auditor is a propose-only sensor/discussant, never an
 * actuator, and auto-submitting a work-pickup turn would make it act (see
 * `startupPickupAutoResumesByDefault` in role-settings-model.ts). The
 * default is enforced by the SCRIPT reading `MACF_AGENT_ROLE` at runtime
 * (exported by claude.sh / env-files.ts) rather than by conditionally
 * omitting this settings.json entry at generation time: `macf rules
 * refresh` (the hand-wired-substrate distribution path this hook ALSO ships
 * through, alongside `macf init` / `macf update` — see `rules-refresh.ts`,
 * which has no `.macf/macf-agent.json` / role to read at all) has no
 * workspace-role information available at write time. So the entry is
 * written unconditionally for every workspace/role, mirroring
 * `check-auditor-never-acts.sh`'s own "distribute everywhere, gate at
 * runtime" shape.
 *
 * Runs on the `SessionStart` event, registered with `matcher: "startup"`
 * (groundnuty/macf#930 — was matcher-less pre-#930, which meant this fired
 * on `compact`/`resume`/`clear`/`fork` too, and reached at least one
 * MACF-orchestrated worker/subagent session). The matcher is
 * defense-in-depth, NOT the load-bearing gate: Claude Code evaluates
 * matchers before invoking the command at all, which means a matcher alone
 * is unobservable from a unit test driving the script's stdin directly — the
 * SCRIPT ITSELF re-checks the payload's `source` field (and, best-effort,
 * `agent_id` alone — deliberately not `agent_type` too, see the script's
 * own header) and is what a test actually exercises. See the script's own
 * header for the full rationale + the residual subagent-detection gap.
 *
 * OBSERVATIONAL (deposits the plugin's own issues-command output into the
 * agent's context) and ALWAYS exits 0 (a missing plugin mount, a query
 * error, a trigger that isn't a genuine startup, or any internal fault all
 * fail the SAME way but for different reasons — see the script header's
 * "fail open on errors, fail closed on ambiguity" split) — but is NOT
 * instant by design as of groundnuty/macf#802: the submit step is gated on
 * a bounded pane-readiness poll + a post-send verify (default budget up to
 * 90s — see the script header) so a relaunch racing its own unresolved
 * startup prompts (#703) doesn't have its pickup keystrokes silently
 * swallowed. `MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS` below gives the hook
 * registration itself enough headroom to outlive that poll, independent of
 * whatever Claude Code's own default hook timeout is.
 * Override: `MACF_NO_STARTUP_PICKUP=1` (family: `MACF_NO_TMUX_WRAP` /
 * `MACF_OTEL_DISABLED`); the poll/verify budgets have their own overrides
 * documented in the script itself. The `source`/subagent gate has
 * deliberately NO override — see the script header for why.
 */
export const MACF_STARTUP_PICKUP_HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/scripts/macf-startup-pickup.sh';

/**
 * Explicit hook-registration timeout (seconds) for the startup-pickup hook
 * (groundnuty/macf#802). Comfortably above the script's own default 90s
 * readiness-poll budget plus the two plugin-CLI queries (`issues` +
 * `issues --oneline`, each a real GitHub API round-trip) and the two
 * bounded post-send verify attempts — set explicitly rather than relying on
 * Claude Code's own default hook timeout, which this hook did not need to
 * outlive before the poll/verify gate existed.
 */
export const MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS = 120;

const STARTUP_PICKUP_HOOK_FILENAME = 'macf-startup-pickup.sh';

/** True iff `command` invokes the startup-pickup hook script (basename match, path-agnostic). */
function isStartupPickupHookCommand(command: string): boolean {
  return basenameOfCommand(command) === STARTUP_PICKUP_HOOK_FILENAME;
}

/**
 * Pure transform: install (or refresh) the SessionStart work-pickup hook
 * entry. Exported (mirrors the DR-040 Decision 3 pattern the other
 * merge-preserving settings.json writers use) so the canonical-compute
 * tier-check can apply this SAME logic in-memory (without writing).
 * Preserves every other SessionStart entry verbatim — operator-authored
 * hooks AND the sibling `check-channels-enabled.sh` MACF entry
 * `installGhTokenHook` writes — identified ONLY by a basename match on
 * `macf-startup-pickup.sh`, never by clearing the array.
 *
 * `matcher: "startup"` (groundnuty/macf#930) is defense-in-depth only — the
 * script itself re-checks the payload's `source` field, which is the part a
 * test can actually drive. See `MACF_STARTUP_PICKUP_HOOK_COMMAND`'s doc
 * comment for why the matcher alone isn't sufficient.
 */
export function applyStartupPickupHookTransform(settings: Settings): Settings {
  const hooks = settings.hooks ?? {};
  const sessionStart = hooks.SessionStart ?? [];
  const preserved = sessionStart.filter(
    (entry) => !entry.hooks.some((h) => isStartupPickupHookCommand(h.command)),
  );
  const macfEntries: readonly HookEntry[] = [
    {
      matcher: 'startup',
      hooks: [
        {
          type: 'command',
          command: MACF_STARTUP_PICKUP_HOOK_COMMAND,
          timeout: MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: [...preserved, ...macfEntries],
    },
  };
}

/**
 * Install (or refresh) the canonical SessionStart work-pickup hook entry in
 * `.claude/settings.json` (merge-preserving, DR-026/macf#768). Creates the
 * `.claude/` directory + settings.json if missing. Idempotent: repeated
 * calls don't duplicate entries (basename-matched refresh, see
 * `applyStartupPickupHookTransform`).
 */
export function installStartupPickupHook(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const updated = applyStartupPickupHookTransform(settings);
  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}
