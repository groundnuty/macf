/**
 * THE load-bearing test (macf#502, DR-026 F4): the Monitor is strictly
 * READ-ONLY. Drive `runMonitor` through a recording fake GitHub seam and assert
 * that ONLY read operations (listOpenIssues / listOpenPRs) were ever issued —
 * never a create / comment / close / edit / merge.
 *
 * Two complementary guards:
 *   1. The recorder logs every method invoked on the seam; we assert the set of
 *      invoked methods is a subset of the allowed read methods.
 *   2. A Proxy trap fails the test LOUDLY if any non-read property is ever
 *      accessed as a function — so if a future refactor adds a mutating call,
 *      this test catches it even if the method name is new.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runMonitor } from '../../../src/cli/monitor/run.js';
import type { GitHubReader, MonitorIssue, MonitorPR } from '../../../src/cli/monitor/github-reader.js';

const READ_METHODS = new Set(['listOpenIssues', 'listOpenPRs']);

// Any method name that smells like a mutation. If the seam ever grows one and a
// caller invokes it, the Proxy trap below throws.
const MUTATION_HINT = /create|comment|close|merge|edit|update|delete|post|patch|put|add|remove|set|write|label/i;

interface RecordingReader extends GitHubReader {
  readonly calls: string[];
}

function makeRecordingReader(): { reader: GitHubReader; calls: string[] } {
  const calls: string[] = [];
  const issues: MonitorIssue[] = [
    { number: 1, title: 'i', createdAt: '2026-06-01T00:00:00Z', labels: ['code-agent'] },
  ];
  const prs: MonitorPR[] = [
    { number: 2, title: 'p', createdAt: '2026-06-10T00:00:00Z', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', isDraft: false },
  ];

  const base: RecordingReader = {
    calls,
    async listOpenIssues() {
      calls.push('listOpenIssues');
      return issues;
    },
    async listOpenPRs() {
      calls.push('listOpenPRs');
      return prs;
    },
  };

  // Proxy: record every property access; throw if anything mutation-shaped is
  // touched. This catches a future regression even if it uses a brand-new name.
  const reader = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && MUTATION_HINT.test(prop) && !READ_METHODS.has(prop)) {
        throw new Error(`READ-ONLY VIOLATION: Monitor touched mutating member "${prop}"`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return { reader, calls };
}

describe('Monitor is strictly read-only', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `macf-ro-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, '.claude', '.macf', 'reflections'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('issues only read operations against the GitHub seam', async () => {
    const { reader, calls } = makeRecordingReader();

    const md = await runMonitor({
      project: 'macf',
      repo: 'groundnuty/macf',
      sinceDays: 14,
      reflectionsDir: join(dir, '.claude', '.macf', 'reflections'),
      workspaceDir: dir,
      reader,
      now: () => Date.parse('2026-06-16T12:00:00Z'),
    });

    // Sanity: it actually produced a digest.
    expect(md).toContain('# Protocol-Health Digest');

    // Every recorded call must be a read method — no mutations.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(READ_METHODS.has(c)).toBe(true);
    }
    expect(calls).toContain('listOpenIssues');
    expect(calls).toContain('listOpenPRs');
  });

  it('never writes to GitHub even when reflections contain evolution signals', async () => {
    // Surfacing a candidate signal in the digest is REPORTING, not proposing —
    // it must not trigger any mutation on the seam.
    const reflDir = join(dir, '.claude', '.macf', 'reflections');
    writeFileSync(
      join(reflDir, 'code-agent.jsonl'),
      JSON.stringify({
        schema_version: '1.0',
        kind: 'macf.reflection',
        agent: { name: 'code-agent', role: 'code-agent', login: 'a' },
        project: 'macf',
        session_id: 's',
        timestamp: '2026-06-16T04:00:00Z',
        trigger: 'pre-compact',
        compaction_type: 'auto',
        rule_evolution_signals: [
          { signal: 'promote X to canonical', proposed_tier: 'canonical', rationale: 'r', key: 'x' },
        ],
      }) + '\n',
    );

    const { reader, calls } = makeRecordingReader();

    const md = await runMonitor({
      project: 'macf',
      repo: 'groundnuty/macf',
      sinceDays: 14,
      reflectionsDir: reflDir,
      workspaceDir: dir,
      reader,
      now: () => Date.parse('2026-06-16T12:00:00Z'),
    });

    // The signal is SURFACED in the digest text...
    expect(md).toContain('promote X to canonical');
    // ...but no mutation ever reached the seam.
    for (const c of calls) {
      expect(READ_METHODS.has(c)).toBe(true);
    }
  });
});
