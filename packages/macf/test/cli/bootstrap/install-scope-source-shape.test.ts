/**
 * Static source-shape regression guard (groundnuty/macf#1128), mirroring
 * `dir-explicit-source-shape.test.ts`'s own precedent (macf#1123) for the
 * SAME class of hazard: two independent copies of the SAME
 * `repository_selection === 'selected'` predicate is exactly how this issue
 * happened in the first place — `apply-router-app.ts` grew its own
 * byte-different copy of `apply-runner-ops.ts::validateRunnerOpsInstall`,
 * and ordinary agent Apps got NO check at all, because nothing pinned "this
 * lives in ONE place."
 *
 * `install-scope.ts::validateInstallRepositoryScope` is now the ONLY place
 * the comparison is allowed to live. This test asserts the raw expression
 * never reappears anywhere else under `src/cli/`, and that every
 * App-install call site threads its `validateInstall` through the shared
 * `buildInstallScopeValidator` builder rather than a hand-rolled closure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Matches a re-derived `repository_selection === 'selected'` (or `!==`)
 * check — camelCase (`ConfirmedInstall.repositorySelection`, the TS field
 * name) or snake_case (`repository_selection`, the raw GitHub API field
 * name a careless re-implementation might compare against directly instead
 * of going through the parsed `ConfirmedInstall`).
 */
const REPO_SELECTION_COMPARISON_PATTERN = /\brepository_?[Ss]election\s*[!=]==\s*['"]selected['"]/;

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** One line in production source that re-derives the repository_selection comparison outside install-scope.ts. */
export interface RepoSelectionComparisonViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Scans TypeScript source for a re-derived repository_selection comparison
 * outside comments. Pure — the same shape `no-internal-citations-in-user-facing-output.test.ts::scanSourceForCitations`
 * uses for its own decisive-test-first discipline.
 */
export function scanSourceForRepoSelectionComparison(source: string, fileLabel: string): RepoSelectionComparisonViolation[] {
  const violations: RepoSelectionComparisonViolation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!REPO_SELECTION_COMPARISON_PATTERN.test(line)) continue;
    if (isCommentLine(trimmed)) continue;
    violations.push({ file: fileLabel, line: i + 1, text: trimmed });
  }
  return violations;
}

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const cliSrcDir = fileURLToPath(new URL('../../../src/cli', import.meta.url));

describe('repository_selection comparison lives in exactly ONE file — install-scope.ts (groundnuty/macf#1128 structural guard)', () => {
  // --- Decisive: prove the scanner actually fires -------------------------
  // Per assert-the-wrong-path.md: a check that only ever reports "clean" is
  // indistinguishable from a broken check.
  it('FIRES on a deliberately re-derived comparison (camelCase field name)', () => {
    const bad = ["  if (install.repositorySelection === 'selected') return undefined;"].join('\n');
    const violations = scanSourceForRepoSelectionComparison(bad, 'synthetic-bad.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toContain('repositorySelection');
  });

  it('also FIRES on the raw GitHub API field name (snake_case) and the negated form', () => {
    const bad = [
      "const ok = body.repository_selection === 'selected';",
      "if (install.repositorySelection !== 'selected') return reject();",
    ].join('\n');
    const violations = scanSourceForRepoSelectionComparison(bad, 'synthetic-bad-2.ts');
    expect(violations).toHaveLength(2);
  });

  it('does NOT fire on a comment describing the check (maintainer prose is fine)', () => {
    const ok = ["  // repository_selection === 'selected' is the ONLY passing shape", "  // install.repositorySelection === 'selected' — see install-scope.ts"].join(
      '\n',
    );
    expect(scanSourceForRepoSelectionComparison(ok, 'synthetic-ok.ts')).toHaveLength(0);
  });

  // --- The real tree --------------------------------------------------------

  it('install-scope.ts itself has the ONE real comparison (sanity: the scanner sees the real tree, not just synthetic strings)', () => {
    const installScopePath = join(cliSrcDir, 'bootstrap', 'install-scope.ts');
    const source = readFileSync(installScopePath, 'utf-8');
    const violations = scanSourceForRepoSelectionComparison(source, 'install-scope.ts');
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it('no OTHER file under src/cli/ re-derives the comparison', () => {
    const files = listTsFilesRecursive(cliSrcDir);
    expect(files.length).toBeGreaterThan(10); // sanity: the walker found the tree

    const violators = files
      .filter((f) => relative(cliSrcDir, f) !== join('bootstrap', 'install-scope.ts'))
      .flatMap((f) => scanSourceForRepoSelectionComparison(readFileSync(f, 'utf-8'), relative(cliSrcDir, f)));

    expect(violators).toEqual([]);
  });
});

// --- Every App-install call site threads validateInstall through the shared builder ---

describe('apply-fleet.ts wires every App-install validateInstall through buildInstallScopeValidator (groundnuty/macf#1128)', () => {
  const applyFleetPath = join(cliSrcDir, 'bootstrap', 'apply-fleet.ts');
  const source = readFileSync(applyFleetPath, 'utf-8');

  it('imports buildInstallScopeValidator from the shared install-scope module', () => {
    expect(source).toMatch(/import\s*\{\s*buildInstallScopeValidator\s*\}\s*from\s*'\.\/install-scope\.js'/);
  });

  it('calls buildInstallScopeValidator at least 3 times — the per-agent loop, runner-ops, and the router App', () => {
    const calls = source.match(/buildInstallScopeValidator\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('never assigns validateInstall directly from a bare validateRunnerOpsInstall/validateRouterAppInstall reference — both were removed by this issue', () => {
    expect(source).not.toMatch(/validateInstall:\s*validateRunnerOpsInstall\b/);
    expect(source).not.toMatch(/validateInstall:\s*validateRouterAppInstall\b/);
  });
});
