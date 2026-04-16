import { createServer, type Server as NodeHttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { NotifyPayloadSchema, SignRequestSchema } from './types.js';
import type { NotifyPayload, SignRequest, HealthResponse, HttpsServer, Logger } from './types.js';
import { PortExhaustedError, PortUnavailableError, HttpsServerError } from './errors.js';

const MAX_BODY_BYTES = 64 * 1024; // 64KB
export const PORT_RANGE_START = 8800;
export const PORT_RANGE_SIZE = 1000;
const MAX_PORT_ATTEMPTS = 10;

interface NodeError extends Error {
  readonly code?: string;
}

// Exported for tests (#109 H1). Uses crypto.randomInt (CSPRNG)
// rather than a weak PRNG — port numbers aren't secrets, but the
// canonical defensive pattern for random in security-adjacent code
// paths is the CSPRNG.
export function randomPort(): number {
  return PORT_RANGE_START + randomInt(PORT_RANGE_SIZE);
}

function sendJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(
  req: import('node:http').IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !settled) {
        settled = true;
        req.destroy();
        reject(new HttpsServerError('Body too large'));
        return;
      }
      if (!settled) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function createHttpsServer(config: {
  readonly caCertPath: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly onNotify: (payload: NotifyPayload) => Promise<void>;
  readonly onHealth: () => HealthResponse;
  readonly onSign?: (request: SignRequest) => Promise<Record<string, unknown>>;
  readonly logger: Logger;
}): HttpsServer {
  const { onNotify, onHealth, onSign, logger } = config;

  const tlsOptions = {
    key: readFileSync(config.agentKeyPath),
    cert: readFileSync(config.agentCertPath),
    ca: readFileSync(config.caCertPath),
    requestCert: true,
    rejectUnauthorized: true,
  };

  let server: NodeHttpsServer | undefined;

  async function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    // Defense-in-depth: reject at HTTP level even if TLS handshake passed.
    // Protects against misconfigured rejectUnauthorized during debugging.
    const tlsSocket = req.socket as TLSSocket;
    if (!tlsSocket.authorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      const health = onHealth();
      const clientCn = (req.socket as import('node:tls').TLSSocket)
        .getPeerCertificate()?.subject?.CN;
      logger.info('health_pinged', { from_cn: clientCn ?? 'unknown' });
      sendJson(res, 200, health as unknown as Record<string, unknown>);
      return;
    }

    if (method === 'POST' && url === '/notify') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'Body too large (max 64KB)' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const result = NotifyPayloadSchema.safeParse(parsed);
      if (!result.success) {
        sendJson(res, 400, { error: `Validation failed: ${result.error.message}` });
        return;
      }

      try {
        await onNotify(result.data);
        sendJson(res, 200, { status: 'received' });
      } catch (err) {
        logger.error('notify_push_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: 'Failed to push notification' });
      }
      return;
    }

    if (method === 'POST' && url === '/sign') {
      if (!onSign) {
        sendJson(res, 503, { error: 'Signing not available on this agent' });
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'Body too large (max 64KB)' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const result = SignRequestSchema.safeParse(parsed);
      if (!result.success) {
        sendJson(res, 400, { error: `Validation failed: ${result.error.message}` });
        return;
      }

      try {
        const response = await onSign(result.data);
        sendJson(res, 200, response);
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;
        sendJson(res, status, {
          error: err instanceof Error ? err.message : 'Signing failed',
        });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  function listenOnPort(
    srv: NodeHttpsServer,
    port: number,
    host: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeError): void => {
        srv.removeListener('error', onError);
        reject(err);
      };
      srv.on('error', onError);
      srv.listen(port, host, () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        resolve(actualPort);
      });
    });
  }

  function requestHandler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    handleRequest(req, res).catch((err) => {
      logger.error('request_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  }

  return {
    async start(port: number, host: string): Promise<{ readonly actualPort: number }> {
      server = createServer(tlsOptions, requestHandler);

      // Explicit port: fail immediately if busy
      if (port !== 0) {
        try {
          const actualPort = await listenOnPort(server, port, host);
          return { actualPort };
        } catch (err) {
          const nodeErr = err as NodeError;
          if (nodeErr.code === 'EADDRINUSE') {
            throw new PortUnavailableError(port);
          }
          throw new HttpsServerError(
            `Failed to start server: ${nodeErr.message}`,
          );
        }
      }

      // Random port: retry up to MAX_PORT_ATTEMPTS times
      for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
        const candidatePort = randomPort();
        try {
          const actualPort = await listenOnPort(server, candidatePort, host);
          return { actualPort };
        } catch (err) {
          const nodeErr = err as NodeError;
          if (nodeErr.code !== 'EADDRINUSE') {
            throw new HttpsServerError(
              `Failed to start server: ${nodeErr.message}`,
            );
          }
          // Close and recreate server for retry
          await new Promise<void>((r) => server!.close(() => r()));
          server = createServer(tlsOptions, requestHandler);
        }
      }

      throw new PortExhaustedError();
    },

    async stop(): Promise<void> {
      if (!server) return;

      return new Promise((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(new HttpsServerError(`Failed to stop server: ${err.message}`));
          else resolve();
        });
      });
    },
  };
}
