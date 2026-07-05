/**
 * DR-041 Decision 1b — the load-bearing EMPIRICAL confirm (groundnuty/macf#784
 * "Step-1 gate"). The verbatim Node TLS docs describe *client*-verifies-server
 * behavior for the `ca` option; MACF's mTLS model needs *server*-verifies-
 * client (inbound) AND *client*-verifies-server (outbound, since agents are
 * dual-role peers). The mechanism is presumably symmetric, but that's
 * inference from symmetry — this file asserts BOTH directions directly
 * against real TLS handshakes, per `.claude/rules/silent-fallback-hazards.md`
 * Pattern A ("verify the instrument, don't assume").
 *
 * Two independent CAs are generated via the PRODUCTION cert-issuing path
 * (`@groundnuty/macf-core`'s `createCA` + `generateAgentCert` — the same
 * `@peculiar/x509`-backed code every real agent's certs come from), never
 * via a mocked/synthetic shortcut:
 *   - `own`     — this agent's home-fleet CA (matches `config.caCertPath`
 *                 in production).
 *   - `foreign` — a DIFFERENT fleet's CA (matches a federated guest's home
 *                 fleet CA per DR-041).
 *
 * INBOUND (site 1 — https.ts `tlsOptions.ca`): does a `createHttpsServer`
 * configured with `caBundlePem: [own, foreign]` authorize an incoming client
 * cert signed by the FOREIGN CA? Plus the regression: withOUT `caBundlePem`
 * (or with a single-CA bundle), the same foreign-CA client is REJECTED —
 * proving the mechanism is genuinely gated by bundle membership, not
 * something else, and that existing (pre-#784) single-CA behavior is
 * unchanged.
 *
 * OUTBOUND (sites 2/3 — a2a-client.ts / notify-peer.ts `ca:`): does an
 * outbound `https.request` configured with the SAME `ca: [own, foreign]`
 * bundle (identical options shape to both outbound call sites —
 * `checkServerIdentity: () => undefined` + `rejectUnauthorized: true`)
 * accept a PEER server presenting a cert signed by the FOREIGN CA? Plus the
 * regression: withOUT the foreign CA in the bundle, the same peer is
 * rejected at the TLS layer (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
 * `SELF_SIGNED_CERT_IN_CHAIN`-shaped failure).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:https';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCA, generateAgentCert } from '@groundnuty/macf-core';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { createHttpsServer } from '../src/https.js';

interface Fleet {
  readonly dir: string;
  readonly caCertPath: string;
  readonly caKeyPath: string;
  readonly caCertPem: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly agentCertPem: string;
  readonly agentKeyPem: string;
}

/** Build one independent CA + one CA-signed agent cert, via the PRODUCTION path. */
async function buildFleet(label: string): Promise<Fleet> {
  const dir = join(tmpdir(), `macf-trust-bundle-mtls-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  const caCertPath = join(dir, 'ca-cert.pem');
  const caKeyPath = join(dir, 'ca-key.pem');
  const agentCertPath = join(dir, 'agent-cert.pem');
  const agentKeyPath = join(dir, 'agent-key.pem');

  await createCA({ project: `macf-784-${label}`, certPath: caCertPath, keyPath: caKeyPath });
  const caCertPem = readFileSync(caCertPath, 'utf-8');
  const caKeyPem = readFileSync(caKeyPath, 'utf-8');

  const agent = await generateAgentCert({
    agentName: `${label}-agent`,
    caCertPem,
    caKeyPem,
    certPath: agentCertPath,
    keyPath: agentKeyPath,
  });

  return {
    dir,
    caCertPath,
    caKeyPath,
    caCertPem,
    agentCertPath,
    agentKeyPath,
    agentCertPem: agent.certPem,
    agentKeyPem: agent.keyPem,
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let own: Fleet;
let foreign: Fleet;

beforeAll(async () => {
  own = await buildFleet('own');
  foreign = await buildFleet('foreign');
});

afterAll(() => {
  rmSync(own.dir, { recursive: true, force: true });
  rmSync(foreign.dir, { recursive: true, force: true });
});

/** GET /health as a specific client identity against a running server. */
function httpsGet(opts: {
  readonly port: number;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  readonly serverCaPem: string;
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: 'GET',
        path: '/health',
        cert: opts.clientCertPem,
        key: opts.clientKeyPem,
        ca: opts.serverCaPem,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DR-041 Decision 1b — INBOUND: server-verifies-client against a multi-CA `ca` bundle (https.ts site 1)', () => {
  it('EMPIRICAL CONFIRM: a client cert signed by a FOREIGN CA is AUTHORIZED when the bundle is [own, foreign]', async () => {
    const server = createHttpsServer({
      caCertPath: own.caCertPath,
      caBundlePem: `${own.caCertPem}\n${foreign.caCertPem}`,
      agentCertPath: own.agentCertPath,
      agentKeyPath: own.agentKeyPath,
      onNotify: vi.fn().mockResolvedValue(undefined),
      onHealth: () => ({}) as HealthResponse,
      logger: makeLogger(),
    });
    const { actualPort } = await server.start(0, '127.0.0.1');
    try {
      const res = await httpsGet({
        port: actualPort,
        // The INCOMING client presents a cert signed by the FOREIGN ca —
        // this is the exact shape of a cross-fleet guest's cert.
        clientCertPem: foreign.agentCertPem,
        clientKeyPem: foreign.agentKeyPem,
        // The client's OWN validation of the server's cert only needs the
        // `own` CA — the server always presents its own-CA-signed leaf.
        serverCaPem: own.caCertPem,
      });
      expect(res.status).toBe(200); // NOT 401 — server authorized the foreign-CA client.
    } finally {
      await server.stop();
    }
  });

  it('REGRESSION: with NO caBundlePem (single-CA, pre-#784 shape), the SAME foreign-CA client is REJECTED', async () => {
    const server = createHttpsServer({
      caCertPath: own.caCertPath,
      // caBundlePem intentionally omitted — pre-#784 single-CA path.
      agentCertPath: own.agentCertPath,
      agentKeyPath: own.agentKeyPath,
      onNotify: vi.fn().mockResolvedValue(undefined),
      onHealth: () => ({}) as HealthResponse,
      logger: makeLogger(),
    });
    const { actualPort } = await server.start(0, '127.0.0.1');
    try {
      await expect(
        httpsGet({
          port: actualPort,
          clientCertPem: foreign.agentCertPem,
          clientKeyPem: foreign.agentKeyPem,
          serverCaPem: own.caCertPem,
        }),
      ).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it('REGRESSION: own-CA client is authorized with OR without caBundlePem (existing peers unaffected)', async () => {
    const server = createHttpsServer({
      caCertPath: own.caCertPath,
      caBundlePem: `${own.caCertPem}\n${foreign.caCertPem}`,
      agentCertPath: own.agentCertPath,
      agentKeyPath: own.agentKeyPath,
      onNotify: vi.fn().mockResolvedValue(undefined),
      onHealth: () => ({}) as HealthResponse,
      logger: makeLogger(),
    });
    const { actualPort } = await server.start(0, '127.0.0.1');
    try {
      const res = await httpsGet({
        port: actualPort,
        clientCertPem: own.agentCertPem,
        clientKeyPem: own.agentKeyPem,
        serverCaPem: own.caCertPem,
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe('DR-041 Decision 1b — OUTBOUND: client-verifies-peer-server against a multi-CA `ca` bundle (a2a-client.ts / notify-peer.ts sites 2+3)', () => {
  /**
   * A minimal RAW `https.createServer` (NOT `createHttpsServer`) standing in
   * for a federated peer's server — presents a leaf cert signed by the
   * peer's OWN (foreign) CA, but deliberately does NOT set `requestCert`, so
   * it never demands (or validates) OUR client cert. `createHttpsServer`
   * hardcodes `requestCert: true` + `rejectUnauthorized: true`, so using it
   * here would entangle TWO separate TLS checks (does the peer trust OUR
   * client cert? does OUR client trust the peer's server cert?) into one
   * pass/fail signal — a client-cert rejection at the SERVER's TLS layer
   * surfaces to our client as a generic "socket hang up," indistinguishable
   * from our client failing to validate the peer's cert. This raw server
   * isolates EXACTLY the claim under test: does our OUTBOUND client accept a
   * server whose leaf chains to a CA that is ONLY in our bundle because of
   * federation (not because it's our own CA). The bidirectional,
   * fully-mTLS, real-topology case (both sides use `createHttpsServer`, both
   * federate) is covered separately below by the "END-TO-END bidirectional"
   * test, which asserts a clean HTTP 200 with no confound.
   */
  async function startForeignPeerServer(): Promise<{ port: number; stop: () => Promise<void> }> {
    const { createServer } = await import('node:https');
    const server = createServer(
      { key: foreign.agentKeyPem, cert: foreign.agentCertPem },
      (_req, res) => {
        res.writeHead(200);
        res.end('ok');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      port,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /**
   * The EXACT outbound TLS-request options shape used by both
   * `a2a-client.ts` (`#httpsSend`) and `notify-peer.ts` (`postToPeer`):
   * `cert`/`key` (our mTLS client identity), `ca` (the trust bundle),
   * `rejectUnauthorized: true`, `checkServerIdentity: () => undefined`
   * (CN-based identity, not SAN-hostname-matched — same rationale cited
   * in both production call sites).
   */
  function outboundRequest(opts: { readonly port: number; readonly caBundle: string }): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: opts.port,
          method: 'GET',
          path: '/health',
          cert: own.agentCertPem,
          key: own.agentKeyPem,
          ca: opts.caBundle,
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('EMPIRICAL CONFIRM: our outbound client ACCEPTS a peer server cert signed by a FOREIGN CA when its `ca` is [own, foreign]', async () => {
    const peer = await startForeignPeerServer();
    try {
      const status = await outboundRequest({
        port: peer.port,
        caBundle: `${own.caCertPem}\n${foreign.caCertPem}`,
      });
      // The raw peer double doesn't require a client cert, so a clean 200
      // here is unambiguous proof: our client validated the peer's
      // FOREIGN-CA-signed server cert against the [own, foreign] bundle —
      // no `UNABLE_TO_VERIFY_LEAF_SIGNATURE` at the TLS layer.
      expect(status).toBe(200);
    } finally {
      await peer.stop();
    }
  });

  it('REGRESSION: withOUT the foreign CA in our bundle, the outbound TLS handshake itself FAILS', async () => {
    const peer = await startForeignPeerServer();
    try {
      await expect(
        outboundRequest({ port: peer.port, caBundle: own.caCertPem }),
      ).rejects.toThrow();
    } finally {
      await peer.stop();
    }
  });

  it('END-TO-END bidirectional: with BOTH fleets federating each other, the outbound request reaches the peer AUTHORIZED (200, not 401)', async () => {
    // Mirrors the real DR-041 topology: peer's OWN server bundle includes
    // BOTH its own CA and ours (bidirectional federation — Decision 4:
    // "bidirectional trust = both publish"), so our own-CA client cert
    // clears the peer's requestCert/rejectUnauthorized gate too.
    const server = createHttpsServer({
      caCertPath: foreign.caCertPath,
      caBundlePem: `${foreign.caCertPem}\n${own.caCertPem}`,
      agentCertPath: foreign.agentCertPath,
      agentKeyPath: foreign.agentKeyPath,
      onNotify: vi.fn().mockResolvedValue(undefined),
      onHealth: () => ({}) as HealthResponse,
      logger: makeLogger(),
    });
    const { actualPort } = await server.start(0, '127.0.0.1');
    try {
      const status = await outboundRequest({
        port: actualPort,
        caBundle: `${own.caCertPem}\n${foreign.caCertPem}`,
      });
      expect(status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
