/**
 * `macf routing runner-declaration-check` — the operator-facing surface
 * for `bootstrap/runner-declaration-reach.ts` (groundnuty/macf#1194's
 * provision-time detection half). For each named repo, reads the
 * INSTALLED `.github/workflows/agent-router.yml` and reports whether the
 * fleet's `--runs-on self-hosted` declaration can actually reach
 * `pick-runner`'s decision — never at the exit-code level alone; the
 * printed line names the repo, the installed pin, what `with:` keys it
 * actually passes, and what governs the router's choice instead
 * (`MACF_TRUSTED_ACTORS` membership, independent of this manifest).
 *
 * **Non-blocking, deliberately.** This command is not called by
 * `bootstrap plan`/`apply` — per the issue's own AC ("do NOT block
 * provisioning on it unless the issue says to"), detection here is
 * advisory: an operator (or a wrapping script) runs it during
 * provisioning to get a loud, named answer, but nothing in the live
 * `apply` path fails because of what this reports.
 *
 * Exit code is `0` ONLY when every named repo comes back `'not-applicable'`
 * — the one verdict that is a genuine, unambiguous pass (hosted is an
 * accepted choice, nothing to check). `'not-honoured'` and `'unknown'`
 * are non-zero, same "an honest-unknown never reads as fine" convention
 * `runner-audit.ts` already uses. **`'honoured'` is ALSO non-zero** —
 * deliberately not treated as a clean pass: `runner-declaration-reach.ts`'s
 * own doc explains why `conveysRunnerIntent` fires on ANY unrecognized
 * `with:` key, not specifically a runner-intent one, so a repo classified
 * `'honoured'` still needs an operator's eyes, tagged distinctly
 * (`DECLARED (runtime unverified)`, via the shared {@link runnerDeclarationTag}
 * — groundnuty/macf#1421) from a genuine `N/A` pass rather than silently
 * trusted.
 */
import { checkRunnerDeclarationReach, REAL_RUNNER_DECLARATION_DEPS, runnerDeclarationTag } from '../bootstrap/runner-declaration-reach.js';
import type { RunnerDeclarationDeps, RunnerDeclarationFinding } from '../bootstrap/runner-declaration-reach.js';

export interface RunnerDeclarationCheckCliOptions {
  readonly repos: readonly string[];
  /** The fleet's declared `routing.runner.runs_on` value (e.g. `fleet.yaml`'s own field, read by the caller). Any value other than the literal `'self-hosted'` short-circuits to `'not-applicable'` for every repo. */
  readonly runsOn: string | undefined;
  readonly json?: boolean;
}

function formatFinding(finding: RunnerDeclarationFinding): string {
  return `[${runnerDeclarationTag(finding.verdict)}] ${finding.message}`;
}

/**
 * Runs the check for every `opts.repos` entry and prints one line per
 * repo (human or `--json`). Returns the process exit code: `0` ONLY when
 * every repo is `'not-applicable'` — see this module's own doc for why
 * `'honoured'` does NOT count as clean here.
 */
export async function runRunnerDeclarationCheck(
  opts: RunnerDeclarationCheckCliOptions,
  deps: RunnerDeclarationDeps = REAL_RUNNER_DECLARATION_DEPS,
): Promise<number> {
  if (opts.repos.length === 0) {
    console.error('macf routing runner-declaration-check: at least one --repo <owner/repo> is required.');
    return 1;
  }

  const findings: RunnerDeclarationFinding[] = [];
  for (const repo of opts.repos) {
    findings.push(await checkRunnerDeclarationReach(repo, opts.runsOn, deps));
  }

  if (opts.json) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else {
    for (const finding of findings) console.log(formatFinding(finding));
  }

  const ok = findings.every((f) => f.verdict === 'not-applicable');
  return ok ? 0 : 1;
}
