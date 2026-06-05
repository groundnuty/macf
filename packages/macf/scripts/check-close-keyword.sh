#!/usr/bin/env bash
#
# check-close-keyword.sh — Claude Code PreToolUse hook that blocks
# `gh pr create` / `gh pr edit` invocations whose body / title contains a
# GitHub auto-close keyword (`close`/`closes`/`closed`/`fix`/`fixes`/`fixed`/
# `resolve`/`resolves`/`resolved`) adjacent to an issue ref (`#N` or
# `owner/repo#N`) **filed by another agent**. On merge, such a keyword
# auto-closes the referenced issue — bypassing reporter-owns-closure
# (coordination.md §Issue Lifecycle 1). The keyword parser is negation-blind
# and context-blind (tables, checklists, quotes, code fences don't shield it),
# so cognitive discipline has proven insufficient (4 self-inflicted recurrences
# — macf#316/#410/#430). This is the Path-2 structural backstop.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr is fed
# back to Claude as the error). Mirrors check-gh-token.sh / check-mention-
# routing.sh in shape (wrapper-aware invocation matching, fail-open on parse
# error so a broken hook never bricks the harness).
#
# Discriminator: blocks ONLY when the referenced issue's author is NOT the
# acting bot. A self-filed `Closes #own` is legitimate and passes. The acting
# bot login is `${MACF_AGENT_NAME}[bot]` (falls back to $GIT_AUTHOR_NAME, which
# env.identity sets to `<agent_name>[bot]`).
#
# Override: MACF_SKIP_CLOSE_CHECK=1 bypasses (deliberate cross-fix, or the rare
# case the heuristic mis-resolves authorship).
#
# Refs: groundnuty/macf#431 (this hook); coordination.md §Issue Lifecycle 1
#       (the 9 forbidden variants + reporter-owns-closure); silent-fallback-
#       hazards.md Instance 2; #140 / #244+#272 / #270 (sister Path-2 hooks).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_CLOSE_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a broken
# hook must not brick the harness. Same defense-in-depth as the sister hooks.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0

# Wrapper-aware match for `gh pr create` / `gh pr edit`. Mirrors check-gh-
# token.sh / check-mention-routing.sh — covers sudo, env VAR=, watch, ionice,
# setsid, nice, time prefix wrappers + chained-form leadins `;` `|` `&` `(`
# (subshell) + bare `VAR=val gh ...`. These are the two subcommands whose
# body/title lands in the merge commit (and thus can auto-close on merge).
GH_PR_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+(create|edit)([[:space:]]|$)'

# Shell-wrapper bypass: `bash -c "gh pr create ..."` and variants.
SHELL_C_GH_PR_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+pr[[:space:]]+(create|edit)([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_PR_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_PR_PATTERN ]]; then
  exit 0
fi

# ── Acting bot login ─────────────────────────────────────────────────────
# Prefer MACF_AGENT_NAME (env.identity exports it as the agent stem, e.g.
# `macf-code-agent`); the bot login is `<stem>[bot]`. Fall back to
# GIT_AUTHOR_NAME (env.identity sets it to `<stem>[bot]` already). May be empty
# in a workspace with no identity env — handled conservatively below.
ACTING_BOT=""
if [[ -n "${MACF_AGENT_NAME:-}" ]]; then
  # Strip a trailing `[bot]` first so a misconfigured MACF_AGENT_NAME that
  # already carries it doesn't become `<name>[bot][bot]` (which would
  # mis-block self-filed closes). Append exactly once.
  ACTING_BOT="${MACF_AGENT_NAME%"[bot]"}[bot]"
elif [[ -n "${GIT_AUTHOR_NAME:-}" && "${GIT_AUTHOR_NAME}" == *"[bot]" ]]; then
  ACTING_BOT="${GIT_AUTHOR_NAME}"
fi

# ── Repo the PR targets (for refs without an owner/repo prefix) ──────────
# Parse `--repo owner/repo` (or `--repo=owner/repo`) from the command; fall
# back to gh's default repo resolution for the cwd.
PR_REPO="$(grep -oE -- '--repo[ =][^[:space:]]+' <<<"$COMMAND" | head -1 | sed -E 's/^--repo[ =]//' | tr -d "\"'" || true)"
if [[ -z "$PR_REPO" ]]; then
  PR_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi

# ── Build the scan text: the raw command (covers inline --body, --title, and
#    heredoc text) plus the contents of any --body-file (a file path, NOT an
#    inline arg — the bypass most likely to slip a body-only scan). ─────────
# `-F` is gh's documented short alias for `--body-file` (`gh pr create --help`:
# `-F, --body-file file`), so normalize the space/`=` forms `-F path` / `-F=path`
# → `--body-file …` before extraction, else a peer close-keyword in a `-F`-passed
# file slips the scan (groundnuty/macf#431 review must-fix 1).
#
# Known inherent non-guards (backstop, not airtight): `--body-file -` / `-F -`
# (stdin — unreadable at hook-fire time); the glued short form `-Fpath`; and a
# path-prefixed binary (`/usr/bin/gh pr create …`, where the leading boundary
# class doesn't see a bare `gh`). The authorship+merge-time reality still
# catches the common forms; these are documented so they're known, not silent.
NORM_CMD="$(sed -E 's/(^|[[:space:]])-F([ =])/\1--body-file\2/g' <<<"$COMMAND")"
SCAN_TEXT="$COMMAND"
while IFS= read -r bf; do
  [[ -z "$bf" ]] && continue
  bf="${bf%\"}"; bf="${bf#\"}"; bf="${bf%\'}"; bf="${bf#\'}"
  if [[ -f "$bf" ]]; then
    SCAN_TEXT+=$'\n'"$(cat "$bf" 2>/dev/null || true)"
  fi
done < <(grep -oE -- '--body-file[ =][^[:space:]]+' <<<"$NORM_CMD" | sed -E 's/^--body-file[ =]//' || true)

# ── Find close-keyword → issue-ref adjacencies ───────────────────────────
# Mirrors GitHub's actual parser: the keyword must be a whole word
# (word-boundary before it) and immediately followed by only whitespace then
# the ref — `fix the bug in #1` does NOT auto-close, so it must NOT match.
# The ref may carry an optional `owner/repo` prefix (cross-repo close, e.g.
# `closes groundnuty/macf#418` in a devops-toolkit PR — lands in the squash
# commit + closes the referenced repo's issue).
KW_ALT='close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved'
# After the keyword, either a `:` + optional space (`Closes: #5` AND `Closes:#5`)
# OR required whitespace (`Closes #5`) — but NOT `closes#5` (no separator, which
# GitHub does not auto-close). The leading boundary `[^A-Za-z]` (or line start)
# keeps `unfixes #1` / `prefixes #1` from matching.
ADJ_RE="(^|[^A-Za-z])(${KW_ALT})(:[[:space:]]*|[[:space:]]+)([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)?#[0-9]+"

# grep -o yields each match including the optional leading boundary char;
# strip it so each token is `<kw>[ ](<owner/repo>)?#N`.
MATCHES="$(grep -oiE "$ADJ_RE" <<<"$SCAN_TEXT" | sed -E 's/^[^A-Za-z]+//' || true)"
[[ -z "$MATCHES" ]] && exit 0

# ── Resolve authorship for each unique ref + classify ────────────────────
# Returns one of: NOTFOUND (no such issue → safe, no auto-close target),
# OK:<PR|ISSUE>:<login>, or APIERROR:<msg>.
resolve_issue() {
  local repo="$1" num="$2" out rc err errfile
  # Single gh call: capture stdout + stderr + rc atomically so the
  # success/404/error classification can't split across two flaky calls.
  errfile="$(mktemp)"
  out="$(GH_PAGER= gh api "repos/${repo}/issues/${num}" 2>"$errfile")"; rc=$?
  err="$(cat "$errfile" 2>/dev/null || true)"; rm -f "$errfile"
  if [[ $rc -ne 0 ]]; then
    if grep -qiE '404|not found' <<<"$err"; then
      echo "NOTFOUND"
    else
      echo "APIERROR:$(tr '\n' ' ' <<<"$err" | cut -c1-120)"
    fi
    return 0
  fi
  local login ispr
  login="$(jq -r '.user.login // ""' <<<"$out")"
  ispr="$(jq -r 'if .pull_request then "PR" else "ISSUE" end' <<<"$out")"
  echo "OK:${ispr}:${login}"
}

BLOCKED=""        # accumulated human-readable offenders
SEEN=""           # dedup set of "repo#N"

while IFS= read -r m; do
  [[ -z "$m" ]] && continue
  num="$(grep -oE '#[0-9]+' <<<"$m" | head -1 | tr -d '#')"
  [[ -z "$num" ]] && continue
  prefix="$(grep -oE '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#' <<<"$m" | head -1 | sed 's/#$//' || true)"
  kw="$(grep -oiE "^(${KW_ALT})" <<<"$m")"
  target_repo="${prefix:-$PR_REPO}"

  # Can't determine which repo → can't verify authorship. Conservative block.
  if [[ -z "$target_repo" ]]; then
    BLOCKED+=$'\n'"  - \"${kw} #${num}\" → could not determine target repo (pass --repo or run from the repo)"
    continue
  fi

  key="${target_repo}#${num}"
  case " $SEEN " in *" $key "*) continue ;; esac
  SEEN+=" $key"

  res="$(resolve_issue "$target_repo" "$num")"
  case "$res" in
    NOTFOUND)
      : # no such issue → nothing to auto-close → allow
      ;;
    OK:PR:*)
      : # a PR, not an issue → auto-close keywords don't close PRs → allow
      ;;
    OK:ISSUE:*)
      login="${res#OK:ISSUE:}"
      if [[ -n "$ACTING_BOT" && "${login,,}" == "${ACTING_BOT,,}" ]]; then
        : # self-filed → legitimate auto-close → allow
      elif [[ -z "$ACTING_BOT" ]]; then
        BLOCKED+=$'\n'"  - \"${kw} ${prefix:+${prefix}}#${num}\" → ${target_repo}#${num} filed by ${login}; could not confirm you are the author (no MACF_AGENT_NAME / GIT_AUTHOR_NAME)"
      else
        BLOCKED+=$'\n'"  - \"${kw} ${prefix:+${prefix}}#${num}\" → ${target_repo}#${num} filed by ${login} (not you, ${ACTING_BOT})"
      fi
      ;;
    APIERROR:*)
      BLOCKED+=$'\n'"  - \"${kw} ${prefix:+${prefix}}#${num}\" → could not verify ${target_repo}#${num} author (API: ${res#APIERROR:})"
      ;;
  esac
done <<<"$MATCHES"

[[ -z "$BLOCKED" ]] && exit 0

cat >&2 <<ERR
BLOCKED by MACF close-keyword guard: this \`gh pr create/edit\` would auto-close
an issue you did not file when the PR merges, bypassing reporter-owns-closure
(coordination.md §Issue Lifecycle 1).

Offending close-keyword reference(s):${BLOCKED}

GitHub's auto-close parser fires on \`<keyword> #N\` adjacency in a PR body or
title — negation-blind and context-blind (tables, checklists, quotes, and code
fences do NOT shield it). On merge it closes the referenced issue before the
reporter can verify the fix matches their intent.

Fix: replace the close-keyword with \`Refs\` (which references without closing):
  Wrong:  closes #${num:-N}            Right:  Refs #${num:-N}
  Wrong:  fixes owner/repo#${num:-N}   Right:  Refs owner/repo#${num:-N}

Then the reporter closes it after verifying, per coordination.md.

Override (ONLY for a deliberate cross-fix, or your OWN issue the check
mis-resolved):
  export MACF_SKIP_CLOSE_CHECK=1

Refs: groundnuty/macf#431 (this hook); coordination.md §Issue Lifecycle 1
(the 9 forbidden variants); silent-fallback-hazards.md Instance 2.
ERR
exit 2
