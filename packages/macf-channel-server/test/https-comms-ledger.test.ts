/**
 * Unit tests for the comms-ledger edge mappers used by the two inbound recv
 * edge sites in https.ts (macf#473 piece 2).
 *
 * The full recv path (mTLS handshake → handleRequest → recordLedgerEdge
 * BEFORE onNotify) is exercised in `test/e2e/comms-ledger-recv.test.ts`
 * (cert-gated). Here we pin the pure mapping helpers + the edge SHAPE the
 * recv sites build, so a future refactor can't silently drift the taxonomy
 * mapping or the anchor derivation. `src/https.ts` is excluded from coverage
 * thresholds (vitest.config.ts) precisely because its request-handler body
 * is e2e-tested; these unit tests cover the extracted pure helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  notifyTypeToCommsEvent,
  githubAnchorFromNotify,
  githubAnchorFromMessage,
  a2aMetadataToCommsEvent,
} from '../src/https.js';
import type { NotifyPayload } from '@groundnuty/macf-core';
import type { Message } from '../src/a2a-types.js';

describe('notifyTypeToCommsEvent — NotifyType → DR-025 taxonomy', () => {
  it('maps mention → mention', () => {
    expect(notifyTypeToCommsEvent({ type: 'mention' } as NotifyPayload)).toBe('mention');
  });
  it('maps issue_routed → issue-routed', () => {
    expect(notifyTypeToCommsEvent({ type: 'issue_routed' } as NotifyPayload)).toBe('issue-routed');
  });
  it('maps pr_review_state → pr-review-state', () => {
    expect(notifyTypeToCommsEvent({ type: 'pr_review_state' } as NotifyPayload)).toBe('pr-review-state');
  });
  it('falls back to custom for ci_completion / startup_check', () => {
    expect(notifyTypeToCommsEvent({ type: 'ci_completion' } as NotifyPayload)).toBe('custom');
    expect(notifyTypeToCommsEvent({ type: 'startup_check' } as NotifyPayload)).toBe('custom');
  });
  it('passes a legacy peer_notification finer `event` through verbatim', () => {
    expect(
      notifyTypeToCommsEvent({ type: 'peer_notification', event: 'turn-complete' } as NotifyPayload),
    ).toBe('turn-complete');
    expect(
      notifyTypeToCommsEvent({ type: 'peer_notification', event: 'session-end' } as NotifyPayload),
    ).toBe('session-end');
    expect(
      notifyTypeToCommsEvent({ type: 'peer_notification', event: 'error' } as NotifyPayload),
    ).toBe('error');
    expect(
      notifyTypeToCommsEvent({ type: 'peer_notification', event: 'custom' } as NotifyPayload),
    ).toBe('custom');
  });
  it('falls back to custom for a peer_notification with no event', () => {
    expect(notifyTypeToCommsEvent({ type: 'peer_notification' } as NotifyPayload)).toBe('custom');
  });
});

describe('githubAnchorFromNotify — owner/repo#N derivation', () => {
  it('prefers repo + issue_number → owner/repo#N', () => {
    expect(
      githubAnchorFromNotify({ type: 'issue_routed', issue_number: 34, repo: 'groundnuty/macf' } as NotifyPayload),
    ).toBe('groundnuty/macf#34');
  });
  it('falls back to bare #N when repo is absent', () => {
    expect(
      githubAnchorFromNotify({ type: 'issue_routed', issue_number: 34 } as NotifyPayload),
    ).toBe('#34');
  });
  it('uses pr_number when issue_number absent', () => {
    expect(
      githubAnchorFromNotify({ type: 'pr_review_state', pr_number: 99, repo: 'g/m' } as NotifyPayload),
    ).toBe('g/m#99');
  });
  it('returns null for a payload with no GitHub object (pure nudge)', () => {
    expect(githubAnchorFromNotify({ type: 'peer_notification' } as NotifyPayload)).toBeNull();
  });
  it('prefers a peer-stamped github_anchor on the wire (macf#473 legacy path)', () => {
    expect(
      githubAnchorFromNotify({ type: 'peer_notification', github_anchor: 'g/m#7' } as NotifyPayload),
    ).toBe('g/m#7');
    // a peer-stamped anchor wins even when issue/pr derivation would also fire
    expect(
      githubAnchorFromNotify({
        type: 'issue_routed',
        github_anchor: 'stamped/repo#1',
        issue_number: 99,
        repo: 'derived/repo',
      } as NotifyPayload),
    ).toBe('stamped/repo#1');
  });
});

describe('a2aMetadataToCommsEvent — A2A metadata.event → taxonomy', () => {
  function msg(event?: unknown): Message {
    return {
      messageId: 'm-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      ...(event !== undefined ? { metadata: { event } } : {}),
    };
  }
  it('maps the three autonomous events through verbatim', () => {
    expect(a2aMetadataToCommsEvent(msg('session-end'))).toBe('session-end');
    expect(a2aMetadataToCommsEvent(msg('turn-complete'))).toBe('turn-complete');
    expect(a2aMetadataToCommsEvent(msg('error'))).toBe('error');
  });
  it('maps custom → custom', () => {
    expect(a2aMetadataToCommsEvent(msg('custom'))).toBe('custom');
  });
  it('falls back to custom when event is missing or unrecognized', () => {
    expect(a2aMetadataToCommsEvent(msg())).toBe('custom');
    expect(a2aMetadataToCommsEvent(msg('not-a-real-event'))).toBe('custom');
  });
});

describe('githubAnchorFromMessage — A2A metadata.github_anchor read', () => {
  function msg(meta?: Record<string, unknown>): Message {
    return {
      messageId: 'm-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      ...(meta !== undefined ? { metadata: meta } : {}),
    };
  }
  it('reads a string anchor stamped by the sender', () => {
    expect(githubAnchorFromMessage(msg({ github_anchor: 'g/m#7' }))).toBe('g/m#7');
  });
  it('returns null when absent', () => {
    expect(githubAnchorFromMessage(msg())).toBeNull();
    expect(githubAnchorFromMessage(msg({ event: 'custom' }))).toBeNull();
  });
  it('returns null for a non-string or empty anchor', () => {
    expect(githubAnchorFromMessage(msg({ github_anchor: 123 }))).toBeNull();
    expect(githubAnchorFromMessage(msg({ github_anchor: '' }))).toBeNull();
  });
});
