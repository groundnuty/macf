/**
 * macf#1480 — the AgentCard must advertise the port the server actually
 * bound. With config port 0 (OS-assigned) a card built at startup named
 * `:0`, so a client following the card's URL could never connect.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'node:https';
import { createHttpsServer } from '../src/https.js';
import { buildAgentCard } from '../src/agent-card.js';
import { A2aClient } from '../src/a2a-client.js';
import { A2A_ENDPOINT_PATH } from '../src/a2a-types.js';
import { TaskStore } from '../src/a2a-task.js';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './e2e/fixtures/gen-certs.js';

let certs: TestCerts;
const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// Mirrors the builder server.ts passes: the card is built from the bound port.
const cardFor = (boundPort: number) =>
  buildAgentCard({
    agentName: 'code-agent',
    agentRole: 'code-agent',
    project: 'macf',
    url: `https://127.0.0.1:${boundPort}`,
    version: '0.0.0-test',
  });

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1', port, path, method: 'GET',
        cert: readFileSync(certs.agentCert), key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert), rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(() => { certs = generateTestCerts(); });
afterAll(() => { cleanupTestCerts(certs); });

describe('AgentCard advertises the bound port (macf#1480)', () => {
  it('port 0: card URL names the OS-assigned port, and a client using only that URL completes message/send', async () => {
    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: async () => {},
      onHealth: () => ({}) as HealthResponse,
      agentCardFor: cardFor,
      taskStore: new TaskStore(),
      logger: logger(),
    });
    const { actualPort } = await server.start(0, '127.0.0.1');
    try {
      expect(actualPort).toBeGreaterThan(0);
      const card = JSON.parse(await get(actualPort, '/.well-known/agent-card.json'));
      const advertised: string = card.supportedInterfaces[0].url;
      expect(advertised).toBe(`https://127.0.0.1:${actualPort}${A2A_ENDPOINT_PATH}`);
      expect(advertised).not.toContain(':0/');

      // Stable for the process lifetime: a second fetch returns the same URL.
      const again = JSON.parse(await get(actualPort, '/.well-known/agent-card.json'));
      expect(again.supportedInterfaces[0].url).toBe(advertised);

      const client = new A2aClient({
        mTlsClientCertPem: readFileSync(certs.agentCert, 'utf-8'),
        mTlsClientKeyPem: readFileSync(certs.agentKey, 'utf-8'),
        caCertPem: readFileSync(certs.caCert, 'utf-8'),
      });
      try {
        // The client appends the endpoint path itself, so hand it the card
        // URL minus that path: nothing but the card supplies host and port.
        const base = advertised.slice(0, -A2A_ENDPOINT_PATH.length);
        const task = await client.sendMessage(base, {
          messageId: 'msg-1480', role: 'ROLE_USER', parts: [{ text: 'hello' }],
        });
        expect(task.id).toBeTruthy();
      } finally {
        client.close?.();
      }
    } finally {
      await server.stop();
    }
  });

  it('server.ts builds the card from the bound port, not config.port (source tripwire)', () => {
    // server.ts has no startup harness; pin the wiring textually.
    const src = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');
    const start = src.indexOf('const agentCardFor = (boundPort: number)');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 600);
    expect(block).toContain('${boundPort}');
    expect(block).not.toContain('config.port');
    expect(src).toMatch(/^\s+agentCardFor,$/m);
  });
});
