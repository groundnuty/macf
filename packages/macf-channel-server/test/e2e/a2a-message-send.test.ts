/**
 * E2E tests for the A2A v1.0 inbound JSON-RPC endpoint
 * (`POST /a2a/v1`).
 *
 * groundnuty/macf#398 — A2A Phase 2d. Closes the E2E coverage gap for
 * Phase 2a (`message/send`) + extends it with the new Phase 2d methods
 * (`tasks/get`, `tasks/cancel`). Exercises the full request path —
 * mTLS handshake + EKU gate + JSON-RPC envelope dispatch + TaskStore
 * mutation — through a real `node:https` client.
 *
 * Unit-level dispatch tests live in `test/a2a-task.test.ts` +
 * `test/a2a-types.test.ts`; this file pins the integration wiring so
 * the endpoint stays reachable + the response headers stay correct
 * across refactors of https.ts dispatch.
 *
 * Spec references:
 *   - § 4.1.1–4.1.3 (Task / TaskStatus / TaskState)
 *   - § 9 JSON-RPC Protocol Binding
 *   - § 3.6 A2A-Version response header (verified at every response)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHttpsServer } from '../../src/https.js';
import { TaskStore } from '../../src/a2a-task.js';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function httpsPost(
  clientCertPath: string,
  clientKeyPath: string,
  port: number,
  path: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr).toString(),
          ...extraHeaders,
        },
        cert: readFileSync(clientCertPath),
        key: readFileSync(clientKeyPath),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function startServer(opts: { readonly taskStore?: TaskStore } = {}) {
  const onNotify = vi.fn().mockResolvedValue(undefined);
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify,
    onHealth: () => ({}) as HealthResponse,
    taskStore: opts.taskStore,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  // onNotify returned so macf#428 delivery tests can assert it was invoked.
  return { port: actualPort, onNotify, stop: () => server.stop() };
}

beforeAll(() => {
  certs = generateTestCerts();
});

afterAll(() => {
  cleanupTestCerts(certs);
});

describe('A2A /a2a/v1 endpoint E2E (macf#398 Phase 2d)', () => {
  describe('message/send — happy path (macf#390 Phase 2a coverage backfill)', () => {
    it('drives a fresh task to COMPLETED + returns it via JSON-RPC', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'message/send',
          params: {
            message: {
              messageId: 'msg-1',
              role: 'ROLE_USER',
              parts: [{ text: 'hello from E2E' }],
            },
          },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.jsonrpc).toBe('2.0');
        expect(parsed.id).toBe('req-1');
        expect(parsed.result.status.state).toBe('TASK_STATE_COMPLETED');
        expect(parsed.result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
        // Task store has the entry persisted for subsequent tasks/get.
        expect(store.size()).toBe(1);
      } finally {
        await stop();
      }
    });

    it('delivers the message to the agent via onNotify, carrying event=custom → wake (macf#428 Phase 3.5)', async () => {
      const { port, onNotify, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'req-deliver',
          method: 'message/send',
          params: {
            message: {
              messageId: 'msg-deliver',
              role: 'ROLE_USER',
              parts: [{ text: 'phase 3.5 delivery' }],
              metadata: { event: 'custom', source: 'cv-architect' },
            },
          },
        });
        expect(res.status).toBe(200); // protocol exchange still succeeds
        // The message reached the agent's delivery primitive (mcp_push + decideWake).
        expect(onNotify).toHaveBeenCalledTimes(1);
        const payload = onNotify.mock.calls[0]![0] as Record<string, unknown>;
        expect(payload['type']).toBe('peer_notification');
        expect(payload['message']).toBe('phase 3.5 delivery'); // body surfaced
        expect(payload['event']).toBe('custom'); // → decideWake WAKES
        expect(payload['source']).toBe('cv-architect');
      } finally {
        await stop();
      }
    });

    it('omits event (push-only) when the A2A message lacks our metadata keys — macf#428 no-accidental-wake default', async () => {
      const { port, onNotify, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'req-anon',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-anon', role: 'ROLE_USER', parts: [{ text: 'no metadata' }] },
          },
        });
        expect(onNotify).toHaveBeenCalledTimes(1);
        const payload = onNotify.mock.calls[0]![0] as Record<string, unknown>;
        expect('event' in payload).toBe(false); // push-only → no accidental wake from a non-MACF client
        expect(payload['message']).toBe('no metadata');
      } finally {
        await stop();
      }
    });

    it('emits A2A-Version: 1.0 header (spec § 3.6)', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'req-2',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-2', role: 'ROLE_USER', parts: [{ text: 'x' }] },
          },
        });
        expect(res.headers['a2a-version']).toBe('1.0');
      } finally {
        await stop();
      }
    });

    it('returns -32601 Method not found for unknown method', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'req-3',
          method: 'message/stream', // out-of-scope; Phase 3.5+
          params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x' }] } },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.error.code).toBe(-32601);
        expect(parsed.error.data.reason).toBe('METHOD_NOT_SUPPORTED');
      } finally {
        await stop();
      }
    });
  });

  describe('tasks/get — Phase 2d', () => {
    it('returns a previously-created Task by id', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        // First create a task via message/send
        const sendRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'send-1',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-send', role: 'ROLE_USER', parts: [{ text: 'x' }] },
          },
        });
        const { id: taskId } = JSON.parse(sendRes.body).result;
        // Then fetch it back via tasks/get
        const getRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'get-1',
          method: 'tasks/get',
          params: { id: taskId },
        });
        expect(getRes.status).toBe(200);
        const parsed = JSON.parse(getRes.body);
        expect(parsed.id).toBe('get-1');
        expect(parsed.result.id).toBe(taskId);
        expect(parsed.result.status.state).toBe('TASK_STATE_COMPLETED');
      } finally {
        await stop();
      }
    });

    it('accepts proto-canonical `{ name: "tasks/<id>" }` form', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        const sendRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'send-2',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-send-2', role: 'ROLE_USER', parts: [{ text: 'x' }] },
          },
        });
        const { id: taskId } = JSON.parse(sendRes.body).result;
        const getRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'get-name',
          method: 'tasks/get',
          params: { name: `tasks/${taskId}` },
        });
        const parsed = JSON.parse(getRes.body);
        expect(parsed.result.id).toBe(taskId);
      } finally {
        await stop();
      }
    });

    it('returns TASK_NOT_FOUND error envelope on unknown id', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'get-missing',
          method: 'tasks/get',
          params: { id: 'nonexistent-uuid' },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.error.code).toBe(-32602);
        expect(parsed.error.data.reason).toBe('TASK_NOT_FOUND');
        expect(parsed.error.data.domain).toBe('a2a-protocol.org');
      } finally {
        await stop();
      }
    });

    it('returns INVALID_PARAMS when neither id nor name is supplied', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'get-bad',
          method: 'tasks/get',
          params: { metadata: { hint: 'x' } },
        });
        const parsed = JSON.parse(res.body);
        expect(parsed.error.code).toBe(-32602);
        expect(parsed.error.message).toMatch(/Invalid tasks\/get params/);
      } finally {
        await stop();
      }
    });
  });

  describe('tasks/cancel — Phase 2d', () => {
    it('cancels a SUBMITTED task + returns CANCELED state', async () => {
      // Manually pre-populate the store with a SUBMITTED task that we
      // can cancel before the route happy-path drives it through.
      const store = new TaskStore();
      const initialMsg = {
        messageId: 'pre-msg',
        role: 'ROLE_USER' as const,
        parts: [{ text: 'pre' }],
      };
      const created = store.create(initialMsg, { nowIso: new Date().toISOString() });

      const { port, stop } = await startServer({ taskStore: store });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'cancel-1',
          method: 'tasks/cancel',
          params: { id: created.id },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.result.id).toBe(created.id);
        expect(parsed.result.status.state).toBe('TASK_STATE_CANCELED');
        // Verify the store actually mutated.
        expect(store.get(created.id)?.status.state).toBe('TASK_STATE_CANCELED');
        expect(store.isTerminal(created.id)).toBe(true);
      } finally {
        await stop();
      }
    });

    it('returns TASK_TERMINAL_STATE on attempt to cancel COMPLETED task', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        // Drive a task to COMPLETED via message/send first.
        const sendRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'send-c',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-c', role: 'ROLE_USER', parts: [{ text: 'x' }] },
          },
        });
        const { id: taskId } = JSON.parse(sendRes.body).result;
        // Now try to cancel it.
        const cancelRes = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'cancel-bad',
          method: 'tasks/cancel',
          params: { id: taskId },
        });
        const parsed = JSON.parse(cancelRes.body);
        expect(parsed.error.code).toBe(-32602);
        expect(parsed.error.data.reason).toBe('TASK_TERMINAL_STATE');
      } finally {
        await stop();
      }
    });

    it('returns TASK_NOT_FOUND error envelope on unknown id', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'cancel-missing',
          method: 'tasks/cancel',
          params: { id: 'nonexistent-uuid' },
        });
        const parsed = JSON.parse(res.body);
        expect(parsed.error.code).toBe(-32602);
        expect(parsed.error.data.reason).toBe('TASK_NOT_FOUND');
      } finally {
        await stop();
      }
    });

    it('emits A2A-Version header on cancel response too (spec § 3.6 invariant)', async () => {
      const store = new TaskStore();
      const created = store.create(
        { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x' }] },
        { nowIso: new Date().toISOString() },
      );
      const { port, stop } = await startServer({ taskStore: store });
      try {
        const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
          jsonrpc: '2.0',
          id: 'cancel-hdr',
          method: 'tasks/cancel',
          params: { id: created.id },
        });
        expect(res.headers['a2a-version']).toBe('1.0');
      } finally {
        await stop();
      }
    });
  });

  describe('Method dispatch — no behavior change to existing methods', () => {
    it('still rejects out-of-scope methods (message/stream, tasks/subscribe, etc.)', async () => {
      const { port, stop } = await startServer({ taskStore: new TaskStore() });
      try {
        for (const method of ['tasks/subscribe', 'message/stream', 'agent/getExtendedCard']) {
          const res = await httpsPost(certs.agentCert, certs.agentKey, port, '/a2a/v1', {
            jsonrpc: '2.0',
            id: `m-${method}`,
            method,
            params: {},
          });
          const parsed = JSON.parse(res.body);
          expect(parsed.error.code).toBe(-32601);
          expect(parsed.error.data.reason).toBe('METHOD_NOT_SUPPORTED');
        }
      } finally {
        await stop();
      }
    });
  });
});
