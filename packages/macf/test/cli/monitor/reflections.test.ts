/**
 * Tests for the reflection JSONL reader (macf#502, DR-026 F4).
 *
 * Asserts that malformed lines (bad JSON + valid-JSON-wrong-shape) are SKIPPED
 * defensively — never fatal — and that valid records parse + aggregate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readReflections } from '../../../src/cli/monitor/reflections.js';

function validLine(key?: string): string {
  return JSON.stringify({
    schema_version: '1.0',
    kind: 'macf.reflection',
    agent: { name: 'code-agent', role: 'code-agent', login: 'a' },
    project: 'macf',
    session_id: 's',
    timestamp: '2026-06-16T04:00:00Z',
    trigger: 'pre-compact',
    compaction_type: 'auto',
    rule_evolution_signals: key
      ? [{ signal: 'sig', proposed_tier: 'canonical', rationale: 'r', key }]
      : [],
  });
}

describe('readReflections', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `macf-refl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'reflections'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty (no throw) when the dir does not exist', () => {
    const res = readReflections(join(dir, 'does-not-exist'));
    expect(res.records).toHaveLength(0);
    expect(res.files).toBe(0);
    expect(res.skipped).toBe(0);
  });

  it('parses valid lines and skips malformed ones without throwing', () => {
    const reflDir = join(dir, 'reflections');
    const content = [
      validLine('k1'),
      'this is not json at all',          // bad JSON → skipped
      '',                                  // blank → ignored, not a skip
      JSON.stringify({ kind: 'wrong', schema_version: '9.9' }), // valid JSON, wrong shape → skipped
      validLine('k2'),
    ].join('\n');
    writeFileSync(join(reflDir, 'code-agent.jsonl'), content + '\n');

    const res = readReflections(reflDir);
    expect(res.records).toHaveLength(2);
    expect(res.skipped).toBe(2);
    expect(res.files).toBe(1);
  });

  it('reads multiple jsonl files and ignores non-jsonl files', () => {
    const reflDir = join(dir, 'reflections');
    writeFileSync(join(reflDir, 'a.jsonl'), validLine('ka') + '\n');
    writeFileSync(join(reflDir, 'b.jsonl'), validLine('kb') + '\n');
    writeFileSync(join(reflDir, 'pending.json'), '{"not":"a ledger"}'); // ignored (not .jsonl)
    writeFileSync(join(reflDir, 'notes.txt'), 'ignored');

    const res = readReflections(reflDir);
    expect(res.files).toBe(2);
    expect(res.records).toHaveLength(2);
  });
});
