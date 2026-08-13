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
 * caller that supplies a fake `DeleteRepoFn`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Real `DELETE /repos/{repo}`. NO confirmation, NO undo — see module doc. */
export async function realDeleteRepo(repo: string): Promise<void> {
  await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'DELETE']);
}

export type DeleteRepoFn = (repo: string) => Promise<void>;
