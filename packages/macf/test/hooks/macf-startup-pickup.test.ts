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
 * Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
 * agent's context. OBSERVATIONAL + NON-BLOCKING — the script ALWAYS exits
 * 0. Overrides: MACF_NO_STARTUP_PICKUP=1.
 *
 * groundnuty/macf#930: the payload is now READ (not drained/ignored) for a
 * `source` field (must be exactly `"startup"` — resume/clear/compact/fork/
 * absent/unrecognised all fail CLOSED, no injection) and `agent_id` alone
 * (present → best-effort subagent no-op; deliberately NOT `agent_type`,
 * which Claude Code also sets for a legitimate `--agent`-launched top-level
 * session — gating on it would false-positive and drop the prompt for a
 * genuine startup). `runHook`'s `source`/`agentId`/`agentType` options
 * exercise this; `source` defaults to `'startup'` so every pre-#930 call
 * site (none of which pass it) keeps exercising a genuine startup unchanged.
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

// groundnuty/macf#1170: the reporter-stall section's wording is deliberately
// disjoint from both auto-submit-gate substrings ("pending issue(s):" /
// "inbox message(s) drained on startup:") — see format.ts's
// formatReporterStallSweep. This fixture proves it end-to-end through the
// hook's OWN step-6 grep, not just via a unit assertion on the string.
const REPORTER_STALL_ONLY_OUTPUT = [
  'No pending issues.',
  '',
  '1 issue(s) you filed are open and quiet — re-read before assuming still blocked:',
  '  groundnuty/macf#999: verification nobody acted on (quiet 6d) — re-read its stated conditions before assuming it\'s still blocked',
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
  /**
   * SessionStart payload `source` field (groundnuty/macf#930). Defaults to
   * `'startup'` — matches the ORIGINAL hardcoded stdin this file always
   * sent, so every pre-#930 test case keeps exercising a genuine startup
   * unchanged. Pass `null` to omit the `source` key entirely (the
   * field-absent case); pass any other string (`'compact'`, `'resume'`,
   * `'clear'`, `'fork'`, `'wat'`) to exercise the fail-closed gate.
   */
  readonly source?: string | null;
  /** SessionStart payload `agent_id` field (groundnuty/macf#930 subagent no-op). Omitted by default. */
  readonly agentId?: string;
  /** SessionStart payload `agent_type` field (groundnuty/macf#930 subagent no-op). Omitted by default. */
  readonly agentType?: string;
  /**
   * Simulates the on-disk `.git` shape at the workspace root (groundnuty/macf#1042
   * linked-worktree no-op). Omitted (default) = no `.git` at all — the shape
   * every OTHER test in this file already exercises; per the gate's
   * honest-unknown floor this is indeterminate and falls through unchanged
   * (inject), so none of those tests needed to change for this fix.
   *   - `'worktree'`  → `.git` is a FILE containing a `gitdir: ...` pointer
   *                     (the real shape `git worktree add` produces) → suppress.
   *   - `'primary'`   → `.git` is a real DIRECTORY (the real shape a primary
   *                     checkout has) → no suppression (genuine permanent shape).
   *   - `'malformed'` → `.git` is a FILE but does NOT match `^gitdir: ` → falls
   *                     through unchanged (indeterminate, not a confirmed marker).
   */
  readonly gitDotShape?: 'worktree' | 'primary' | 'malformed';
}): RunResult {
  const workspace = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-ws-'));

  // groundnuty/macf#1042 linked-worktree no-op — see `gitDotShape`'s own doc
  // comment. Omitted entirely (the default) leaves NO `.git` at the
  // workspace root, matching every other test in this file.
  if (opts.gitDotShape === 'worktree') {
    writeFileSync(join(workspace, '.git'), 'gitdir: /some/other/repo/.git/worktrees/agent-x\n');
  } else if (opts.gitDotShape === 'primary') {
    mkdirSync(join(workspace, '.git'), { recursive: true });
  } else if (opts.gitDotShape === 'malformed') {
    writeFileSync(join(workspace, '.git'), 'not a gitdir pointer\n');
  }

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

  // groundnuty/macf#930: build the payload's `source` (default 'startup' —
  // preserves every pre-#930 call site unchanged) + optional agent_id /
  // agent_type. `source: null` omits the key entirely (field-absent case).
  const payload: Record<string, string> = { session_id: 'sess-x' };
  const sourceValue = opts.source === undefined ? 'startup' : opts.source;
  if (sourceValue !== null) payload['source'] = sourceValue;
  if (opts.agentId !== undefined) payload['agent_id'] = opts.agentId;
  if (opts.agentType !== undefined) payload['agent_type'] = opts.agentType;

  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
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

    it('a reporter-stall-only startup (macf#1170) prints the stall section but does NOT auto-submit — it is a closure decision to re-read, not work to pick up', () => {
      const r = runHook({
        pluginOutput: REPORTER_STALL_ONLY_OUTPUT,
        pluginOnelineOutput: '',
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('groundnuty/macf#999');
      expect(r.stdout).toContain('issue(s) you filed are open and quiet');
      expect(r.submitInvocation).toBeNull();
    });
  });

  describe('(b.5) trigger + subagent gate (groundnuty/macf#930) — genuine startup only, never a subagent-shaped payload', () => {
    // Decisive per the #930 fix: compact/resume/clear/fork must NOT inject,
    // and a genuine startup must be UNCHANGED (covered by every other
    // describe block in this file, none of which override `source` — they
    // all still send the default 'startup').
    for (const source of ['compact', 'resume', 'clear', 'fork']) {
      it(`source: '${source}' → does NOT inject (fails CLOSED, not the pre-#930 fire-on-everything behavior)`, () => {
        const r = runHook({
          pluginOutput: PENDING_OUTPUT,
          pluginOnelineOutput: '#1: fix the thing; #2: write the docs',
          env: { MACF_AGENT_ROLE: 'code-agent' },
          source,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.submitInvocation).toBeNull();
      });
    }

    it("an unrecognised source ('wat') → does NOT inject (fail-closed on ambiguity, not just the 4 known non-startup values)", () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'wat',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it('source field ABSENT entirely from the payload → does NOT inject (fail-closed, never assume startup)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: null,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it("source: 'startup' (the default every other test in this file sends) still injects — genuine startup is UNCHANGED", () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).not.toBeNull();
    });

    it('agent_id present (source still startup) → does NOT inject (subagent no-op, best-effort per the file header)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        agentId: 'sub-1',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it("agent_type present WITHOUT agent_id (source still startup) → STILL injects (agent_type alone is NOT the subagent signal)", () => {
      // Claude Code documents agent_type as present "when the session uses
      // --agent OR the hook fires inside a subagent" — two conditions, only
      // one of which is a subagent. agent_id is documented as present ONLY
      // for the subagent case. Gating on agent_type too would silently drop
      // the pickup prompt for a legitimate top-level `--agent`-launched
      // session (unreachable via claude.sh today — it never emits --agent —
      // but the gate must not regress requirement #3, "preserve genuine-
      // startup behavior exactly", if that ever changes). This is the
      // regression test for that false-positive.
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        agentType: 'general-purpose',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).not.toBeNull();
    });

    it('a subagent-shaped payload (source=startup + agent_id) on a compact ALSO does not inject (both gates independently fail closed)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'compact',
        agentId: 'sub-1',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });
  });

  describe('(b.6) linked-worktree no-op (groundnuty/macf#1042) — a worktree/background-worker session inherits its parent env verbatim, so `.git` shape (not MACF_*/CLAUDE_CODE_CHILD_SESSION/$TMUX, all empirically inherited) is the discriminator', () => {
    // DECISIVE PAIR (assert-the-wrong-path.md): a worker session that produces
    // empty stdout could mean "the new gate correctly fired" OR "the hook is
    // broken outright" — the two are indistinguishable from the worker
    // assertion alone. The permanent-shape test below rules out the second:
    // same setup, same PENDING_OUTPUT, only the `.git` shape differs, and it
    // DOES inject — proving the pipeline isn't globally broken and the empty
    // result in the worker case is specifically this gate, not a crash.
    it('WORKER (`.git` is a `gitdir:` pointer file — a real `git worktree add` shape) + pending work → does NOT inject, even though role/source/tmux all look like a genuine startup', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing; #2: write the docs',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        gitDotShape: 'worktree',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it('PERMANENT (`.git` is a real directory — a primary-checkout shape) + pending work → DOES inject (the decisive pair\'s other half — the pipeline is not globally broken)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing; #2: write the docs',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        gitDotShape: 'primary',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).not.toBeNull();
    });

    it('indeterminate: `.git` is a file but NOT a `gitdir:` pointer (malformed/unexpected shape) → falls through unchanged, still injects (honest-unknown floor: ambiguity resolves to inject, not skip)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        gitDotShape: 'malformed',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).not.toBeNull();
    });

    it('indeterminate: `.git` absent entirely (documented default every other test in this file uses) → falls through unchanged, still injects', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        // gitDotShape omitted — no .git at all.
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pending issue(s):');
      expect(r.submitInvocation).not.toBeNull();
    });

    it('WORKER shape + a role that would otherwise auto-nudge + a subagent-shaped payload too → still just exits 0, no double-fault', () => {
      // Belt-and-suspenders: the linked-worktree gate and the #930 agent_id
      // gate are independent checks (either alone suffices); confirm they
      // don't interact badly when both fire on the same payload.
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'code-agent' },
        source: 'startup',
        agentId: 'sub-1',
        gitDotShape: 'worktree',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.submitInvocation).toBeNull();
    });

    it('WORKER shape + role=auditor → still a full no-op (gates are independent, none conflict)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        env: { MACF_AGENT_ROLE: 'auditor' },
        source: 'startup',
        gitDotShape: 'worktree',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
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

    it('malformed / empty stdin → still exits 0 (semantic shift post-#930: fails closed with empty stdout, not just non-blocking)', () => {
      // Pre-#930 this only asserted non-blocking (status 0) — the payload was
      // drained/ignored, so malformed stdin was harmless by construction.
      // Post-#930 the payload IS parsed for `source`; malformed input can't
      // match "startup" (the sed extraction simply finds nothing), so this
      // now ALSO exercises the fail-closed path, not merely the fail-open
      // `trap`. Both assertions below hold for the same reason but are
      // conceptually distinct — pinning both so neither regresses silently.
      const workspace = mkdtempSync(join(tmpdir(), 'macf-startup-pickup-ws-'));
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: 'not json {{{',
        env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: workspace },
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0); // never blocks the session (fail-open on errors)
      expect(res.stdout).toBe(''); // and never injects on unparseable input (fail-closed on ambiguity)
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
    // groundnuty/macf#802 review: the FIRST shipped gate (PR #845) matched a
    // KNOWN blocking shape (`❯ N.` numbered menu) and submitted unless it
    // saw one — a blocklist. Follow-up review found real Claude Code (2.1.226,
    // byte-level binary inspection) has NO numbered-select renderer at all —
    // every select/confirm option renders as `❯` + a LABEL, never a digit —
    // so that blocklist was a likely production no-op for the exact prompt
    // it existed to catch. The gate below is INVERTED: submit ONLY when the
    // pane affirmatively shows the standing input box.
    //
    // SEP/READY_* are PINNED TO A LIVE `capture-pane -p -J` of real, running
    // Claude Code sessions on this fleet (not synthesized to match the
    // implementation) — the standing input box renders as a `─` separator,
    // a `❯`-prefixed line (blank idle / free text queued — both observed
    // live), then a closing `─` separator, identically whether idle or busy.
    //
    // BLOCKED_* are RECONSTRUCTED from the #802 issue thread's static-binary
    // evidence (a labelled confirm/select component, `❯` + label, never a
    // digit) — not a live capture of an actual ceremony dialog (triggering
    // one live on a shared multi-agent host was judged too invasive). Best
    // evidence available, not proven; see the script's own header for the
    // same caveat stated in the same terms.
    const SEP = '─'.repeat(40);
    const READY_IDLE = [SEP, '❯ ', SEP].join('\n');
    const READY_QUEUED = [SEP, '❯ pick up pending issues', SEP].join('\n');
    const BUSY_WORKING = ['* Imagining… (1m 5s · ↓ 8.4k tokens)', SEP, '❯ ', SEP].join('\n');
    const BLOCKED_DEV_CHANNELS = [
      'This project uses development channels.',
      '',
      '❯ I am using this for local development',
      '  Exit',
    ].join('\n');
    const BLOCKED_TRUST_FOLDER = [
      'Do you trust the files in this folder?',
      '',
      '❯ Yes, I trust this folder',
      '  No, continue without these permissions',
    ].join('\n');

    // Tiny overrides so these tests run in well under a second instead of
    // exercising the real ~90s default budget.
    const FAST_TIMING = {
      MACF_STARTUP_PICKUP_READY_TIMEOUT_SECS: '1',
      MACF_STARTUP_PICKUP_READY_INTERVAL_SECS: '0.1',
      MACF_STARTUP_PICKUP_VERIFY_DELAY_SECS: '0.1',
    };

    it('DECISIVE (1/2): pane never shows a ready input line for the whole window → skips the submit, warns loud instead of swallowing it', () => {
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
      expect(r.stdout).toContain('does not show a ready input line');
      expect(r.stdout).toContain('groundnuty/macf#802');
    });

    it('DECISIVE (2/2): pane is not-ready then becomes ready within the window → waits it out, then submits exactly once and observably lands', () => {
      // Pre-send poll sees two non-ready captures, then READY_IDLE (breaks
      // the poll, submits). Post-send capture is BUSY_WORKING — different
      // content from READY_IDLE (proves the pane visibly reacted) AND still
      // ready-shaped (the standing input box persists through busy state,
      // exactly as observed live) — genuine landing, not a coincidental diff.
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        tmuxFrames: [BLOCKED_DEV_CHANNELS, BLOCKED_DEV_CHANNELS, READY_IDLE, BUSY_WORKING],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(1);
      expect(r.submitInvocation).not.toBeNull();
      const lines = (r.submitInvocation ?? '').split('\n');
      expect(lines[1]).toBe('Pick up pending issues: #1: fix the thing');
      expect(r.stdout).not.toContain('WARNING');
    });

    it('a pane already showing queued/typed text in the input box also counts as ready (not just the blank-idle shape)', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        tmuxFrames: [READY_QUEUED, BUSY_WORKING],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(1);
      expect(r.stdout).not.toContain('WARNING');
    });

    it('HONEST-UNKNOWN: pane content stays static after the submit (never visibly reacts) → retries once, then states the outcome as unknown rather than declaring success', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        // Ready from the first capture — the pre-send check passes
        // immediately, but the post-send verify never sees a diff.
        tmuxFrames: [READY_IDLE],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(2); // one bounded retry, then give up
      expect(r.stdout).toContain('WARNING');
      expect(r.stdout).toContain('could not confirm the auto-submit landed');
      expect(r.stdout).toContain('groundnuty/macf#802');
    });

    it('HONEST-UNKNOWN: the pane is interrupted by a non-ready dialog right after the submit → not mistaken for success just because content differs', () => {
      const r = runHook({
        pluginOutput: PENDING_OUTPUT,
        pluginOnelineOutput: '#1: fix the thing',
        env: { MACF_AGENT_ROLE: 'code-agent', ...FAST_TIMING },
        // Pre-send check passes on READY_IDLE; the post-send capture lands
        // on a NEW dialog whose content differs from READY_IDLE — a raw
        // content-diff alone would misread this as "delivered".
        tmuxFrames: [READY_IDLE, BLOCKED_TRUST_FOLDER, BLOCKED_TRUST_FOLDER],
      });
      expect(r.status).toBe(0);
      expect(r.submitCallCount).toBe(2);
      expect(r.stdout).toContain('WARNING');
      expect(r.stdout).toContain('could not confirm the auto-submit landed');
    });

    it('UNOBSERVABLE (trichotomy row 3): no tmux reachable at all (capture always fails) → fails OPEN, immediate unconditional submit (pre-#802 behavior preserved)', () => {
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
