#!/usr/bin/env bash
#
# check-close-condition-create.sh — Claude Code PreToolUse hook
# (groundnuty/macf#1248) that grades an issue's closing condition at the
# moment it is WRITTEN, the create-time sibling of check-close-condition.sh
# (#1231/#1247, which surfaces the condition at CLOSE time).
#
# WHY: `#1248` frames this as the opposite-direction failure mode from the
# same remedy. `#1245` — "the next E2E run is green" — was MET BY LUCK: a
# false CLOSE, because an unrelated green run satisfies it while the bug
# survives. `#1170` — "a fresh session surfaces it unprompted" — was UNMET
# BY LUCK: an indefinite OPEN, because non-appearance from a capped, ranked
# sweep is the *expected* outcome, not evidence the condition failed. Both
# are luck-satisfiable conditions; the remedy for both is grading the
# condition when it is WRITTEN, not only when it is invoked at close. The
# three grading criteria (from science's #1248 ruling):
#
#   1. observable                     — can someone else check it, unprompted?
#   2. satisfiable only by the repair — luck cannot satisfy it        (#1245)
#   3. falsifiable when unmet         — non-appearance is evidence     (#1170)
#
# WHAT IT DOES NOT DO: it does not decide whether a stated condition passes
# any of the three criteria. It detects THAT a closing condition was stated
# (same extraction heuristic as check-close-condition.sh: a `## Closure
# condition` / `## Closing condition` heading section, falling back to a
# bare `[Cc]loses when …` line) and echoes it back alongside the three
# criteria, unconditionally, for the author to self-grade. Per #1248's own
# acceptance criteria: "it must not adjudicate. Grading prose is a
# judgement; a hook that guesses gets overridden into silence." An issue
# with NO stated closing condition passes with NO output at all — most
# issues have none, and printing something on every `gh issue create`
# would train the override reflex on the common case (#1248: "no stated
# condition → silent pass").
#
# WARN-ONLY, NOT BLOCK (same posture as #1247, for the same reason): this
# hook ALWAYS allows the create. Its only job is making sure the three
# criteria were put on screen, once, at the moment the condition was
# written — not deciding whether the condition is any good.
#
# HOW IT SURFACES THE CRITERIA: same mechanism as check-close-condition.sh
# — plain stdout/stderr on an ALLOWING PreToolUse hook is not injected into
# the calling agent's own context, so this hook emits the structured
# PreToolUse JSON contract on stdout instead:
#   {"hookSpecificOutput": {"hookEventName": "PreToolUse",
#     "permissionDecision": "allow", "additionalContext": "<criteria text>"}}
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 always (this hook never
# blocks). stdout carries the structured hookSpecificOutput JSON ONLY when a
# closing condition was detected in the body; otherwise stdout is empty —
# true silence, not a "nothing found" note (unlike #1247's close-time
# sibling, where a "no condition found" note helps the closer; here it
# would just be noise repeated on every issue creation).
#
# SCOPE: `gh issue create` only, per #1248's own Required list. The body
# text lives entirely in the intercepted command (inline `--body`, or the
# contents of a `--body-file`/`-F` path) — the issue does not exist on
# GitHub yet, so unlike #1247 there is no `gh issue view` fetch and thus no
# gh-API / network failure surface. The one infra-failure surface that DOES
# exist here is a `--body-file` path that can't be read (missing, no
# permission) — handled by silently skipping that source rather than
# crashing (fail-open; see the body-file read loop below).
#
# Override: MACF_SKIP_CONDITION_GRADE_CHECK=1 bypasses (no context
# injection at all — cheap exit, no stdin read). Deliberately a DISTINCT
# flag from #1247's MACF_SKIP_CLOSE_CONDITION_CHECK — sharing one flag
# between the create-time and close-time siblings would let a single
# override silently disable both hooks, which is a real defect, not a
# naming nicety.
#
# Refs: groundnuty/macf#1248 (this hook); #1247 (the close-time sibling,
#       merged); #1245 + #1170 (the two luck-satisfiable instances that
#       motivated grading at write time); #1046 (the rule whose trigger 3
#       this generalises); #1171 (the N=2 standard this meets);
#       check-close-condition.sh (the extraction heuristic + warn-only +
#       additionalContext mechanism this hook copies); check-close-keyword.sh
#       (the `-F`/`--body-file` normalization + wrapper-coverage pattern
#       this hook's command matching is copied from);
#       assert-the-wrong-path.md (the decisive-test-pair discipline this
#       hook's own tests follow — test 1 must assert the CONDITION'S OWN
#       TEXT is echoed, not merely that the criteria appear, since "print
#       the criteria on every create" would satisfy a weaker test 1 alone).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_CONDITION_GRADE_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a broken
# hook must not brick the harness. Same defense-in-depth as the sister hooks.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0

# Wrapper-aware match for `gh issue create`. Mirrors check-close-condition.sh's
# GH_CLOSE_PATTERN shape — covers sudo, env VAR=, watch, ionice, setsid, nice,
# time prefix wrappers + chained-form leadins `;` `|` `&` `(` (subshell) +
# bare `VAR=val gh ...`.
GH_CREATE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+issue[[:space:]]+create([[:space:]]|$)'

# Shell-wrapper bypass: `bash -c "gh issue create ..."` and variants.
SHELL_C_GH_CREATE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+issue[[:space:]]+create([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_CREATE_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_CREATE_PATTERN ]]; then
  exit 0
fi

# ── Build the scan text: the raw command (covers an inline --body) plus the
#    contents of any --body-file (a file path, not inline text). `-F` is
#    gh's documented short alias for `--body-file` (`gh issue create --help`),
#    so normalize the space/`=` forms `-F path` / `-F=path` → `--body-file …`
#    before extraction — mirrors check-close-keyword.sh's own normalization,
#    same rationale (a peer closing-condition stated only in a `-F`-passed
#    file would otherwise slip a body-only scan). ─────────────────────────
#
# Known inherent non-guard (backstop, not airtight, same as the sibling
# hook): `--body-file -` / `-F -` (stdin — unreadable at hook-fire time).
# An unreadable/missing path is skipped silently (fail-open) rather than
# treated as a hook error — there is nothing to append, not a crash.
NORM_CMD="$(sed -E 's/(^|[[:space:]])-F([ =])/\1--body-file\2/g' <<<"$COMMAND" 2>/dev/null || echo "$COMMAND")"
SCAN_TEXT="$COMMAND"
while IFS= read -r bf; do
  [[ -z "$bf" ]] && continue
  bf="${bf%\"}"; bf="${bf#\"}"; bf="${bf%\'}"; bf="${bf#\'}"
  if [[ -f "$bf" && -r "$bf" ]]; then
    SCAN_TEXT+=$'\n'"$(cat "$bf" 2>/dev/null || true)"
  fi
done < <(grep -oE -- '--body-file[ =][^[:space:]]+' <<<"$NORM_CMD" 2>/dev/null | sed -E 's/^--body-file[ =]//' || true)

# ── Extract a stated closing condition ────────────────────────────────────
# Identical heuristic to check-close-condition.sh's extraction (a line-scan,
# not a full markdown parser — matches this hook family's existing style),
# applied to SCAN_TEXT (the raw command + any --body-file contents) rather
# than a fetched GitHub `.body` field, since the issue does not exist yet.
SECTION="$(awk '
  /^#+[[:space:]].*([Cc]losure|[Cc]losing)[[:space:]]+[Cc]ondition/ {
    if (insection) { exit }
    insection = 1
    next
  }
  insection && /^#+[[:space:]]/ { exit }
  insection { print }
' <<<"$SCAN_TEXT" 2>/dev/null | sed '/^[[:space:]]*$/d' || true)"

CONDITION_TEXT=""
if [[ -n "$SECTION" ]]; then
  CONDITION_TEXT="$SECTION"
else
  LINE="$(grep -iE 'closes when' <<<"$SCAN_TEXT" 2>/dev/null | head -1 || true)"
  if [[ -n "$LINE" ]]; then
    # Strip a wrapping markdown emphasis marker (`**`/`_`) at the line's own
    # start/end, plus a leading shell-quote character that can end up glued
    # on when the whole --body value is itself quoted — cosmetic only.
    CONDITION_TEXT="$(sed -E 's/^[[:space:]]*["'"'"']?[*_]{0,2}//; s/[*_]{0,2}["'"'"']?[[:space:]]*$//' <<<"$LINE")"
  fi
fi

# No stated closing condition → TRUE silent pass. No JSON constructed, no
# stdout at all — per #1248: "most issues have none; blocking those trains
# the override on." This is deliberately NOT the #1247 close-time behavior
# (which still emits a short "no condition found" note) — a create-time
# note on every issue with no condition would be exactly the noise #1248
# says to avoid.
[[ -z "$CONDITION_TEXT" ]] && exit 0

# Truncate defensively — mirrors check-close-condition.sh's truncation.
if [[ ${#CONDITION_TEXT} -gt 1000 ]]; then
  CONDITION_TEXT="${CONDITION_TEXT:0:1000}…[truncated]"
fi

CONTEXT_MSG="This issue states its own closing condition — grade it against the three criteria BEFORE filing (this hook surfaces the criteria; it does not adjudicate whether your condition meets them):

${CONDITION_TEXT}

1. observable — can someone else check it without asking you?
2. satisfiable only by the repair — luck must not be able to satisfy it (the #1245 failure: \"the next E2E run is green\" is met by an unrelated green run while the bug survives)
3. falsifiable when unmet — is there a state that definitely means NOT done, or would non-appearance just look like an expected non-event (the #1170 failure)?

Refs groundnuty/macf#1248 (why this is surfaced), #1247 (the close-time sibling), #1245 + #1170 (the two instances that motivated grading at write time)."

# Emit the structured PreToolUse allow+context-injection contract. Guarded
# against a missing/broken jq: if construction fails, fall through to a
# plain exit 0 with no injected context rather than letting a jq failure
# propagate under `set -e`.
OUTPUT=""
OUTPUT="$(jq -n --arg ctx "$CONTEXT_MSG" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    additionalContext: $ctx
  }
}' 2>/dev/null)" || OUTPUT=""

if [[ -n "$OUTPUT" ]]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
