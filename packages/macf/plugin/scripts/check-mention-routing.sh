#!/usr/bin/env bash
#
# check-mention-routing.sh — Claude Code PreToolUse hook that blocks
# `gh issue comment` / `gh pr comment` / `gh issue close --comment` /
# `gh pr close --comment` / `gh issue create` / `gh pr create` invocations
# when the body content contains raw `@macf-<role>-agent[bot]` mentions in
# describing contexts (mid-line, not backticked) — Check B — or, for a
# routed `create`, carries none at all — Check A. Implements
# `mention-routing-hygiene.md` + `coordination.md` §Communication 1
# structurally.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). Mirrors the shape of #140's
# check-gh-token.sh per groundnuty/macf#272 design alignment.
#
# Override: MACF_SKIP_MENTION_CHECK=1 bypasses (for legitimate raw-mention
# cases the heuristic catches; rare per the canonical rule's structure
# but mirrors check-gh-token.sh's escape hatch).
#
# ── `create` coverage (groundnuty/macf#1091) ──────────────────────────────
# Check B (must-not-leak) applies to `gh issue create` / `gh pr create`
# bodies unconditionally — a describing-context leak fires false-positive
# routing regardless of the creator's intent.
#
# Check A (must-have-mention) is DECLARED, not inferred, per the operator's
# ruling: "obvious for an agent" is the binding constraint, and inferring
# intent from label absence is ambiguous (backlog, or forgot?) in a way an
# agent can't self-diagnose. So the author states intent via labels, and
# the hook enforces that the statement is present. Four cases, evaluated
# against the create's `--label`/`-l` values:
#   1. `backlog` label present                        → ALLOW. Declared:
#      nobody's queue, on purpose. `delegation-template.md`'s canonical
#      Backlog mode ("Route this now or backlog?" → "Use a separate
#      `backlog` label"). `macf repo-init` creates this label on every
#      freshly-provisioned repo (STATUS_LABELS in repo-init.ts) so the
#      escape hatch always exists, not just on repos with prior history.
#   2. assignee label CONFIRMED naming ANOTHER agent   → ALLOW. route-by-
#      label already delivers it — a mention would be redundant.
#      "Confirmed" requires BOTH: the label matches THIS repo's actual
#      routing-label registry (`.github/agent-config.json`'s `.agents`
#      keys — the file `macf repo-init` writes and the router reads;
#      never a hardcoded role list, since fleets choose their own role
#      names) AND it differs from the acting agent's own routing label.
#   3. assignee label CONFIRMED naming the ACTING agent itself → BLOCK.
#      The router skips a label applied by the agent it names, so the
#      issue routes to no one. This is the failure this hook exists to
#      catch: an issue self-labeled by its filer sat unanswered while a
#      blocking design question inside it waited on a peer who never saw
#      it. A mention in a NEW issue's body cannot rescue it: the router
#      runs route-by-mention only for issue_comment, pull_request and
#      pull_request_review events, never for a new issue's body, so for
#      the issue-create form cases 3 and 4 block even when the body
#      carries a mention. (For a PR create a body mention does route, so
#      there a mention still satisfies the check.)
#   4. anything else — no labels at all; labels that don't match the
#      registry; a registry match the hook can't confirm as self or peer
#      (`$MACF_ROUTING_LABEL` unset) → BLOCK on `gh issue create`; ALLOW on
#      `gh pr create`. Ambiguous states default to BLOCK for issues, never
#      ALLOW — the same posture as case 3, and the reason case 1 has to be
#      a POSITIVE declaration rather than "well, nothing else matched." A
#      PR is NOT ambiguous the same way: it has no backlog concept, and
#      its real routing signal is the pull_request_review state-change
#      event (route-by-pr-review-state) plus a separately-mentioned issue
#      comment, not the PR body — see `pr-discipline.md`. agent-identity.md's
#      canonical PR-creation call is unlabeled, unmentioned
#      (`--body "Refs #<N>"`); blocking case 4 there would break every PR
#      the fleet creates, and — because `MACF_SKIP_MENTION_CHECK` is
#      launch-time-only (see the override guidance in the Check A block
#      below) — unrecoverably until an operator relaunches. Case 3 still
#      blocks a self-labeled `gh pr create`; only case 4 is issue-only.
# Self-identity (cases 2 vs. 3) comes from `$MACF_ROUTING_LABEL` (canonical,
# always-exported by claude.sh's env.identity — coordination.md's tmux
# launch-pattern section documents it as the routing/registry/cert-CN key,
# distinct from the OTEL display name `$MACF_AGENT_NAME`). If unset, or if
# `.github/agent-config.json` itself is unavailable, the hook can't confirm
# case 2 — it falls to case 4 (block), the same fail-toward-block-on-
# uncertainty posture as case 4's other branches (this differs from the
# rest of this hook family's fail-OPEN-on-infrastructure-absence norm,
# because here "can't tell" and "genuinely no signal" are the same
# observable state from the recipient's side, and the operator's ruling is
# that state must block).
#
# Refs: groundnuty/macf#244 (must-have-mention class — orthogonal, deferred),
#       groundnuty/macf#272 (must-not-leak — what this script enforces),
#       groundnuty/macf#1091 (this `create` extension),
#       DR-023 UC-4 (bash-form per substrate-compat — mcp_tool variant
#       won't fire on substrate workspaces where the macf-agent MCP server
#       isn't loaded, but the breach pattern is concentrated on substrate).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_MENTION_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a
# broken hook must not brick the harness. Same defense-in-depth as
# check-gh-token.sh.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Wrapper-aware match for the body-carrying subcommands. Mirrors
# check-gh-token.sh's pattern shape — covers sudo, env VAR=, watch,
# ionice, setsid, nice, time prefix wrappers + chained-form leadins
# `;` `|` `&`. The subcommands we care about are exactly those that
# accept --body and post text content visible to other agents:
#   gh issue comment    gh pr comment
#   gh issue close      gh pr close      (only when --comment is present;
#                                          plain close has no body)
#   gh issue create      gh pr create    (groundnuty/macf#1091)
# One wrapper list feeds the segment reader below.
WRAP_LIST='sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+'

# Cheap prefilter: a superset of every form the splitter below accepts.
if [[ ! "$COMMAND" =~ gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close|create) ]]; then
  exit 0
fi

# ── One quote-aware command splitter (groundnuty/macf#1482) ───────────────
# Every detector reads commands from this walk, never from regexes over raw
# text, so text inside a quoted argument or a heredoc body never starts a
# command. macf_split_text walks once, tracking '...', "..." (backslash
# escapes), $'...' and heredoc bodies (<<EOF, <<'EOF', <<-EOF). It cuts at ;
# & | ( ) and newlines outside quotes and heredoc bodies; && and || are two
# cuts. Each cut piece goes to macf_collect_segment, which strips wrapper
# prefixes and, for `bash|sh|zsh -c`-style flag clusters (-c -lc -ec -xc ...),
# unquotes the script and splits it recursively. Results land in EFF_CMDS.
# Residual: a command substitution inside double quotes is not entered.
EFF_CMDS=()

# Sets MACF_UNQUOTED to the first shell word of $1, quotes removed.
macf_unquote_first_word() {
  local r="$1" i=1 n c nx out=""
  n=${#r}
  MACF_UNQUOTED=""
  if [[ "${r:0:1}" == "'" ]]; then
    out="${r:1}"; MACF_UNQUOTED="${out%%\'*}"; return 0
  fi
  if [[ "${r:0:2}" == "\$'" ]]; then
    i=2
    while [[ $i -lt $n ]]; do
      c="${r:i:1}"; nx="${r:i+1:1}"
      if [[ "$c" == "\\" ]]; then
        if [[ "$nx" == "n" ]]; then out+=$'\n'; else out+="$nx"; fi
        i=$((i + 2)); continue
      fi
      [[ "$c" == "'" ]] && break
      out+="$c"; i=$((i + 1))
    done
    MACF_UNQUOTED="$out"; return 0
  fi
  if [[ "${r:0:1}" == '"' ]]; then
    while [[ $i -lt $n ]]; do
      c="${r:i:1}"; nx="${r:i+1:1}"
      if [[ "$c" == "\\" ]]; then
        case "$nx" in
          '"'|'\'|'$'|'`') out+="$nx" ;;
          *) out+="$c$nx" ;;
        esac
        i=$((i + 2)); continue
      fi
      [[ "$c" == '"' ]] && break
      out+="$c"; i=$((i + 1))
    done
    MACF_UNQUOTED="$out"; return 0
  fi
  MACF_UNQUOTED="${r%%[[:space:]]*}"
  return 0
}

macf_collect_segment() {
  local seg="$1" depth="$2"
  local wre='^[[:space:]]*('"$WRAP_LIST"')*'
  # Shell reserved words and negation lead a command without changing it
  # (`if gh ...; then`, `while gh ...; do`, `! gh ...`, `{ gh ...; }`).
  local kre='^[[:space:]]*(if|then|else|elif|while|until|do|!|\{)([[:space:]]+|$)'
  local before="" guard=0
  while [[ "$seg" != "$before" ]] && [[ "$guard" -lt 20 ]]; do
    before="$seg"; guard=$((guard + 1))
    if [[ "$seg" =~ $wre ]]; then seg="${seg:${#BASH_REMATCH[0]}}"; fi
    if [[ "$seg" =~ $kre ]]; then seg="${seg:${#BASH_REMATCH[0]}}"; fi
  done
  [[ -z "$seg" ]] && return 0
  local sre='^(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+(.*)$'
  if [[ "$depth" -lt 4 ]] && [[ "$seg" =~ $sre ]]; then
    macf_unquote_first_word "${BASH_REMATCH[3]}"
    macf_split_text "$MACF_UNQUOTED" $((depth + 1))
    return 0
  fi
  EFF_CMDS+=("$seg")
  return 0
}

# Skips the bodies of the heredocs opened on the line just ended. $1 = text,
# $2 = index of that newline. Sets MACF_SKIP_TO to the index of the last
# consumed character; the delimiters come in the HD_DELIMS / HD_STRIPS arrays.
macf_skip_heredoc_bodies() {
  local s="$1" i="$2" k line rest cmp
  rest="${s:i+1}"
  local consumed=$((i + 1))
  for ((k = 0; k < ${#HD_DELIMS[@]}; k++)); do
    while [[ -n "$rest" ]]; do
      if [[ "$rest" == *$'\n'* ]]; then
        line="${rest%%$'\n'*}"; rest="${rest#*$'\n'}"; consumed=$((consumed + ${#line} + 1))
      else
        line="$rest"; rest=""; consumed=$((consumed + ${#line}))
      fi
      cmp="$line"
      if [[ "${HD_STRIPS[k]}" == "true" ]]; then
        while [[ "$cmp" == $'\t'* ]]; do cmp="${cmp#$'\t'}"; done
      fi
      [[ "$cmp" == "${HD_DELIMS[k]}" ]] && break
    done
  done
  MACF_SKIP_TO=$((consumed - 1))
  return 0
}

# Index of the ")" that closes the "(" at $2 in $1, skipping quoted text and
# nested parens; -1 when unbalanced. Result in MACF_MATCH.
macf_match_paren() {
  local s="$1" i="$2" n=${#1} pd=0 c q=""
  MACF_MATCH=-1
  while [[ $i -lt $n ]]; do
    c="${s:i:1}"
    if [[ "$q" == "s" ]]; then [[ "$c" == "'" ]] && q=""; i=$((i + 1)); continue; fi
    if [[ "$q" == "d" ]]; then
      if [[ "$c" == "\\" ]]; then i=$((i + 2)); continue; fi
      [[ "$c" == '"' ]] && q=""
      i=$((i + 1)); continue
    fi
    case "$c" in
      "'") q="s" ;;
      '"') q="d" ;;
      "\\") i=$((i + 1)) ;;
      '(') pd=$((pd + 1)) ;;
      ')') pd=$((pd - 1)); if [[ $pd -eq 0 ]]; then MACF_MATCH=$i; return 0; fi ;;
    esac
    i=$((i + 1))
  done
  return 0
}

macf_split_text() {
  local s="$1" depth="$2" n=${#1} i=0 c nx nx2 cur="" q="" j d strip mm
  local -a HD_DELIMS=() HD_STRIPS=()
  while [[ $i -lt $n ]]; do
    c="${s:i:1}"; nx="${s:i+1:1}"
    if [[ "$q" == "s" ]]; then
      cur+="$c"; [[ "$c" == "'" ]] && q=""
      i=$((i + 1)); continue
    fi
    if [[ "$q" == "d" && "$depth" -lt 4 ]]; then
      # Double quotes stop word splitting, not execution: check what $( ) and ` ` run.
      if [[ "$c" == '$' && "$nx" == '(' && "${s:i+2:1}" != '(' ]]; then
        macf_match_paren "$s" $((i + 1))
        # Save the offset first: the recursive split below reuses MACF_MATCH.
        mm=$MACF_MATCH
        if [[ "$mm" -gt $((i + 1)) ]]; then
          macf_split_text "${s:i+2:mm-i-2}" $((depth + 1))
          cur+="${s:i:mm-i+1}"; i=$((mm + 1)); continue
        fi
      fi
      if [[ "$c" == '`' ]]; then
        j=$((i + 1))
        while [[ $j -lt $n && "${s:j:1}" != '`' ]]; do
          [[ "${s:j:1}" == "\\" ]] && j=$((j + 1))
          j=$((j + 1))
        done
        if [[ $j -lt $n ]]; then
          macf_split_text "${s:i+1:j-i-1}" $((depth + 1))
          cur+="${s:i:j-i+1}"; i=$((j + 1)); continue
        fi
      fi
    fi
    if [[ "$q" == "a" || "$q" == "d" ]]; then
      if [[ "$c" == "\\" ]]; then
        # Inside double quotes a backslash-newline is a line continuation: drop both.
        if [[ "$q" == "d" && "$nx" == $'\n' ]]; then i=$((i + 2)); continue; fi
        cur+="$c$nx"; i=$((i + 2)); continue
      fi
      cur+="$c"
      if [[ "$q" == "a" && "$c" == "'" ]] || [[ "$q" == "d" && "$c" == '"' ]]; then q=""; fi
      i=$((i + 1)); continue
    fi
    case "$c" in
      "'") q="s"; cur+="$c" ;;
      '"') q="d"; cur+="$c" ;;
      '$')
        if [[ "$nx" == "'" ]]; then q="a"; cur+="$c$nx"; i=$((i + 1)); else cur+="$c"; fi ;;
      "\\")
        # A backslash-newline is a line continuation, not part of the command: drop both.
        if [[ "$nx" != $'\n' ]]; then cur+="$c$nx"; fi
        i=$((i + 1)) ;;
      '#')
        if [[ -z "$cur" || "${cur: -1}" == [[:space:]] ]]; then
          while [[ $i -lt $n && "${s:i:1}" != $'\n' ]]; do i=$((i + 1)); done
          continue
        fi
        cur+="$c" ;;
      '<')
        nx2="${s:i+2:1}"
        if [[ "$nx" == "<" && "$nx2" == "<" ]]; then
          # A here-string (<<<) is one operator; never read its tail as a heredoc opener.
          cur+="<<<"; i=$((i + 3)); continue
        fi
        if [[ "$nx" == "<" && "$nx2" != "<" ]]; then
          j=$((i + 2)); strip=false
          if [[ "${s:j:1}" == "-" ]]; then strip=true; j=$((j + 1)); fi
          while [[ "${s:j:1}" == " " || "${s:j:1}" == $'\t' ]]; do j=$((j + 1)); done
          d=""
          if [[ "${s:j:1}" == "'" || "${s:j:1}" == '"' ]]; then
            local qc="${s:j:1}"; j=$((j + 1))
            while [[ $j -lt $n && "${s:j:1}" != "$qc" ]]; do d+="${s:j:1}"; j=$((j + 1)); done
            j=$((j + 1))
          else
            [[ "${s:j:1}" == "\\" ]] && j=$((j + 1))
            while [[ $j -lt $n && "${s:j:1}" != [[:space:]\;\|\&\(\)\<\>] ]]; do d+="${s:j:1}"; j=$((j + 1)); done
          fi
          cur+="${s:i:j-i}"
          if [[ -n "$d" ]]; then HD_DELIMS+=("$d"); HD_STRIPS+=("$strip"); fi
          i=$j; continue
        fi
        cur+="$c" ;;
      '&')
        if [[ "${cur: -1}" == ">" || "${cur: -1}" == "<" || "$nx" == ">" ]]; then
          cur+="$c"
        else
          macf_collect_segment "$cur" "$depth"; cur=""
        fi ;;
      ';'|'|'|'('|')') macf_collect_segment "$cur" "$depth"; cur="" ;;
      $'\n')
        macf_collect_segment "$cur" "$depth"; cur=""
        if [[ ${#HD_DELIMS[@]} -gt 0 ]]; then
          macf_skip_heredoc_bodies "$s" "$i"
          i=$MACF_SKIP_TO
          HD_DELIMS=(); HD_STRIPS=()
        fi ;;
      *) cur+="$c" ;;
    esac
    i=$((i + 1))
  done
  macf_collect_segment "$cur" "$depth"
  return 0
}

macf_split_text "$COMMAND" 0

# Classify the commands the walk found. COMMENT_SEGS keeps each comment's own
# text so a comment chained after a create is judged on its own body.
IS_PR_CREATE=false
HAS_ISSUE_CREATE=false
IS_CLOSE_SUBCOMMAND=false
HAS_BODY_CMD=false
COMMENT_SEGS=()
ISSUE_CREATE_SEGS=()
PR_CREATE_SEGS=()
gh_cmd_re='^gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close|create)([[:space:]]|$)'
for eff in ${EFF_CMDS[@]+"${EFF_CMDS[@]}"}; do
  if [[ "$eff" =~ $gh_cmd_re ]]; then
    kind_sub="${BASH_REMATCH[1]}"
    kind_verb="${BASH_REMATCH[2]}"
    case "$kind_verb" in
      comment) HAS_BODY_CMD=true; COMMENT_SEGS+=("$eff") ;;
      create)
        HAS_BODY_CMD=true
        if [[ "$kind_sub" == "pr" ]]; then
          IS_PR_CREATE=true; PR_CREATE_SEGS+=("$eff")
        else
          HAS_ISSUE_CREATE=true; ISSUE_CREATE_SEGS+=("$eff")
        fi ;;
      close)
        # `close` without --comment posts no text — nothing to check.
        if [[ "$eff" =~ --comment ]]; then HAS_BODY_CMD=true; IS_CLOSE_SUBCOMMAND=true; fi ;;
    esac
  fi
done
if [[ "$HAS_BODY_CMD" != "true" ]]; then
  exit 0
fi

# Check A (must-have-mention; macf#244) does NOT apply to close subcommands —
# self-close verification comments are canonically no-recipient
# (reporter-internal verification per coordination.md §Issue Lifecycle 1
# case 2 self-close pattern: "Verified on main after PR #M merged.
# Closing as reporter."). The close action itself is the routing-end
# signal, not a routing-active comment requiring an addressed @mention.
# Check B (must-not-leak; describing-context) still applies on close
# subcommands — leak prevention is independent of recipient semantics.

# ── `create`-subcommand + assignee-label discriminator (macf#1091) ────────
# See the file-header "`create` coverage" section for the full 4-case
# rationale. Computed here (before the --body-file dispatch below) because
# the branch-3 warning also needs to know whether Check A applies.
# `gh pr create` is tracked separately from `gh issue create` because case 4
# ("no confirmed routing signal → BLOCK") does NOT extend to it — see the
# CHECK_A_APPLIES computation below for why.
IS_CREATE_SUBCOMMAND=false
if [[ "$IS_PR_CREATE" == "true" || "$HAS_ISSUE_CREATE" == "true" ]]; then
  IS_CREATE_SUBCOMMAND=true
fi

# Extracts every --label/-l VALUE (comma-split, one wrapping-quote layer
# stripped) from a gh command string. Prints one label per line. Single-
# token match only — assignee labels are always single hyphenated words in
# this framework (`code-agent`, `science-agent`, ...) — same simplifying
# assumption the --body-file extraction below already makes for its own
# no-embedded-space args. Mirrors macf_resolve_path_vars's match-advance
# loop shape (bounded by a guard counter, never `eval`).
macf_extract_labels() {
  local cmd="$1"
  # Leading `(^|[[:space:]])` boundary closes the glued-word collision:
  # without it, `-l` (the short form) matches inside an unrelated LONGER
  # flag name that happens to end in `-l<sep><token>` (e.g. `--tool-label
  # backlog`). It does NOT close — and cannot, without real shell-quote-
  # boundary awareness this whole-command-string scan doesn't have anywhere
  # in this file — the narrower case of genuine PROSE containing an
  # isolated, whitespace-bounded "-l <label>"/"--label <label>" sequence
  # (e.g. a body discussing this very flag). That residual is a documented,
  # accepted trade-off, same class as every other whole-command-scan
  # imprecision in this hook (the --body-file / --title extraction below
  # has the identical limitation) — flagged here rather than silently
  # assumed closed.
  local pattern='(^|[[:space:]])(--label|-l)(=|[[:space:]]+)([^[:space:]]+)'
  local rest="$cmd" guard=0
  while [[ "$rest" =~ $pattern ]] && [[ "$guard" -lt 50 ]]; do
    guard=$((guard + 1))
    local raw="${BASH_REMATCH[4]}"
    raw="${raw%\"}"; raw="${raw#\"}"
    raw="${raw%\'}"; raw="${raw#\'}"
    local whole="${BASH_REMATCH[0]}"
    local prefix="${rest%%"$whole"*}"
    local -a toks=()
    IFS=',' read -r -a toks <<<"$raw"
    local tok
    for tok in "${toks[@]}"; do
      [[ -n "$tok" ]] && printf '%s\n' "$tok"
    done
    rest="${rest#"${prefix}${whole}"}"
  done
}

# Four cases (the operator's final ruling — DECLARED, not inferred, is the
# binding constraint; see the file-header "`create` coverage" section):
#   1. `backlog` label present                       → ALLOW (declared: for later, nobody's queue)
#   2. assignee label naming ANOTHER agent (confirmed)→ ALLOW (route-by-label delivers it)
#   3. assignee label naming the ACTING agent itself  → BLOCK (route-by-label is a no-op)
#   4. anything else (no labels; unrecognized labels; can't confirm 2 vs 3) → BLOCK (ambiguous)
# Only case 2 is a CONFIRMED allow: it requires BOTH the routing-label
# registry to resolve the label as real for this repo AND $MACF_ROUTING_LABEL
# to be known and different from it. Every state the hook can't positively
# resolve to case 1 or case 2 blocks — ambiguity defaults to BLOCK, not
# ALLOW, per the operator's ruling.
# Judged for one create segment at a time ($1), so one create's labels never
# vouch for another create in the same command.
macf_eval_labels() {
  local text="$1"
  CREATE_HAS_BACKLOG_LABEL=false
  CREATE_CONFIRMED_PEER_LABEL=false
  CREATE_CONFIRMED_SELF_LABEL=false
  CREATE_MATCHED_LABELS=""
  if true; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
  if [[ -z "$PROJECT_DIR" ]]; then
    PROJECT_DIR="$(jq -r '.cwd // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
  fi
  AGENT_CONFIG_PATH="${PROJECT_DIR:+$PROJECT_DIR/.github/agent-config.json}"
  ROUTING_LABELS=()
  REGISTRY_READABLE=false
  # The target repo is this workspace's own unless --repo/-R names another
  # one; the registry read below belongs to this workspace's repo only.
  TARGET_IS_OWN=true
  repo_re='(^|[[:space:]])(--repo|-R)(=|[[:space:]]+)([^[:space:]]+)'
  if [[ "$text" =~ $repo_re ]]; then
    target_repo="${BASH_REMATCH[4]}"
    target_repo="${target_repo%\"}"; target_repo="${target_repo#\"}"
    target_repo="${target_repo%\'}"; target_repo="${target_repo#\'}"
    origin_url=""
    if [[ -n "$PROJECT_DIR" ]]; then
      origin_url="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
    fi
    origin_url="${origin_url%.git}"
    origin_name="${origin_url##*[:/]}"
    origin_rest="${origin_url%/*}"
    origin_repo="${origin_rest##*[:/]}/$origin_name"
    lower_target="$(printf '%s' "$target_repo" | tr '[:upper:]' '[:lower:]')"
    lower_origin="$(printf '%s' "$origin_repo" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$origin_url" ]] || [[ "$lower_target" != "$lower_origin" ]]; then
      TARGET_IS_OWN=false
    fi
  fi
  if [[ -n "$AGENT_CONFIG_PATH" ]] && [[ -f "$AGENT_CONFIG_PATH" ]] && [[ -r "$AGENT_CONFIG_PATH" ]]; then
    REGISTRY_READABLE=true
    # Registry keys = this fleet's actual routing labels (repo-specific;
    # never hardcoded — see repo-init.ts, the file's writer, and the
    # router that reads it the same way).
    while IFS= read -r rl; do
      [[ -n "$rl" ]] && ROUTING_LABELS+=("$rl")
    done < <(jq -r '.agents // {} | keys[]?' "$AGENT_CONFIG_PATH" 2>/dev/null || true)
  fi

  # Collect into an array first (rather than testing membership inline)
  # so `"${EXTRACTED_LABELS[@]}"` / `"${ROUTING_LABELS[@]}"` can each be
  # guarded by a `${#arr[@]} -gt 0` check before expansion — an empty-array
  # expansion under `set -u` is an unbound-variable error on older bash
  # (pre-4.4 — macOS's shipped /bin/bash is 3.2), so this script never
  # expands `"${arr[@]}"` without that guard anywhere.
  EXTRACTED_LABELS=()
  while IFS= read -r tok; do
    [[ -n "$tok" ]] && EXTRACTED_LABELS+=("$tok")
  done < <(macf_extract_labels "$text")

  if [[ "${#EXTRACTED_LABELS[@]}" -gt 0 ]]; then
    # `backlog` detection is registry-independent — it's a fixed literal
    # this framework's repo-init always creates, not a per-fleet routing
    # label, so it needs no lookup to recognize.
    for tok in "${EXTRACTED_LABELS[@]}"; do
      [[ "$tok" == "backlog" ]] && CREATE_HAS_BACKLOG_LABEL=true
    done

    # The self check needs no registry: if your own label is the only one
    # that could name an agent, the router skips it and nobody else is named.
    # Another label could be an agent's unless a registry that covers this
    # repo proves it is not; without that proof, warn rather than block.
    if [[ -n "${MACF_ROUTING_LABEL:-}" ]]; then
      self_present=false
      other_agentish=false
      for tok in "${EXTRACTED_LABELS[@]}"; do
        if [[ "$tok" == "${MACF_ROUTING_LABEL}" ]]; then
          self_present=true
        elif [[ "$tok" != "backlog" ]]; then
          if [[ "$REGISTRY_READABLE" == "true" ]] && [[ "$TARGET_IS_OWN" == "true" ]]; then
            for rl in ${ROUTING_LABELS[@]+"${ROUTING_LABELS[@]}"}; do
              [[ "$tok" == "$rl" ]] && other_agentish=true
            done
          else
            other_agentish=true
          fi
        fi
      done
      if [[ "$self_present" == "true" ]] && [[ "$other_agentish" == "false" ]]; then
        CREATE_CONFIRMED_SELF_LABEL=true
      fi
    fi

    if [[ "${#ROUTING_LABELS[@]}" -gt 0 ]]; then
      for tok in "${EXTRACTED_LABELS[@]}"; do
        for rl in "${ROUTING_LABELS[@]}"; do
          if [[ "$tok" == "$rl" ]]; then
            CREATE_MATCHED_LABELS+="${CREATE_MATCHED_LABELS:+, }$tok"
            if [[ -n "${MACF_ROUTING_LABEL:-}" ]] && [[ "$tok" != "${MACF_ROUTING_LABEL}" ]] && [[ "$TARGET_IS_OWN" == "true" ]]; then
              CREATE_CONFIRMED_PEER_LABEL=true
            fi
            # $MACF_ROUTING_LABEL unset: a real assignee label matched, but
            # self vs. peer can't be confirmed either way — falls through
            # to case 4 (ambiguous → block) below, same as an unrecognized
            # label would.
          fi
        done
      done
    fi
  fi
  fi
}

# CHECK_A_APPLIES replaces the old close-only gate on the must-have-mention
# check (macf#244): close subcommands never require one (self-close verify
# is reporter-internal — see IS_CLOSE_SUBCOMMAND above); a `create` requires
# one in cases 3 and 4 (see above); every other subcommand this hook guards
# (comment) is unchanged — always applies.
CHECK_A_APPLIES=false
ISSUE_CREATE_WARNING=""
# The model never sees stderr on exit 0, so an allow-with-warning goes out
# as additionalContext JSON on stdout when the hook exits 0.
macf_emit_warning() {
  local rc=$?
  if [[ "$rc" -eq 0 ]] && [[ -n "$ISSUE_CREATE_WARNING" ]]; then
    jq -n --arg ctx "$ISSUE_CREATE_WARNING" \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: $ctx}}'
  fi
}
trap macf_emit_warning EXIT

# Each create is judged on its own labels; a close or a comment elsewhere in
# the command never exempts it.
macf_judge_issue_create() {
  local seg="$1" tok joined="" reason="" unrouted=false note
  macf_eval_labels "$seg"
  # A new issue routes only by its label (route-by-label); a mention in its
  # body is never delivered. Unless the label is `backlog` or confirmed for
  # another agent, the issue reaches no one, with or without a mention.
  [[ "$CREATE_HAS_BACKLOG_LABEL" == "true" || "$CREATE_CONFIRMED_PEER_LABEL" == "true" ]] && return 0
  # Block only what the hook can prove undeliverable: no label, a confirmed
  # self-label, or a readable registry for this repo with no other agent's
  # label. A label it cannot confirm is allowed with a warning, because the
  # router reads the target repo's registry.
  for tok in ${EXTRACTED_LABELS[@]+"${EXTRACTED_LABELS[@]}"}; do
    [[ -n "${MACF_ROUTING_LABEL:-}" ]] && [[ "$tok" == "${MACF_ROUTING_LABEL}" ]] && continue
    joined+="${joined:+, }$tok"
  done
  if [[ "${#EXTRACTED_LABELS[@]}" -eq 0 ]] || [[ "$CREATE_CONFIRMED_SELF_LABEL" == "true" ]]; then
    unrouted=true
  elif [[ "$REGISTRY_READABLE" != "true" ]]; then
    reason="no .github/agent-config.json in this workspace"
  elif [[ -z "${MACF_ROUTING_LABEL:-}" ]] && [[ -n "$CREATE_MATCHED_LABELS" ]]; then
    reason="MACF_ROUTING_LABEL is unset"
  elif [[ "$TARGET_IS_OWN" != "true" ]]; then
    reason="--repo is not this workspace's repo"
  else
    unrouted=true
  fi
  if [[ -n "$reason" ]]; then
    ISSUE_CREATE_WARNING="The hook could not confirm that any of these labels belongs to another agent: $joined ($reason). If one of them is another agent's label in the target repo, the router delivers the issue. If none is, add one with gh issue edit <N> --add-label <label>; adding a label after the issue exists still routes it."
  fi
  [[ "$unrouted" == "true" ]] || return 0
  if [[ "$CREATE_CONFIRMED_SELF_LABEL" == "true" ]]; then
    note="The router skips a label applied by the agent it names, so this issue reaches no one."
  else
    note="A new issue is routed only by its label, and this one has no label for another agent."
  fi
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: $note
A mention in a new issue's body is never delivered, because the router reads mentions only on comments and pull requests.

Create it with a label for the agent who should act, or the "backlog" label
if it is for later. To ping someone, post a comment with a mention after the
issue exists.

The override (MACF_SKIP_MENTION_CHECK=1) is operator-only and set at launch.
ERR
  exit 2
}
for seg in ${ISSUE_CREATE_SEGS[@]+"${ISSUE_CREATE_SEGS[@]}"}; do
  macf_judge_issue_create "$seg"
done

# A PR body mention does route (pull_request event), so a PR create needs one
# only when its own label proves the label alone reaches no one. Case 4 does
# not extend to a PR: an unlabeled `--body "Refs #N"` is the canonical PR
# call, its routing signal is the review state, and blocking it cannot be
# recovered mid-session.
PR_SELF_LABEL=false
for seg in ${PR_CREATE_SEGS[@]+"${PR_CREATE_SEGS[@]}"}; do
  macf_eval_labels "$seg"
  if [[ "$CREATE_HAS_BACKLOG_LABEL" != "true" ]] && [[ "$CREATE_CONFIRMED_SELF_LABEL" == "true" ]]; then
    CHECK_A_APPLIES=true; PR_SELF_LABEL=true
  fi
done
# A lone comment needs a mention in its text. Beside a create or a close, each
# comment is checked on its own body by the chained-comment loop below.
if [[ "${#COMMENT_SEGS[@]}" -gt 0 ]] && [[ "$IS_CREATE_SUBCOMMAND" != "true" ]] && [[ "$IS_CLOSE_SUBCOMMAND" != "true" ]]; then
  CHECK_A_APPLIES=true
fi
CREATE_CONFIRMED_SELF_LABEL="$PR_SELF_LABEL"

# --body-file handling (groundnuty/macf#944).
#
# The ORIGINAL exemption here unconditionally `exit 0`d for ANY
# `--body-file` invocation — the form `pr-discipline.md` explicitly
# recommends for review/comment bodies AND the write-then-post /
# write-and-post patterns. That blanket exemption silently skipped BOTH
# Check A and Check B for every `--body-file` call, including bodies with
# zero mentions (Check A's exact failure mode) or describing-context leaks
# (Check B's). Fixed per the #944 ruling: resolve the actual body content
# where possible and lint IT; only fall back to a non-blocking warning
# (Check A) / today's silent allow (Check B) when content genuinely can't
# be resolved.
#
# Three branches, in order:
#   1. `--body-file <path>` and the file is READABLE right now → lint the
#      file's actual content (both checks). Covers the two-call
#      write-then-post pattern (a prior tool call already wrote the file).
#   2. Not readable, but $COMMAND contains a heredoc whose redirect TARGET
#      is exactly the --body-file path, with a QUOTED delimiter → extract
#      the heredoc BODY TEXT (not evaluated — see the Instance-12 note
#      below) and lint THAT. Covers the single-call write-and-post pattern
#      (`cat > f <<'EOF' … EOF; gh … --body-file f` in one Bash call),
#      where PreToolUse fires before the file exists on disk.
#   3. Neither resolvable → Check A WARNS on stderr (non-blocking); Check B
#      keeps the pre-#944 silent allow (nothing lintable, same as before).
#
# --- Distinguishing branch 2 from silent-fallback Instance 12's
# decided-against (silent-fallback-hazards.md) ---
# Instance 12 records a *decided-against*: teaching a PreToolUse hook to
# parse inline shell, because doing so would require EVALUATING shell (the
# value there came from a command substitution `$(...)`, whose result
# can't be known without running it). Branch 2 here is a different
# operation: it only SLICES literal text between two known delimiters out
# of the already-available command STRING. A `<<'EOF'` heredoc body is
# unexpanded BY DEFINITION — the quoted delimiter is exactly what tells
# the real shell "don't touch this text" — so no variable substitution,
# command substitution, or globbing happens to it before it lands in the
# target file. The text sitting between the heredoc-open line and its
# closing delimiter line IN THE COMMAND STRING *is* the exact body that
# will land in the file: reading it off the string is text extraction, not
# shell evaluation. An UNQUOTED `<<EOF` does not carry this guarantee (its
# body undergoes expansion), which is exactly why branch 2 refuses to
# treat an unquoted delimiter as safe — it falls through to branch 3
# instead of guessing.

# --- Helpers -----------------------------------------------------------

# Bounded path-variable resolution for --body-file paths (branch 1).
# Expands a leading `~` to $HOME and any $VAR / ${VAR} references using
# bash's OWN indirect parameter expansion (${!name}) against variables
# already present in THIS hook process's environment — text substitution,
# never `eval` or a subshell. A reference to a variable this process
# doesn't have expands to empty string (same as unset-variable semantics),
# which naturally fails the subsequent readability check rather than
# guessing.
macf_resolve_path_vars() {
  local raw="$1"
  local resolved="$raw"
  # shellcheck disable=SC2088  # intentional: comparing a string's literal
  # leading chars against "~"/"~/" here, not asking the shell to expand a
  # tilde inside a quoted string. The manual $HOME substitution below IS
  # the expansion.
  if [[ "$resolved" == "~" || "$resolved" == "~/"* ]]; then
    resolved="${HOME:-}${resolved:1}"
  fi
  local out="" rest="$resolved" guard=0
  while [[ "$rest" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]] && [[ "$guard" -lt 20 ]]; do
    guard=$((guard + 1))
    local varname="${BASH_REMATCH[1]}"
    local whole="${BASH_REMATCH[0]}"
    local prefix="${rest%%"$whole"*}"
    out+="${prefix}${!varname:-}"
    rest="${rest#"${prefix}${whole}"}"
  done
  out+="$rest"
  printf '%s' "$out"
}

# Literal heredoc-body extraction for --body-file paths (branch 2). Slices
# TEXT out of the command string — never evaluates shell (see the
# Instance-12 distinguishing note above). Matching is done via plain
# substring containment (bash treats a quoted portion of a `[[ ]]` glob
# pattern as literal), so no path-to-regex escaping is needed anywhere.
#
# Contract: prints the extracted body and returns 0 on an UNAMBIGUOUS,
# quoted-delimiter match; prints nothing and returns 1 on anything else —
# no candidate line, more than one candidate line, or an unquoted
# delimiter. Every failure mode here falls through to branch 3; this
# function never guesses.
macf_extract_heredoc_body() {
  local target="$1" cmd="$2"
  if [[ -z "$target" ]]; then
    return 1
  fi

  local heredoc_open_sq_pattern="^-?[[:space:]]*'([A-Za-z_][A-Za-z0-9_]*)'"
  local heredoc_open_dq_pattern='^-?[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)"'

  local -a lines=()
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    lines+=("$line")
  done <<<"$cmd"

  local match_idx=-1 match_count=0 delimiter="" strip_tabs=false
  local i=0
  while [[ "$i" -lt "${#lines[@]}" ]]; do
    line="${lines[$i]}"
    if [[ "$line" == *">"* ]] && [[ "$line" == *"$target"* ]] && [[ "$line" == *"<<"* ]]; then
      local frag="${line#*<<}"
      if [[ "$frag" =~ $heredoc_open_sq_pattern ]] || [[ "$frag" =~ $heredoc_open_dq_pattern ]]; then
        match_count=$((match_count + 1))
        delimiter="${BASH_REMATCH[1]}"
        match_idx="$i"
        if [[ "$frag" == "-"* ]]; then strip_tabs=true; else strip_tabs=false; fi
      else
        # Candidate line targets our path but has no safely-literal
        # (quoted) delimiter — unsafe to treat as this heredoc's body.
        # Still counts toward ambiguity so a second, quoted-looking match
        # elsewhere doesn't win by default (fail closed, not a guess).
        match_count=$((match_count + 1))
        delimiter=""
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$match_count" -ne 1 ]] || [[ -z "$delimiter" ]] || [[ "$match_idx" -lt 0 ]]; then
    return 1
  fi

  local body="" found_close=false
  i=$((match_idx + 1))
  while [[ "$i" -lt "${#lines[@]}" ]]; do
    line="${lines[$i]}"
    local cmp_line="$line"
    if [[ "$strip_tabs" == "true" ]]; then
      while [[ "$cmp_line" == $'\t'* ]]; do
        cmp_line="${cmp_line#$'\t'}"
      done
    fi
    if [[ "$cmp_line" == "$delimiter" ]]; then
      found_close=true
      break
    fi
    body+="${line}"$'\n'
    i=$((i + 1))
  done

  if [[ "$found_close" == "false" ]]; then
    return 1
  fi

  printf '%s' "$body" || true
  return 0
}

HANDLE_PATTERN='@[a-zA-Z][a-zA-Z0-9_-]*[[]bot[]]'

# --- Chained comments: each is judged against its own body -----------------
# Counts routing-active mentions (not backticked) in the text on stdin.
macf_count_active() {
  awk -v pat="$HANDLE_PATTERN" '
    { l = $0; a = 0
      while (match(l, pat)) {
        s = a + RSTART; b = (s > 1) ? substr($0, s - 1, 1) : ""; c = substr($0, s + RLENGTH, 1)
        if (!(b == "`" && c == "`")) n++
        l = substr(l, RSTART + RLENGTH); a = s + RLENGTH - 1
      } }
    END { print n + 0 }'
}

# Prints the mention count of one chained comment's own body: its --body-file
# (readable now, or a quoted heredoc in this command) or else its own text.
# Prints nothing when its file cannot be resolved.
macf_chain_segment_count() {
  local seg="$1" re='--body-file(=|[[:space:]]+)([^[:space:]]+)' raw path body
  if [[ "$seg" =~ $re ]]; then
    raw="${BASH_REMATCH[2]}"
    raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
    path="$(macf_resolve_path_vars "$raw")"
    if [[ -n "$path" ]] && [[ -f "$path" ]] && [[ -r "$path" ]]; then
      macf_count_active <"$path"
    elif body="$(macf_extract_heredoc_body "$raw" "$COMMAND")"; then
      macf_count_active <<<"$body"
    fi
    return 0
  fi
  macf_count_active <<<"$seg"
}

if [[ "$IS_CREATE_SUBCOMMAND" == "true" || "$IS_CLOSE_SUBCOMMAND" == "true" ]]; then
  for seg in ${COMMENT_SEGS[@]+"${COMMENT_SEGS[@]}"}; do
    seg_count="$(macf_chain_segment_count "$seg")"
    if [[ "$seg_count" == "0" ]]; then
      cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: A comment chained after the create has no mention. Each chained comment needs its own mention of whoever should read it; neither the create nor the other comments cover it.

Add a line starting with the recipient's handle to that comment's body:
  @<recipient-handle>[bot] <your message>

The override (MACF_SKIP_MENTION_CHECK=1) is operator-only and set at launch.
ERR
      exit 2
    fi
  done
fi

# --- Three-branch dispatch ----------------------------------------------

BODY_FILE_MODE=false
BODY_FILE_RESOLVED=false
LINT_TARGET="$COMMAND"

BODY_FILE_ARG_PATTERN='--body-file(=|[[:space:]]+)([^[:space:]]+)'
if [[ "$COMMAND" =~ $BODY_FILE_ARG_PATTERN ]]; then
  BODY_FILE_MODE=true
  BODY_FILE_RAW="${BASH_REMATCH[2]}"
  # Strip one layer of matching wrapping quotes (only the common
  # no-embedded-space quoted case; quoted paths WITH spaces aren't
  # captured by [^[:space:]]+ above and fall through to branch 3 —
  # fail-safe, never a wrong-answer risk).
  if [[ "$BODY_FILE_RAW" == \"*\" ]] && [[ "$BODY_FILE_RAW" == *\" ]]; then
    BODY_FILE_RAW="${BODY_FILE_RAW:1:-1}"
  elif [[ "$BODY_FILE_RAW" == \'*\' ]] && [[ "$BODY_FILE_RAW" == *\' ]]; then
    BODY_FILE_RAW="${BODY_FILE_RAW:1:-1}"
  fi

  # Branch 1: readable file right now.
  RESOLVED_BODY_FILE_PATH="$(macf_resolve_path_vars "$BODY_FILE_RAW")"
  if [[ -n "$RESOLVED_BODY_FILE_PATH" ]] \
     && [[ -f "$RESOLVED_BODY_FILE_PATH" ]] \
     && [[ -r "$RESOLVED_BODY_FILE_PATH" ]]; then
    LINT_TARGET="$(cat -- "$RESOLVED_BODY_FILE_PATH" 2>/dev/null || true)"
    BODY_FILE_RESOLVED=true
  fi

  # Branch 2: literal heredoc targeting the same path.
  if [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
    if HEREDOC_BODY="$(macf_extract_heredoc_body "$BODY_FILE_RAW" "$COMMAND")"; then
      LINT_TARGET="$HEREDOC_BODY"
      BODY_FILE_RESOLVED=true
    fi
  fi
fi

# Branch 3: neither resolvable.
if [[ "$BODY_FILE_MODE" == "true" ]] && [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
  # Check B: nothing lintable — same silent allow as pre-#944 (no leak
  # check possible without content; operator discipline covers the gap).
  # Check A: WARN (do not block) — unlike Check B, a missing mention is
  # the exact silent-failure shape coordination.md §Communication 1 warns
  # about, so make the gap visible even though we can't prove it either
  # way. Bypassed wherever Check A itself doesn't apply — close
  # subcommands (see IS_CLOSE_SUBCOMMAND above), and `create` cases 1/2
  # (see CHECK_A_APPLIES above, macf#1091).
  if [[ "$CHECK_A_APPLIES" == "true" ]]; then
    cat >&2 <<WARNERR
WARNING (non-blocking) from MACF mention-routing-hygiene hook: this command
uses --body-file "$BODY_FILE_RAW" and the hook could not resolve its
content — the file isn't readable yet AND no literal (quoted-delimiter)
heredoc in this command targets that same path. The hook cannot verify
this comment carries a routing-active @<bot>[bot] mention
(coordination.md §Communication 1) or is free of a describing-context leak
(mention-routing-hygiene.md, "Addressing and describing").

Proceeding WITHOUT blocking (groundnuty/macf#944 branch 3) — double-check
the file content manually before it posts.
WARNERR
  fi
  exit 0
fi

# Per-occurrence scan for raw @macf-<role>-agent[bot] patterns in the lint
# target (LINT_TARGET — the command string for a plain `--body`/`--comment`
# invocation, or the resolved --body-file content per the dispatch above
# for branches 1/2; branch 3 exits before reaching this scan at all — see
# groundnuty/macf#944). Heuristic per groundnuty/macf#272 design synthesis:
#   - Already wrapped in backticks (`@bot[bot]`) → allowed (describing form §5)
#   - At line start (only whitespace, blockquote `>`, or list markers
#     `* ` `- ` `1. ` before it on the same line) → allowed (addressing
#     form §3 — typical PR-closing-line / handoff / escalation shape)
#   - Otherwise → BLOCK as describing-context leak
#
# False-positive trade-off: single-line bodies with the addressing form
# right after `--body "` (no preceding newline) are flagged. The canonical
# rule's examples (§3) all show addressing on its own line, so this
# matches the expected idiom. Override available for rare exceptions.
#
# False-negative trade-off: line-start mentions that are actually
# describing-with-bot-as-subject ("@bot's response was clean" — line
# starts with the handle but the sentence is descriptive) pass through.
# This is rare in practice; canonical idiom puts describing references
# inside prose, not at line-start. Operator discipline catches the residual.
# awk regex: `[[]` and `[]]` express literal `[` and `]` in a char class
# context (awk's `\[` escape would either warn-and-strip or be ambiguous
# across awk variants).
#
# Pattern scope (broadened per macf#276): matches ANY `@<handle>[bot]`
# rather than only `@macf-*-agent[bot]`. First char must be a letter
# (excludes leading digit/underscore/hyphen forms which aren't valid
# GitHub handles anyway); body accepts alphanumeric / underscore /
# hyphen so digit-suffixed and multi-segment handles match.
#
# Covers: macf-* fleet (`macf-code-agent`, `macf-science-agent`,
# `macf-tester-N-agent`, `macf-devops-agent`); future CV fleet
# (`cv-architect`, `academic-resume-author`, similar shapes); future
# MACF-consumer fleets that may not follow the `macf-*-agent` naming
# convention; AND third-party bots (`dependabot`, `github-actions`).
# Third-party bots don't fire MACF routing (not in agent registry),
# but blocking their describing-context use is consistent style — and
# operators can use `MACF_SKIP_MENTION_CHECK=1` for the rare legitimate
# describing reference. The cost of generalization is small; the
# benefit (fleet-agnostic protection) is durable.

# Single AWK pass produces TWO outputs (line-prefix-discriminated):
#   - `LEAK:<line_no>: <line>` — describing-context leaks (Check B,
#     groundnuty/macf#272). Reported once per offending line.
#   - `ACTIVE_COUNT:<n>` — total routing-active @mentions across the
#     entire body (Check A, groundnuty/macf#244). Routing-active =
#     NOT wrapped in backticks. Both line-start addressing AND mid-line
#     describing-leaks are routing-active; only the backticked form is
#     routing-suppressed. If this count is 0, the comment has no
#     recipient — Check A blocks.
AWK_OUTPUT="$(awk -v pat="$HANDLE_PATTERN" '
  BEGIN { active_count = 0 }
  {
    # Track which lines we have already reported a leak for, so a line
    # with multiple offenders surfaces once (existing Check B behavior
    # — preserved verbatim across the Check A extension).
    line_already_reported = 0

    # Process every match on this line. After each match, advance the
    # search-substring past it (RSTART+RLENGTH from the original line $0
    # tracked via abs_offset).
    abs_offset = 0
    line = $0
    while ( match(line, pat) ) {
      abs_start = abs_offset + RSTART
      abs_end = abs_start + RLENGTH

      # Surrounding chars from the ORIGINAL line $0
      char_before = (abs_start - 1 >= 1) ? substr($0, abs_start - 1, 1) : ""
      char_after = substr($0, abs_end, 1)

      # Already-backticked? Allowed describing form (§5). Routing-suppressed
      # — does NOT count toward Check A active-mention total.
      if (char_before == "`" && char_after == "`") {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Routing-active (NOT backticked). Counts toward Check A regardless
      # of position (line-start addressing AND mid-line describing both
      # fire routing — the backtick suppression is the only routing-mute).
      active_count++

      # Line-start (after optional whitespace, blockquote, or list-item
      # markers)? Allowed addressing form (§3) — Check B passes; Check A
      # already incremented above.
      prefix = substr($0, 1, abs_start - 1)
      if (prefix ~ /^[[:space:]>]*([0-9]+\.[[:space:]]+|[-*][[:space:]]+)?$/) {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Mid-line raw mention — describing-context leak (Check B BLOCK).
      # Report once per line; counter still increments for additional
      # matches on the same line so Check A sees the complete picture.
      if (!line_already_reported) {
        print "LEAK:" NR ": " $0
        line_already_reported = 1
      }
      line = substr(line, RSTART + RLENGTH)
      abs_offset = abs_start + RLENGTH - 1
    }
  }
  END { print "ACTIVE_COUNT:" active_count }
' <<<"$LINT_TARGET")"

# `grep` returns 1 when no matches; under `set -euo pipefail` that
# propagates as the script's exit code without `|| true`. The Check A
# happy-path (no leaks) needs OFFENDING to be empty without the hook
# itself dying — the explicit fall-through is required.
OFFENDING="$(grep '^LEAK:' <<<"$AWK_OUTPUT" | sed 's/^LEAK://' || true)"
ACTIVE_COUNT="$(grep '^ACTIVE_COUNT:' <<<"$AWK_OUTPUT" | sed 's/^ACTIVE_COUNT://' || true)"

if [[ -n "$OFFENDING" ]]; then
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: this comment/issue/PR body
contains raw @<bot>[bot] mention(s) in describing-context (mid-line, not
backticked) which would fire false-positive routing per
mention-routing-hygiene.md, "Addressing and describing".

Offending line(s) within the command:
$OFFENDING

Fix per the canonical rule — wrap describing-context mentions in backticks:
  Wrong:  @macf-tester-2-agent[bot] response quoted coordination.md ...
  Right:  \`@macf-tester-2-agent[bot]\` response quoted coordination.md ...

Or use one of the equivalent suppression forms (§5):
  - Backticks:  \`@macf-tester-2-agent[bot]\`   (preferred — semantic markup)
  - Escapes:    \\@macf-tester-2-agent\\[bot\\]
  - Label form: "tester-2" or "the tester-2 agent"

Addressing form (line-start, expected to fire routing) is allowed:
  @macf-science-agent[bot] PR ready for review.

Override (ONLY for legitimate raw-mention cases the heuristic catches) is
launch-time / operator only: MACF_SKIP_MENTION_CHECK is read from THIS
session's process env, fixed when ./claude.sh launched it. An in-session
\`export MACF_SKIP_MENTION_CHECK=1\` from a Bash tool call does NOT reach
it — Bash-tool commands run in a separate subshell that never persists
into the session's env. To use it: set MACF_SKIP_MENTION_CHECK=1 in the
launch env (or the workspace's .claude/.macf/env.* files) BEFORE running
./claude.sh, then relaunch. Need it mid-session? Ask the operator to set
it + relaunch, or route the specific comment through the operator directly.

Refs: groundnuty/macf#244, #272 (this hook); mention-routing-hygiene.md
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

# Check A (groundnuty/macf#244): must-have-mention. Comment-emit commands
# must contain at least one routing-active @<bot>[bot] mention. Without
# one, the comment is "invisible" to other agents — coordination.md
# §Communication 1 names this as the silent-failure mode.
#
# Bypassed for `gh (issue|pr) close --comment` — self-close verification
# comments are canonically no-recipient (reporter-internal). The close
# action itself signals routing-end; no addressed mention required.
#
# Bypassed for `create` cases 1/2 (backlog label; label confirmed naming
# another agent) — CHECK_A_APPLIES already folds those in. Fires for
# `create` case 3 (self-labeled) and case 4 (no confirmed routing signal —
# no labels, unrecognized labels, or a label the hook can't confirm is
# self vs. peer). The two messages below are what make the fix obvious to
# the agent: plain remedies, no internal citations — this text is
# user-facing (macf#1061's rule for CLI output applies here too, even
# though the automated guard for it doesn't currently scan shell scripts).
if [[ "$CHECK_A_APPLIES" == "true" ]] && [[ "$ACTIVE_COUNT" == "0" ]]; then
  CREATE_NOTE=""
  if [[ "$IS_CREATE_SUBCOMMAND" == "true" ]] && [[ "$CREATE_CONFIRMED_SELF_LABEL" == "true" ]]; then
    CREATE_NOTE="
A label on a pull request does not route; only a mention in its body or in a comment does. Add a mention for whoever should read it."
  fi
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: this comment/issue/PR body has
zero routing-active @<bot>[bot] mentions. Per coordination.md §Communication 1:

  "Put an @mention in every comment, because routing depends on it. A
  comment that only closes your own issue needs none."

Without a routing-active mention, the content is silently invisible to
peer agents — they have no notification that you posted, even if the
issue/PR is on their assigned-label queue.
$CREATE_NOTE

Fix: add an addressing mention naming the recipient:
  @<recipient-handle>[bot] <your message>

Examples (where <recipient> is the issue reporter, PR reviewer, etc.):
  @macf-science-agent[bot] PR #N ready for review.
  @macf-code-agent[bot] LGTM, you can merge.

Override (ONLY for legitimate no-recipient cases — rare; status posts
on self-filed-self-closed issues, or test-orchestration scratch comments)
is launch-time / operator only: MACF_SKIP_MENTION_CHECK is read from THIS
session's process env, fixed when ./claude.sh launched it. An in-session
\`export MACF_SKIP_MENTION_CHECK=1\` from a Bash tool call does NOT reach
it — Bash-tool commands run in a separate subshell that never persists
into the session's env. To use it: set MACF_SKIP_MENTION_CHECK=1 in the
launch env (or the workspace's .claude/.macf/env.* files) BEFORE running
./claude.sh, then relaunch. Need it mid-session? Ask the operator to set
it + relaunch, or route the specific comment through the operator directly.

Refs: groundnuty/macf#244 (this check); coordination.md §Communication 1
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

exit 0
