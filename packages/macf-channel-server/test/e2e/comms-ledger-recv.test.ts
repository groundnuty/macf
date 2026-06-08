/**
 * E2E: the two inbound RECV edge sites record an authoritative comms-ledger
 * edge BEFORE delivering to onNotify (macf#473 piece 2, APPEND-BEFORE-DELIVER).
 *
 * Cert-gated (real mTLS handshake → handleRequest), so this lives under
 * test/e2e/ alongside the other full-path https tests. It drives a real
 * POST /notify and a real A2A /a2a/v1 message/send through the server, and
 * asserts both:
 *   - recordLedgerEdge fires with the correctly-mapped edge, and
 *   - it fires STRICTLY BEFORE onNotify (the durable write precedes the
 *     lossy delivery hop).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../../src/https.js';
import { TaskStore } from '../../src/a2a-task.js';
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

describe('inbound recv edge sites — append-before-deliver (macf#473)', () => {
  it('POST /notify records the github-route recv edge BEFORE onNotify', async () => {
    const order: string[] = [];
    let recordedEdge: CommsLedgerEdge | undefined;

    const recordLedgerEdge = vi.fn((edge: CommsLedgerEdge) => {
      order.push('record');
      recordedEdge = edge;
    });
    const onNotify = vi.fn(async (_p: NotifyPayload) => {
      order.push('deliver');
    });

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      recordLedgerEdge,
      selfAgentName: 'recv-agent',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'mention', issue_number: 42, repo: 'groundnuty/macf', message: 'ping' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);
    // THE ordering contract: record precedes deliver.
    expect(order).toEqual(['record', 'deliver']);

    expect(recordedEdge).toMatchObject({
      to: 'recv-agent',
      channel: 'github-route',
      direction: 'recv',
      event: 'mention',
      github_anchor: 'groundnuty/macf#42',
      delivered: true,
      processed: null,
    });
    expect(typeof recordedEdge!.trace_id).toBe('string');
    expect(recordedEdge!.from.length).toBeGreaterThan(0);

    await server.stop();
  });

  it('A2A /a2a/v1 message/send records the a2a recv edge BEFORE onNotify', async () => {
    const order: string[] = [];
    let recordedEdge: CommsLedgerEdge | undefined;

    const recordLedgerEdge = vi.fn((edge: CommsLedgerEdge) => {
      order.push('record');
      recordedEdge = edge;
    });
    const onNotify = vi.fn(async (_p: NotifyPayload) => {
      order.push('deliver');
    });

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
      taskStore: new TaskStore(),
      recordLedgerEdge,
      selfAgentName: 'recv-agent',
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    const envelope = {
      jsonrpc: '2.0',
      id: 'rpc-1',
      method: 'message/send',
      params: {
        message: {
          messageId: 'a2a-msg-9',
          role: 'ROLE_USER',
          parts: [{ text: 'A2A nudge body' }],
          metadata: { event: 'custom', source: 'cv-architect', github_anchor: 'g/m#9' },
        },
      },
    };
    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/a2a/v1',
      body: JSON.stringify(envelope),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['record', 'deliver']);

    expect(recordedEdge).toMatchObject({
      to: 'recv-agent',
      channel: 'a2a',
      direction: 'recv',
      event: 'custom',
      msg_id: 'a2a-msg-9',
      github_anchor: 'g/m#9',
      delivered: true,
      processed: null,
    });
    expect(recordedEdge!.intent_summary).toBe('A2A nudge body');

    await server.stop();
  });
});
