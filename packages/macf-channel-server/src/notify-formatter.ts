import type { NotifyPayload } from '@groundnuty/macf-core';

/**
 * Render a NotifyPayload to the operator-facing content string that
 * gets pushed through MCP. Pure function — extracted from `onNotify`
 * in `server.ts` per ultrareview finding A6. Previously the renderer
 * lived inside a 58-line closure that also did logging, health-state
 * mutation, and MCP push; adding a new `NotifyPayload` variant meant
 * editing that closure. Extracting makes variant dispatch testable
 * in isolation.
 *
 * Returns the rendered content and the issue number the payload is
 * associated with (for health-state updates at the call site).
 */
export interface FormattedNotify {
  readonly content: string;
  readonly issueNumber?: number;
}

export function formatNotifyContent(payload: NotifyPayload): FormattedNotify {
  const formatted = renderNotifyContent(payload);
  // macf#790 Gap 2: when the sender stamped a canonical `<project>/<name>`
  // reply-to slug, surface it explicitly so the recipient agent has an
  // unambiguous reply address instead of guessing from the bare `source` —
  // a guest replying to a bare routing label resolves inside its OWN
  // project and never reaches the sender's home fleet. Applies uniformly
  // across every rendered variant that can carry `reply_to` (peer_notification
  // + mention today, both the legacy `/notify` path and the A2A message
  // path once converted to NotifyPayload — see a2a-delivery.ts).
  if (payload.reply_to !== undefined && payload.reply_to.length > 0) {
    return { ...formatted, content: `${formatted.content}\n(reply to: ${payload.reply_to})` };
  }
  return formatted;
}

function renderNotifyContent(payload: NotifyPayload): FormattedNotify {
  if (payload.type === 'issue_routed') {
    if (payload.issue_number !== undefined) {
      const suffix = payload.title ? `: ${payload.title}` : '';
      // Include `--repo <repo>` instruction when the producer
      // supplied origin-repo (macf-actions v3.2.0+, #30). Multi-homed
      // receivers otherwise fall back to cwd-repo on bare `gh issue
      // view N`, which is rarely the routing source. The hint mirrors
      // the route-by-mention path's MESSAGE template. When repo is
      // absent (older producer), the trailing-period + Run-hint are
      // omitted to keep the legacy single-sentence shape unchanged.
      const repoSuffix = payload.repo
        ? `. Run: gh issue view ${payload.issue_number} --repo ${payload.repo} --json title,body,labels,comments`
        : '';
      return {
        content: `Issue #${payload.issue_number} was routed to you${suffix}${repoSuffix}`,
        issueNumber: payload.issue_number,
      };
    }
    return {
      content: payload.title
        ? `An issue was routed to you: ${payload.title}`
        : 'An issue was routed to you',
    };
  }

  if (payload.type === 'mention') {
    if (payload.message) {
      return { content: payload.message };
    }
    // macf#616: a message-less mention still carries its anchor (issue_number
    // or pr_number — enforced by NotifyPayloadSchema's refine), so the fallback
    // surfaces that anchor rather than a bare context-free "You were mentioned"
    // that would strand the recipient (silent-fallback Instance 14). The truly
    // anchorless bare string remains only as a last-resort defense for the
    // diagnostic-probe path (which never reaches here) and direct callers that
    // bypass the schema.
    if (payload.issue_number !== undefined) {
      return { content: `You were mentioned in #${payload.issue_number}` };
    }
    if (payload.pr_number !== undefined) {
      return { content: `You were mentioned in PR #${payload.pr_number}` };
    }
    return { content: 'You were mentioned' };
  }

  if (payload.type === 'ci_completion') {
    // Prefer the prebuilt `message` (producer has all context) but
    // fall back to a shape-derived rendering if absent. Producers
    // that use CiCompletionPayloadSchema always provide `message`.
    if (payload.message) {
      return { content: payload.message };
    }
    if (payload.pr_number !== undefined && payload.conclusion !== undefined) {
      const prRef = `PR #${payload.pr_number}`;
      if (payload.conclusion === 'success') {
        return { content: `${prRef}: CI SUCCESS` };
      }
      const failing = payload.failing_check_name
        ? ` (first failing check: '${payload.failing_check_name}')`
        : '';
      return {
        content: `${prRef}: CI ${payload.conclusion.toUpperCase()}${failing}`,
      };
    }
    return { content: 'CI completed' };
  }

  if (payload.type === 'peer_notification') {
    // macf#256 / DR-023 UC-1: rendered when the channel-server's
    // notify_peer MCP tool POSTs to a peer's /notify. Source is the
    // sending peer's agent name; event is the hook context that
    // triggered the notification (session-end / session-compact / turn-complete /
    // error / custom). Prefer producer's `message` if present;
    // otherwise synthesize a minimal "Peer X reports event Y" line.
    if (payload.message) {
      const prefix = payload.source ? `Peer ${payload.source}: ` : 'Peer notification: ';
      return { content: `${prefix}${payload.message}` };
    }
    const sourcePart = payload.source ? `Peer ${payload.source}` : 'A peer';
    const eventPart = payload.event ? ` reports event: ${payload.event}` : ' sent a notification';
    return { content: `${sourcePart}${eventPart}` };
  }

  if (payload.type === 'pr_review_state') {
    // macf-actions#39 (v3.3.0): rendered when the route-by-pr-review-state
    // job POSTs on a `pull_request_review` event with state in
    // {approved, changes_requested}. Receiver is the PR author. The
    // verb is determined by review_state; reviewer_login surfaces who
    // acted; pr_url locates the work unit. review_url (if provided)
    // deep-links to the review comment for receivers that want it —
    // omitted from the rendered string to keep it terse but available
    // on the payload for programmatic use.
    const reviewer = payload.reviewer_login ?? 'A reviewer';
    const verb =
      payload.review_state === 'approved'
        ? 'approved'
        : payload.review_state === 'changes_requested'
          ? 'requested changes on'
          : 'reviewed';
    if (payload.pr_number !== undefined) {
      const linkSuffix = payload.pr_url ? `: ${payload.pr_url}` : '';
      return { content: `${reviewer} ${verb} PR #${payload.pr_number}${linkSuffix}` };
    }
    return {
      content: payload.pr_url
        ? `${reviewer} ${verb} PR: ${payload.pr_url}`
        : `${reviewer} ${verb} a PR`,
    };
  }

  // startup_check or any future variant falls through here
  return { content: payload.message ?? 'Pending issues found at startup' };
}
