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
#   Inv 2  ceremony-only. Entries whose signature contains delete/overwrite/trust
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
#           MACF_PROMPT_WATCH_INTERVAL_SECS (default 1).
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

# Inv-2 substring lists — kept in lockstep with PROMPT_{REFUSE,WARN}_SUBSTRINGS
# in @groundnuty/macf-core prompt-responses.ts.
REFUSE_SUBSTR=(delete overwrite trust)
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

# _looks_prompt_like <frame> → 0 if the frame looks like an interactive prompt
_looks_prompt_like() {
  printf '%s' "$1" | grep -qF '❯' && return 0
  printf '%s' "$1" | grep -qE '\((y/n|y/N|Y/n)\)|\[(y/N|Y/n|y/n)\]' && return 0
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

_capture() { tmux capture-pane -t "$PANE" -p 2>/dev/null || true; }

# --- handle a matched entry: settle → send → verify --------------------------
_handle_match() { # <frame> <idx>
  local frame="$1" idx="$2"
  local name="${ACC_NAME[$idx]}" send="${ACC_SEND[$idx]}" verify="${ACC_VERIFY[$idx]}"

  # Settle: require the SAME match on a second capture (full render + stable)
  # before touching the keyboard. If it changed under us, wait for next poll.
  sleep 0.4
  local frame2; frame2="$(_capture)"
  _entry_matches "$frame2" "$idx" || { _log INFO "entry \"$name\" matched but frame not yet stable — deferring"; return 0; }

  # Send the ordinal. Re-check before sending Enter: some menus advance on the
  # digit alone, so a blind Enter would land on the NEXT screen (hazardous).
  _log INFO "auto-answering \"$name\": sending \"$send\" to pane $PANE"
  tmux send-keys -t "$PANE" -- "$send" 2>/dev/null || { _alert "send-keys failed for \"$name\""; FIRED[$idx]=$((FIRED[idx] + 1)); return 0; }
  sleep 0.4
  local mid; mid="$(_capture)"
  if _entry_matches "$mid" "$idx"; then
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true
    sleep 1
  fi

  FIRED[$idx]=$((FIRED[idx] + 1))
  local after; after="$(_capture)"

  # Verify the RIGHT outcome (DR-033). "Cleared" != "correctly answered".
  if _entry_matches "$after" "$idx"; then
    # Not cleared — typed-but-no-effect (RC "typed-no-Enter", silent-fallback
    # Instance 3). One retry, then alert + stop (fire cap protects against loops).
    _log WARN "\"$name\" still present after send — retrying once"
    tmux send-keys -t "$PANE" -- "$send" 2>/dev/null || true
    sleep 0.4
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true
    sleep 1
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

# --- unknown-prompt alert (dedup per distinct frame) -------------------------
LAST_UNKNOWN=""
_maybe_alert_unknown() { # <frame>
  local h; h="$(printf '%s' "$1" | cksum 2>/dev/null | awk '{print $1}' || echo x)"
  [ "$h" = "$LAST_UNKNOWN" ] && return 0
  LAST_UNKNOWN="$h"
  _alert "UNKNOWN prompt-like frame on pane $PANE not on the allowlist — NOT answering (Inv 1). First line: $(printf '%s' "$1" | grep -m1 -E '❯|\(y/n\)' | sed 's/^[[:space:]]*//' | cut -c1-120)"
}

# --- poll loop, bounded by the startup window --------------------------------
now="$(date +%s 2>/dev/null || echo 0)"
deadline=$((now + WINDOW))
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
    if [ "$matched" -eq 0 ] && _looks_prompt_like "$frame"; then
      _maybe_alert_unknown "$frame"
    fi
  fi
  sleep "$INTERVAL"
done

_log INFO "startup window elapsed — watcher exiting"
exit 0
