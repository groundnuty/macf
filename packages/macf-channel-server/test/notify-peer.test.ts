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

const { notifyPeer, createNotifyOutboxSend } = await import('../src/notify-peer.js');
const { createOutbox } = await import('../src/delivery/outbox.js');
const { createInMemoryOutboxStore } = await import('../src/delivery/in-memory-store.js');

interface FakeRegistry {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  registerConditional: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const fakeLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

/**
 * DR-038 Slice B: `notifyPeer()` now sends THROUGH a durable outbox
 * (persist-then-send) instead of dispatching directly — `NotifyPeerDeps`
 * requires `outbox` + `outboxAttempts`. Wiring a REAL in-memory-backed
 * outbox here (via the actual production `createNotifyOutboxSend` adapter,
 * not a re-mocked stand-in) means every existing test in this file
 * exercises the real DR-038 wiring end-to-end while still only touching
 * `node:https` at the mock boundary — the same boundary these tests
 * already assumed.
 *
 * `extra` overrides (e.g. `a2aClient`, `recordLedgerEdge`) MUST be folded
 * in BEFORE `createNotifyOutboxSend` is called, not spread onto the
 * returned object afterward — the outbox's `send` adapter closes over the
 * deps object passed to `createNotifyOutboxSend` at construction time, so
 * a later `{ ...makeDeps(reg), a2aClient }`-style override would silently
 * never reach the adapter (it patches a copy, not the closed-over original).
 */
function makeDeps(reg: FakeRegistry, extra: Record<string, unknown> = {}) {
  const base = {
    registry: reg as unknown as Parameters<typeof notifyPeer>[0]['registry'],
    selfAgentName: 'self-agent',
    // macf#790 Gap 2: the canonical cross-fleet reply-to slug — wired here
    // exactly the way server.ts wires it (`${config.project}/${config.routingLabel}`).
    selfReplyTo: 'self-project/self-agent',
    mTlsClientCertPem: 'test-cert',
    mTlsClientKeyPem: 'test-key',
    caCertPem: 'test-ca',
    logger: fakeLogger as unknown as Parameters<typeof notifyPeer>[0]['logger'],
    ...extra,
  };
  const { send, lastAttempts } = createNotifyOutboxSend(base);
  const outbox = createOutbox({ store: createInMemoryOutboxStore(), send });
  return { ...base, outbox, outboxAttempts: lastAttempts };
}

function makeRegistry(opts: {
  get?: Awaited<ReturnType<FakeRegistry['get']>>;
  list?: Awaited<ReturnType<FakeRegistry['list']>>;
}): FakeRegistry {
  const list = opts.list ?? [];
  return {
    // DR-038 Slice B: the outbox's send adapter re-resolves EVERY attempt
    // (including the immediate first one) via `registry.get(target)` — not
    // just at the initial `resolveTargetPeers` call — so a real Registry's
    // `get` must be able to find anything `list` can (both are views into
    // the same underlying store; re-resolving at send time is deliberate,
    // to pick up a peer's host/port changing across a retry gap). When the
    // test wired an explicit `get` value, honor it verbatim (preserves
    // every pre-DR-038 single-peer-mode test exactly); otherwise fall back
    // to a list-member lookup by name — mirrors realistic registry
    // semantics for the broadcast-mode tests, which only ever wired `list`.
    get: vi.fn().mockImplementation(async (name: string) => {
      if (opts.get !== undefined) return opts.get;
      const found = list.find((p) => p.name === name);
      return found?.info ?? null;
    }),
    list: vi.fn().mockResolvedValue(list),
    register: vi.fn(),
    registerConditional: vi.fn(),
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

  describe('reply_to (macf#790 Gap 2 — cross-fleet reply-to slug)', () => {
    it('legacy POST carries reply_to equal to the wired <project>/<name> slug', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'session-end',
        message: 'hi',
      });
      const body = JSON.parse(lastPostedBody!);
      expect(body.reply_to).toBe('self-project/self-agent');
      // source stays the bare routing label (back-compat) — reply_to is
      // the NEW, unambiguous field, not a replacement.
      expect(body.source).toBe('self-agent');
    });

    it('uses whatever selfReplyTo the deps wire in (not hardcoded)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg, { selfReplyTo: 'icsoc-2026/science-agent' }), {
        to: 'peer-a',
        event: 'session-end',
      });
      const body = JSON.parse(lastPostedBody!);
      expect(body.reply_to).toBe('icsoc-2026/science-agent');
    });

    it('the A2A outbound Message carries reply_to in metadata (mirrors github_anchor)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      const a2aClient = { getAgentCard, sendMessage };
      await notifyPeer(
        makeDeps(reg, {
          a2aClient: a2aClient as unknown as Parameters<typeof notifyPeer>[0]['a2aClient'],
          selfReplyTo: 'icsoc-2026/science-agent',
        }),
        { to: 'peer-a', event: 'turn-complete' },
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const sentMessage = sendMessage.mock.calls[0]![1] as { metadata: Record<string, unknown> };
      expect(sentMessage.metadata['reply_to']).toBe('icsoc-2026/science-agent');
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

  describe('DR-041 Amendment A — cross-fleet guest addressing (macf#786)', () => {
    const guestInfo = { host: '10.0.0.5', port: 8443, type: 'permanent' as const, instance_id: 'inst-guest', started: 't' };

    it('rung 1 — federated guest slug resolves via resolveCrossProjectAgent and is ATTEMPTED (not peers_attempted:0)', async () => {
      const reg = makeRegistry({ get: null }); // own-project registry never used on this path
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(guestInfo);
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(
        makeDeps(reg, { federatedCas: ['ppam-2026'], resolveCrossProjectAgent }),
        { to: 'ppam-2026/code-agent', event: 'session-end' },
      );
      expect(result).toEqual({
        delivered: true,
        channel_state: 'online',
        peers_attempted: 1,
        peers_delivered: 1,
      });
      expect(resolveCrossProjectAgent).toHaveBeenCalledWith('ppam-2026', 'code-agent');
      // Dispatch actually targeted the GUEST's resolved host:port, not the
      // own-project registry.
      expect(lastPostedOptions?.['hostname']).toBe('10.0.0.5');
      expect(lastPostedOptions?.['port']).toBe(8443);
      expect(reg.get).not.toHaveBeenCalled();
    });

    it('rung 2 — home fleet NOT in federated_cas → clear error, no silent peers_attempted:0', async () => {
      const reg = makeRegistry({ get: null });
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(guestInfo);
      const result = await notifyPeer(
        makeDeps(reg, { federatedCas: [], resolveCrossProjectAgent }),
        { to: 'ppam-2026/code-agent', event: 'session-end' },
      );
      expect(result).toEqual({
        delivered: false,
        // macf#790 Gap 1: this is an address-RESOLUTION failure, not a real
        // outage — 'no-peer-resolved', not 'offline' (which would misread as
        // "my own channel-server is down").
        channel_state: 'no-peer-resolved',
        peers_attempted: 0,
        peers_delivered: 0,
        error:
          "guest ppam-2026/code-agent: home fleet 'ppam-2026' not in federated_cas — " +
          'federate it (DR-041) to message this guest.',
      });
      expect(resolveCrossProjectAgent).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('rung 3 — home fleet federated but the guest\'s registry slot is missing → not-found error', async () => {
      const reg = makeRegistry({ get: null });
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(null);
      const result = await notifyPeer(
        makeDeps(reg, { federatedCas: ['ppam-2026'], resolveCrossProjectAgent }),
        { to: 'ppam-2026/code-agent', event: 'session-end' },
      );
      expect(result).toEqual({
        delivered: false,
        // macf#790 Gap 1 — see rung-2 comment above.
        channel_state: 'no-peer-resolved',
        peers_attempted: 0,
        peers_delivered: 0,
        error: 'guest ppam-2026/code-agent not found in registry.',
      });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('rung 4 — a bare own-project name is unaffected by federatedCas/resolveCrossProjectAgent being wired (regression)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(guestInfo);
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(
        makeDeps(reg, { federatedCas: ['ppam-2026'], resolveCrossProjectAgent }),
        { to: 'peer-a', event: 'session-end' },
      );
      expect(result).toEqual({
        delivered: true,
        channel_state: 'online',
        peers_attempted: 1,
        peers_delivered: 1,
      });
      expect(reg.get).toHaveBeenCalledWith('peer-a');
      expect(resolveCrossProjectAgent).not.toHaveBeenCalled();
    });

    it('omitting federatedCas/resolveCrossProjectAgent entirely degrades a guest slug to the rung-2 not-federated error (never a crash)', async () => {
      const reg = makeRegistry({ get: null });
      const result = await notifyPeer(makeDeps(reg), {
        to: 'ppam-2026/code-agent',
        event: 'session-end',
      });
      expect(result.error).toBe(
        "guest ppam-2026/code-agent: home fleet 'ppam-2026' not in federated_cas — " +
          'federate it (DR-041) to message this guest.',
      );
      // macf#790 Gap 1
      expect(result.channel_state).toBe('no-peer-resolved');
    });

    it('the A2A outbound path dispatches to a resolved guest exactly like an own-project peer (same resolved-peer object)', async () => {
      const reg = makeRegistry({ get: null });
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(guestInfo);
      const agentCard = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC' as const, url: 'https://10.0.0.5:8443' }],
      };
      const a2aClient = {
        getAgentCard: vi.fn().mockResolvedValue(agentCard),
        sendMessage: vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } }),
      };
      const result = await notifyPeer(
        makeDeps(reg, { federatedCas: ['ppam-2026'], resolveCrossProjectAgent, a2aClient }),
        { to: 'ppam-2026/code-agent', event: 'custom', message: 'hi' },
      );
      expect(result).toEqual({
        delivered: true,
        channel_state: 'online',
        peers_attempted: 1,
        peers_delivered: 1,
      });
      expect(a2aClient.sendMessage).toHaveBeenCalledWith(
        'https://10.0.0.5:8443',
        expect.anything(),
        expect.anything(),
      );
    });

    it('a LATER outbox retry re-resolves the guest via resolveCrossProjectAgent again (guest-aware across retries, not just the first attempt)', async () => {
      const reg = makeRegistry({ get: null });
      const resolveCrossProjectAgent = vi.fn().mockResolvedValue(guestInfo);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const deps = makeDeps(reg, { federatedCas: ['ppam-2026'], resolveCrossProjectAgent });
      const first = await notifyPeer(deps, { to: 'ppam-2026/code-agent', event: 'session-end' });
      expect(first.channel_state).toBe('offline');
      // Called TWICE already on the first `notifyPeer()` call — once by
      // `resolveTargetPeers` (initial ladder evaluation) + once more by the
      // outbox's `send` adapter re-resolving at SEND time (DR-038 Slice B's
      // "persist-then-send" fires an immediate `driveOnce()` inline). This
      // mirrors the pre-#786 own-project `registry.get()` double-call shape
      // exactly — not a regression this change introduces.
      expect(resolveCrossProjectAgent).toHaveBeenCalledTimes(2);

      // The entry survived in the outbox (Decision 4) — a later driveOnce()
      // tick (simulating the periodic ticker, past the backoff window) re-
      // resolves the SAME guest slug a THIRD time, proving retry-time
      // resolution is guest-aware too, not just the first attempt.
      nextHttpsRespondsWith(200);
      await deps.outbox.driveOnce(Date.now() + 60_000);
      expect(resolveCrossProjectAgent).toHaveBeenCalledTimes(3);
      expect(resolveCrossProjectAgent).toHaveBeenNthCalledWith(3, 'ppam-2026', 'code-agent');
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
      return makeDeps(reg, { a2aClient });
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

  // macf#473 piece 2: the outbound SEND edge site. Unlike the recv sites,
  // recordEdge runs AFTER the dispatch (so `delivered` reflects the actual
  // send result), inside the `invoke_agent` span.
  describe('comms-ledger outbound send edge (macf#473)', () => {
    function depsWithLedger(
      reg: FakeRegistry,
      recordLedgerEdge: ReturnType<typeof vi.fn>,
      extra: Record<string, unknown> = {},
    ) {
      return makeDeps(reg, { recordLedgerEdge, ...extra });
    }

    it('records one send edge per peer over the legacy path with delivered=true on HTTP 200', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const recordLedgerEdge = vi.fn();
      nextHttpsRespondsWith(200);
      await notifyPeer(depsWithLedger(reg, recordLedgerEdge), {
        to: 'peer-a',
        event: 'turn-complete',
        message: 'wrapped up #34',
        github_anchor: 'groundnuty/macf#34',
      });
      expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
      const edge = recordLedgerEdge.mock.calls[0]![0];
      expect(edge).toMatchObject({
        from: 'self-agent',
        to: 'peer-a',
        // direct-vs-router: a notify_peer send is always DIRECT peer-to-peer
        // (legacy /notify POST or a2a-client) — never the router — so `a2a`.
        channel: 'a2a',
        direction: 'send',
        event: 'turn-complete',
        intent_summary: 'wrapped up #34',
        github_anchor: 'groundnuty/macf#34',
        delivered: true,
        processed: null,
      });
      // a generated msg_id for the legacy path (no natural A2A id)
      expect(typeof edge.msg_id).toBe('string');
      expect(edge.msg_id.length).toBeGreaterThan(0);
    });

    it('records delivered=false when the legacy peer returns non-200', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const recordLedgerEdge = vi.fn();
      nextHttpsRespondsWith(500); // peer alive but rejected
      await notifyPeer(depsWithLedger(reg, recordLedgerEdge), { to: 'peer-a', event: 'error' });
      expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
      expect(recordLedgerEdge.mock.calls[0]![0]).toMatchObject({
        delivered: false,
        event: 'error',
        github_anchor: null, // omitted → null
      });
    });

    it('records delivered=false on transport error (peer unreachable)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const recordLedgerEdge = vi.fn();
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      await notifyPeer(depsWithLedger(reg, recordLedgerEdge), { to: 'peer-a', event: 'session-end' });
      expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
      expect(recordLedgerEdge.mock.calls[0]![0]).toMatchObject({ delivered: false });
    });

    it('records the A2A message id as msg_id + channel=a2a on the A2A path', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      const recordLedgerEdge = vi.fn();
      const a2aClient = { getAgentCard, sendMessage };
      await notifyPeer(
        depsWithLedger(reg, recordLedgerEdge, {
          a2aClient: a2aClient as unknown as Parameters<typeof notifyPeer>[0]['a2aClient'],
        }),
        { to: 'peer-a', event: 'turn-complete', github_anchor: 'g/m#7' },
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);
      // The Message constructed for the A2A send carries the messageId we record.
      const sentMessage = sendMessage.mock.calls[0]![1] as { messageId: string; metadata: Record<string, unknown> };
      expect(recordLedgerEdge).toHaveBeenCalledTimes(1);
      const edge = recordLedgerEdge.mock.calls[0]![0];
      expect(edge).toMatchObject({
        channel: 'a2a',
        direction: 'send',
        msg_id: sentMessage.messageId,
        delivered: true,
        github_anchor: 'g/m#7',
      });
      // github_anchor also rides the outbound A2A Message metadata for the receiver.
      expect(sentMessage.metadata['github_anchor']).toBe('g/m#7');
    });

    it('records delivered=false when the A2A peer REJECTED the message', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const card = {
        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9000' }],
      };
      const getAgentCard = vi.fn().mockResolvedValue(card);
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_REJECTED' } });
      const recordLedgerEdge = vi.fn();
      const a2aClient = { getAgentCard, sendMessage };
      await notifyPeer(
        depsWithLedger(reg, recordLedgerEdge, {
          a2aClient: a2aClient as unknown as Parameters<typeof notifyPeer>[0]['a2aClient'],
        }),
        { to: 'peer-a', event: 'turn-complete' },
      );
      expect(recordLedgerEdge.mock.calls[0]![0]).toMatchObject({ channel: 'a2a', delivered: false });
    });

    it('is a clean no-op when recordLedgerEdge is omitted (back-compat)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      // makeDeps() has no recordLedgerEdge — must still deliver fine.
      const result = await notifyPeer(makeDeps(reg), { to: 'peer-a', event: 'turn-complete' });
      expect(result.peers_delivered).toBe(1);
    });
  });

  // macf#590: the outbound `invoke_agent` span's `gen_ai.agent.name` (sourced
  // from the sendMessage `target` opt) must be the kebab routing-label, NOT
  // the SCREAMING_SNAKE registry-key suffix that `Registry.list()` returns.
  // The `target` opt is telemetry-only (it becomes the span name +
  // gen_ai.agent.name); the actual A2A dispatch uses the peer base URL.
  describe('invoke_agent gen_ai.agent.name is the kebab routing-label (macf#590)', () => {
    function a2aCard() {
      return {
        supportedInterfaces: [
          { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://127.0.0.1:9001' },
        ],
      };
    }
    function makeA2aDeps(reg: FakeRegistry, sendMessage: ReturnType<typeof vi.fn>) {
      const a2aClient = { getAgentCard: vi.fn().mockResolvedValue(a2aCard()), sendMessage };
      return makeDeps(reg, { a2aClient });
    }

    it('broadcast: passes the kebab routing-label, not the registry-key suffix', async () => {
      // Registry.list() returns GitHub-Variables-canonical names (uppercased,
      // hyphens-to-underscores) — e.g. 'DEVOPS_AGENT'. Pre-fix this leaked
      // straight onto the span as gen_ai.agent.name='DEVOPS_AGENT'.
      const reg = makeRegistry({
        list: [
          { name: 'DEVOPS_AGENT', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' } },
        ],
      });
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      await notifyPeer(makeA2aDeps(reg, sendMessage), { event: 'turn-complete' });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const opts = sendMessage.mock.calls[0]![2] as { target?: string };
      expect(opts.target).toBe('devops-agent');
      expect(opts.target).not.toBe('DEVOPS_AGENT');
      expect(opts.target).not.toMatch(/[A-Z_]/); // no SCREAMING_SNAKE / underscore
      expect(opts.target?.startsWith('MACF_')).toBe(false);
    });

    it('single-peer: normalizes an uppercase `to` to the kebab routing-label', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      await notifyPeer(makeA2aDeps(reg, sendMessage), { to: 'CODE_AGENT', event: 'turn-complete' });
      const opts = sendMessage.mock.calls[0]![2] as { target?: string };
      expect(opts.target).toBe('code-agent');
    });

    it('single-peer: leaves an already-kebab `to` unchanged (idempotent)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const sendMessage = vi.fn().mockResolvedValue({ id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
      await notifyPeer(makeA2aDeps(reg, sendMessage), { to: 'science-agent', event: 'turn-complete' });
      const opts = sendMessage.mock.calls[0]![2] as { target?: string };
      expect(opts.target).toBe('science-agent');
    });
  });

  describe('DR-038 Slice B — durable outbox wiring (groundnuty/macf#704)', () => {
    /** Same as `makeDeps`, but also returns the underlying store + outbox so
     * these tests can assert on outbox STATE across separate `driveOnce()`
     * ticks — simulating the periodic `outbox-ticker.ts` retry-drive that
     * runs independently of any single `notifyPeer()` call in production. */
    function makeDepsWithStore(reg: FakeRegistry) {
      const base = {
        registry: reg as unknown as Parameters<typeof notifyPeer>[0]['registry'],
        selfAgentName: 'self-agent',
        selfReplyTo: 'self-project/self-agent',
        mTlsClientCertPem: 'test-cert',
        mTlsClientKeyPem: 'test-key',
        caCertPem: 'test-ca',
        logger: fakeLogger as unknown as Parameters<typeof notifyPeer>[0]['logger'],
      };
      const { send, lastAttempts } = createNotifyOutboxSend(base);
      const store = createInMemoryOutboxStore();
      const outbox = createOutbox({ store, send });
      return { deps: { ...base, outbox, outboxAttempts: lastAttempts }, store };
    }

    it('persist-then-send (Decision 1): by the time the HTTP transport fires, the entry is already durable in the store', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const { deps, store } = makeDepsWithStore(reg);
      let pendingAtSendTime: number | undefined;
      requestMock.mockImplementationOnce((...args: unknown[]) => {
        const cb = args[1] as ((res: EventEmitter & { statusCode: number; resume: () => void }) => void);
        const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
        req.write = () => undefined;
        req.end = () => {
          // Read store state at the moment the transport layer is invoked
          // (synchronously, before the response even fires) — the outbox
          // already `await`ed `store.enqueue()` before calling this `send`
          // function, so the entry MUST already be durable here.
          void store.listPending().then((p) => { pendingAtSendTime = p.length; });
          const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
          res.statusCode = 200;
          res.resume = () => undefined;
          cb(res);
          Promise.resolve().then(() => res.emit('end'));
        };
        req.destroy = () => undefined;
        return req;
      });

      await notifyPeer(deps, { to: 'peer-a', event: 'session-end' });
      expect(pendingAtSendTime).toBe(1); // durably persisted BEFORE the send attempt
    });

    it('a failed first attempt leaves the entry pending in the outbox for a LATER retry (Decision 4 restart-survival)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const { deps, store } = makeDepsWithStore(reg);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));

      const result = await notifyPeer(deps, { to: 'peer-a', event: 'session-end' });
      expect(result.channel_state).toBe('offline');

      // The message SURVIVES the failed attempt — it's still in the outbox,
      // not dropped, ready for the next retry tick.
      const pending = await store.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.attemptCount).toBe(1);
      expect(pending[0]?.target).toBe('peer-a');
    });

    it('a LATER driveOnce() tick (simulating the periodic ticker) retries + delivers the survived entry', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const { deps, store } = makeDepsWithStore(reg);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      await notifyPeer(deps, { to: 'peer-a', event: 'session-end' });
      expect(await store.listPending()).toHaveLength(1);

      // Simulate the periodic outbox-ticker's next tick, independent of any
      // further notifyPeer() call — the peer is back up now.
      nextHttpsRespondsWith(200);
      const summary = await deps.outbox.driveOnce(Date.now() + 60_000);

      expect(summary.acked).toBe(1);
      expect(await store.listPending()).toHaveLength(0);
    });

    it('reuses the SAME message-id across the failed attempt and the later successful retry (Decision 2)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const { deps, store } = makeDepsWithStore(reg);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      await notifyPeer(deps, { to: 'peer-a', event: 'session-end' });
      const [entryAfterFailure] = await store.listPending();
      const idAfterFailure = entryAfterFailure?.id;
      expect(typeof idAfterFailure).toBe('string');

      let postedId: string | undefined;
      requestMock.mockImplementationOnce((...args: unknown[]) => {
        const cb = args[1] as ((res: EventEmitter & { statusCode: number; resume: () => void }) => void);
        const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void; destroy: () => void };
        req.write = (body: string) => {
          postedId = (JSON.parse(body) as { message_id?: string }).message_id;
        };
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
          res.statusCode = 200;
          res.resume = () => undefined;
          cb(res);
          Promise.resolve().then(() => res.emit('end'));
        };
        req.destroy = () => undefined;
        return req;
      });
      await deps.outbox.driveOnce(Date.now() + 60_000);

      expect(postedId).toBe(idAfterFailure);
    });

    it('the legacy wire payload carries the outbox message_id (dedup key)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      await notifyPeer(makeDeps(reg), { to: 'peer-a', event: 'session-end' });
      const body = JSON.parse(lastPostedBody!);
      expect(typeof body.message_id).toBe('string');
      expect(body.message_id.length).toBeGreaterThan(0);
    });
  });
});

// vitest's `beforeEach` is per-describe by default; declare top-level here too.
import { beforeEach } from 'vitest';
