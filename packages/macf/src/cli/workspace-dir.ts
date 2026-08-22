/**
 * Shared `--dir`-vs-`MACF_WORKSPACE_DIR` precedence discriminator.
 *
 * `restart-self.ts`'s `resolveIdentity` established the fix for this exact
 * hazard (macf#888): an explicit `--dir <target>` must WIN over the calling
 * agent's own ambient `MACF_WORKSPACE_DIR`, or a command told to act on one
 * project silently acts on the caller's own instead. `fleet resume` /
 * `fleet reconcile` / `fleet install-cron` reproduced the PRE-#888 shape
 * (ambient env unconditionally wins, with no `dirExplicit` distinction at
 * all) in a sibling command family (macf#1123).
 *
 * This module is the single home for "was `--dir` passed explicitly, and
 * does it conflict with the ambient env" for every `--dir`-taking command
 * EXCEPT `restart-self` (left untouched — it is already correct, and its
 * `resolveIdentity` is the reference this module's precedence matches
 * exactly). Without a shared home, each of the three sibling commands would
 * re-derive the same discriminator independently — two (or four)
 * independent copies of the same predicate are a silent-drift risk, the
 * same class `check-framework-surface.sh` / `macf-startup-pickup.sh` closed
 * by sharing one `.git`-shape predicate instead of re-deriving it per script
 * (macf#1121/#1124).
 */

/** Where a resolved workspace dir's value came from. */
export type WorkspaceDirSource = 'dir-flag' | 'env' | 'cwd-discovery';

export interface ResolvedWorkspaceDir {
  readonly workspaceDir: string;
  readonly source: WorkspaceDirSource;
  /**
   * The discarded `MACF_WORKSPACE_DIR` value, set ONLY when an explicit
   * `--dir` won over a DIFFERING ambient value. `null` whenever there is
   * nothing to warn about (env unset, env matches `--dir`, or `--dir` was
   * never passed).
   */
  readonly workspaceDirConflict: string | null;
}

/**
 * Resolve `workspaceDir`, matching `restart-self.ts`'s `resolveIdentity`
 * precedence exactly:
 *
 * - `dirExplicit=true` (an explicit `--dir <target>` was passed): the
 *   target ALWAYS wins, regardless of the ambient `MACF_WORKSPACE_DIR`.
 *   `workspaceDirConflict` records the discarded env value so the caller
 *   can warn — never silently.
 * - `dirExplicit=false` (no `--dir`; the ordinary in-session invocation):
 *   UNCHANGED precedence — ambient `MACF_WORKSPACE_DIR` wins over the
 *   auto-discovered `projectDir` when set, else `projectDir` itself. This
 *   is the path every pre-existing no-`--dir` caller (a cron line, an
 *   agent restarting itself) depends on and must not break.
 */
export function resolveWorkspaceDir(
  projectDir: string,
  dirExplicit: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkspaceDir {
  const envWorkspaceDir = env['MACF_WORKSPACE_DIR']?.trim();
  if (dirExplicit) {
    return {
      workspaceDir: projectDir,
      source: 'dir-flag',
      workspaceDirConflict:
        envWorkspaceDir && envWorkspaceDir !== projectDir ? envWorkspaceDir : null,
    };
  }
  return {
    workspaceDir: envWorkspaceDir || projectDir,
    source: envWorkspaceDir ? 'env' : 'cwd-discovery',
    workspaceDirConflict: null,
  };
}

/**
 * The conflict-warning line — matches `restart-self.ts`'s `runRestartSelf`
 * stderr warning SHAPE exactly (only the command label differs), so an
 * operator sees the same warning regardless of which `--dir`-taking command
 * discarded its ambient env. Returns `null` when there is nothing to warn
 * about (mirrors `resolved.workspaceDirConflict`).
 */
export function formatWorkspaceDirConflictWarning(
  commandLabel: string,
  resolved: ResolvedWorkspaceDir,
): string | null {
  if (!resolved.workspaceDirConflict) return null;
  return (
    `macf ${commandLabel}: --dir wins over MACF_WORKSPACE_DIR=${resolved.workspaceDirConflict} ` +
    `— targeting ${resolved.workspaceDir} (without this, ${commandLabel} would ` +
    'silently target the CALLER, not the named workspace).'
  );
}

/**
 * Was `--dir` passed explicitly on argv? Commander's `--dir <path>`
 * registration carries no 3rd-arg default, so `opts.dir` is `undefined`
 * exactly when the flag is absent — the only reliable "explicit" signal.
 * Callers must capture this BEFORE `resolveProjectDir` collapses the
 * explicit-vs-auto-discovered paths into the same string shape (macf#347's
 * lesson: a resolved path is truthy either way and can't be used to infer
 * "explicit" after the fact).
 *
 * Threaded from `restart-self`'s original inline capture (macf#888) into
 * this single shared function so a fourth (or fifth) `--dir`-taking command
 * never has the chance to re-derive — and silently drift from — the same
 * predicate (macf#1123).
 */
export function isDirExplicit(opts: { readonly dir?: string }): boolean {
  return opts.dir !== undefined;
}
