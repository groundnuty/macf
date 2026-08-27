#!/usr/bin/env bash
#
# macf-prompt-watcher.sh — the runtime half of the interactive-prompt
# auto-responder (DR-033, groundnuty/macf#645). SAFETY-CRITICAL.
#
# Started by claude.sh (in the in-tmux invocation, before `exec claude`) to
# watch the launcher's tmux pane during the STARTUP WINDOW, detect KNOWN
# ceremony prompts from the operator's allowlist, and auto-answer them by
# driving the TUI with `tmux send-keys`. It is a faithful bash+jq reimpl of the
# pure matcher in @groundnuty/macf-core `prompt-responses.ts` — the two MUST
# stay in lockstep.
#
# The three constitutional invariants (DR-033):
#   Inv 1  allowlist-only. Only auto-answer a frame that matches a vetted entry.
#          An unrecognized prompt-like frame (a `❯` menu / `(y/n)`) → ALERT loud
#          (forensic log + stderr) and DO NOT answer. Silence beats a wrong key.
#   Inv 2  ceremony-only. Entries whose signature contains delete/overwrite/trust/revoke/remove
#          are HARD-REFUSED (dropped) here at load; (y/n)/allow/permission/grant
#          are LOUD-WARNED (kept, operator-owned risk). Defense-in-depth: the CLI
#          validates too at `macf update`, but the operator may edit the JSON and
#          relaunch without re-running it, so the watcher enforces Inv 2 itself.
#   Inv 3  the signature guarantees `send` still means the intended option: match
#          requires `option_text` on the menu line numbered `send`. A reorder /
#          reword / insert breaks the match → falls through to Inv 1 (alert),
#          never fires a now-wrong ordinal.
#
# It also: waits for the full frame to render before sending; VERIFIES the RIGHT
# outcome after sending (not merely that the signature vanished — a wrong answer
# also clears it); enforces a per-prompt fire cap; and logs every action.
#
# Usage: macf-prompt-watcher.sh <tmux-pane-target>
#   <tmux-pane-target> — e.g. "$TMUX_PANE" (%N) or "session:win.pane". Empty →
#                        no-op exit 0 (not in tmux / nothing to watch).
#
# Opt-out: MACF_PROMPT_AUTORESPOND_DISABLED=1 (also gated in claude.sh).
# Tunables: MACF_PROMPT_RESPONSES_PATH, MACF_PROMPT_WATCH_WINDOW_SECS (default 90),
#           MACF_PROMPT_WATCH_INTERVAL_SECS (default 1),
#           MACF_PROMPT_WATCH_TOTAL_CAP_SECS (default 1800 — see below).
#
# DEADLINE MODEL (groundnuty/macf#1041 — fixes the #994-discovered defect below):
#   the pre-#1041 deadline was `launch + WINDOW`, computed ONCE at watcher
#   start. `macf init` already seeds a `dev-channels` auto-response
#   (PROMPT_RESPONSES_SEED, @groundnuty/macf-core) matching the channels-
#   confirmation prompt exactly — so under normal conditions only the trust
#   dialog needs a human. But the trust dialog is HARD-REFUSED (Inv 2, never
#   auto-answered) and the unattended/overnight case — nobody attends within
#   WINDOW (90s) of launch — is the NORMAL case, not the exception: by the
#   time an operator answers trust, the watcher had already exited on the
#   fixed deadline, and the channels prompt that follows finds nobody
#   watching. The invariant that matters: the watcher should be alive while
#   prompts it can answer are still possible, and a fixed wall-clock window
#   from LAUNCH does not express that.
#
#   Fix: the deadline is `<last prompt-relevant signal> + WINDOW`, RESTARTED
#   every time the pane shows something the watcher cares about — either a
#   successful auto-answer (Option 1, "restart on each answered prompt") OR
#   an unanswerable/unrecognized prompt-like frame it correctly refuses to
#   touch, e.g. the still-unanswered trust dialog (the generalization to
#   "last observed [prompt-relevant] activity", Option 2 in #1041). The
#   trust dialog sitting on screen, unanswered, for 10 minutes IS the signal
#   that a subsequent prompt (channels) is still possible once it clears —
#   so its mere continued presence keeps the deadline alive, exactly as
#   Option 2 generalizes Option 1. This does NOT touch Inv 1/2/3 above: a
#   longer-lived watcher still only ever auto-answers an allowlisted,
#   Inv-2-surviving entry — it is simply awake for longer.
#
#   Bounded total lifetime (`MACF_PROMPT_WATCH_TOTAL_CAP_SECS`, default 1800s
#   / 30 min): every recomputed deadline is clamped to `launch + TOTAL_CAP`,
#   so no amount of prompt-relevant activity keeps the watcher alive past
#   this hard ceiling — "an idle watcher should still exit" and "no watcher
#   runs forever" both hold regardless of what the pane keeps showing. 30
#   minutes is 3x the #1041 acceptance scenario (a trust dialog answered at
#   t+10min) — generous headroom for a distracted operator while still
#   finite; tune via the env var if a deployment needs a different bound. A
#   pane showing nothing prompt-relevant is unaffected and still exits at the
#   base WINDOW, unchanged from pre-#1041 behavior.
#
#   KNOWN TRADE-OFF, not fixed here (#1041 review): there is no pidfile/
#   flock/instance guard. `claude.sh` backgrounds one watcher per launch
#   unconditionally. Pre-#1041 (fixed 90s deadline), two watchers could only
#   overlap on the SAME pane if relaunched within 90s of each other —
#   effectively never. Post-#1041, the overlap window is as wide as
#   TOTAL_CAP (1800s default), and a relaunch inside that window commonly
#   re-attaches the SAME `<project>@<agent>` tmux session/pane (canonical
#   session-naming, coordination.md), so two live watcher processes could
#   both match the same frame and both send — the exact "menus advance on
#   the digit alone" hazard `_handle_match` already guards against
#   single-process-internally. This widens a pre-existing hazard rather than
#   introducing a new one, and is left as a follow-up rather than gating
#   #1041 on a concurrency-control redesign.
#
# Fail-open by design: any missing dependency (jq/tmux), missing/invalid config,
# or empty pane makes the watcher a silent no-op — it never blocks the launch and
# never fires on a config it could not fully validate.

set -euo pipefail

# --- opt-out + arg -----------------------------------------------------------
if [ "${MACF_PROMPT_AUTORESPOND_DISABLED:-}" = "1" ]; then
  exit 0
fi

PANE="${1:-}"
if [ -z "$PANE" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- log sink (MACF_LOG_PATH cluster) ----------------------------------------
if [ -n "${MACF_LOG_PATH:-}" ]; then
  LOG_DIR="$(dirname "$MACF_LOG_PATH")"
else
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/macf"
fi
LOG_FILE="$LOG_DIR/prompt-watcher.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

_log() { # <level> <message>
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')"
  printf '[macf-prompt-watcher] %s [%s] %s\n' "$ts" "$1" "$2" >>"$LOG_FILE" 2>/dev/null || true
}
_alert() { # <message> — LOUD: forensic log + stderr
  _log ALERT "$1"
  printf '[macf-prompt-watcher] ALERT: %s\n' "$1" >&2 || true
}

# --- dependency + config gates (fail-open) -----------------------------------
if ! command -v jq >/dev/null 2>&1; then
  _log WARN "jq not found on PATH — auto-responder disabled this session"
  exit 0
fi
if ! command -v tmux >/dev/null 2>&1; then
  _log WARN "tmux not found on PATH — auto-responder disabled this session"
  exit 0
fi

CONFIG="${MACF_PROMPT_RESPONSES_PATH:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)/.macf/prompt-responses.json}"
if [ ! -f "$CONFIG" ]; then
  _log INFO "no config at $CONFIG — nothing to watch"
  exit 0
fi
if ! jq -e . "$CONFIG" >/dev/null 2>&1; then
  _alert "config $CONFIG is not valid JSON — refusing to auto-answer anything this session"
  exit 0
fi

WINDOW="${MACF_PROMPT_WATCH_WINDOW_SECS:-90}"
INTERVAL="${MACF_PROMPT_WATCH_INTERVAL_SECS:-1}"
# Total lifetime cap (macf#1041) — the hard ceiling the per-activity deadline
# below is clamped to, regardless of how much prompt-relevant activity keeps
# recomputing it. See the file header "DEADLINE MODEL" section.
TOTAL_CAP="${MACF_PROMPT_WATCH_TOTAL_CAP_SECS:-1800}"
case "$TOTAL_CAP" in ''|*[!0-9]*) TOTAL_CAP=1800 ;; esac
# Never let the cap collapse below the base window. Without this floor,
# MACF_PROMPT_WATCH_TOTAL_CAP_SECS=0 (or any value under WINDOW) would make
# HARD_DEADLINE <= launch time, so the poll loop's very first condition is
# already false and the watcher exits without a single poll — a silent
# second disable path alongside MACF_PROMPT_AUTORESPOND_DISABLED=1 (macf#1041
# review finding). TOTAL_CAP is a ceiling above the base window, not a
# switch — use the DISABLED flag to actually disable the watcher.
[ "$TOTAL_CAP" -lt "$WINDOW" ] && TOTAL_CAP="$WINDOW"

# Inv-2 substring lists — kept in lockstep with PROMPT_{REFUSE,WARN}_SUBSTRINGS
# in @groundnuty/macf-core prompt-responses.ts.
REFUSE_SUBSTR=(delete overwrite trust revoke remove)
WARN_SUBSTR=("(y/n)" allow permission grant)

# --- pure helpers (mirror the macf-core matcher) -----------------------------

# _classify <signature-material> → prints refuse | warn | ok
_classify() {
  local sig s
  sig="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for s in "${REFUSE_SUBSTR[@]}"; do
    case "$sig" in *"$s"*) echo refuse; return 0 ;; esac
  done
  for s in "${WARN_SUBSTR[@]}"; do
    case "$sig" in *"$s"*) echo warn; return 0 ;; esac
  done
  echo ok
}

# Prompt-like detection regexes — the single source both _looks_prompt_like
# (does this frame look like a prompt at all?) AND _prompt_signature (which
# LINES are the actual signal, used for the alert dedup key + display excerpt
# below) match against. Keeping one definition removes a class of bug: a
# mismatch between the detection regex and a separately-written extraction
# regex is exactly the shape of the macf#729 misclassification hazard this
# comment already warns about, just at a different pair of call sites.
readonly PROMPT_LIKE_MENU_RE='❯[[:space:]]*[0-9]+[.)]'
readonly PROMPT_LIKE_YN_RE='\((y/n|y/N|Y/n)\)|\[(y/N|Y/n|y/n)\]'

# _looks_prompt_like <frame> → 0 if the frame looks like an interactive prompt
#
# ❯ is overloaded (groundnuty/macf#729): it is BOTH the menu-selection cursor
# on a real numbered ceremony prompt (`❯ 1. Yes`) AND the Claude Code
# free-form input-box cursor (`❯ <queued/typed text>`). A bare `❯` match
# misclassified a queued message in the input box (e.g.
# `❯ you merge pleasee, complete startup-reconcile`) as an unknown prompt,
# firing repeated ALERT spam. Match only when `❯` sits directly on a
# NUMBERED OPTION line — that excludes the free-form input box (whose text
# after `❯` is not `[0-9]+[.)]`) while still catching real numbered menus.
_looks_prompt_like() {
  printf '%s' "$1" | grep -qE "$PROMPT_LIKE_MENU_RE" && return 0
  printf '%s' "$1" | grep -qE "$PROMPT_LIKE_YN_RE" && return 0
  return 1
}

# _option_on_send_line <frame> <option_text> <send> → 0 if option_text renders on
# a line numbered <send> (Inv 3). Non-numeric send: presence is the binding.
_option_on_send_line() {
  awk -v opt="$2" -v send="$3" '
    index($0, opt) > 0 {
      line = $0
      if (send ~ /^[0-9]+$/) {
        sub(/^[^0-9A-Za-z]+/, "", line)
        if (substr(line, 1, length(send)) == send) {
          rest = substr(line, length(send) + 1, 1)
          if (rest == "" || rest !~ /[0-9A-Za-z]/) { found = 1; exit }
        }
      } else {
        found = 1; exit
      }
    }
    END { exit(found ? 0 : 1) }
  ' <<<"$1"
}

# --- load + Inv-2-filter the accepted allowlist ------------------------------
# Parallel arrays, one slot per ACCEPTED entry.
ACC_NAME=(); ACC_OPT=(); ACC_SEND=(); ACC_VERIFY=(); ACC_MAXFIRES=(); ACC_FC=(); FIRED=()

n="$(jq '.entries | length' "$CONFIG" 2>/dev/null || echo 0)"
i=0
while [ "$i" -lt "$n" ]; do
  name="$(jq -r ".entries[$i].name // empty" "$CONFIG")"
  opt="$(jq -r ".entries[$i].option_text // empty" "$CONFIG")"
  send="$(jq -r ".entries[$i].send // empty" "$CONFIG")"
  verify="$(jq -r ".entries[$i].verify_contains // empty" "$CONFIG")"
  maxf="$(jq -r ".entries[$i].max_fires // 1" "$CONFIG")"
  fc="$(jq -r ".entries[$i].frame_contains // [] | .[]" "$CONFIG" 2>/dev/null || true)"
  i=$((i + 1))

  # Defensive shape check — skip (loud) any entry missing required fields.
  if [ -z "$name" ] || [ -z "$opt" ] || [ -z "$send" ] || [ -z "$fc" ]; then
    _alert "skipping malformed entry #$((i - 1)) (missing name/option_text/send/frame_contains)"
    continue
  fi
  case "$maxf" in ''|*[!0-9]*) maxf=1 ;; esac

  # Inv 2 — classify the entry's signature material.
  class="$(_classify "$name"$'\n'"$fc"$'\n'"$opt")"
  if [ "$class" = "refuse" ]; then
    _alert "REFUSED entry \"$name\" — signature contains a delete/overwrite/trust substring (Inv 2 hard-refuse; dropped)"
    continue
  fi
  if [ "$class" = "warn" ]; then
    _log WARN "entry \"$name\" signature is authorization-shaped ((y/n)/allow/permission/grant) — kept, operator-owned risk (Inv 2)"
  fi

  ACC_NAME+=("$name"); ACC_OPT+=("$opt"); ACC_SEND+=("$send")
  ACC_VERIFY+=("$verify"); ACC_MAXFIRES+=("$maxf"); ACC_FC+=("$fc"); FIRED+=(0)
done

if [ "${#ACC_NAME[@]}" -eq 0 ]; then
  _log INFO "no accepted allowlist entries — nothing to auto-answer"
  exit 0
fi
_log INFO "watching pane $PANE for ${#ACC_NAME[@]} accepted prompt(s), window=${WINDOW}s"

# --- match one accepted entry against a captured frame -----------------------
# _entry_matches <frame> <idx> → 0 on match (all frame_contains + option_text +
# option_text-on-send-line).
_entry_matches() {
  local frame="$1" idx="$2" needle
  while IFS= read -r needle; do
    [ -z "$needle" ] && continue
    printf '%s' "$frame" | grep -qF -- "$needle" || return 1
  done <<<"${ACC_FC[$idx]}"
  printf '%s' "$frame" | grep -qF -- "${ACC_OPT[$idx]}" || return 1
  _option_on_send_line "$frame" "${ACC_OPT[$idx]}" "${ACC_SEND[$idx]}" || return 1
  return 0
}

# Own-output marker — every line this watcher writes (via _log/_alert) is
# prefixed with this. When the watcher's stderr shares the watched pane (the
# canonical claude.sh wiring backgrounds it into the SAME tmux pane it
# watches), its own ALERT lines land back in the very frame the next poll
# captures. An ALERT line embeds an excerpt of the offending frame (which for
# an unknown MENU prompt contains the `❯` glyph) — so the alert itself
# "looks prompt-like" to `_looks_prompt_like` on the very next poll, causing
# an infinite self-alert feedback loop (groundnuty/macf#712). Filtering the
# marker out of every captured frame, BEFORE any matching/detection runs,
# makes the watcher blind to its own emitted output structurally, regardless
# of where its stderr happens to be wired.
readonly OWN_MARKER='[macf-prompt-watcher]'

# _strip_own_output <frame> → the frame with every line containing this
# watcher's own log/alert marker removed.
_strip_own_output() {
  printf '%s' "$1" | grep -vF -- "$OWN_MARKER" || true
}

# groundnuty/macf#778: the #712 strip above is a CAPTURE THAT INCLUDES ITS
# OWN ECHO, incompletely discriminated. An ALERT line is long (it embeds a
# frame excerpt) and routinely exceeds the pane's column width, so
# `tmux capture-pane -p` (no `-J`) renders it as MULTIPLE physical rows — the
# marker sits only on the FIRST row. `grep -vF "$OWN_MARKER"` strips that one
# row and leaves the wrapped CONTINUATION rows behind, unmarked. When a
# continuation row happens to carry the embedded `❯ N.` excerpt (routine,
# since that excerpt is exactly what wrapped), it still "looks prompt-like"
# on the next poll — a fresh, non-deduped alert (its content shifts every
# time), i.e. the watcher re-triggers on its own prior output. `-J` tells
# tmux to join wrapped physical rows back into the ONE logical line it always
# was, using tmux's own internal wrap tracking (not something we can safely
# reconstruct from unwrapped text after the fact) — so the marker match now
# covers the entire ALERT line, continuation included, and the strip is
# complete regardless of ALERT-line length vs pane width. Verified against
# real tmux (3.4): the same ALERT text at a 40-col pane width leaves
# `line: ❯ 1. Continue` unmarked and re-matchable under plain `-p`; under
# `-p -J` nothing prompt-like survives the strip.
_capture() {
  local raw; raw="$(tmux capture-pane -t "$PANE" -p -J 2>/dev/null || true)"
  _strip_own_output "$raw"
}

# _send_ordinal_and_maybe_enter <idx> → sends the entry's ordinal, re-captures,
# and presses Enter ONLY if the frame still matches the entry afterward.
#
# groundnuty/macf#891: some menus advance on the digit alone, so a blind
# Enter would land on whatever screen comes NEXT — hazardous, because that
# next screen was never vetted against the allowlist (Inv 1). The first
# attempt in _handle_match always re-checked before pressing Enter; the retry
# branch used to skip the re-check and send Enter unconditionally, carrying
# exactly the hazard the first attempt exists to avoid. Both call sites now
# share this ONE guarded implementation, so the guard cannot silently apply
# to only one of the two structurally identical send attempts again.
_send_ordinal_and_maybe_enter() { # <idx>
  local idx="$1" send="${ACC_SEND[$1]}"
  tmux send-keys -t "$PANE" -- "$send" 2>/dev/null || return 1
  sleep 0.4
  local mid; mid="$(_capture)"
  if _entry_matches "$mid" "$idx"; then
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true
    sleep 1
  fi
  return 0
}

# --- handle a matched entry: settle → send → verify --------------------------
_handle_match() { # <frame> <idx>
  local frame="$1" idx="$2"
  local name="${ACC_NAME[$idx]}" send="${ACC_SEND[$idx]}" verify="${ACC_VERIFY[$idx]}"

  # Settle: require the SAME match on a second capture (full render + stable)
  # before touching the keyboard. If it changed under us, wait for next poll.
  sleep 0.4
  local frame2; frame2="$(_capture)"
  _entry_matches "$frame2" "$idx" || { _log INFO "entry \"$name\" matched but frame not yet stable — deferring"; return 0; }

  _log INFO "auto-answering \"$name\": sending \"$send\" to pane $PANE"
  if ! _send_ordinal_and_maybe_enter "$idx"; then
    _alert "send-keys failed for \"$name\""
    FIRED[$idx]=$((FIRED[idx] + 1))
    return 0
  fi

  FIRED[$idx]=$((FIRED[idx] + 1))
  local after; after="$(_capture)"

  # Verify the RIGHT outcome (DR-033). "Cleared" != "correctly answered".
  if _entry_matches "$after" "$idx"; then
    # Not cleared — typed-but-no-effect (RC "typed-no-Enter", silent-fallback
    # Instance 3). One retry, with the SAME re-check guard as the first
    # attempt (macf#891), then alert + stop (fire cap protects against loops).
    _log WARN "\"$name\" still present after send — retrying once"
    _send_ordinal_and_maybe_enter "$idx" || true
    after="$(_capture)"
    if _entry_matches "$after" "$idx"; then
      _alert "\"$name\" did NOT clear after auto-answer (typed-no-Enter?) — will not retry further"
      return 0
    fi
  fi

  if [ -n "$verify" ]; then
    if printf '%s' "$after" | grep -qF -- "$verify"; then
      _log INFO "\"$name\" verified: post-answer screen contains expected marker"
    else
      _alert "\"$name\" cleared but the expected post-answer marker is ABSENT — possible WRONG answer (verify the pane)"
    fi
  else
    _log WARN "\"$name\" cleared, but no verify_contains configured — outcome check is signature-clearance only (weaker; set verify_contains for full verification)"
  fi
}

# _prompt_signature <frame> → just the lines that make the frame look like a
# prompt at all (the SAME regexes _looks_prompt_like uses), one per line.
#
# groundnuty/macf#1066: _maybe_alert_unknown used to dedup on a hash of the
# WHOLE raw frame. That is wrong — an unknown prompt can sit unchanged on
# screen for many polls while OTHER, prompt-irrelevant content elsewhere in
# the same pane keeps moving (a status/footer line, a live counter, the
# free-form input-box `❯` line itself changing as text is typed/queued
# elsewhere — see the macf#729 comment above on that same overload). Any of
# that changes the WHOLE-FRAME hash on every poll even though the unknown
# menu itself never moved, so the pre-fix dedup silently degenerated to
# "alert once per poll" — 2 real unknown prompts produced 321 alert lines
# (23 distinct byte-variants) in one observed session, burying the one
# prompt an operator needed to see under the noise.
# Restricting both the dedup key AND the excerpt below to just the matched
# prompt line(s) makes both immune to everything else on screen: the key
# changes only when the ACTUAL prompt content changes.
_prompt_signature() {
  printf '%s' "$1" | grep -E "$PROMPT_LIKE_MENU_RE" || true
  printf '%s' "$1" | grep -E "$PROMPT_LIKE_YN_RE" || true
}

# _sanitize_excerpt <text> → <text> with the exact substrings
# PROMPT_LIKE_MENU_RE / PROMPT_LIKE_YN_RE match neutralized (❯ glyph;
# (y/n)-shaped groups). Defense-in-depth for groundnuty/macf#778: the -J
# capture fix above closes the WRAPPED-continuation self-match, but a
# residual shape remains that -J cannot reach — character-level interleaving
# from the TUI redrawing at absolute cursor positions while the watcher
# writes at its own (an ALERT byte landing next to unrelated on-screen text,
# e.g. the live-observed "❯macfContinuewatcher] ALERT: ..."). There the
# `[macf-prompt-watcher]` marker itself is broken up, so neither
# `grep -vF`'s marker-match nor `-J`'s row-join can recover it. Sanitizing
# what we EMIT — so the alert text can never itself be prompt-shaped, no
# matter how it re-enters a captured frame — is the only defense that
# reaches that case. This ONLY touches the text handed to `_alert` for
# display; it must never touch `_looks_prompt_like`'s detection input ($1
# here, used unsanitized above for `sig`/`h`) — sanitizing what the watcher
# reads instead of what it writes would blind real-prompt detection, not
# just its own echo.
_sanitize_excerpt() {
  printf '%s' "$1" | sed \
    -e 's/❯/[cursor]/g' \
    -e 's/(y\/n)/(y-n)/g' -e 's/(y\/N)/(y-N)/g' -e 's/(Y\/n)/(Y-n)/g' \
    -e 's/\[y\/N\]/[y-N]/g' -e 's/\[Y\/n\]/[Y-n]/g' -e 's/\[y\/n\]/[y-n]/g'
}

# --- unknown-prompt alert (dedup per distinct frame) -------------------------
LAST_UNKNOWN=""
_maybe_alert_unknown() { # <frame>
  local sig h excerpt
  sig="$(_prompt_signature "$1")"
  h="$(printf '%s' "$sig" | cksum 2>/dev/null | awk '{print $1}' || echo x)"
  [ "$h" = "$LAST_UNKNOWN" ] && return 0
  LAST_UNKNOWN="$h"
  excerpt="$(printf '%s' "$sig" | head -n1 | sed 's/^[[:space:]]*//' | cut -c1-120)"
  _alert "UNKNOWN prompt-like frame on pane $PANE not on the allowlist — NOT answering (Inv 1). First line: $(_sanitize_excerpt "$excerpt")"
}

# --- deadline extension (macf#1041) -------------------------------------
# LAUNCH_TS/HARD_DEADLINE are fixed once; `deadline` is the live, extendable
# bound the poll loop actually checks — always clamped to HARD_DEADLINE, so
# the total cap holds no matter how much activity keeps restarting it.
LAUNCH_TS="$(date +%s 2>/dev/null || echo 0)"
HARD_DEADLINE=$((LAUNCH_TS + TOTAL_CAP))
deadline=$((LAUNCH_TS + WINDOW))
[ "$deadline" -gt "$HARD_DEADLINE" ] && deadline="$HARD_DEADLINE"

# _extend_deadline — called on prompt-relevant activity (a successful
# auto-answer OR a still-unanswered/unrecognized prompt-like frame, e.g. the
# hard-refused trust dialog). Restarts the WINDOW-sized grace period from
# NOW, clamped to HARD_DEADLINE (macf#1041 Option 1+2). Does nothing —
# `deadline` is simply left as-is — when the candidate wouldn't move it
# forward, so an idle pane (no activity) still exits at the original
# WINDOW-from-launch bound, unchanged from pre-#1041 behavior.
#
# EXTENDED_LOGGED gates the forensic log line to ONCE per run (macf#1041
# review): an unattended prompt sitting on screen re-triggers this every
# poll (once per INTERVAL, default 1s) for as long as it lingers — up to
# TOTAL_CAP/INTERVAL times (≈1800 lines at the defaults) into a
# never-rotated prompt-watcher.log absent this gate. "This watcher outlived
# its base window" is the one forensically interesting event; "still alive"
# on every subsequent poll is not. The final "total lifetime cap reached" /
# "startup window elapsed" line at exit still reports the outcome either way.
EXTENDED_LOGGED=0
_extend_deadline() {
  local t candidate
  t="$(date +%s 2>/dev/null || echo "$deadline")"
  candidate=$((t + WINDOW))
  [ "$candidate" -gt "$HARD_DEADLINE" ] && candidate="$HARD_DEADLINE"
  if [ "$candidate" -gt "$deadline" ]; then
    deadline="$candidate"
    if [ "$EXTENDED_LOGGED" -eq 0 ]; then
      EXTENDED_LOGGED=1
      _log INFO "prompt-relevant activity — deadline extended past the base window (hard cap: launch+${TOTAL_CAP}s)"
    fi
  fi
}

# --- poll loop, bounded by the (extendable, capped) deadline -----------------
while [ "$(date +%s 2>/dev/null || echo "$deadline")" -lt "$deadline" ]; do
  frame="$(_capture)"
  if [ -n "$frame" ]; then
    matched=0
    for idx in "${!ACC_NAME[@]}"; do
      [ "${FIRED[$idx]}" -ge "${ACC_MAXFIRES[$idx]}" ] && continue
      if _entry_matches "$frame" "$idx"; then
        matched=1
        _handle_match "$frame" "$idx"
        break
      fi
    done
    if [ "$matched" -eq 1 ]; then
      _extend_deadline
    elif _looks_prompt_like "$frame"; then
      _maybe_alert_unknown "$frame"
      _extend_deadline
    fi
  fi
  sleep "$INTERVAL"
done

if [ "$deadline" -ge "$HARD_DEADLINE" ]; then
  _log INFO "total lifetime cap (${TOTAL_CAP}s from launch) reached — watcher exiting"
else
  _log INFO "startup window elapsed with no further prompt-relevant activity — watcher exiting"
fi
exit 0
