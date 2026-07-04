#!/usr/bin/env bash
#
# check-channel-alive.sh — Claude Code SessionStart + UserPromptSubmit hook
# (groundnuty/macf#734) that asserts THIS agent's OWN channel-server is
# actually alive right now, and warns LOUDLY into the agent's context when
# it is not.
#
# WHY (the silent-fallback this catches — the detect-half macf#633 doesn't
# cover): devops's channel-server process DIED and nobody noticed for ~55
# minutes. The Claude Code TUI kept working fine the whole time (it's a
# separate process) — but the agent was completely deaf to every routed
# issue/PR/mention, with zero signal anywhere. check-channels-enabled.sh
# (#633) asserts "is native channel-push ENABLED for this session" (a
# config/flag question, answered once at session start); it says nothing
# about whether the channel-server PROCESS is still running a minute, an
# hour, or 55 minutes later. This hook is the missing piece: a direct
# result-invariant liveness probe (Pattern A, silent-fallback-hazards.md)
# against the agent's own channel-server `/health` endpoint over mTLS,
# re-asserted periodically through the session (throttled — see below).
#
# HOW it finds "its own" endpoint: the channel-server logs a `server_started`
# JSONL event (host/port/pid/instance_id — packages/macf-core/src/logger.ts +
# packages/macf-channel-server/src/server.ts) to its own channel.log — the
# SAME log check-channels-enabled.sh already reads via MACF_LOG_PATH (or the
# newest `~/.local/state/macf/*/channel.log` fallback). channel.log is
# APPEND-ONLY across every relaunch generation, and the channel-server picks
# a fresh random port every launch (PORT_RANGE 8800..9800) — so this hook
# does NOT simply trust the newest `server_started` line (macf#760: that
# heuristic false-alarmed "DEAD" on a live server, because the NEWEST logged
# line can belong to a PRIOR generation whose process is long gone — e.g. at
# SessionStart, when THIS session's channel-server, an MCP stdio child
# Claude Code spawns ASYNCHRONOUSLY, hasn't logged its own line yet). Instead
# it scans every `server_started` line and selects the {host, port} of the
# most recent one whose `pid` is CONFIRMED ALIVE (`kill -0`, best-effort
# tightened against pid-reuse via `/proc/<pid>/cmdline` where readable — see
# the port-resolution block below for the full rationale), then curls
# `https://<host>:<port>/health` over mTLS using the same MACF_CA_CERT /
# MACF_AGENT_CERT / MACF_AGENT_KEY cert paths claude.sh's multi-file env
# (env.certs) exports for peer-health pings (see plugin/lib/probe-peer-health.ts
# — identical cert usage). No GitHub / registry call is made — purely local
# files + one local-network probe, so this hook stays fast, offline-safe, and
# matches the check-*.sh family's no-external-dependency posture.
#
# IDENTITY CHECK IS BEST-EFFORT AND NON-GATING: a fully robust liveness
# assertion would confirm the `/health` responder's `instance_id` against the
# REGISTRY-authoritative current instance for this agent — but that needs a
# GH/registry round-trip, which this fail-open, GH-API-free hook family
# deliberately avoids (same posture as check-channels-enabled.sh, which reads
# only local logs). This hook therefore uses "did `/health` respond 2xx" as
# the sole, load-bearing liveness criterion. A cross-check against this
# process's OWN last-logged instance_id was considered but deliberately left
# unimplemented: on a randomly-chosen port (packages/macf-channel-server/src/
# https.ts PORT_RANGE_START=8800..+1000) a genuine squatter is exceedingly
# unlikely, and a partial/best-effort mismatch check that still never gates
# the outcome would add code with no observable behavior difference. If a
# more rigorous identity assertion is ever needed, the extension point is a
# registry lookup (see `registry.list()` in src/cli/commands/peers.ts) for
# the agent's OWN routing_label slot, compared against the `/health` body's
# `instance_id` field (packages/macf-channel-server/src/health.ts).
#
# Hook contract (SessionStart + UserPromptSubmit): JSON on stdin; STDOUT is
# injected into the agent's context on exit 0 (same mechanism
# check-channels-enabled.sh uses). This hook is OBSERVATIONAL + NON-BLOCKING:
# it ALWAYS exits 0 — a missing log, missing certs, missing curl, or any
# internal error fails open (never delays or blocks a turn/session). Override:
# MACF_SKIP_CHANNEL_ALIVE_CHECK=1.
#
# RETRY-BEFORE-DEAD (groundnuty/macf#765): a SINGLE `curl` probe treated a
# transient timeout / momentary TLS blip / SessionStart-time resource
# contention under fleet-launch load as a definitive, maximally-loud DEAD
# verdict — no retry, no debounce. This produced a real false positive: the
# channel-server had been up 2d19h, `macf fleet status` reported it reachable,
# and live @mentions were arriving — yet this hook fired the DEAD banner off
# one noisy sample. Same class as macf#645 (single-noisy-sample vs
# sustained-signal — see silent-fallback-hazards.md's Pattern-C correction).
# The fix: retry the probe up to MACF_CHANNEL_ALIVE_RETRIES times (default 3,
# short spacing between attempts via MACF_CHANNEL_ALIVE_RETRY_DELAY_SECS,
# default 1s) and only emit the LOUD banner once EVERY attempt has failed —
# a single failure among successes stays completely silent, and the happy
# path exits as soon as any attempt returns 2xx (no latency added when the
# server is actually up). All attempts happen inside this ONE invocation, so
# the existing throttle stamp (written once, below, before any attempt) still
# bounds the frequency of the *next* invocation correctly.
#
# THROTTLE: a real mTLS probe on EVERY UserPromptSubmit would add needless
# latency + noise to every turn. A local timestamp file
# (.claude/.macf/.channel-alive-last-check, plain epoch-seconds) bounds the
# probe to once per MACF_CHANNEL_ALIVE_THROTTLE_SECS (internal/test knob;
# default 300s = 5 min). SessionStart ALWAYS probes (fresh session — no
# reason to trust a stale throttle stamp from a prior session) and
# (re)stamps the file so subsequent UserPromptSubmit calls inherit the fresh
# window.
set -euo pipefail

# Operator override first — cheapest exit, no stdin read needed.
if [ "${MACF_SKIP_CHANNEL_ALIVE_CHECK:-}" = "1" ]; then
  exit 0
fi

# Read the hook payload (SessionStart or UserPromptSubmit shape) — we only
# need `hook_event_name` to decide whether to bypass the throttle. Never
# block on stdin; a read/parse failure just means "can't tell which event,
# apply the throttle as usual" (fails toward MORE throttling, never toward a
# false alarm).
INPUT_JSON="$(cat 2>/dev/null || echo '')"
HOOK_EVENT="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"hook_event_name":"\([^"]*\)".*/\1/p' 2>/dev/null || true)"

# Resolve the workspace dir the same way check-channels-enabled.sh does.
WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[ -n "$WORKSPACE" ] || exit 0

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || exit 0

# ── Throttle gate ────────────────────────────────────────────────────────────
# MACF_CHANNEL_ALIVE_THROTTLE_SECS is an internal/test knob (default 300s); a
# non-numeric value falls back to the default so a bad env can't break the gate.
THROTTLE_SECS="${MACF_CHANNEL_ALIVE_THROTTLE_SECS:-300}"
case "$THROTTLE_SECS" in
  '' | *[!0-9]*) THROTTLE_SECS=300 ;;
esac

THROTTLE_DIR="$WORKSPACE/.claude/.macf"
THROTTLE_FILE="$THROTTLE_DIR/.channel-alive-last-check"
NOW_EPOCH="$(date +%s 2>/dev/null || true)"

# SessionStart always probes (HOOK_EVENT == "SessionStart" skips this gate
# entirely). Every other event (UserPromptSubmit) is throttled.
if [ "$HOOK_EVENT" != "SessionStart" ] && [ -n "$NOW_EPOCH" ] && [ -r "$THROTTLE_FILE" ]; then
  LAST_CHECK="$(cat "$THROTTLE_FILE" 2>/dev/null || true)"
  case "$LAST_CHECK" in
    '' | *[!0-9]*) LAST_CHECK="" ;;
  esac
  if [ -n "$LAST_CHECK" ]; then
    AGE=$((NOW_EPOCH - LAST_CHECK))
    if [ "$AGE" -ge 0 ] && [ "$AGE" -lt "$THROTTLE_SECS" ]; then
      exit 0
    fi
  fi
fi

# ── Locate THIS agent's channel-server log (same locator as #633) ───────────
CHANNEL_LOG=""
if [ -n "${MACF_LOG_PATH:-}" ] && [ -r "${MACF_LOG_PATH}" ]; then
  CHANNEL_LOG="${MACF_LOG_PATH}"
else
  CHANNEL_LOG="$(ls -t "$HOME_DIR"/.local/state/macf/*/channel.log 2>/dev/null | head -n1 || true)"
fi
[ -n "$CHANNEL_LOG" ] && [ -r "$CHANNEL_LOG" ] || exit 0

# ── Read back this agent's own {host, port} — NOT simply from the NEWEST
# `server_started` log line (macf#760). channel.log is append-only across
# every relaunch generation, and the channel-server picks a FRESH random
# port every launch (PORT_RANGE 8800..9800), so a blind "take the newest
# line" read can name a port from a PRIOR generation whose process is long
# gone — while the CURRENT server is alive on a different port. Concretely:
# at SessionStart, this session's channel-server is an MCP stdio child
# Claude Code spawns ASYNCHRONOUSLY — it may not have logged its own
# `server_started` line yet, so the newest line on disk still belongs to the
# previous generation. Probing that stale port then false-alarms "DEAD" on a
# server that is, in fact, alive elsewhere (verified live 2026-07-03: the
# guard probed a stale dead-pid port while the real v0.2.50 server served
# peer health-pings on a different port the whole time).
#
# Fix: scan every `server_started` line, oldest → newest (the log's natural
# append order), and remember the {host, port} of the LAST (i.e. most
# recent) one whose `pid` is CONFIRMED ALIVE — `kill -0 $pid` — and, when
# `/proc` is readable (Linux), whose `/proc/$pid/cmdline` actually looks like
# a channel-server process (best-effort pid-reuse guard; when
# `/proc/$pid/cmdline` can't be read at all — non-Linux, permission,
# `/proc` absent — that extra check is skipped and `kill -0` alone decides,
# rather than failing the whole liveness check over an unrelated missing
# `/proc` capability).
#
# No candidate has a live pid at all → same posture as "no `server_started`
# line at all": fail open, no false alarm. This is the expected TRANSIENT
# shape right at SessionStart, before the async stdio child has logged its
# first line — treating it as a hazard would just reintroduce the false
# alarm this fix removes. The LOUD alarm below stays reserved for the
# genuine hazard this hook exists to catch: a LIVE-pid server that still
# won't answer `/health` (process up, endpoint deaf).
ALL_STARTS="$(grep '"event":"server_started"' "$CHANNEL_LOG" 2>/dev/null || true)"
[ -n "$ALL_STARTS" ] || exit 0

PORT=""
HOST=""
while IFS= read -r START_LINE; do
  [ -n "$START_LINE" ] || continue
  CAND_PID="$(printf '%s' "$START_LINE" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
  [ -n "$CAND_PID" ] || continue
  kill -0 "$CAND_PID" 2>/dev/null || continue
  if [ -r "/proc/$CAND_PID/cmdline" ]; then
    tr '\0' ' ' <"/proc/$CAND_PID/cmdline" 2>/dev/null | grep -q 'macf-channel-server' || continue
  fi
  CAND_PORT="$(printf '%s' "$START_LINE" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
  CAND_HOST="$(printf '%s' "$START_LINE" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')"
  [ -n "$CAND_PORT" ] && [ -n "$CAND_HOST" ] || continue
  PORT="$CAND_PORT"
  HOST="$CAND_HOST"
done <<STARTLINES
$ALL_STARTS
STARTLINES

# No `server_started` line had a confirmable-live pid → fail open (see the
# comment above — this is the expected transient shape, not a hazard).
[ -n "$PORT" ] && [ -n "$HOST" ] || exit 0

# ── mTLS cert paths (claude.sh's env.certs exports these; see
# plugin/lib/probe-peer-health.ts for the identical peer-ping usage).
# Missing/unreadable → can't probe → fail open.
CA_CERT="${MACF_CA_CERT:-}"
AGENT_CERT="${MACF_AGENT_CERT:-}"
AGENT_KEY="${MACF_AGENT_KEY:-}"
if [ -z "$CA_CERT" ] || [ ! -r "$CA_CERT" ] || \
   [ -z "$AGENT_CERT" ] || [ ! -r "$AGENT_CERT" ] || \
   [ -z "$AGENT_KEY" ] || [ ! -r "$AGENT_KEY" ]; then
  exit 0
fi

command -v curl >/dev/null 2>&1 || exit 0

# ── Stamp the throttle NOW (right before the actual probe), so a hung/slow
# curl below still bounds the frequency of the NEXT invocation, and so a
# SessionStart-triggered check (which bypassed the gate above) starts the
# window for the UserPromptSubmit calls that follow it.
mkdir -p "$THROTTLE_DIR" 2>/dev/null || true
if [ -n "$NOW_EPOCH" ]; then
  printf '%s' "$NOW_EPOCH" >"$THROTTLE_FILE" 2>/dev/null || true
fi

# ── The actual liveness probe — retry-before-DEAD (groundnuty/macf#765) ─────
# A single transient failure must NOT produce the maximally-loud DEAD verdict
# — only a SUSTAINED failure across every attempt does. The happy path (any
# attempt returns 2xx) exits immediately with zero added latency; only a
# fully-dead channel-server pays for the full retry budget.
CURL_TIMEOUT_SECS="${MACF_CHANNEL_ALIVE_CURL_TIMEOUT_SECS:-8}"
case "$CURL_TIMEOUT_SECS" in
  '' | *[!0-9]*) CURL_TIMEOUT_SECS=8 ;;
esac

RETRIES="${MACF_CHANNEL_ALIVE_RETRIES:-3}"
case "$RETRIES" in
  '' | *[!0-9]*) RETRIES=3 ;;
esac
# A zero/blank-after-guard value would skip the loop body entirely and fall
# through to the DEAD verdict WITHOUT ever probing — that's a false alarm,
# not a fail-open. Floor it at 1.
[ "$RETRIES" -ge 1 ] || RETRIES=3

RETRY_DELAY_SECS="${MACF_CHANNEL_ALIVE_RETRY_DELAY_SECS:-1}"
case "$RETRY_DELAY_SECS" in
  '' | *[!0-9]*) RETRY_DELAY_SECS=1 ;;
esac

HEALTH_URL="https://${HOST}:${PORT}/health"

ATTEMPT=1
HTTP_CODE="000"
while [ "$ATTEMPT" -le "$RETRIES" ]; do
  TMP_BODY="$(mktemp 2>/dev/null || true)"
  [ -n "$TMP_BODY" ] || exit 0

  # curl's own `%{http_code}` prints "000" when no HTTP response was received
  # at all (connection refused / timeout / TLS failure) — it prints that AND
  # still exits non-zero, so `|| echo "000"` here would DOUBLE it into "000000"
  # (curl's own "000" plus the fallback's). `|| true` just neutralizes curl's
  # exit status for `set -e` purposes without adding a second stdout write; the
  # empty-string case below (curl killed by a signal before writing anything)
  # is the actual belt-and-suspenders backstop.
  HTTP_CODE="$(curl -sS -o "$TMP_BODY" -w '%{http_code}' -m "$CURL_TIMEOUT_SECS" \
    --cacert "$CA_CERT" --cert "$AGENT_CERT" --key "$AGENT_KEY" \
    "$HEALTH_URL" 2>/dev/null || true)"
  rm -f "$TMP_BODY" 2>/dev/null || true
  [ -z "$HTTP_CODE" ] && HTTP_CODE="000"

  case "$HTTP_CODE" in
    2??)
      # Alive on this attempt. No output — no noise on the happy path. Stop
      # immediately; a single success is sufficient, no need to burn the
      # remaining retry budget.
      exit 0
      ;;
  esac

  # Not alive on this attempt. Unless this was the last one, wait a short
  # beat and try again — only a failure sustained across EVERY attempt is
  # reported below.
  if [ "$ATTEMPT" -lt "$RETRIES" ] && [ "$RETRY_DELAY_SECS" -gt 0 ]; then
    sleep "$RETRY_DELAY_SECS" 2>/dev/null || true
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

# Every attempt failed — the CONFIRMED-sustained case. Report LOUD (wording
# intentionally NOT softened here: this verdict now means "sustained across
# $RETRIES consecutive probes", which is meaningfully stronger evidence than
# the single-sample verdict this hook used to fire on).
DETAIL="unexpected HTTP ${HTTP_CODE} from ${HEALTH_URL} (after ${RETRIES} attempts)"
[ "$HTTP_CODE" = "000" ] && DETAIL="connection to ${HEALTH_URL} failed (refused/timeout/TLS error) after ${RETRIES} attempts"
cat <<WARN
⚠️  YOUR CHANNEL-SERVER IS DEAD (groundnuty/macf#734) — you are DEAF to ALL
routed issues, PRs, reviews, and @mentions.

${RETRIES} consecutive liveness probes to this agent's own channel-server
(${HEALTH_URL}) did NOT succeed: ${DETAIL}. The channel-server process is the
delivery path for BOTH native channel-push AND the tmux-wake fallback
(silent-fallback-hazards.md Instance 15) — when it is down, every routed
notification is silently dropped, and the Claude Code TUI itself shows
nothing wrong (it's a separate process; this is exactly how one agent's dead
channel-server went unnoticed for ~55 minutes).

Do NOT assume "no pings = nothing to do" — that assumption is exactly what a
dead channel-server breaks. Assert GitHub state directly (gh issue/pr list,
review-sweep, gate-sweep) instead of waiting for a ping (coordination.md
§Communication 5).

TELL THE OPERATOR your channel-server is down so it can be restarted — this
guard is observational-only (DR-023 §UC-3) and cannot restart it for you.

Silence: MACF_SKIP_CHANNEL_ALIVE_CHECK=1.
WARN
exit 0
