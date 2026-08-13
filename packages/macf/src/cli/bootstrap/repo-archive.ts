/**
 * Repo archive / un-archive — DR-043 Amendment G (the fleet teardown
 * ladder, groundnuty/macf#867). `PATCH /repos/{owner}/{repo}` with a
 * TYPED `archived` boolean field: `-F` (typed), never `-f` (which would
 * send the literal STRING `"true"`/`"false"` — GitHub's schema requires a
 * JSON boolean, and the two `gh api` flags are easy to confuse at a glance).
 *
 * **Two functions, not one `setArchived(repo, bool)`.** Amendment G's own
 * design principle — "the same make-the-bad-state-unrepresentable
 * principle as removing `transport.vault_repo`... `macf fleet archive` and
 * `macf fleet destroy` cannot be confused; `--archive` vs `--purge` can" —
 * applies here too: the TEARDOWN direction (`realArchiveRepo`, called from
 * `macf fleet archive`'s bulk sweep over every fleet repo) and the REVIVAL
 * direction (`realUnarchiveRepo`, called from `apply`'s single
 * confirm-required un-archive of `<fleet>-control` — see
 * `control-repo.ts`'s `ours-archived` handling) run in very different
 * contexts. A shared boolean-parameter signature is exactly the kind of
 * call site a reviewer can misread; two named functions can't be swapped
 * by a typo the way `setArchived(repo, false)` vs `setArchived(repo, true)`
 * can.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Real `PATCH /repos/{repo}` `archived=true`. Idempotent — archiving an already-archived repo is a no-op 200 on GitHub's side, so a re-run of `macf fleet archive` never errors on this step. */
export async function realArchiveRepo(repo: string): Promise<void> {
  await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'PATCH', '-F', 'archived=true']);
}

/** Real `PATCH /repos/{repo}` `archived=false` — DR-043 Amendment G's "free revival" primitive (an approval keystroke + this one API call, zero browser consent clicks). Idempotent — un-archiving an already-live repo is a no-op 200. */
export async function realUnarchiveRepo(repo: string): Promise<void> {
  await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'PATCH', '-F', 'archived=false']);
}

export type ArchiveRepoFn = (repo: string) => Promise<void>;
export type UnarchiveRepoFn = (repo: string) => Promise<void>;
