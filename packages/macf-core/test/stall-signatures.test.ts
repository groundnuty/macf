/**
 * Tests for the stall-signature pure logic (DR-037 / groundnuty/macf#686) — the
 * schema/loader, the case-insensitive pane matcher, the per-action fire-cap, and
 * the seed's validity + fidelity to the devops `stall-signatures.json` reference.
 *
 * The `macf fleet resume` decision layer + the devops `resume.sh` bash both
 * reimplement match-then-dispatch over this data; these are the reference spec.
 */
import { describe, it, expect } from 'vitest';
import {
  STALL_ACTIONS,
  DEFAULT_NUDGE_MAX_FIRES,
  DEFAULT_REPORT_MAX_FIRES,
  StallSignatureEntrySchema,
  StallSignaturesConfigSchema,
  StallSignaturesError,
  STALL_SIGNATURES_SEED,
  loadStallSignatures,
  matchStallSignature,
  resolveMaxFires,
  canFireStall,
  type StallSignatureEntry,
} from '../src/stall-signatures.js';

const NUDGE: StallSignatureEntry = {
  name: 'rate-limit',
  signature: '(temporarily limiting requests|Rate limited)',
  action: 'nudge',
  nudge: 'please continue',
  max_fires: 4,
};
const REPORT: StallSignatureEntry = {
  name: 'permission-prompt',
  signature: 'Do you want to proceed\\?',
  action: 'report',
  report: 'blocked on a permission prompt',
  max_fires: 1,
};

describe('StallSignatureEntrySchema', () => {
  it('defaults action to nudge when omitted', () => {
    const e = StallSignatureEntrySchema.parse({ name: 'x', signature: 'foo' });
    expect(e.action).toBe('nudge');
  });

  it('accepts the two actions and an optional comment', () => {
    expect(STALL_ACTIONS).toEqual(['nudge', 'report']);
    const e = StallSignatureEntrySchema.parse({
      name: 'x',
      signature: 'foo',
      action: 'report',
      comment: 'why this exists',
    });
    expect(e.action).toBe('report');
    expect(e.comment).toBe('why this exists');
  });

  it('is strict — a typo\'d field name is a loud error', () => {
    expect(() => StallSignatureEntrySchema.parse({ name: 'x', signatures: 'foo' })).toThrow();
  });

  it('rejects an unknown action', () => {
    expect(() => StallSignatureEntrySchema.parse({ name: 'x', signature: 'f', action: 'answer' })).toThrow();
  });
});

describe('loadStallSignatures', () => {
  it('accepts a bare array (the reference shape)', () => {
    const entries = loadStallSignatures([NUDGE, REPORT]);
    expect(entries).toHaveLength(2);
  });

  it('throws StallSignaturesError on a non-array / schema-invalid config', () => {
    expect(() => loadStallSignatures({ entries: [] })).toThrow(StallSignaturesError);
    expect(() => loadStallSignatures([{ name: '', signature: 'f' }])).toThrow(StallSignaturesError);
  });

  it('throws StallSignaturesError (fail-loud) on an uncompilable regex signature', () => {
    expect(() => loadStallSignatures([{ name: 'bad', signature: '(' }])).toThrow(StallSignaturesError);
    expect(() => loadStallSignatures([{ name: 'bad', signature: '(' }])).toThrow(/invalid regex/i);
  });
});

describe('matchStallSignature', () => {
  const entries = [NUDGE, REPORT];

  it('matches case-insensitively (mirrors grep -iE)', () => {
    expect(matchStallSignature('… API Error · rate LIMITED ·', entries)?.name).toBe('rate-limit');
  });

  it('matches a report signature', () => {
    expect(matchStallSignature('Do you want to proceed? ❯ 1. Yes', entries)?.name).toBe('permission-prompt');
  });

  it('returns null on an unmatched pane (idle-CLEAN — never touched)', () => {
    expect(matchStallSignature('❯ DR-032 ok, all green', entries)).toBeNull();
    expect(matchStallSignature('', entries)).toBeNull();
  });

  it('returns the FIRST matching entry (allowlist order)', () => {
    const both: StallSignatureEntry[] = [
      { name: 'first', signature: 'shared', action: 'nudge' },
      { name: 'second', signature: 'shared', action: 'report' },
    ];
    expect(matchStallSignature('a shared line', both)?.name).toBe('first');
  });

  it('skips an uncompilable signature rather than throwing (total matcher)', () => {
    const withBad: StallSignatureEntry[] = [
      { name: 'bad', signature: '(', action: 'nudge' },
      NUDGE,
    ];
    expect(matchStallSignature('Rate limited', withBad)?.name).toBe('rate-limit');
  });
});

describe('resolveMaxFires / canFire', () => {
  it('uses the explicit max_fires when present', () => {
    expect(resolveMaxFires(NUDGE)).toBe(4);
    expect(resolveMaxFires(REPORT)).toBe(1);
  });

  it('falls back to the per-action default (nudge 3 / report 1)', () => {
    expect(resolveMaxFires({ name: 'n', signature: 'f', action: 'nudge' })).toBe(DEFAULT_NUDGE_MAX_FIRES);
    expect(resolveMaxFires({ name: 'r', signature: 'f', action: 'report' })).toBe(DEFAULT_REPORT_MAX_FIRES);
    expect(DEFAULT_NUDGE_MAX_FIRES).toBe(3);
    expect(DEFAULT_REPORT_MAX_FIRES).toBe(1);
  });

  it('canFireStall gates on the resolved cap', () => {
    expect(canFireStall(REPORT, 0)).toBe(true);
    expect(canFireStall(REPORT, 1)).toBe(false); // report cap = 1
    expect(canFireStall(NUDGE, 3)).toBe(true);
    expect(canFireStall(NUDGE, 4)).toBe(false); // nudge cap = 4
  });
});

describe('STALL_SIGNATURES_SEED', () => {
  it('validates against the config schema', () => {
    expect(() => StallSignaturesConfigSchema.parse(STALL_SIGNATURES_SEED)).not.toThrow();
    expect(() => loadStallSignatures(STALL_SIGNATURES_SEED)).not.toThrow();
  });

  it('ships the 5 reference signatures with the right actions', () => {
    const byName = new Map(STALL_SIGNATURES_SEED.map((e) => [e.name, e]));
    expect(byName.get('rate-limit')?.action).toBe('nudge');
    expect(byName.get('turn-aborted')?.action).toBe('nudge');
    expect(byName.get('permission-prompt')?.action).toBe('report');
    expect(byName.get('trust-folder-prompt')?.action).toBe('report');
    expect(byName.get('skill-or-memory-prompt')?.action).toBe('report');
  });

  it('every seed regex compiles', () => {
    for (const e of STALL_SIGNATURES_SEED) {
      expect(() => new RegExp(e.signature, 'i')).not.toThrow();
    }
  });

  it('matches the reference panes the way resume.sh does', () => {
    const seed = STALL_SIGNATURES_SEED;
    expect(matchStallSignature('API Error: Server is temporarily limiting requests · Rate limited', seed)?.name).toBe('rate-limit');
    expect(matchStallSignature("Do you want to proceed? ❯ 1. Yes  2. Yes, and don't ask again  3. No", seed)?.name).toBe('permission-prompt');
    expect(matchStallSignature('Do you trust the files in this folder? ❯ 1. Yes, proceed', seed)?.name).toBe('trust-folder-prompt');
    expect(matchStallSignature('❯ DR-032 ok', seed)).toBeNull();
  });
});
