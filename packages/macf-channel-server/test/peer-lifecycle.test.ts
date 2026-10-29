import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NotifyPayload } from '@groundnuty/macf-core';
import { pushUnlessLifecycle } from '../src/peer-lifecycle.js';
import { notifyTypeToCommsEvent } from '../src/https.js';

const throwingPush = (): Promise<void> => {
  throw new Error('push must not be called for an autonomous lifecycle notice');
};

function logger() {
  const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return { lines, info: (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields }); } };
}

describe('autonomous peer lifecycle notices are recorded, not pushed (macf#1525)', () => {
  for (const event of ['session-end', 'session-compact', 'turn-complete', 'error'] as const) {
    it(`does not push ${event}, logs peer_lifecycle_recorded, ledger event kept`, async () => {
      const payload: NotifyPayload = { type: 'peer_notification', source: 'peer-a', event, message: 'x' };
      const log = logger();
      await expect(pushUnlessLifecycle(payload, throwingPush, log)).resolves.toBe(false);
      expect(log.lines).toEqual([
        { event: 'peer_lifecycle_recorded', fields: { source: 'peer-a', event_type: event } },
      ]);
      expect(notifyTypeToCommsEvent(payload)).toBe(event);
    });
  }

  it('treats a missing event as autonomous', async () => {
    const payload: NotifyPayload = { type: 'peer_notification', source: 'peer-a', message: 'x' };
    await expect(pushUnlessLifecycle(payload, throwingPush, logger())).resolves.toBe(false);
  });

  it('still pushes event=custom and non-peer types', async () => {
    const payloads: NotifyPayload[] = [
      { type: 'peer_notification', source: 'p', event: 'custom', message: 'x' },
      { type: 'mention', issue_number: 1 },
      { type: 'issue_routed', issue_number: 2 },
    ] as NotifyPayload[];
    for (const payload of payloads) {
      const push = vi.fn(async () => undefined);
      const log = logger();
      await expect(pushUnlessLifecycle(payload, push, log)).resolves.toBe(true);
      expect(push).toHaveBeenCalledTimes(1);
      expect(log.lines).toEqual([]);
    }
  });

  it('server.ts pushes only through pushUnlessLifecycle', () => {
    const src = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');
    expect(src.match(/mcp\.pushNotification\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/pushUnlessLifecycle\(\s*payload,\s*\(\) => mcp\.pushNotification\(/);
  });
});
