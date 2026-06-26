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
  ROLE_FLOOR_ALLOW,
  ROLE_FLOOR_DENY,
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

// DR-028 universal floor allow/deny live in settings-writer.ts (zero deps) to
// avoid an import cycle — this module imports the hook constants FROM there, so
// the floor data must not flow the other way. Re-exported below so the model's
// public surface (what `macf doctor` validates against) stays in one place.
export { ROLE_FLOOR_ALLOW, ROLE_FLOOR_DENY };

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

/**
 * The roles the framework recognizes — ships an agent template / model handling
 * for (macf#551). The floor applies to ALL roles; only some carry deltas
 * (`ROLE_SETTINGS_DELTAS`). An `agent_role` OUTSIDE this set is a custom role
 * (legitimate — floor-only), but `macf doctor` surfaces it (INFO) so a typo on
 * a delta-bearing SAFETY-critical role — e.g. `auditor-agent` instead of the
 * exact `auditor`, which would silently skip the never-acts hook AND its doctor
 * ERROR — becomes visible instead of degrading silently. NOTE: `auditor` has no
 * `-agent` suffix (unlike `code-agent`); use the exact strings here.
 */
export const KNOWN_ROLES: readonly string[] = [
  'auditor',
  'code-agent',
  'science-agent',
  'devops-agent',
  'writing-agent',
  'exp-code-agent',
  'exp-science-code-aware',
  'exp-science-domain-only',
  'exp-single-agent',
];

/** True if `role` is a framework-recognized role (see `KNOWN_ROLES`). */
export function isKnownRole(role: string): boolean {
  return KNOWN_ROLES.includes(role);
}

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
