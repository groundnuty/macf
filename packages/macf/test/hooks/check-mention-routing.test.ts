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
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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

  describe('--body-file path', () => {
    it('allows `gh issue comment ... --body-file path` (file content not lintable)', () => {
      // The hook intentionally skips file-based body — content not
      // available at hook-fire time. Operator discipline + the canonical
      // rule cover this.
      const r = runHook({
        command: 'gh issue comment 123 --body-file /tmp/comment.md',
      });
      expect(r.status).toBe(0);
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
});
