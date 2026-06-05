/**
 * Tests for src/a2a-delivery.ts — macf#428 (A2A Phase 3.5) receiver-side
 * delivery payload mapping. Pins the metadata→NotifyPayload contract that
 * the `/a2a/v1` handler relies on to deliver via `onNotify` + the Pattern-E
 * wake discriminator.
 */
import { describe, it, expect } from 'vitest';
import { a2aMessageToNotifyPayload } from '../src/a2a-delivery.js';
import type { Message } from '../src/a2a-types.js';

function msg(parts: Message['parts'], metadata?: Message['metadata']): Message {
  return {
    messageId: 'm-1',
    role: 'ROLE_USER',
    parts,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe('a2aMessageToNotifyPayload (macf#428)', () => {
  it('builds a peer_notification payload with the joined text body', () => {
    const p = a2aMessageToNotifyPayload(
      msg([{ text: 'hello' }, { text: 'world' }], { event: 'custom', source: 'cv-architect' }),
    );
    expect(p.type).toBe('peer_notification');
    expect(p.message).toBe('hello\nworld');
    expect(p.source).toBe('cv-architect');
  });

  it('carries event=custom from metadata (→ decideWake will WAKE)', () => {
    const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }], { event: 'custom', source: 's' }));
    expect(p.event).toBe('custom');
  });

  it('carries an autonomous event from metadata (→ decideWake will SKIP wake, Pattern E)', () => {
    for (const ev of ['turn-complete', 'session-end', 'error'] as const) {
      const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }], { event: ev, source: 's' }));
      expect(p.event).toBe(ev);
    }
  });

  it('OMITS event when metadata.event is missing → push-only safety default (no accidental wake)', () => {
    const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }], { source: 's' }));
    expect('event' in p).toBe(false); // decideWake falls to skip → push-only
  });

  it('OMITS event when metadata.event is unrecognized (non-MACF client) → push-only', () => {
    const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }], { event: 'bogus', source: 's' }));
    expect('event' in p).toBe(false);
  });

  it('OMITS event when there is no metadata at all', () => {
    const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }]));
    expect('event' in p).toBe(false);
    expect(p.source).toBe('a2a-peer'); // generic fallback
  });

  it('falls back to a generic source when metadata.source is absent', () => {
    const p = a2aMessageToNotifyPayload(msg([{ text: 'x' }], { event: 'custom' }));
    expect(p.source).toBe('a2a-peer');
  });

  it('skips non-text parts when joining the body', () => {
    const p = a2aMessageToNotifyPayload(
      msg([{ text: 'visible' }, { data: { k: 'v' } } as unknown as Message['parts'][number]], { source: 's' }),
    );
    expect(p.message).toBe('visible');
  });
});
