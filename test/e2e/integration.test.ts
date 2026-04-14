/**
 * Integration test: starts the full HTTPS server with real test certs,
 * verifies health, notify, and cert rejection work end-to-end.
 * MCP channel is mocked (no real Claude Code session).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../../src/https.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/logger.js';
import type { NotifyPayload, HttpsServer } from '../../src/types.js';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;
let server: HttpsServer;
let port: number;
const notifications: NotifyPayload[] = [];

function httpsGet(
  path: string,
  overrides?: { cert?: Buffer; key?: Buffer; ca?: Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path,
        cert: overrides?.cert ?? readFileSync(certs.agentCert),
        key: overrides?.key ?? readFileSync(certs.agentKey),
        ca: overrides?.ca ?? readFileSync(certs.caCert),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers,
        cert: readFileSync(certs.agentCert),
        key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  certs = generateTestCerts();

  const health = createHealthState('integration-test', 'permanent');
  const logger = createLogger({ debug: false });

  server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: async (payload) => {
      notifications.push(payload);
      if (payload.type === 'issue_routed' && payload.issue_number !== undefined) {
        health.setCurrentIssue(payload.issue_number);
      }
      health.recordNotification();
    },
    onHealth: () => health.getHealth(),
    logger,
  });

  const result = await server.start(0, '127.0.0.1');
  port = result.actualPort;
});

afterAll(async () => {
  await server.stop();
  cleanupTestCerts(certs);
});

describe('integration', () => {
  it('health endpoint returns correct initial state', async () => {
    const res = await httpsGet('/health');
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.agent).toBe('integration-test');
    expect(body.status).toBe('online');
    expect(body.type).toBe('permanent');
    expect(body.current_issue).toBeNull();
    expect(body.version).toBe('0.1.0');
  });

  it('notify endpoint receives and records notifications', async () => {
    const res = await httpsPost(
      '/notify',
      JSON.stringify({
        type: 'issue_routed',
        issue_number: 11,
        title: 'P1 Channel Server',
        source: 'agent-router',
      }),
      { 'Content-Type': 'application/json' },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.issue_number).toBe(11);
  });

  it('health reflects state after notification', async () => {
    const res = await httpsGet('/health');
    const body = JSON.parse(res.body);
    expect(body.current_issue).toBe(11);
    expect(body.last_notification).not.toBeNull();
  });

  it('rejects connection with untrusted certificate', async () => {
    await expect(
      httpsGet('/health', {
        cert: readFileSync(certs.untrustedCert),
        key: readFileSync(certs.untrustedKey),
        ca: readFileSync(certs.caCert),
      }),
    ).rejects.toThrow();
  });

  it('rejects notify with wrong content type', async () => {
    const res = await httpsPost('/notify', '{}', { 'Content-Type': 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('rejects notify with invalid type', async () => {
    const res = await httpsPost(
      '/notify',
      JSON.stringify({ type: 'bad_type' }),
      { 'Content-Type': 'application/json' },
    );
    expect(res.status).toBe(400);
  });
});
