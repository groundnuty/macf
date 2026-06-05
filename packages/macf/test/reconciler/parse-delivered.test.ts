/**
 * Tests for the router "Routed … to <AGENT> via helper|inline" log parser
 * (groundnuty/macf#444 piece 4). The log shapes mirror the 4 `route-by-*`
 * blocks' success-echo lines in macf-actions/agent-router.yml.
 */
import { describe, it, expect } from 'vitest';
import { parseDeliveredFromLog } from '../../src/reconciler/parse-delivered.js';

const RUN = '27040000001';
const T = 1_780_000_000_000;

describe('parseDeliveredFromLog', () => {
  it('parses route-by-mention success line', () => {
    const log = 'Routed mention to science-agent via helper (target=science-agent, session=alive)';
    expect(parseDeliveredFromLog(log, RUN, T)).toEqual([{ runId: RUN, agent: 'science-agent', deliveredAtMs: T }]);
  });

  it('parses route-by-label, route-by-ci-completion, route-by-pr-review-state shapes', () => {
    const log = [
      'Routed issue #5 to code-agent via inline (target=code-agent, session=alive)',
      'Routed CI completion for PR #12 to devops-agent via helper (target=devops-agent, session=alive)',
      'Routed review-state (APPROVED) for PR #99 to code-agent via helper (target=code-agent, session=unknown)',
    ].join('\n');
    const got = parseDeliveredFromLog(log, RUN, T).map((d) => d.agent).sort();
    expect(got).toEqual(['code-agent', 'devops-agent']); // code-agent deduped across 2 lines
  });

  it('does NOT count failure / offline lines (no `via helper|inline`)', () => {
    const log = [
      'Agent code-agent delivery FAILED after probe=unknown (attempted, not silently offline-skipped)',
      'Agent science-agent session not found (offline), skipping',
      "Agent code-agent session not found (offline); marking agent-offline",
    ].join('\n');
    expect(parseDeliveredFromLog(log, RUN, T)).toEqual([]);
  });

  it('dedups the same agent appearing on multiple delivered lines', () => {
    const log = [
      'Routed mention to code-agent via helper (…)',
      'Routed CI completion for PR #1 to code-agent via inline (…)',
    ].join('\n');
    expect(parseDeliveredFromLog(log, RUN, T)).toEqual([{ runId: RUN, agent: 'code-agent', deliveredAtMs: T }]);
  });

  it('handles GitHub log line prefixes (timestamps/job prefixes) around the marker', () => {
    const log = '2026-06-05T22:38:15.1234567Z route-by-mention\tRouted mention to code-agent via helper (target=code-agent, session=alive)';
    expect(parseDeliveredFromLog(log, RUN, T).map((d) => d.agent)).toEqual(['code-agent']);
  });

  it('empty / no-delivery log ⇒ no routes', () => {
    expect(parseDeliveredFromLog('', RUN, T)).toEqual([]);
    expect(parseDeliveredFromLog('some unrelated output\nnothing routed here', RUN, T)).toEqual([]);
  });
});
