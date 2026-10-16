# Verify before you claim

## Evidence in comments

- Paste the literal output of the command that verified a close or handoff comment, with its `$` prompt, because a peer acts on what you say.

## Current state

- Before saying a PR merged, an issue closed, or one PR must wait on another, re-query it: `gh pr view <N> --json state,mergeStateStatus,mergedAt`. Reviews run for hours.
- When you cite code as what is on main, fetch first, then read `git show origin/main:<path>`; a local checkout or an unfetched `origin/main` can be behind.
- Before adding a config file or setting, check whether GitHub, the registry or an existing file already holds that state, and read from it.

## Peer evidence

- When citing a peer's evidence in a tracking issue, re-run the query yourself.
