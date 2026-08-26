/**
 * `macf routing runner-audit` — the operator-facing surface for
 * `bootstrap/runner-usage-audit.ts` (groundnuty/macf#1194). Reads recent
 * `agent-router.yml` run history for each named repo and reports any
 * non-exempt job that actually landed on a metered GitHub-hosted runner —
 * the after-the-fact half of the invariant: declaration-time enforcement
 * (`fleet-manifest.ts`'s parse-time check, `apply-routing.ts`'s
 * register-before-route gate) can be edited away after `apply` has already
 * run once; only run history proves what actually happened.
 *
 * Exit code is non-zero whenever ANY repo's report is not `clean` —
 * including an honest-`unknown` (unreadable run/job history), never only
 * on a confirmed violation. A caller scripting this into CI must not read
 * "exit 0" as "confirmed no hosted spend."
 */
import { auditRunnerUsage, REAL_RUNNER_AUDIT_DEPS } from '../bootstrap/runner-usage-audit.js';
import type { RunnerAuditDeps, RunnerAuditReport } from '../bootstrap/runner-usage-audit.js';

export interface RunnerAuditCliOptions {
  readonly repos: readonly string[];
  readonly json?: boolean;
  readonly maxRuns?: number;
}

function formatReport(report: RunnerAuditReport): string {
  const lines: string[] = [];
  if (report.clean) {
    lines.push(`${report.repo}: CLEAN — ${String(report.jobsChecked)} job(s) across ${String(report.runsChecked)} run(s), all self-hosted.`);
    return lines.join('\n');
  }
  lines.push(`${report.repo}: NOT CLEAN — ${String(report.violations.length)} hosted-runner violation(s), ${String(report.unknowns.length)} unreadable.`);
  for (const v of report.violations) {
    lines.push(`  VIOLATION run ${String(v.runId)} job "${v.jobName}": runner_group="${v.runnerGroupName ?? '(none)'}" runner_name="${v.runnerName ?? '(none)'}"`);
  }
  for (const u of report.unknowns) {
    lines.push(`  UNKNOWN run ${String(u.runId)} job "${u.jobName}": ${u.reason}`);
  }
  return lines.join('\n');
}

/**
 * Runs the audit for every `opts.repos` entry and prints a report (human
 * or `--json`). Returns the process exit code: `0` only when every repo's
 * report is `clean`.
 */
export async function runRunnerAudit(opts: RunnerAuditCliOptions, deps: RunnerAuditDeps = REAL_RUNNER_AUDIT_DEPS): Promise<number> {
  if (opts.repos.length === 0) {
    console.error('macf routing runner-audit: at least one --repo <owner/repo> is required.');
    return 1;
  }

  const reports: RunnerAuditReport[] = [];
  for (const repo of opts.repos) {
    reports.push(await auditRunnerUsage(repo, deps, { maxRuns: opts.maxRuns }));
  }

  if (opts.json) {
    console.log(JSON.stringify({ reports }, null, 2));
  } else {
    for (const report of reports) console.log(formatReport(report));
  }

  return reports.every((r) => r.clean) ? 0 : 1;
}
