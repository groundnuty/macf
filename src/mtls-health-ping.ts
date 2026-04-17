import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import type { HealthResponse } from './types.js';

/**
 * Shared mTLS /health ping. Used by:
 *
 *   - `src/cli/commands/status.ts` → `macf status` display
 *   - `src/plugin/lib/health.ts`    → `/macf-ping` skill
 *
 * Returns the parsed HealthResponse on 2xx JSON, or `null` on any
 * failure (missing cert files, network error, timeout, bad JSON).
 * Null-on-failure matches both callers' expectations — they render
 * "agent offline" at the UI layer.
 *
 * `src/collision.ts` has its own boolean-returning variant with
 * different failure semantics (an in-process collision check, not a
 * user-facing status fetch) — intentionally not folded into this
 * shared helper. See ultrareview finding A3 for the dedup rationale.
 */
export async function pingAgentHealth(config: {
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

const DEFAULT_TIMEOUT_MS = 5000;
