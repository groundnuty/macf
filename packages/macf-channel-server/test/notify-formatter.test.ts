/**
 * Tests for the NotifyPayload → MCP-content renderer (ultrareview A6).
 *
 * Pre-refactor this logic lived inside the `onNotify` closure in
 * server.ts, entangled with logging + health-state + MCP push. The
 * extraction makes variant dispatch testable in isolation — any new
 * NotifyPayload variant should land here with its own rendering test
 * before the server-side wire-up.
 */
import { describe, it, expect } from 'vitest';
import { formatNotifyContent } from '../src/notify-formatter.js';
import type { NotifyPayload } from '@groundnuty/macf-core';

describe('formatNotifyContent', () => {
  describe('issue_routed', () => {
    it('includes issue number + title', () => {
      const result = formatNotifyContent({
        type: 'issue_routed',
        issue_number: 42,
        title: 'Fix the thing',
      });
      expect(result.content).toBe('Issue #42 was routed to you: Fix the thing');
      expect(result.issueNumber).toBe(42);
    });

    it('omits title when absent', () => {
      const result = formatNotifyContent({
        type: 'issue_routed',
        issue_number: 99,
      });
      expect(result.content).toBe('Issue #99 was routed to you');
      expect(result.issueNumber).toBe(99);
    });

    it('falls back gracefully when issue_number is absent (no issueNumber in result)', () => {
      const result = formatNotifyContent({
        type: 'issue_routed',
        title: 'Something',
      });
      expect(result.content).toBe('An issue was routed to you: Something');
      expect(result.issueNumber).toBeUndefined();
    });

    it('falls back to generic string when both absent', () => {
      const result = formatNotifyContent({ type: 'issue_routed' });
      expect(result.content).toBe('An issue was routed to you');
      expect(result.issueNumber).toBeUndefined();
    });

    // macf-actions#30: route-by-label payload now carries `repo`.
    // Receivers render `--repo <repo>` into the surfaced message so
    // multi-homed agents don't need to guess the origin repo.
    it('appends gh issue view --repo hint when repo is present', () => {
      const result = formatNotifyContent({
        type: 'issue_routed',
        issue_number: 7,
        title: 'Demo title',
        repo: 'groundnuty/macf-testbed',
      });
      expect(result.content).toBe(
        'Issue #7 was routed to you: Demo title. ' +
          'Run: gh issue view 7 --repo groundnuty/macf-testbed --json title,body,labels,comments',
      );
      expect(result.issueNumber).toBe(7);
    });

    it('appends repo hint even when title is absent', () => {
      const result = formatNotifyContent({
        type: 'issue_routed',
        issue_number: 12,
        repo: 'groundnuty/macf',
      });
      expect(result.content).toBe(
        'Issue #12 was routed to you. ' +
          'Run: gh issue view 12 --repo groundnuty/macf --json title,body,labels,comments',
      );
    });
  });

  describe('mention', () => {
    it('uses the message field verbatim', () => {
      const result = formatNotifyContent({
        type: 'mention',
        message: 'You were mentioned in issue #7',
      });
      expect(result.content).toBe('You were mentioned in issue #7');
      expect(result.issueNumber).toBeUndefined();
    });

    it('falls back to generic string when message AND anchor absent', () => {
      // Truly anchorless mentions can't reach the formatter post-macf#616
      // (NotifyPayloadSchema rejects them), but the bare string remains as a
      // last-resort defense for direct callers that bypass the schema.
      const result = formatNotifyContent({ type: 'mention' });
      expect(result.content).toBe('You were mentioned');
    });

    it('includes the issue anchor when message absent (macf#616)', () => {
      const result = formatNotifyContent({ type: 'mention', issue_number: 7 });
      expect(result.content).toBe('You were mentioned in #7');
    });

    it('includes the PR anchor when message absent (macf#616)', () => {
      const result = formatNotifyContent({ type: 'mention', pr_number: 12 });
      expect(result.content).toBe('You were mentioned in PR #12');
    });
  });

  describe('ci_completion', () => {
    const base: NotifyPayload = {
      type: 'ci_completion',
      pr_number: 130,
      pr_title: 'some PR',
      pr_url: 'https://github.com/owner/repo/pull/130',
      conclusion: 'success',
      failing_check_name: null,
      message: 'PR #130: CI SUCCESS. ...',
    };

    it('prefers prebuilt message when present', () => {
      expect(formatNotifyContent(base).content).toBe('PR #130: CI SUCCESS. ...');
    });

    it('falls back to shape-derived rendering on success', () => {
      const result = formatNotifyContent({ ...base, message: undefined });
      expect(result.content).toBe('PR #130: CI SUCCESS');
    });

    it('falls back to shape-derived rendering on failure with failing_check_name', () => {
      const result = formatNotifyContent({
        ...base,
        message: undefined,
        conclusion: 'failure',
        failing_check_name: 'check / build',
      });
      expect(result.content).toContain('CI FAILURE');
      expect(result.content).toContain("'check / build'");
    });

    it('handles timed_out + action_required conclusions', () => {
      const timeoutResult = formatNotifyContent({
        ...base,
        message: undefined,
        conclusion: 'timed_out',
        failing_check_name: null,
      });
      expect(timeoutResult.content).toContain('CI TIMED_OUT');

      const actionResult = formatNotifyContent({
        ...base,
        message: undefined,
        conclusion: 'action_required',
        failing_check_name: null,
      });
      expect(actionResult.content).toContain('CI ACTION_REQUIRED');
    });

    it('falls back to generic string when nothing useful is present', () => {
      expect(formatNotifyContent({ type: 'ci_completion' }).content).toBe('CI completed');
    });
  });

  describe('startup_check (unchanged from pre-refactor)', () => {
    it('uses message field', () => {
      const result = formatNotifyContent({
        type: 'startup_check',
        message: 'Pending issues: #1, #2',
      });
      expect(result.content).toBe('Pending issues: #1, #2');
    });

    it('falls back to default when message absent', () => {
      expect(formatNotifyContent({ type: 'startup_check' }).content)
        .toBe('Pending issues found at startup');
    });
  });

  describe('pr_review_state (macf-actions#39, v3.3.0)', () => {
    it('renders approved with reviewer + PR number + URL', () => {
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
      });
      expect(result.content).toBe(
        'cv-architect[bot] approved PR #42: https://github.com/groundnuty/academic-resume/pull/42',
      );
    });

    it('renders changes_requested with descriptive verb phrase', () => {
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'changes_requested',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
      });
      expect(result.content).toBe(
        'cv-architect[bot] requested changes on PR #42: https://github.com/groundnuty/academic-resume/pull/42',
      );
    });

    it('falls back gracefully when reviewer_login is absent', () => {
      // Defense-in-depth: receivers parse via wider NotifyPayloadSchema
      // where reviewer_login is optional. Older producers OR clients
      // omitting it should still render readable text rather than
      // "undefined approved PR #N".
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
        pr_number: 42,
        pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
      });
      expect(result.content).toBe(
        'A reviewer approved PR #42: https://github.com/groundnuty/academic-resume/pull/42',
      );
    });

    it('handles missing pr_url (no link suffix)', () => {
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
      });
      expect(result.content).toBe('cv-architect[bot] approved PR #42');
    });

    it('handles missing pr_number (URL-only path)', () => {
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
      });
      expect(result.content).toBe(
        'cv-architect[bot] approved PR: https://github.com/groundnuty/academic-resume/pull/42',
      );
    });

    it('handles minimal payload (review_state only)', () => {
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
      });
      expect(result.content).toBe('A reviewer approved a PR');
    });

    it('does NOT render review_url in the surface text (kept on payload only)', () => {
      // review_url is for programmatic deep-linking (receivers fetch
      // the review body if they want); the rendered surface stays
      // terse with just the PR URL.
      const result = formatNotifyContent({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
        review_url: 'https://github.com/groundnuty/academic-resume/pull/42#pullrequestreview-12345',
      });
      expect(result.content).not.toContain('pullrequestreview');
    });
  });

  describe('reply_to surfacing (macf#790 Gap 2)', () => {
    it('appends the reply-to line for a peer_notification carrying reply_to', () => {
      const result = formatNotifyContent({
        type: 'peer_notification',
        source: 'science-agent',
        event: 'custom',
        message: 'need a hand on #12',
        reply_to: 'icsoc-2026/science-agent',
      });
      expect(result.content).toBe(
        'Peer science-agent: need a hand on #12\n(reply to: icsoc-2026/science-agent)',
      );
    });

    it('appends the reply-to line for a mention carrying reply_to', () => {
      const result = formatNotifyContent({
        type: 'mention',
        message: 'please take a look',
        reply_to: 'icsoc-2026/science-agent',
      });
      expect(result.content).toBe('please take a look\n(reply to: icsoc-2026/science-agent)');
    });

    it('omits the reply-to line when reply_to is absent (pre-#790 back-compat)', () => {
      const result = formatNotifyContent({
        type: 'peer_notification',
        source: 'science-agent',
        event: 'custom',
        message: 'no reply-to here',
      });
      expect(result.content).toBe('Peer science-agent: no reply-to here');
      expect(result.content).not.toContain('reply to');
    });

    it('omits the reply-to line when reply_to is an empty string', () => {
      const result = formatNotifyContent({
        type: 'mention',
        message: 'please take a look',
        reply_to: '',
      });
      expect(result.content).toBe('please take a look');
    });
  });
});
