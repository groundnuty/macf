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
}

function runHook(prompt: string, opts: { curlExit?: number } = {}): RunResult {
  const stubDir = makeStubCurlDir();
  const captureFile = join(stubDir, 'capture.json');
  try {
    const res = spawnSync('bash', [HOOK_SCRIPT], {
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
        CURL_CAPTURE: captureFile,
        CURL_EXIT: String(opts.curlExit ?? 0),
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://orzech-dev-agents-monitoring.tail491af.ts.net:4318',
        OTEL_SERVICE_NAME: 'macf-agent-code-agent',
      },
    });
    return {
      status: res.status,
      stderr: res.stderr ?? '',
      capture: existsSync(captureFile) ? readFileSync(captureFile, 'utf-8') : null,
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
