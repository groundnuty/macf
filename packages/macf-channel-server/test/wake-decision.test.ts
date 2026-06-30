/**
 * Tests for `decideWake` (macf#351 → simplified macf#355) — pure-function
 * discriminator that tells the receiver-side `/notify` handler whether to
 * call wakeViaTmux.
 *
 * The two security-load-bearing properties under test:
 *
 *   1. **Pattern E preservation.** Stop-hook autonomous flows post a
 *      peer_notification with `event` ∈ `{session-end, turn-complete,
 *      error}`. The decision MUST be `skip` so receivers don't fire a
 *      fresh turn, which would re-trigger their own Stop hooks →
 *      cross-agent loop (macf#267 Option d).
 *
 *   2. **Operator-driven wake.** When a peer_notification arrives with
 *      `event: 'custom'`, the decision MUST be `wake`. Operator-driven
 *      invocations (slash-command in macf#350) need the receiver TUI
 *      to show the notification visibly without a context switch.
 *      `event: 'custom'` originates only from operator-driven flows
 *      (the Stop-hook hooks.json entry hard-codes one of the autonomous
 *      events; agents-and-operators communication channels follow
 *      the same convention).
 *
 * macf#355 history note: the previous design (#351) keyed wake-decision
 * off a `wake?: boolean` field on the payload (the sender opted in
 * per-call). That leaked Pattern E loop-prevention logic into the
 * agent-facing API and was removed in v0.2.21 — discriminating by
 * `event` alone keeps the policy at the receiver while shrinking the
 * sender-side API surface by one optional flag.
 */
import { describe, it, expect } from 'vitest';
import { decideWake } from '../src/wake-decision.js';

describe('decideWake (macf#355)', () => {
  describe('peer_notification — Pattern E (autonomous events skip)', () => {
    it('skips wake for event: session-end (Stop-hook autonomous flow)', () => {
      // Regression test: hooks.json `Stop` entry posts peer_notification
      // with event=session-end. MUST be `skip` to keep cross-agent
      // Stop-hook loop prevention intact.
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'session-end',
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_autonomous_event');
    });

    it('skips wake for event: turn-complete (autonomous flow)', () => {
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'turn-complete',
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_autonomous_event');
    });

    it('skips wake for event: error (autonomous flow)', () => {
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'error',
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_autonomous_event');
    });

    it('skips wake for event: session-compact (PreCompact-hook autonomous flow, macf#673)', () => {
      // Regression: hooks.json PreCompact entry posts peer_notification with
      // event=session-compact. MUST be `skip` — observational-only like
      // session-end; only `custom` wakes. (macf#673 moved the peer-notify off
      // the per-turn Stop hook onto SessionEnd[session-end] + PreCompact[session-compact].)
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'session-compact',
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_autonomous_event');
    });
  });

  describe('peer_notification — operator-driven wake', () => {
    it('wakes for event: custom (operator-driven slash-command)', () => {
      const decision = decideWake({
        type: 'peer_notification',
        source: 'operator',
        event: 'custom',
        message: 'operator typed: notify code-agent that ...',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('peer_notification_custom_event');
    });
  });

  describe('non-peer notify types — wake by default', () => {
    it('wakes for issue_routed', () => {
      const decision = decideWake({
        type: 'issue_routed',
        issue_number: 42,
        title: 'fix the thing',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for mention', () => {
      const decision = decideWake({
        type: 'mention',
        message: 'You were mentioned in #99',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for ci_completion', () => {
      const decision = decideWake({
        type: 'ci_completion',
        pr_number: 100,
        conclusion: 'success',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for pr_review_state', () => {
      const decision = decideWake({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'reviewer[bot]',
        pr_number: 200,
        pr_url: 'https://github.com/x/y/pull/200',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for startup_check', () => {
      const decision = decideWake({
        type: 'startup_check',
        message: 'pending issues found',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });
  });
});
