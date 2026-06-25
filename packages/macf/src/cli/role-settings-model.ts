/**
 * DR-028 — the canonical expected-`settings.json`-per-role model.
 *
 * A universal **floor** + per-role **deltas**: the single source of truth that
 * BOTH `macf init` (emit) and `macf doctor` (validate / `--fix`) consume, so
 * init-output and doctor-expectation can't diverge. See
 * `design/decisions/DR-028-expected-settings-per-role.md`.
 *
 * **Doctrine** (DR-028 §Decision 1): the defense is the **`deny` list + the
 * PreToolUse hooks**, NOT allow-enumeration — canonical macf commands embed
 * `$GH_TOKEN`/`$MACF_WORKSPACE_DIR` ("Contains simple_expansion"), which defeat
 * narrow `Bash(...)` patterns, so the floor uses broad `Bash(*)`.
 *
 * This module is the **data model only**. The `macf init` emit and the
 * `macf doctor` validate/`--fix` wiring land in follow-up increments (gated on
 * DR-028 ratification, macf#539). Importing the hook-command constants from
 * `settings-writer` is one-directional (settings-writer does not import this),
 * so there is no import cycle.
 */
import {
  MACF_HOOK_COMMAND,
  MACF_MENTION_HOOK_COMMAND,
  MACF_LGTM_HOOK_COMMAND,
  MACF_CLOSE_HOOK_COMMAND,
  MACF_AUDITOR_HOOK_COMMAND,
  MACF_TURN_RECEIPT_HOOK_COMMAND,
  MACF_ATTRIBUTION_HOOK_COMMAND,
  MACF_REFLECTION_HOOK_COMMAND,
} from './settings-writer.js';

/** A hook the model expects in `.claude/settings.json`. */
export interface ExpectedHook {
  readonly event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'PreCompact';
  /** Tool matcher for tool-scoped events (e.g. `Bash`); omitted for prompt/compact hooks. */
  readonly matcher?: string;
  readonly command: string;
  /**
   * `true` → a missing/changed instance of this hook is an **error**, not
   * drift (DR-028: the auditor's `never-acts` hook). `false` → recommended;
   * absence is reported as drift the operator may `--fix`.
   */
  readonly required: boolean;
}

/**
 * Universal floor `allow` tools (every role) — DR-028 §Decision 1. The macf
 * `Skill(...)` + `mcp__plugin…` entries (`PLUGIN_SKILL_PERMISSIONS` /
 * `PLUGIN_MCP_TOOL_PERMISSIONS`) are composed onto this by the emitter; they
 * are already emitted today and live in `settings-writer`.
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
 * Universal floor `deny` — the real guardrail (DR-028 §Decision 1; seeded from
 * devops's set, the most complete of the three working agents). Credential
 * reads + config/dotfile writes + dangerous commands.
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
  // config / dotfile writes
  'Write(~/.claude/settings.json)',
  'Edit(~/.claude/settings.json)',
  'Write(~/.claude.json)',
  'Edit(~/.claude.json)',
  'Write(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'Write(~/.aws/**)',
  'Edit(~/.aws/**)',
  'Write(~/.gnupg/**)',
  'Edit(~/.gnupg/**)',
  'Write(~/.kube/**)',
  'Edit(~/.kube/**)',
  'Write(~/.config/gcloud/**)',
  'Edit(~/.config/gcloud/**)',
  'Write(~/.gitconfig)',
  'Edit(~/.gitconfig)',
  'Write(~/.npmrc)',
  'Edit(~/.npmrc)',
  'Write(~/.pypirc)',
  'Edit(~/.pypirc)',
  'Write(~/.docker/config.json)',
  'Edit(~/.docker/config.json)',
  'Write(~/.netrc)',
  'Edit(~/.netrc)',
  'Write(~/.config/gh/**)',
  'Edit(~/.config/gh/**)',
  'Write(~/.bashrc)',
  'Edit(~/.bashrc)',
  'Write(~/.zshrc)',
  'Edit(~/.zshrc)',
  'Write(~/.profile)',
  'Edit(~/.profile)',
  'Write(~/.bash_profile)',
  'Edit(~/.bash_profile)',
  'Write(~/.zprofile)',
  'Edit(~/.zprofile)',
  'Write(~/.zshenv)',
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

/** Universal floor hooks (every role) — DR-028 §Decision 1. */
export const ROLE_FLOOR_HOOKS: readonly ExpectedHook[] = [
  { event: 'PreToolUse', matcher: 'Bash', command: MACF_HOOK_COMMAND, required: false },
  { event: 'PreToolUse', matcher: 'Bash', command: MACF_MENTION_HOOK_COMMAND, required: false },
  { event: 'PreToolUse', matcher: 'Bash', command: MACF_LGTM_HOOK_COMMAND, required: false },
  { event: 'PreToolUse', matcher: 'Bash', command: MACF_CLOSE_HOOK_COMMAND, required: false },
  { event: 'PostToolUse', matcher: 'Bash', command: MACF_ATTRIBUTION_HOOK_COMMAND, required: false },
  { event: 'UserPromptSubmit', command: MACF_TURN_RECEIPT_HOOK_COMMAND, required: false },
  { event: 'PreCompact', command: MACF_REFLECTION_HOOK_COMMAND, required: false },
];

/** Per-role additions beyond the floor (DR-028 §Decision 1, Per-role deltas). */
export interface RoleSettingsDelta {
  /** Hooks this role adds beyond the floor. */
  readonly hooks?: readonly ExpectedHook[];
  /** Extra `allow` entries (e.g. the role's MCP servers) beyond the floor. */
  readonly allow?: readonly string[];
}

/**
 * Per-role deltas. Roles not listed get the universal floor as-is
 * (code / science / devops — they all file + review PRs).
 */
export const ROLE_SETTINGS_DELTAS: Readonly<Record<string, RoleSettingsDelta>> = {
  // The auditor (DR-026): the `never-acts` hook is REQUIRED — a missing one is
  // an error, not drift. It STILL gets `Write`/`Edit` from the floor (it writes
  // proposals/digests locally); never-acts is hook-enforced on `gh pr merge` /
  // `issue close` (DR-026 §1/§4), not permission-removed.
  auditor: {
    hooks: [
      { event: 'PreToolUse', matcher: 'Bash', command: MACF_AUDITOR_HOOK_COMMAND, required: true },
    ],
  },
};

/** Expected hooks for a role = the floor + the role's delta hooks. */
export function expectedHooksForRole(role: string): readonly ExpectedHook[] {
  const delta = ROLE_SETTINGS_DELTAS[role];
  return delta?.hooks ? [...ROLE_FLOOR_HOOKS, ...delta.hooks] : ROLE_FLOOR_HOOKS;
}

/**
 * Expected base `allow` for a role = the floor + the role's extra allow
 * entries. The emitter composes `PLUGIN_SKILL_PERMISSIONS` +
 * `PLUGIN_MCP_TOOL_PERMISSIONS` onto this.
 */
export function expectedAllowForRole(role: string): readonly string[] {
  const delta = ROLE_SETTINGS_DELTAS[role];
  return delta?.allow ? [...ROLE_FLOOR_ALLOW, ...delta.allow] : ROLE_FLOOR_ALLOW;
}
