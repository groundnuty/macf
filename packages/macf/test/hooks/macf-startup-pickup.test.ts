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
  /** Contents of the tmux-submit stub's invocation marker, or null if never invoked. */
  readonly submitInvocation: string | null;
}

function runHook(opts: {
  /** stdout the fake plugin CLI's `issues` command should print; undefined = plugin CLI file absent entirely. */
  readonly pluginOutput?: string;
  /** Non-zero exit for the fake plugin CLI (simulates a query failure). */
  readonly pluginExitNonZero?: boolean;
  readonly env?: Record<string, string | undefined>;
  /** Whether to set TMUX (simulates running inside a tmux session). Defaults true. */
  readonly inTmux?: boolean;
}): RunResult {
  const workspace = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-ws-'));

  if (opts.pluginOutput !== undefined) {
    const pluginBinDir = join(workspace, '.macf', 'plugin', 'dist', 'plugin', 'bin');
    mkdirSync(pluginBinDir, { recursive: true });
    const exitLine = opts.pluginExitNonZero ? 'process.exitCode = 1;' : '';
    writeFileSync(
      join(pluginBinDir, 'macf-plugin-cli.js'),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(opts.pluginOutput)});\n${exitLine}\n`,
    );
  }

  const scriptsDir = join(workspace, '.claude', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const submitMarker = join(workspace, 'submit-invocation.txt');
  // Stub tmux-send-to-claude.sh: record argv instead of touching real tmux.
  writeFileSync(
    join(scriptsDir, 'tmux-send-to-claude.sh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(submitMarker)}\n`,
  );
  chmodSync(join(scriptsDir, 'tmux-send-to-claude.sh'), 0o755);

  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    CLAUDE_PROJECT_DIR: workspace,
    ...(opts.inTmux === false ? {} : { TMUX: '/tmp/tmux-1000/default,1234,0' }),
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
  };
}

describe('macf-startup-pickup.sh (SessionStart hook, groundnuty/macf#768)', () => {
  describe('(a) auto-resuming role (e.g. code-agent) + pending work → submits via tmux-send-to-claude.sh', () => {
    it('prints the plugin output + submits a follow-up prompt', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      // Submitted via the sanctioned helper with the empty-session ("current
      // pane") form + a "Pick up pending issues" prompt.
      expect(r.submitInvocation).not.toBeNull();
      const lines = (r.submitInvocation ?? '').split('\n');
      expect(lines[0]).toBe('');
      expect(lines[1]).toMatch(/Pick up pending issues/);
    });

    it('also submits when only inbox messages were drained (no open issues)', () => {
      const r = runHook({
        pluginOutput: DRAINED_ONLY_OUTPUT,
        env: { MACF_AGENT_ROLE: 'science-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.submitInvocation).not.toBeNull();
    });
  });

  describe('(b) no pending work → no submit', () => {
    it('prints the plugin output but does NOT invoke the submit helper', () => {
      const r = runHook({
        pluginOutput: NO_PENDING_OUTPUT,
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
});
