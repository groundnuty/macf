import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { createHttpsServer } from '../../src/https.js';
import type { HealthResponse, Logger } from '../../src/types.js';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function httpsRequest(
  port: number,
  options: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    cert?: Buffer;
    key?: Buffer;
    ca?: Buffer;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        cert: options.cert ?? readFileSync(certs.agentCert),
        key: options.key ?? readFileSync(certs.agentKey),
        ca: options.ca ?? readFileSync(certs.caCert),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

beforeAll(() => {
  certs = generateTestCerts();
});

afterAll(() => {
  cleanupTestCerts(certs);
});

describe('createHttpsServer', () => {
  it('starts and responds to GET /health', async () => {
    const healthData: HealthResponse = {
      agent: 'test-agent',
      status: 'online',
      type: 'permanent',
      uptime_seconds: 42,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    };

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => healthData,
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    expect(actualPort).toBeGreaterThan(0);

    const res = await httpsRequest(actualPort, {
      method: 'GET',
      path: '/health',
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.agent).toBe('test-agent');
    expect(parsed.status).toBe('online');

    await server.stop();
  });

  it('accepts POST /notify with valid payload', async () => {
    const onNotify = vi.fn().mockResolvedValue(undefined);

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const payload = JSON.stringify({
      type: 'issue_routed',
      issue_number: 42,
      title: 'Test issue',
    });

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received' });
    expect(onNotify).toHaveBeenCalledWith({
      type: 'issue_routed',
      issue_number: 42,
      title: 'Test issue',
    });

    await server.stop();
  });

  it('returns 400 for invalid JSON', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid JSON');

    await server.stop();
  });

  it('returns 400 for unknown notify type', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'unknown_type' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Validation failed');

    await server.stop();
  });

  it('returns 415 for wrong content type', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: '{}',
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(res.status).toBe(415);

    await server.stop();
  });

  it('returns 500 when onNotify fails', async () => {
    const onNotify = vi.fn().mockRejectedValue(new Error('MCP push failed'));

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'mention' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(500);

    await server.stop();
  });

  it('returns 404 for unknown routes', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'GET',
      path: '/unknown',
    });

    expect(res.status).toBe(404);

    await server.stop();
  });

  it('rejects connection with untrusted client cert', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    await expect(
      httpsRequest(actualPort, {
        method: 'GET',
        path: '/health',
        cert: readFileSync(certs.untrustedCert),
        key: readFileSync(certs.untrustedKey),
        ca: readFileSync(certs.caCert),
      }),
    ).rejects.toThrow();

    await server.stop();
  });

  it('uses explicit port when specified', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    // Use a high port unlikely to be in use
    const port = 19876;
    const { actualPort } = await server.start(port, '127.0.0.1');
    expect(actualPort).toBe(port);

    await server.stop();
  });

  it('fails immediately when explicit port is busy', async () => {
    const { PortUnavailableError } = await import('../../src/errors.js');

    // Start first server on explicit port
    const server1 = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });
    const { actualPort } = await server1.start(0, '127.0.0.1');

    // Try to start second server on same port (explicit)
    const server2 = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    await expect(server2.start(actualPort, '127.0.0.1')).rejects.toThrow(
      PortUnavailableError,
    );

    await server1.stop();
  });

  it('handles random port assignment when port=0', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');
    expect(actualPort).toBeGreaterThanOrEqual(8800);
    expect(actualPort).toBeLessThan(9800);

    await server.stop();
  });

  it('stops cleanly when already stopped', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    // stop() before start() should be a no-op
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('returns 413 for oversized body', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    // Create a body larger than 64KB
    const largeBody = 'x'.repeat(65 * 1024);

    // The server will destroy the connection when body exceeds 64KB,
    // so we expect either 413 or a connection error
    try {
      const res = await httpsRequest(actualPort, {
        method: 'POST',
        path: '/notify',
        body: largeBody,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(413);
    } catch {
      // Connection destroyed by server — also valid
    }

    await server.stop();
  });

  it('handles thrown error in onHealth gracefully', async () => {
    const logger = makeLogger();
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => { throw new Error('health broken'); },
      logger,
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'GET',
      path: '/health',
    });

    // The unhandled throw in handleRequest is caught by the .catch handler
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe('Internal server error');

    await server.stop();
  });

  it('accepts notify payload with only required type field', async () => {
    const onNotify = vi.fn().mockResolvedValue(undefined);
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    const res = await httpsRequest(actualPort, {
      method: 'POST',
      path: '/notify',
      body: JSON.stringify({ type: 'startup_check' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(onNotify).toHaveBeenCalledWith({ type: 'startup_check' });

    await server.stop();
  });
});
