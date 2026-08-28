/**
 * Tests for `stale-issue-citations.ts` (groundnuty/macf#1299) — the sweep
 * that flags an open issue whose quoted code, tied to a named file path,
 * no longer matches that file's current content.
 *
 * Decisive pair (per `assert-the-wrong-path.md` — test 1 alone is
 * satisfied by a checker that flags everything):
 *   1. an issue quoting a named file's code that no longer contains it
 *      -> flagged as a `stale` candidate.
 *   2. an issue quoting code that still matches the named file
 *      -> NOT flagged.
 *
 * Plus the required distinctions from the issue body: the named file
 * absent entirely -> `unknown` (a different fact from a changed line);
 * a reformatted-only match -> not flagged (whitespace-insensitive);
 * a fence with no nameable path -> out of scope, silent; and the
 * reported list is capped with the cap disclosed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCitations,
  resolveCitationPath,
  bodyContainsNormalizedSequence,
  checkStaleIssueCitations,
  createDefaultTreeAccess,
  formatStaleCitationReport,
  DEFAULT_STALE_CITATION_LIMIT,
  type TreeAccess,
  type RawIssue,
} from '../../../src/plugin/lib/stale-issue-citations.js';

/** In-memory `TreeAccess` fake — keys are repo-relative POSIX paths. */
function fakeTree(files: Record<string, string>): TreeAccess {
  return {
    fileExists: (p) => Object.hasOwn(files, p),
    readFile: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    findByBasename: (basename) =>
      Object.keys(files).filter((p) => p === basename || p.endsWith(`/${basename}`)),
  };
}

function issue(overrides: Partial<RawIssue> & { readonly number: number }): RawIssue {
  return { title: `issue ${overrides.number}`, body: '', ...overrides };
}

describe('extractCitations', () => {
  it('pairs a fence with the nearest named path in the line directly above it', () => {
    const body = [
      '## Root cause',
      '',
      '`check-channel-alive.sh` log resolution (lines ~144-147):',
      '```sh',
      'CHANNEL_LOG="$(ls -t ...)"',
      '```',
      '',
      'more prose',
    ].join('\n');

    const citations = extractCitations(body);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.rawToken).toBe('check-channel-alive.sh');
    expect(citations[0]!.codeLines).toEqual(['CHANNEL_LOG="$(ls -t ...)"']);
  });

  it('resolves a full repo-relative path named above the fence', () => {
    const body = [
      'See `packages/macf/plugin/scripts/check-channel-alive.sh`:',
      '```sh',
      'echo hi',
      '```',
    ].join('\n');

    const citations = extractCitations(body);
    expect(citations[0]!.rawToken).toBe('packages/macf/plugin/scripts/check-channel-alive.sh');
  });

  it('drops a fence with no nameable path in its immediate context (out of scope)', () => {
    const body = ['Here is some output:', '```', 'random text, no file mentioned', '```'].join('\n');

    expect(extractCitations(body)).toHaveLength(0);
  });

  it('stops looking for a path at the first blank line above the fence', () => {
    const body = [
      '`foo.sh` is referenced way up here.',
      '',
      '```sh',
      'echo hi',
      '```',
    ].join('\n');

    // The blank line separates the path mention from the fence's own
    // paragraph — treated as unrelated context, not a citation.
    expect(extractCitations(body)).toHaveLength(0);
  });

  it('drops a fence whose content is entirely blank lines', () => {
    const body = ['`foo.sh`:', '```', '', '   ', '```'].join('\n');
    expect(extractCitations(body)).toHaveLength(0);
  });

  it('does not hang on an unterminated fence', () => {
    const body = ['`foo.sh`:', '```sh', 'echo hi', '(no closing fence)'].join('\n');
    expect(extractCitations(body)).toHaveLength(0);
  });
});

describe('bodyContainsNormalizedSequence (reformat-insensitivity)', () => {
  it('matches when the quoted lines are a contiguous subsequence', () => {
    const file = 'a\nfunction foo() {\n  return 1;\n}\nb\n';
    expect(bodyContainsNormalizedSequence(file, ['function foo() {', 'return 1;', '}'])).toBe(true);
  });

  it('survives indentation changes, trailing whitespace, and an inserted blank line', () => {
    const file = 'function foo() {   \n\treturn 1;\n\n}\n';
    expect(bodyContainsNormalizedSequence(file, ['function foo() {', '  return 1;', '}'])).toBe(true);
  });

  it('does not match when the actual content differs (not just whitespace)', () => {
    const file = 'function foo() {\n  return 2;\n}\n';
    expect(bodyContainsNormalizedSequence(file, ['function foo() {', 'return 1;', '}'])).toBe(false);
  });
});

describe('resolveCitationPath', () => {
  it('resolves an exact repo-relative path', () => {
    const tree = fakeTree({ 'a/b/foo.sh': 'x' });
    expect(resolveCitationPath('a/b/foo.sh', tree)).toEqual({ kind: 'resolved', path: 'a/b/foo.sh' });
  });

  it('resolves a bare filename via a unique basename match', () => {
    const tree = fakeTree({ 'a/b/foo.sh': 'x' });
    expect(resolveCitationPath('foo.sh', tree)).toEqual({ kind: 'resolved', path: 'a/b/foo.sh' });
  });

  it('reports unknown when the path cannot be found anywhere in the tree', () => {
    const tree = fakeTree({ 'a/b/other.sh': 'x' });
    expect(resolveCitationPath('foo.sh', tree)).toEqual({ kind: 'unknown' });
  });

  it('reports ambiguous (not a guess) when a bare filename matches more than one file', () => {
    const tree = fakeTree({ 'a/foo.sh': 'x', 'b/foo.sh': 'y' });
    expect(resolveCitationPath('foo.sh', tree)).toEqual({ kind: 'ambiguous' });
  });
});

describe('checkStaleIssueCitations', () => {
  // Decisive pair #1: the code moved out from under the citation.
  it('flags a candidate whose quoted code no longer matches the named file', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({ 'foo.sh': 'echo "new behavior"\n' }),
      listOpenIssues: async () => [
        issue({
          number: 1,
          title: 'stale citation',
          body: ['`foo.sh` does this:', '```sh', 'echo "old behavior"', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toMatchObject({ number: 1, path: 'foo.sh', verdict: 'stale' });
    expect(result.totalStale).toBe(1);
    expect(result.unknown).toHaveLength(0);
  });

  // Decisive pair #2: same shape, code still matches -> silent.
  it('does not flag a candidate whose quoted code still matches the named file', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({ 'foo.sh': 'echo "old behavior"\n' }),
      listOpenIssues: async () => [
        issue({
          number: 2,
          title: 'live citation',
          body: ['`foo.sh` does this:', '```sh', 'echo "old behavior"', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(0);
    expect(result.totalStale).toBe(0);
  });

  it('reports unknown, distinctly from stale, when the named file is gone entirely', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({}), // foo.sh doesn't exist anywhere
      listOpenIssues: async () => [
        issue({
          number: 3,
          title: 'moved-file citation',
          body: ['`foo.sh` does this:', '```sh', 'echo "old behavior"', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(0);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ number: 3, rawToken: 'foo.sh', verdict: 'unknown' });
  });

  it('does not flag a reformatted-only match (whitespace/indentation-insensitive)', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({ 'foo.sh': 'function foo() {   \n\treturn 1;\n\n}\n' }),
      listOpenIssues: async () => [
        issue({
          number: 4,
          title: 'reformatted only',
          body: ['`foo.sh`:', '```sh', 'function foo() {', '  return 1;', '}', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('leaves a fence with no named path out of scope — never flagged, never unknown', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({}),
      listOpenIssues: async () => [
        issue({
          number: 5,
          title: 'no path mentioned',
          body: ['Here is the output I saw:', '```', 'some unrelated text', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('skips an ambiguous bare-filename match silently rather than guessing', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({ 'a/foo.sh': 'echo old', 'b/foo.sh': 'echo old' }),
      listOpenIssues: async () => [
        issue({
          number: 6,
          title: 'ambiguous basename',
          body: ['`foo.sh` says:', '```sh', 'echo old', '```'].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('dedupes multiple fences in one issue that resolve to the same stale file', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({ 'foo.sh': 'echo "new"\n' }),
      listOpenIssues: async () => [
        issue({
          number: 7,
          title: 'two fences, one file',
          body: [
            '`foo.sh` line A:',
            '```sh',
            'echo "old A"',
            '```',
            '`foo.sh` line B:',
            '```sh',
            'echo "old B"',
            '```',
          ].join('\n'),
        }),
      ],
    });

    expect(result.stale).toHaveLength(1);
  });

  it('caps the reported stale list and discloses the pre-cap total', async () => {
    const files: Record<string, string> = {};
    const issues: RawIssue[] = [];
    const overLimit = DEFAULT_STALE_CITATION_LIMIT + 3;
    for (let n = 1; n <= overLimit; n += 1) {
      files[`f${n}.sh`] = 'echo "new"\n';
      issues.push(
        issue({
          number: n,
          title: `citation ${n}`,
          body: [`\`f${n}.sh\`:`, '```sh', 'echo "old"', '```'].join('\n'),
        }),
      );
    }

    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree(files),
      listOpenIssues: async () => issues,
    });

    expect(result.totalStale).toBe(overLimit);
    expect(result.stale).toHaveLength(DEFAULT_STALE_CITATION_LIMIT);

    const report = formatStaleCitationReport(result);
    expect(report).toContain(`showing ${DEFAULT_STALE_CITATION_LIMIT} of ${overLimit}`);
  });

  it('reports a clean sweep distinctly when nothing is stale or unknown', async () => {
    const result = await checkStaleIssueCitations({
      repo: 'org/repo',
      token: 'test-token',
      tree: fakeTree({}),
      listOpenIssues: async () => [],
    });

    expect(formatStaleCitationReport(result)).toContain('No stale-citation candidates found.');
  });
});

describe('createDefaultTreeAccess (real filesystem)', () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    cleanupDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves an exact path and a unique bare-filename match against a real tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'macf-stale-citations-'));
    cleanupDirs.push(root);
    mkdirSync(join(root, 'packages', 'macf', 'plugin', 'scripts'), { recursive: true });
    const target = join(root, 'packages', 'macf', 'plugin', 'scripts', 'check-channel-alive.sh');
    writeFileSync(target, 'echo "current behavior"\n');

    const tree = createDefaultTreeAccess(root);

    expect(
      resolveCitationPath('packages/macf/plugin/scripts/check-channel-alive.sh', tree),
    ).toEqual({
      kind: 'resolved',
      path: 'packages/macf/plugin/scripts/check-channel-alive.sh',
    });
    expect(resolveCitationPath('check-channel-alive.sh', tree)).toEqual({
      kind: 'resolved',
      path: 'packages/macf/plugin/scripts/check-channel-alive.sh',
    });
    expect(resolveCitationPath('does-not-exist.sh', tree)).toEqual({ kind: 'unknown' });
  });
});
