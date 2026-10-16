# GitHub token and attribution

Agents act on GitHub as their bot, with a one-hour installation token. If `GH_TOKEN` is empty or wrong, `gh` falls back to the stored user login and succeeds, so the post lands under the operator's name and nothing shows the mismatch. This file owns the token procedure; other rules point here.

## Mint a token

Mint in its own step, before the `gh` or `git push` command, and refresh when a call returns 401. Use as written:

    GH_TOKEN=$("$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \
      --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
    export GH_TOKEN

- Assign bare, then export. In `export GH_TOKEN=$(…)` the export's own exit status replaces the helper's, so a failed mint is not caught and the variable ends up empty.
- Do not mint inline inside the `gh` command, because the guard hook checks the token before the command runs and cannot see a value reassigned mid-command.
- Use `$MACF_WORKSPACE_DIR/` as the prefix, not `./`, because a relative path breaks after `cd` to another repo and the substitution silently returns nothing. `KEY_PATH` must be absolute for the same reason.
- The helper checks the `ghs_` prefix, so a user token (`ghp_`, `gho_`, `ghu_`) is refused. Never use a user token for bot work.
- Treat everything after the prefix as opaque. Validate only: non-empty, `ghs_` prefix, characters `[A-Za-z0-9._-]`. Do not check length or format.

## Push

Pass the token in the URL of that one push, so it never persists in the remote:

    git -c url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf="https://github.com/" push -u origin HEAD

An SSH remote ignores this. Push to the explicit `https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git` URL instead.

## When minting fails

Diagnose, do not work around it:

- JWT "could not be decoded": clock drift (check `timedatectl status`) or a key that no longer matches the App.
- Wrong App or installation ID: check `$APP_ID` and `$INSTALL_ID` in `.claude/settings.local.json`.
- A 401 on one endpoint while others work: the App lacks that permission; run `macf doctor`.
- Helper missing: `macf rules refresh --dir .`.

## Hooks

- `check-gh-token.sh` blocks `gh` and `git push` before they run when `GH_TOKEN` is not a bot token. Mint again as above. If the session's environment is itself bad, relaunch with `./claude.sh`.
- `check-gh-attribution.sh` reads who authored what you just posted and warns when it was the user account. Follow its message, and if a post landed under the wrong identity, add a clarifying comment instead of deleting it.

Both overrides (`MACF_SKIP_TOKEN_CHECK`, `MACF_SKIP_ATTRIBUTION_CHECK`) are read at launch only; setting them inside a session has no effect.

To check which agent you are, read `.macf/macf-agent.json`. `macf-whoami.sh` reports only whether the token is a bot token.
