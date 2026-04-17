import type { NotifyPayload } from './types.js';

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
  if (payload.type === 'issue_routed') {
    if (payload.issue_number !== undefined) {
      const suffix = payload.title ? `: ${payload.title}` : '';
      return {
        content: `Issue #${payload.issue_number} was routed to you${suffix}`,
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
    return { content: payload.message ?? 'You were mentioned' };
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

  // startup_check or any future variant falls through here
  return { content: payload.message ?? 'Pending issues found at startup' };
}
