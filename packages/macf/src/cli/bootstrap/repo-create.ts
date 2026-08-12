/**
 * `gh repo create` — the shared repo-creation I/O leaf, DR-043 §D2 / Amendment
 * F (groundnuty/macf#838, #854, #857).
 *
 * ONE primitive, TWO callers: `control-repo.ts::provisionControlRepo` creates
 * `<fleet>-control` with NO template (it holds only GitOps state + the sealed
 * vault, never agent-workspace content — see Amendment F); `apply-repo-init.ts
 * ::ensureAgentRepo` creates an agent's `repo` FROM `defaults.role_template`
 * (mirrors the DR-035 skill's manual `gh repo create <owner>/<repo> --template
 * groundnuty/agentic-repo-template --private` — "mechanism promoted to code,"
 * the same posture `manifest-exchange.ts` already established for
 * `bootstrap-exchange-manifest.sh`). Both go through this ONE function so a
 * future flag/behavior change (e.g. an org-vs-user branch, a visibility
 * override) lands in one place.
 *
 * `gh repo create OWNER/REPO ...` (a fully-qualified `owner/repo` argument,
 * which every caller here supplies) does not prompt interactively and
 * resolves org-vs-user itself from the `OWNER` segment — no separate
 * `FleetOwner`/org-vs-user branch needed in this module.
 *
 * Thin I/O leaf, untested directly — same posture as `apply-repo-init.ts`'s
 * `realCloneRepo`/`realCommitAndPush` and `observer.ts`'s `gh api` shell-outs;
 * exercised only via a caller that supplies a fake `CreateRepoFn`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CreateRepoOptions {
  /** `owner/repo` of a GitHub template repo (`gh repo create --template`). Omitted → a blank private repo (the control-repo case, and `provenance: mirror` agents — see `ensureAgentRepo`'s doc). */
  readonly template?: string;
}

export type CreateRepoFn = (repo: string, opts?: CreateRepoOptions) => Promise<void>;

/** Real `gh repo create <owner>/<repo> --private [--template <template>]`. */
export async function realCreateRepo(repo: string, opts?: CreateRepoOptions): Promise<void> {
  const args = ['repo', 'create', repo, '--private'];
  if (opts?.template !== undefined) args.push('--template', opts.template);
  await execFileAsync('gh', args);
}
