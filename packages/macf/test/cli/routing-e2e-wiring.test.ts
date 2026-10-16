/**
 * Wiring tests for the PRODUCTION `gh` seams in `routing-e2e-gh.ts`: a fake
 * `gh` executable first on PATH records its argv and REJECTS any request that
 * would be a POST (`-f` fields without `--method GET`) — which is exactly what
 * the real `gh api` would do. Injected fakes elsewhere never execute this seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouterRunFinder, createRouterRunLister } from '../../src/cli/commands/routing-e2e-gh.js';
import { runRoutingE2eCore, type RoutingE2eDeps, type RoutingE2eRouterRun } from '../../src/cli/commands/routing-e2e.js';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';

const RUNS_JSON = JSON.stringify([
  { id: 11, conclusion: 'success', status: 'completed', created_at: '2099-01-01T00:00:10Z', html_url: 'https://x/11' },
]);

let dir: string;
let oldPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  oldPath = process.env['PATH'];
  const script = `#!/bin/bash
echo "$*" >> "${dir}/argv.log"
has_f=0; method=""
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  [[ "\${args[i]}" == "-f" || "\${args[i]}" == "-F" ]] && has_f=1
  [[ "\${args[i]}" == "--method" || "\${args[i]}" == "-X" ]] && method="\${args[i+1]}"
done
if [[ $has_f == 1 && "$method" != "GET" ]]; then
  echo "gh: POST not allowed on this endpoint (HTTP 404)" >&2
  exit 1
fi
echo '${RUNS_JSON}'
`;
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  process.env['PATH'] = `${dir}:${oldPath ?? ''}`;
});
afterEach(() => {
  process.env['PATH'] = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('production run lister / finder against a POST-rejecting fake gh', () => {
  it('lister sends a GET (fields become query params) and returns the runs', async () => {
    const r = await createRouterRunLister('ghs_x')('o/r', '2099-01-01T00:00:00Z', 'issues');
    expect(r).toEqual({ ok: true, runs: [expect.objectContaining({ found: true, id: 11 })] });
    expect(readFileSync(join(dir, 'argv.log'), 'utf-8')).toContain('--method GET');
  });

  it('DECISIVE: when the fake rejects (no GET), the lister reports could-not-list, never []', async () => {
    // Simulate the defect by making the fake reject everything.
    writeFileSync(join(dir, 'gh'), '#!/bin/bash\necho "gh: HTTP 404 POST" >&2\nexit 1\n');
    const r = await createRouterRunLister('ghs_x')('o/r', '2099-01-01T00:00:00Z', 'issues');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('POST');
  });

  it('finder sends a GET and finds the run', async () => {
    const r = await createRouterRunFinder('ghs_x')('o/r', '2099-01-01T00:00:00Z');
    expect(r).toMatchObject({ found: true, id: 11 });
    expect(r.error).toBeUndefined();
  });

  it('finder failure carries an error rather than reading as no-run', async () => {
    writeFileSync(join(dir, 'gh'), '#!/bin/bash\necho boom >&2\nexit 1\n');
    const r = await createRouterRunFinder('ghs_x')('o/r', '2099-01-01T00:00:00Z');
    expect(r.found).toBe(false);
    expect(r.error).toContain('boom');
  });
});

describe('the orchestrator turns a listing failure into unknown', () => {
  const info = { host: '10.0.0.5', port: 8443, version: '1.0.0', instance_id: 'i' } as unknown as AgentInfo;
  const base = (over: Partial<RoutingE2eDeps>): RoutingE2eDeps => ({
    currentLabel: 'code-agent',
    listInstallRepos: async () => ['o/r'],
    isTargetCaller: async () => true,
    readTargetRoutingConfig: async () => ({ agents: { 'science-agent': {} } }),
    listRegistry: async () => [{ name: 'SCIENCE_AGENT', info }],
    probe: async () => null,
    createProbeIssue: async () => ({ ok: true as const, number: 42, url: 'u' }),
    applyLabel: async () => ({ ok: true as const }),
    closeIssue: async () => true,
    findRouterRun: async (): Promise<RoutingE2eRouterRun> => ({ found: false, conclusion: null, status: null, url: null }),
    readRunLog: async () => ({ kind: 'absent' }),
    maxPolls: 2,
    pollIntervalMs: 0,
    sleep: async () => {},
    ...over,
  });

  it('listing failure -> unknown / delivery_unverifiable with the error text', async () => {
    const r = await runRoutingE2eCore(
      base({ listRouterRuns: async () => ({ ok: false as const, error: 'HTTP 404' }) }),
      { targetRepo: 'o/r' },
    );
    expect(r.stage).toBe('delivery_unverifiable');
    expect(r.evidence?.verdict).toBe('unknown');
    expect(r.message).toBe('router runs could not be listed: HTTP 404');
  });

  it('a successful empty listing is still no-run', async () => {
    const r = await runRoutingE2eCore(base({ listRouterRuns: async () => ({ ok: true as const, runs: [] }) }), { targetRepo: 'o/r' });
    expect(r.evidence?.verdict).toBe('no-run');
  });

  it('finder error (no listRouterRuns) is also unverifiable', async () => {
    const r = await runRoutingE2eCore(
      base({ findRouterRun: async () => ({ found: false, conclusion: null, status: null, url: null, error: 'bad auth' }) }),
      { targetRepo: 'o/r' },
    );
    expect(r.stage).toBe('delivery_unverifiable');
  });

  it('ONE shared deadline: health never confirms + run never completes ends at ~one timeout', async () => {
    let t = 0;
    const r = await runRoutingE2eCore(
      base({
        maxPolls: undefined,
        pollIntervalMs: 10_000,
        now: () => t,
        sleep: async (ms) => { t += ms; },
        listRouterRuns: async () => ({ ok: true as const, runs: [{ found: true, id: 1, conclusion: null, status: 'in_progress', url: 'u' }] }),
      }),
      { targetRepo: 'o/r', timeoutSec: 100 },
    );
    expect(r.evidence).toBeDefined();
    expect(t).toBeLessThanOrEqual(110_000);
    expect(t).toBeGreaterThanOrEqual(90_000);
  });
});
