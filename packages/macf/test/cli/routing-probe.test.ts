/**
 * Tests for `routing-probe.ts`. All deps are fakes; nothing touches the
 * network, `gh`, or a real log. The decisive case is a router run whose
 * conclusion is `success` with no routed line: it must be not-routed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runRoutingProbeCore,
  formatProbeText,
  type ProbeDeps,
  type ProbeRun,
  type TextRead,
} from '../../src/cli/commands/routing-probe.js';

const POST_MS = Date.parse('2026-10-16T12:00:00Z');
const RUN: ProbeRun = {
  id: 7, status: 'completed', conclusion: 'success', url: 'https://example.test/run/7', createdAt: '2026-10-16T12:00:02Z',
};
const ROUTED = 'router\tRouted issue #3 to science-agent via mTLS POST (HTTP 200)';
const RECEIPT = JSON.stringify({ ts: '2026-10-16T12:00:05Z', event: 'notify_received', type: 'issue_routed', issue: 3 });

function deps(over: Partial<ProbeDeps> & { runLog?: string; run?: ProbeRun; receiver?: TextRead } = {}): ProbeDeps {
  const { runLog = ROUTED, run = RUN, receiver = { kind: 'ok', text: RECEIPT }, ...rest } = over;
  return {
    invokerLabel: 'code-agent',
    readTargetRoutingConfig: async () => ({ agents: { 'science-agent': { app_name: 'macf-science-agent' } } }),
    post: async () => ({ ok: true, issueNumber: 3, url: 'https://example.test/issues/3' }),
    listRuns: async () => [run],
    readRunLog: async () => ({ kind: 'ok', text: runLog }),
    receiverLogPath: () => '/state/macf/p@macf-science-agent/channel.log',
    readReceiverLog: async () => receiver,
    newToken: () => 'tok',
    now: () => POST_MS,
    sleep: async () => {},
    ...rest,
  };
}

const OPTS = { targetRepo: 'o/r', recipient: 'science-agent', mode: 'label' as const, pollIntervalMs: 1, timeoutSec: 1 };

describe('runRoutingProbeCore', () => {
  it('delivered: routed line AND receiver receipt', async () => {
    const r = await runRoutingProbeCore(deps(), OPTS);
    expect(r.verdict).toBe('delivered');
    expect(r.gaps).toEqual([]);
  });

  it('a green run with NO routed line is not-routed (never inferred from the conclusion)', async () => {
    const r = await runRoutingProbeCore(deps({ runLog: 'router\tnothing to route here' }), OPTS);
    expect(RUN.conclusion).toBe('success');
    expect(r.verdict).toBe('not-routed');
  });

  it('a red run quotes the error line as router-failed', async () => {
    const run = { ...RUN, conclusion: 'failure' };
    const r = await runRoutingProbeCore(deps({ run, runLog: 'x\t##[error]Missing secret ROUTING_CLIENT_CERT' }), OPTS);
    expect(r.verdict).toBe('router-failed');
    expect(r.gaps).toContain('router error: Missing secret ROUTING_CLIENT_CERT');
  });

  it('routed but no receipt after the post is routed-but-not-received', async () => {
    const stale = JSON.stringify({ ts: '2026-10-16T11:00:00Z', event: 'notify_received', type: 'issue_routed', issue: 3 });
    const r = await runRoutingProbeCore(deps({ receiver: { kind: 'ok', text: stale } }), OPTS);
    expect(r.verdict).toBe('routed-but-not-received');
  });

  it('receiver log not local is unknown, never delivered', async () => {
    const r = await runRoutingProbeCore(deps({ receiver: { kind: 'absent' } }), OPTS);
    expect(r.verdict).toBe('unknown');
    expect(r.summary).toContain('not verifiable from this host');
  });

  it('a self-route skip line is reported as self-route', async () => {
    const r = await runRoutingProbeCore(deps({ runLog: 'x\tActor is the same agent, skipping self-routing' }), OPTS);
    expect(r.verdict).toBe('self-route');
  });

  it('no run within the window is no-run', async () => {
    const r = await runRoutingProbeCore(deps({ listRuns: async () => [] }), OPTS);
    expect(r.verdict).toBe('no-run');
  });

  it('two candidate runs where neither names the probe is unknown (ambiguous)', async () => {
    const r = await runRoutingProbeCore(deps({ listRuns: async () => [RUN, { ...RUN, id: 8 }], runLog: ROUTED.replace('#3', '#9') }), OPTS);
    expect(r.verdict).toBe('unknown');
  });

  it('refuses before posting when the recipient is the invoker', async () => {
    const post = vi.fn();
    const r = await runRoutingProbeCore(deps({ invokerLabel: 'science-agent', post }), OPTS);
    expect(r.verdict).toBe('unknown');
    expect(post).not.toHaveBeenCalled();
  });

  it('posts exactly once and never to another repo', async () => {
    const post = vi.fn(async () => ({ ok: true as const, issueNumber: 3, url: 'u' }));
    await runRoutingProbeCore(deps({ post }), OPTS);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ repo: 'o/r', mode: 'label' });
  });

  it('prints every stage in one pass', async () => {
    const r = await runRoutingProbeCore(deps({ receiver: { kind: 'absent' } }), OPTS);
    const text = formatProbeText(r, 'o/r');
    for (const s of ['post', 'router-run', 'routed-line', 'receiver']) expect(text).toContain(s);
  });
});
