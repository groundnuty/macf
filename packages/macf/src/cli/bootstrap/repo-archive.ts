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

/**
 * Real `PATCH /repos/{repo}` `archived=true`. **NOT idempotent on its own —
 * corrected groundnuty/macf#917**, observed live during a real teardown run:
 * GitHub 403s ("Repository was archived so is read-only") when the repo is
 * ALREADY archived, because an archived repo is read-only for every write,
 * including a redundant re-set of the SAME `archived` value. (This is the
 * reverse of {@link realUnarchiveRepo} below — `archived=false` is a
 * documented, GitHub-sanctioned exception to the read-only rule, since it IS
 * the un-archive mechanism; a same-value `archived=true` PATCH gets no such
 * carve-out.) Idempotency for the `archive` rung is provided ONE LAYER UP —
 * `teardown.ts::executeArchiveRepos` reads `.archived` first and skips this
 * call entirely once it's already `true` — never by this function catching
 * or matching its own 403 (an overloaded status also produced by genuine
 * permission failures; see `silent-fallback-hazards.md` Pattern A for why a
 * result-invariant read, not an error-shape match, is the correct guard).
 */
export async function realArchiveRepo(repo: string): Promise<void> {
  await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'PATCH', '-F', 'archived=true']);
}

/**
 * Real `PATCH /repos/{repo}` `archived=false` — DR-043 Amendment G's "free
 * revival" primitive (an approval keystroke + this one API call, zero
 * browser consent clicks). **Idempotent, genuinely (groundnuty/macf#917
 * ruling)** — un-archiving an already-live repo is an ordinary PATCH on a
 * normal, writable repo (not the read-only-because-archived state
 * `realArchiveRepo`'s doc describes), so it is NOT the asymmetric case that
 * function's 403 exposed; a same-value `archived=false` re-set is a no-op
 * 200 on GitHub's side. No state-read guard is needed here — unlike
 * `executeArchiveRepos`'s per-repo re-run gap, this function's only
 * production call site (`control-repo.ts`'s `provisionControlRepo`) reads
 * `meta.archived === true` moments earlier in the SAME invocation before
 * ever reaching this call, so there is no meaningful re-run window to guard
 * against.
 */
export async function realUnarchiveRepo(repo: string): Promise<void> {
  await execFileAsync('gh', ['api', `repos/${repo}`, '--method', 'PATCH', '-F', 'archived=false']);
}

export type ArchiveRepoFn = (repo: string) => Promise<void>;
export type UnarchiveRepoFn = (repo: string) => Promise<void>;
