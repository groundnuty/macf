/**
 * GATE 2 — dry-run by DEFAULT (macf#503, DR-026 G1). The whole-of-blast-radius
 * safety check: drive `runPropose` through a recording create-only writer seam
 * and assert:
 *
 *   - default (no --file): the writer receives ZERO creates — opens NOTHING;
 *   - --file: the writer receives one create per promoted candidate, and the
 *     ONLY method ever touched is `createProposalIssue` (create-only — a Proxy
 *     trap fails LOUDLY on any mutation-shaped member, mirroring F4's read-only
 *     guard inverted for writes).
 *
 * Also exercises the orchestrator end-to-end: reflections read from a temp dir,
 * invariants loaded from a temp design/ tree, report rendered in both modes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runPropose } from '../../../src/cli/propose/run.js';
import type {
  ProposalIssueInput,
  ProposalIssueResult,
  ProposalIssueWriter,
} from '../../../src/cli/propose/proposal-writer.js';

const CREATE_METHODS = new Set(['createProposalIssue']);

// Anything that smells like a mutation OTHER than the allowed create. If a
// future refactor adds merge/close/edit/comment and a caller invokes it, the
// Proxy trap throws — even for a brand-new name.
const FORBIDDEN_HINT = /merge|close|edit|update|delete|comment|label|patch|put|remove|approve|assign/i;

interface Recorder {
  readonly calls: string[];
  readonly created: ProposalIssueInput[];
}

function makeRecordingWriter(): { writer: ProposalIssueWriter; rec: Recorder } {
  const calls: string[] = [];
  const created: ProposalIssueInput[] = [];

  const base: ProposalIssueWriter = {
    async createProposalIssue(input: ProposalIssueInput): Promise<ProposalIssueResult> {
      calls.push('createProposalIssue');
      created.push(input);
      return { url: `https://github.com/example/repo/issues/${created.length}` };
    },
  };

  const writer = new Proxy(base, {
    get(target, prop, receiver) {
      if (
        typeof prop === 'string' &&
        FORBIDDEN_HINT.test(prop) &&
        !CREATE_METHODS.has(prop)
      ) {
        throw new Error(`CREATE-ONLY VIOLATION: propose touched mutating member "${prop}"`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return { writer, rec: { calls, created } };
}

const DESIGN_MD = `# Protected invariants

## The invariants

1. **Reporter-owns-closure accountability.** The agent who opened an issue owns its closure.
3. **No-self-merge / LGTM gate.** No PR merges without a non-author APPROVED review.
`;

function writeReflection(dir: string, file: string, lines: readonly object[]): void {
  writeFileSync(
    join(dir, file),
    lines.map((o) => JSON.stringify(o)).join('\n') + '\n',
  );
}

function reflection(agentName: string, signals: readonly object[]): object {
  return {
    schema_version: '1.0',
    kind: 'macf.reflection',
    agent: { name: agentName, role: agentName, login: `${agentName}[bot]` },
    project: 'macf',
    session_id: `s-${agentName}`,
    timestamp: '2026-06-16T04:00:00Z',
    trigger: 'pre-compact',
    compaction_type: 'auto',
    rule_evolution_signals: signals,
  };
}

describe('GATE 2 — dry-run by default; --file is create-only', () => {
  let root: string;
  let reflDir: string;

  beforeEach(() => {
    root = join(tmpdir(), `macf-propose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    reflDir = join(root, '.claude', '.macf', 'reflections');
    mkdirSync(reflDir, { recursive: true });
    mkdirSync(join(root, 'design'), { recursive: true });
    writeFileSync(join(root, 'design', 'protected-invariants.md'), DESIGN_MD);

    // One candidate corroborated by 2 distinct agents → 1 promoted.
    writeReflection(reflDir, 'code-agent.jsonl', [
      reflection('code-agent', [
        { signal: 'promote corroborated rule', proposed_tier: 'project', rationale: 'r1', key: 'corr' },
      ]),
    ]);
    writeReflection(reflDir, 'science-agent.jsonl', [
      reflection('science-agent', [
        { signal: 'promote corroborated rule', proposed_tier: 'project', rationale: 'r2', key: 'corr' },
      ]),
    ]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('DEFAULT (no --file): opens NOTHING — writer receives zero creates', async () => {
    const { writer, rec } = makeRecordingWriter();
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: false,
      writer, // even when a writer is provided, dry-run must not touch it
    });

    expect(rec.calls).toHaveLength(0);
    expect(rec.created).toHaveLength(0);
    expect(res.created).toHaveLength(0);

    // The report still surfaces the candidate + announces dry-run.
    expect(res.report).toContain('# Auditor proposal report');
    expect(res.report).toContain('dry-run (default — opens nothing)');
    expect(res.report).toContain('promote corroborated rule');
    expect(res.report).toContain('Re-run with `--file`');
  });

  it('DEFAULT works with NO writer supplied (dry-run needs none)', async () => {
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: false,
    });
    expect(res.created).toHaveLength(0);
    expect(res.report).toContain('# Auditor proposal report');
  });

  it('--file: writer receives exactly one create-only call per promoted candidate', async () => {
    const { writer, rec } = makeRecordingWriter();
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: true,
      writer,
    });

    // Exactly one create (one promoted candidate), and ONLY the create method.
    expect(rec.calls).toEqual(['createProposalIssue']);
    expect(rec.created).toHaveLength(1);
    expect(res.created).toHaveLength(1);

    const input = rec.created[0]!;
    expect(input.repo).toBe('groundnuty/macf');
    expect(input.title).toContain('auditor-proposal:');
    expect(input.labels).toContain('auditor-proposal');
    expect(input.body).toContain('Auditor proposal.');
    expect(input.body).toContain('code-agent, science-agent'); // corroboration list
    expect(res.report).toContain('--file (artifacts opened)');
  });

  it('--file with no writer throws (the command must wire one)', async () => {
    await expect(
      runPropose({
        project: 'macf',
        repo: 'groundnuty/macf',
        reflectionsDir: reflDir,
        repoRoot: root,
        minAgents: 2,
        fileMode: true,
      }),
    ).rejects.toThrow(/requires a proposal writer/);
  });

  it('--file opens NOTHING when there are no promoted candidates (all HELD)', async () => {
    // Re-seed with a single-agent signal → N=1 → HELD, none promoted.
    rmSync(join(reflDir, 'science-agent.jsonl'));
    const { writer, rec } = makeRecordingWriter();
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: true,
      writer,
    });
    expect(rec.created).toHaveLength(0);
    expect(res.created).toHaveLength(0);
    expect(res.report).toContain('HELD');
  });

  it('skips malformed reflection lines without throwing (defensive read)', async () => {
    writeFileSync(
      join(reflDir, 'broken.jsonl'),
      [
        'not json at all',
        JSON.stringify({ kind: 'wrong', schema_version: '9.9' }),
        '',
      ].join('\n') + '\n',
    );
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: false,
    });
    // Surfaced in the report, not fatal.
    expect(res.report).toContain('skipped malformed: 2');
    expect(res.report).toContain('promote corroborated rule');
  });

  it('surfaces a missing protected-invariants.md (loud-but-proceeds)', async () => {
    rmSync(join(root, 'design', 'protected-invariants.md'));
    const res = await runPropose({
      project: 'macf',
      repo: 'groundnuty/macf',
      reflectionsDir: reflDir,
      repoRoot: root,
      minAgents: 2,
      fileMode: false,
    });
    expect(res.report).toContain('protected-invariants.md` not found');
    // Still promotes the candidate (just with no invariant touches surfaced).
    expect(res.report).toContain('promote corroborated rule');
  });
});
