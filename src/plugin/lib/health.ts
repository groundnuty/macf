import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import type { HealthResponse } from '../../types.js';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Ping an agent's /health endpoint via mTLS and return the health response.
 * Returns null if the agent is unreachable.
 */
export async function pingAgent(config: {
  readonly host: string;
  readonly port: number;
  readonly caCertPem: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly timeoutMs?: number;
}): Promise<HealthResponse | null> {
  const { host, port, caCertPem, certPath, keyPath, timeoutMs = DEFAULT_TIMEOUT_MS } = config;

  if (!existsSync(certPath) || !existsSync(keyPath)) return null;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'GET',
        path: '/health',
        ca: Buffer.from(caCertPem),
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            resolve(body as HealthResponse);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
