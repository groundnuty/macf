/**
 * Tests for the after-the-fact runner-usage audit (groundnuty/macf#1194).
 * The decisive pair this module exists for:
 *
 *   1. a non-exempt job that actually ran on a hosted runner -> reported as
 *      a VIOLATION, report is NOT clean.
 *   2. the SAME shape on the exempt `pick-runner` job -> NOT a violation
 *      (the named exemption, asserted by name — a differently-named job on
 *      the same hosted runner IS a violation, proving the exemption is
 *      name-scoped, not "any dispatcher-shaped job").
 *
 * Plus the honest-unknown floor: a job whose runner fields are both
 * unreadable classifies 'unknown', and the OVERALL report must not read
 * clean merely because it found zero violations.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyJobRunner,
  auditRunnerUsage,
  RUNNER_AUDIT_EXEMPT_JOB_NAME,
  DEFAULT_RUNNER_AUDIT_MAX_RUNS,
} from '../../../src/cli/bootstrap/runner-usage-audit.js';
import type { RunnerAuditDeps, RunnerAuditJob } from '../../../src/cli/bootstrap/runner-usage-audit.js';

function job(overrides: Partial<RunnerAuditJob> & { readonly name: string }): RunnerAuditJob {
  return { runnerName: null, runnerGroupName: null, ...overrides };
}

describe('classifyJobRunner (pure)', () => {
  it('runner_group_name "GitHub Actions" -> hosted', () => {
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerGroupName: 'GitHub Actions' }))).toBe('hosted');
  });

  it('any OTHER runner_group_name -> self-hosted', () => {
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerGroupName: 'Default' }))).toBe('self-hosted');
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerGroupName: 'macf-runners' }))).toBe('self-hosted');
  });

  it('group name absent, runner_name matches "GitHub Actions <N>" -> hosted (fallback)', () => {
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerName: 'GitHub Actions 10000000123' }))).toBe('hosted');
  });

  it('group name absent, runner_name does NOT match the hosted pattern -> self-hosted', () => {
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerName: 'macf-vm' }))).toBe('self-hosted');
  });

  it('DECISIVE: both fields absent -> unknown, never a claimed self-hosted', () => {
    expect(classifyJobRunner(job({ name: 'route-by-label', runnerName: null, runnerGroupName: null }))).toBe('unknown');
  });

  it('runner_group_name wins over a hosted-shaped runner_name when both are present', () => {
    expect(
      classifyJobRunner(job({ name: 'route-by-label', runnerGroupName: 'macf-runners', runnerName: 'GitHub Actions 1' })),
    ).toBe('self-hosted');
  });
});

function depsFor(runIdToJobs: ReadonlyMap<number, readonly RunnerAuditJob[] | undefined>): RunnerAuditDeps {
  return {
    listRecentRunIds: async () => [...runIdToJobs.keys()],
    listRunJobs: async (_repo, runId) => runIdToJobs.get(runId),
  };
}

describe('auditRunnerUsage — decisive pair', () => {
  it('1. a non-exempt job that ran on a hosted runner -> reported as a violation, report NOT clean', async () => {
    const deps = depsFor(
      new Map([[101, [job({ name: 'route-by-label', runnerGroupName: 'GitHub Actions', runnerName: 'GitHub Actions 42' })]]]),
    );
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.violations).toEqual([
      { repo: 'groundnuty/x', runId: 101, jobName: 'route-by-label', runnerName: 'GitHub Actions 42', runnerGroupName: 'GitHub Actions' },
    ]);
    expect(report.clean).toBe(false);
  });

  it('2. the SAME hosted-runner shape on the exempt "pick-runner" job -> NOT a violation (named exemption)', async () => {
    const deps = depsFor(
      new Map([[102, [job({ name: RUNNER_AUDIT_EXEMPT_JOB_NAME, runnerGroupName: 'GitHub Actions', runnerName: 'GitHub Actions 7' })]]]),
    );
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.violations).toEqual([]);
    expect(report.jobsChecked).toBe(0);
    expect(report.clean).toBe(true);
  });

  it('a differently-named dispatcher-shaped job on a hosted runner IS a violation — the exemption is name-scoped, not shape-scoped', async () => {
    const deps = depsFor(
      new Map([[103, [job({ name: 'pick-runner-2', runnerGroupName: 'GitHub Actions', runnerName: 'GitHub Actions 9' })]]]),
    );
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.jobName).toBe('pick-runner-2');
    expect(report.clean).toBe(false);
  });

  it('a self-hosted job alongside the exempt pick-runner job -> clean, exempt job never counted', async () => {
    const deps = depsFor(
      new Map([
        [
          104,
          [
            job({ name: RUNNER_AUDIT_EXEMPT_JOB_NAME, runnerGroupName: 'GitHub Actions' }),
            job({ name: 'route-by-mention', runnerGroupName: 'macf-runners' }),
          ],
        ],
      ]),
    );
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.violations).toEqual([]);
    expect(report.jobsChecked).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe('auditRunnerUsage — honest-unknown floor', () => {
  it('DECISIVE: a job with both runner fields unreadable classifies unknown, and the report does NOT read clean', async () => {
    const deps = depsFor(new Map([[105, [job({ name: 'route-by-ci-completion', runnerName: null, runnerGroupName: null })]]]));
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.violations).toEqual([]);
    expect(report.unknowns).toHaveLength(1);
    expect(report.unknowns[0]?.jobName).toBe('route-by-ci-completion');
    expect(report.clean).toBe(false);
  });

  it('a failed run-list read -> zero violations but clean is false, not a false "no hosted usage"', async () => {
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => undefined,
      listRunJobs: async () => [],
    };
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.runsChecked).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.unknowns).toHaveLength(1);
    expect(report.clean).toBe(false);
  });

  it('a failed job-list read on one run does not abort the others, and still marks clean:false', async () => {
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [201, 202],
      listRunJobs: async (_repo, runId) => (runId === 201 ? undefined : [job({ name: 'route-by-mention', runnerGroupName: 'macf-runners' })]),
    };
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.runsChecked).toBe(2);
    expect(report.unknowns).toHaveLength(1);
    expect(report.violations).toEqual([]);
    expect(report.clean).toBe(false);
  });

  it('genuinely zero runs (a confirmed-empty read, not a failed one) -> clean', async () => {
    const deps: RunnerAuditDeps = { listRecentRunIds: async () => [], listRunJobs: async () => [] };
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(report.runsChecked).toBe(0);
    expect(report.clean).toBe(true);
  });
});

describe('auditRunnerUsage — bounding', () => {
  it('respects opts.maxRuns, checking only the first N run ids (most-recent-first)', async () => {
    const seen: number[] = [];
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1, 2, 3, 4, 5],
      listRunJobs: async (_repo, runId) => {
        seen.push(runId);
        return [];
      },
    };
    const report = await auditRunnerUsage('groundnuty/x', deps, { maxRuns: 2 });
    expect(seen).toEqual([1, 2]);
    expect(report.runsChecked).toBe(2);
  });

  it('defaults to DEFAULT_RUNNER_AUDIT_MAX_RUNS when opts.maxRuns is omitted', async () => {
    const runIds = Array.from({ length: DEFAULT_RUNNER_AUDIT_MAX_RUNS + 10 }, (_, i) => i + 1);
    const seen: number[] = [];
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => runIds,
      listRunJobs: async (_repo, runId) => {
        seen.push(runId);
        return [];
      },
    };
    const report = await auditRunnerUsage('groundnuty/x', deps);
    expect(seen).toHaveLength(DEFAULT_RUNNER_AUDIT_MAX_RUNS);
    expect(report.runsChecked).toBe(DEFAULT_RUNNER_AUDIT_MAX_RUNS);
  });
});

describe('user-facing unknown reasons carry NO internal issue numbers or DR names (citation guard)', () => {
  it('the run-list-failure reason', async () => {
    const deps: RunnerAuditDeps = { listRecentRunIds: async () => undefined, listRunJobs: async () => [] };
    const report = await auditRunnerUsage('groundnuty/x', deps);
    const reason = report.unknowns[0]?.reason ?? '';
    expect(reason).not.toMatch(/#\d+/);
    expect(reason).not.toMatch(/DR-\d+/);
    expect(reason).not.toMatch(/Amendment/i);
  });

  it('the per-job unknown-classification reason', async () => {
    const deps = depsFor(new Map([[301, [job({ name: 'route-by-mention' })]]]));
    const report = await auditRunnerUsage('groundnuty/x', deps);
    const reason = report.unknowns[0]?.reason ?? '';
    expect(reason).not.toMatch(/#\d+/);
    expect(reason).not.toMatch(/DR-\d+/);
    expect(reason).not.toMatch(/Amendment/i);
  });
});
