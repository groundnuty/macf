/**
 * Tests for src/tmux-wake.ts — macf#185 sidecar wake path.
 *
 * Scope:
 *   - resolveTmuxTarget's 4 branches (explicit both, explicit session-only,
 *     auto-detect via $TMUX, no-target) — pure function, exercised via
 *     injected env + mocked tmux command
 *   - wakeViaTmux's fail-silent policy — missing helper, missing target,
 *     spawn failure, non-zero exit all return false without throwing
 *   - wakeViaTmux's success path — spawns helper with correct argv, logs
 *     the delivery event
 *
 * Out of scope:
 *   - Actual tmux interaction (that's integration territory; smoke-
 *     tested manually during CV Phase 7 rollout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTmuxTarget, wakeViaTmux } from '../src/tmux-wake.js';
import type { Logger } from '@groundnuty/macf-core';

function makeLogger(): Logger & { readonly events: Array<{ event: string; data: Record<string, unknown> }> } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logger = {
    events,
    info: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
    warn: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
    error: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
  } as Logger & { readonly events: typeof events };
  return logger;
}

describe('resolveTmuxTarget', () => {
  it('returns "session:window" when both provided', () => {
    expect(resolveTmuxTarget({ session: 'cv-project', window: '0' })).toBe('cv-project:0');
    expect(resolveTmuxTarget({ session: 'cv-project', window: 'cv-architect' }))
      .toBe('cv-project:cv-architect');
  });

  it('returns session alone when window not provided', () => {
    expect(resolveTmuxTarget({ session: 'cv-project' })).toBe('cv-project');
    expect(resolveTmuxTarget({ session: 'cv-project', window: '' })).toBe('cv-project');
  });

  it('returns null when session empty AND no $TMUX in env', () => {
    expect(resolveTmuxTarget({ env: {} })).toBeNull();
    expect(resolveTmuxTarget({ session: '', env: {} })).toBeNull();
  });

  describe('$TMUX_PANE priority (macf#189 sub-item 3)', () => {
    it('returns $TMUX_PANE value when set (no explicit session)', () => {
      // Pane IDs are tmux-specific — %<digits> format. Valid `-t` target.
      expect(resolveTmuxTarget({ env: { TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%87' } }))
        .toBe('%87');
    });

    it('$TMUX_PANE beats display-message fallback', () => {
      // Both $TMUX and $TMUX_PANE present → use pane directly, skip
      // display-message entirely. The deterministic-per-pane guarantee
      // is what made the bilateral e2e demo's ambiguity fix work.
      const env = { TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%99' };
      expect(resolveTmuxTarget({ env })).toBe('%99');
    });

    it('explicit session still beats $TMUX_PANE', () => {
      // Operator-declared config is the highest priority — if they
      // set an explicit session, use it. Auto-detection is only a
      // zero-config convenience.
      const env = { TMUX: '/tmp/tmux-1000/default', TMUX_PANE: '%87' };
      expect(resolveTmuxTarget({ session: 'operator-pick', env }))
        .toBe('operator-pick');
    });

    // Note: the display-message fallback path (TMUX set, TMUX_PANE
    // unset) isn't unit-testable deterministically — the actual tmux
    // binary's behavior depends on the test runner's real tmux state
    // (CI runners have no tmux → always null; local dev inside tmux
    // → returns the real session:window). The TMUX_PANE priority
    // tests above + the "no $TMUX" path cover the deterministic
    // branches; the display-message fallback is exercised
    // empirically during integration smoke.
  });
});

describe('wakeViaTmux', () => {
  let workspaceDir: string;
  let scriptPath: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'macf-tmux-wake-'));
    scriptPath = join(workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function installHelper(body: string): void {
    const scriptsDir = join(workspaceDir, '.claude', 'scripts');
    require('node:fs').mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(scriptPath, body, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
  }

  it('returns false when helper script missing — logs skip reason', async () => {
    const logger = makeLogger();
    expect(existsSync(scriptPath)).toBe(false);

    const result = await wakeViaTmux('hello', { workspaceDir, session: 'cv-project', logger });
    expect(result).toBe(false);
    expect(logger.events.map(e => e.event)).toContain('tmux_wake_skipped');
    expect(logger.events[0]?.data['reason']).toBe('helper_missing');
  });

  it('returns false when target cannot be resolved (no session + no tmux env)', async () => {
    installHelper('#!/bin/sh\nexit 0\n');
    const logger = makeLogger();
    // No session passed; rely on resolveTmuxTarget's auto-detect, which
    // returns null when neither $TMUX_PANE nor $TMUX is set. Backup +
    // clear both so the test works whether the runner happens to be
    // inside tmux or not (local dev vs CI).
    const tmuxBackup = process.env['TMUX'];
    const paneBackup = process.env['TMUX_PANE'];
    delete process.env['TMUX'];
    delete process.env['TMUX_PANE'];
    try {
      const result = await wakeViaTmux('hello', { workspaceDir, logger });
      expect(result).toBe(false);
      const skipEvent = logger.events.find(e => e.event === 'tmux_wake_skipped');
      expect(skipEvent).toBeDefined();
      expect(skipEvent?.data['reason']).toBe('no_target');
    } finally {
      if (tmuxBackup !== undefined) process.env['TMUX'] = tmuxBackup;
      if (paneBackup !== undefined) process.env['TMUX_PANE'] = paneBackup;
    }
  });

  it('shells out to helper with session target + prompt as separate argv', async () => {
    // Helper records its argv to a file for inspection.
    const argLog = join(workspaceDir, 'args.log');
    installHelper(
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`,
    );
    const logger = makeLogger();

    const result = await wakeViaTmux('Pick up issue #42', {
      workspaceDir,
      session: 'cv-project',
      window: 'cv-architect',
      logger,
    });
    expect(result).toBe(true);

    // Verify the helper saw exactly our two args (target + prompt).
    const args = require('node:fs').readFileSync(argLog, 'utf-8').trim().split('\n');
    expect(args).toEqual(['cv-project:cv-architect', 'Pick up issue #42']);

    // Success event logged with metadata.
    const deliveredEvent = logger.events.find(e => e.event === 'tmux_wake_delivered');
    expect(deliveredEvent).toBeDefined();
    expect(deliveredEvent?.data['target']).toBe('cv-project:cv-architect');
    expect(deliveredEvent?.data['prompt_length']).toBe('Pick up issue #42'.length);
  });

  it('returns false on non-zero helper exit + logs stderr snippet', async () => {
    installHelper('#!/bin/sh\necho "tmux: session not found" >&2\nexit 1\n');
    const logger = makeLogger();

    const result = await wakeViaTmux('x', { workspaceDir, session: 'missing', logger });
    expect(result).toBe(false);
    const failEvent = logger.events.find(e => e.event === 'tmux_wake_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.data['reason']).toBe('nonzero_exit');
    expect(failEvent?.data['status']).toBe(1);
    expect(String(failEvent?.data['stderr'])).toContain('tmux: session not found');
  });

  it('passes prompts with shell-metacharacters safely (argv boundary, no shell)', async () => {
    // If the helper were invoked via `sh -c "script $prompt"` the
    // metacharacters would execute. Because spawn uses execvp
    // semantics with an argv array, the string is opaque to the shell.
    const argLog = join(workspaceDir, 'args.log');
    installHelper(
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`,
    );
    const logger = makeLogger();

    const nastyPrompt = `; rm -rf /tmp/\`whoami\`; echo "$(cat /etc/hostname)" && touch /tmp/pwned`;
    const result = await wakeViaTmux(nastyPrompt, { workspaceDir, session: 't', logger });
    expect(result).toBe(true);

    const args = require('node:fs').readFileSync(argLog, 'utf-8').trim().split('\n');
    // Helper saw the full literal string as one arg — no shell
    // interpolation, no command substitution, no process spawned
    // from the metacharacters.
    expect(args[1]).toBe(nastyPrompt);
    // And no /tmp/pwned side effect.
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});
