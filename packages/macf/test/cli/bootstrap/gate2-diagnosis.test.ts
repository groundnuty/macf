/**
 * Tests for `gate2-diagnosis.ts`'s classifier (groundnuty/macf#1179 Step 6).
 * Pure, no I/O — every test drives `diagnoseGate2Rejection` directly against
 * a `{repositorySelection}` shape + an `InstallRejection`, both already-typed
 * facts the real gate-2 poll has in hand.
 */
import { describe, it, expect } from 'vitest';
import { diagnoseGate2Rejection, gate2DiagnosisMessageLines, gate2DiagnosisRepoNames } from '../../../src/cli/bootstrap/gate2-diagnosis.js';

describe('diagnoseGate2Rejection', () => {
  it('scope-wrong: repositorySelection !== "selected" classifies as scope-wrong regardless of the rejection shape', () => {
    const d = diagnoseGate2Rejection({ repositorySelection: 'all' }, 'repository_selection must be "selected" — observed "all".');
    expect(d.kind).toBe('scope-wrong');
    if (d.kind === 'scope-wrong') {
      expect(d.message).toContain('repository_selection must be "selected"');
    }
  });

  it('coverage-short: repositorySelection is "selected" AND the rejection carries missingRepos', () => {
    const d = diagnoseGate2Rejection(
      { repositorySelection: 'selected' },
      { message: 'registry repo not installed', retryInstruction: 'add groundnuty/demo-fresh-control under Repository access, then Save.', missingRepos: ['groundnuty/demo-fresh-control'] },
    );
    expect(d.kind).toBe('coverage-short');
    if (d.kind === 'coverage-short') {
      expect(d.message).toBe('add groundnuty/demo-fresh-control under Repository access, then Save.');
      expect(d.missingRepos).toEqual(['groundnuty/demo-fresh-control']);
    }
  });

  it('honest-unknown: repositorySelection is "selected" AND the rejection carries NO missingRepos — a real, reachable third shape, not a contrived one', () => {
    // This is exactly what a bare-string rejection from a hook that is
    // neither the scope check nor the coverage check looks like — scope is
    // fine, and there's no structured missing-repo delta to point at.
    const d = diagnoseGate2Rejection({ repositorySelection: 'selected' }, 'some other validator rejected this install for an unrelated reason.');
    expect(d.kind).toBe('unknown');
  });

  it('DECISIVE: the three kinds produce mutually distinct message text — an unclassifiable case never masquerades as either specific one', () => {
    const scopeWrong = diagnoseGate2Rejection({ repositorySelection: 'all' }, 'X');
    const coverageShort = diagnoseGate2Rejection({ repositorySelection: 'selected' }, { message: 'X', missingRepos: ['o/r'] });
    const unknown = diagnoseGate2Rejection({ repositorySelection: 'selected' }, 'X');

    const scopeLines = gate2DiagnosisMessageLines(scopeWrong).join('\n');
    const coverageLines = gate2DiagnosisMessageLines(coverageShort).join('\n');
    const unknownLines = gate2DiagnosisMessageLines(unknown).join('\n');

    expect(scopeLines).not.toBe(coverageLines);
    expect(scopeLines).not.toBe(unknownLines);
    expect(coverageLines).not.toBe(unknownLines);

    // The unknown case must say it doesn't know — never claim scope or
    // coverage specifically.
    expect(unknownLines).toMatch(/can't (tell|classify)/);
    expect(unknownLines).not.toMatch(/repository scope/);
    expect(unknownLines).not.toMatch(/missing repository access/);
  });

  it('NEGATIVE — an "all"-scope install is NEVER classified coverage-short even when the rejection ALSO happens to carry missingRepos (scope check wins — it is checked first in the real composeValidateInstall chain, and this classifier does not trust caller ordering to enforce that)', () => {
    const d = diagnoseGate2Rejection(
      { repositorySelection: 'all' },
      { message: 'coverage check text', missingRepos: ['groundnuty/demo-fresh-control'] },
    );
    expect(d.kind).toBe('scope-wrong');
    expect(d.kind).not.toBe('coverage-short');
  });

  it('NEGATIVE — a "selected" install with an EMPTY missingRepos array is honest-unknown, not coverage-short (an empty delta names nothing to fix)', () => {
    const d = diagnoseGate2Rejection({ repositorySelection: 'selected' }, { message: 'X', missingRepos: [] });
    expect(d.kind).toBe('unknown');
  });
});

describe('gate2DiagnosisRepoNames', () => {
  it('only coverage-short names any repos — the other two kinds have nothing narrower to offer', () => {
    expect(gate2DiagnosisRepoNames(diagnoseGate2Rejection({ repositorySelection: 'all' }, 'X'))).toEqual([]);
    expect(gate2DiagnosisRepoNames(diagnoseGate2Rejection({ repositorySelection: 'selected' }, 'X'))).toEqual([]);
    expect(
      gate2DiagnosisRepoNames(diagnoseGate2Rejection({ repositorySelection: 'selected' }, { message: 'X', missingRepos: ['groundnuty/demo-fresh-control'] })),
    ).toEqual(['groundnuty/demo-fresh-control']);
  });
});
