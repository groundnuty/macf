# You are macf-code-agent[bot]

Your `GH_TOKEN` is a short-lived (1 hour) installation token generated from the GitHub App private key. It expires silently; always refresh before a `gh` or `git push` command in a new task.

## Canonical refresh pattern — fail-loud chain

**Always use this exact pattern.** Bare `export GH_TOKEN=$(gh token generate ... | jq ...)` is the attribution trap — if token generation fails, the string `"null"` becomes your token, `gh` silently falls back to stored user auth, and your PRs post as the user. We've hit this five times across agents; the fail-loud pattern is the default now.

```bash
GH_TOKEN=$(./.claude/scripts/macf-gh-token.sh \
  --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
export GH_TOKEN
```

The helper validates the `ghs_` prefix internally, uses `set -euo pipefail`, and emits actionable diagnostics on failure (clock drift, missing key, bad PEM, wrong App/install ID).

Or when inlining per-command instead of using the helper, include the prefix-guard directly:

```bash
GH_TOKEN=$(gh token generate --app-id $APP_ID --installation-id $INSTALL_ID --key $KEY_PATH | jq -r '.token') && \
  [[ "$GH_TOKEN" == ghs_* ]] || { echo "FATAL: bad token"; exit 1; }
export GH_TOKEN
```

On 401 or "Bad credentials" from a `gh` call, run the same refresh and retry.

## Git push

Use `-c url.insteadOf` for the push (don't bake the token into the remote URL):

    git -c url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf="https://github.com/" push

## Embed in command blocks

For operations that MUST succeed (PR creation, merge, any push), chain the refresh directly:

```bash
GH_TOKEN=$(./.claude/scripts/macf-gh-token.sh \
  --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
export GH_TOKEN && \
  gh pr create --repo groundnuty/macf ...
```

Chain, don't sequence in separate messages — a sequence can be interrupted.

## Never

- Never use the bare `export GH_TOKEN=$(gh token generate ... | jq -r '.token')` pattern — it silently swallows errors (no pipefail, no prefix check). See `plugin/rules/coordination.md` Token & Git Hygiene + `memory/feedback_attribution_trap_recurring.md` (5 recurrences logged).
- Never unset `GH_TOKEN` — always refresh instead.
- Never embed the token in a git remote URL permanently.
- Never commit `.github-app-key.pem` or a token.
- Never use your personal `gh auth` login for bot operations.
