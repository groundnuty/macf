/**
 * Tests for `scripts/emit-turn-receipt.sh` — the UserPromptSubmit turn-ack
 * receipt hook (groundnuty/macf#444 Option D, piece 2).
 *
 * Contract: reads the UserPromptSubmit JSON on stdin. If `.prompt` carries a
 * `[macf-route:<run_id>:<agent>]` marker (injected by the router, piece 1),
 * emit a `turn_processed` OTel span via curl→OTLP carrying (routed_run_id,
 * agent). No marker → no-op (exit 0, no emit). NEVER blocks the turn: every
 * path exits 0; a genuine emit failure WARNs to stderr (fail-loud).
 *
 * The hook shells out to `curl` for the OTLP POST, so the tests prepend a stub
 * `curl` to PATH that captures the request body (`--data-binary @-` → stdin)
 * to a file and exits with a controllable code (mirrors the gh-stub pattern in
 * check-close-keyword.test.ts). No real network.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'emit-turn-receipt.sh');

/** Stub-`curl` dir: captures the POST body to $CURL_CAPTURE, exits $CURL_EXIT. */
function makeStubCurlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-turn-receipt-curl-'));
  const shim = `#!/usr/bin/env bash
# Ignore all curl args; APPEND the --data-binary @- payload (stdin) — one curl
# invocation per marker (macf#462 per-marker emission), so all payloads are
# captured (newline-separated). Exit with the test-controlled code.
{ cat; echo; } >> "\${CURL_CAPTURE:-/dev/null}"
exit "\${CURL_EXIT:-0}"
`;
  writeFileSync(join(dir, 'curl'), shim);
  chmodSync(join(dir, 'curl'), 0o755);
  return dir;
}

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly capture: string | null;
  /** Contents of the DR-030 receipt sink (sibling of MACF_LOG_PATH), or null. */
  readonly receipts: string | null;
}

function runHook(prompt: string, opts: { curlExit?: number; noLogPath?: boolean } = {}): RunResult {
  const stubDir = makeStubCurlDir();
  const captureFile = join(stubDir, 'capture.json');
  // DR-030: point MACF_LOG_PATH at a temp file so the receipt sink lands in
  // stubDir (and overrides any ambient MACF_LOG_PATH so we never touch a real
  // substrate sink). `noLogPath` exercises the graceful unset path.
  const logPath = join(stubDir, 'logs', 'channel.log');
  const receiptSink = join(stubDir, 'logs', 'processed-receipts.jsonl');
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
      CURL_CAPTURE: captureFile,
      CURL_EXIT: String(opts.curlExit ?? 0),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://orzech-dev-agents-monitoring.tail491af.ts.net:4318',
      OTEL_SERVICE_NAME: 'macf-agent-code-agent',
    };
    if (opts.noLogPath) delete env['MACF_LOG_PATH'];
    else env['MACF_LOG_PATH'] = logPath;
    const res = spawnSync('bash', [HOOK_SCRIPT], {
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
      env,
    });
    return {
      status: res.status,
      stderr: res.stderr ?? '',
      capture: existsSync(captureFile) ? readFileSync(captureFile, 'utf-8') : null,
      receipts: existsSync(receiptSink) ? readFileSync(receiptSink, 'utf-8') : null,
    };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('emit-turn-receipt.sh', () => {
  it('no marker → no-op (exit 0, no emit, no WARN)', () => {
    const r = runHook('Please work on issue #5. Run: gh issue view 5');
    expect(r.status).toBe(0);
    expect(r.capture).toBeNull(); // curl never invoked
    expect(r.stderr).not.toMatch(/WARN/);
  });

  it('marker present + emit OK → exit 0, span carries run_id + agent + identity', () => {
    const r = runHook('You were mentioned in #444 [macf-route:27123456:code-agent]');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/WARN/);
    expect(r.capture).not.toBeNull();
    const payload = r.capture!;
    expect(payload).toContain('"name":"turn_processed"');
    expect(payload).toContain('"routed_run_id"');
    expect(payload).toContain('27123456');
    // agent appears as both the span attr and the gen_ai.agent.name resource attr
    expect(payload).toContain('"gen_ai.agent.name"');
    expect(payload).toContain('code-agent');
    expect(payload).toContain('"service.namespace"');
    expect(payload).toContain('macf');
  });

  it('marker present + emit FAILS → exit 0 (never blocks) + WARN with run/agent', () => {
    const r = runHook('Mention [macf-route:99:science-agent]', { curlExit: 22 });
    expect(r.status).toBe(0); // non-blocking even on emit failure
    expect(r.stderr).toMatch(/WARN/);
    expect(r.stderr).toContain('run=99');
    expect(r.stderr).toContain('agent=science-agent');
  });

  it('parses run_id + agent from a marker embedded mid-prompt', () => {
    const r = runHook('prefix text [macf-route:42:devops-agent] trailing');
    expect(r.status).toBe(0);
    expect(r.capture).not.toBeNull();
    expect(r.capture!).toContain('42');
    expect(r.capture!).toContain('devops-agent');
  });

  it('coalesced turn with MULTIPLE markers → a receipt for EACH (macf#462 per-marker)', () => {
    // The bug: `head -1` receipted only the first marker, so the reconciler
    // false-flagged the rest as drops. Per-marker emission gives each its span.
    const r = runHook('mentioned in #444 [macf-route:111:code-agent] and PR #88 [macf-route:222:science-agent]');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/WARN/);
    expect(r.capture).not.toBeNull();
    const payload = r.capture!;
    expect(payload).toContain('111');
    expect(payload).toContain('code-agent');
    expect(payload).toContain('222');
    expect(payload).toContain('science-agent');
    // two distinct turn_processed spans (head -1 would have emitted only one)
    expect(payload.match(/"name":"turn_processed"/g) ?? []).toHaveLength(2);
  });

  it('duplicate marker in one prompt → deduped to a single receipt', () => {
    const r = runHook('[macf-route:55:code-agent] … then again [macf-route:55:code-agent]');
    expect(r.status).toBe(0);
    expect((r.capture ?? '').match(/"name":"turn_processed"/g) ?? []).toHaveLength(1);
  });
});

// --- DR-030 keystone (groundnuty/macf#568): local turn-receipt sink ----------
//
// In ADDITION to the OTLP span, the hook appends one line per marker to
// `$(dirname MACF_LOG_PATH)/processed-receipts.jsonl` so the channel-server's
// /health.last_processed is a real LOCAL self-report (no Tempo round-trip).
describe('emit-turn-receipt.sh — local receipt sink', () => {
  it('marker + MACF_LOG_PATH set → appends one {ts,run_id,agent} line', () => {
    const r = runHook('You were mentioned in #444 [macf-route:123:code-agent]');
    expect(r.status).toBe(0);
    expect(r.receipts).not.toBeNull();
    const lines = r.receipts!.trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as { ts: number; run_id: string; agent: string };
    expect(rec.run_id).toBe('123');
    expect(rec.agent).toBe('code-agent');
    expect(typeof rec.ts).toBe('number');
    expect(Number.isFinite(rec.ts)).toBe(true);
    expect(rec.ts).toBeGreaterThan(0);
  });

  it('no marker → no receipt written', () => {
    const r = runHook('Just a normal typed prompt, no routing marker');
    expect(r.status).toBe(0);
    expect(r.receipts).toBeNull();
  });

  it('missing MACF_LOG_PATH → no crash, no receipt (graceful no-op)', () => {
    const r = runHook('mention [macf-route:7:code-agent]', { noLogPath: true });
    expect(r.status).toBe(0);
    expect(r.receipts).toBeNull();
  });

  it('coalesced turn → one receipt line per distinct marker', () => {
    const r = runHook('[macf-route:111:code-agent] and [macf-route:222:science-agent]');
    expect(r.status).toBe(0);
    const lines = (r.receipts ?? '').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const runIds = lines.map((l) => (JSON.parse(l) as { run_id: string }).run_id).sort();
    expect(runIds).toEqual(['111', '222']);
  });

  it('receipt still lands when the span emit FAILS (additive, not span-gated)', () => {
    const r = runHook('mention [macf-route:88:code-agent]', { curlExit: 22 });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN/); // span emit failed
    expect(r.receipts).not.toBeNull(); // but the local receipt still landed
    const rec = JSON.parse(r.receipts!.trim()) as { run_id: string };
    expect(rec.run_id).toBe('88');
  });
});
