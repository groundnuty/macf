/**
 * Tests for `scripts/check-mention-routing.sh` — the PreToolUse hook
 * that structurally blocks `gh (issue|pr) comment` invocations whose
 * `--body` content contains raw `@<bot>[bot]` mentions in describing
 * contexts (mid-line, not backticked). Implements
 * `plugin/rules/mention-routing-hygiene.md` §5 enforcement.
 *
 * Background (groundnuty/macf#244 + #272): science-agent recorded 5+
 * routing-hygiene class breaches in 2 days (`observation_self_canonical_
 * rule_breaches.md` → public research at `macf-science-agent:research/
 * 2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md`).
 * Codification alone produced ~80% catch rate; structural defense is
 * load-bearing for the remaining 20%.
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 =
 * block (stderr → Claude as the error). Override: MACF_SKIP_MENTION_CHECK=1.
 *
 * Heuristic per design synthesis:
 *   - Backticked `@<bot>[bot]` → allowed (describing form §5)
 *   - Line-start `@<bot>[bot]` after optional whitespace/blockquote/
 *     list-marker → allowed (addressing form §3)
 *   - Else → BLOCK
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-mention-routing.sh');

/**
 * Spawn the hook with a JSON stdin payload + env overrides. Mirrors the
 * shape of check-gh-token.test.ts so future hook authors recognize it.
 */
function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  // Preserve PATH so bash/jq/awk resolve. Scrub MACF_* unless explicitly
  // set in opts.env so ambient overrides from the test runner don't leak.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: cleanEnv,
    encoding: 'utf-8',
  });
}

describe('check-mention-routing.sh (hook)', () => {
  describe('positive path — non-comment commands pass through', () => {
    it('allows `gh issue view` (no body to validate)', () => {
      const r = runHook({ command: 'gh issue view 272' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue list` (no body to validate)', () => {
      const r = runHook({ command: 'gh issue list --label code-agent' });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr view` (no body to validate)', () => {
      const r = runHook({ command: 'gh pr view 244' });
      expect(r.status).toBe(0);
    });

    it('allows `git push` (different command axis)', () => {
      const r = runHook({ command: 'git push -u origin main' });
      expect(r.status).toBe(0);
    });

    it('allows non-gh commands entirely', () => {
      const r = runHook({ command: 'make -f dev.mk check' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue close` without --comment (no body posted)', () => {
      const r = runHook({ command: 'gh issue close 272 --reason completed' });
      expect(r.status).toBe(0);
    });
  });

  describe('positive path — addressing form is allowed', () => {
    it('allows line-start `@<bot>[bot]` in heredoc body (canonical addressing)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n@macf-science-agent[bot] PR ready for review.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows list-item-prefixed `@<bot>[bot]` (bullet-as-addressing)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n- @macf-science-agent[bot] please review\n- @macf-code-agent[bot] please implement\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows blockquoted line-start `@<bot>[bot]`', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n> @macf-science-agent[bot] (quoted from earlier thread, raw OK)\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('positive path — backticked describing form is allowed', () => {
    it('allows backticked `@<bot>[bot]` mid-line (canonical describing §5)', () => {
      // Body has an addressing line + a backticked describing line. Check B
      // (describing-leak) doesn't fire on the backticked form per §5; Check A
      // (must-have-mention; macf#244) is satisfied by the addressing line.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n@macf-recipient-agent[bot] note:\nThe `@macf-tester-1-agent[bot]` response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows backticked `@<bot>[bot]` mixed with addressing in same body', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nObservation: the `@macf-tester-1-agent[bot]` reply quoted rule §1.\n\n@macf-science-agent[bot] confirming this matches your read?\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('negative path — describing-context leak blocks', () => {
    it('blocks mid-line raw `@<bot>[bot]` in describing prose', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/mention-routing-hygiene/);
      expect(r.stderr).toMatch(/MACF_SKIP_MENTION_CHECK/);
    });

    it('Check B override guidance is honest: launch-time/operator + relaunch, not an in-session export fix', () => {
      // groundnuty/macf#822 Part 1.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/launch-time\s*\/\s*operator/);
      expect(r.stderr).toMatch(/relaunch/);
      expect(r.stderr).toMatch(/does\s+NOT\s+reach\s+it/);
      expect(r.stderr).not.toMatch(/^\s*export MACF_SKIP_MENTION_CHECK=1\s*$/m);
    });

    it('blocks mid-line raw `@<bot>[bot]` after a sentence-starter', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nObserved that @macf-code-agent[bot] posted handoff at 12:00Z.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `gh pr comment` describing-leak (same shape, pr instead of issue)', () => {
      const r = runHook({
        command:
          'gh pr comment 99 --body "$(cat <<EOF\nThe @macf-tester-2-agent[bot] PR was reviewed clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('wrapper-aware matching (bypass prevention)', () => {
    it('blocks `sudo gh issue comment` with describing-leak', () => {
      const r = runHook({
        command:
          'sudo gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "gh issue comment ..."` with describing-leak', () => {
      const r = runHook({
        command:
          'bash -c \'gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."\'',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh issue comment` with describing-leak', () => {
      const r = runHook({
        command:
          'env FOO=bar gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('override path — MACF_SKIP_MENTION_CHECK=1 bypasses', () => {
    it('allows describing-leak when MACF_SKIP_MENTION_CHECK=1', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        env: { MACF_SKIP_MENTION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });

    it('does NOT bypass on MACF_SKIP_MENTION_CHECK=0 (only "1" overrides)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        env: { MACF_SKIP_MENTION_CHECK: '0' },
      });
      expect(r.status).toBe(2);
    });
  });

  describe('--body-file path (groundnuty/macf#944 three-branch resolution)', () => {
    // Branch 1: file is readable at hook-fire time (two-call
    // write-then-post pattern — a prior tool call already wrote it).
    describe('branch 1 — readable file', () => {
      let dir: string;

      afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
      });

      it('BLOCKS on a readable file with zero mentions (the #944 regression)', () => {
        dir = mkdtempSync(join(tmpdir(), 'macf944-'));
        const file = join(dir, 'body.md');
        writeFileSync(file, 'Just a status update, no mentions.\n');
        const r = runHook({
          command: `gh issue comment 123 --body-file ${file}`,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('zero');
        expect(r.stderr).toContain('routing-active');
      });

      it('allows a readable file with a routing-active addressing mention', () => {
        dir = mkdtempSync(join(tmpdir(), 'macf944-'));
        const file = join(dir, 'body.md');
        writeFileSync(file, '@macf-science-agent[bot] PR ready for review.\n');
        const r = runHook({
          command: `gh issue comment 123 --body-file ${file}`,
        });
        expect(r.status).toBe(0);
      });

      it('BLOCKS a readable file carrying a describing-context leak (Check B)', () => {
        dir = mkdtempSync(join(tmpdir(), 'macf944-'));
        const file = join(dir, 'body.md');
        writeFileSync(file, 'The @macf-tester-1-agent[bot] response was clean.\n');
        const r = runHook({
          command: `gh issue comment 123 --body-file ${file}`,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('resolves --body-file=path (equals form) against a readable file', () => {
        dir = mkdtempSync(join(tmpdir(), 'macf944-'));
        const file = join(dir, 'body.md');
        writeFileSync(file, 'no mention here\n');
        const r = runHook({
          command: `gh issue comment 123 --body-file=${file}`,
        });
        expect(r.status).toBe(2); // zero mentions -> Check A blocks
      });
    });

    // Branch 2: single-call write-and-post — `cat > f <<'EOF' ... EOF`
    // followed by `gh ... --body-file f` in ONE Bash command, so the file
    // doesn't exist yet when PreToolUse fires. The hook must extract the
    // heredoc body TEXT (never executes it) and lint that.
    describe('branch 2 — literal heredoc targeting the --body-file path', () => {
      it('BLOCKS a single-call heredoc body with zero mentions', () => {
        const r = runHook({
          command:
            "cat > /tmp/macf944-single.md <<'EOF'\nJust a status update, no mentions.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-single.md",
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('zero');
        expect(r.stderr).toContain('routing-active');
      });

      it('allows a single-call heredoc body with a routing-active mention', () => {
        const r = runHook({
          command:
            "cat > /tmp/macf944-single2.md <<'EOF'\n@macf-science-agent[bot] PR ready for review.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-single2.md",
        });
        expect(r.status).toBe(0);
      });

      it('BLOCKS a single-call heredoc body carrying a describing-context leak', () => {
        const r = runHook({
          command:
            "cat > /tmp/macf944-single3.md <<'EOF'\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-single3.md",
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('the false-pass trap: two heredocs, only the NON-target one carries a mention → must NOT pass', () => {
        // The real --body-file target (macf944-real.md) has zero
        // mentions. An unrelated heredoc earlier in the same command
        // (macf944-other.md, never referenced by --body-file) DOES carry
        // one. An extractor that isn't precise about WHICH heredoc it
        // slices would report "mention present" from the wrong body —
        // this is exactly the trap groundnuty/macf#944 calls out.
        const r = runHook({
          command:
            "cat > /tmp/macf944-other.md <<'EOF'\n@macf-science-agent[bot] unrelated mention in a different file\nEOF\ncat > /tmp/macf944-real.md <<'EOF'\nJust a status update, no mentions here.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-real.md",
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('zero');
        expect(r.stderr).toContain('routing-active');
      });

      it('the false-pass trap holds in reverse: target heredoc has the mention, decoy does not → allows', () => {
        const r = runHook({
          command:
            "cat > /tmp/macf944-decoy.md <<'EOF'\nJust unrelated decoy content.\nEOF\ncat > /tmp/macf944-target.md <<'EOF'\n@macf-science-agent[bot] please review.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-target.md",
        });
        expect(r.status).toBe(0);
      });
    });

    // Branch 3: neither a readable file nor an unambiguous literal
    // heredoc — Check A degrades to a non-blocking warning; Check B keeps
    // the pre-#944 silent allow (nothing lintable).
    describe('branch 3 — unresolvable content (non-blocking warn, not a block)', () => {
      it('an UNQUOTED heredoc delimiter (<<EOF, body may expand) falls to branch 3', () => {
        const r = runHook({
          command:
            'cat > /tmp/macf944-unquoted.md <<EOF\nJust a status update, no mentions.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-unquoted.md',
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/WARNING/);
        expect(r.stderr).not.toMatch(/^BLOCKED/m);
      });

      it('an unresolvable path with no heredoc at all falls to branch 3 (warns, does not block)', () => {
        const r = runHook({
          command: 'gh issue comment 123 --body-file /tmp/macf944-does-not-exist-at-all.md',
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/WARNING/);
        expect(r.stderr).toContain('--body-file');
      });

      it('the branch-3 warning is suppressed for close subcommands (Check A never applies there)', () => {
        const r = runHook({
          command: 'gh issue close 123 --comment "status" --body-file /tmp/macf944-does-not-exist-2.md',
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toBe('');
      });
    });

    describe('MACF_SKIP_MENTION_CHECK=1 overrides branch-1 and branch-2 blocks', () => {
      let dir: string;

      afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
      });

      it('overrides a branch-1 zero-mention block', () => {
        dir = mkdtempSync(join(tmpdir(), 'macf944-'));
        const file = join(dir, 'body.md');
        writeFileSync(file, 'Just a status update, no mentions.\n');
        const r = runHook({
          command: `gh issue comment 123 --body-file ${file}`,
          env: { MACF_SKIP_MENTION_CHECK: '1' },
        });
        expect(r.status).toBe(0);
      });

      it('overrides a branch-2 zero-mention block', () => {
        const r = runHook({
          command:
            "cat > /tmp/macf944-skip.md <<'EOF'\nJust a status update, no mentions.\nEOF\ngh issue comment 123 --body-file /tmp/macf944-skip.md",
          env: { MACF_SKIP_MENTION_CHECK: '1' },
        });
        expect(r.status).toBe(0);
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty body (no @ mentions at all)', () => {
      // Switched to `gh issue close --comment` form — bypasses Check A
      // (must-have-mention; macf#244) which would otherwise BLOCK on a
      // body with no @<bot>[bot] mentions. The intent here is "hook
      // doesn't crash on degenerate inputs"; close subcommand exercises
      // the same parser without the Check A gate.
      const r = runHook({
        command: 'gh issue close 123 --comment "Just a status update, no mentions."',
      });
      expect(r.status).toBe(0);
    });

    it('handles body with no agent handles (only non-bot @ refs)', () => {
      // Same close-bypass rationale as above. Tests that the regex
      // doesn't false-positive-match @<word> without [bot] suffix.
      const r = runHook({
        command:
          'gh issue close 123 --comment "Mention @somebody (not a bot pattern) in passing."',
      });
      expect(r.status).toBe(0);
    });

    it('does not match similar-looking patterns without [bot] suffix', () => {
      // Close-bypass rationale per above — Check B's regex still
      // exercised; "no [bot] suffix → no match → no BLOCK" verified.
      const r = runHook({
        command: 'gh issue close 123 --comment "Reference @macf-code-agent without bot suffix."',
      });
      expect(r.status).toBe(0);
    });

    it('handles digit-suffixed handles (e.g. macf-tester-1-agent)', () => {
      // Verifies the regex character class includes digits — earlier
      // iteration of the canonical rule's regex (`[a-z-]+`) missed this.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('reports which line offended in stderr (operator orientation)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nLine one is fine.\nLine two has @macf-bot-agent[bot] mid-line leak.\nLine three is fine.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      // The hook prints `<line_no>: <line_text>` for each offending line.
      // Don't assert exact line number (depends on shell heredoc parsing),
      // but the offending line text must appear.
      expect(r.stderr).toMatch(/has @macf-bot-agent\[bot\] mid-line leak/);
    });

    it('falls through to allow on parse error (defense-in-depth)', () => {
      // A broken or non-JSON payload should not brick the harness — the
      // hook must fail open. Same convention as check-gh-token.sh.
      const r = spawnSync('bash', [HOOK_SCRIPT], {
        input: 'not-json-at-all',
        env: { PATH: process.env['PATH'] ?? '' },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('broadened HANDLE_PATTERN — fleet-agnostic (macf#276)', () => {
    it('blocks describing-context CV-fleet handle (`@cv-architect[bot]`)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @cv-architect[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('blocks describing-context non-prefixed CV handle (`@academic-resume-author[bot]`)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nObserved @academic-resume-author[bot] in the loop.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('blocks describing-context third-party bot (`@dependabot[bot]`)', () => {
      // Third-party bots don't fire MACF routing, but blocking style is
      // consistent with the discipline. Operators can use
      // MACF_SKIP_MENTION_CHECK=1 for the rare legitimate describing case.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @dependabot[bot] update was reverted.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('blocks describing-context `@github-actions[bot]`', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @github-actions[bot] workflow ran twice.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('allows backticked CV-fleet handle in describing context', () => {
      // Close-bypass for Check A; Check B's backtick-suppression on
      // CV-fleet handles is the real assertion (broadened HANDLE_PATTERN
      // matches @cv-architect[bot] but backticks suppress the BLOCK).
      const r = runHook({
        command:
          'gh issue close 123 --comment "The `@cv-architect[bot]` response was clean."',
      });
      expect(r.status).toBe(0);
    });

    it('allows line-start CV-fleet handle in addressing context', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n@cv-architect[bot] please review the draft.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows backticked third-party bot handle (legitimate describing reference)', () => {
      // Close-bypass for Check A; Check B verified — third-party-bot
      // backtick-suppression behaves the same as macf-fleet.
      const r = runHook({
        command:
          'gh issue close 123 --comment "Note that the `@dependabot[bot]` MR was reverted."',
      });
      expect(r.status).toBe(0);
    });

    it('does not match handle starting with digit (invalid GitHub handle shape)', () => {
      // First-char letter requirement excludes leading-digit forms.
      // Close-bypass per above (Check B regex still exercised).
      const r = runHook({
        command: 'gh issue close 123 --comment "Reference @1bot[bot] in passing."',
      });
      expect(r.status).toBe(0);
    });

    it('does not match handle starting with underscore or hyphen', () => {
      // Same first-char letter requirement; close-bypass for Check A.
      const r1 = runHook({
        command: 'gh issue close 123 --comment "Reference @_priv[bot] in passing."',
      });
      const r2 = runHook({
        command: 'gh issue close 123 --comment "Reference @-leader[bot] in passing."',
      });
      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
    });

    it('does not match `@[bot]` with no handle body', () => {
      // First-char letter requirement excludes the empty-handle form.
      // Close-bypass per above.
      const r = runHook({
        command: 'gh issue close 123 --comment "Reference @[bot] in passing."',
      });
      expect(r.status).toBe(0);
    });

    it('MACF_SKIP_MENTION_CHECK=1 still bypasses third-party bot blocks', () => {
      // Override path covers the rare legitimate describing-context use
      // of third-party bot handles.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @dependabot[bot] update was reverted.\nEOF\n)"',
        env: { MACF_SKIP_MENTION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('Check A — must-have-mention (macf#244)', () => {
    it('blocks `gh issue comment` with body containing zero @mentions', () => {
      // The canonical Check A failure mode: peer agent never sees the
      // comment because routing depends on @mention presence.
      const r = runHook({
        command: 'gh issue comment 123 --body "Just a status update."',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('zero');
      expect(r.stderr).toContain('routing-active');
    });

    it('blocks `gh pr comment` with body containing zero @mentions (sister case)', () => {
      const r = runHook({
        command: 'gh pr comment 123 --body "Status pushed."',
      });
      expect(r.status).toBe(2);
    });

    it('blocks body with only backticked mentions (routing-suppressed)', () => {
      // Backticked mentions are describing-form (§5) and do NOT fire
      // routing. A body containing only backticked handles still has
      // zero routing-active mentions → Check A blocks.
      const r = runHook({
        command:
          'gh issue comment 123 --body "Per the `@macf-code-agent[bot]` notes, status is X"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('routing-active');
    });

    it('allows body with line-start addressing mention (routing-active)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n@macf-code-agent[bot] LGTM, you can merge.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows mixed body: backticked describing + line-start addressing', () => {
      // Realistic comment shape — references one peer in describing-form
      // and addresses another. Routing-active count == 1 → Check A passes.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nPer `@macf-code-agent[bot]` notes, status is good.\n@macf-science-agent[bot] please confirm.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('Check B (describing-leak) takes precedence over Check A (no addressing)', () => {
      // If a body has only a mid-line raw mention (Check B BLOCK trigger),
      // that mention is also routing-active (Check A passes — count > 0).
      // The describing-leak BLOCK message surfaces, not the no-addressing one.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-code-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      // The Check B message mentions describing-context leak; Check A's
      // distinctive phrase ("zero ... mentions") should NOT appear.
      expect(r.stderr).toContain('describing-context');
      expect(r.stderr).not.toContain('zero');
    });

    it('MACF_SKIP_MENTION_CHECK=1 bypasses Check A (legitimate no-recipient cases)', () => {
      const r = runHook({
        command: 'gh issue comment 123 --body "Just a status update."',
        env: { MACF_SKIP_MENTION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });

    it('block message cites coordination.md §Communication 2', () => {
      const r = runHook({
        command: 'gh issue comment 123 --body "no mention here"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('coordination.md');
      expect(r.stderr).toContain('Communication 2');
    });

    it('block message includes example fix + override hint', () => {
      const r = runHook({
        command: 'gh issue comment 123 --body "no mention here"',
      });
      expect(r.stderr).toContain('@<recipient-handle>[bot]');
      expect(r.stderr).toContain('MACF_SKIP_MENTION_CHECK=1');
    });

    it('Check A override guidance is honest: launch-time/operator + relaunch, not an in-session export fix', () => {
      // groundnuty/macf#822 Part 1.
      const r = runHook({
        command: 'gh issue comment 123 --body "no mention here"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/launch-time\s*\/\s*operator/);
      expect(r.stderr).toMatch(/relaunch/);
      expect(r.stderr).toMatch(/does\s+NOT\s+reach\s+it/);
      expect(r.stderr).not.toMatch(/^\s*export MACF_SKIP_MENTION_CHECK=1\s*$/m);
    });
  });

  describe('Check A — close-subcommand bypass (self-close pattern)', () => {
    it('allows `gh issue close --comment` without @mention (canonical self-close)', () => {
      // Per coordination.md §Issue Lifecycle 1 case 2: self-close
      // verification comments are reporter-internal, no recipient. The
      // close action itself is the routing-end signal; no addressed
      // mention required. Check A bypasses the close subcommand.
      const r = runHook({
        command:
          'gh issue close 123 --reason completed --comment "Verified on main after PR #M merged. Closing as reporter."',
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr close --comment` without @mention', () => {
      const r = runHook({
        command: 'gh pr close 123 --comment "Superseded by PR #N."',
      });
      expect(r.status).toBe(0);
    });

    it('still blocks `gh issue close --comment` with describing-leak (Check B applies)', () => {
      // Check B leak prevention is independent of recipient semantics —
      // a describing-leak in close --comment still fires false-positive
      // routing on the leaked handle.
      const r = runHook({
        command:
          'gh issue close 123 --comment "$(cat <<EOF\nThe @macf-tester-1-agent[bot] sweep was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('describing-context');
    });

    it('allows `gh issue close --comment` with both describing-leak-suppressed (backticked) and no addressing', () => {
      // close --comment with backticked describing reference + no
      // addressing → Check A bypassed (close subcommand) + Check B not
      // triggered (backticks suppress) → ALLOW.
      const r = runHook({
        command:
          'gh issue close 123 --comment "Verified `@macf-tester-1-agent[bot]` data; closing."',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('create-subcommand coverage — declared, not inferred (groundnuty/macf#1091)', () => {
    // Registry fixture: this repo's routing-label registry as `macf
    // repo-init` actually writes it (`.github/agent-config.json`'s
    // `.agents` keys). code-agent is the "self" identity throughout this
    // describe block via MACF_ROUTING_LABEL; science-agent is "a peer".
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'macf1091-'));
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(
        join(dir, '.github', 'agent-config.json'),
        JSON.stringify({ agents: { 'code-agent': {}, 'science-agent': {} } }),
      );
    });

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function runCreate(command: string, extraEnv: Record<string, string | undefined> = {}): ReturnType<typeof runHook> {
      return runHook({
        command,
        env: { CLAUDE_PROJECT_DIR: dir, MACF_ROUTING_LABEL: 'code-agent', ...extraEnv },
      });
    }

    describe('the four cases', () => {
      it('case 1 — `backlog` label, no mention → ALLOWED (declared: nobody\'s queue)', () => {
        const r = runCreate('gh issue create --title "x" --label backlog --body "no mention here"');
        expect(r.status).toBe(0);
      });

      it('the backlog label is what makes the difference — same body, label removed → BLOCKED', () => {
        // Decisive pairing (assert-the-wrong-path.md): proves the ALLOW
        // above is because the hook recognized the `backlog` label, not
        // because `create` silently passes through unguarded. Same body,
        // same everything, only the label is gone.
        const r = runCreate('gh issue create --title "x" --body "no mention here"');
        expect(r.status).toBe(2);
      });

      it('case 2 — assignee label CONFIRMED naming another agent, no mention → ALLOWED', () => {
        const r = runCreate('gh issue create --title "x" --label science-agent --body "no mention here"');
        expect(r.status).toBe(0);
      });

      it('case 3 — assignee label CONFIRMED naming the acting agent itself, no mention → BLOCKED (decisive)', () => {
        // The failure this hook exists to catch: route-by-label "delivers"
        // a self-labeled create to its own author — a no-op — and nothing
        // else points at anyone who needs to see it.
        const r = runCreate('gh issue create --title "x" --label code-agent --body "no mention here"');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('labeled for you');
        expect(r.stderr).toContain('backlog');
      });

      it('same label value, different acting identity → the SAME label that blocked case 3 now ALLOWS', () => {
        // Decisive pairing for case 2 vs. case 3: identical command, only
        // MACF_ROUTING_LABEL differs. Proves the self/peer distinction is
        // real discrimination, not a hardcoded verdict on the label name.
        const r = runCreate('gh issue create --title "x" --label code-agent --body "no mention here"', {
          MACF_ROUTING_LABEL: 'science-agent',
        });
        expect(r.status).toBe(0);
      });

      it('case 4 — no labels at all, no mention → BLOCKED, message names all three remedies', () => {
        const r = runCreate('gh issue create --title "x" --body "no mention here"');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('no assignee label');
        expect(r.stderr).toContain('assignee label');
        expect(r.stderr).toMatch(/mention/);
        expect(r.stderr).toContain('backlog');
      });

      it('case 4 — an unrecognized label (not backlog, not in the registry) → BLOCKED same as no labels', () => {
        // A label like `docs` doesn't route anywhere — it must not be
        // treated as evidence of a confirmed peer-routing decision.
        const r = runCreate('gh issue create --title "x" --label docs --body "no mention here"');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('no assignee label');
      });

      it('case 4 — assignee label present but self-identity unknown (MACF_ROUTING_LABEL unset) → BLOCKED', () => {
        // Can't confirm self vs. peer → ambiguous → blocks, per the
        // operator's ruling that uncertainty defaults to BLOCK not ALLOW.
        const r = runCreate('gh issue create --title "x" --label science-agent --body "no mention here"', {
          MACF_ROUTING_LABEL: undefined,
        });
        expect(r.status).toBe(2);
      });

      it('a mention satisfies Check A even on a self-labeled create (case 3 escape via mention, not backlog)', () => {
        const r = runCreate(
          'gh issue create --title "x" --label code-agent --body "$(cat <<EOF\n@macf-science-agent[bot] please advise\nEOF\n)"',
        );
        expect(r.status).toBe(0);
      });
    });

    describe('Check B (must-not-leak) is unconditional — not gated on routing intent', () => {
      it('fires on a describing-leak in a backlog-labeled create', () => {
        const r = runCreate(
          'gh issue create --title "x" --label backlog --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('fires on a describing-leak in a peer-labeled create', () => {
        const r = runCreate(
          'gh issue create --title "x" --label science-agent --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('fires on a describing-leak in a self-labeled create', () => {
        const r = runCreate(
          'gh issue create --title "x" --label code-agent --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('fires on a describing-leak in a create with no labels at all', () => {
        const r = runCreate(
          'gh issue create --title "x" --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });
    });

    describe('`gh pr create` — sister subcommand, same shape', () => {
      it('case 3 sister-case: self-labeled `gh pr create`, no mention → BLOCKED', () => {
        const r = runCreate('gh pr create --title "x" --label code-agent --body "Refs #1"');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('labeled for you');
      });

      it('the canonical unlabeled `gh pr create --body "Refs #N"` shape (agent-identity.md) stays ALLOWED', () => {
        // Case 4 ("no confirmed routing signal → BLOCK") is scoped to
        // `gh issue create` only — it does NOT extend to `gh pr create`.
        // A PR isn't ambiguous the way an issue is: it has no backlog
        // concept, and its real routing signal is the pull_request_review
        // state-change event (route-by-pr-review-state) plus a
        // separately-mentioned issue comment, not the PR body itself
        // (pr-discipline.md). This IS the exact unlabeled, unmentioned
        // shape agent-identity.md documents as the standard PR-creation
        // call — blocking it would break every PR the fleet creates, with
        // no mid-session fix available (MACF_SKIP_MENTION_CHECK is
        // launch-time-only).
        const r = runCreate('gh pr create --title "x" --body "Refs #1"');
        expect(r.status).toBe(0);
      });

      it('a peer-labeled `gh pr create` with no mention still ALLOWS (case 2 applies the same to PRs)', () => {
        const r = runCreate('gh pr create --title "x" --label science-agent --body "Refs #1"');
        expect(r.status).toBe(0);
      });
    });

    describe('registry / infrastructure edge cases', () => {
      it('`backlog` label allows even with NO registry available (registry-independent check)', () => {
        const r = runHook({
          command: 'gh issue create --title "x" --label backlog --body "no mention here"',
          // No CLAUDE_PROJECT_DIR at all — backlog detection doesn't need it.
        });
        expect(r.status).toBe(0);
      });

      it('no registry + no labels at all → still BLOCKED (registry-independent case 4)', () => {
        const r = runHook({
          command: 'gh issue create --title "x" --body "no mention here"',
        });
        expect(r.status).toBe(2);
      });

      it('no registry + a non-backlog label present → BLOCKED (can\'t confirm, falls to case 4)', () => {
        const r = runHook({
          command: 'gh issue create --title "x" --label code-agent --body "no mention here"',
        });
        expect(r.status).toBe(2);
      });
    });

    describe('--body-file handling for create forms', () => {
      it('resolves a readable --body-file for a self-labeled create with zero mentions → BLOCKED', () => {
        const file = join(dir, 'body.md');
        writeFileSync(file, 'no mention here\n');
        const r = runCreate(`gh issue create --title "x" --label code-agent --body-file ${file}`);
        expect(r.status).toBe(2);
      });

      it('resolves a readable --body-file for a self-labeled create WITH a mention → ALLOWED', () => {
        const file = join(dir, 'body.md');
        writeFileSync(file, '@macf-science-agent[bot] please advise\n');
        const r = runCreate(`gh issue create --title "x" --label code-agent --body-file ${file}`);
        expect(r.status).toBe(0);
      });

      it('resolves a readable --body-file for a backlog-labeled create with zero mentions → ALLOWED', () => {
        const file = join(dir, 'body.md');
        writeFileSync(file, 'no mention here\n');
        const r = runCreate(`gh issue create --title "x" --label backlog --body-file ${file}`);
        expect(r.status).toBe(0);
      });
    });

    describe('MACF_SKIP_MENTION_CHECK=1 overrides the create-guard', () => {
      it('bypasses a case-3 (self-labeled) block', () => {
        const r = runCreate('gh issue create --title "x" --label code-agent --body "no mention here"', {
          MACF_SKIP_MENTION_CHECK: '1',
        });
        expect(r.status).toBe(0);
      });

      it('bypasses a case-4 (no labels) block', () => {
        const r = runCreate('gh issue create --title "x" --body "no mention here"', {
          MACF_SKIP_MENTION_CHECK: '1',
        });
        expect(r.status).toBe(0);
      });
    });

    describe('--title mentions (mechanical consequence of whole-command scanning)', () => {
      // Documented judgment call (see the report): Check A/B's LINT_TARGET
      // for the inline (non --body-file) form is the whole raw $COMMAND
      // string, same as it always was for `comment` subcommands — there is
      // no reliable way to slice out just --body's value from --title's
      // without real shell-quote evaluation. A mention landing in --title
      // therefore mechanically counts, even though GitHub's own mention/
      // notification parsing does not apply to title text.
      it('a mention ONLY in --title (not in --body) satisfies Check A for a self-labeled create', () => {
        // The title mention must be in the SAME line-start form Check B
        // already requires everywhere else (a mid-line mention right after
        // an opening quote is flagged as a describing-context leak
        // regardless of which flag carries it — see the next describe
        // block). A heredoc-substituted --title puts it at true line-start.
        const r = runCreate(
          'gh issue create --title "$(cat <<EOF\n@macf-science-agent[bot] please advise\nEOF\n)" --label code-agent --body "no mention in the body"',
        );
        expect(r.status).toBe(0);
      });
    });

    describe('pre-existing Check B heuristic, now visible on a canonical doc example', () => {
      // NOT a regression introduced by macf#1091 — verified the identical
      // shape already blocked `gh issue comment` one-liners before this fix
      // (mid-line-vs-line-start heuristic, documented since #272). What's
      // NEW is that this exact shape is agent-identity.md's own canonical
      // "Creating Issues for Other Agents" example:
      //   gh issue create --repo groundnuty/macf --title "<description>" \
      //     --label "science-agent" --body "@macf-science-agent[bot] <details>"
      // The mention sits immediately after `--body "` with no preceding
      // newline, which the existing heuristic treats as mid-line, not
      // line-start addressing — Check B blocks it. Reported, not silently
      // patched: widening the line-start allowance is a Check-B-wide
      // heuristic change out of scope for this fix; the doc example needs
      // a heredoc (matching the pattern already required for `comment`).
      it('blocks the literal agent-identity.md issue-create example as written (documents the friction, does not endorse it)', () => {
        const r = runCreate(
          'gh issue create --repo groundnuty/macf --title "some description" --label "science-agent" --body "@macf-science-agent[bot] some details"',
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('describing-context');
      });

      it('the heredoc form of the same example passes (the documented workaround already required for `comment`)', () => {
        const r = runCreate(
          'gh issue create --repo groundnuty/macf --title "some description" --label "science-agent" --body "$(cat <<EOF\n@macf-science-agent[bot] some details\nEOF\n)"',
        );
        expect(r.status).toBe(0);
      });
    });
  });
});
