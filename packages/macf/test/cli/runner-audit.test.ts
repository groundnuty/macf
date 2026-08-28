/**
 * Tests for `macf routing runner-audit` (groundnuty/macf#1194) — the CLI
 * wrapper over `bootstrap/runner-usage-audit.ts::auditRunnerUsage`.
 */
import { describe, it, expect, vi } from 'vitest';
import { runRunnerAudit } from '../../src/cli/commands/runner-audit.js';
import type { RunnerAuditDeps, RunnerAuditJob } from '../../src/cli/bootstrap/runner-usage-audit.js';

function job(name: string, overrides: Partial<RunnerAuditJob> = {}): RunnerAuditJob {
  return { name, runnerName: null, runnerGroupName: null, ...overrides };
}

describe('runRunnerAudit', () => {
  it('requires at least one repo', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runRunnerAudit({ repos: [] });
    expect(code).toBe(1);
    errorSpy.mockRestore();
  });

  it('exit 0 when every named repo audits clean', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('route-by-mention', { runnerGroupName: 'macf-runners' })],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(code).toBe(0);
    logSpy.mockRestore();
  });

  it('exit non-zero when ANY named repo has a hosted-runner violation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('route-by-mention', { runnerGroupName: 'GitHub Actions' })],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x', 'groundnuty/y'] }, deps);
    expect(code).toBe(1);
    logSpy.mockRestore();
  });

  it('exit non-zero on an honest-unknown, even with zero violations (never a false "clean" exit)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('route-by-mention')],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(code).toBe(1);
    logSpy.mockRestore();
  });

  it('--json emits one machine-readable report per repo', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed = s;
    });
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [],
      listRunJobs: async () => [],
    };
    await runRunnerAudit({ repos: ['groundnuty/x'], json: true }, deps);
    const parsed = JSON.parse(printed) as { reports: readonly { repo: string; clean: boolean }[] };
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]?.repo).toBe('groundnuty/x');
    expect(parsed.reports[0]?.clean).toBe(true);
    logSpy.mockRestore();
  });

  it('audits every named repo, not just the first', async () => {
    const seen: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async (repo) => {
        seen.push(repo);
        return [];
      },
      listRunJobs: async () => [],
    };
    await runRunnerAudit({ repos: ['groundnuty/a', 'groundnuty/b', 'groundnuty/c'] }, deps);
    expect(seen).toEqual(['groundnuty/a', 'groundnuty/b', 'groundnuty/c']);
    logSpy.mockRestore();
  });

  it('threads opts.maxRuns through to the audit — only the first N run ids are checked', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const seenRunIds: number[] = [];
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1, 2, 3],
      listRunJobs: async (_repo, runId) => {
        seenRunIds.push(runId);
        return [];
      },
    };
    await runRunnerAudit({ repos: ['groundnuty/x'], maxRuns: 1 }, deps);
    expect(seenRunIds).toEqual([1]);
    logSpy.mockRestore();
  });

  it('DECISIVE: genuinely zero runs renders as "NOTHING TO AUDIT / UNTESTED", never "CLEAN ... all self-hosted"', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [],
      listRunJobs: async () => [],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(code).toBe(0); // clean stays true — this test is about the RENDERED TEXT, not the exit code
    expect(printed).not.toMatch(/all self-hosted/);
    expect(printed).toMatch(/NOTHING TO AUDIT/);
    expect(printed).toMatch(/UNTESTED/);
    logSpy.mockRestore();
  });

  it('runs exist but every job seen was the exempt pick-runner dispatcher -> same "NOTHING TO AUDIT" render, not "CLEAN ... all self-hosted"', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('pick-runner', { runnerGroupName: 'GitHub Actions' })],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(code).toBe(0);
    expect(printed).not.toMatch(/all self-hosted/);
    expect(printed).toMatch(/NOTHING TO AUDIT/);
    logSpy.mockRestore();
  });

  it('a real confirmation (non-exempt job actually checked and found self-hosted) still renders CLEAN ... all self-hosted', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('route-by-mention', { runnerGroupName: 'macf-runners' })],
    };
    const code = await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(code).toBe(0);
    expect(printed).toMatch(/CLEAN — 1 job\(s\) across 1 run\(s\), all self-hosted\./);
    logSpy.mockRestore();
  });

  it('citation guard: the human-readable report carries no internal issue numbers or DR names', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerAuditDeps = {
      listRecentRunIds: async () => [1],
      listRunJobs: async () => [job('route-by-mention', { runnerGroupName: 'GitHub Actions' }), job('route-by-label')],
    };
    await runRunnerAudit({ repos: ['groundnuty/x'] }, deps);
    expect(printed).not.toMatch(/#\d+/);
    expect(printed).not.toMatch(/DR-\d+/);
    expect(printed).not.toMatch(/Amendment/i);
    logSpy.mockRestore();
  });
});
