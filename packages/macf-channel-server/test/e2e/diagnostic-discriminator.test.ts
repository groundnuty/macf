/**
 * E2E: the DR-030 §6 `diagnostic` discriminator on POST /notify
 * (groundnuty/macf#568) — the fleet-doctor mesh "Accepted" check.
 *
 * Cert-gated (real mTLS handshake → handleRequest), so this lives under
 * test/e2e/ alongside the other full-path https tests. It drives a real
 * `diagnostic: true` POST /notify through the server and asserts the
 * SHORT-CIRCUIT contract:
 *   - 200 ACK body { ack:true, agent, instance_id, correlation_token? }
 *     echoing the correlation_token when one was sent (and omitting it
 *     otherwise), and
 *   - NO side-effects: onNotify NOT called (→ no mcp push / no wake / no
 *     health.recordNotification) and recordLedgerEdge NOT called (no ledger
 *     write). Contrast: a normal (non-diagnostic) payload still drives both.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../../src/https.js';
import type { HealthResponse, Logger, NotifyPayload } from '@groundnuty/macf-core';
import type { CommsLedgerEdge } from '../../src/comms-ledger.js';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function httpsRequest(
  port: number,
  options: { method: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        cert: readFileSync(certs.agentCert),
        key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

beforeAll(() => {
  certs = generateTestCerts();
});
afterAll(() => {
  cleanupTestCerts(certs);
});

describe('POST /notify — DR-030 §6 diagnostic discriminator (macf#568)', () => {
  it('diagnostic:true → ACK (echoing correlation_token), NO push / wake / ledger', async () => {
    const onNotify = vi.fn(async (_p: NotifyPayload) => {});
    const recordLedgerEdge = vi.fn((_e: CommsLedgerEdge) => {});

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      recordLedgerEdge,
      selfAgentName: 'macf-code-agent',
      routingLabel: 'code-agent',
      instanceId: 'inst-abc123',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({
        type: 'mention',
        diagnostic: true,
        correlation_token: 'probe-xyz-789',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ack: true,
      agent: 'code-agent',
      instance_id: 'inst-abc123',
      correlation_token: 'probe-xyz-789',
    });
    // The short-circuit contract: NO delivery side-effects.
    expect(onNotify).not.toHaveBeenCalled();
    expect(recordLedgerEdge).not.toHaveBeenCalled();

    await server.stop();
  });

  it('diagnostic:true without a token → ACK omits correlation_token; still no side-effects', async () => {
    const onNotify = vi.fn(async (_p: NotifyPayload) => {});
    const recordLedgerEdge = vi.fn((_e: CommsLedgerEdge) => {});

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      recordLedgerEdge,
      selfAgentName: 'macf-code-agent',
      routingLabel: 'code-agent',
      instanceId: 'inst-abc123',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'mention', diagnostic: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ ack: true, agent: 'code-agent', instance_id: 'inst-abc123' });
    expect('correlation_token' in parsed).toBe(false);
    expect(onNotify).not.toHaveBeenCalled();
    expect(recordLedgerEdge).not.toHaveBeenCalled();

    await server.stop();
  });

  it('a normal (non-diagnostic) payload is unchanged — drives onNotify + ledger once', async () => {
    const onNotify = vi.fn(async (_p: NotifyPayload) => {});
    const recordLedgerEdge = vi.fn((_e: CommsLedgerEdge) => {});

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      recordLedgerEdge,
      selfAgentName: 'macf-code-agent',
      routingLabel: 'code-agent',
      instanceId: 'inst-abc123',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'mention', issue_number: 42, message: 'real ping' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received' });
    // Unchanged behavior: the real notification path runs.
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(recordLedgerEdge).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it('diagnostic:false is treated as a normal payload (explicit false ≠ probe)', async () => {
    const onNotify = vi.fn(async (_p: NotifyPayload) => {});
    const recordLedgerEdge = vi.fn((_e: CommsLedgerEdge) => {});

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      recordLedgerEdge,
      selfAgentName: 'macf-code-agent',
      routingLabel: 'code-agent',
      instanceId: 'inst-abc123',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'mention', diagnostic: false, message: 'real ping' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received' });
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(recordLedgerEdge).toHaveBeenCalledTimes(1);

    await server.stop();
  });
});
