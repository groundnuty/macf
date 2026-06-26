/**
 * Unit tests for the DR-030 §6 diagnostic-ACK builder (groundnuty/macf#568).
 *
 * The full short-circuit path (mTLS handshake → handleRequest → ACK + return
 * BEFORE any push/wake/ledger side-effect) is exercised in
 * `test/e2e/diagnostic-discriminator.test.ts` (cert-gated). Here we pin the
 * pure ACK-body shape + the correlation-token echo/omit contract, so a future
 * refactor can't silently drift the wire shape the fleet-doctor "Accepted"
 * check depends on. `src/https.ts` is excluded from coverage thresholds
 * (vitest.config.ts) precisely because its request-handler body is e2e-tested;
 * this unit test covers the extracted pure helper.
 */
import { describe, it, expect } from 'vitest';
import { diagnosticAckBody } from '../src/https.js';
import type { NotifyPayload } from '@groundnuty/macf-core';

const IDS = { agent: 'code-agent', instanceId: 'inst-7f3a' } as const;

describe('diagnosticAckBody — DR-030 §6 mesh Accepted ACK', () => {
  it('echoes correlation_token verbatim when the probe sent one', () => {
    const body = diagnosticAckBody(
      { type: 'mention', diagnostic: true, correlation_token: 'probe-abc-123' } as NotifyPayload,
      IDS,
    );
    expect(body).toEqual({
      ack: true,
      agent: 'code-agent',
      instance_id: 'inst-7f3a',
      correlation_token: 'probe-abc-123',
    });
  });

  it('omits correlation_token entirely when the probe sent none', () => {
    const body = diagnosticAckBody(
      { type: 'mention', diagnostic: true } as NotifyPayload,
      IDS,
    );
    expect(body).toEqual({
      ack: true,
      agent: 'code-agent',
      instance_id: 'inst-7f3a',
    });
    expect('correlation_token' in body).toBe(false);
  });

  it('always sets ack:true and carries the supplied routing identity + instance_id', () => {
    const body = diagnosticAckBody(
      { type: 'mention', diagnostic: true } as NotifyPayload,
      { agent: 'science-agent', instanceId: 'inst-deadbeef' },
    );
    expect(body['ack']).toBe(true);
    expect(body['agent']).toBe('science-agent');
    expect(body['instance_id']).toBe('inst-deadbeef');
  });
});
