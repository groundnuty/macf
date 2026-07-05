/**
 * macf#428 (A2A Phase 3.5) — receiver-side delivery for inbound A2A v1.0
 * `message/send`.
 *
 * Before this, the `/a2a/v1` handler created an A2A Task and returned, but
 * never delivered the message to the agent: no MCP-channel deposit, no wake.
 * So A2A was protocol-proven but agents didn't actually receive over it.
 *
 * This maps an inbound A2A `Message` to the `peer_notification`
 * `NotifyPayload` that the legacy `/notify` delivery primitive (`onNotify`
 * → `mcp.pushNotification` → `decideWake` → `wakeViaTmux`) already consumes,
 * so the A2A path delivers exactly the way legacy `/notify` does — and the
 * Pattern-E wake discriminator (`decideWake`, keyed on `event`) is reused
 * unchanged.
 */
import type { Message } from './a2a-types.js';
import type { NotifyPayload } from '@groundnuty/macf-core';

/** The four wake-policy events `decideWake` recognizes (macf#355). */
const KNOWN_EVENTS = ['session-end', 'turn-complete', 'error', 'custom'] as const;
type KnownEvent = (typeof KNOWN_EVENTS)[number];

function isKnownEvent(v: unknown): v is KnownEvent {
  return typeof v === 'string' && (KNOWN_EVENTS as readonly string[]).includes(v);
}

/**
 * Map an inbound A2A `message/send` Message → a `peer_notification`
 * NotifyPayload for `onNotify`.
 *
 * - **body** (`message`): the Message's text parts, joined — the content the
 *   receiving agent actually sees.
 * - **event**: read from `Message.metadata.event` (the sender's
 *   `buildA2aMessageFromPayload` stamps it). Only a *recognized* event is
 *   carried; a missing/unrecognized value **omits `event`**, so
 *   `decideWake` falls to its skip branch → **push-only, no wake**. This is
 *   the missing-event→push-only safety default (macf#428): an mTLS-trusted
 *   but non-MACF A2A client that doesn't know our metadata keys cannot
 *   *accidentally* wake the receiver.
 *
 *   Security framing (precise): the **mTLS trust boundary** is the gate —
 *   any mTLS-trusted client that *deliberately* stamps `event=custom` will
 *   wake the receiver, exactly as it would over legacy `/notify` today.
 *   This default only prevents *accidental* wakes, not deliberate ones by
 *   trusted clients (fine under mTLS).
 * - **source**: from `Message.metadata.source` (sender agent name); falls
 *   back to a generic label when absent.
 * - **reply_to** (macf#790 Gap 2): from `Message.metadata.reply_to` — the
 *   sender's canonical `<project>/<name>` reply address (stamped by
 *   `notify-peer.ts`'s `buildA2aMessageFromPayload`). Carried straight
 *   through so `formatNotifyContent` can surface it to the recipient;
 *   omitted when absent (pre-#790 senders) or non-string.
 */
export function a2aMessageToNotifyPayload(message: Message): NotifyPayload {
  const body = message.parts
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t.length > 0)
    .join('\n');

  const meta = message.metadata ?? {};
  const rawEvent = meta['event'];
  const rawReplyTo = meta['reply_to'];
  const source = typeof meta['source'] === 'string' && meta['source'].length > 0
    ? meta['source']
    : 'a2a-peer';

  return {
    type: 'peer_notification',
    source,
    message: body,
    // Omit `event` entirely when unrecognized → decideWake → skip (push-only).
    ...(isKnownEvent(rawEvent) ? { event: rawEvent } : {}),
    ...(typeof rawReplyTo === 'string' && rawReplyTo.length > 0 ? { reply_to: rawReplyTo } : {}),
  };
}
