/**
 * Pure-function wake-decision for the `/notify` receiver-side handler.
 *
 * Extracted from `server.ts` `onNotify` (macf#351 → simplified macf#355)
 * so the discriminator is unit-testable without spinning up the HTTPS
 * server. The receiver's decision tree is small but security-load-
 * bearing — Pattern E (macf#267 Option d) prevents the cross-agent
 * Stop-hook ping-pong loop, and the slash-command-driven wake path
 * is the operator-driven escape hatch.
 *
 * Decision rule (in order):
 *
 *   1. `peer_notification` with `event === 'custom'` → WAKE via tmux.
 *      `event: custom` originates only from operator-driven flows
 *      (slash command in macf#350). The loop hazard does not apply
 *      when the trigger is a human, not a Stop hook.
 *   2. `peer_notification` with any autonomous-flow event
 *      (`session-end` / `session-compact` / `turn-complete` / `error`) → SKIP tmux wake
 *      (Pattern E; observational-only delivery; loop prevention).
 *   3. Any other NotifyType (issue_routed, mention, ci_completion,
 *      pr_review_state, startup_check) → WAKE via tmux (existing
 *      behavior — these variants always wake the receiver).
 *
 * Returns the action + a structured reason for log/observability.
 *
 * macf#355 history note: this used to read a `wake?: boolean` field
 * from the payload (the sender opted in per-call). That leaked
 * Pattern E loop-prevention logic into every sender's API surface.
 * Discriminating by `event` keeps the policy at the receiver — which
 * is the architectural layer that enforces it — and shrinks the
 * agent-facing API by one optional flag.
 */
import type { NotifyPayload } from '@groundnuty/macf-core';

export type WakeAction = 'wake' | 'skip';

export interface WakeDecision {
  readonly action: WakeAction;
  /** Stable string for log-event `reason` field; one per branch. */
  readonly reason:
    | 'peer_notification_autonomous_event'
    | 'peer_notification_custom_event'
    | 'standard_notify_type';
}

export function decideWake(payload: NotifyPayload): WakeDecision {
  if (payload.type === 'peer_notification') {
    if (payload.event === 'custom') {
      return { action: 'wake', reason: 'peer_notification_custom_event' };
    }
    return { action: 'skip', reason: 'peer_notification_autonomous_event' };
  }
  return { action: 'wake', reason: 'standard_notify_type' };
}
