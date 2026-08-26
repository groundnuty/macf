/**
 * After-the-fact runner-usage audit (groundnuty/macf#1194) — reads ACTUAL
 * runner names/groups from a repo's recent `agent-router.yml` run history
 * and reports whether any work-doing job landed on a metered GitHub-hosted
 * runner. Declaration-time enforcement (macf#993's `publishTrustedActorsGated`
 * refusal, this module's sibling `isSelfHostedCapableActionsVersion` gate)
 * can be edited away after the fact — a `runs_on: self-hosted` manifest
 * doesn't prove anything about what actually ran; only run history does.
 * Money is spent at RUN time, not at provisioning time, so this is the
 * check that can actually catch a drift nothing else would see.
 *
 * **The named exemption.** `pick-runner` (`agent-router.yml`'s own tiny
 * dispatcher job) is hosted BY DESIGN — the operator's own framing is "no
 * hosted runner does the WORK," not "no hosted runner runs at all." This
 * module names that ONE job explicitly ({@link RUNNER_AUDIT_EXEMPT_JOB_NAME})
 * so a future job added to the router can never inherit the exemption by
 * accident (matching name only, not "the first job" or "anything named
 * like a picker").
 *
 * **Classify from what a job ACTUALLY RAN ON, never from what it ASKED
 * for.** A job's requested `labels` (what `runs-on:` evaluated to) is NOT
 * evidence of where it ran — GitHub's own `runner_group_name`/`runner_name`
 * fields on the completed job are. Using the requested-labels shape would
 * reproduce the exact mistake #1194's own reporter names: "a confident
 * negative from the wrong instrument."
 *
 * **Honest-unknown floor.** A job whose runner fields are unreadable (both
 * `runner_group_name` and `runner_name` absent) classifies `'unknown'`,
 * never `'self-hosted'` — and a report carrying ANY unknown is `clean:
 * false`, exactly the same bar a hosted-runner violation gets. "Could not
 * confirm" must never render as "confirmed clean."
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// --- Classification (pure) ---

/** The literal job name `agent-router.yml` uses for its runner-selection dispatcher — the SAME literal `fleet-manifest.ts`'s router-contract constants (`ROUTER_EMITTED_LABELS`) are pinned against. Naming it here, by string equality only, is what makes the exemption impossible to inherit by accident: a differently-named job added later is audited like any other. */
export const RUNNER_AUDIT_EXEMPT_JOB_NAME = 'pick-runner';

/** Every GitHub-hosted runner belongs to a runner group literally named this — GitHub's own hosted/self-hosted discriminator on a completed job. Any OTHER group name (the operator's own, "Default" or custom) is self-hosted. */
const HOSTED_RUNNER_GROUP_NAME = 'GitHub Actions';

/** Fallback pattern for a GitHub-hosted runner's `runner_name` when `runner_group_name` itself is absent from the API response — GitHub-hosted runner names are always of this documented shape ("GitHub Actions 123..."), confirmed against a live sample cited on #1194. */
const HOSTED_RUNNER_NAME_RE = /^GitHub Actions \d+$/;

/** One job's runner-identity fields as read from a completed workflow run — the ACTUAL assignment, never the requested `labels`. `null` for a field GitHub's response didn't carry (job still queued/in-progress, or a genuinely absent value). */
export interface RunnerAuditJob {
  readonly name: string;
  readonly runnerName: string | null;
  readonly runnerGroupName: string | null;
}

export type RunnerClassification = 'hosted' | 'self-hosted' | 'unknown';

/**
 * Classifies what `job` actually ran on. `runner_group_name` is the
 * primary, authoritative signal (present on every completed job GitHub has
 * assigned a runner to); `runner_name`'s pattern match is a fallback ONLY
 * when the group name itself is missing. Neither present -> `'unknown'` —
 * never a claimed `'self-hosted'` merely because the value wasn't the
 * hosted pattern; absence of evidence is not evidence of self-hosting.
 */
export function classifyJobRunner(job: RunnerAuditJob): RunnerClassification {
  if (job.runnerGroupName !== null) {
    return job.runnerGroupName === HOSTED_RUNNER_GROUP_NAME ? 'hosted' : 'self-hosted';
  }
  if (job.runnerName !== null) {
    return HOSTED_RUNNER_NAME_RE.test(job.runnerName) ? 'hosted' : 'self-hosted';
  }
  return 'unknown';
}

// --- Audit orchestration ---

export interface RunnerAuditViolation {
  readonly repo: string;
  readonly runId: number;
  readonly jobName: string;
  readonly runnerName: string | null;
  readonly runnerGroupName: string | null;
}

export interface RunnerAuditUnknown {
  readonly repo: string;
  readonly runId: number;
  readonly jobName: string;
  readonly reason: string;
}

export interface RunnerAuditReport {
  readonly repo: string;
  readonly runsChecked: number;
  readonly jobsChecked: number;
  readonly violations: readonly RunnerAuditViolation[];
  /** Every job (or run, or the run-list itself) this audit could not confirm the runner identity for. */
  readonly unknowns: readonly RunnerAuditUnknown[];
  /**
   * `true` only when every non-exempt job across every checked run was
   * confirmed self-hosted AND nothing failed to read. NEVER derive this
   * from "violations is empty" alone — a read failure produces zero
   * violations too, and reporting that as clean is exactly the "confident
   * negative from the wrong instrument" mistake this module exists to
   * avoid.
   */
  readonly clean: boolean;
}

/** Injectable reads — production wiring in {@link REAL_RUNNER_AUDIT_DEPS}; every method returns `undefined` on a failed read (honest-unknown), NEVER throws (mirrors `observer.ts`'s `check*` read contracts). */
export interface RunnerAuditDeps {
  /** Most-recent-first run ids for the router workflow on `repo`. `undefined` = the read itself failed (auth / network / rate-limit) — distinct from a confirmed-empty `[]` (genuinely no runs yet). */
  readonly listRecentRunIds: (repo: string) => Promise<readonly number[] | undefined>;
  /** Every job GitHub recorded for `runId`. `undefined` = the read failed. */
  readonly listRunJobs: (repo: string, runId: number) => Promise<readonly RunnerAuditJob[] | undefined>;
}

export const DEFAULT_RUNNER_AUDIT_MAX_RUNS = 20;

/**
 * Audits `repo`'s recent `agent-router.yml` run history for any non-exempt
 * job that actually ran on a hosted runner. Never throws — a failed
 * `listRecentRunIds`/`listRunJobs` read is folded into `unknowns`, and
 * `clean` reflects that honestly rather than silently reporting on a
 * partial read as if it were complete.
 */
export async function auditRunnerUsage(
  repo: string,
  deps: RunnerAuditDeps,
  opts?: { readonly maxRuns?: number },
): Promise<RunnerAuditReport> {
  const maxRuns = opts?.maxRuns ?? DEFAULT_RUNNER_AUDIT_MAX_RUNS;
  const runIds = await deps.listRecentRunIds(repo);
  if (runIds === undefined) {
    return {
      repo,
      runsChecked: 0,
      jobsChecked: 0,
      violations: [],
      unknowns: [
        {
          repo,
          runId: 0,
          jobName: '(run list)',
          reason: 'could not list recent agent-router.yml runs for this repo (auth / network / rate-limit) — nothing was checked',
        },
      ],
      clean: false,
    };
  }

  const bounded = runIds.slice(0, maxRuns);
  const violations: RunnerAuditViolation[] = [];
  const unknowns: RunnerAuditUnknown[] = [];
  let jobsChecked = 0;

  for (const runId of bounded) {
    const jobs = await deps.listRunJobs(repo, runId);
    if (jobs === undefined) {
      unknowns.push({ repo, runId, jobName: '(job list)', reason: 'could not list jobs for this run (auth / network / rate-limit)' });
      continue;
    }
    for (const job of jobs) {
      if (job.name === RUNNER_AUDIT_EXEMPT_JOB_NAME) continue;
      jobsChecked += 1;
      const classification = classifyJobRunner(job);
      if (classification === 'hosted') {
        violations.push({ repo, runId, jobName: job.name, runnerName: job.runnerName, runnerGroupName: job.runnerGroupName });
      } else if (classification === 'unknown') {
        unknowns.push({
          repo,
          runId,
          jobName: job.name,
          reason: 'runner name and runner group were both unreadable for this job — cannot confirm hosted vs self-hosted',
        });
      }
    }
  }

  return {
    repo,
    runsChecked: bounded.length,
    jobsChecked,
    violations,
    unknowns,
    clean: violations.length === 0 && unknowns.length === 0,
  };
}

// --- Real deps (thin `gh api` I/O leaves — untested directly, same posture as `observer.ts`'s other real reads) ---

async function realListRecentRunIds(repo: string): Promise<readonly number[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/actions/workflows/agent-router.yml/runs`, '--jq', '[.workflow_runs[].id]'],
      { encoding: 'utf-8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || !parsed.every((x): x is number => typeof x === 'number')) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function realListRunJobs(repo: string, runId: number): Promise<readonly RunnerAuditJob[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/actions/runs/${String(runId)}/jobs`, '--jq', '[.jobs[] | {name, runner_name, runner_group_name}]'],
      { encoding: 'utf-8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return undefined;
    const jobs: RunnerAuditJob[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const { name, runner_name: runnerName, runner_group_name: runnerGroupName } = item as {
        name?: unknown;
        runner_name?: unknown;
        runner_group_name?: unknown;
      };
      if (typeof name !== 'string') continue;
      jobs.push({
        name,
        runnerName: typeof runnerName === 'string' ? runnerName : null,
        runnerGroupName: typeof runnerGroupName === 'string' ? runnerGroupName : null,
      });
    }
    return jobs;
  } catch {
    return undefined;
  }
}

/** Real production wiring — `gh api` reads only, no credentials ever logged. */
export const REAL_RUNNER_AUDIT_DEPS: RunnerAuditDeps = {
  listRecentRunIds: realListRecentRunIds,
  listRunJobs: realListRunJobs,
};
