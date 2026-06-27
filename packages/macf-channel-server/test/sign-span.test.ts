/**
 * Unit-level span-attribute test for the POST /sign SignCsr SERVER span
 * (groundnuty/macf#611).
 *
 * Regression guard: the SignCsr span's `gen_ai.agent.name` attribute must
 * carry the kebab routing-label (`code-agent`), never the SCREAMING_SNAKE
 * registry-key form (`CODE_AGENT`) — the macf#590 convention. The CSR
 * `agent_name` can arrive in either form depending on the caller, so the
 * handler normalizes it via `fromVariableSegment` before stamping the span.
 *
 * Lives outside test/e2e/ (so it runs under the default `make check`
 * vitest pass) but uses the same real-TLS + InMemorySpanExporter harness
 * as test/e2e/a2a-traceparent-e2e.test.ts — the SignCsr span only exists
 * on the live HTTP request path, so there is no smaller seam to assert.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createHttpsServer } from '../src/https.js';
import { SpanNames, GenAiAttr } from '../src/tracing.js';
import type { HealthResponse, Logger, SignRequest } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './e2e/fixtures/gen-certs.js';

let certs: TestCerts;
let spanExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function httpsRequest(
  port: number,
  options: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
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
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function startServer(
  onSign: (req: SignRequest) => Promise<Record<string, unknown>>,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn(),
    onHealth: () => ({}) as HealthResponse,
    onSign,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  return { port: actualPort, stop: () => server.stop() };
}

/** Issue a /sign step-1 request and return the captured SignCsr span's agent name. */
async function signAndReadSpanAgentName(agentName: string): Promise<string | undefined> {
  const onSign = vi.fn().mockResolvedValue({
    challenge_id: '123e4567-e89b-42d3-a456-556642440000',
    instruction: 'write challenge value to registry',
  });
  const { port, stop } = await startServer(onSign);
  try {
    const res = await httpsRequest(port, {
      method: 'POST',
      path: '/macf/sign',
      body: JSON.stringify({ csr: 'dummy-csr', agent_name: agentName }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    // SimpleSpanProcessor exports synchronously on span.end() (the
    // handler's finally block), so the span is finished by the time the
    // HTTP response returns.
    const spans = spanExporter.getFinishedSpans();
    const signSpan = spans.find((s) => s.name === SpanNames.SignCsr);
    expect(
      signSpan,
      `expected a ${SpanNames.SignCsr} span; got: ${spans.map((s) => s.name).join(', ')}`,
    ).toBeDefined();
    return signSpan!.attributes[GenAiAttr.AgentName] as string | undefined;
  } finally {
    await stop();
  }
}

beforeAll(() => {
  certs = generateTestCerts();
  // Install an in-memory tracer provider so getTracer('macf') in
  // https.ts emits spans we can introspect. getTracer() resolves the
  // provider per-call, so a beforeAll registration reaches the handler.
  spanExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  cleanupTestCerts(certs);
});

beforeEach(() => {
  spanExporter.reset();
});

describe('POST /sign SignCsr span gen_ai.agent.name (macf#611)', () => {
  it('normalizes a SCREAMING_SNAKE registry-key agent_name to the kebab routing-label', async () => {
    const agentName = await signAndReadSpanAgentName('CODE_AGENT');
    expect(agentName).toBe('code-agent');
  });

  it('passes an already-kebab agent_name through unchanged (fromVariableSegment is idempotent)', async () => {
    const agentName = await signAndReadSpanAgentName('cv-architect');
    expect(agentName).toBe('cv-architect');
  });
});
