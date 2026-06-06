/**
 * Tests for the Tempo TraceQL search-response → PROCESSED-receipt parser
 * (groundnuty/macf#444 piece 4). Sample shapes mirror the live response
 * science recorded (`traces[].spanSets[].spans[].attributes[]`, typed values).
 */
import { describe, it, expect } from 'vitest';
import { parseProcessedFromTempo } from '../../src/reconciler/parse-processed.js';

function trace(runId: string, agent: string) {
  return {
    traceID: 'abc123',
    spanSets: [
      {
        spans: [
          {
            name: 'turn_processed',
            attributes: [
              { key: 'routed_run_id', value: { stringValue: runId } },
              { key: 'agent', value: { stringValue: agent } },
              { key: 'service.namespace', value: { stringValue: 'macf' } },
            ],
          },
        ],
        matched: 1,
      },
    ],
  };
}

describe('parseProcessedFromTempo', () => {
  it('parses (routed_run_id, agent) from the live spanSets[].spans[].attributes[] shape', () => {
    const r = parseProcessedFromTempo({ traces: [trace('27040000001', 'code-agent'), trace('27040000002', 'science-agent')] });
    expect(r.receipts).toEqual([
      { runId: '27040000001', agent: 'code-agent' },
      { runId: '27040000002', agent: 'science-agent' },
    ]);
    expect(r.traceCount).toBe(2);
  });

  it('handles the older singular `spanSet` shape too', () => {
    const r = parseProcessedFromTempo({
      traces: [{ spanSet: { spans: [{ attributes: [
        { key: 'routed_run_id', value: { stringValue: '5' } },
        { key: 'agent', value: { stringValue: 'devops-agent' } },
      ] }] } }],
    });
    expect(r.receipts).toEqual([{ runId: '5', agent: 'devops-agent' }]);
  });

  it('skips a span missing routed_run_id or agent (defensive — not a valid receipt)', () => {
    const r = parseProcessedFromTempo({ traces: [
      { spanSets: [{ spans: [{ attributes: [{ key: 'agent', value: { stringValue: 'code-agent' } }] }] }] }, // no run_id
      trace('9', 'code-agent'),
    ] });
    expect(r.receipts).toEqual([{ runId: '9', agent: 'code-agent' }]);
    expect(r.traceCount).toBe(2); // count is raw trace count, for truncation check
  });

  it('empty / missing traces ⇒ no receipts, count 0', () => {
    expect(parseProcessedFromTempo({ traces: [] })).toEqual({ receipts: [], traceCount: 0 });
    expect(parseProcessedFromTempo({})).toEqual({ receipts: [], traceCount: 0 });
    expect(parseProcessedFromTempo(null)).toEqual({ receipts: [], traceCount: 0 });
  });

  it('traceCount reflects raw trace count (caller compares to `limit` for truncation = false-drop guard)', () => {
    const traces = Array.from({ length: 20 }, (_, i) => trace(String(i), 'code-agent'));
    const r = parseProcessedFromTempo({ traces });
    expect(r.traceCount).toBe(20);
    expect(r.receipts).toHaveLength(20);
  });
});
