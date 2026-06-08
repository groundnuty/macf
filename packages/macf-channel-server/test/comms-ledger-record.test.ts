/**
 * Unit tests for `recordEdge` — the loud-but-proceeds policy slot
 * (macf#473 piece 2; operator decision 2026-06-08).
 *
 * The library writer `appendEdge` is fail-loud (throws); `recordEdge` wraps
 * it so a write failure at a coordination edge site is loud (logger.error +
 * metric) but never fatal (returns normally, caller proceeds). These tests
 * pin all three guarantees:
 *   (a) happy path appends the edge,
 *   (b) write-failure still RETURNS (no throw), logs comms_ledger_write_failed
 *       WITH the edge, and increments the metric,
 *   (c) the loud signal carries the edge inline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCommsLedger, COMMS_LEDGER_FILENAME } from '../src/comms-ledger.js';
import type { CommsLedger, CommsLedgerEdge } from '../src/comms-ledger.js';
import { recordEdge } from '../src/comms-ledger-record.js';

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
  tmp = mkdtempSync(join(tmpdir(), 'macf-ledger-record-'));
  fakeLogger.info.mockReset();
  fakeLogger.warn.mockReset();
  fakeLogger.error.mockReset();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('recordEdge — happy path', () => {
  it('appends the edge to the ledger', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    const recordWriteFailed = vi.fn();

    recordEdge(
      { ledger, logger: fakeLogger as never, recordWriteFailed },
      edge({ msg_id: 'happy-1' }),
    );

    const rec = JSON.parse(readFileSync(path, 'utf8').trim()) as CommsLedgerEdge;
    expect(rec.msg_id).toBe('happy-1');
    // no failure signal on the happy path
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(recordWriteFailed).not.toHaveBeenCalled();
  });

  it('is a clean no-op (no throw, no signal) on the no-op ledger', () => {
    const ledger = createCommsLedger({}); // no path → NOOP_LEDGER
    const recordWriteFailed = vi.fn();
    expect(() =>
      recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, edge()),
    ).not.toThrow();
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(recordWriteFailed).not.toHaveBeenCalled();
  });
});

describe('recordEdge — loud-but-proceeds on write failure', () => {
  /**
   * Build a ledger whose `appendEdge` throws, two ways:
   *  - real EISDIR: path is a directory (root-safe; matches comms-ledger.test.ts)
   *  - stub: an appendEdge that throws synchronously (covers the policy seam
   *    without relying on fs behavior)
   */
  function dirBackedLedger(): CommsLedger {
    const path = join(tmp, 'asdir', COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    // Replace the file with a directory → appendFileSync gets EISDIR.
    rmSync(path);
    mkdirSync(path);
    return ledger;
  }

  it('does NOT throw when the ledger write fails (delivery is never blocked)', () => {
    const ledger = dirBackedLedger();
    const recordWriteFailed = vi.fn();
    expect(() =>
      recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, edge()),
    ).not.toThrow();
  });

  it('emits logger.error(comms_ledger_write_failed) carrying the edge inline + the error', () => {
    const ledger = dirBackedLedger();
    const recordWriteFailed = vi.fn();
    const e = edge({ msg_id: 'lost-1', channel: 'github-route', direction: 'recv' });

    recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, e);

    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    const [event, data] = fakeLogger.error.mock.calls[0]!;
    expect(event).toBe('comms_ledger_write_failed');
    // the edge is carried inline so the lost authoritative record is reconstructable
    expect((data as { edge: CommsLedgerEdge }).edge).toEqual(e);
    expect(typeof (data as { error: string }).error).toBe('string');
    expect((data as { error: string }).error.length).toBeGreaterThan(0);
  });

  it('increments the write-failed metric, passing the failed edge for label derivation', () => {
    const ledger = dirBackedLedger();
    const recordWriteFailed = vi.fn();
    const e = edge({ channel: 'a2a', direction: 'send' });

    recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, e);

    expect(recordWriteFailed).toHaveBeenCalledTimes(1);
    expect(recordWriteFailed).toHaveBeenCalledWith(e);
  });

  it('still logs (loud) even when no metric recorder is wired', () => {
    const ledger = dirBackedLedger();
    expect(() =>
      recordEdge({ ledger, logger: fakeLogger as never }, edge()),
    ).not.toThrow();
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'comms_ledger_write_failed',
      expect.objectContaining({ edge: expect.any(Object) }),
    );
  });

  it('catches the schema-parse throw too (bad edge → loud, not fatal)', () => {
    const path = join(tmp, COMMS_LEDGER_FILENAME);
    const ledger = createCommsLedger({ ledgerPath: path });
    const recordWriteFailed = vi.fn();
    // appendEdge runs CommsLedgerEdgeSchema.parse → throws on a bad channel.
    const bad = { ...edge(), channel: 'smoke-signal' } as unknown as CommsLedgerEdge;
    expect(() =>
      recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, bad),
    ).not.toThrow();
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'comms_ledger_write_failed',
      expect.objectContaining({ edge: bad }),
    );
    expect(recordWriteFailed).toHaveBeenCalledWith(bad);
  });

  it('a misbehaving metric recorder cannot turn the policy fatal (last-ditch guard)', () => {
    const ledger = dirBackedLedger();
    const recordWriteFailed = vi.fn(() => {
      throw new Error('metric sink blew up');
    });
    expect(() =>
      recordEdge({ ledger, logger: fakeLogger as never, recordWriteFailed }, edge()),
    ).not.toThrow();
    // both the primary loud signal AND the metric-error signal landed
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'comms_ledger_write_failed',
      expect.any(Object),
    );
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'comms_ledger_write_failed_metric_error',
      expect.any(Object),
    );
  });

  it('uses a stub ledger whose appendEdge throws (policy seam, fs-independent)', () => {
    const throwingLedger: CommsLedger = {
      path: '/does/not/matter',
      appendEdge: () => {
        throw new Error('stub write failure');
      },
    };
    const recordWriteFailed = vi.fn();
    expect(() =>
      recordEdge({ ledger: throwingLedger, logger: fakeLogger as never, recordWriteFailed }, edge()),
    ).not.toThrow();
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'comms_ledger_write_failed',
      expect.objectContaining({ error: 'stub write failure' }),
    );
    expect(recordWriteFailed).toHaveBeenCalledTimes(1);
  });
});
