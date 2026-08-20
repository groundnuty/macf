/**
 * Tests for `routing-e2e.ts` — the routing CAPABILITY probe orchestration
 * (`macf routing doctor --e2e`). All deps are injected fakes; nothing here
 * hits `gh` / the registry / the network.
 *
 * Per `assert-the-wrong-path.md`: the load-bearing test is NOT "a timeout
 * produces a RED result" (a broken implementation that hardcodes any stage
 * on timeout would still pass that). It is the triple in "decisive RED
 * result" below — three cases sharing the IDENTICAL poll outcome (probe
 * reachable, never matches) that differ ONLY in what `findRouterRun`
 * returns, asserting three DIFFERENT stages. That triple can only pass if
 * the stage is actually derived from the router-run read.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import type { RoutingConfig } from '../../src/cli/commands/routing-doctor.js';
import {
  deriveMaxPolls,
  formatRoutingE2eText,
  routingE2eToJson,
  runRoutingE2eCore,
  ROUTING_E2E_JSON_SCHEMA_VERSION,
  type RoutingE2eDeps,
  type RoutingE2eRouterRun,
} from '../../src/cli/commands/routing-e2e.js';

const AGENT_INFO: AgentInfo = {
  host: '10.0.0.5',
  port: 8443,
  version: '1.0.0',
  instance_id: 'inst-1',
} as unknown as AgentInfo;

const REACHABLE_NOT_MATCHED_HEALTH: HealthResponse = {
  agent: 'science-agent',
  status: 'online',
  current_issue: 999, // some OTHER issue, never our probe's number
} as unknown as HealthResponse;

const NOT_FOUND_RUN: RoutingE2eRouterRun = { found: false, conclusion: null, status: null, url: null };

/** A fully-wired, always-successful fake — individual tests override just what they need. */
function baseDeps(overrides: Partial<RoutingE2eDeps> = {}): RoutingE2eDeps {
  return {
    currentLabel: 'code-agent',
    isTargetCaller: vi.fn(async () => true),
    readTargetRoutingConfig: vi.fn(async (): Promise<RoutingConfig | null> => ({ agents: { 'science-agent': {} } })),
    listRegistry: vi.fn(async () => [{ name: 'SCIENCE_AGENT', info: AGENT_INFO }]),
    probe: vi.fn(async () => ({ ...REACHABLE_NOT_MATCHED_HEALTH, current_issue: 42 }) as unknown as HealthResponse),
    createProbeIssue: vi.fn(async () => ({ ok: true as const, number: 42, url: 'https://github.com/o/r/issues/42' })),
    applyLabel: vi.fn(async () => ({ ok: true as const })),
    closeIssue: vi.fn(async () => true),
    findRouterRun: vi.fn(async () => NOT_FOUND_RUN),
    maxPolls: 3,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    ...overrides,
  };
}

describe('runRoutingE2eCore — preconditions (nothing filed, nothing to clean up)', () => {
  it('refuses when the target repo has no committed routing workflow', async () => {
    const deps = baseDeps({ isTargetCaller: vi.fn(async () => false) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.verdict).toBe('RED');
    expect(r.stage).toBe('target_not_a_caller');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
    expect(r.cleanup.attempted).toBe(false);
  });

  it('refuses when the target repo routes for more than one agent and no --target-label given', async () => {
    const deps = baseDeps({
      readTargetRoutingConfig: vi.fn(async () => ({ agents: { a: {}, b: {} } })),
    });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_label_ambiguous');
    expect(r.message).toContain('a');
    expect(r.message).toContain('b');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
  });

  it('refuses when the target repo has no routing config at all', async () => {
    const deps = baseDeps({ readTargetRoutingConfig: vi.fn(async () => null) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_label_not_found');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
  });

  it('refuses when --target-label is not a label the target repo actually has', async () => {
    const deps = baseDeps();
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r', targetLabel: 'nonexistent-agent' });
    expect(r.stage).toBe('target_label_not_found');
    expect(r.message).toContain('science-agent');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
  });

  it('refuses self-routing (target label === this agent\'s own label) BEFORE filing anything', async () => {
    const deps = baseDeps({ currentLabel: 'science-agent' });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('self_route_would_skip');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
  });

  it('refuses when the resolved target label has no live registry entry', async () => {
    const deps = baseDeps({ listRegistry: vi.fn(async () => []) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_unregistered');
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
  });
});

describe('runRoutingE2eCore — happy path', () => {
  it('GREEN: delivered on the first poll, never consults the router-run reader', async () => {
    const deps = baseDeps({
      probe: vi.fn(async () => ({ ...REACHABLE_NOT_MATCHED_HEALTH, current_issue: 42 }) as unknown as HealthResponse),
    });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.verdict).toBe('GREEN');
    expect(r.stage).toBe('delivered');
    expect(r.probeIssue.number).toBe(42);
    expect(deps.findRouterRun).not.toHaveBeenCalled();
    expect(deps.probe).toHaveBeenCalledTimes(1); // broke out of the poll loop immediately
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
    expect(r.cleanup).toEqual({ attempted: true, closed: true });
  });

  it('applies the label as a call SEPARATE from issue creation (fires `labeled`, not `opened`)', async () => {
    const deps = baseDeps();
    await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(deps.createProbeIssue).toHaveBeenCalledTimes(1);
    expect(deps.applyLabel).toHaveBeenCalledTimes(1);
    expect(deps.applyLabel).toHaveBeenCalledWith('o/r', 42, 'science-agent');
  });
});

describe('runRoutingE2eCore — post-creation failures still clean up exactly once', () => {
  it('probe_creation_failed: issue never created, so cleanup is never attempted', async () => {
    const deps = baseDeps({ createProbeIssue: vi.fn(async () => ({ ok: false as const, error: 'boom' })) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('probe_creation_failed');
    expect(r.cleanup.attempted).toBe(false);
    expect(deps.closeIssue).not.toHaveBeenCalled();
  });

  it('probe_label_failed: issue created but label POST fails — cleanup runs exactly once, probe never polled', async () => {
    const deps = baseDeps({ applyLabel: vi.fn(async () => ({ ok: false as const, error: 'label 404' })) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('probe_label_failed');
    expect(r.message).toContain('label 404');
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
    expect(r.cleanup).toEqual({ attempted: true, closed: true });
  });
});

describe('runRoutingE2eCore — decisive RED result: same timeout, different stage per root cause', () => {
  // All three share the IDENTICAL poll outcome: the target answers /health
  // every time (reachable) but current_issue never matches. Only
  // `findRouterRun`'s return value differs. A stage hardcoded on timeout
  // (rather than derived from the router-run read) would produce the SAME
  // stage in all three — this triple fails such an implementation.
  const neverMatchedProbe = vi.fn(async () => REACHABLE_NOT_MATCHED_HEALTH);

  it('never reachable at all -> target_unreachable, router-run reader never consulted', async () => {
    const deps = baseDeps({ probe: vi.fn(async () => null), findRouterRun: vi.fn(async () => NOT_FOUND_RUN) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_unreachable');
    expect(r.everReachable).toBe(false);
    expect(deps.findRouterRun).not.toHaveBeenCalled();
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
  });

  it('reachable, no router run found -> router_not_triggered', async () => {
    const deps = baseDeps({ probe: neverMatchedProbe, findRouterRun: vi.fn(async () => NOT_FOUND_RUN) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('router_not_triggered');
    expect(r.everReachable).toBe(true);
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
  });

  it('reachable, router run FAILED -> router_run_failed, names the conclusion + URL', async () => {
    const failedRun: RoutingE2eRouterRun = {
      found: true,
      conclusion: 'failure',
      status: 'completed',
      url: 'https://github.com/o/r/actions/runs/123',
    };
    const deps = baseDeps({ probe: neverMatchedProbe, findRouterRun: vi.fn(async () => failedRun) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('router_run_failed');
    expect(r.message).toContain('failure');
    expect(r.message).toContain('https://github.com/o/r/actions/runs/123');
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
  });

  it('reachable, router run SUCCEEDED -> delivered_not_confirmed (not router_run_failed)', async () => {
    const okRun: RoutingE2eRouterRun = { found: true, conclusion: 'success', status: 'completed', url: 'https://x' };
    const deps = baseDeps({ probe: neverMatchedProbe, findRouterRun: vi.fn(async () => okRun) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('delivered_not_confirmed');
    expect(deps.closeIssue).toHaveBeenCalledTimes(1);
  });

  it('findRouterRun is called with a since-timestamp AFTER the label was applied, not before', async () => {
    const findRouterRun = vi.fn(async () => NOT_FOUND_RUN);
    const deps = baseDeps({ probe: neverMatchedProbe, findRouterRun });
    await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(findRouterRun).toHaveBeenCalledTimes(1);
    const [repoArg, sinceArg] = findRouterRun.mock.calls[0] as [string, string];
    expect(repoArg).toBe('o/r');
    expect(() => new Date(sinceArg).toISOString()).not.toThrow(); // a real ISO timestamp, not garbage
  });
});

describe('runRoutingE2eCore — cleanup failure is reported, not swallowed into a crash', () => {
  it('closeIssue throwing surfaces as cleanup.error without losing the diagnosis', async () => {
    const deps = baseDeps({
      probe: vi.fn(async () => null),
      closeIssue: vi.fn(async () => {
        throw new Error('403 forbidden');
      }),
    });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_unreachable'); // the diagnosis still landed
    expect(r.cleanup).toEqual({ attempted: true, closed: false, error: '403 forbidden' });
  });
});

describe('deriveMaxPolls', () => {
  it('derives roughly (budget/interval)+1 polls, floored at 2', () => {
    expect(deriveMaxPolls(180, 10_000)).toBe(19);
    expect(deriveMaxPolls(1, 10_000)).toBe(2); // tiny budget still gets at least 2 tries
  });
});

describe('routingE2eToJson / formatRoutingE2eText', () => {
  it('JSON carries schema_version + the same fields the text render describes', async () => {
    const deps = baseDeps();
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    const json = routingE2eToJson(r) as Record<string, unknown>;
    expect(json['schema_version']).toBe(ROUTING_E2E_JSON_SCHEMA_VERSION);
    expect(json['verdict']).toBe('GREEN');
    expect(json['probe_issue']).toEqual({ number: 42, url: 'https://github.com/o/r/issues/42' });

    const text = formatRoutingE2eText(r);
    expect(text).toContain('#42');
    expect(text).toContain('DELIVERED');
    expect(text).toContain('not that the agent acted'); // the "delivered, not seen" disclaimer
  });

  it('never leaks credential-shaped material (host/port/certs) into either render', async () => {
    const deps = baseDeps();
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    const jsonStr = JSON.stringify(routingE2eToJson(r));
    expect(jsonStr).not.toContain(AGENT_INFO.host);
    expect(jsonStr).not.toContain(String(AGENT_INFO.port));
    expect(formatRoutingE2eText(r)).not.toContain(AGENT_INFO.host);
  });
});
