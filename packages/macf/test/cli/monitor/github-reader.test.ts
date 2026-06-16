/**
 * Tests for the production gh-backed GitHub reader (macf#502, DR-026 F4).
 *
 * Asserts the reader (a) parses `gh issue/pr list --json` output into the
 * Monitor shapes and (b) ONLY ever invokes read subcommands (`issue list` /
 * `pr list`) — never a mutating `gh` subcommand. The execFile call is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const { createGhReader } = await import('../../../src/cli/monitor/github-reader.js');

/** All gh argv vectors the reader passed, for read-only assertion. */
function recordedArgvs(): string[][] {
  return vi.mocked(mockExecFile).mock.calls.map((c) => c[1] as string[]);
}

function mockGhReturning(bySubcommand: Record<string, unknown>): void {
  vi.mocked(mockExecFile).mockImplementation(
    (_cmd: any, args: any, _opts: any, cb: any) => {
      const sub = `${args[0]} ${args[1]}`; // e.g. "issue list"
      const payload = bySubcommand[sub] ?? [];
      if (cb) cb(null, { stdout: JSON.stringify(payload), stderr: '' });
      return {} as any;
    },
  );
}

describe('createGhReader', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses gh issue list output into MonitorIssue shape', async () => {
    mockGhReturning({
      'issue list': [
        { number: 5, title: 'a', createdAt: '2026-06-01T00:00:00Z', labels: [{ name: 'code-agent' }] },
      ],
    });
    const reader = createGhReader('ghs_token');
    const issues = await reader.listOpenIssues('groundnuty/macf');
    expect(issues).toEqual([
      { number: 5, title: 'a', createdAt: '2026-06-01T00:00:00Z', labels: ['code-agent'] },
    ]);
  });

  it('parses gh pr list output into MonitorPR shape', async () => {
    mockGhReturning({
      'pr list': [
        { number: 7, title: 'p', createdAt: '2026-06-10T00:00:00Z', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', isDraft: false },
      ],
    });
    const reader = createGhReader('ghs_token');
    const prs = await reader.listOpenPRs('groundnuty/macf');
    expect(prs[0]!.reviewDecision).toBe('APPROVED');
    expect(prs[0]!.isDraft).toBe(false);
  });

  it('only ever invokes read subcommands (issue list / pr list)', async () => {
    mockGhReturning({ 'issue list': [], 'pr list': [] });
    const reader = createGhReader('ghs_token');
    await reader.listOpenIssues('groundnuty/macf');
    await reader.listOpenPRs('groundnuty/macf');

    const argvs = recordedArgvs();
    expect(argvs.length).toBe(2);
    for (const argv of argvs) {
      // First token is the resource, second is the verb — must be a list read.
      expect(['issue', 'pr']).toContain(argv[0]);
      expect(argv[1]).toBe('list');
      // No mutating verb anywhere in the argv.
      expect(argv.some((a) => /^(create|comment|close|merge|edit|delete|review)$/.test(a))).toBe(false);
    }
  });
});
