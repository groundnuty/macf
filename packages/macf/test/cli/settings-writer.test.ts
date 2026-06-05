/**
 * Tests for `src/cli/settings-writer.ts` — merge-preserving writer
 * for `<workspace>/.claude/settings.json` that installs the PreToolUse
 * entry for `check-gh-token.sh` without clobbering operator-authored
 * settings (per #140).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhTokenHook, MACF_HOOK_COMMAND, MACF_MENTION_HOOK_COMMAND, MACF_LGTM_HOOK_COMMAND, MACF_CLOSE_HOOK_COMMAND, installPluginSkillPermissions, PLUGIN_SKILL_PERMISSIONS, PLUGIN_MCP_TOOL_PERMISSIONS, installSandboxFdAllowRead, SANDBOX_FD_READ_PATTERN, installSandboxExcludedCommands, SANDBOX_EXCLUDED_COMMANDS, getSandboxExcludedCommands, getPermissionsAllow, getPermissionsDeny } from '../../src/cli/settings-writer.js';

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
  // regardless of where Bash was invoked from.
  it('MACF_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent absolute path)', () => {
    expect(MACF_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\//);
    expect(MACF_HOOK_COMMAND).toContain('check-gh-token.sh');
  });

  it('creates .claude/settings.json when missing, with the hook entries', () => {
    installGhTokenHook(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Four MACF hook entries land per call: check-gh-token.sh +
    // check-mention-routing.sh + check-lgtm-gate.sh (groundnuty/macf#270) +
    // check-close-keyword.sh (groundnuty/macf#431).
    expect(s.hooks.PreToolUse).toHaveLength(4);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(s.hooks.PreToolUse[1].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[1].hooks[0].command).toBe(MACF_MENTION_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[1].hooks[0].type).toBe('command');
    expect(s.hooks.PreToolUse[2].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[2].hooks[0].command).toBe(MACF_LGTM_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[2].hooks[0].type).toBe('command');
    expect(s.hooks.PreToolUse[3].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[3].hooks[0].command).toBe(MACF_CLOSE_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[3].hooks[0].type).toBe('command');
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
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
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
    // 1 user Edit hook + 4 MACF Bash hooks (gh-token + mention-routing +
    // lgtm-gate + close-keyword).
    expect(s.hooks.PreToolUse).toHaveLength(5);
    const userHook = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === 'Edit');
    const macfHooks = s.hooks.PreToolUse.filter(
      (e: { matcher: string; hooks: { command: string }[] }) =>
        e.matcher === 'Bash' &&
        e.hooks.some((h) =>
          [MACF_HOOK_COMMAND, MACF_MENTION_HOOK_COMMAND, MACF_LGTM_HOOK_COMMAND, MACF_CLOSE_HOOK_COMMAND].includes(h.command),
        ),
    );
    expect(userHook).toBeDefined();
    expect(userHook.hooks[0].command).toBe('./user-edit-hook.sh');
    expect(macfHooks).toHaveLength(4);
    const cmds = macfHooks.map((e: { hooks: { command: string }[] }) => e.hooks[0].command);
    expect(cmds).toContain(MACF_HOOK_COMMAND);
    expect(cmds).toContain(MACF_MENTION_HOOK_COMMAND);
    expect(cmds).toContain(MACF_LGTM_HOOK_COMMAND);
    expect(cmds).toContain(MACF_CLOSE_HOOK_COMMAND);
  });

  it('preserves other hook event types (SessionStart, Stop, etc.)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: './user-session-hook.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: './user-stop-hook.sh' }] }],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
  });

  it('is idempotent — second call does not duplicate the MACF entry', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_HOOK_COMMAND),
    );
    expect(macfEntries).toHaveLength(1);
  });

  it('refreshes a stale MACF entry (replaces by command-path match)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh --old-flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-gh-token.sh')),
    );
    expect(macfEntries).toHaveLength(1);
    expect(macfEntries[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
    // --old-flag should be gone.
    expect(macfEntries[0].hooks[0].command).not.toContain('--old-flag');
  });

  // Per macf#232: workspaces created before the cwd-independent path
  // change have a relative-path entry (`.claude/scripts/...`). On the
  // next `macf update` the basename matcher (`isMacfManagedCommand`)
  // recognizes the legacy entry as MACF-managed and replaces it with
  // the current `$CLAUDE_PROJECT_DIR/...` form. No legacy-pattern
  // list is needed (basename match is path-agnostic). Operator hooks
  // unrelated to MACF stay untouched.
  it('migrates legacy relative-path entry to $CLAUDE_PROJECT_DIR form (macf#232)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh' }],
          },
          // Operator-authored unrelated hook that must survive.
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo edited' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Exactly one MACF entry, on the current absolute form.
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-gh-token.sh')),
    );
    expect(macfEntries).toHaveLength(1);
    expect(macfEntries[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
    expect(macfEntries[0].hooks[0].command).toMatch(/^\$CLAUDE_PROJECT_DIR\//);

    // Operator-authored hook preserved verbatim.
    const operatorEntries = s.hooks.PreToolUse.filter((e: { matcher?: string }) =>
      e.matcher === 'Edit',
    );
    expect(operatorEntries).toHaveLength(1);
    expect(operatorEntries[0].hooks[0].command).toBe('echo edited');
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
    expect(raw).toMatch(/^\{\n  /); // starts with `{` then newline+2-space indent
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
    // And all real MACF entries landed alongside it.
    const macfGhTokenEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_HOOK_COMMAND),
    );
    expect(macfGhTokenEntry).toBeDefined();
    const macfMentionEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_MENTION_HOOK_COMMAND),
    );
    expect(macfMentionEntry).toBeDefined();
    const macfLgtmEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_LGTM_HOOK_COMMAND),
    );
    expect(macfLgtmEntry).toBeDefined();
    // 1 operator + 4 MACF entries.
    expect(s.hooks.PreToolUse).toHaveLength(5);
  });

  it('refreshes a stale MACF mention-routing entry alongside gh-token', () => {
    // Same shape as the gh-token "refresh" test but for the new
    // check-mention-routing.sh hook landed via groundnuty/macf#272.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-mention-routing.sh --legacy-flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const mentionEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-mention-routing.sh')),
    );
    expect(mentionEntries).toHaveLength(1);
    expect(mentionEntries[0].hooks[0].command).toBe(MACF_MENTION_HOOK_COMMAND);
    // Stale --legacy-flag dropped via path-end matching in MACF_HOOK_FILENAMES.
    expect(mentionEntries[0].hooks[0].command).not.toContain('--legacy-flag');
  });

  it('idempotent: second call does not duplicate mention-routing entry', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const mentionEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_MENTION_HOOK_COMMAND),
    );
    expect(mentionEntries).toHaveLength(1);
  });

  // groundnuty/macf#270 — DR-023 UC-2 LGTM-gate hook entry. Same path-end
  // matching + idempotency posture as the mention-routing entry.
  it('MACF_LGTM_HOOK_COMMAND uses $CLAUDE_PROJECT_DIR (cwd-independent)', () => {
    expect(MACF_LGTM_HOOK_COMMAND).toMatch(/^\$CLAUDE_PROJECT_DIR\//);
    expect(MACF_LGTM_HOOK_COMMAND).toContain('check-lgtm-gate.sh');
  });

  it('refreshes a stale MACF lgtm-gate entry alongside other hooks', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-lgtm-gate.sh --legacy-flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const lgtmEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-lgtm-gate.sh')),
    );
    expect(lgtmEntries).toHaveLength(1);
    expect(lgtmEntries[0].hooks[0].command).toBe(MACF_LGTM_HOOK_COMMAND);
    // Stale --legacy-flag dropped via path-end matching in MACF_HOOK_FILENAMES.
    expect(lgtmEntries[0].hooks[0].command).not.toContain('--legacy-flag');
  });

  it('idempotent: second call does not duplicate lgtm-gate entry', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const lgtmEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_LGTM_HOOK_COMMAND),
    );
    expect(lgtmEntries).toHaveLength(1);
  });

  it('does NOT misclassify operator files with similar lgtm-gate basenames as MACF-managed', () => {
    // Sister regression of the gh-token "lookalike" test — defends
    // against `my-check-lgtm-gate.sh-wrapper` being misclassified.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: './my-check-lgtm-gate.sh-wrapper --flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const operatorEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === './my-check-lgtm-gate.sh-wrapper --flag'),
    );
    expect(operatorEntry).toBeDefined();
    // 1 operator + 4 MACF entries.
    expect(s.hooks.PreToolUse).toHaveLength(5);
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

  it('creates .claude/settings.json with all skill + MCP tool patterns when missing', () => {
    installPluginSkillPermissions(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Post-#349: skill patterns + MCP tool patterns installed in lockstep.
    expect(s.permissions.allow).toEqual([...PLUGIN_SKILL_PERMISSIONS, ...PLUGIN_MCP_TOOL_PERMISSIONS]);
    // Spot-check the 5 skills (macf#350 added macf-notify-peer).
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-status)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-issues)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-peers)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-ping)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-notify-peer)');
    // Spot-check the 2 MCP tools (macf#349).
    expect(s.permissions.allow).toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');
    expect(s.permissions.allow).toContain('mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory');
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
      expect(PLUGIN_MCP_TOOL_PERMISSIONS).toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');
      expect(PLUGIN_MCP_TOOL_PERMISSIONS).toContain('mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory');
    });

    it('installs MCP tool permissions on a fresh workspace', () => {
      installPluginSkillPermissions(tmpRoot);
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const allow: readonly string[] = s.permissions.allow;
      expect(allow).toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');
      expect(allow).toContain('mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory');
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
      expect(allow).toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');             // ours
      expect(allow).toContain('mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory');    // ours
    });

    it('drops stale MCP tool entries (e.g. tool removed in newer plugin) on refresh', () => {
      mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        permissions: {
          allow: [
            'mcp__plugin_macf-agent_macf-agent__since_removed_tool',  // stale ours
            'mcp__plugin_macf-agent_macf-agent__notify_peer',         // current
            'Bash(*)',                                                 // operator — preserved
          ],
        },
      }, null, 2));

      installPluginSkillPermissions(tmpRoot);

      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      expect(allow).not.toContain('mcp__plugin_macf-agent_macf-agent__since_removed_tool');  // dropped
      expect(allow).toContain('mcp__plugin_macf-agent_macf-agent__notify_peer');             // current re-installed
      expect(allow).toContain('Bash(*)');                                                    // operator preserved
    });

    it('idempotent: repeated calls don\'t duplicate MCP tool entries', () => {
      installPluginSkillPermissions(tmpRoot);
      installPluginSkillPermissions(tmpRoot);
      installPluginSkillPermissions(tmpRoot);
      const allow = JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
      const notifyCount = allow.filter((e: string) => e === 'mcp__plugin_macf-agent_macf-agent__notify_peer').length;
      const checkpointCount = allow.filter((e: string) => e === 'mcp__plugin_macf-agent_macf-agent__checkpoint_to_memory').length;
      expect(notifyCount).toBe(1);
      expect(checkpointCount).toBe(1);
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
    expect(s.permissions.deny).toEqual(['Bash(rm -rf /)', 'Write(/etc/*)']);
  });
});
