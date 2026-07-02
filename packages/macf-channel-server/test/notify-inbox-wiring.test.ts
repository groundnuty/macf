/**
 * DR-038 Slice B (groundnuty/macf#704) — receiver-side inbox wiring tests.
 *
 * Decision 3's load-bearing claim is an ORDERING guarantee: the HTTP 200 /
 * JSON-RPC result is returned ONLY AFTER `inbox.accept()` (the atomic
 * dedup-and-persist primitive) has resolved. Returning 200 before the
 * persist would make the ACK mean "received" instead of "durably yours" —
 * the exact silent-fallback shape Decision 3 exists to avoid (see
 * `silent-fallback-hazards.md`). These tests PROVE the ordering directly by
 * instrumenting a fake `Inbox` whose `accept()` is artificially delayed and
 * recording the sequence of events against the real HTTP response.
 *
 * Lives outside test/e2e/ (runs under the default `make check` vitest pass)
 * using the same real-TLS harness as `test/sign-span.test.ts` — the ordering
 * claim only holds on the live HTTP/JSON-RPC request path, so there's no
 * smaller seam to assert it at.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../src/https.js';
import { createInbox } from '../src/delivery/inbox.js';
import { createInMemoryInboxStore } from '../src/delivery/in-memory-store.js';
import type { Inbox } from '../src/delivery/inbox.js';
import { TaskStore } from '../src/a2a-task.js';
import type { HealthResponse, Logger, NotifyPayload } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './e2e/fixtures/gen-certs.js';

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
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A delayable Inbox wrapper around the real in-memory-backed createInbox —
 * exercises the ACTUAL accept()/dedup logic (Slice A), with an injectable
 * artificial delay on `accept` so ordering can be observed against the
 * real HTTP response. */
function makeInstrumentedInbox(events: string[], acceptDelayMs = 0): Inbox {
  const real = createInbox({ store: createInMemoryInboxStore() });
  return {
    accept: async (id, payload) => {
      events.push('accept-start');
      if (acceptDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, acceptDelayMs));
      }
      const result = await real.accept(id, payload);
      events.push(result.wasNew ? 'accept-resolved-new' : 'accept-resolved-dedup');
      return result;
    },
    undrained: real.undrained,
    markProcessed: async (id) => {
      await real.markProcessed(id);
      events.push('markProcessed');
    },
  };
}

async function startServer(opts: {
  onNotify: (payload: NotifyPayload) => Promise<void>;
  inbox?: Inbox;
  taskStore?: TaskStore;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: opts.onNotify,
    onHealth: () => ({}) as HealthResponse,
    inbox: opts.inbox,
    taskStore: opts.taskStore,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  return { port: actualPort, stop: () => server.stop() };
}

function notifyBody(messageId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'peer_notification',
    source: 'peer-a',
    event: 'custom',
    message_id: messageId,
    ...extra,
  });
}

beforeAll(() => {
  certs = generateTestCerts();
});

afterAll(() => {
  cleanupTestCerts(certs);
});

describe('POST /notify — DR-038 Decision 3 persist-then-ACK ordering', () => {
  it('the 200 response arrives ONLY AFTER inbox.accept() has resolved (and after processing, in this ordering)', async () => {
    const events: string[] = [];
    const inbox = makeInstrumentedInbox(events, 30);
    const onNotify = vi.fn(async () => { events.push('onNotify'); });
    const { port, stop } = await startServer({ onNotify, inbox });
    try {
      const res = await httpsRequest(port, {
        method: 'POST',
        path: '/notify',
        body: notifyBody('msg-ordering-1'),
        headers: { 'Content-Type': 'application/json' },
      });
      events.push('response-received');

      expect(res.status).toBe(200);
      // The load-bearing ordering: accept-start → accept-resolved (persist)
      // → onNotify (process) → markProcessed → THEN the HTTP response.
      // Never response-received before accept-resolved-new.
      expect(events).toEqual([
        'accept-start',
        'accept-resolved-new',
        'onNotify',
        'markProcessed',
        'response-received',
      ]);
    } finally {
      await stop();
    }
  });

  it('dedup: the SAME message_id delivered twice persists once, processes (onNotify) once, both requests still get 200', async () => {
    const events: string[] = [];
    const inbox = makeInstrumentedInbox(events);
    const onNotify = vi.fn(async () => { events.push('onNotify'); });
    const { port, stop } = await startServer({ onNotify, inbox });
    try {
      const first = await httpsRequest(port, {
        method: 'POST', path: '/notify', body: notifyBody('msg-dedup-1'),
        headers: { 'Content-Type': 'application/json' },
      });
      const second = await httpsRequest(port, {
        method: 'POST', path: '/notify', body: notifyBody('msg-dedup-1'),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200); // Decision 3: "a lost-in-transit 200 is safe... idempotent by construction"
      expect(onNotify).toHaveBeenCalledTimes(1); // NOT re-invoked on redelivery
      expect(events.filter((e) => e === 'accept-resolved-new')).toHaveLength(1);
      expect(events.filter((e) => e === 'accept-resolved-dedup')).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it('back-compat: with NO inbox configured, /notify calls onNotify directly (pre-DR-038 behavior unchanged)', async () => {
    const onNotify = vi.fn(async () => undefined);
    const { port, stop } = await startServer({ onNotify }); // inbox omitted
    try {
      const res = await httpsRequest(port, {
        method: 'POST', path: '/notify', body: notifyBody('msg-no-inbox'),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(onNotify).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });

  it('GitHub-anchored notify types (mention) are OUT of DR-038 scope — never routed through the inbox even when one is configured', async () => {
    const events: string[] = [];
    const inbox = makeInstrumentedInbox(events);
    const onNotify = vi.fn(async () => undefined);
    const { port, stop } = await startServer({ onNotify, inbox });
    try {
      const res = await httpsRequest(port, {
        method: 'POST',
        path: '/notify',
        body: JSON.stringify({ type: 'mention', message: 'hi', issue_number: 1 }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(onNotify).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]); // inbox.accept was never called
    } finally {
      await stop();
    }
  });
});

describe('POST /a2a/v1 message/send — DR-038 inbox wiring (Message.messageId is spec-required, always dedup-eligible)', () => {
  function messageSendBody(id: number, messageId: string): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'message/send',
      params: {
        message: { messageId, role: 'ROLE_USER', parts: [{ text: 'hi' }] },
      },
    });
  }

  it('dedup: the SAME Message.messageId sent twice processes (onNotify) once, both requests still get a 200 JSON-RPC result', async () => {
    const events: string[] = [];
    const inbox = makeInstrumentedInbox(events);
    const onNotify = vi.fn(async () => { events.push('onNotify'); });
    const { port, stop } = await startServer({ onNotify, inbox, taskStore: new TaskStore() });
    try {
      const first = await httpsRequest(port, {
        method: 'POST', path: '/a2a/v1', body: messageSendBody(1, 'a2a-msg-dedup-1'),
        headers: { 'Content-Type': 'application/json' },
      });
      const second = await httpsRequest(port, {
        method: 'POST', path: '/a2a/v1', body: messageSendBody(2, 'a2a-msg-dedup-1'),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((JSON.parse(first.body) as { result?: unknown }).result).toBeDefined();
      expect((JSON.parse(second.body) as { result?: unknown }).result).toBeDefined();
      expect(onNotify).toHaveBeenCalledTimes(1); // NOT re-invoked on redelivery
      expect(events.filter((e) => e === 'accept-resolved-new')).toHaveLength(1);
      expect(events.filter((e) => e === 'accept-resolved-dedup')).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it('back-compat: with NO inbox configured, message/send calls onNotify directly (pre-DR-038 behavior unchanged)', async () => {
    const onNotify = vi.fn(async () => undefined);
    const { port, stop } = await startServer({ onNotify, taskStore: new TaskStore() }); // inbox omitted
    try {
      const res = await httpsRequest(port, {
        method: 'POST', path: '/a2a/v1', body: messageSendBody(1, 'a2a-msg-no-inbox'),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(onNotify).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });
});
