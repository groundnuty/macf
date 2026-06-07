#!/usr/bin/env bash
# UserPromptSubmit hook — turn-ack receipt for routed prompts
# (groundnuty/macf#444 Option D, piece 2).
#
# When the router injects a prompt it appends a correlation marker
# `[macf-route:<run_id>:<agent>]` (macf-actions#45, piece 1). When that prompt
# is submitted AS A TURN, this hook fires and emits a `turn_processed` OTel
# span carrying (routed_run_id, agent). A reconciler (piece 4) joins the
# router's delivered-pairs log against these spans: a delivered route with no
# matching span past the open-threshold = a dropped ping that surfaces
# structurally (closes the #437 send≠receipt gap). A prompt with NO marker
# (a typed prompt, a non-routed turn) is a no-op — exit 0, emit nothing.
#
# Registered `async: true` (settings.json) so it never adds turn latency. It
# NEVER blocks the turn: any failure path exits 0 (with a stderr WARN on a
# genuine emit error — fail-loud per silent-fallback-hazards.md Instance 8).
#
# Dependency: a live OTLP endpoint (OTEL_EXPORTER_OTLP_ENDPOINT — populated on
# substrate by the #418 launcher OTEL block). Absent/unreachable → curl fails
# → WARN, no span, no crash. So this ships safely before #418's relaunch; it
# simply no-ops-with-WARN until substrate OTel is live.
set -uo pipefail

INPUT="$(cat)"

# Extract the submitted prompt text. jq if available; else scan the raw payload.
PROMPT=""
if command -v jq >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null || true)"
fi
[ -z "$PROMPT" ] && PROMPT="$INPUT"

# Route-correlation markers: [macf-route:<digits>:<kebab-agent>]. No match → not
# a routed prompt → no-op. A COALESCED turn (a busy agent processing several
# queued routed pings in one turn) carries MULTIPLE markers — emit a receipt for
# EACH distinct one. A receipt then means "the marked prompt reached the agent",
# not "a distinct turn happened". (Was `head -1`, which under-emitted → the
# macf#444 reconciler false-flagged the un-receipted markers as drops — #462.)
MARKERS="$(printf '%s' "$PROMPT" | grep -oE '\[macf-route:[0-9]+:[a-z0-9-]+\]' | sort -u || true)"
[ -z "$MARKERS" ] && exit 0

# Need curl + openssl to emit; absent → degrade silently (no span, no noise).
command -v curl >/dev/null 2>&1 || exit 0
command -v openssl >/dev/null 2>&1 || exit 0

BASE="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:14318}"
BASE="${BASE%/v1/traces}"

# One independent span per distinct marker (own trace/span id + timestamp).
printf '%s\n' "$MARKERS" | while IFS= read -r MARKER; do
  [ -z "$MARKER" ] && continue
  RUN_ID="$(printf '%s' "$MARKER" | sed -E 's/.*\[macf-route:([0-9]+):([a-z0-9-]+)\].*/\1/')"
  AGENT="$(printf '%s' "$MARKER" | sed -E 's/.*\[macf-route:([0-9]+):([a-z0-9-]+)\].*/\2/')"

  # Nanosecond epoch. `date +%s%N` is GNU-only (substrate is Linux); on a BSD/mac
  # date that prints a literal `N`, fall back to seconds×1e9.
  NOW="$(date +%s%N 2>/dev/null || true)"
  case "$NOW" in
    *N|'' ) NOW="$(( $(date +%s) * 1000000000 ))" ;;
  esac
  TID="$(openssl rand -hex 16)"
  SID="$(openssl rand -hex 8)"

  # Identity on resource attrs (matches the collector's resource/paper-dims +
  # the `{resource."gen_ai.agent.name"=…}` TraceQL); correlation on span attrs.
  curl -sf -m 3 -X POST "${BASE}/v1/traces" \
    -H 'Content-Type: application/json' --data-binary @- <<JSON >/dev/null \
    || echo "WARN: turn_processed span emit failed (endpoint=${BASE}/v1/traces run=${RUN_ID} agent=${AGENT})" >&2
{"resourceSpans":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"${OTEL_SERVICE_NAME:-macf-agent}"}},
  {"key":"gen_ai.agent.name","value":{"stringValue":"${AGENT}"}},
  {"key":"service.namespace","value":{"stringValue":"macf"}}
]},"scopeSpans":[{"scope":{"name":"macf.hook"},"spans":[{
  "traceId":"${TID}","spanId":"${SID}","name":"turn_processed","kind":1,
  "startTimeUnixNano":"${NOW}","endTimeUnixNano":"${NOW}",
  "attributes":[{"key":"routed_run_id","value":{"stringValue":"${RUN_ID}"}},
    {"key":"agent","value":{"stringValue":"${AGENT}"}}],"status":{"code":1}}]}]}]}
JSON
done

exit 0
