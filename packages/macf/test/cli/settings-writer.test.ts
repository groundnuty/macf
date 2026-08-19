/**
 * Tests for `src/cli/settings-writer.ts` — merge-preserving writer
 * for `<workspace>/.claude/settings.json` that installs the PreToolUse
 * entry for `check-gh-token.sh` without clobbering operator-authored
 * settings (per #140).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhTokenHook, MACF_HOOK_COMMAND, MACF_MENTION_HOOK_COMMAND, MACF_LGTM_HOOK_COMMAND, MACF_CLOSE_HOOK_COMMAND, MACF_AUDITOR_HOOK_COMMAND, MACF_TURN_RECEIPT_HOOK_COMMAND, MACF_ATTRIBUTION_HOOK_COMMAND, MACF_REFLECTION_HOOK_COMMAND, MACF_CHANNELS_HOOK_COMMAND, MACF_CHANNEL_ALIVE_HOOK_COMMAND, installStartupPickupHook, MACF_STARTUP_PICKUP_HOOK_COMMAND, MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS, installPluginSkillPermissions, PLUGIN_SKILL_PERMISSIONS, PLUGIN_MCP_TOOL_PERMISSIONS, ROLE_FLOOR_ALLOW, installSandboxFdAllowRead, SANDBOX_FD_READ_PATTERN, installSandboxExcludedCommands, SANDBOX_EXCLUDED_COMMANDS, getSandboxExcludedCommands, getPermissionsAllow, getPermissionsDeny, canPluginDeliverMigratedHooks } from '../../src/cli/settings-writer.js';

// ── Shared fixtures for the DR-039 Amendment B self-guard (macf#743 review) ──
//
// `canPluginDeliverMigratedHooks` resolves the plugin dir from `claude.sh`'s
// `--plugin-dir` flag, then reads that dir's `hooks/hooks.json`. These
// helpers set up the two shapes the self-guard discriminates between.

const MIGRATED_HOOK_BASENAMES = [
  'check-gh-token.sh',
  'check-mention-routing.sh',
  'check-lgtm-gate.sh',
  'check-close-keyword.sh',
  'check-gh-attribution.sh',
  'harvest-reflection.sh',
  'check-channel-alive.sh',
];

/** Write a `claude.sh` whose `--plugin-dir` resolves (via $SCRIPT_DIR) to `<root>/.macf/plugin`. */
function writeClaudeShPointingAtDotMacfPlugin(root: string): void {
  writeFileSync(
    join(root, 'claude.sh'),
    [
      '#!/bin/bash',
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"',
      '',
    ].join('\n'),
  );
}

/**
 * Full-plugin fixture — a `.macf/plugin/hooks/hooks.json` that registers all
 * 7 DR-039 Decision 2 migrated hooks. Represents a canonical, up-to-date
 * launcher: `canPluginDeliverMigratedHooks` should report `canDeliver: true`.
 */
function setupDeliveringPlugin(root: string): void {
  writeClaudeShPointingAtDotMacfPlugin(root);
  const hooksDir = join(root, '.macf', 'plugin', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-gh-token.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-mention-routing.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-lgtm-gate.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-close-keyword.sh' }] },
          ],
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-gh-attribution.sh' }] },
          ],
          PreCompact: [
            { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/harvest-reflection.sh' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-channel-alive.sh' }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-channel-alive.sh' }] },
          ],
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Hooks-less-plugin fixture (the `plugin-cs` shape) — a `.macf/plugin/hooks/`
 * dir whose `hooks.json` is EMPTY (mcpServers-only plugin variant, no hook
 * registrations at all). `canPluginDeliverMigratedHooks` should report
 * `canDeliver: false`.
 */
function setupHooksLessPlugin(root: string): void {
  writeClaudeShPointingAtDotMacfPlugin(root);
  const hooksDir = join(root, '.macf', 'plugin', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ hooks: {} }, null, 2));
}

/** Write a legacy hand-wired copy of all 7 migrated hooks into settings.json. */
function writeLegacyMigratedHooksSettings(settingsPath: string): void {
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-mention-routing.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-lgtm-gate.sh' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-close-keyword.sh' }] },
          ],
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-attribution.sh' }] },
          ],
          PreCompact: [{ hooks: [{ type: 'command', command: '.claude/scripts/harvest-reflection.sh' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: '.claude/scripts/check-channel-alive.sh' }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: '.claude/scripts/check-channel-alive.sh' }] }],
        },
      },
      null,
      2,
    ),
  );
}

function allHookCommands(settingsJson: {
  hooks?: Record<string, ReadonlyArray<{ hooks: ReadonlyArray<{ command: string }> }>>;
}): string[] {
  const hooks = settingsJson.hooks ?? {};
  return Object.values(hooks).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
}

describe('installGhTokenHook', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-settings-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Regression guard: per macf#232, a workspace-relative
  // `.claude/scripts/check-gh-token.sh` resolves against the cwd of
  // the spawned tool, which fails when the agent has cd'd into a
  // subdir before a Bash call. The constant must use
  // `$CLAUDE_PROJECT_DIR/...` (Claude Code substitutes that to the
  // workspace root at hook-dispatch time) so the path is correct
  // regardless of where Bash was invoked from. Per DR-039 Decision 2
  // (groundnuty/macf#731/#739) this hook's REGISTRATION now lives in the
  // plugin's hooks.json (see the "plugin single-source" describe block
  // below). Per DR-039 phase 2 (groundnuty/macf#698) the plugin's own
  // hooks.json entry no longer matches this constant verbatim — it invokes
  // the script via `${CLAUDE_PLUGIN_ROOT}/scripts/` instead (the script FILE
  // moved into the plugin). This constant is retained ONLY for the
  // settings.json/.claude/scripts/ migration-cleanup + hand-wired-compat
  // path (`isMacfManagedCommand` basename matching).
  it('MACF_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent absolute path)', () => {
    expect(MACF_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\//);
    expect(MACF_HOOK_COMMAND).toContain('check-gh-token.sh');
  });

  // Per DR-039 phase 2 (groundnuty/macf#698), the plugin's hooks.json no
  // longer matches ANY of the 7 migrated-hook constants verbatim (see the
  // dedicated assertions above) — but the constants themselves must still
  // retain the settings.json-compat `$CLAUDE_PROJECT_DIR/.claude/scripts/`
  // shape, since `isMacfManagedCommand` / the migration-cleanup strip logic
  // (below) and any still-hand-wired substrate workspace depend on it.
  it('the 7 migrated-hook constants all retain the $CLAUDE_PROJECT_DIR/.claude/scripts/ compat form', () => {
    const constants: ReadonlyArray<readonly [string, string]> = [
      [MACF_HOOK_COMMAND, 'check-gh-token.sh'],
      [MACF_MENTION_HOOK_COMMAND, 'check-mention-routing.sh'],
      [MACF_LGTM_HOOK_COMMAND, 'check-lgtm-gate.sh'],
      [MACF_CLOSE_HOOK_COMMAND, 'check-close-keyword.sh'],
      [MACF_ATTRIBUTION_HOOK_COMMAND, 'check-gh-attribution.sh'],
      [MACF_REFLECTION_HOOK_COMMAND, 'harvest-reflection.sh'],
      [MACF_CHANNEL_ALIVE_HOOK_COMMAND, 'check-channel-alive.sh'],
    ];
    for (const [constant, basename] of constants) {
      expect(constant, `${basename} constant`).toMatch(/^\$CLAUDE_PROJECT_DIR\/\.claude\/scripts\//);
      expect(constant, `${basename} constant`).toContain(basename);
    }
  });

  it('creates .claude/settings.json when missing, with the auditor hook entry only', () => {
    installGhTokenHook(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Only check-auditor-never-acts.sh (groundnuty/macf#499) remains
    // hand-wired on PreToolUse post-DR-039-Decision-2 (groundnuty/macf#731/
    // #739) — check-gh-token / check-mention-routing / check-lgtm-gate /
    // check-close-keyword single-sourced into the plugin's hooks.json.
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_AUDITOR_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('preserves existing unrelated settings keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      env: { DEBUG: 'true' },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ DEBUG: 'true' });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_AUDITOR_HOOK_COMMAND);
  });

  it('preserves other PreToolUse entries when adding ours', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: './user-edit-hook.sh' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // 1 user Edit hook + 1 MACF Bash hook (auditor-never-acts only, post
    // DR-039 Decision 2 — the other 4 moved to the plugin's hooks.json).
    expect(s.hooks.PreToolUse).toHaveLength(2);
    const userHook = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === 'Edit');
    const macfHooks = s.hooks.PreToolUse.filter(
      (e: { matcher: string; hooks: { command: string }[] }) =>
        e.matcher === 'Bash' && e.hooks.some((h) => h.command === MACF_AUDITOR_HOOK_COMMAND),
    );
    expect(userHook).toBeDefined();
    expect(userHook.hooks[0].command).toBe('./user-edit-hook.sh');
    expect(macfHooks).toHaveLength(1);
  });

  it('preserves operator hooks on other events (SessionStart op-hook kept, Stop untouched)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: './user-session-hook.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: './user-stop-hook.sh' }] }],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // SessionStart now carries the operator's hook PLUS only the macf
    // channels-enabled guard (check-channel-alive.sh moved to the plugin,
    // DR-039 Decision 2).
    expect(s.hooks.SessionStart).toHaveLength(2);
    const sessionCmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(sessionCmds).toContain('./user-session-hook.sh');
    expect(sessionCmds).toContain(MACF_CHANNELS_HOOK_COMMAND);
    // Stop is not a MACF event → untouched.
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_AUDITOR_HOOK_COMMAND);
  });

  it('is idempotent — second call does not duplicate the MACF entry', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_AUDITOR_HOOK_COMMAND),
    );
    expect(macfEntries).toHaveLength(1);
  });

  it('refreshes a stale MACF auditor entry (replaces by command-path match)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-auditor-never-acts.sh --old-flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-auditor-never-acts.sh')),
    );
    expect(macfEntries).toHaveLength(1);
    expect(macfEntries[0].hooks[0].command).toBe(MACF_AUDITOR_HOOK_COMMAND);
    // --old-flag should be gone.
    expect(macfEntries[0].hooks[0].command).not.toContain('--old-flag');
  });

  // ── UserPromptSubmit turn-ack receipt hook (groundnuty/macf#444) — the
  // only hand-wired UserPromptSubmit hook post-DR-039-Decision-2
  // (check-channel-alive.sh moved to the plugin). ──

  it('installs the UserPromptSubmit turn-receipt hook (async, no matcher)', () => {
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    const entry = s.hooks.UserPromptSubmit[0];
    // UserPromptSubmit isn't tool-gated → no matcher (unlike the Bash PreToolUse hooks).
    expect(entry.matcher).toBeUndefined();
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toBe(MACF_TURN_RECEIPT_HOOK_COMMAND);
    // async so it never adds turn latency / can't block on a slow OTLP endpoint.
    expect(entry.hooks[0].async).toBe(true);
  });

  it('MACF_TURN_RECEIPT_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent)', () => {
    expect(MACF_TURN_RECEIPT_HOOK_COMMAND).toBe(
      '$CLAUDE_PROJECT_DIR/.claude/scripts/emit-turn-receipt.sh',
    );
  });

  it('preserves operator-authored UserPromptSubmit hooks when adding ours', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: './my-ups-hook.sh' }] }],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // 1 operator hook + 1 MACF entry (turn-receipt only, post DR-039
    // Decision 2 — check-channel-alive.sh moved to the plugin's hooks.json).
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    const cmds = s.hooks.UserPromptSubmit.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain('./my-ups-hook.sh');
    expect(cmds).toContain(MACF_TURN_RECEIPT_HOOK_COMMAND);
  });

  it('UserPromptSubmit install is idempotent (no duplicate macf entry)', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfUps = s.hooks.UserPromptSubmit.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('emit-turn-receipt.sh')),
    );
    expect(macfUps).toHaveLength(1);
  });

  // ── PostToolUse: nothing remains hand-wired post-DR-039-Decision-2
  // (check-gh-attribution.sh moved to the plugin's hooks.json). ──

  it('MACF_ATTRIBUTION_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent)', () => {
    expect(MACF_ATTRIBUTION_HOOK_COMMAND).toBe(
      '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-attribution.sh',
    );
    expect(MACF_ATTRIBUTION_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\//);
  });

  it('installs no MACF PostToolUse hook on a fresh workspace (moved to the plugin)', () => {
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PostToolUse).toEqual([]);
  });

  it('preserves operator-authored PostToolUse hooks (no MACF entry added alongside)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: './my-post-hook.sh' }] }],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PostToolUse).toHaveLength(1);
    const cmds = s.hooks.PostToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain('./my-post-hook.sh');
    expect(cmds).not.toContain(MACF_ATTRIBUTION_HOOK_COMMAND);
  });

  it('handles malformed settings.json by failing loud (does not silently clobber)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not valid json');

    expect(() => installGhTokenHook(tmpRoot)).toThrow(/settings\.json/i);
    // File should NOT have been overwritten.
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not valid json');
  });

  it('creates .claude/ directory if missing', () => {
    // tmpRoot exists but .claude/ does not yet.
    expect(existsSync(join(tmpRoot, '.claude'))).toBe(false);

    installGhTokenHook(tmpRoot);

    expect(existsSync(join(tmpRoot, '.claude'))).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('writes pretty-printed JSON (readable for operators)', () => {
    installGhTokenHook(tmpRoot);
    const raw = readFileSync(settingsPath, 'utf-8');
    // Pretty-printed JSON has newlines and indentation.
    expect(raw).toContain('\n');
    expect(raw).toMatch(/^\{\n {2}/); // starts with `{` then newline+2-space indent
  });

  it('does NOT misclassify operator files with similar basenames as MACF-managed', () => {
    // Per science-agent's #140 review — substring match on
    // `check-gh-token.sh` would also claim `my-check-gh-token.sh-wrapper`.
    // We use path-end/basename equality to defend against that.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: './my-check-gh-token.sh-wrapper --flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Operator's lookalike hook must still be present.
    const operatorEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === './my-check-gh-token.sh-wrapper --flag'),
    );
    expect(operatorEntry).toBeDefined();
    const macfAuditorEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_AUDITOR_HOOK_COMMAND),
    );
    expect(macfAuditorEntry).toBeDefined();
    // 1 operator lookalike + 1 MACF entry (auditor-never-acts only, post
    // DR-039 Decision 2).
    expect(s.hooks.PreToolUse).toHaveLength(2);
  });

  // groundnuty/macf#499 — DR-026 F1 auditor-never-acts hook entry shape.
  it('MACF_AUDITOR_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent)', () => {
    expect(MACF_AUDITOR_HOOK_COMMAND).toBe(
      '$CLAUDE_PROJECT_DIR/.claude/scripts/check-auditor-never-acts.sh',
    );
    expect(MACF_AUDITOR_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\//);
    expect(MACF_AUDITOR_HOOK_COMMAND).toContain('check-auditor-never-acts.sh');
  });
});

// ── DR-039 Decision 2 migration cleanup (groundnuty/macf#731/#739) ──
//
// `installGhTokenHook` no longer RE-ADDS check-gh-token / check-mention-routing /
// check-lgtm-gate / check-close-keyword (PreToolUse), check-gh-attribution
// (PostToolUse), harvest-reflection (PreCompact), or check-channel-alive
// (SessionStart + UserPromptSubmit) — those 7 hooks' REGISTRATION single-sourced
// into the plugin's hooks.json. But `isMacfManagedCommand` / `MACF_HOOK_FILENAMES`
// still recognize their basenames, so a legacy settings.json copy from a
// pre-migration CLI version is STRIPPED (not refreshed) on the next
// `macf update` — this is the "atomic on macf update" migration-cleanup
// mechanism DR-039 Decision 2 calls for. These tests pin that behavior
// distinctly from the "moved hooks are simply absent" coverage above.
describe('installGhTokenHook — DR-039 Decision 2 migration cleanup', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-settings-migration-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
    // DR-039 Amendment B self-guard (macf#743 review): the strip these tests
    // assert on is now GATED on the effective plugin being able to deliver
    // the migrated set. Set up a full-delivering plugin fixture so these
    // pre-existing migration-cleanup assertions keep exercising the STRIP
    // path unchanged; the self-guard's DEFER path gets its own describe
    // block below ("DR-039 Amendment B self-guard").
    setupDeliveringPlugin(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('strips (does not refresh) a legacy PreToolUse entry for each of the 4 migrated guards', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-mention-routing.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-lgtm-gate.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-close-keyword.sh' }] },
          // Operator-authored unrelated hook that must survive untouched.
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edited' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = s.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds.some((c: string) => c.includes('check-gh-token.sh'))).toBe(false);
    expect(cmds.some((c: string) => c.includes('check-mention-routing.sh'))).toBe(false);
    expect(cmds.some((c: string) => c.includes('check-lgtm-gate.sh'))).toBe(false);
    expect(cmds.some((c: string) => c.includes('check-close-keyword.sh'))).toBe(false);
    // The still-hand-wired auditor hook IS present.
    expect(cmds).toContain(MACF_AUDITOR_HOOK_COMMAND);
    // Operator-authored hook survives verbatim.
    expect(cmds).toContain('echo edited');
  });

  it('does NOT crash on a type:mcp_tool hook (no command field) and preserves it (groundnuty/macf#757)', () => {
    // A `type: "mcp_tool"` hook (e.g. a hand-wired PreCompact
    // `checkpoint_to_memory` — the exact shape on macf-devops-agent) has
    // server/tool/input and NO `command`. The DR-039 strip iterates every
    // hook calling the command-matchers, which used to `basenameOfCommand
    // (undefined).trim()` → "Cannot read properties of undefined (reading
    // 'trim')" → `macf update` crashed mid-fleet-roll. It must be treated as
    // a non-command hook (never stripped), not crash.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { hooks: [{ type: 'mcp_tool', server: 'macf-agent', tool: 'checkpoint_to_memory', input: {}, timeout: 60 }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh' }] },
        ],
      },
    }, null, 2));

    // Must not throw.
    expect(() => installGhTokenHook(tmpRoot)).not.toThrow();

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // The mcp_tool hook is preserved verbatim (not a managed COMMAND hook).
    const preCompact = s.hooks.PreCompact.flatMap((e: { hooks: unknown[] }) => e.hooks);
    expect(preCompact).toContainEqual(
      expect.objectContaining({ type: 'mcp_tool', tool: 'checkpoint_to_memory' }),
    );
    // The genuine command-hook strip still worked alongside it.
    const preTool = s.hooks.PreToolUse.flatMap((e: { hooks: { command?: string }[] }) => e.hooks.map((h) => h.command));
    expect(preTool.some((c: string | undefined) => c?.includes('check-gh-token.sh'))).toBe(false);
  });

  it('strips a legacy PostToolUse check-gh-attribution.sh entry without re-adding it', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-attribution.sh' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PostToolUse).toEqual([]);
  });

  it('strips a legacy PreCompact harvest-reflection.sh entry without re-adding it', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { hooks: [{ type: 'command', command: '.claude/scripts/harvest-reflection.sh' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PreCompact).toEqual([]);
  });

  it('strips legacy check-channel-alive.sh entries from BOTH SessionStart and UserPromptSubmit', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '.claude/scripts/check-channel-alive.sh' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '.claude/scripts/check-channel-alive.sh' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const sessionCmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    const upsCmds = s.hooks.UserPromptSubmit.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(sessionCmds.some((c: string) => c.includes('check-channel-alive.sh'))).toBe(false);
    expect(upsCmds.some((c: string) => c.includes('check-channel-alive.sh'))).toBe(false);
    // The still-hand-wired hooks for each event ARE present.
    expect(sessionCmds).toContain(MACF_CHANNELS_HOOK_COMMAND);
    expect(upsCmds).toContain(MACF_TURN_RECEIPT_HOOK_COMMAND);
  });

  it('migration cleanup is idempotent — re-running an already-migrated workspace is a no-op for the moved events', () => {
    installGhTokenHook(tmpRoot); // fresh install, already "migrated" (never had legacy entries)
    const before = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    installGhTokenHook(tmpRoot); // second run
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
    expect(after.hooks.PreCompact).toEqual(before.hooks.PreCompact);
    expect(after.hooks.PostToolUse).toEqual([]);
    expect(after.hooks.PreCompact).toEqual([]);
  });

  // Per macf#232's legacy-relative-path migration, generalized: a
  // pre-migration workspace's relative-path entry is recognized by basename
  // regardless of path form — the migration-cleanup strip applies uniformly.
  it('strips a legacy RELATIVE-path check-gh-token.sh entry (macf#232 path form) without re-adding it', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh' }] },
          // Operator-authored unrelated hook that must survive.
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edited' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = s.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(cmds.some((c: string) => c.includes('check-gh-token.sh'))).toBe(false);
    expect(cmds).toContain('echo edited');
  });
});

// ── DR-039 Amendment B self-guard (groundnuty/macf#743 science-agent review) ──
//
// `installGhTokenHook`'s strip of the 7 migrated hooks must DEFER (not
// strip) when the effective loaded plugin CANNOT deliver the load-bearing
// set — otherwise a hooks-less-plugin launcher (e.g. devops's `plugin-cs`
// relic) has its hand-wired settings.json fallback stripped into a
// total-hook-loss gap. See `canPluginDeliverMigratedHooks` in
// `settings-writer.ts` for the mechanism + the DR-037-Amendment-B-lesson
// framing (verify "can deliver" BEFORE removing a fallback).
describe('installGhTokenHook — DR-039 Amendment B self-guard (macf#743 review)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-settings-selfguard-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('canPluginDeliverMigratedHooks', () => {
    it('reports canDeliver: false when claude.sh is absent (unresolvable)', () => {
      const result = canPluginDeliverMigratedHooks(tmpRoot);
      expect(result.canDeliver).toBe(false);
      expect(result.detail).toMatch(/not cleanly determinable/i);
    });

    it('reports canDeliver: false for a hooks-less plugin (plugin-cs shape)', () => {
      setupHooksLessPlugin(tmpRoot);
      const result = canPluginDeliverMigratedHooks(tmpRoot);
      expect(result.canDeliver).toBe(false);
      expect(result.detail).toContain('does not register');
      for (const name of MIGRATED_HOOK_BASENAMES) {
        expect(result.detail).toContain(name);
      }
    });

    it('reports canDeliver: true for a full plugin that registers all 7 migrated hooks', () => {
      setupDeliveringPlugin(tmpRoot);
      const result = canPluginDeliverMigratedHooks(tmpRoot);
      expect(result.canDeliver).toBe(true);
      expect(result.detail).toContain('registers the full migrated hook set');
    });

    it('reports canDeliver: false when claude.sh has multiple distinct --plugin-dir values (ambiguous)', () => {
      writeFileSync(
        join(tmpRoot, 'claude.sh'),
        '#!/bin/bash\nclaude --plugin-dir "/a/plugin" "$@"\nclaude --plugin-dir "/b/plugin" "$@"\n',
      );
      const result = canPluginDeliverMigratedHooks(tmpRoot);
      expect(result.canDeliver).toBe(false);
      expect(result.detail).toMatch(/not cleanly determinable/i);
    });
  });

  it('DEFERS the strip when the plugin is hooks-less — the 7 hand-wired copies SURVIVE', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupHooksLessPlugin(tmpRoot);

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = allHookCommands(s);
    for (const name of MIGRATED_HOOK_BASENAMES) {
      expect(cmds.some((c) => c.includes(name)), `expected ${name} to survive (deferred, not stripped)`).toBe(true);
    }
    // The always-hand-wired 3 are still present too.
    expect(cmds).toContain(MACF_AUDITOR_HOOK_COMMAND);
    expect(cmds).toContain(MACF_TURN_RECEIPT_HOOK_COMMAND);
    expect(cmds).toContain(MACF_CHANNELS_HOOK_COMMAND);
  });

  it('DEFERS the strip when claude.sh is absent (ambiguous/unresolvable) — legacy copies SURVIVE', () => {
    // No claude.sh at all — resolvePluginDirFromClaudeSh is undeterminable.
    writeLegacyMigratedHooksSettings(settingsPath);

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = allHookCommands(s);
    for (const name of MIGRATED_HOOK_BASENAMES) {
      expect(cmds.some((c) => c.includes(name)), `expected ${name} to survive (deferred, not stripped)`).toBe(true);
    }
  });

  it('STRIPS the legacy copies when the plugin CAN deliver the full migrated set', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupDeliveringPlugin(tmpRoot);

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = allHookCommands(s);
    for (const name of MIGRATED_HOOK_BASENAMES) {
      expect(cmds.some((c) => c.includes(name)), `expected ${name} to be stripped`).toBe(false);
    }
    // The always-hand-wired 3 are still (re-)installed.
    expect(cmds).toContain(MACF_AUDITOR_HOOK_COMMAND);
    expect(cmds).toContain(MACF_TURN_RECEIPT_HOOK_COMMAND);
    expect(cmds).toContain(MACF_CHANNELS_HOOK_COMMAND);
  });

  it('is idempotent — re-running against an already-delivering plugin twice produces the same stripped result', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupDeliveringPlugin(tmpRoot);

    installGhTokenHook(tmpRoot);
    const after1 = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    installGhTokenHook(tmpRoot);
    const after2 = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(after2).toEqual(after1);
    const cmds = allHookCommands(after2);
    for (const name of MIGRATED_HOOK_BASENAMES) {
      expect(cmds.some((c) => c.includes(name))).toBe(false);
    }
  });

  it('is idempotent — re-running against a hooks-less plugin twice keeps deferring without duplicating entries', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupHooksLessPlugin(tmpRoot);

    installGhTokenHook(tmpRoot);
    const after1 = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    installGhTokenHook(tmpRoot);
    const after2 = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(after2).toEqual(after1);
    const preToolUseCmds = after2.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    // check-gh-token.sh legacy entry present exactly once (not duplicated).
    expect(preToolUseCmds.filter((c: string) => c.includes('check-gh-token.sh'))).toHaveLength(1);
  });

  it('does NOT strip a brand-new workspace differently — a fresh hooks-less-plugin install still ends up with only the 3 hand-wired hooks (nothing to defer)', () => {
    // No pre-existing legacy entries at all — a first-ever `macf init` on a
    // hooks-less-plugin launcher. The self-guard only prevents STRIPPING an
    // EXISTING fallback; it does not synthesize fresh copies of the 7.
    setupHooksLessPlugin(tmpRoot);

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = allHookCommands(s);
    for (const name of MIGRATED_HOOK_BASENAMES) {
      expect(cmds.some((c) => c.includes(name))).toBe(false);
    }
    expect(cmds).toContain(MACF_AUDITOR_HOOK_COMMAND);
  });

  it('warns loudly when deferring an actual strip (hooks-less plugin + existing legacy copies)', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupHooksLessPlugin(tmpRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installGhTokenHook(tmpRoot);

    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(messages.some((m) => m.includes('deferring hook-strip'))).toBe(true);
    expect(messages.some((m) => m.includes('DR-039'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('does NOT warn on a fresh workspace with nothing to defer (hooks-less plugin, no legacy entries)', () => {
    setupHooksLessPlugin(tmpRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installGhTokenHook(tmpRoot);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn when the plugin can deliver (nothing deferred, strip proceeds normally)', () => {
    writeLegacyMigratedHooksSettings(settingsPath);
    setupDeliveringPlugin(tmpRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installGhTokenHook(tmpRoot);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── Canonical role-aware SessionStart work-pickup hook (groundnuty/macf#768) ──
describe('installStartupPickupHook (DR-026 / macf#768)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('MACF_STARTUP_PICKUP_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent absolute path)', () => {
    expect(MACF_STARTUP_PICKUP_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\/\.claude\/scripts\//);
    expect(MACF_STARTUP_PICKUP_HOOK_COMMAND).toContain('macf-startup-pickup.sh');
  });

  it('creates .claude/settings.json when missing, with the SessionStart entry', () => {
    installStartupPickupHook(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(MACF_STARTUP_PICKUP_HOOK_COMMAND);
    expect(s.hooks.SessionStart[0].hooks[0].type).toBe('command');
    // No matcher — SessionStart hooks are matcher-less, like the sibling
    // channels-enabled / turn-receipt hooks.
    expect(s.hooks.SessionStart[0].matcher).toBeUndefined();
  });

  it('registers an explicit timeout comfortably above the script\'s own readiness-poll budget (macf#802)', () => {
    // Claude Code's own default hook timeout is not documented anywhere in
    // this repo; the script's readiness-poll can legitimately run up to ~90s
    // (macf#802) so the registration must not rely on an unverified default
    // — see MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS's doc comment.
    installStartupPickupHook(tmpRoot);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionStart[0].hooks[0].timeout).toBe(MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS);
    expect(MACF_STARTUP_PICKUP_HOOK_TIMEOUT_SECONDS).toBeGreaterThan(90);
  });

  it('is written unconditionally — no role parameter, same entry regardless of workspace role', () => {
    // installStartupPickupHook has no role argument at all: the per-role
    // DR-026 default lives in the SCRIPT (runtime MACF_AGENT_ROLE check),
    // not in conditional settings.json generation — see the exported
    // function's doc comment for why (macf rules refresh has no role to
    // read). This test just pins the current signature/behavior.
    installStartupPickupHook(tmpRoot);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain(MACF_STARTUP_PICKUP_HOOK_COMMAND);
  });

  it('preserves an operator-authored SessionStart hook alongside ours', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: './user-session-hook.sh' }] }],
      },
    }, null, 2));

    installStartupPickupHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionStart).toHaveLength(2);
    const cmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain('./user-session-hook.sh');
    expect(cmds).toContain(MACF_STARTUP_PICKUP_HOOK_COMMAND);
  });

  it('preserves the sibling check-channels-enabled.sh MACF entry installGhTokenHook writes', () => {
    installGhTokenHook(tmpRoot); // writes check-channels-enabled.sh on SessionStart
    installStartupPickupHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain(MACF_CHANNELS_HOOK_COMMAND);
    expect(cmds).toContain(MACF_STARTUP_PICKUP_HOOK_COMMAND);
  });

  it('is idempotent (managed-header/basename refresh): calling twice does not duplicate', () => {
    installStartupPickupHook(tmpRoot);
    installStartupPickupHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const matching = s.hooks.SessionStart.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_STARTUP_PICKUP_HOOK_COMMAND),
    );
    expect(matching).toHaveLength(1);
  });

  it('refreshes a legacy/stale command string in place (basename match, not exact-string match)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '.claude/scripts/macf-startup-pickup.sh' }] },
        ],
      },
    }, null, 2));

    installStartupPickupHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmds = s.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toEqual([MACF_STARTUP_PICKUP_HOOK_COMMAND]);
  });

  it('preserves unrelated top-level settings keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));

    installStartupPickupHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.model).toBe('opus');
  });

  it('throws on malformed settings.json (consistent with installGhTokenHook)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ broken json');
    expect(() => installStartupPickupHook(tmpRoot)).toThrow(/malformed/i);
  });
});

// ── DR-039 Decision 2 plugin single-source lockstep (groundnuty/macf#731/#739) ──
//
// The plugin's canonical `plugin/hooks/hooks.json` must actually carry the
// registration for every hook `installGhTokenHook` no longer writes — this is
// the correctness crux of the whole migration (a settings-writer.ts change
// with no matching hooks.json change would silently drop the hook fleet-wide).
// Read the REAL on-disk file (not a fixture) so drift between the TS constant
// and the static JSON is caught immediately.
describe('plugin hooks.json single-source (DR-039 Decision 2)', () => {
  interface PluginHookEntry {
    readonly matcher?: string;
    readonly hooks: ReadonlyArray<{ type: string; command?: string; tool?: string }>;
  }
  interface PluginHooksJson {
    readonly hooks: Record<string, readonly PluginHookEntry[]>;
  }

  function pluginHooksJsonPath(): string {
    // packages/macf/test/cli/settings-writer.test.ts → packages/macf/plugin/hooks/hooks.json
    return join(__dirname, '..', '..', 'plugin', 'hooks', 'hooks.json');
  }

  function readPluginHooksJson(): PluginHooksJson {
    return JSON.parse(readFileSync(pluginHooksJsonPath(), 'utf-8')) as PluginHooksJson;
  }

  function commandsFor(entries: readonly PluginHookEntry[]): string[] {
    return entries.flatMap((e) => e.hooks.filter((h) => h.type === 'command').map((h) => h.command as string));
  }

  // DR-039 phase 2 (groundnuty/macf#698): the 7 migrated hook scripts moved a
  // second time — their FILES now live under the plugin's own scripts/ dir
  // (`packages/macf/plugin/scripts/`), so the plugin's hooks.json invokes them
  // via `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh` (tamper-resistant), NOT the
  // `$CLAUDE_PROJECT_DIR/.claude/scripts/` form the MACF_*_HOOK_COMMAND
  // constants still carry (those constants are now scoped to the settings.json
  // hand-wired-compat path only — see their doc comments in settings-writer.ts).
  function pluginRootHookCommand(basename: string): string {
    return `"\${CLAUDE_PLUGIN_ROOT}/scripts/${basename}"`;
  }

  it('is valid JSON with a top-level hooks map', () => {
    const parsed = readPluginHooksJson();
    expect(typeof parsed.hooks).toBe('object');
  });

  it('registers check-gh-token.sh / check-mention-routing.sh / check-lgtm-gate.sh / check-close-keyword.sh on PreToolUse with matcher Bash, via ${CLAUDE_PLUGIN_ROOT}/scripts/', () => {
    const parsed = readPluginHooksJson();
    const preToolUse = parsed.hooks['PreToolUse'] ?? [];
    for (const name of ['check-gh-token.sh', 'check-mention-routing.sh', 'check-lgtm-gate.sh', 'check-close-keyword.sh']) {
      const cmd = pluginRootHookCommand(name);
      const entry = preToolUse.find((e) => e.hooks.some((h) => h.command === cmd));
      expect(entry, `expected a PreToolUse entry for ${cmd}`).toBeDefined();
      expect(entry?.matcher).toBe('Bash');
      // Not the settings.json/.claude/scripts/ compat form.
      expect(preToolUse.some((e) => e.hooks.some((h) => h.command?.includes('.claude/scripts/' + name)))).toBe(false);
    }
  });

  it('registers check-gh-attribution.sh on PostToolUse with matcher Bash, via ${CLAUDE_PLUGIN_ROOT}/scripts/', () => {
    const parsed = readPluginHooksJson();
    const postToolUse = parsed.hooks['PostToolUse'] ?? [];
    const entry = postToolUse.find((e) => e.hooks.some((h) => h.command === pluginRootHookCommand('check-gh-attribution.sh')));
    expect(entry).toBeDefined();
    expect(entry?.matcher).toBe('Bash');
  });

  it('registers harvest-reflection.sh on PreCompact, via ${CLAUDE_PLUGIN_ROOT}/scripts/, alongside the existing checkpoint_to_memory + notify_peer mcp_tool entries', () => {
    const parsed = readPluginHooksJson();
    const preCompact = parsed.hooks['PreCompact'] ?? [];
    const cmds = commandsFor(preCompact);
    expect(cmds).toContain(pluginRootHookCommand('harvest-reflection.sh'));
    // The pre-existing mcp_tool entries must NOT have regressed.
    const mcpTools = preCompact.flatMap((e) => e.hooks.filter((h) => h.type === 'mcp_tool').map((h) => h.tool));
    expect(mcpTools).toContain('checkpoint_to_memory');
    expect(mcpTools).toContain('notify_peer');
  });

  it('registers check-channel-alive.sh on BOTH SessionStart and UserPromptSubmit, via ${CLAUDE_PLUGIN_ROOT}/scripts/', () => {
    const parsed = readPluginHooksJson();
    const sessionStart = commandsFor(parsed.hooks['SessionStart'] ?? []);
    const userPromptSubmit = commandsFor(parsed.hooks['UserPromptSubmit'] ?? []);
    const expected = pluginRootHookCommand('check-channel-alive.sh');
    expect(sessionStart).toContain(expected);
    expect(userPromptSubmit).toContain(expected);
  });

  it('does NOT register check-channels-enabled.sh, check-auditor-never-acts.sh, or emit-turn-receipt.sh (those stay hand-wired in settings.json)', () => {
    const parsed = readPluginHooksJson();
    const allCommands = Object.values(parsed.hooks).flatMap((entries) => commandsFor(entries));
    expect(allCommands.some((c) => c.includes('check-channels-enabled.sh'))).toBe(false);
    expect(allCommands.some((c) => c.includes('check-auditor-never-acts.sh'))).toBe(false);
    expect(allCommands.some((c) => c.includes('emit-turn-receipt.sh'))).toBe(false);
  });

  it('the pre-existing mark-turn-state.sh entries are untouched (still plugin-root-relative)', () => {
    const parsed = readPluginHooksJson();
    const allCommands = Object.values(parsed.hooks).flatMap((entries) => commandsFor(entries));
    const markTurnStateCommands = allCommands.filter((c) => c.includes('mark-turn-state.sh'));
    expect(markTurnStateCommands.length).toBeGreaterThan(0);
    for (const c of markTurnStateCommands) {
      expect(c).toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });

  it('none of the 7 migrated hooks reference the legacy $CLAUDE_PROJECT_DIR/.claude/scripts/ path anymore', () => {
    const parsed = readPluginHooksJson();
    const allCommands = Object.values(parsed.hooks).flatMap((entries) => commandsFor(entries));
    for (const name of [
      'check-gh-token.sh',
      'check-mention-routing.sh',
      'check-lgtm-gate.sh',
      'check-close-keyword.sh',
      'check-gh-attribution.sh',
      'harvest-reflection.sh',
      'check-channel-alive.sh',
    ]) {
      const matches = allCommands.filter((c) => c.includes(name));
      expect(matches.length, `expected at least one entry for ${name}`).toBeGreaterThan(0);
      for (const c of matches) {
        expect(c, `${name} command should be plugin-root-relative: ${c}`).toContain('${CLAUDE_PLUGIN_ROOT}');
        expect(c, `${name} command should not use the .claude/scripts/ compat path: ${c}`).not.toContain('.claude/scripts/');
      }
    }
  });

  // ── groundnuty/macf#814 — framework-surface git-sweep guard pair ─────────
  it('registers check-framework-surface.sh on SessionStart, via ${CLAUDE_PLUGIN_ROOT}/scripts/', () => {
    const parsed = readPluginHooksJson();
    const sessionStart = commandsFor(parsed.hooks['SessionStart'] ?? []);
    expect(sessionStart).toContain(pluginRootHookCommand('check-framework-surface.sh'));
  });

  it('registers check-git-sweep.sh on PreToolUse with matcher Bash, via ${CLAUDE_PLUGIN_ROOT}/scripts/', () => {
    const parsed = readPluginHooksJson();
    const preToolUse = parsed.hooks['PreToolUse'] ?? [];
    const cmd = pluginRootHookCommand('check-git-sweep.sh');
    const entry = preToolUse.find((e) => e.hooks.some((h) => h.command === cmd));
    expect(entry, `expected a PreToolUse entry for ${cmd}`).toBeDefined();
    expect(entry?.matcher).toBe('Bash');
  });
});

describe('installPluginSkillPermissions (macf#189 sub-item 2)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-skill-perm-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates .claude/settings.json with the DR-028 floor + skill + MCP tool patterns when missing', () => {
    installPluginSkillPermissions(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // DR-028 (macf#534): emits the role-aware floor + plugin perms, in that order.
    expect(s.permissions.allow).toEqual([
      ...ROLE_FLOOR_ALLOW,
      ...PLUGIN_SKILL_PERMISSIONS,
      ...PLUGIN_MCP_TOOL_PERMISSIONS,
    ]);
    // Floor: broad Bash(*) + the read/write/edit tools (the no-usable-perms +
    // memory-edit fix).
    expect(s.permissions.allow).toContain('Bash(*)');
    expect(s.permissions.allow).toContain('Write');
    expect(s.permissions.allow).toContain('Edit');
    // The deny safety floor is emitted too.
    expect(s.permissions.deny).toContain('Bash(sudo *)');
    expect(s.permissions.deny).toContain('Read(~/.ssh/id_*)');
    // Spot-check the 5 skills (macf#350 added macf-notify-peer).
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-status)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-notify-peer)');
    // Spot-check the 2 MCP tools (macf#349).
    expect(s.permissions.allow).toContain('mcp__macf-agent__notify_peer');
    expect(s.permissions.allow).toContain('mcp__macf-agent__checkpoint_to_memory');
  });

  it('preserves non-MACF permissions.allow entries', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Bash(ls:*)', 'Skill(other-plugin:some-skill)'],
      },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.permissions.allow).toContain('Bash(ls:*)');
    expect(s.permissions.allow).toContain('Skill(other-plugin:some-skill)');
    // MACF skills land after operator entries.
    for (const pattern of PLUGIN_SKILL_PERMISSIONS) {
      expect(s.permissions.allow).toContain(pattern);
    }
  });

  it('is idempotent — re-running does not duplicate MACF entries', () => {
    installPluginSkillPermissions(tmpRoot);
    installPluginSkillPermissions(tmpRoot);
    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Count macf-agent: entries — should equal the static list length
    // exactly, not triple.
    const macfEntries = (s.permissions.allow as string[]).filter(e => e.startsWith('Skill(macf-agent:'));
    expect(macfEntries).toHaveLength(PLUGIN_SKILL_PERMISSIONS.length);
  });

  it('refreshes stale MACF entries on re-run (pretends an old skill was removed)', () => {
    // Pre-seed with a fake stale entry that isn't in the current
    // PLUGIN_SKILL_PERMISSIONS list.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Skill(macf-agent:legacy-removed-skill)', 'Bash(git:*)'],
      },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Stale macf-agent entry gone.
    expect(s.permissions.allow).not.toContain('Skill(macf-agent:legacy-removed-skill)');
    // Non-MACF entry preserved.
    expect(s.permissions.allow).toContain('Bash(git:*)');
    // Current skills all present.
    for (const pattern of PLUGIN_SKILL_PERMISSIONS) {
      expect(s.permissions.allow).toContain(pattern);
    }
  });

  it('preserves other settings.json keys (e.g. existing hooks block)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }] },
      env: { SOME_OPERATOR_VAR: '1' },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // permissions.allow installed.
    expect(s.permissions.allow).toBeDefined();
    // Unrelated keys preserved.
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.env.SOME_OPERATOR_VAR).toBe('1');
  });

  describe('MCP tool permissions (macf#349)', () => {
    // Without these pre-approvals, every first invocation of notify_peer
    // (or checkpoint_to_memory) fires an interactive approval dialog —
    // blocking the Stop-hook autonomy contract from DR-023 UC-1 + UC-3.
    // PPAM 2026 macbook hit it 2026-05-04.

    it('PLUGIN_MCP_TOOL_PERMISSIONS exports the channel-server tool list', () => {
      // Lockstep with channel-server's `mcp.mcp.registerTool(...)` calls
      // in `packages/macf-channel-server/src/server.ts`. When a new tool
      // is added, this list must be updated + CLI version bumped.
      expect(PLUGIN_MCP_TOOL_PERMISSIONS).toContain('mcp__macf-agent__notify_peer');
      expect(PLUGIN_MCP_TOOL_PERMISSIONS).toContain('mcp__macf-agent__checkpoint_to_memory');
    });

    it('installs MCP tool permissions on a fresh workspace', () => {
      installPluginSkillPermissions(tmpRoot);
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const allow: readonly string[] = s.permissions.allow;
      expect(allow).toContain('mcp__macf-agent__notify_peer');
      expect(allow).toContain('mcp__macf-agent__checkpoint_to_memory');
    });

    it('installs both skill + MCP tool permissions in lockstep', () => {
      installPluginSkillPermissions(tmpRoot);
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const allow: readonly string[] = s.permissions.allow;
      // 4 skills + 2 MCP tools
      for (const skill of PLUGIN_SKILL_PERMISSIONS) {
        expect(allow).toContain(skill);
      }
      for (const tool of PLUGIN_MCP_TOOL_PERMISSIONS) {
        expect(allow).toContain(tool);
      }
    });

    it('preserves operator-authored mcp__* wildcard alongside our specific entries', () => {
      // Operator may have set a wildcard via "yes and don't ask again";
      // our specific entries are additive. Both end up in permissions.allow.
      mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['mcp__*', 'Bash(*)'] },
      }, null, 2));

      installPluginSkillPermissions(tmpRoot);

      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      expect(allow).toContain('mcp__*');                                                     // operator
      expect(allow).toContain('Bash(*)');                                                    // operator
      expect(allow).toContain('mcp__macf-agent__notify_peer');             // ours
      expect(allow).toContain('mcp__macf-agent__checkpoint_to_memory');    // ours
    });

    it('drops stale MCP tool entries (e.g. tool removed in newer plugin) on refresh', () => {
      mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        permissions: {
          allow: [
            'mcp__macf-agent__since_removed_tool',  // stale ours
            'mcp__macf-agent__notify_peer',         // current
            'Bash(*)',                                                 // operator — preserved
          ],
        },
      }, null, 2));

      installPluginSkillPermissions(tmpRoot);

      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      expect(allow).not.toContain('mcp__macf-agent__since_removed_tool');  // dropped
      expect(allow).toContain('mcp__macf-agent__notify_peer');             // current re-installed
      expect(allow).toContain('Bash(*)');                                                    // operator preserved
    });

    it('idempotent: repeated calls don\'t duplicate MCP tool entries', () => {
      installPluginSkillPermissions(tmpRoot);
      installPluginSkillPermissions(tmpRoot);
      installPluginSkillPermissions(tmpRoot);
      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      const notifyCount = allow.filter((e: string) => e === 'mcp__macf-agent__notify_peer').length;
      const checkpointCount = allow.filter((e: string) => e === 'mcp__macf-agent__checkpoint_to_memory').length;
      expect(notifyCount).toBe(1);
      expect(checkpointCount).toBe(1);
    });

    // DR-022 Amendment P / groundnuty/macf#995: the channel-server moved off
    // the plugin's mcpServers to a project .mcp.json server, flipping the MCP
    // tool namespace from `mcp__plugin_macf-agent_macf-agent__*` to
    // `mcp__macf-agent__*`. A workspace updating from before the move would
    // otherwise keep the dead legacy-namespace entry forever (mistaken for
    // operator-authored, since it no longer matches the new prefix).
    it('drops the PRE-macf#995 legacy-namespace entry on refresh (migration cleanup)', () => {
      mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        permissions: {
          allow: [
            'mcp__plugin_macf-agent_macf-agent__notify_peer',           // legacy — dead post-migration
            'mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory',  // legacy — dead post-migration
            'Bash(*)',                                                   // operator — preserved
          ],
        },
      }, null, 2));

      installPluginSkillPermissions(tmpRoot);

      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      expect(allow).not.toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');
      expect(allow).not.toContain('mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory');
      expect(allow).toContain('mcp__macf-agent__notify_peer');           // current namespace re-installed
      expect(allow).toContain('mcp__macf-agent__checkpoint_to_memory');  // current namespace re-installed
      expect(allow).toContain('Bash(*)');                                // operator preserved
    });
  });

  describe('enabledMcpjsonServers (DR-022 Amendment P, groundnuty/macf#995)', () => {
    it('pre-approves the macf-agent .mcp.json server on a fresh workspace', () => {
      installPluginSkillPermissions(tmpRoot);
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(s.enabledMcpjsonServers).toEqual(['macf-agent']);
    });

    it('merges macf-agent into an operator-authored enabledMcpjsonServers array, never clobbering it', () => {
      mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ enabledMcpjsonServers: ['operator-tool'] }, null, 2));

      installPluginSkillPermissions(tmpRoot);

      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(s.enabledMcpjsonServers).toContain('operator-tool');
      expect(s.enabledMcpjsonServers).toContain('macf-agent');
    });

    it('is idempotent — repeated calls do not duplicate macf-agent', () => {
      installPluginSkillPermissions(tmpRoot);
      installPluginSkillPermissions(tmpRoot);
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect((s.enabledMcpjsonServers as string[]).filter((e) => e === 'macf-agent')).toHaveLength(1);
    });
  });
});

describe('installSandboxFdAllowRead (macf#200)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-sandbox-fd-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
    delete process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  });

  it('a) creates settings.json + sandbox.filesystem.allowRead when missing', () => {
    installSandboxFdAllowRead(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('b) creates filesystem subblock when sandbox exists but filesystem does not', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: { enabled: true },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.enabled).toBe(true); // preserved
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('c) creates allowRead when filesystem exists but allowRead does not', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        filesystem: {
          allowWrite: ['/tmp/**'],
          denyRead: ['/etc/shadow'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
    // Other filesystem sub-keys preserved.
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/tmp/**']);
    expect(s.sandbox.filesystem.denyRead).toEqual(['/etc/shadow']);
  });

  it('d) appends to existing allowRead, preserving operator entries', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', '/etc/resolv.conf'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toContain('/etc/hosts');
    expect(s.sandbox.filesystem.allowRead).toContain('/etc/resolv.conf');
    expect(s.sandbox.filesystem.allowRead).toContain(SANDBOX_FD_READ_PATTERN);
    expect(s.sandbox.filesystem.allowRead).toHaveLength(3);
  });

  it('e) no-op when the fd pattern is already present', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    const before = {
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', SANDBOX_FD_READ_PATTERN],
        },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(before, null, 2));
    const mtimeBefore = statSync(settingsPath).mtimeMs;

    installSandboxFdAllowRead(tmpRoot);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.sandbox.filesystem.allowRead).toEqual(['/etc/hosts', SANDBOX_FD_READ_PATTERN]);
    // File not rewritten on no-op.
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore);
  });

  it('f) respects MACF_SANDBOX_FD_FIX_SKIP=1 opt-out', () => {
    process.env['MACF_SANDBOX_FD_FIX_SKIP'] = '1';
    installSandboxFdAllowRead(tmpRoot);

    // Nothing written — settings.json shouldn't exist.
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('f2) respects MACF_SANDBOX_FD_FIX_SKIP=true opt-out (aligned with MACF_OTEL_DISABLED)', () => {
    process.env['MACF_SANDBOX_FD_FIX_SKIP'] = 'true';
    installSandboxFdAllowRead(tmpRoot);

    expect(existsSync(settingsPath)).toBe(false);
  });

  it('g) throws on malformed settings.json (consistent with installGhTokenHook)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not valid json');

    expect(() => installSandboxFdAllowRead(tmpRoot))
      .toThrow(/Refusing to overwrite malformed/);
  });

  it('is idempotent — N calls produce same output as 1 call', () => {
    installSandboxFdAllowRead(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('migrates legacy /proc/self/fd/** pattern to the current /proc/self/fd (macf#208)', () => {
    // Workspaces written by CLI pre-#208 have the broken `/proc/self/fd/**`
    // pattern in allowRead — the sandbox treats `**` as a literal, not a
    // glob, so the read stays denied. `macf update` / `macf init` should
    // drop the stale pattern and install the working one.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', '/proc/self/fd/**'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Legacy pattern dropped, current pattern appended, operator entry preserved.
    expect(s.sandbox.filesystem.allowRead).toEqual(['/etc/hosts', SANDBOX_FD_READ_PATTERN]);
    expect(s.sandbox.filesystem.allowRead).not.toContain('/proc/self/fd/**');
  });

  it('preserves other top-level settings.json keys + other sandbox keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }] },
      env: { SOME_OPERATOR_VAR: '1' },
      sandbox: {
        enabled: true,
        excludedCommands: ['gh:*'],
        filesystem: {
          allowRead: ['/etc/hosts'],
          denyWrite: ['/etc/**'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.env.SOME_OPERATOR_VAR).toBe('1');
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.excludedCommands).toEqual(['gh:*']);
    expect(s.sandbox.filesystem.allowRead).toEqual(['/etc/hosts', SANDBOX_FD_READ_PATTERN]);
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/etc/**']);
  });
});

describe('installSandboxExcludedCommands (macf#211)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-excl-cmd-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
    delete process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'];
  });

  it('canonical set spans all 4 documented classes (build-loop / search / shell / fs-mutate)', () => {
    // Regression guard: each command class must contribute at least
    // one entry. If a future refactor accidentally removes a whole
    // class, this test catches it before consumers do.
    expect(SANDBOX_EXCLUDED_COMMANDS).toContain('git:*');     // build-loop
    expect(SANDBOX_EXCLUDED_COMMANDS).toContain('grep:*');    // search/read
    expect(SANDBOX_EXCLUDED_COMMANDS).toContain('bash:*');    // shell wrapper
    expect(SANDBOX_EXCLUDED_COMMANDS).toContain('mkdir:*');   // low-blast fs
  });

  it('explicitly omits destructive fs commands (rm, mv) — kept sandboxed', () => {
    // Per the issue's design discussion: high-blast-radius fs
    // mutations stay sandboxed so the sandbox preserves a damage-
    // control gate even though it's defense-in-depth here.
    expect(SANDBOX_EXCLUDED_COMMANDS).not.toContain('rm:*');
    expect(SANDBOX_EXCLUDED_COMMANDS).not.toContain('mv:*');
  });

  it('creates settings.json + sandbox.excludedCommands when missing', () => {
    installSandboxExcludedCommands(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.excludedCommands).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
  });

  it('creates excludedCommands when sandbox exists but excludedCommands does not', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: { enabled: true },
    }, null, 2));

    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.enabled).toBe(true); // preserved
    expect(s.sandbox.excludedCommands).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
  });

  it('appends to existing excludedCommands, preserving operator entries', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        excludedCommands: ['kubectl:*', 'helm:*'],
      },
    }, null, 2));

    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Operator-authored entries kept in their original positions
    // (front of array); canonical MACF entries appended at the end.
    expect(s.sandbox.excludedCommands.slice(0, 2)).toEqual(['kubectl:*', 'helm:*']);
    expect(s.sandbox.excludedCommands.slice(2)).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
  });

  it('does not duplicate entries operator already added (idempotent merge)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    // Operator already has some MACF entries (e.g., they hand-applied
    // the workaround pre-#211 landing).
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        excludedCommands: ['gh:*', 'grep:*', 'kubectl:*'],
      },
    }, null, 2));

    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // gh:* and grep:* should appear exactly once (their original
    // positions preserved); kubectl:* (operator-only) preserved;
    // remaining canonical entries appended.
    expect(s.sandbox.excludedCommands.filter((e: string) => e === 'gh:*')).toHaveLength(1);
    expect(s.sandbox.excludedCommands.filter((e: string) => e === 'grep:*')).toHaveLength(1);
    expect(s.sandbox.excludedCommands).toContain('kubectl:*');
    expect(s.sandbox.excludedCommands.slice(0, 3)).toEqual(['gh:*', 'grep:*', 'kubectl:*']);
  });

  it('is idempotent — second call writes nothing new', () => {
    installSandboxExcludedCommands(tmpRoot);
    const firstWrite = readFileSync(settingsPath, 'utf-8');
    installSandboxExcludedCommands(tmpRoot);
    const secondWrite = readFileSync(settingsPath, 'utf-8');
    expect(secondWrite).toBe(firstWrite);
  });

  it('respects MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1 (no file written)', () => {
    process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'] = '1';
    installSandboxExcludedCommands(tmpRoot);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('respects MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=true (no file written)', () => {
    process.env['MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP'] = 'true';
    installSandboxExcludedCommands(tmpRoot);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('preserves unrelated top-level + sandbox keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      env: { DEBUG: '1' },
      sandbox: {
        enabled: true,
        filesystem: { allowRead: ['/proc/self/fd'] },
      },
    }, null, 2));

    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ DEBUG: '1' });
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.filesystem.allowRead).toEqual(['/proc/self/fd']);
    expect(s.sandbox.excludedCommands).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
  });

  it('handles malformed settings.json by failing loud', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ broken json');

    expect(() => installSandboxExcludedCommands(tmpRoot)).toThrow(/settings\.json/i);
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken json');
  });

  it('getSandboxExcludedCommands returns array (or empty when missing/alien shape)', () => {
    expect(getSandboxExcludedCommands(tmpRoot)).toEqual([]);

    installSandboxExcludedCommands(tmpRoot);
    const got = getSandboxExcludedCommands(tmpRoot);
    expect(got).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
  });
});

describe('getPermissionsAllow / getPermissionsDeny (macf#296)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'perms-read-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSettings(obj: unknown): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  }

  it('getPermissionsAllow returns the allow array', () => {
    writeSettings({ permissions: { allow: ['Write', 'Edit', 'Bash(*)'] } });
    expect(getPermissionsAllow(tmpRoot)).toEqual(['Write', 'Edit', 'Bash(*)']);
  });

  it('getPermissionsAllow returns empty array when settings absent', () => {
    expect(getPermissionsAllow(tmpRoot)).toEqual([]);
  });

  it('getPermissionsAllow returns empty array when permissions key missing', () => {
    writeSettings({ hooks: {} });
    expect(getPermissionsAllow(tmpRoot)).toEqual([]);
  });

  it('getPermissionsAllow filters non-string entries', () => {
    writeSettings({ permissions: { allow: ['Write', 42, null, 'Edit'] } });
    expect(getPermissionsAllow(tmpRoot)).toEqual(['Write', 'Edit']);
  });

  it('getPermissionsAllow throws on malformed JSON (matches getSandboxAllowRead posture)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ broken json');
    expect(() => getPermissionsAllow(tmpRoot)).toThrow(/Refusing to overwrite malformed/);
  });

  it('getPermissionsDeny returns the deny array', () => {
    writeSettings({ permissions: { deny: ['Bash(rm -rf *)'] } });
    expect(getPermissionsDeny(tmpRoot)).toEqual(['Bash(rm -rf *)']);
  });

  it('getPermissionsDeny returns empty array when permissions absent', () => {
    writeSettings({ hooks: {} });
    expect(getPermissionsDeny(tmpRoot)).toEqual([]);
  });
});

describe('getPermissionsAllow / getPermissionsDeny merge with settings.local.json (macf#305)', () => {
  let tmpRoot: string;
  let mainPath: string;
  let localPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'perms-merge-'));
    mainPath = join(tmpRoot, '.claude', 'settings.json');
    localPath = join(tmpRoot, '.claude', 'settings.local.json');
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeMain(obj: unknown): void {
    writeFileSync(mainPath, JSON.stringify(obj, null, 2));
  }

  function writeLocal(obj: unknown): void {
    writeFileSync(localPath, JSON.stringify(obj, null, 2));
  }

  it('settings.json-only — returns settings.json allow (unchanged behavior)', () => {
    writeMain({ permissions: { allow: ['Write', 'Edit'] } });
    expect(getPermissionsAllow(tmpRoot)).toEqual(['Write', 'Edit']);
  });

  it('settings.local.json-only — returns settings.local.json allow (the macf#305 fix)', () => {
    // The exact case driving #305: cv-architect + cv-project-archaeologist
    // moved Write+Edit to settings.local.json after the macf#302 drift
    // workaround. Pre-#305 doctor missed these workspaces.
    writeLocal({ permissions: { allow: ['Write', 'Edit'] } });
    expect(getPermissionsAllow(tmpRoot)).toEqual(['Write', 'Edit']);
  });

  it('both files — returns deduped union per Claude Code merge semantics', () => {
    writeMain({ permissions: { allow: ['Read', 'Bash(*)'] } });
    writeLocal({ permissions: { allow: ['Write', 'Edit'] } });
    const result = getPermissionsAllow(tmpRoot);
    expect(result).toContain('Read');
    expect(result).toContain('Bash(*)');
    expect(result).toContain('Write');
    expect(result).toContain('Edit');
    expect(result).toHaveLength(4);
  });

  it('both files — duplicates deduped (string equality)', () => {
    writeMain({ permissions: { allow: ['Write', 'Edit', 'Bash(*)'] } });
    writeLocal({ permissions: { allow: ['Edit', 'Read'] } });
    const result = getPermissionsAllow(tmpRoot);
    expect(result).toContain('Write');
    expect(result).toContain('Edit');
    expect(result).toContain('Bash(*)');
    expect(result).toContain('Read');
    // Edit appears in both files but only once in the merged result.
    expect(result.filter((e) => e === 'Edit')).toHaveLength(1);
  });

  it('neither file present — returns empty array (existing posture)', () => {
    expect(getPermissionsAllow(tmpRoot)).toEqual([]);
    expect(getPermissionsDeny(tmpRoot)).toEqual([]);
  });

  it('throws with shape-aware error when settings.json is malformed', () => {
    writeFileSync(mainPath, '{ broken main');
    writeLocal({ permissions: { allow: ['Write'] } });
    expect(() => getPermissionsAllow(tmpRoot)).toThrow(/Refusing to overwrite malformed/);
    expect(() => getPermissionsAllow(tmpRoot)).toThrow(/settings\.json/);
    // The path in the error message is shape-aware — surfaces WHICH file failed parse.
  });

  it('throws with shape-aware error when settings.local.json is malformed', () => {
    writeMain({ permissions: { allow: ['Write'] } });
    writeFileSync(localPath, '{ broken local');
    expect(() => getPermissionsAllow(tmpRoot)).toThrow(/Refusing to overwrite malformed/);
    expect(() => getPermissionsAllow(tmpRoot)).toThrow(/settings\.local\.json/);
  });

  it('getPermissionsDeny mirrors merge semantics', () => {
    writeMain({ permissions: { deny: ['Write(/etc/*)'] } });
    writeLocal({ permissions: { deny: ['Write(/root/*)', 'Edit(/etc/*)'] } });
    const result = getPermissionsDeny(tmpRoot);
    expect(result).toContain('Write(/etc/*)');
    expect(result).toContain('Write(/root/*)');
    expect(result).toContain('Edit(/etc/*)');
    expect(result).toHaveLength(3);
  });

  it('one file has permissions, other has unrelated keys — handles gracefully', () => {
    writeMain({ hooks: { PreToolUse: [] }, env: { FOO: 'bar' } });
    writeLocal({ permissions: { allow: ['Write', 'Edit'] } });
    expect(getPermissionsAllow(tmpRoot)).toEqual(['Write', 'Edit']);
  });

  it('preserves order: settings.json entries first, settings.local.json second', () => {
    // Order-dependence not strictly required by AC but useful for
    // debugging — operator can scan the merged list and tell where
    // each entry came from.
    writeMain({ permissions: { allow: ['Read', 'Bash(*)'] } });
    writeLocal({ permissions: { allow: ['Write', 'Edit'] } });
    const result = getPermissionsAllow(tmpRoot);
    expect(result).toEqual(['Read', 'Bash(*)', 'Write', 'Edit']);
  });
});

describe('end-to-end: macf update preserves operator-authored allow entries (macf#302 regression)', () => {
  // Scenario reproduces macf#302: cv-architect's `.claude/settings.json`
  // had operator-authored `Write` + `Edit` entries plus a legacy
  // `Skill(macf-agent:*)` wildcard. After observing the after-state
  // (Write/Edit stripped, wildcard preserved, 4 specific Skill entries
  // missing), science-agent reported the drift as a macf-update bug.
  //
  // This test runs the EXACT 4 settings-writers `update.ts` invokes
  // (in update-order) on the empirical before-state and asserts the
  // expected after-state. PASS = macf-update is NOT the culprit;
  // operator entries round-trip cleanly. The drift on academic-resume
  // is therefore traceable to a non-macf surface (rehearsal harness
  // template-overwrite, TUI startup normalization, or similar) rather
  // than the macf settings-writers.
  //
  // Defensive purpose: any future regression in installGhTokenHook /
  // installPluginSkillPermissions / installSandboxFdAllowRead /
  // installSandboxExcludedCommands that strips operator-authored allow
  // entries fails this test.
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-302-regression-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves Write + Edit through full update sequence (#302 reproducer)', () => {
    // Empirical BEFORE state from cv-architect's academic-resume workspace
    // pre-rehearsal #12b (per #302 issue body):
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebFetch', 'WebSearch', 'Bash(*)', 'Agent',
          'mcp__*', 'Skill(macf-agent:*)',
        ],
      },
    }, null, 2));

    // Run the exact 4 settings-writers in update.ts ordering:
    installGhTokenHook(tmpRoot);
    installPluginSkillPermissions(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);
    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const allow: readonly string[] = s.permissions.allow;

    // Operator-authored entries MUST round-trip:
    expect(allow).toContain('Write');
    expect(allow).toContain('Edit');
    expect(allow).toContain('Read');
    expect(allow).toContain('Glob');
    expect(allow).toContain('Grep');
    expect(allow).toContain('WebFetch');
    expect(allow).toContain('WebSearch');
    expect(allow).toContain('Bash(*)');
    expect(allow).toContain('Agent');
    expect(allow).toContain('mcp__*');

    // MACF-managed: 5 specific Skill entries installed (macf#350 added macf-notify-peer):
    expect(allow).toContain('Skill(macf-agent:macf-status)');
    expect(allow).toContain('Skill(macf-agent:macf-issues)');
    expect(allow).toContain('Skill(macf-agent:macf-peers)');
    expect(allow).toContain('Skill(macf-agent:macf-ping)');
    expect(allow).toContain('Skill(macf-agent:macf-notify-peer)');

    // MACF-managed: legacy wildcard dropped (current pattern is N specific
    // entries — wildcard would auto-approve future-added skills without
    // operator review). See packages/macf/src/cli/settings-writer.ts:138.
    expect(allow).not.toContain('Skill(macf-agent:*)');
  });

  it('does not strip Write/Edit when sandbox + hook writers run after plugin-skill writer', () => {
    // Defends against a future refactor that orders the writers differently
    // and accidentally drops permissions.allow during a sandbox-section update.
    // Each writer is supposed to be merge-preserving; the test enforces this
    // across all 4 in any future ordering.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Write', 'Edit'] },
    }, null, 2));

    // Reverse order — same merge-preservation requirement.
    installSandboxExcludedCommands(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);
    installPluginSkillPermissions(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.permissions.allow).toContain('Write');
    expect(s.permissions.allow).toContain('Edit');
  });

  it('preserves operator deny rules alongside operator allow (defensive)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Write', 'Edit', 'Bash(*)'],
        deny: ['Bash(rm -rf /)', 'Write(/etc/*)'],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);
    installPluginSkillPermissions(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);
    installSandboxExcludedCommands(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.permissions.allow).toContain('Write');
    expect(s.permissions.allow).toContain('Edit');
    // DR-028: the deny floor is now unioned in — operator entries preserved,
    // floor added (not an exact-equals anymore).
    expect(s.permissions.deny).toContain('Bash(rm -rf /)'); // operator's (also in floor)
    expect(s.permissions.deny).toContain('Write(/etc/*)'); // operator-only — preserved
    expect(s.permissions.deny).toContain('Bash(sudo *)'); // floor
    // No duplicate of the shared 'Bash(rm -rf /)' entry.
    expect(s.permissions.deny.filter((d: string) => d === 'Bash(rm -rf /)')).toHaveLength(1);
  });
});
