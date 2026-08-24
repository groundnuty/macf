/**
 * macf#1144: Node's built-in global `fetch` does not honor
 * HTTP_PROXY/HTTPS_PROXY by default (unlike `gh`, whose Go `net/http`
 * reads the env natively). `proxyAwareFetch` threads an explicit `undici`
 * `ProxyAgent` dispatcher through so every GitHub-API call site in this
 * codebase works behind an operator's forward proxy.
 *
 * The decisive pair (per `assert-the-wrong-path.md`): a "the call
 * succeeded" assertion is NOT decisive on a machine with direct egress —
 * it passes identically whether or not the proxy was actually used. This
 * suite instead:
 *   1. Targets a host that is GUARANTEED unresolvable directly (the
 *      `.invalid` TLD is reserved by RFC 2606 for exactly this) — so a
 *      request that reaches a real answer can only have gotten there
 *      THROUGH the configured proxy, never by accident.
 *   2. Uses a real local CONNECT-tunneling proxy relaying to a real local
 *      backend — proving actual routing, not merely that a ProxyAgent
 *      object was constructed and handed to fetch() (construction alone
 *      doesn't prove undici's fetch actually consulted it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolveProxyUrl, proxyAwareFetch } from '../src/proxy-fetch.js';

const UNROUTABLE_TARGET = 'http://definitely-does-not-resolve.invalid/probe';

/** A real backend that answers regardless of the Host header it receives —
 *  proves the request that reached it was for the (unresolvable) target,
 *  tunneled through the proxy, not a request that happened to land here
 *  some other way. */
async function startBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`BACKEND-OK host=${String(req.headers.host)} url=${req.url ?? ''}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A minimal CONNECT-tunneling forward proxy. Relays EVERY tunnel to the
 *  given backend regardless of the requested CONNECT target — this models
 *  "the proxy is the only thing that can reach the real destination"
 *  without needing genuine outbound network access in the test. */
async function startProxy(backendPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((clientSocket) => {
    clientSocket.once('data', (chunk) => {
      const line = chunk.toString('utf-8').split('\r\n')[0] ?? '';
      if (!line.startsWith('CONNECT')) {
        clientSocket.end();
        return;
      }
      const backendSocket = net.connect(backendPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('proxyAwareFetch — decisive pair (macf#1144)', () => {
  let savedEnv: Record<string, string | undefined>;
  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

  beforeEach(() => {
    savedEnv = {};
    for (const key of PROXY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('1) WITH proxy env set, the request is actually routed through the configured proxy dispatcher', async () => {
    const backend = await startBackend();
    const proxy = await startProxy(backend.port);
    try {
      process.env['HTTP_PROXY'] = `http://127.0.0.1:${String(proxy.port)}`;

      const res = await proxyAwareFetch(UNROUTABLE_TARGET, { signal: AbortSignal.timeout(4000) });
      const body = await res.text();

      expect(res.status).toBe(200);
      // The backend saw the ORIGINAL unresolvable hostname in the Host
      // header — proof the request was tunneled to it through the proxy,
      // not served some other way.
      expect(body).toContain('host=definitely-does-not-resolve.invalid');
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('2) WITHOUT proxy env, behavior is unchanged — the same unroutable target fails exactly as bare fetch() would', async () => {
    // No proxy env set (beforeEach cleared it). The target is
    // RFC-2606-guaranteed unresolvable, so this must fail — and the
    // failure must be a DNS-shaped one (ENOTFOUND/EAI_AGAIN via undici's
    // default dispatcher), never a proxy-connection error, proving
    // proxyAwareFetch took the exact same no-dispatcher path as a bare
    // fetch() call would.
    try {
      await proxyAwareFetch(UNROUTABLE_TARGET, { signal: AbortSignal.timeout(3000) });
      expect.unreachable('expected proxyAwareFetch to throw for an unresolvable host');
    } catch (err) {
      expect((err as Error).message).toMatch(/fetch failed/);
      const cause = (err as Error).cause as { code?: string } | undefined;
      expect(cause?.code).toBe('ENOTFOUND');
    }
  });
});

describe('resolveProxyUrl', () => {
  it('returns undefined when no proxy env is set', () => {
    expect(resolveProxyUrl('https://api.github.com/x', {})).toBeUndefined();
  });

  it('selects HTTPS_PROXY for an https:// target', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:8080', HTTP_PROXY: 'http://wrong.example:8080' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBe('http://proxy.example:8080');
  });

  it('selects HTTP_PROXY for an http:// target', () => {
    const env = { HTTPS_PROXY: 'http://wrong.example:8080', HTTP_PROXY: 'http://proxy.example:8080' };
    expect(resolveProxyUrl('http://api.example.com/x', env)).toBe('http://proxy.example:8080');
  });

  it('accepts lowercase https_proxy / http_proxy variants', () => {
    expect(resolveProxyUrl('https://api.github.com/x', { https_proxy: 'http://lower.example:1' }))
      .toBe('http://lower.example:1');
  });

  it('falls back to ALL_PROXY when no protocol-specific var is set', () => {
    expect(resolveProxyUrl('https://api.github.com/x', { ALL_PROXY: 'http://all.example:1' }))
      .toBe('http://all.example:1');
  });

  it('prefers the protocol-specific var over ALL_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://specific.example:1', ALL_PROXY: 'http://all.example:1' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBe('http://specific.example:1');
  });

  it('NO_PROXY exact-match suppresses proxying for that host', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:1', NO_PROXY: 'api.github.com' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBeUndefined();
  });

  it('NO_PROXY suffix-match suppresses proxying for subdomains', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:1', NO_PROXY: '.internal.example' };
    expect(resolveProxyUrl('https://svc.internal.example/x', env)).toBeUndefined();
  });

  it('NO_PROXY does not suffix-match an unrelated host with the same tail characters', () => {
    // "hub.com" must not accidentally match "api.github.com" via naive
    // string suffix matching (no leading dot boundary).
    const env = { HTTPS_PROXY: 'http://proxy.example:1', NO_PROXY: 'hub.com' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBe('http://proxy.example:1');
  });

  it('NO_PROXY="*" disables proxying for everything', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:1', NO_PROXY: '*' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBeUndefined();
  });

  it('never appears in the resolved value in a form that would be logged accidentally — returns the raw URL for the CALLER to keep private', () => {
    // This test documents the contract (see proxy-fetch.ts module doc):
    // resolveProxyUrl legitimately returns a value that may carry
    // credentials; the guarantee is that this module never logs it, not
    // that the value is redacted. Callers must not log it either.
    const env = { HTTPS_PROXY: 'http://user:secret@proxy.example:1' };
    expect(resolveProxyUrl('https://api.github.com/x', env)).toBe('http://user:secret@proxy.example:1');
  });
});
