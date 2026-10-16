/**
 * macf#1491 — a wake must not block the event loop. The helper sleeps and
 * verifies for 3-10 s; with a blocking spawn, /notify, /health and the MCP
 * stdio connection all froze for that long (live: fleet doctor --inject's 5 s
 * POST timed out against a delivered probe).
 *
 * A real mTLS HTTPS server (production cert path) whose onNotify mirrors
 * server.ts: push, then fire-and-forget wakeViaTmux. A fake send script
 * stands in for tmux-send-to-claude.sh.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:https';
import { readFileSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCA, generateAgentCert } from '@groundnuty/macf-core';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { createHttpsServer } from '../src/https.js';
import { wakeViaTmux } from '../src/tmux-wake.js';

type Ev = { event: string; data: Record<string, unknown>; at: number };

function makeLogger(): Logger & { readonly events: Ev[] } {
  const events: Ev[] = [];
  const rec = (event: string, data: Record<string, unknown> = {}): void => {
    events.push({ event, data, at: Date.now() });
  };
  return { events, info: vi.fn(rec), warn: vi.fn(rec), error: vi.fn(rec) } as Logger & { readonly events: Ev[] };
}

let dir: string;
let caCertPem: string;
let agentCertPem: string;
let agentKeyPem: string;
let agentCertPath: string;
let agentKeyPath: string;
let caCertPath: string;

beforeAll(async () => {
  dir = join(tmpdir(), `macf-1491-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  caCertPath = join(dir, 'ca-cert.pem');
  const caKeyPath = join(dir, 'ca-key.pem');
  agentCertPath = join(dir, 'agent-cert.pem');
  agentKeyPath = join(dir, 'agent-key.pem');
  await createCA({ project: 'macf-1491', certPath: caCertPath, keyPath: caKeyPath });
  caCertPem = readFileSync(caCertPath, 'utf-8');
  const agent = await generateAgentCert({
    agentName: 'wake-agent',
    caCertPem,
    caKeyPem: readFileSync(caKeyPath, 'utf-8'),
    certPath: agentCertPath,
    keyPath: agentKeyPath,
  });
  agentCertPem = agent.certPem;
  agentKeyPem = agent.keyPem;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function installScript(workspace: string, body: string): void {
  const scripts = join(workspace, '.claude', 'scripts');
  mkdirSync(scripts, { recursive: true });
  const p = join(scripts, 'tmux-send-to-claude.sh');
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
}

function call(port: number, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1', port, method, path,
        cert: agentCertPem, key: agentKeyPem, ca: caCertPem,
        rejectUnauthorized: true, checkServerIdentity: () => undefined,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - t0 }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer<T>(
  workspace: string,
  logger: Logger,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = createHttpsServer({
    caCertPath, agentCertPath, agentKeyPath,
    // Mirrors server.ts deliverNotification: push done, wake not awaited.
    onNotify: async (payload) => {
      void wakeViaTmux(`ping ${String(payload.issue_number)}`, { workspaceDir: workspace, session: 'sess', logger });
    },
    onHealth: () => ({ status: 'online' }) as HealthResponse,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  try {
    return await fn(actualPort);
  } finally {
    await server.stop();
  }
}

const notify = (n: number) => ({ type: 'issue_routed', issue_number: n, title: 't', source: 'test' });

describe('macf#1491 — wake does not block the server', () => {
  it('/notify answers < 1 s and /health answers during a 6 s wake; delivered logs after ~6 s', async () => {
    const ws = join(dir, 'ws-block');
    installScript(ws, '#!/bin/sh\nsleep 6\nexit 0\n');
    const logger = makeLogger();
    await withServer(ws, logger, async (port) => {
      const t0 = Date.now();
      const n = await call(port, 'POST', '/notify', notify(1));
      expect(n.status).toBe(200);
      expect(n.ms).toBeLessThan(1000);

      // The wake is now in flight (≈6 s remaining): /health must still answer.
      expect(logger.events.some((e) => e.event === 'tmux_wake_delivered')).toBe(false);
      const h = await call(port, 'GET', '/health');
      expect(h.status).toBe(200);
      expect(h.ms).toBeLessThan(1000);
      expect(logger.events.some((e) => e.event === 'tmux_wake_delivered')).toBe(false);

      await vi.waitFor(
        () => expect(logger.events.some((e) => e.event === 'tmux_wake_delivered')).toBe(true),
        { timeout: 9000, interval: 100 },
      );
      const delivered = logger.events.find((e) => e.event === 'tmux_wake_delivered');
      expect((delivered?.at ?? 0) - t0).toBeGreaterThanOrEqual(5500);
    });
  }, 20_000);

  it('two quick /notify calls run the script twice, in order, never overlapping', async () => {
    const ws = join(dir, 'ws-order');
    const trace = join(dir, 'order.log');
    installScript(
      ws,
      `#!/bin/sh\necho "start $2" >> "${trace}"\nsleep 0.4\necho "end $2" >> "${trace}"\nexit 0\n`,
    );
    const logger = makeLogger();
    await withServer(ws, logger, async (port) => {
      expect((await call(port, 'POST', '/notify', notify(1))).status).toBe(200);
      expect((await call(port, 'POST', '/notify', notify(2))).status).toBe(200);
      await vi.waitFor(
        () => expect(logger.events.filter((e) => e.event === 'tmux_wake_delivered')).toHaveLength(2),
        { timeout: 8000, interval: 50 },
      );
    });
    expect(readFileSync(trace, 'utf-8').trim().split('\n')).toEqual([
      'start ping 1', 'end ping 1', 'start ping 2', 'end ping 2',
    ]);
  }, 20_000);
});

describe('macf#1491 — failures still log their event', () => {
  it('non-zero exit → tmux_wake_failed nonzero_exit with stderr', async () => {
    const ws = join(dir, 'ws-fail');
    installScript(ws, '#!/bin/sh\necho boom >&2\nexit 3\n');
    const logger = makeLogger();
    expect(await wakeViaTmux('x', { workspaceDir: ws, session: 's', logger })).toBe(false);
    const ev = logger.events.find((e) => e.event === 'tmux_wake_failed');
    expect(ev?.data['reason']).toBe('nonzero_exit');
    expect(ev?.data['status']).toBe(3);
    expect(String(ev?.data['stderr'])).toContain('boom');
  });

  it('a prompt that makes spawn throw (a NUL byte) resolves false and never rejects', async () => {
    const ws = join(dir, 'ws-nul');
    installScript(ws, '#!/bin/sh\nexit 0\n');
    const logger = makeLogger();
    await expect(wakeViaTmux('bad\u0000prompt', { workspaceDir: ws, session: 'nul', logger })).resolves.toBe(false);
    const ev = logger.events.find((e) => e.event === 'tmux_wake_failed');
    expect(ev?.data['reason']).toBe('spawn_error');
    // The queue for that pane is not wedged.
    expect(await wakeViaTmux('fine', { workspaceDir: ws, session: 'nul', logger })).toBe(true);
  });

  it('timeout → tmux_wake_failed spawn_error ETIMEDOUT, and the queue is not wedged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ws = join(dir, 'ws-timeout');
      installScript(ws, '#!/bin/sh\nexec sleep 30\n');
      const logger = makeLogger();
      const p = wakeViaTmux('x', { workspaceDir: ws, session: 'to', logger });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await p).toBe(false);
      const ev = logger.events.find((e) => e.event === 'tmux_wake_failed');
      expect(ev?.data['reason']).toBe('spawn_error');
      expect(String(ev?.data['error'])).toContain('ETIMEDOUT');

      installScript(ws, '#!/bin/sh\nexit 0\n');
      expect(await wakeViaTmux('y', { workspaceDir: ws, session: 'to', logger })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
