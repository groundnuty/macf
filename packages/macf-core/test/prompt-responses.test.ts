/**
 * Tests for the interactive-prompt auto-responder pure logic (DR-033,
 * groundnuty/macf#645). SAFETY-CRITICAL — these cover the three constitutional
 * invariants:
 *   Inv 1 — allowlist-only + unknown-prompt → alert (never answer)
 *   Inv 2 — ceremony-only config classifier (refuse delete/overwrite/trust/revoke/remove;
 *           warn (y/n)/allow/permission/grant)
 *   Inv 3 — structured signature: option_text at the send ordinal → reorder
 *           breaks the match → falls through to Inv 1
 * plus the fire cap + verify-the-right-outcome logic.
 *
 * The shell watcher (scripts/macf-prompt-watcher.sh) reimplements this same
 * algorithm; these tests are the reference spec for both.
 */
import { describe, it, expect } from 'vitest';
import {
  PromptResponseEntrySchema,
  PromptResponsesConfigSchema,
  PROMPT_RESPONSES_SCHEMA_VERSION,
  PROMPT_RESPONSES_SEED,
  PROMPT_REFUSE_SUBSTRINGS,
  PROMPT_WARN_SUBSTRINGS,
  PromptResponderError,
  classifyPromptSignature,
  loadPromptResponses,
  looksPromptLike,
  optionOnSendLine,
  entryMatchesFrame,
  matchPromptFrame,
  canFire,
  verifyOutcome,
  type PromptResponseEntry,
} from '../src/prompt-responses.js';

/** A well-formed ceremony entry (dev-channels shape). */
const devChannels: PromptResponseEntry = {
  name: 'dev-channels',
  frame_contains: ['I am using this for local development'],
  option_text: 'I am using this for local development',
  send: '1',
  max_fires: 1,
};

/** A realistic dev-channels frame as rendered by Claude Code. */
const DEV_FRAME = [
  '⚠ Development channels',
  'Loading development channels can be dangerous.',
  '❯ 1. I am using this for local development',
  '  2. Cancel',
].join('\n');

describe('schema', () => {
  it('parses a full valid entry + applies max_fires default', () => {
    const parsed = PromptResponseEntrySchema.parse({
      name: 'x',
      frame_contains: ['a'],
      option_text: 'a',
      send: '1',
    });
    expect(parsed.max_fires).toBe(1);
    expect(parsed.verify_contains).toBeUndefined();
  });

  it('rejects an unknown field on an entry (strict — catches operator typos)', () => {
    const r = PromptResponseEntrySchema.safeParse({
      name: 'x',
      frame_contain: ['a'], // typo: missing s
      option_text: 'a',
      send: '1',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty frame_contains / missing required fields', () => {
    expect(PromptResponseEntrySchema.safeParse({ name: 'x', frame_contains: [], option_text: 'a', send: '1' }).success).toBe(false);
    expect(PromptResponseEntrySchema.safeParse({ name: 'x', frame_contains: ['a'], send: '1' }).success).toBe(false);
  });

  it('config strips an unknown top-level key (allows the seed _comment)', () => {
    const r = PromptResponsesConfigSchema.parse({
      schema_version: '1',
      entries: [],
      _comment: 'hello',
    });
    expect((r as Record<string, unknown>)['_comment']).toBeUndefined();
  });

  it('requires the exact schema_version literal', () => {
    expect(PromptResponsesConfigSchema.safeParse({ schema_version: '2', entries: [] }).success).toBe(false);
  });
});

describe('Inv 2 — classifyPromptSignature', () => {
  it('accepts a clean ceremony signature', () => {
    expect(classifyPromptSignature(devChannels)).toBe('ok');
  });

  it.each(PROMPT_REFUSE_SUBSTRINGS)('HARD-REFUSES a signature containing %s', (sub) => {
    const e: PromptResponseEntry = { ...devChannels, frame_contains: [`please ${sub} it`], option_text: 'ok' };
    expect(classifyPromptSignature(e)).toBe('refuse');
  });

  it.each(PROMPT_WARN_SUBSTRINGS)('LOUD-WARNS a signature containing %s', (sub) => {
    const e: PromptResponseEntry = { ...devChannels, option_text: `do you want to ${sub} this?` };
    expect(classifyPromptSignature(e)).toBe('warn');
  });

  it('refuse wins over warn (destructive checked first)', () => {
    const e: PromptResponseEntry = { ...devChannels, frame_contains: ['allow'], option_text: 'delete files' };
    expect(classifyPromptSignature(e)).toBe('refuse');
  });

  it('classification is case-insensitive', () => {
    const e: PromptResponseEntry = { ...devChannels, option_text: 'TRUST this folder' };
    expect(classifyPromptSignature(e)).toBe('refuse');
  });
});

describe('Inv 2 — loadPromptResponses', () => {
  it('drops refused entries, keeps warned + ok entries', () => {
    const loaded = loadPromptResponses({
      schema_version: '1',
      entries: [
        devChannels,
        { name: 'bad', frame_contains: ['delete everything'], option_text: 'yes', send: '1', max_fires: 1 },
        { name: 'warn', frame_contains: ['allow access'], option_text: 'allow access', send: '1', max_fires: 1 },
      ],
    });
    expect(loaded.accepted.map((e) => e.name)).toEqual(['dev-channels', 'warn']);
    expect(loaded.refused.map((r) => r.entry.name)).toEqual(['bad']);
    expect(loaded.refused[0]?.matched).toBe('delete');
    expect(loaded.warned.map((w) => w.entry.name)).toEqual(['warn']);
    expect(loaded.warned[0]?.matched).toBe('allow');
  });

  it('throws PromptResponderError (loud) on a schema-invalid config', () => {
    expect(() => loadPromptResponses({ schema_version: '1', entries: [{ name: 'x' }] })).toThrow(PromptResponderError);
  });

  it('throws on a non-object / wrong version', () => {
    expect(() => loadPromptResponses(null)).toThrow(PromptResponderError);
    expect(() => loadPromptResponses({ schema_version: '9', entries: [] })).toThrow(PromptResponderError);
  });
});

describe('Inv 1 — looksPromptLike', () => {
  it('detects a ❯ menu selector', () => {
    expect(looksPromptLike(DEV_FRAME)).toBe(true);
  });
  it('detects (y/n) style confirmations', () => {
    expect(looksPromptLike('Continue? (y/n)')).toBe(true);
    expect(looksPromptLike('Overwrite? [y/N]')).toBe(true);
  });
  it('is false for ordinary agent output', () => {
    expect(looksPromptLike('Running tests...\nAll 47 passing.')).toBe(false);
  });

  // groundnuty/macf#729 — ❯ is overloaded: it is also the Claude Code
  // free-form input-box cursor, not just the menu-selection cursor. A queued
  // message in the input box must NOT be misread as an unknown prompt.
  it('is false for a queued message in the free-form input box (macf#729)', () => {
    expect(
      looksPromptLike('❯ you merge pleasee, complete startup-reconcile (DR-008)'),
    ).toBe(false);
  });
  it('is false for an empty input box', () => {
    expect(looksPromptLike('❯ ')).toBe(false);
    expect(looksPromptLike('❯')).toBe(false);
  });
  it('is still true for a real numbered menu even without a matching allowlist entry', () => {
    expect(looksPromptLike('❯ 1. Yes, proceed\n  2. No')).toBe(true);
    expect(looksPromptLike('❯ 2) No')).toBe(true);
  });
});

describe('Inv 3 — optionOnSendLine', () => {
  it('matches option_text on the correctly-numbered line', () => {
    expect(optionOnSendLine(DEV_FRAME, 'I am using this for local development', '1')).toBe(true);
  });
  it('does NOT match when the send ordinal points at a different line (reorder guard)', () => {
    expect(optionOnSendLine(DEV_FRAME, 'I am using this for local development', '2')).toBe(false);
  });
  it('binds to the boundary — send "1" does not match a "10." line', () => {
    const frame = '❯ 10. I am using this for local development';
    expect(optionOnSendLine(frame, 'I am using this for local development', '1')).toBe(false);
    expect(optionOnSendLine(frame, 'I am using this for local development', '10')).toBe(true);
  });
  it('handles ) and : and bare-ordinal boundaries', () => {
    expect(optionOnSendLine('  2) Resume', 'Resume', '2')).toBe(true);
    expect(optionOnSendLine('❯ 3: Continue', 'Continue', '3')).toBe(true);
  });
  it('non-numeric send falls back to option_text presence', () => {
    expect(optionOnSendLine('Trust? y/n', 'Trust?', 'y')).toBe(true);
  });
});

describe('Inv 1 + Inv 3 — matchPromptFrame', () => {
  it('matches a known ceremony prompt', () => {
    const r = matchPromptFrame(DEV_FRAME, [devChannels]);
    expect(r.kind).toBe('match');
    expect(r.kind === 'match' && r.entry.name).toBe('dev-channels');
  });

  it('a menu reorder breaks the match → unknown-prompt (alert, never answer)', () => {
    // The option text moved to line 2 but the config still says send "1".
    const reordered = ['❯ 1. Cancel', '  2. I am using this for local development'].join('\n');
    const r = matchPromptFrame(reordered, [devChannels]);
    expect(r.kind).toBe('unknown-prompt');
  });

  it('a reworded option breaks the match → unknown-prompt', () => {
    const reworded = '❯ 1. I am running this locally for dev\n  2. Cancel';
    expect(matchPromptFrame(reworded, [devChannels]).kind).toBe('unknown-prompt');
  });

  it('an unknown prompt-like frame → unknown-prompt', () => {
    expect(matchPromptFrame('❯ 1. Delete all files\n  2. Keep', [devChannels]).kind).toBe('unknown-prompt');
  });

  it('ordinary output with no prompt → none', () => {
    expect(matchPromptFrame('building...\ndone', [devChannels]).kind).toBe('none');
  });

  it('requires ALL frame_contains present (partial render → no premature fire)', () => {
    const entry: PromptResponseEntry = {
      name: 'multi',
      frame_contains: ['Header line', 'I am using this for local development'],
      option_text: 'I am using this for local development',
      send: '1',
      max_fires: 1,
    };
    // Only the option rendered so far, header not yet → not a match; frame is
    // prompt-like → unknown (alert), NOT a premature answer.
    const partial = '❯ 1. I am using this for local development';
    expect(matchPromptFrame(partial, [entry]).kind).toBe('unknown-prompt');
    // Full frame → match.
    const full = 'Header line\n❯ 1. I am using this for local development';
    expect(matchPromptFrame(full, [entry]).kind).toBe('match');
  });
});

describe('fire cap — canFire', () => {
  it('allows firing under the cap and blocks at/over it', () => {
    expect(canFire(devChannels, 0)).toBe(true);
    expect(canFire(devChannels, 1)).toBe(false);
    const twice: PromptResponseEntry = { ...devChannels, max_fires: 2 };
    expect(canFire(twice, 1)).toBe(true);
    expect(canFire(twice, 2)).toBe(false);
  });
});

describe('verify the RIGHT outcome — verifyOutcome', () => {
  it('not-cleared when the same signature still matches (typed-no-Enter)', () => {
    expect(verifyOutcome(DEV_FRAME, devChannels)).toBe('not-cleared');
  });

  it('weak-ok when cleared but no verify_contains configured', () => {
    expect(verifyOutcome('welcome to claude', devChannels)).toBe('weak-ok');
  });

  it('ok when cleared AND verify_contains present', () => {
    const e: PromptResponseEntry = { ...devChannels, verify_contains: 'How can I help' };
    expect(verifyOutcome('How can I help you today?', e)).toBe('ok');
  });

  it('wrong-outcome when cleared but verify_contains absent (a wrong answer also clears)', () => {
    const e: PromptResponseEntry = { ...devChannels, verify_contains: 'How can I help' };
    expect(verifyOutcome('Some other unexpected screen', e)).toBe('wrong-outcome');
  });
});

describe('canonical seed', () => {
  it('has schema_version + two ceremony entries', () => {
    expect(PROMPT_RESPONSES_SEED.schema_version).toBe(PROMPT_RESPONSES_SCHEMA_VERSION);
    expect(PROMPT_RESPONSES_SEED.entries.map((e) => e.name)).toEqual(['dev-channels', 'resume-summary']);
  });

  it('validates against the schema', () => {
    expect(PromptResponsesConfigSchema.safeParse(PROMPT_RESPONSES_SEED).success).toBe(true);
  });

  it('every seed entry is Inv-2 clean (ok — not refused/warned)', () => {
    const loaded = loadPromptResponses(PROMPT_RESPONSES_SEED);
    expect(loaded.refused).toHaveLength(0);
    expect(loaded.warned).toHaveLength(0);
    expect(loaded.accepted).toHaveLength(2);
  });

  it('the dev-channels seed matches its realistic frame', () => {
    const seed = PROMPT_RESPONSES_SEED.entries[0]!;
    expect(entryMatchesFrame(DEV_FRAME, seed)).toBe(true);
  });
});
