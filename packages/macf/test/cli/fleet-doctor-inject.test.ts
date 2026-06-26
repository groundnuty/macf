/**
 * Tests for the `fleet-doctor-inject.ts` leaf module — the pure
 * `readCorrelationToken` accessor (DR-030 §3, macf#568).
 *
 * The mTLS network fns (`postInjectNotify` / `pollLastProcessedToken`) are NOT
 * unit-tested here — same posture as `postDiagnosticNotify` in fleet-doctor.ts:
 * they are thin wrappers over `node:https` + `pingAgentHealth`, exercised
 * through the injected-fake orchestration in `fleet-doctor.test.ts`. What IS
 * pure + worth pinning is the `last_processed.correlation_token` extraction —
 * THE `--inject` contract (correlation_token === the receipt's run_id).
 */
import { describe, it, expect } from 'vitest';
import type { HealthResponse } from '@groundnuty/macf-core';
import { readCorrelationToken } from '../../src/cli/commands/fleet-doctor-inject.js';

describe('readCorrelationToken — last_processed.correlation_token extraction', () => {
  it('returns the token when /health.last_processed carries one', () => {
    const health = {
      agent: 'code-agent',
      status: 'online',
      last_processed: { at: '2026-06-26T00:00:00Z', anchor: null, age_ms: 1200, correlation_token: '777' },
    } as unknown as HealthResponse;
    expect(readCorrelationToken(health)).toBe('777');
  });

  it('returns null when last_processed is null (no processed receipt yet)', () => {
    const health = { agent: 'code-agent', status: 'online', last_processed: null } as unknown as HealthResponse;
    expect(readCorrelationToken(health)).toBeNull();
  });

  it('returns null when the field is absent (older agent predating the passive increment)', () => {
    const health = { agent: 'code-agent', status: 'online' } as unknown as HealthResponse;
    expect(readCorrelationToken(health)).toBeNull();
  });

  it('returns null on a null health body (probe failed)', () => {
    expect(readCorrelationToken(null)).toBeNull();
  });

  it('returns null when correlation_token itself is null', () => {
    const health = {
      agent: 'code-agent',
      status: 'online',
      last_processed: { at: null, anchor: null, age_ms: null, correlation_token: null },
    } as unknown as HealthResponse;
    expect(readCorrelationToken(health)).toBeNull();
  });
});
