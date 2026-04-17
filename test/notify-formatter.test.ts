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
import type { NotifyPayload } from '../src/types.js';

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

    it('falls back to generic string when message absent', () => {
      const result = formatNotifyContent({ type: 'mention' });
      expect(result.content).toBe('You were mentioned');
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
});
