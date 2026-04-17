#!/usr/bin/env bash
# Print the identity associated with the current GH_TOKEN, and flag it
# LOUDLY if the token is the wrong type (e.g., a user PAT where a bot
# installation token is expected).
#
# This exists because of the silent-fallback trap: when `gh token generate`
# fails, `gh` falls back to the locally stored `gh auth login` token,
# and subsequent `gh` operations silently run as the user — but nothing
# surfaces the identity mismatch until cross-agent routing breaks.
#
# Usage:
#   macf-whoami.sh       # prints identity to stdout; non-zero exit on trouble
#
# Token prefixes (per GitHub docs):
#   ghs_  — server-to-server (App installation token) → /user returns 403
#   ghp_  — personal access token
#   gho_  — OAuth user token
#   ghu_  — user-to-server (GitHub App user-access) token

set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "Error: GH_TOKEN is unset." >&2
  exit 1
fi

prefix="${GH_TOKEN:0:4}"

case "$prefix" in
  ghs_)
    # Installation token — /user is 403. This is the EXPECTED prefix for a
    # healthy bot operation.
    echo "bot installation token (prefix=ghs_)"
    ;;
  ghp_|gho_|ghu_)
    user="$(gh api user --jq '.login' 2>/dev/null || echo '<unknown>')"
    echo "user token: $user (prefix=$prefix)"
    echo "" >&2
    echo "WARNING: this is NOT a bot installation token. All gh/git-push" >&2
    echo "operations will be attributed to '$user', not to the bot." >&2
    echo "If you expected a bot token, run:" >&2
    echo "  .claude/scripts/macf-gh-token.sh --app-id \$APP_ID --install-id \$INSTALL_ID --key \$KEY_PATH" >&2
    echo "and look at its stderr diagnostics." >&2
    exit 2
    ;;
  *)
    echo "unknown token type (prefix=$prefix, first chars only shown)" >&2
    echo "Expected ghs_ (bot installation), ghp_ (user PAT), gho_ (OAuth), or ghu_ (user-to-server)." >&2
    exit 3
    ;;
esac
