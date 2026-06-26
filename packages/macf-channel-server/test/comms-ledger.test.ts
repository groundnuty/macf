import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommsLedger,
  intentSummary,
  backfillProcessed,
  mergeLedgers,
  ledgerPathFromLog,
  COMMS_LEDGER_FILENAME,
  CommsLedgerEdgeSchema,
  readLastProcessed,
  selectLastReceipt,
  mapReceiptToLastProcessed,
  parseReceipts,
  receiptSinkPathFromLog,
  RECEIPT_SINK_FILENAME,
  type CommsLedgerEdge,
  type ProcessedReceipt,
} from '../src/comms-ledger.js';

function edge(overrides: Partial<CommsLedgerEdge> = {}): CommsLedgerEdge {
  return {
    ts: '2026-06-08T00:00:00.000Z',
    from: 'cv-architect',
    to: 'cv-project-archaeologist',
    channel: 'a2a',
    event: 'turn-complete',
    direction: 'send',
    msg_id: 'm-1',
    intent_summary: 'review request: PR #34 ready',
    github_anchor: 'groundnuty/macf-science-agent#34',
    delivered: true,
    processed: null,
    trace_id: '8886200a',
    ...overrides,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'macf-ledger-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('createCommsLedger — write path', () => {
  it('appends one JSONL line per edge, in order', () => {
    const path = join(tmp, 'logs', COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    expect(ledger.path).toBe(path);

    ledger.appendEdge(edge({ msg_id: 'm-1' }));
    ledger.appendEdge(edge({ msg_id: 'm-2', direction: 'recv', channel: 'github-route', event: 'mention' }));

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as CommsLedgerEdge;
    const second = JSON.parse(lines[1]!) as CommsLedgerEdge;
    expect(first.msg_id).toBe('m-1');
    expect(second.msg_id).toBe('m-2');
    expect(second.channel).toBe('github-route');
    // round-trips through the schema (shape AC)
    expect(CommsLedgerEdgeSchema.safeParse(first).success).toBe(true);
    expect(CommsLedgerEdgeSchema.safeParse(second).success).toBe(true);
  });

  it('creates the ledger dir + file if absent', () => {
    const path = join(tmp, 'deep', 'logs', COMMS_LEDGER_FILENAME);
    expect(existsSync(path)).toBe(false);
    const ledger = createCommsLedger({ ledgerPath: path });
    ledger.appendEdge(edge());
    expect(existsSync(path)).toBe(true);
  });

  it('writes the edge fields verbatim (durable record), incl. nullable processed + github_anchor', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    ledger.appendEdge(edge({ processed: null, github_anchor: null, channel: 'github-route', event: 'issue-routed', direction: 'recv' }));
    const rec = JSON.parse(readFileSync(path, 'utf8').trim()) as CommsLedgerEdge;
    expect(rec.processed).toBeNull();
    expect(rec.github_anchor).toBeNull();
    expect(rec.trace_id).toBe('8886200a');
    expect(rec.delivered).toBe(true);
  });

  it('is a no-op (does not throw, no path) when neither logPath nor ledgerPath is set', () => {
    const ledger = createCommsLedger({});
    expect(ledger.path).toBeUndefined();
    expect(() => ledger.appendEdge(edge())).not.toThrow();
  });

  it('FAIL-LOUD: appendEdge throws if the underlying write fails', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    ledger.appendEdge(edge()); // works once
    // Replace the file with a directory → appendFileSync gets EISDIR (root-safe,
    // unlike chmod which root bypasses). The authoritative write must propagate.
    rmSync(path);
    mkdirSync(path);
    expect(() => ledger.appendEdge(edge())).toThrow();
  });

  it('rejects a malformed edge at the source (schema parse on write)', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    // bad channel value
    expect(() => ledger.appendEdge({ ...edge(), channel: 'smoke-signal' as never })).toThrow();
  });
});

describe('ledgerPathFromLog', () => {
  it('derives a sibling of channel.log', () => {
    expect(ledgerPathFromLog('/x/.macf/logs/channel.log')).toBe(`/x/.macf/logs/${COMMS_LEDGER_FILENAME}`);
  });
  it('is undefined when logPath is undefined', () => {
    expect(ledgerPathFromLog(undefined)).toBeUndefined();
  });
  it('createCommsLedger derives from logPath when ledgerPath not given', () => {
    const logPath = join(tmp, 'logs', 'channel.log');
    const ledger = createCommsLedger({ logPath });
    expect(ledger.path).toBe(join(tmp, 'logs', COMMS_LEDGER_FILENAME));
  });
});

describe('intentSummary — cheap deterministic clip (no LLM)', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(intentSummary('  review request: PR #34  \nmore body\nlines')).toBe('review request: PR #34');
  });
  it('skips leading blank lines', () => {
    expect(intentSummary('\n\n  hello there  \n')).toBe('hello there');
  });
  it('returns empty string for null/undefined/whitespace', () => {
    expect(intentSummary(undefined)).toBe('');
    expect(intentSummary(null)).toBe('');
    expect(intentSummary('   \n  \n')).toBe('');
  });
  it('clips an over-long line with an ellipsis (never a silent cap)', () => {
    const long = 'x'.repeat(300);
    const out = intentSummary(long, 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('backfillProcessed — null-then-backfill (DR-025 / macf#444)', () => {
  const keyOf = (e: CommsLedgerEdge): string => e.msg_id;

  it('resolves processed:null → true when a receipt exists, false otherwise', () => {
    const edges = [edge({ msg_id: 'm-1', processed: null }), edge({ msg_id: 'm-2', processed: null })];
    const out = backfillProcessed(edges, new Set(['m-1']), keyOf);
    expect(out.find((e) => e.msg_id === 'm-1')!.processed).toBe(true);
    expect(out.find((e) => e.msg_id === 'm-2')!.processed).toBe(false);
  });

  it('leaves already-resolved processed untouched (idempotent)', () => {
    const edges = [edge({ msg_id: 'm-1', processed: true }), edge({ msg_id: 'm-2', processed: false })];
    const out = backfillProcessed(edges, new Set([]), keyOf);
    expect(out.find((e) => e.msg_id === 'm-1')!.processed).toBe(true);
    expect(out.find((e) => e.msg_id === 'm-2')!.processed).toBe(false);
  });

  it('does not mutate the input edges (pure)', () => {
    const edges = [edge({ msg_id: 'm-1', processed: null })];
    backfillProcessed(edges, new Set(['m-1']), keyOf);
    expect(edges[0]!.processed).toBeNull();
  });
});

describe('mergeLedgers — multi-host gather', () => {
  it('merges multiple ledgers and orders by ts', () => {
    const a = [
      JSON.stringify(edge({ msg_id: 'a2', ts: '2026-06-08T00:00:02.000Z' })),
      JSON.stringify(edge({ msg_id: 'a1', ts: '2026-06-08T00:00:01.000Z' })),
    ].join('\n');
    const b = JSON.stringify(edge({ msg_id: 'b1', ts: '2026-06-08T00:00:03.000Z' }));
    const merged = mergeLedgers([a, b]);
    expect(merged.map((e) => e.msg_id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('skips blank and malformed lines (a corrupt line must not blind the gather)', () => {
    const content = [
      JSON.stringify(edge({ msg_id: 'ok1' })),
      '',
      'this is not json',
      '{"partial": true}', // valid JSON but fails the edge schema
      JSON.stringify(edge({ msg_id: 'ok2', ts: '2026-06-08T00:00:05.000Z' })),
    ].join('\n');
    const merged = mergeLedgers([content]);
    expect(merged.map((e) => e.msg_id)).toEqual(['ok1', 'ok2']);
  });

  it('round-trips a real written ledger file', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    ledger.appendEdge(edge({ msg_id: 'w1' }));
    ledger.appendEdge(edge({ msg_id: 'w2', ts: '2026-06-08T00:00:09.000Z' }));
    const merged = mergeLedgers([readFileSync(path, 'utf8')]);
    expect(merged.map((e) => e.msg_id)).toEqual(['w1', 'w2']);
  });
});

// --- DR-030 phase-1 (groundnuty/macf#568): last_processed via the receipt sink ---

/** Build a turn-receipt (the `emit-turn-receipt.sh` wire shape) for reader tests. */
function receipt(over: Partial<ProcessedReceipt> = {}): ProcessedReceipt {
  return {
    ts: Date.parse('2026-06-08T00:00:00.000Z'),
    run_id: '27123456',
    agent: 'code-agent',
    ...over,
  };
}

describe('receiptSinkPathFromLog', () => {
  it('derives a sibling of channel.log', () => {
    expect(receiptSinkPathFromLog('/x/.macf/logs/channel.log')).toBe(`/x/.macf/logs/${RECEIPT_SINK_FILENAME}`);
  });
  it('is undefined when logPath is undefined', () => {
    expect(receiptSinkPathFromLog(undefined)).toBeUndefined();
  });
});

describe('parseReceipts — tolerant line parsing', () => {
  it('parses valid receipt lines, skipping blank + malformed + schema-failing lines', () => {
    const content = [
      JSON.stringify(receipt({ run_id: '1' })),
      '',
      'not json at all {{{',
      '{"ts":123}', // valid JSON but fails the schema (missing run_id/agent)
      '{"ts":456,"run_id":"","agent":"x"}', // empty run_id rejected by .min(1)
      JSON.stringify(receipt({ run_id: '2' })),
    ].join('\n');
    expect(parseReceipts(content).map((r) => r.run_id)).toEqual(['1', '2']);
  });

  it('returns [] for empty content', () => {
    expect(parseReceipts('')).toEqual([]);
  });
});

describe('selectLastReceipt', () => {
  it('picks the most-recent (max ts) receipt, robust to out-of-order lines', () => {
    expect(
      selectLastReceipt([
        receipt({ run_id: 'old', ts: 1000 }),
        receipt({ run_id: 'new', ts: 5000 }),
        receipt({ run_id: 'mid', ts: 3000 }),
      ])?.run_id,
    ).toBe('new');
  });
  it('returns null on an empty list', () => {
    expect(selectLastReceipt([])).toBeNull();
  });
});

describe('mapReceiptToLastProcessed', () => {
  const NOW = Date.parse('2026-06-08T00:00:05.000Z');

  it('maps ts→at(ISO), run_id→correlation_token, anchor:null, age_ms=now−ts', () => {
    const ts = Date.parse('2026-06-08T00:00:00.000Z');
    expect(mapReceiptToLastProcessed(receipt({ ts, run_id: 'tok-XYZ' }), NOW)).toEqual({
      at: '2026-06-08T00:00:00.000Z',
      anchor: null,
      age_ms: 5000,
      correlation_token: 'tok-XYZ',
    });
  });

  it('null receipt maps to null', () => {
    expect(mapReceiptToLastProcessed(null, NOW)).toBeNull();
  });

  it('clamps age_ms to 0 on backwards clock skew (receipt ts in the future)', () => {
    expect(mapReceiptToLastProcessed(receipt({ ts: NOW + 9000 }), NOW)?.age_ms).toBe(0);
  });

  it('yields at:null + age_ms:null for a non-finite ts (never NaN)', () => {
    const r = mapReceiptToLastProcessed(receipt({ ts: NaN }), NOW);
    expect(r?.at).toBeNull();
    expect(r?.age_ms).toBeNull();
  });
});

describe('readLastProcessed — reads the receipt sink', () => {
  const NOW = Date.parse('2026-06-08T00:00:05.000Z');

  it('reads the most-recent receipt via an injected readReceipts fn', () => {
    expect(
      readLastProcessed({
        now: NOW,
        readReceipts: () => [
          receipt({ run_id: 'old', ts: Date.parse('2026-06-08T00:00:01.000Z') }),
          receipt({ run_id: 'newest', ts: Date.parse('2026-06-08T00:00:03.000Z') }),
        ],
      }),
    ).toEqual({
      at: '2026-06-08T00:00:03.000Z',
      anchor: null,
      age_ms: 2000,
      correlation_token: 'newest',
    });
  });

  it('reads from a real on-disk receipt sink (sibling of logPath)', () => {
    const logPath = join(tmp, 'logs', 'channel.log');
    const sink = receiptSinkPathFromLog(logPath)!;
    mkdirSync(join(tmp, 'logs'), { recursive: true });
    writeFileSync(
      sink,
      [
        JSON.stringify(receipt({ run_id: 'r-1', ts: Date.parse('2026-06-08T00:00:01.000Z') })),
        JSON.stringify(receipt({ run_id: 'r-3', ts: Date.parse('2026-06-08T00:00:03.000Z') })),
      ].join('\n') + '\n',
    );
    expect(readLastProcessed({ logPath, now: NOW })).toEqual({
      at: '2026-06-08T00:00:03.000Z',
      anchor: null,
      age_ms: 2000,
      correlation_token: 'r-3',
    });
  });

  it('returns null when no logPath/receiptSinkPath/readReceipts is given', () => {
    expect(readLastProcessed({ now: NOW })).toBeNull();
  });

  it('returns null when the receipt sink file is missing', () => {
    expect(
      readLastProcessed({ receiptSinkPath: join(tmp, 'nope', RECEIPT_SINK_FILENAME), now: NOW }),
    ).toBeNull();
  });

  it('returns null (never throws) on a garbage receipt sink file', () => {
    const path = join(tmp, RECEIPT_SINK_FILENAME);
    writeFileSync(path, 'not json at all {{{\n{"partial":true}\n');
    expect(readLastProcessed({ receiptSinkPath: path, now: NOW })).toBeNull();
  });
});
