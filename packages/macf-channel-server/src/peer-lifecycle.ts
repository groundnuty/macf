/**
 * Autonomous peer lifecycle notices (`session-end`, `session-compact`,
 * `turn-complete`, `error`) are recorded, never pushed. A peer message with no
 * event is NOT one of them: it may be a real A2A message from a client that
 * does not know our metadata keys, so it is still pushed (just never woken).
 *
 * With native channels registered, an MCP push reaches the model as a channel
 * message and starts a turn. These notices are informational, so pushing them
 * made receivers spend turns answering "needs no reply" (macf#1525).
 * `decideWake` already skips the tmux wake for the same events.
 */
import type { NotifyPayload } from '@groundnuty/macf-core';
import { decideWake } from './wake-decision.js';

export interface LifecycleLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['session-end', 'session-compact', 'turn-complete', 'error']);

export function isAutonomousPeerLifecycle(payload: NotifyPayload): boolean {
  return (
    payload.type === 'peer_notification' &&
    payload.event !== undefined &&
    LIFECYCLE_EVENTS.has(payload.event) &&
    decideWake(payload).action === 'skip'
  );
}

/** Runs `push` unless the payload is an autonomous lifecycle notice. Returns true when pushed. */
export async function pushUnlessLifecycle(
  payload: NotifyPayload,
  push: () => Promise<void>,
  logger: LifecycleLogger,
): Promise<boolean> {
  if (isAutonomousPeerLifecycle(payload)) {
    logger.info('peer_lifecycle_recorded', {
      source: payload.source ?? 'unknown',
      event_type: payload.event ?? 'unknown',
    });
    return false;
  }
  await push();
  return true;
}
