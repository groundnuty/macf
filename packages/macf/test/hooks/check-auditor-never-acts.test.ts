/**
 * Tests for `scripts/check-auditor-never-acts.sh` — the PreToolUse hook that
 * structurally enforces the auditor's "never-acts" boundary (DR-026 F1,
 * groundnuty/macf#499). When the active identity is the auditor
 * (`MACF_AGENT_ROLE=auditor`), the hook BLOCKS state-mutating `gh` ops
 * (`gh pr merge` / `gh issue close` / `gh pr close`) while ALLOWING the propose
 * verbs (`gh issue/pr create|comment`) and all reads. For every non-auditor
 * identity the hook is inert (exit 0 before any parsing).
 *
 * Why structural and not permission-based: a GitHub App's `pull_requests:write`
 * permission grants merge+close TOGETHER with open-PR; there is no
 * "open-a-PR-but-not-merge" scope to express the auditor's write-proposals-only
 * boundary, so it must be enforced at tool-call time. Sister to the
 * #140 / #244+#272 / #270 / #431 / #489 hooks.
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
 * (stderr → Claude as the error). Override: MACF_SKIP_AUDITOR_ACT_CHECK=1.
 * Unlike check-lgtm-gate.sh / check-gh-attribution.sh this hook makes NO `gh`
 * calls — the decision is purely role + command-shape — so the tests don't
 * need a stub-gh shim.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-auditor-never-acts.sh');

function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
  /** When true, send raw (non-JSON) input to exercise the fail-open path. */
  readonly rawInput?: string;
}): ReturnType<typeof spawnSync> {
  const input =
    opts.rawInput !== undefined
      ? opts.rawInput
      : JSON.stringify({
          session_id: 'test',
          tool_name: 'Bash',
          tool_input: { command: opts.command },
        });
  // Clean env so the parent process's MACF_AGENT_ROLE / overrides don't leak
  // in; PATH preserved so bash/jq resolve.
  const cleanEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], {
    input,
    env: cleanEnv,
    encoding: 'utf-8',
  });
}

const AUDITOR = { MACF_AGENT_ROLE: 'auditor' };

describe('check-auditor-never-acts.sh (hook)', () => {
  describe('inert for non-auditor identities (load-bearing gate)', () => {
    it('a) allows `gh pr merge` when MACF_AGENT_ROLE is unset', () => {
      const r = runHook({ command: 'gh pr merge 123 --squash' });
      expect(r.status).toBe(0);
    });

    it('a2) allows `gh pr merge` for code-agent (non-auditor role)', () => {
      const r = runHook({
        command: 'gh pr merge 123 --squash',
        env: { MACF_AGENT_ROLE: 'code-agent' },
      });
      expect(r.status).toBe(0);
    });

    it('a3) allows `gh issue close` for science-agent (non-auditor role)', () => {
      const r = runHook({
        command: 'gh issue close 5 --reason completed',
        env: { MACF_AGENT_ROLE: 'science-agent' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('auditor — blocks state-mutating acting verbs', () => {
    it('b) blocks `gh pr merge` under auditor', () => {
      const r = runHook({ command: 'gh pr merge 123 --squash', env: AUDITOR });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/auditor-never-acts/);
      expect(r.stderr).toMatch(/gh pr merge/);
      expect(r.stderr).toMatch(/MACF_SKIP_AUDITOR_ACT_CHECK/);
    });

    it('c) blocks `gh issue close` under auditor', () => {
      const r = runHook({
        command: 'gh issue close 5 --reason completed',
        env: AUDITOR,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/gh issue close/);
    });

    it('d) blocks `gh pr close` under auditor', () => {
      const r = runHook({ command: 'gh pr close 9', env: AUDITOR });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/gh pr close/);
    });

    it('block message cites DR-026 + the never-acts boundary', () => {
      const r = runHook({ command: 'gh pr merge 7 --squash', env: AUDITOR });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('DR-026');
      expect(r.stderr).toContain('never');
    });

    it('override guidance is honest: launch-time/operator + relaunch, not an in-session export fix', () => {
      // groundnuty/macf#822 Part 1.
      const r = runHook({ command: 'gh pr merge 8 --squash', env: AUDITOR });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/launch-time\s*\/\s*operator/);
      expect(r.stderr).toMatch(/relaunch/);
      expect(r.stderr).toMatch(/does\s+NOT\s+reach\s+it/);
      expect(r.stderr).not.toMatch(/^\s*export MACF_SKIP_AUDITOR_ACT_CHECK=1\s*$/m);
    });
  });

  describe('auditor — allows propose verbs + reads (write-proposals-only)', () => {
    it('e) allows `gh issue create` under auditor (propose)', () => {
      const r = runHook({
        command: 'gh issue create --title x --body y --label code-agent',
        env: AUDITOR,
      });
      expect(r.status).toBe(0);
    });

    it('e2) allows `gh pr create` under auditor (propose)', () => {
      const r = runHook({
        command: 'gh pr create --title x --body "Refs #1"',
        env: AUDITOR,
      });
      expect(r.status).toBe(0);
    });

    it('f) allows `gh pr comment` under auditor (propose)', () => {
      const r = runHook({
        command: 'gh pr comment 5 --body "@macf-code-agent[bot] please review"',
        env: AUDITOR,
      });
      expect(r.status).toBe(0);
    });

    it('f2) allows `gh issue comment` under auditor (propose)', () => {
      const r = runHook({
        command: 'gh issue comment 5 --body "@macf-science-agent[bot] proposal"',
        env: AUDITOR,
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr view` under auditor (read)', () => {
      const r = runHook({ command: 'gh pr view 5 --json state', env: AUDITOR });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue list` under auditor (read)', () => {
      const r = runHook({ command: 'gh issue list --label auditor', env: AUDITOR });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr merge-base` under auditor (NOT `gh pr merge` — exact-subcommand)', () => {
      const r = runHook({ command: 'gh pr merge-base origin/main', env: AUDITOR });
      expect(r.status).toBe(0);
    });
  });

  describe('g) non-gh commands pass through under auditor', () => {
    it('allows a non-gh command (make) under auditor', () => {
      const r = runHook({ command: 'make -f dev.mk check', env: AUDITOR });
      expect(r.status).toBe(0);
    });

    it('allows `git push` under auditor (not a gh acting verb)', () => {
      const r = runHook({ command: 'git push -u origin HEAD', env: AUDITOR });
      expect(r.status).toBe(0);
    });
  });

  describe('h) wrapper-aware matching (bypass prevention) under auditor', () => {
    it('blocks `sudo gh pr merge` under auditor', () => {
      const r = runHook({ command: 'sudo gh pr merge 7 --squash', env: AUDITOR });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "gh pr merge ..."` under auditor', () => {
      const r = runHook({
        command: "bash -c 'gh pr merge 8 --squash'",
        env: AUDITOR,
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh issue close` under auditor', () => {
      const r = runHook({
        command: 'env FOO=bar gh issue close 3',
        env: AUDITOR,
      });
      expect(r.status).toBe(2);
    });

    it('blocks chained `cmd && gh pr close` under auditor', () => {
      const r = runHook({
        command: 'echo ok && gh pr close 9',
        env: AUDITOR,
      });
      expect(r.status).toBe(2);
    });

    it('blocks `GH_TOKEN=ghs_x gh pr merge` under auditor (inline VAR= form)', () => {
      const r = runHook({
        command: 'GH_TOKEN=ghs_x gh pr merge 11 --squash',
        env: AUDITOR,
      });
      expect(r.status).toBe(2);
    });
  });

  describe('i) override path — MACF_SKIP_AUDITOR_ACT_CHECK=1 bypasses', () => {
    it('allows `gh pr merge` under auditor when MACF_SKIP_AUDITOR_ACT_CHECK=1', () => {
      const r = runHook({
        command: 'gh pr merge 1 --squash',
        env: { ...AUDITOR, MACF_SKIP_AUDITOR_ACT_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });

    it('does NOT bypass on MACF_SKIP_AUDITOR_ACT_CHECK=0 (only "1" overrides)', () => {
      const r = runHook({
        command: 'gh pr merge 2 --squash',
        env: { ...AUDITOR, MACF_SKIP_AUDITOR_ACT_CHECK: '0' },
      });
      expect(r.status).toBe(2);
    });

    it('does NOT bypass on MACF_SKIP_AUDITOR_ACT_CHECK="" (empty string)', () => {
      const r = runHook({
        command: 'gh pr merge 3 --squash',
        env: { ...AUDITOR, MACF_SKIP_AUDITOR_ACT_CHECK: '' },
      });
      expect(r.status).toBe(2);
    });
  });

  describe('j) defense-in-depth — fail-open on bad input', () => {
    it('falls through to allow on parse error (non-JSON stdin) under auditor', () => {
      const r = runHook({ command: '', env: AUDITOR, rawInput: 'not-json-at-all' });
      expect(r.status).toBe(0);
    });

    it('falls through to allow on empty stdin under auditor', () => {
      const r = runHook({ command: '', env: AUDITOR, rawInput: '' });
      expect(r.status).toBe(0);
    });

    it('falls through to allow when command is absent in the JSON under auditor', () => {
      const r = runHook({
        command: '',
        env: AUDITOR,
        rawInput: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      });
      expect(r.status).toBe(0);
    });
  });
});
