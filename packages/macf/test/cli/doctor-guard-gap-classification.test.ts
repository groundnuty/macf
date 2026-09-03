/**
 * Tests for the groundnuty/macf#1401 second-increment systemic-vs-
 * individual guard-gap classifier — `classifyGuardGapCause`.
 *
 * The motivating population (a fleet where the guard-presence detector
 * fired on every agent, per two independent causes) was repaired before
 * this classifier shipped — so per the issue thread's ruling (comment 13),
 * the decisive triple below SYNTHESISES both systemic signatures as
 * fixtures rather than relying on a live incident this classifier would
 * otherwise never have met:
 *
 *   1. CLI without plugin/scripts/           → systemic-packaging
 *   2. plugin hooks.json with 0 PreToolUse   → systemic-pin
 *   3. both present, hooks registered        → healthy — no classification
 *
 * A fourth case pins the independence requirement explicitly: both
 * signatures can fire TOGETHER (comment 11 — the two are independent
 * defects with the same symptom; fixing one must not read as "the fix
 * failed" while the other's warning persists), so `classifyGuardGapCause`
 * returns every matching cause, not a first-match verdict.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { classifyGuardGapCause } from '../../src/cli/commands/doctor.js';

describe('classifyGuardGapCause (groundnuty/macf#1401 second increment)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-guard-gap-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeClaudeSh(pluginDirExpr: string): void {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        '#!/bin/bash',
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
        `exec claude --plugin-dir "${pluginDirExpr}" "$@"`,
        '',
      ].join('\n'),
    );
  }

  function writePluginHooksJson(pluginRelDir: string, preToolUseEntries: readonly unknown[] | undefined): void {
    const dir = join(tmpRoot, pluginRelDir, 'hooks');
    mkdirSync(dir, { recursive: true });
    const hooks = preToolUseEntries === undefined ? {} : { PreToolUse: preToolUseEntries };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  }

  /** One populated PreToolUse hook entry, matching hooks.json's real shape. */
  function preToolUseEntry(command: string): unknown {
    return { hooks: [{ type: 'command', command }] };
  }

  // --- Decisive triple ---

  it('DECISIVE 1/3: CLI without plugin/scripts/ classifies systemic-packaging', () => {
    const result = classifyGuardGapCause(tmpRoot, { pluginScriptsDir: join(tmpRoot, 'nonexistent-plugin-scripts') });
    expect(result.causes).toEqual(['systemic-packaging']);
    expect(result.descriptions).toHaveLength(1);
    expect(result.descriptions[0]).toMatch(/packaging defect/);
    expect(result.descriptions[0]).toMatch(/not individually broken/);
    // Never cites an internal issue number — this is user-facing CLI text.
    expect(result.descriptions[0]).not.toMatch(/\bmacf#\d+\b/);
  });

  it('DECISIVE 2/3: the mounted plugin hooks.json with 0 PreToolUse entries classifies systemic-pin', () => {
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', []);
    // pluginScriptsDir left at its default (the real running CLI's own
    // plugin/scripts/, which exists in this checkout) so systemic-packaging
    // does not also fire — isolating the pin signature.
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual(['systemic-pin']);
    expect(result.descriptions).toHaveLength(1);
    expect(result.descriptions[0]).toMatch(/version-pin defect at deploy/);
    expect(result.descriptions[0]).toMatch(/not individually broken/);
    expect(result.descriptions[0]).not.toMatch(/\bmacf#\d+\b/);
  });

  it('DECISIVE 3/3: both present + hooks registered — no classification (healthy fixture)', () => {
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', [preToolUseEntry('$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-token.sh')]);
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual([]);
    expect(result.descriptions).toEqual([]);
  });

  // --- Independence: both signatures can fire together ---

  it('reports BOTH causes when both signatures are present — not a first-match verdict', () => {
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', []);
    const result = classifyGuardGapCause(tmpRoot, { pluginScriptsDir: join(tmpRoot, 'nonexistent-plugin-scripts') });
    expect(result.causes).toEqual(['systemic-packaging', 'systemic-pin']);
    expect(result.descriptions).toHaveLength(2);
  });

  // --- Edge cases guarding against over-firing ---

  it('does NOT classify systemic-pin when the plugin dir is not determinable (no claude.sh at all — a bare workspace is not evidence of a deploy defect)', () => {
    // Deliberately no claude.sh — resolvePluginDirFromClaudeSh returns
    // determinable: false, and pluginScriptsDir defaults to the real
    // (existing) CLI dir, so nothing should fire.
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual([]);
  });

  it('does NOT classify systemic-pin when claude.sh has multiple ambiguous --plugin-dir values', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        '#!/bin/bash',
        'exec claude --plugin-dir "/one/path" --plugin-dir "/two/path" "$@"',
        '',
      ].join('\n'),
    );
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual([]);
  });

  it('classifies systemic-pin when hooks.json exists but has no PreToolUse key at all (not just an empty array)', () => {
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', undefined); // hooks: {} — no PreToolUse key
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual(['systemic-pin']);
  });

  it('classifies systemic-pin when the resolved plugin dir has no hooks.json file at all', () => {
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    mkdirSync(join(tmpRoot, '.macf', 'plugin'), { recursive: true }); // dir exists, no hooks/hooks.json
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual(['systemic-pin']);
  });

  it('does not misclassify when the mounted plugin has a non-empty PreToolUse array with an entry carrying zero hooks', () => {
    // A matcher group present but its own `hooks` array empty registers
    // nothing — countPreToolUseEntries must sum actual hook entries, not
    // just check the PreToolUse array's own length.
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', [{ hooks: [] }]);
    const result = classifyGuardGapCause(tmpRoot);
    expect(result.causes).toEqual(['systemic-pin']);
  });
});
