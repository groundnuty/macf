/**
 * macf self-update — pulls main + rebuilds the CLI's own dist/ (#144).
 *
 * Solves the stale-dist recurrence where operators `npm link`-ed to the
 * macf source repo hit silent no-op behavior after a CLI-behavior PR
 * merged: the installed binary points at an older `dist/cli/index.js`
 * because no one ran `npm run build`.
 *
 * This command fetches + ff-merges origin/main into the local source
 * checkout, then runs `npm run build` to refresh `dist/`. No-op when
 * already up-to-date. Refuses to run on a dirty tree or divergent
 * local commits — operator cleans up by hand; we don't guess.
 *
 * Bootstrap limitation: this command only helps CLI versions at or
 * after #144. Pre-#144 upgrades were silent; existing workspaces pick
 * up detection on first rebuild after this PR lands.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SelfUpdateResult {
  readonly updated: boolean;
  readonly previousCommit: string;
  readonly newCommit: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run the self-update sequence in `sourceRepoDir` (typically the
 * result of findCliPackageRoot()).
 *
 * Set MACF_SELF_UPDATE_SKIP_BUILD=1 to skip the `npm run build` step
 * (used by unit tests that don't want to exercise npm).
 */
export function selfUpdate(sourceRepoDir: string): SelfUpdateResult {
  if (!existsSync(join(sourceRepoDir, '.git'))) {
    throw new Error(
      `${sourceRepoDir} is not a git-cloned install (no .git/ directory). ` +
        `self-update only works for npm-link dev installs, not tarball extracts.`,
    );
  }

  // Refuse dirty trees — operator may have in-flight work we'd lose.
  // Clamp the status output to the first 20 lines so a pathological
  // dirty state (e.g. `rm -rf node_modules/` before the rebuild) doesn't
  // produce a wall of text in the error. 20 lines is enough context for
  // a typical few-modified-files case; beyond that the operator needs
  // to run `git status` themselves anyway. Per science-agent's #144
  // review non-blocker.
  const status = git(sourceRepoDir, 'status', '--porcelain');
  if (status !== '') {
    const lines = status.split('\n');
    const shown = lines.slice(0, 20).join('\n');
    const truncation = lines.length > 20
      ? `\n... (${lines.length - 20} more; run \`git status\` to see them all)`
      : '';
    throw new Error(
      `working tree is dirty in ${sourceRepoDir}:\n${shown}${truncation}\n` +
        `self-update refuses to overwrite uncommitted changes. ` +
        `Commit or stash first, then re-run.`,
    );
  }

  const previousCommit = git(sourceRepoDir, 'rev-parse', 'HEAD');

  // Fetch origin/main (don't merge yet — we want to decide based on
  // divergence first).
  git(sourceRepoDir, 'fetch', 'origin', 'main');
  const remoteCommit = git(sourceRepoDir, 'rev-parse', 'origin/main');

  if (previousCommit === remoteCommit) {
    console.log(`Already up-to-date at ${previousCommit.slice(0, 7)} — no update needed.`);
    return { updated: false, previousCommit, newCommit: previousCommit };
  }

  // Check for divergence: if local HEAD isn't an ancestor of remote,
  // ff-only would fail — surface a clear error instead of letting git
  // spit its usual "non-fast-forward" message.
  try {
    git(sourceRepoDir, 'merge-base', '--is-ancestor', previousCommit, remoteCommit);
  } catch {
    throw new Error(
      `local HEAD has diverged from origin/main (non-fast-forward, ff-only would fail). ` +
        `Rebase or reset manually, then re-run self-update. Local: ${previousCommit.slice(0, 7)}, ` +
        `remote: ${remoteCommit.slice(0, 7)}.`,
    );
  }

  console.log(`Fast-forwarding ${previousCommit.slice(0, 7)} → ${remoteCommit.slice(0, 7)}...`);
  git(sourceRepoDir, 'merge', '--ff-only', 'origin/main');

  // Only reinstall deps when package-lock.json actually changed between
  // commits. `npm ci` is load-bearing when deps move (nukes node_modules
  // and reinstalls from lockfile — correctness-critical for a rebuild)
  // but on the common case where a PR touches only `src/`, it's
  // minutes of wasted cold-cache time. Caught in the post-#140 audit
  // pass, 2026-04-20. `git diff --quiet` exits 0 on no-diff, non-zero
  // on any diff — exactly the signal we want.
  let lockChanged = false;
  try {
    execFileSync(
      'git',
      ['diff', '--quiet', previousCommit, remoteCommit, '--', 'package-lock.json'],
      { cwd: sourceRepoDir, stdio: 'ignore' },
    );
  } catch {
    lockChanged = true;
  }
  if (lockChanged) {
    console.log('package-lock.json changed; will run `npm ci` to refresh node_modules.');
  } else {
    console.log('package-lock.json unchanged; skipping `npm ci` (deps already up-to-date).');
  }

  if (process.env['MACF_SELF_UPDATE_SKIP_BUILD'] !== '1') {
    if (lockChanged) {
      execFileSync('npm', ['ci'], { cwd: sourceRepoDir, stdio: 'inherit' });
    }
    console.log('Running `npm run build` to refresh dist/...');
    execFileSync('npm', ['run', 'build'], { cwd: sourceRepoDir, stdio: 'inherit' });
  }

  const newCommit = git(sourceRepoDir, 'rev-parse', 'HEAD');
  console.log(`CLI refreshed — now at ${newCommit.slice(0, 7)}.`);
  return { updated: true, previousCommit, newCommit };
}
