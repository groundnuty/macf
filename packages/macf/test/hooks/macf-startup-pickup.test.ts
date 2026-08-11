/**
 * Tests for `scripts/macf-startup-pickup.sh` — the canonical SessionStart
 * hook (groundnuty/macf#768) that surfaces pending work at session start
 * and, for auto-resuming roles, submits a follow-up prompt via
 * `tmux-send-to-claude.sh` so the agent picks the queue up without an
 * operator nudge.
 *
 * THIN BY DESIGN: the hook delegates the queue-query to the plugin's own
 * `issues` command (the same one backing `/macf-issues`) rather than
 * hand-rolling `gh issue list` — these tests fake that command (a stub
 * `.macf/plugin/dist/plugin/bin/macf-plugin-cli.js`) and the submit helper
 * (a stub `.claude/scripts/tmux-send-to-claude.sh` that records its
 * invocation instead of touching a real tmux session), so no real GitHub
 * or tmux access is needed.
 *
 * Hook contract (SessionStart): JSON on stdin (ignored); STDOUT is injected
 * into the agent's context. OBSERVATIONAL + NON-BLOCKING — the script
 * ALWAYS exits 0. Overrides: MACF_NO_STARTUP_PICKUP=1.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'macf-startup-pickup.sh');

const PENDING_OUTPUT = [
  '2 pending issue(s):',
  '',
  '  #1: fix the thing',
  '  #2: write the docs',
  '',
  'Coordination sweep (coordination.md §Communication 5) — run before considering yourself idle:',
].join('\n');

const NO_PENDING_OUTPUT = [
  'No pending issues.',
  '',
  'Coordination sweep (coordination.md §Communication 5) — run before considering yourself idle:',
].join('\n');

const DRAINED_ONLY_OUTPUT = [
  'No pending issues.',
  '',
  '1 inbox message(s) drained on startup:',
  '  msg-1 (received 2026-07-03T00:00:00.000Z): {"foo":"bar"}',
  '',
  'Coordination sweep (coordination.md §Communication 5) — run before considering yourself idle:',
].join('\n');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Contents of the tmux-submit stub's LAST invocation marker, or null if never invoked. */
  readonly submitInvocation: string | null;
  /** How many times the tmux-submit stub was invoked (macf#802 retry coverage). */
  readonly submitCallCount: number;
}

/**
 * Install a fake `tmux` executable on PATH ahead of any real one, so
 * `capture-pane` calls made by the macf#802 readiness/verify gate return a
 * scripted sequence of pane "frames" instead of touching a real tmux
 * server. Each `capture-pane` invocation (regardless of `-t <target>` vs
 * bare `-p`, matching the hook's own fallback) advances to the next frame;
 * once the list is exhausted, the LAST frame repeats (simulates "settled
 * into a steady state" rather than a scripted end-of-test cliff).
 *
 * Returns the bin directory to prepend to PATH.
 */
function writeTmuxCaptureStub(workspace: string, frames: readonly string[]): string {
  const framesDir = join(workspace, 'frames');
  mkdirSync(framesDir, { recursive: true });
  frames.forEach((frame, i) => writeFileSync(join(framesDir, String(i)), frame));
  const idxFile = join(workspace, 'tmux-capture-idx.txt');
  const binDir = join(workspace, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const maxIdx = frames.length - 1;
  writeFileSync(
    join(binDir, 'tmux'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "capture-pane" ]; then',
      `  idx_file=${JSON.stringify(idxFile)}`,
      '  idx=$(cat "$idx_file" 2>/dev/null || echo 0)',
      `  max=${maxIdx}`,
      '  use=$idx',
      '  if [ "$use" -gt "$max" ]; then use=$max; fi',
      `  frame_file=${JSON.stringify(framesDir)}/$use`,
      '  [ -f "$frame_file" ] && cat "$frame_file"',
      '  echo $((idx + 1)) > "$idx_file"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'tmux'), 0o755);
  return binDir;
}

function runHook(opts: {
  /** stdout the fake plugin CLI's `issues` command should print; undefined = plugin CLI file absent entirely. */
  readonly pluginOutput?: string;
  /**
   * stdout the fake plugin CLI's `issues --oneline` command should print
   * (macf#816 — the detailed-submit source). Defaults to '' (no pending GH
   * issues) when `pluginOutput` is set but this is omitted — most fail-open
   * / gated test cases never reach the `--oneline` call at all, so the
   * default only matters for the handful of tests that assert on submit
   * text/behavior and set it explicitly.
   */
  readonly pluginOnelineOutput?: string;
  /** Non-zero exit for the fake plugin CLI's plain `issues` call (simulates a query failure). */
  readonly pluginExitNonZero?: boolean;
  /** Non-zero exit for the fake plugin CLI's `issues --oneline` call specifically (macf#816). */
  readonly pluginOnelineExitNonZero?: boolean;
  readonly env?: Record<string, string | undefined>;
  /** Whether to set TMUX (simulates running inside a tmux session). Defaults true. */
  readonly inTmux?: boolean;
  /**
   * Scripted `capture-pane` frame sequence (macf#802) — see
   * `writeTmuxCaptureStub`. Omitted = no fake `tmux` on PATH, so
   * `capture-pane` calls fail (no real tmux server reachable in the test
   * sandbox) and the readiness/verify gate treats every capture as
   * "can't tell" — the pre-#802 behavior (immediate, unconditional submit).
   */
  readonly tmuxFrames?: readonly string[];
}): RunResult {
  const workspace = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-ws-'));

  if (opts.pluginOutput !== undefined) {
    const pluginBinDir = join(workspace, '.macf', 'plugin', 'dist', 'plugin', 'bin');
    mkdirSync(pluginBinDir, { recursive: true });
    const fullOutput = JSON.stringify(opts.pluginOutput);
    const onelineOutput = JSON.stringify(opts.pluginOnelineOutput ?? '');
    const fullExit = opts.pluginExitNonZero ? 1 : 0;
    const onelineExit = opts.pluginOnelineExitNonZero ? 1 : 0;
    writeFileSync(
      join(pluginBinDir, 'macf-plugin-cli.js'),
      [
        '#!/usr/bin/env node',
        "const isOneline = process.argv[3] === '--oneline';",
        `console.log(isOneline ? ${onelineOutput} : ${fullOutput});`,
        `process.exitCode = isOneline ? ${onelineExit} : ${fullExit};`,
        '',
      ].join('\n'),
    );
  }

  const scriptsDir = join(workspace, '.claude', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const submitMarker = join(workspace, 'submit-invocation.txt');
  const submitCountFile = join(workspace, 'submit-call-count.txt');
  // Stub tmux-send-to-claude.sh: record argv (overwritten each call — callers
  // that expect a single invocation read this) + a call COUNT (appended,
  // macf#802 retry coverage) instead of touching a real tmux session.
  writeFileSync(
    join(scriptsDir, 'tmux-send-to-claude.sh'),
    [
      '#!/usr/bin/env bash',
      `n=$(cat ${JSON.stringify(submitCountFile)} 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > ${JSON.stringify(submitCountFile)}`,
      `printf '%s\\n' "$@" > ${JSON.stringify(submitMarker)}`,
      '',
    ].join('\n'),
  );
  chmodSync(join(scriptsDir, 'tmux-send-to-claude.sh'), 0o755);

  const pathParts = [process.env['PATH'] ?? ''];
  if (opts.tmuxFrames) {
    pathParts.unshift(writeTmuxCaptureStub(workspace, opts.tmuxFrames));
  }

  const cleanEnv: Record<string, string> = {
    PATH: pathParts.join(':'),
    CLAUDE_PROJECT_DIR: workspace,
    // Workspace-scoped (not a fixed literal like `/tmp/tmux-1000/default,...`):
    // a shared-host dev sandbox can have a REAL tmux server listening on a
    // conventional-looking `/tmp/tmux-<uid>/default` socket, and a fixed
    // literal risks colliding with it — a bare (no `-t`) `tmux capture-pane`
    // call would then read a live, unrelated pane instead of failing closed.
    // Only the macf#802 readiness/verify gate actually invokes real `tmux`
    // (`tmux-send-to-claude.sh` itself is always stubbed below); before that
    // gate existed this collision was latent and harmless.
    ...(opts.inTmux === false ? {} : { TMUX: `${workspace}/fake-tmux-socket,99999,0` }),
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }

  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: JSON.stringify({ session_id: 'sess-x', source: 'startup' }),
    env: cleanEnv,
    encoding: 'utf-8',
  });

  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    submitInvocation: existsSync(submitMarker) ? readFileSync(submitMarker, 'utf-8') : null,
    submitCallCount: existsSync(submitCountFile) ? Number(readFileSync(submitCountFile, 'utf-8').trim()) : 0,
  };
}

describe('macf-startup-pickup.sh (SessionStart hook, groundnuty/macf#768)', () => {
  describe('(a) auto-resuming role (e.g. code-agent) + pending work → submits via tmux-send-to-claude.sh', () => {
    it('prints the plugin output + submits a DETAILED follow-up prompt naming the pending issues (macf#816)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing; #2: write the docs',
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      // Submitted via the sanctioned helper with the empty-session ("current
      // pane") form + a "Pick up pending issues: <oneline list>" prompt —
      // the detailed line from `issues --oneline`, not the old generic
      // "review the queue above" pointer.
      expect(r.submitInvocation).not.toBeNull();
      const lines = (r.submitInvocation ?? '').split('\n');
      expect(lines[0]).toBe('');
      expect(lines[1]).toBe('Pick up pending issues: #1: fix the thing; #2: write the docs');
    });

    it('submits the INBOX nudge when only inbox messages were drained and no GH issues are pending (macf#816 review-fix)', () => {
      // No open GH issues → `--oneline` is empty → there is no detailed issue
      // list to name. But the inbox WAS drained (offline-arrived peer work),
      // and the pre-#816 hook fired a self-nudge on that case too. Preserve
      // it: submit an inbox-oriented nudge (not the issue-list prompt) so a
      // drained message can't strand un-processed (the #802 silent-fallback
      // shape). The full drained-message text is also printed in context above.
      const r = runHook({
        pluginOutput: DRAINED_ONLY_OUTPUT,
        pluginOnelineOutput: '',
        env: { MACF_AGENT_ROLE: 'science-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('inbox message(s) drained on startup:');
      expect(r.submitInvocation).not.toBeNull();
      const lines = (r.submitInvocation ?? '').split('\n');
      // tmux-send-to-claude.sh stub records its args; arg[1] is the prompt.
      expect(lines[1]).toBe('Process the inbox message(s) drained on startup (surfaced above).');
    });
  });

  describe('(b) no pending work → no submit', () => {
    it('prints the plugin output but does NOT invoke the submit helper', () => {
      const r = runHook({
        pluginOutput: NO_PENDING_OUTPUT,
        pluginOnelineOutput: '',
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('No pending issues.');
      expect(r.submitInvocation).toBeNull();
    });
  });

  describe('(c) role=auditor → FULL no-op (DR-026: propose-only, never an actuator)', () => {
    it('exits 0 with EMPTY stdout and never queries or submits, even with pending work', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'auditor' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });
  });

  describe('(d) MACF_NO_STARTUP_PICKUP=1 → opt-out, no-op regardless of role', () => {
    it('suppresses the hook entirely for an auto-resuming role', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent', MACF_NO_STARTUP_PICKUP: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it('does NOT trigger on MACF_NO_STARTUP_PICKUP="0" (only "1" opts out)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', MACF_NO_STARTUP_PICKUP: '0' },
      });
      expect(r.status).toBe(0);
      expect(r.submitInvocation).not.toBeNull();
    });
  });

  describe('(e) fail-open paths — never blocks the session', () => {
    it('no .macf/plugin mount at all (never macf-init\'d) → silent exit 0', () => {
      const r = runHook({ env: { MACF_AGENT_ROLE: 'code-agent' } }); // pluginOutput undefined → no plugin file
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it('plugin CLI query fails (non-zero exit) → silent exit 0, no submit', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginExitNonZero: true,
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      // A non-zero exit from the plugin CLI is treated as "nothing to
      // report this start" — the hook does not surface partial output.
      expect(r.submitInvocation).toBeNull();
    });

    it('not inside a tmux session → prints output but does not attempt submit', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        inTmux: false,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).toBeNull();
    });

    it('the `issues --oneline` call fails (non-zero exit) → silent exit 0, no submit (macf#816)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        pluginOnelineExitNonZero: true,
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      // The full context was already printed successfully — only the
      // detailed self-nudge submit is skipped when its own query fails.
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).toBeNull();
    });

    it('malformed / empty stdin → still exits 0', () => {
      const workspace = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-ws-'));
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: 'not json {{{',
        env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: workspace },
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
    });
  });

  describe('(f) thin design — delegates to the plugin CLI, never hand-rolls gh issue list', () => {
    // Strip comment lines first — the header prose intentionally NAMES the
    // anti-patterns ("never hand-roll `gh issue list`", "never inline `tmux
    // send-keys ... Enter`") as documentation; the assertions below check
    // the actual EXECUTABLE code, not the prose describing what to avoid.
    function codeOnly(script: string): string {
      return script
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
    }

    it('script content invokes macf-plugin-cli.js issues and never calls `gh issue list` directly', () => {
      const script = readFileSync(HOOK_SCRIPT, 'utf-8');
      const code = codeOnly(script);
      expect(script).toContain('macf-plugin-cli.js');
      expect(script).toMatch(/\bissues\b/);
      expect(code).not.toMatch(/gh issue list/);
    });

    it('script content submits exclusively via tmux-send-to-claude.sh (never inline `tmux send-keys ... Enter`)', () => {
      const script = readFileSync(HOOK_SCRIPT, 'utf-8');
      const code = codeOnly(script);
      expect(script).toContain('tmux-send-to-claude.sh');
      expect(code).not.toMatch(/tmux send-keys[^\n]*Enter/);
    });
  });

  describe('(g) readiness + verify gate — the pickup prompt no longer gets silently swallowed by a startup ceremony prompt (groundnuty/macf#802)', () => {
    // Real #703-shaped ceremony prompts (dev-channels ack, folder-trust) —
    // a numbered-option cursor line is what `_pane_blocked` matches.
    const BLOCKED_DEV_CHANNELS = [
      '❯ 1. I am using this for local development',
      '  2. Exit',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const BLOCKED_TRUST_FOLDER = ['❯ 1. Yes, I trust this folder', '  2. No, exit'].join('\n');
    // Not blocking-shaped — Claude's free-form input cursor has no numbered
    // option after the ❯, so `_pane_blocked` reads it as clear.
    const CLEAR_IDLE = '❯ ';
    const CLEAR_ACTIVE = '⠋ Working on it...';

    // Tiny overrides so these tests run in well under a second instead of
    // exercising the real ~90s default budget.
    const FAST_TIMING = {
      MACF_STARTUP_PICKUP_READY_TIMEOUT_SECS: '1',
      MACF_STARTUP_PICKUP_READY_INTERVAL_SECS: '0.1',
      MACF_STARTUP_PICKUP_VERIFY_DELAY_SECS: '0.1',
    };

    it('pane shows a blocking ceremony prompt for the whole window → skips the submit, warns loud instead of swallowing it', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        tmuxFrames: [BLOCKED_DEV_CHANNELS],
      });
      expect(r.status).toBe(0);
      expect(r.submitInvocation).toBeNull();
      expect(r.submitCallCount).toBe(0);
      expect(r.stdout).toContain('WARNING');
      expect(r.stdout).toContain('startup ceremony prompt');
      expect(r.stdout).toContain('groundnuty/macf#802');
    });

    it('pane is blocked then clears within the window → waits it out, then submits exactly once', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        tmuxFrames: [BLOCKED_DEV_CHANNELS, BLOCKED_DEV_CHANNELS, CLEAR_IDLE, CLEAR_ACTIVE],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(1);
      expect(r.submitInvocation).not.toBeNull();
      const lines = (r.submitInvocation ?? '').split('\n');
      expect(lines[1]).toBe('Pick up pending issues: #1: fix the thing');
      expect(r.stdout).not.toContain('WARNING');
    });

    it('pane content stays static after the submit (never visibly reacts) → retries once, then warns instead of silently declaring success', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        // Never changes, never blocked — the pre-send check passes
        // immediately, but the post-send verify never sees a diff.
        tmuxFrames: [CLEAR_IDLE],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(2); // one bounded retry, then give up
      expect(r.stdout).toContain('WARNING');
      expect(r.stdout).toContain('could not confirm the auto-submit landed');
      expect(r.stdout).toContain('groundnuty/macf#802');
    });

    it('the pane shows a DIFFERENT blocking prompt right after the submit → not mistaken for success just because content differs', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        // Pre-send check passes on CLEAR_IDLE; the post-send capture lands
        // on a NEW blocking prompt whose content differs from CLEAR_IDLE —
        // a raw content-diff alone would misread this as "delivered".
        tmuxFrames: [CLEAR_IDLE, BLOCKED_TRUST_FOLDER, BLOCKED_TRUST_FOLDER],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(2);
      expect(r.stdout).toContain('WARNING');
      expect(r.stdout).toContain('could not confirm the auto-submit landed');
    });

    it('no tmux reachable at all (capture always fails) → fails OPEN, immediate unconditional submit (pre-#802 behavior preserved)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        // No tmuxFrames → no fake tmux on PATH → every capture-pane call
        // fails (no real tmux server reachable in the test sandbox).
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(1);
      expect(r.stdout).not.toContain('WARNING');
    });
  });
});
