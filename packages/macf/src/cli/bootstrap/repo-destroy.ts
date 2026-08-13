/**
 * Repository DELETION — DR-043 Amendment G's terminal rung (`macf fleet
 * destroy`, groundnuty/macf#867). Deliberately its OWN file, never folded
 * into `repo-archive.ts` — Amendment G's "friction is the feature" /
 * make-the-bad-state-unrepresentable principle: archiving and destroying
 * have wildly different blast radii (archive is reversible via
 * `realUnarchiveRepo`; this has NO undo — GitHub does not soft-delete
 * repositories, there is no trash, no un-delete API), so they get named,
 * separately-importable primitives a reviewer can't misread at a call site
 * the way a shared `deleteRepo(repo, hard: boolean)` signature could be.
 *
 * This primitive performs NO confirmation of its own — same "the confirm
 * lives at the orchestration layer, never duplicated into the I/O leaf"
 * split every other `real*` primitive in this package follows
 * (`realArchiveRepo`, `realCreateRepo`, `realDeleteVariable`). The
 * operator-facing confirmation ladder (flag + typed fleet name + env
 * acknowledgment, `fleet-teardown-destructive.ts`) is what stands between a
 * `destroy` invocation and this function ever being called.
 *
 * Thin I/O leaf, untested directly — same posture as `repo-archive.ts` /
 * `repo-create.ts` (neither has a direct test file); exercised only via a
 * caller that supplies a fake `DeleteRepoFn`. This includes the 404→
 * `'already-absent'` classification regex added for groundnuty/macf#917:
 * the branch itself is exercised only through callers' fakes returning
 * `'already-absent'` directly (`teardown-destructive.test.ts`), never
 * through a real `gh` stderr string — the SAME posture
 * `variable-write.ts::realDeleteVariable`'s own equivalent regex has (only
 * its pure sibling `buildDeleteVariableArgs` is directly pinned).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStderr } from './observer.js';

const execFileAsync = promisify(execFile);

export type DeleteRepoResult = 'deleted' | 'already-absent';

/**
 * Real `DELETE /repos/{repo}`. NO confirmation, NO undo — see module doc.
 *
 * **Idempotency ruling (groundnuty/macf#917 — "decide deliberately").**
 * `'already-absent'` means the API reported a 404, and that is treated as
 * benign SUCCESS, not failure — the same shape/reasoning as
 * `variable-write.ts::realDeleteVariable`. This is a deliberate call, not
 * the default "any non-2xx throws": `buildDestroyPlan`'s own doc documents
 * `destroy`'s recovery story as re-running the ENTIRE command after a
 * partial failure ("the operator can fix the failure and re-run `destroy`
 * to completion"), and target derivation is exact-key EVERY re-run (never a
 * diff against what's already gone — module doc, `teardown.ts`'s "exact-key
 * targeting" rail) — so a re-run WILL re-target a repo the FIRST run already
 * deleted. A DELETE's 404 is unambiguous (unlike `realArchiveRepo`'s 403,
 * which a genuine permission failure ALSO produces — see that function's
 * doc): "this named resource does not exist" is the one thing 404 means on
 * a single-resource DELETE, so classifying it from the response is sound
 * here in a way it was NOT sound for the archive rung's 403. Any OTHER
 * failure (auth, network, insufficient scope) throws — never silently
 * swallowed, so the caller's "report what could not be done" rail has
 * something concrete to report.
 *
 * **Scope of the "re-run" this covers — a PARTIAL-failure re-run, not a
 * re-run after a fully successful `destroy`.** After every target repo
 * (agent repos, then the control repo LAST — `teardown-destructive.ts`'s
 * `buildDestroyPlan` doc) is genuinely deleted, the control repo is GONE — so
 * `resolveControlRepoOwnership` reads `absent` on the next invocation and
 * `evaluateTeardownGate` refuses the ENTIRE run with "nothing to tear down"
 * BEFORE this function is ever reached again. This ruling only matters for
 * the case `buildDestroyPlan`'s doc actually describes: destroy STOPPED
 * partway (some repos deleted, one failed, the control repo NOT yet
 * reached because agent repos delete first) — the gate still resolves
 * (control repo still exists), so a re-run reaches this function again and
 * needs the already-deleted agent repos to be idempotent, not refused.
 */
export async function realDeleteRepo(repo: string): Promise<DeleteRepoResult> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'DELETE']);
    return 'deleted';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'already-absent';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh api delete-repo failed for "${repo}": ${stderr || msg}`, { cause: err });
  }
}

export type DeleteRepoFn = (repo: string) => Promise<DeleteRepoResult>;
