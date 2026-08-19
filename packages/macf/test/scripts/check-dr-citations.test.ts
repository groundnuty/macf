/**
 * Tests for `scripts/check-dr-citations.sh` (STATE check) and
 * `scripts/check-dr-citations-diff.sh` (DIFF check) — the DR-citation
 * enforcement pair from groundnuty/macf#998.
 *
 * The convention: a DR amendment whose Mechanism section names an artifact
 * the tool must produce carries a citation in the exact form:
 *
 *     **Asserted by:** `<path/to/file>.test.ts` → `"<exact test name>"`
 *
 * Two checks, two different failure classes:
 *   - The STATE check scans design/decisions/*.md and verifies every
 *     citation resolves (file exists, test name appears in it). It catches
 *     a citation gone STALE.
 *   - The DIFF check compares a base ref to a head ref and fails when a
 *     citation line disappears from a DR file while the amendment it
 *     belonged to survives. It catches a citation gone MISSING outright —
 *     the erosion mode a state check structurally cannot see ("a deleted
 *     citation looks exactly like an amendment that never needed one").
 *
 * Both scripts are executed as real subprocesses against fixture
 * directories/repos, per this repo's precedent for exercising extracted
 * shell logic (see repo-init.test.ts's "gate step bash" describe blocks
 * and macf-prompt-watcher.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const STATE_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-dr-citations.sh');
const DIFF_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-dr-citations-diff.sh');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(script: string, args: readonly string[], cwd?: string): RunResult {
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    cwd,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-dr-citations-state-'));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'design', 'decisions'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'macf', 'test', 'cli'), { recursive: true });
  return dir;
}

function writeDr(root: string, name: string, content: string): void {
  writeFileSync(join(root, 'design', 'decisions', name), content);
}

function writeTest(root: string, name: string, content: string): void {
  writeFileSync(join(root, 'packages', 'macf', 'test', 'cli', name), content);
}

const FAKE_TEST_FILE = 'packages/macf/test/cli/fake.test.ts';
const FAKE_TEST_NAME = 'the launcher server argument equals a key macf init writes to .mcp.json';
const FAKE_TEST_CONTENT = `import { describe, it, expect } from 'vitest';
describe('fake', () => {
  it('${FAKE_TEST_NAME}', () => {
    expect(true).toBe(true);
  });
});
`;

const VALID_CITATION =
  '**Asserted by:** `packages/macf/test/cli/fake.test.ts` → `"' + FAKE_TEST_NAME + '"`';

// ---------------------------------------------------------------------------
// STATE check (check-dr-citations.sh)
// ---------------------------------------------------------------------------

describe('check-dr-citations.sh (state check)', () => {
  it('a valid citation passes', () => {
    const root = makeFixtureRoot();
    writeTest(root, 'fake.test.ts', FAKE_TEST_CONTENT);
    writeDr(
      root,
      'DR-999-fixture.md',
      `# DR-999: fixture\n\n### Amendment P — fixture\n\nMechanism: X.\n\n${VALID_CITATION}\n`,
    );

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('passed');
  });

  it('a citation naming a missing test FILE fails, and names the file', () => {
    const root = makeFixtureRoot();
    // Deliberately do NOT create packages/macf/test/cli/ghost.test.ts.
    writeDr(
      root,
      'DR-998-missing-file.md',
      '# DR-998: fixture\n\n### Amendment Q — fixture\n\n' +
        '**Asserted by:** `packages/macf/test/cli/ghost.test.ts` → `"some test"`\n',
    );

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('packages/macf/test/cli/ghost.test.ts');
    expect(res.stderr).toMatch(/does not exist/);
  });

  it('a citation naming a real file but a test name absent from it fails, and names the test', () => {
    const root = makeFixtureRoot();
    writeTest(root, 'fake.test.ts', FAKE_TEST_CONTENT);
    writeDr(
      root,
      'DR-997-missing-test.md',
      '# DR-997: fixture\n\n### Amendment R — fixture\n\n' +
        '**Asserted by:** `packages/macf/test/cli/fake.test.ts` → `"a test name nobody wrote"`\n',
    );

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('a test name nobody wrote');
    expect(res.stderr).toMatch(/does not exist in/);
  });

  it('a malformed citation line fails clearly rather than silently passing', () => {
    const root = makeFixtureRoot();
    writeTest(root, 'fake.test.ts', FAKE_TEST_CONTENT);
    writeDr(
      root,
      'DR-996-malformed.md',
      '# DR-996: fixture\n\n### Amendment S — fixture\n\n' +
        // No arrow, no quoted test name -> doesn't match the ruled shape.
        '**Asserted by:** `packages/macf/test/cli/fake.test.ts` (see the test suite)\n',
    );

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/malformed/i);
  });

  it('a DR with zero citations passes', () => {
    const root = makeFixtureRoot();
    writeDr(
      root,
      'DR-995-no-citations.md',
      '# DR-995: fixture\n\n### Amendment T — fixture\n\nNo mechanism worth asserting here.\n',
    );

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('passed');
  });

  it('a repo with no design/decisions directory at all passes (nothing to check)', () => {
    const root = mkdtempSync(join(tmpdir(), 'macf-dr-citations-empty-'));
    cleanupDirs.push(root);

    const res = run(STATE_SCRIPT, [root]);

    expect(res.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DIFF check (check-dr-citations-diff.sh)
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${res.stdout}\n${res.stderr}`);
  }
}

/** Fresh git repo, configured with a throwaway identity so commits succeed. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-dr-citations-diff-'));
  cleanupDirs.push(dir);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'design', 'decisions'), { recursive: true });
  return dir;
}

function commitDr(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, 'design', 'decisions', name), content);
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message], repo);
}

const DR_NAME = 'DR-999-fixture.md';
const CITED_AMENDMENT = `# DR-999: fixture

### Amendment P — fixture

Mechanism: X.

${VALID_CITATION}

Trailing prose about Amendment P.
`;
const AMENDMENT_NO_CITATION = `# DR-999: fixture

### Amendment P — fixture

Mechanism: X.

Trailing prose about Amendment P.
`;
const AMENDMENT_REMOVED_ENTIRELY = `# DR-999: fixture

Amendment P was removed entirely in this revision.
`;
const CITATION_MOVED = `# DR-999: fixture

### Amendment P — fixture

Mechanism: X.

Trailing prose about Amendment P.

### Amendment Q — reorganized home for the citation

The citation moved here during a reorg.

${VALID_CITATION}
`;

describe('check-dr-citations-diff.sh (diff/erosion check)', () => {
  it('DECISIVE: removing only the citation while its amendment survives FAILS', () => {
    const repo = makeGitRepo();
    commitDr(repo, DR_NAME, CITED_AMENDMENT, 'base: citation present');
    git(['tag', 'base'], repo);
    commitDr(repo, DR_NAME, AMENDMENT_NO_CITATION, 'strip citation, keep amendment');

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/erosion/i);
    expect(res.stderr).toContain('Amendment P');
    expect(res.stderr).toContain(FAKE_TEST_FILE);
  });

  it('removing the whole amendment (heading + citation together) passes', () => {
    const repo = makeGitRepo();
    commitDr(repo, DR_NAME, CITED_AMENDMENT, 'base: citation present');
    git(['tag', 'base'], repo);
    commitDr(repo, DR_NAME, AMENDMENT_REMOVED_ENTIRELY, 'remove whole amendment');

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('passed');
  });

  it('a citation moved to a different amendment in the same file passes', () => {
    const repo = makeGitRepo();
    commitDr(repo, DR_NAME, CITED_AMENDMENT, 'base: citation under Amendment P');
    git(['tag', 'base'], repo);
    commitDr(repo, DR_NAME, CITATION_MOVED, 'move citation to Amendment Q');

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('passed');
  });

  it('a DR file with no citations in either revision passes', () => {
    const repo = makeGitRepo();
    commitDr(repo, DR_NAME, AMENDMENT_NO_CITATION, 'base: no citation ever');
    git(['tag', 'base'], repo);
    commitDr(
      repo,
      DR_NAME,
      AMENDMENT_NO_CITATION.replace('Trailing prose', 'Slightly different trailing prose'),
      'unrelated prose edit',
    );

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).toBe(0);
  });

  it('no design/decisions/*.md changed between the two refs passes trivially', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    git(['tag', 'base'], repo);
    writeFileSync(join(repo, 'README.md'), 'unrelated change\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'unrelated'], repo);

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nothing to check');
  });

  it('a NEW DR file (no base version) with a citation is not treated as a removal', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'base, no DR yet'], repo);
    git(['tag', 'base'], repo);
    commitDr(repo, DR_NAME, CITED_AMENDMENT, 'add brand-new DR with a citation');

    const res = run(DIFF_SCRIPT, ['base', 'HEAD'], repo);

    expect(res.status).toBe(0);
  });

  it('missing base-ref argument fails with a usage message', () => {
    const repo = makeGitRepo();
    commitDr(repo, DR_NAME, AMENDMENT_NO_CITATION, 'base');

    const res = run(DIFF_SCRIPT, [], repo);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage/i);
  });
});
