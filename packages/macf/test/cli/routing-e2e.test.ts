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
import type { TextRead } from '../../src/cli/commands/routing-e2e-evidence.js';
import { receiverLogPathFor } from '../../src/cli/commands/routing-e2e-gh.js';

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
    // Confirmed-visible by default (matches `targetRepo: 'o/r'` used
    // throughout) so every existing scenario below exercises the SAME
    // entitled-repo path it always did; only the new tests override this.
    listInstallRepos: vi.fn(async () => ['o/r']),
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
  // Decisive per assert-the-wrong-path.md: a broken gate that calls
  // isTargetCaller regardless (letting its own ambiguous 404-collapse decide)
  // could still land on SOME red stage — asserting only `verdict === 'RED'`
  // would not catch that. Asserting the SPECIFIC stage plus that the
  // ambiguous per-file reads were never even attempted is what a correct
  // gate uniquely produces.
  it('reports unknown, not absent, when the listing succeeds but does not contain the target repo (macf#1077)', async () => {
    // The listing IS non-empty (a real read landed) — 'o/r' is simply not
    // in it, the actual entitlement-gap shape the issue reports. A `[]`
    // fake here would instead exercise the "listing itself failed" cause
    // (covered separately below) and bless the wrong message.
    const deps = baseDeps({ listInstallRepos: vi.fn(async () => ['o/some-other-repo']) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.verdict).toBe('RED');
    expect(r.stage).toBe('target_visibility_unknown');
    expect(r.stage).not.toBe('target_not_a_caller'); // never a false claim of confirmed absence
    expect(deps.isTargetCaller).not.toHaveBeenCalled();
    expect(deps.readTargetRoutingConfig).not.toHaveBeenCalled();
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
    expect(r.cleanup.attempted).toBe(false);
    expect(r.message).toContain('code-agent'); // names the credential
    expect(r.message).toContain('read successfully'); // never claims a read that didn't happen
  });

  it('reports unknown for the DIFFERENT reason when the install listing read itself never comes back', async () => {
    // `listInstallRepos` degrades to `[]` on any failure (network/auth/gh
    // missing) — a real installation always covers at least this agent's
    // own repo, so `[]` means "never read," not "confirmed empty." The
    // message must say so, not claim the (never-read) listing named the
    // target absent.
    const deps = baseDeps({ listInstallRepos: vi.fn(async () => []) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_visibility_unknown');
    expect(r.message).toContain('could not read its own installed-repository list');
    expect(r.message).not.toContain('read successfully');
    expect(deps.isTargetCaller).not.toHaveBeenCalled();
  });

  it('is case-insensitive matching the target repo against the install listing', async () => {
    const deps = baseDeps({ listInstallRepos: vi.fn(async () => ['O/R']) }); // GitHub's own casing may differ
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).not.toBe('target_visibility_unknown');
    expect(deps.isTargetCaller).toHaveBeenCalledTimes(1);
  });

  // The confirmed-absent sibling: when the install-set DOES contain the
  // repo (this credential is entitled to read it), a 404 on the workflow
  // file is trustworthy and still reports absent — the fix narrows WHEN a
  // 404 is trusted, it does not make every 404 unknown.
  it('refuses when the target repo has no committed routing workflow (confirmed via the install-set, not merely a 404)', async () => {
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

  // Defect 2 (macf#1077): the delivery caveat describes what a GREEN
  // verdict means. A RED run delivered nothing, so the note must not print
  // — it would assert something that never happened.
  it('the delivery disclaimer is present on a GREEN result and absent on a RED one (#1077)', async () => {
    const green = await runRoutingE2eCore(baseDeps(), { targetRepo: 'o/r' });
    expect(green.verdict).toBe('GREEN');
    expect(formatRoutingE2eText(green)).toContain('DELIVERED to the recipient channel-server');
    expect((routingE2eToJson(green) as Record<string, unknown>)['disclaimer']).not.toBeNull();

    const red = await runRoutingE2eCore(baseDeps({ isTargetCaller: vi.fn(async () => false) }), { targetRepo: 'o/r' });
    expect(red.verdict).toBe('RED');
    expect(formatRoutingE2eText(red)).not.toContain('DELIVERED to the recipient channel-server');
    expect((routingE2eToJson(red) as Record<string, unknown>)['disclaimer']).toBeNull();
  });

  it('the target_visibility_unknown message never leaks credential-shaped material either', async () => {
    const deps = baseDeps({ listInstallRepos: vi.fn(async () => []) });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r' });
    expect(r.stage).toBe('target_visibility_unknown');
    const jsonStr = JSON.stringify(routingE2eToJson(r));
    expect(jsonStr).not.toContain(AGENT_INFO.host);
    expect(jsonStr).not.toContain(String(AGENT_INFO.port));
    expect(formatRoutingE2eText(r)).not.toContain(AGENT_INFO.host);
  });
});

// --- Evidence-based verdicts: the run's conclusion is never the evidence ---

const ROUTED_LINE = 'router\tRouted issue #42 to science-agent via mTLS POST (HTTP 200)';
const RECEIPT_LINE = JSON.stringify({ ts: '2099-01-01T00:00:00.000Z', level: 'info', event: 'notify_received', type: 'issue_routed', issue: 42 });
const DONE_RUN: RoutingE2eRouterRun = { found: true, id: 7, conclusion: 'success', status: 'completed', url: 'https://example.test/run/7' };

const neverMatchedProbe = vi.fn(async () => REACHABLE_NOT_MATCHED_HEALTH);

function evidenceDeps(over: Partial<RoutingE2eDeps> & { log?: string; recv?: TextRead } = {}): RoutingE2eDeps {
  const { log = ROUTED_LINE, recv = { kind: 'ok', text: RECEIPT_LINE }, ...rest } = over;
  return baseDeps({
    probe: neverMatchedProbe,
    findRouterRun: vi.fn(async () => DONE_RUN),
    readRunLog: vi.fn(async (): Promise<TextRead> => ({ kind: 'ok', text: log })),
    readReceiverLog: vi.fn(async () => ({ read: recv, path: '/state/macf/p@science-agent/channel.log' })),
    ...rest,
  });
}

describe('runRoutingE2eCore — evidence verdicts', () => {
  it('delivered: routed line AND a receiver channel-log receipt', async () => {
    const r = await runRoutingE2eCore(evidenceDeps(), { targetRepo: 'o/r' });
    expect(r.verdict).toBe('GREEN');
    expect(r.evidence?.verdict).toBe('delivered');
  });

  it('DECISIVE: a green run (conclusion success) with no routed line is not-routed', async () => {
    const r = await runRoutingE2eCore(evidenceDeps({ log: 'router\tnothing was routed' }), { targetRepo: 'o/r' });
    expect(DONE_RUN.conclusion).toBe('success');
    expect(r.evidence?.verdict).toBe('not-routed');
    expect(r.verdict).toBe('RED');
  });

  it('a red run with an error line is router-failed and quotes it', async () => {
    const failed = { ...DONE_RUN, conclusion: 'failure' };
    const r = await runRoutingE2eCore(
      evidenceDeps({ findRouterRun: vi.fn(async () => failed), log: 'x\t##[error]Missing secret ROUTING_CLIENT_CERT' }),
      { targetRepo: 'o/r' },
    );
    expect(r.evidence?.verdict).toBe('router-failed');
    expect(r.evidence?.gaps).toContain('router error: Missing secret ROUTING_CLIENT_CERT');
  });

  it('routed but no receipt in the channel log is routed-but-not-received', async () => {
    const r = await runRoutingE2eCore(evidenceDeps({ recv: { kind: 'ok', text: '' } }), { targetRepo: 'o/r' });
    expect(r.evidence?.verdict).toBe('routed-but-not-received');
  });

  it('receiver log not local (and endpoint never answered) is unknown, never delivered', async () => {
    const r = await runRoutingE2eCore(evidenceDeps({ recv: { kind: 'absent' }, probe: vi.fn(async () => null) }), { targetRepo: 'o/r' });
    expect(r.evidence?.verdict).toBe('unknown');
    expect(r.message).toContain('not verifiable from this host');
    expect(r.verdict).toBe('RED');
  });

  it('a self-route skip line is reported as a self-route, not delivered', async () => {
    const r = await runRoutingE2eCore(evidenceDeps({ log: 'x\tActor is the same agent, skipping self-routing' }), { targetRepo: 'o/r' });
    expect(r.evidence?.verdict).toBe('self-route');
  });

  it('no run within the wait is no-run', async () => {
    const r = await runRoutingE2eCore(evidenceDeps({ findRouterRun: vi.fn(async () => NOT_FOUND_RUN) }), { targetRepo: 'o/r' });
    expect(r.evidence?.verdict).toBe('no-run');
  });

  it('mention mode comments once on the given issue and never closes anything', async () => {
    const postMention = vi.fn(async () => ({ ok: true as const, url: 'https://example.test/c' }));
    const deps = evidenceDeps({
      postMention,
      readTargetRoutingConfig: vi.fn(async (): Promise<RoutingConfig | null> => ({ agents: { 'science-agent': { app_name: 'macf-science-agent' } } })),
      recv: { kind: 'ok', text: JSON.stringify({ ts: '2099-01-01T00:00:00.000Z', event: 'notify_received', type: 'mention', issue: 5 }) },
    });
    const r = await runRoutingE2eCore(deps, { targetRepo: 'o/r', mode: 'mention', issue: 5 });
    expect(postMention).toHaveBeenCalledTimes(1);
    expect(deps.createProbeIssue).not.toHaveBeenCalled();
    expect(deps.closeIssue).not.toHaveBeenCalled();
    expect(r.evidence?.verdict).toBe('delivered');
  });
});

describe('receiver log path', () => {
  it('is keyed on the routing label (the table key), never on the bot app name', () => {
    process.env['XDG_STATE_HOME'] = '/state';
    expect(receiverLogPathFor('macf-trial', 'code-agent')).toBe('/state/macf/macf-trial@code-agent/channel.log');
    expect(receiverLogPathFor('macf-trial', 'code-agent')).not.toContain('macf-trial-code-agent');
  });
});

describe('runRoutingE2eCore — which router run is the probe\'s (never a guess)', () => {
  const run = (id: number): RoutingE2eRouterRun => ({ found: true, id, conclusion: 'success', status: 'completed', url: `https://example.test/run/${String(id)}` });
  const mentionDeps = (logs: Record<number, string>, runs: readonly RoutingE2eRouterRun[]): RoutingE2eDeps =>
    evidenceDeps({
      listRouterRuns: vi.fn(async () => runs),
      readRunLog: vi.fn(async (_r: string, id: number): Promise<TextRead> => ({ kind: 'ok', text: logs[id] ?? '' })),
      postMention: vi.fn(async () => ({ ok: true as const, url: 'https://example.test/c' })),
      readTargetRoutingConfig: vi.fn(async (): Promise<RoutingConfig | null> => ({ agents: { 'science-agent': { app_name: 'macf-science-agent' } } })),
      recv: { kind: 'ok', text: JSON.stringify({ ts: '2099-01-01T00:00:00.000Z', event: 'notify_received', type: 'mention', issue: 5 }) },
    });
  const opts = { targetRepo: 'o/r', mode: 'mention' as const, issue: 5 };

  it('two concurrent runs, only one names the issue: that one is judged', async () => {
    const r = await runRoutingE2eCore(
      mentionDeps({ 1: 'Routed mention to science-agent via mTLS POST\nISSUE_NUMBER: 9', 2: 'Routed mention to science-agent via mTLS POST\nISSUE_NUMBER: 5' }, [run(1), run(2)]),
      opts,
    );
    expect(r.evidence?.verdict).toBe('delivered');
    expect(r.routerRun?.id).toBe(2);
  });

  it('two runs that both name the issue are ambiguous, not guessed', async () => {
    const log = 'Routed mention to science-agent via mTLS POST\nISSUE_NUMBER: 5';
    const r = await runRoutingE2eCore(mentionDeps({ 1: log, 2: log }, [run(1), run(2)]), opts);
    expect(r.evidence?.verdict).toBe('unknown');
    expect(r.message).toBe("ambiguous: 2 router runs started in the window and the log could not single out the probe's");
  });

  it('two runs where neither names the issue are ambiguous', async () => {
    const r = await runRoutingE2eCore(mentionDeps({ 1: 'nothing', 2: 'nothing' }, [run(1), run(2)]), opts);
    expect(r.evidence?.verdict).toBe('unknown');
    expect(r.message).toContain('ambiguous: 2 router runs');
  });

  it('a single candidate is used as-is, even if its log does not name the issue', async () => {
    const r = await runRoutingE2eCore(mentionDeps({ 1: 'Routed mention to science-agent via mTLS POST' }, [run(1)]), opts);
    expect(r.evidence?.verdict).toBe('delivered');
  });
});
