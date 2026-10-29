/**
 * Autonomous peer lifecycle notices (`session-end`, `session-compact`,
 * `turn-complete`, `error`, or no event) are recorded, never pushed.
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

export function isAutonomousPeerLifecycle(payload: NotifyPayload): boolean {
  return payload.type === 'peer_notification' && decideWake(payload).action === 'skip';
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
