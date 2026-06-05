import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Mock node:https.request — capture call args + control the response /
 * error path per test. Returned via vi.mock factory below; tests inspect
 * `requestMock` directly.
 *
 * The mock returns an EventEmitter for the request, a similar emitter
 * for the response, and accepts `.write()` / `.end()` no-op calls.
 * Tests trigger response or error by emitting on the captured emitters.
 */
const requestMock = vi.fn();
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const { notifyPeer } = await import('../src/notify-peer.js');

interface FakeRegistry {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const fakeLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeDeps(reg: FakeRegistry) {
  return {
    registry: reg as unknown as Parameters<typeof notifyPeer>[0]['registry'],
    selfAgentName: 'self-agent',
    mTlsClientCertPem: 'test-cert',
    mTlsClientKeyPem: 'test-key',
    caCertPem: 'test-ca',
    logger: fakeLogger as unknown as Parameters<typeof notifyPeer>[0]['logger'],
  };
}

function makeRegistry(opts: {
  get?: Awaited<ReturnType<FakeRegistry['get']>>;
  list?: Awaited<ReturnType<FakeRegistry['list']>>;
}): FakeRegistry {
  return {
    get: vi.fn().mockResolvedValue(opts.get ?? null),
    list: vi.fn().mockResolvedValue(opts.list ?? []),
    register: vi.fn(),
    remove: vi.fn(),
  };
}

/**
 * Drive the next https.request call to return statusCode `code` synchronously.
 * The notifyPeer code does `req.on('error')` → resolve, or invokes the
 * callback with res. We simulate the latter; res.resume() + res.on('end')
 * are called after a microtask.
 */
/** Captures the most recent POST body for assertion in tests. */
let lastPostedBody: string | undefined;
/** Captures the most recent POST request options (headers, etc.) — macf#267 traceparent test. */
let lastPostedOptions: Record<string, unknown> | undefined;

function nextHttpsRespondsWith(statusCode: number): void {
  requestMock.mockImplementationOnce((...args: unknown[]) => {
    lastPostedOptions = args[0] as Record<string, unknown>;
    const cb = args[1] as ((res: EventEmitter & { statusCode: number; resume: () => void }) => void);
    const req = new EventEmitter() as EventEmitter & {
      write: (body: string) => void; end: () => void; destroy: () => void;
    };
    req.write = (body: string) => { lastPostedBody = body; };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number; resume: () => void;
      };
      res.statusCode = statusCode;
      res.resume = () => undefined;
      cb(res);
      // Microtask-defer the end so callback's res.on('end') registers first.
      Promise.resolve().then(() => res.emit('end'));
    };
    req.destroy = () => undefined;
    return req;
  });
}

function nextHttpsErrorsWith(error: Error): void {
  requestMock.mockImplementationOnce((..._args: unknown[]) => {
    const req = new EventEmitter() as EventEmitter & {
      write: () => void; end: () => void; destroy: () => void;
    };
    req.write = () => undefined;
    req.end = () => {
      Promise.resolve().then(() => req.emit('error', error));
    };
    req.destroy = () => undefined;
    return req;
  });
}

describe('notify_peer tool', () => {
  beforeEach(() => {
    requestMock.mockReset();
    lastPostedBody = undefined;
    lastPostedOptions = undefined;
  });

  describe('OTel + traceparent (macf#267 Findings 3+4)', () => {
    it('outbound POST request options include headers map', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), { to: 'peer-a', event: 'session-end' });
      expect(lastPostedOptions).toBeDefined();
      const headers = lastPostedOptions!['headers'] as Record<string, string>;
      expect(headers).toBeDefined();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Content-Length']).toBeDefined();
      // Note: traceparent is only injected by propagation.inject() when
      // a span context is active. In unit tests without a configured
      // tracer provider, the inject is a no-op (no traceparent key).
      // Real-world behavior is verified via the integration test path
      // (testbed re-bootstrap → trace evidence on macf#256).
      // The presence of the headers OBJECT (not undefined) confirms
      // the inject site is reachable.
    });

    it('uses 5s timeout (macf#267 Finding 1 fix; was 1s in v0.2.3)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), { to: 'peer-a', event: 'session-end' });
      expect(lastPostedOptions!['timeout']).toBe(5000);
    });
  });

  describe('payload shape (macf#256 Bug 2)', () => {
    it('POSTs type=peer_notification (not the input.event)', async () => {
      // Regression: v0.2.2 sent `type: input.event` (e.g., "session-end")
      // which isn't a valid NotifyType → /notify HTTP 400. v0.2.3 sends
      // the dedicated `peer_notification` type with hook-event in a
      // separate `event` field.
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'session-end',
        message: 'tester-1 wrapped up',
      });
      expect(lastPostedBody).toBeDefined();
      const body = JSON.parse(lastPostedBody!);
      expect(body.type).toBe('peer_notification');
      expect(body.event).toBe('session-end');
      expect(body.source).toBe('self-agent');
      expect(body.message).toBe('tester-1 wrapped up');
    });

    it('omits optional fields when not provided', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'turn-complete',
      });
      const body = JSON.parse(lastPostedBody!);
      expect(body.type).toBe('peer_notification');
      expect(body.event).toBe('turn-complete');
      expect('message' in body).toBe(false);
      expect('context' in body).toBe(false);
    });
  });

  describe('wake field absent (macf#355)', () => {
    // After macf#355, sender NEVER sets `wake` on the wire — receiver-side
    // `decideWake()` reads `event` directly. Pin: outbound POST body must
    // not carry `wake` regardless of the call shape (operator-driven
    // event=custom, autonomous event=session-end, or anything else).

    it('omits wake on outbound POST for event: custom (operator-driven)', async () => {
      // macf#355: receiver wakes on event=custom alone; no wake flag needed.
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'custom',
        message: 'operator-driven notify',
      });
      const body = JSON.parse(lastPostedBody!);
      expect('wake' in body).toBe(false);
    });

    it('omits wake on outbound POST for event: session-end (Pattern E preserved)', async () => {
      // Regression: hooks.json's Stop entry posts event=session-end.
      // Receiver MUST discriminate by event alone (skip wake →
      // cross-agent Stop-hook loop stays structurally prevented).
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'session-end',
      });
      const body = JSON.parse(lastPostedBody!);
      expect('wake' in body).toBe(false);
    });
  });

  describe('single-peer mode (`to` provided)', () => {
    it('returns offline when peer is not registered', async () => {
      const reg = makeRegistry({ get: null });
      const result = await notifyPeer(makeDeps(reg), {
        to: 'missing-peer',
        event: 'session-end',
      });
      expect(result).toEqual({
        delivered: false,
        channel_state: 'offline',
        peers_attempted: 0,
        peers_delivered: 0,
      });
      expect(reg.get).toHaveBeenCalledWith('missing-peer');
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('returns delivered when peer responds 200', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'session-end',
        message: 'bye',
      });
      expect(result).toEqual({
        delivered: true,
        channel_state: 'online',
        peers_attempted: 1,
        peers_delivered: 1,
      });
    });

    it('returns delivered=false when peer responds non-200 (peer alive but rejected)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(500);
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'error',
      });
      expect(result.delivered).toBe(false);
      expect(result.channel_state).toBe('online'); // transport ok, peer alive
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
    });

    it('returns offline when transport fails', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-dead',
        event: 'session-end',
      });
      expect(result.channel_state).toBe('offline');
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
    });

    it('returns offline immediately when `to` references self (cycle prevention)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const result = await notifyPeer(makeDeps(reg), {
        to: 'self-agent', // matches selfAgentName in deps
        event: 'session-end',
      });
      expect(result.peers_attempted).toBe(0);
      expect(reg.get).not.toHaveBeenCalled(); // short-circuit before registry lookup
    });

    it('self-exclusion uses toVariableSegment normalization (macf#256 Bug 1)', async () => {
      // Regression: registry's list() returns names in GitHub Variables
      // canonical form (uppercased, hyphens-to-underscores). Single-peer
      // mode's `to` arg may also arrive in either form. Self-check must
      // compare normalized strings.
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      // selfAgentName in deps is 'self-agent' (canonical); the variable-
      // form equivalent would be 'SELF_AGENT'. Test that passing 'SELF_AGENT'
      // also short-circuits as self.
      const result = await notifyPeer(makeDeps(reg), {
        to: 'SELF_AGENT',
        event: 'session-end',
      });
      expect(result.peers_attempted).toBe(0);
      expect(reg.get).not.toHaveBeenCalled();
    });
  });

  describe('broadcast mode (`to` absent)', () => {
    it('returns offline+0 when no peers registered', async () => {
      const reg = makeRegistry({ list: [] });
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result).toEqual({
        delivered: false,
        channel_state: 'offline',
        peers_attempted: 0,
        peers_delivered: 0,
      });
    });

    it('excludes self from broadcast (cycle prevention)', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'self-agent', info: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' } },
        ],
      });
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(0);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('excludes self when registry returns variable-format name (macf#256 Bug 1)', async () => {
      // Regression: real-world Registry.list() returns names like
      // 'MACF_TESTER_1_AGENT' (uppercased + underscored per
      // toVariableSegment) — comparison against the canonical
      // selfAgentName 'self-agent' would never match without
      // normalization, leaking self into the broadcast and triggering
      // the (server, tool, input) deduplication cycle DR-023 warns about.
      const reg = makeRegistry({
        list: [
          // Variable-format equivalent of 'self-agent' is 'SELF_AGENT'
          { name: 'SELF_AGENT', info: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' } },
          { name: 'PEER_B', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'b', started: 't' } },
        ],
      });
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(1); // only PEER_B; SELF_AGENT filtered as self
      expect(result.peers_delivered).toBe(1);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('broadcasts to all non-self peers in parallel; aggregates delivered count', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' } },
          { name: 'peer-b', info: { host: '127.0.0.1', port: 9002, type: 'permanent', instance_id: 'b', started: 't' } },
          { name: 'self-agent', info: { host: '127.0.0.1', port: 9003, type: 'permanent', instance_id: 's', started: 't' } },
        ],
      });
      nextHttpsRespondsWith(200);
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(2);
      expect(result.peers_delivered).toBe(2);
      expect(result.channel_state).toBe('online');
      expect(result.delivered).toBe(true);
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it('partial-success counts as delivered=true (one peer ok, one offline)', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' } },
          { name: 'peer-b', info: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'b', started: 't' } },
        ],
      });
      nextHttpsRespondsWith(200);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(2);
      expect(result.peers_delivered).toBe(1);
      expect(result.delivered).toBe(true);
      expect(result.channel_state).toBe('online'); // at least one transport-ok
    });

    it('returns offline when all peers transport-error', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' } },
        ],
      });
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
      expect(result.channel_state).toBe('offline');
    });
  });

  describe('A2A discovery silent-fallback warns (macf#422 Bug-2)', () => {
    // selectOutboundProtocol's getAgentCard step had two SILENT legacy
    // fallbacks: card===null (peer 404/401/403) + AgentCard-without-JSONRPC-
    // binding. Only the catch (transport/5xx/schema-fail) warned. A 404 is a
    // clean null-return, not an exception — so a stale pre-v0.2.24 peer
    // routed legacy invisibly while notify_peer returned delivered:true.
    // These pin the warn on both quiet branches (symmetric with the catch).
    function depsWithA2a(
      reg: FakeRegistry,
      getAgentCard: ReturnType<typeof vi.fn>,
      sendMessage: ReturnType<typeof vi.fn> = vi.fn(),
    ) {
      const a2aClient = { getAgentCard, sendMessage };
      return {
        ...makeDeps(reg),
        a2aClient: a2aClient as unknown as Parameters<typeof notifyPeer>[0]['a2aClient'],
      };
    }

    it('warns notify_peer_a2a_no_agent_card when getAgentCard returns null, then legacy-falls-back', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const getAgentCard = vi.fn().mockResolvedValue(null);
      nextHttpsRespondsWith(200); // legacy /notify fallback succeeds
      fakeLogger.warn.mockClear();
      const result = await notifyPeer(depsWithA2a(reg, getAgentCard), { to: 'peer-a', event: 'turn-complete' });
      expect(getAgentCard).toHaveBeenCalledTimes(1);
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        'notify_peer_a2a_no_agent_card',
        expect.objectContaining({ peer: 'peer-a' }),
      );
      expect(result.peers_delivered).toBe(1); // legacy path still delivered
    });

    it('warns notify_peer_a2a_no_jsonrpc_binding when AgentCard lacks a JSONRPC binding, then legacy-falls-back', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'GRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      nextHttpsRespondsWith(200);
      fakeLogger.warn.mockClear();
      await notifyPeer(depsWithA2a(reg, getAgentCard), { to: 'peer-a', event: 'turn-complete' });
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        'notify_peer_a2a_no_jsonrpc_binding',
        expect.objectContaining({ peer: 'peer-a', bindings: ['GRPC'] }),
      );
    });

    it('routes a2a (no silent-fallback warn) when AgentCard carries a JSONRPC binding', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      fakeLogger.warn.mockClear();
      const result = await notifyPeer(depsWithA2a(reg, getAgentCard, sendMessage), { to: 'peer-a', event: 'turn-complete' });
      expect(sendMessage).toHaveBeenCalledTimes(1); // A2A path taken, not legacy
      expect(result.peers_delivered).toBe(1);
      expect(fakeLogger.warn).not.toHaveBeenCalledWith('notify_peer_a2a_no_agent_card', expect.anything());
      expect(fakeLogger.warn).not.toHaveBeenCalledWith('notify_peer_a2a_no_jsonrpc_binding', expect.anything());
    });

    it('routes event:custom over A2A too — the custom→legacy carve-out is lifted (macf#428)', async () => {
      // Pre-#428, selectOutboundProtocol forced event:custom → legacy
      // (receiver-wake was only wired on /notify). #428 wired receiver-side
      // decideWake on /a2a/v1, so custom now prefers A2A when the peer
      // supports it; the receiver applies Pattern E (custom → wake).
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      const result = await notifyPeer(
        depsWithA2a(reg, getAgentCard, sendMessage),
        { to: 'peer-a', event: 'custom', message: 'operator-driven' },
      );
      expect(sendMessage).toHaveBeenCalledTimes(1); // custom travels A2A now (was legacy pre-#428)
      expect(result.peers_delivered).toBe(1);
    });
  });
});

// vitest's `beforeEach` is per-describe by default; declare top-level here too.
import { beforeEach } from 'vitest';
