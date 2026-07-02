#!/usr/bin/env bash
#
# check-gh-token.sh — Claude Code PreToolUse hook that blocks `gh` and
# `git push` invocations when GH_TOKEN isn't a bot installation token
# (ghs_ prefix). Prevents the attribution trap documented in
# plugin/rules/coordination.md (Token & Git Hygiene) and #140.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). See groundnuty/macf#140 for
# design rationale; 5 recurrences in a single day drove the move from
# behavioral to structural enforcement.
#
# Override: MACF_SKIP_TOKEN_CHECK=1 bypasses (for intentional
# user-attributed ops, e.g. `gh auth login` during onboarding).
set -euo pipefail

# Operator override first — cheapest exit. No stdin read needed.
if [[ "${MACF_SKIP_TOKEN_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read and parse the PreToolUse JSON payload. Fall through to allow on
# parse error — a broken hook must not brick the harness. Claude Code
# emits a well-formed payload in practice; this is defense-in-depth.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Wrapper-aware regex: match `gh ` or `git push ` as the effective
# command, allowing for zero or more of: sudo, env VAR=VAL..., watch,
# ionice, setsid, nice, time. Also triggers when preceded by `;`, `&&`,
# `||`, `|` so chained forms like `make && sudo gh ...` still match.
# Designed per science-agent's #140 review — the naïve anchored regex
# was trivially bypassable by wrappers.
GH_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(gh[[:space:]]|git[[:space:]]+push([[:space:]]|$))'

# Shell-wrapper bypass regex: catches `bash -c "gh ..."`, `sh -c '...'`,
# `zsh -c`, and flag-prefixed forms like `bash -x -c`, `bash -xc`,
# `bash -lc`. The shell's -c flag executes its quoted argument AS A
# COMMAND, so `gh` inside it IS a real invocation — unlike
# `echo "gh is cool"` where the same text is just literal data.
# Without this branch, `bash -c "gh issue close"` was a trivial bypass:
# `bash` isn't in the wrapper allowlist, and `gh` inside the quotes
# isn't preceded by one of the allowed delimiters `[[:space:];|&]`.
# Caught in the post-#140 audit pass, 2026-04-20.
#
# Flag handling: `(-[a-zA-Z]+[[:space:]]+)*` allows zero or more
# separate flag groups like `-x ` or `-e `. Final flag uses
# `-[a-zA-Z]*c` — must end in `c` (the `-c`-ness), optional letters
# before it cover combined forms like `-xc`, `-lc`, `-exc`.
SHELL_C_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*(gh[[:space:]]|git[[:space:]]+push([[:space:]]|$))'

if [[ ! "$COMMAND" =~ $GH_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_PATTERN ]]; then
  # Not a gh/git-push command — allow without checking token.
  exit 0
fi

# `gh auth *` is identity-management (login, logout, status, token,
# refresh, setup-git) — user-attribution is correct by design here.
# Blanket-blocking this subcommand would put the hook directly in the
# onboarding path (fresh workspace → first `gh auth login` → wall of
# error text), which is exactly the wrong user experience. Carve it
# out. Wrapper forms (`sudo gh auth ...`) also match because the regex
# allows arbitrary wrapper prefix before `gh`.
if [[ "$COMMAND" =~ (^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+auth([[:space:]]|$) ]]; then
  exit 0
fi

# Check GH_TOKEN: must be present AND match the bot-token shape
# ^ghs_[A-Za-z0-9_]+$. Prefix-only check (`${GH_TOKEN:0:4} == ghs_`)
# was bypassable by `GH_TOKEN='ghs_; rm -rf <sentinel>'` — the first
# four chars matched, the rest never validated. Surfaced as Pattern B's
# 1/10 anomaly in the §4.4 failure-injection sprint (paper-research §27);
# canonical-rule update in #364, this script in #365.
# ghp_/gho_/ghu_ are user tokens; empty falls through to stored
# `gh auth login` (user). Either case fires the trap.
# Note: `${GH_TOKEN:-}` expansion is mandatory under `set -u`; a bare
# `${GH_TOKEN:0:4}` errors with "unbound variable" when the env var
# is unset, which is exactly the case we need to handle.
GH_TOKEN_VALUE="${GH_TOKEN:-}"
TOKEN_PREFIX="${GH_TOKEN_VALUE:0:4}"
if [[ -z "$GH_TOKEN_VALUE" ]] || [[ ! "$GH_TOKEN_VALUE" =~ ^ghs_[A-Za-z0-9_]+$ ]]; then
  cat >&2 <<ERR
BLOCKED by MACF attribution-trap hook: this command would post as the USER, not the BOT.

Command: ${COMMAND}
GH_TOKEN prefix: ${TOKEN_PREFIX:-(empty)}

This hook exists because behavioral controls for the GH_TOKEN attribution
trap recurred 5 times in a single day. See groundnuty/macf#140 and
.claude/rules/coordination.md (Token & Git Hygiene).

Fix — refresh the bot token via the fail-loud helper:

  GH_TOKEN=\$(./.claude/scripts/macf-gh-token.sh \\
    --app-id "\$APP_ID" --install-id "\$INSTALL_ID" --key "\$KEY_PATH") || exit 1
  export GH_TOKEN

If the helper is missing, restore it:
  macf rules refresh --dir .

Override (ONLY for intentional user-attributed ops like onboarding):
  export MACF_SKIP_TOKEN_CHECK=1
ERR
  exit 2
fi

# -----------------------------------------------------------------------
# DR-019 Amendment A (#381) — actions:write audit-log emission
# -----------------------------------------------------------------------
# Token-shape check passed; if the command is an `actions:write`-scoped
# subcommand class, emit OTel span + counter signals BEFORE allowing the
# call through. Observational only — emission failure must NOT block the
# call. The only block path is the token-shape check above.
#
# Subcommand classes (per DR-019 Amendment A "Pattern-match comprehensiveness"):
#
#   - Workflow lifecycle:  `gh workflow run`     → action=dispatch
#                          `gh workflow disable` → action=dispatch
#                          `gh workflow enable`  → action=dispatch
#   - Run lifecycle:       `gh run cancel`       → action=cancel
#                          `gh run rerun`        → action=rerun
#                          `gh run rerun --failed` → action=rerun
#   - API-direct (POST):   `gh api .../actions/workflows/.../dispatches`
#                          → action=dispatch
#                          `gh api .../actions/runs/{id}/cancel`
#                          → action=cancel
#                          `gh api .../actions/runs/{id}/rerun`
#                          → action=rerun
#                          `gh api .../actions/runs/{id}/rerun-failed-jobs`
#                          → action=rerun
#
# Known instrumentation gaps (per DR-019 Amendment A "Known instrumentation
# gaps" + science-agent forward-looking note): this PreToolUse hook catches
# every LLM-issued Bash call to `gh`. It does NOT catch non-Bash subprocess
# paths from compiled JS/TS (e.g., a hypothetical
# `child_process.spawn('gh', [...])` from a Node.js channel-server module),
# nor direct `curl` to GitHub's REST API from such paths. Current MACF
# architecture has no such paths — `notify_peer` is the only non-Bash
# subprocess call from compiled code, and it talks to peer agents' `/notify`
# endpoints (not GitHub). If a non-Bash-`gh` subprocess path emerges later,
# instrument THEN — YAGNI for current scope.

# Dispatch-allowlist regex. Per DR-019 Amendment A, the allowlist governs
# `dispatch` actions only — `cancel` / `rerun` operate on runs (not workflows)
# and emit audit-log unconditionally. Keep this as a shell variable near
# the top of the audit branch so it's trivial to amend per future DR
# amendments. Match is "workflow filename appears anywhere in the command";
# this is loose by design so wrapper forms / different gh argument orderings
# still match.
MACF_ACTIONS_DISPATCH_ALLOWLIST_REGEX='npm-deprecate\.yml'

_macf_audit_classify_action() {
  # Echo the action class (`dispatch`|`cancel`|`rerun`) for the given
  # command, or empty if it's not an actions:write subcommand.
  local cmd="$1"
  # Workflow lifecycle — `gh workflow run/enable/disable` (require a word
  # boundary after the verb so `gh workflow runs` etc. don't false-match).
  if [[ "$cmd" =~ (^|[[:space:];|&\"\'])gh[[:space:]]+workflow[[:space:]]+(run|enable|disable)([[:space:]]|$|[\"\']) ]]; then
    echo "dispatch"
    return
  fi
  # Run lifecycle — `gh run cancel` / `gh run rerun` (rerun --failed
  # collapses to action=rerun; the dimensionality is action-only, not
  # rerun-variant).
  if [[ "$cmd" =~ (^|[[:space:];|&\"\'])gh[[:space:]]+run[[:space:]]+cancel([[:space:]]|$|[\"\']) ]]; then
    echo "cancel"
    return
  fi
  if [[ "$cmd" =~ (^|[[:space:];|&\"\'])gh[[:space:]]+run[[:space:]]+rerun([[:space:]]|$|[\"\']) ]]; then
    echo "rerun"
    return
  fi
  # API-direct POST paths — `/dispatches` (workflow dispatch),
  # `/cancel` (run cancel), `/rerun` and `/rerun-failed-jobs` (run rerun).
  if [[ "$cmd" =~ gh[[:space:]]+api[[:space:]] ]]; then
    if [[ "$cmd" =~ /actions/workflows/[^[:space:]\"\']+/dispatches ]]; then
      echo "dispatch"
      return
    fi
    if [[ "$cmd" =~ /actions/runs/[^[:space:]/\"\']+/cancel ]]; then
      echo "cancel"
      return
    fi
    if [[ "$cmd" =~ /actions/runs/[^[:space:]/\"\']+/rerun(-failed-jobs)? ]]; then
      echo "rerun"
      return
    fi
  fi
  echo ""
}

_macf_audit_parse_repo() {
  # Extract `<owner>/<repo>` from `--repo owner/repo` or `-R owner/repo`
  # (gh CLI long/short forms) or from `gh api .../repos/<owner>/<repo>/...`.
  # Echoes empty string if no repo can be parsed (the caller logs "unknown").
  local cmd="$1"
  # `--repo owner/repo` form (gh CLI)
  if [[ "$cmd" =~ --repo[[:space:]=]+([A-Za-z0-9._-]+/[A-Za-z0-9._-]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  # `-R owner/repo` short form
  if [[ "$cmd" =~ (^|[[:space:]])-R[[:space:]]+([A-Za-z0-9._-]+/[A-Za-z0-9._-]+) ]]; then
    echo "${BASH_REMATCH[2]}"
    return
  fi
  # `gh api .../repos/<owner>/<repo>/...` form
  if [[ "$cmd" =~ /repos/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  echo ""
}

_macf_audit_parse_workflow() {
  # Extract the workflow filename (`<name>.yml`) for `dispatch` actions.
  # For `gh workflow run <name.yml>` form, take the first .yml/.yaml token
  # after the `workflow run/enable/disable` verb. For `gh api .../actions/
  # workflows/<name.yml>/dispatches` form, parse from the API path. For
  # `cancel`/`rerun` actions, workflow is null (operates on a run-id, not
  # a workflow name).
  local cmd="$1"
  # gh CLI workflow form
  if [[ "$cmd" =~ gh[[:space:]]+workflow[[:space:]]+(run|enable|disable)[[:space:]]+([^[:space:]\"\']+) ]]; then
    local wf="${BASH_REMATCH[2]}"
    # Strip surrounding quotes if any
    wf="${wf#\"}"; wf="${wf%\"}"
    wf="${wf#\'}"; wf="${wf%\'}"
    echo "$wf"
    return
  fi
  # API-direct workflow form
  if [[ "$cmd" =~ /actions/workflows/([^/[:space:]\"\']+)/dispatches ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  echo ""
}

_macf_audit_build_resource_attrs_json() {
  # Build OTLP-shape resource.attributes JSON array from the canonical
  # claude.sh-exported OTel env vars (`OTEL_SERVICE_NAME` +
  # `OTEL_RESOURCE_ATTRIBUTES`). Per macf#388 / observability-wiring.md:
  # claude.sh exports these at session bootstrap as the single source
  # of truth for the agent's identity attrs. The hook silent-skips
  # service.name + gen_ai.* attrs when emitting outside a claude.sh-
  # wrapped session (graceful degradation; returns the empty array).
  #
  # OTEL_RESOURCE_ATTRIBUTES format per OTel spec: comma-separated
  # `key=value` pairs, no quoting. Canonical export:
  #   gen_ai.agent.name=<name>,gen_ai.agent.role=<role>,service.namespace=macf
  local service_name="${OTEL_SERVICE_NAME:-}"
  local resource_attrs="${OTEL_RESOURCE_ATTRIBUTES:-}"
  jq -n \
    --arg service_name "$service_name" \
    --arg resource_attrs "$resource_attrs" \
    '
    (
      if $service_name != ""
      then [{key: "service.name", value: {stringValue: $service_name}}]
      else []
      end
    )
    +
    (
      $resource_attrs
      | split(",")
      | map(select(length > 0))
      | map(split("=") | select(length >= 2 and .[0] != "") | {key: .[0], value: {stringValue: (.[1] // "")}})
    )
    ' 2>/dev/null || echo "[]"
}

_macf_audit_emit() {
  # Emit span + counter for an actions:write-scoped invocation.
  # Observational only — every emission path is best-effort. Failures
  # are swallowed (|| true) so audit-log infrastructure issues never
  # propagate to the actual gh call.
  local action="$1"
  local repo="${2:-unknown}"
  local workflow="${3:-}"

  # Skip silently if observability is opt-out (per CLAUDE.md — OTEL
  # endpoint unset = no observability stack to report to).
  if [[ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
    return 0
  fi

  local actor="${OTEL_RESOURCE_ATTRIBUTES:-}"
  # gen_ai.agent.name lives inside the resource attrs CSV; parse for it.
  if [[ "$actor" =~ gen_ai\.agent\.name=([^,]+) ]]; then
    actor="app/macf-${BASH_REMATCH[1]}"
  else
    actor="app/unknown"
  fi

  # Build url.path / url.full for the audit signal. The HTTP method is
  # POST for every action class in scope (workflow_dispatch POST,
  # run cancel POST, run rerun POST). HTTP semconv canonical attrs.
  local url_path=""
  local url_full=""
  case "$action" in
    dispatch)
      if [[ -n "$workflow" && -n "$repo" && "$repo" != "unknown" ]]; then
        url_path="/repos/${repo}/actions/workflows/${workflow}/dispatches"
      fi
      ;;
    cancel)
      # Run-id is hard to parse generically (positional arg in `gh run cancel`);
      # leave path with placeholder. The action+repo dimensions are the
      # primary alert surface; per-run-id forensics goes via the gh-CLI logs.
      url_path="/repos/${repo}/actions/runs/{id}/cancel"
      ;;
    rerun)
      url_path="/repos/${repo}/actions/runs/{id}/rerun"
      ;;
  esac
  if [[ -n "$url_path" ]]; then
    url_full="https://api.github.com${url_path}"
  fi

  # Lean emission order (DR-019 Amendment A "OTel emission from bash"):
  #   1. otel-cli if installed — preferred, lightweight, well-documented
  #   2. curl OTLP HTTP JSON fallback — works in any env with curl
  # Both paths are observational; failures swallowed.
  if command -v otel-cli >/dev/null 2>&1; then
    _macf_audit_emit_otel_cli "$action" "$repo" "$workflow" "$actor" "$url_path" "$url_full" 2>/dev/null || true
  else
    _macf_audit_emit_curl "$action" "$repo" "$workflow" "$actor" "$url_path" "$url_full" 2>/dev/null || true
  fi
}

_macf_audit_emit_otel_cli() {
  # Preferred path: otel-cli for span emission. Note: otel-cli emits
  # spans only (no metrics support as of last check); the counter side
  # falls through to the curl path even when otel-cli is installed.
  local action="$1" repo="$2" workflow="$3" actor="$4" url_path="$5" url_full="$6"
  local attrs="gh.api.scope=actions:write,gh.repo=${repo},gh.action=${action},gh.actor=${actor},http.request.method=POST"
  if [[ -n "$workflow" ]]; then
    attrs="${attrs},gh.workflow=${workflow}"
  fi
  if [[ -n "$url_path" ]]; then
    attrs="${attrs},url.path=${url_path},url.full=${url_full}"
  fi
  otel-cli span \
    --name "macf.app.gh_api_call" \
    --kind client \
    --attrs "$attrs" \
    --service "${OTEL_SERVICE_NAME:-macf-agent}" \
    >/dev/null 2>&1 || true
  # Counter still goes via curl (otel-cli has no metrics emit subcommand).
  _macf_audit_emit_curl_metric "$action" "$repo" "$workflow" 2>/dev/null || true
}

_macf_audit_emit_curl() {
  # Fallback path: curl POST to OTLP HTTP JSON endpoint. Emits both span
  # (/v1/traces) and counter (/v1/metrics).
  local action="$1" repo="$2" workflow="$3" actor="$4" url_path="$5" url_full="$6"
  _macf_audit_emit_curl_span "$action" "$repo" "$workflow" "$actor" "$url_path" "$url_full" || true
  _macf_audit_emit_curl_metric "$action" "$repo" "$workflow" || true
}

_macf_audit_emit_curl_span() {
  local action="$1" repo="$2" workflow="$3" actor="$4" url_path="$5" url_full="$6"
  local endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT%/}"
  # OTLP HTTP JSON: ns since epoch. `date +%s%N` on Linux gives nanos
  # directly. Macs need a fallback but the agent runtime is Linux-only
  # (devbox/devcontainer) per CLAUDE.md.
  local ts_ns
  ts_ns="$(date +%s%N)"
  # Random hex IDs — span IDs are 16 hex chars, trace IDs 32. /dev/urandom
  # is portable; head + xxd would also work but stays jq-clean.
  local trace_id span_id
  trace_id="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32)"
  span_id="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 16)"

  # Build span attrs JSON via jq for safe string escaping (workflow / repo
  # could contain regex-friendly chars; jq handles JSON-encoding correctly).
  # OTel HTTP semconv canonical attrs + MACF governance attrs per DR-019
  # Amendment A "Signal 1 — OTel span" table. Note: http.response.status_code
  # is OMITTED — this is a PRE-tool-use hook; the call hasn't fired yet,
  # so there is no response status to report. Documented as a known gap
  # for the span shape.
  local attrs_json
  attrs_json="$(
    jq -n \
      --arg scope "actions:write" \
      --arg repo "$repo" \
      --arg workflow "$workflow" \
      --arg action "$action" \
      --arg actor "$actor" \
      --arg method "POST" \
      --arg url_path "$url_path" \
      --arg url_full "$url_full" \
      '[
        {key: "gh.api.scope",       value: {stringValue: $scope}},
        {key: "gh.repo",            value: {stringValue: $repo}},
        {key: "gh.action",          value: {stringValue: $action}},
        {key: "gh.actor",           value: {stringValue: $actor}},
        {key: "http.request.method", value: {stringValue: $method}}
      ]
      + ( if $workflow != "" then [{key: "gh.workflow", value: {stringValue: $workflow}}] else [] end )
      + ( if $url_path != "" then [{key: "url.path", value: {stringValue: $url_path}}] else [] end )
      + ( if $url_full != "" then [{key: "url.full", value: {stringValue: $url_full}}] else [] end )' 2>/dev/null
  )" || return 1

  # macf#388: populate resource.attributes from claude.sh's exported
  # OTel env vars so hook-emitted spans match the rest of the MACF
  # stack's service.name / gen_ai.* attrs (instead of falling under
  # `rootServiceName=<root span not yet received>` in Tempo).
  # Graceful degradation: empty array when env unset.
  local resource_attrs_json
  resource_attrs_json="$(_macf_audit_build_resource_attrs_json)"

  local body
  body="$(
    jq -n \
      --arg trace_id "$trace_id" \
      --arg span_id "$span_id" \
      --arg name "macf.app.gh_api_call" \
      --arg ts_ns "$ts_ns" \
      --argjson attrs "$attrs_json" \
      --argjson resource_attrs "$resource_attrs_json" \
      '{
        resourceSpans: [{
          resource: { attributes: $resource_attrs },
          scopeSpans: [{
            scope: { name: "macf" },
            spans: [{
              traceId: $trace_id,
              spanId: $span_id,
              name: $name,
              startTimeUnixNano: $ts_ns,
              endTimeUnixNano: $ts_ns,
              kind: 3,
              attributes: $attrs
            }]
          }]
        }]
      }' 2>/dev/null
  )" || return 1

  # SPAN_KIND_CLIENT = 3 in OTLP proto3 enum encoding.
  # Short timeout so a slow / down collector doesn't delay the gh call.
  curl -sS -m 2 \
    -X POST \
    -H "Content-Type: application/json" \
    --data "$body" \
    "${endpoint}/v1/traces" >/dev/null 2>&1 || return 1
}

_macf_audit_emit_curl_metric() {
  local action="$1" repo="$2" workflow="$3"
  local endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT%/}"
  local ts_ns
  ts_ns="$(date +%s%N)"

  local attrs_json
  attrs_json="$(
    jq -n \
      --arg repo "$repo" \
      --arg action "$action" \
      --arg workflow "$workflow" \
      '[
        {key: "repo",     value: {stringValue: $repo}},
        {key: "action",   value: {stringValue: $action}}
      ]
      + ( if $workflow != "" then [{key: "workflow", value: {stringValue: $workflow}}] else [] end )' 2>/dev/null
  )" || return 1

  # macf#388: same resource-attrs population as the span side, for
  # cross-signal consistency on Tempo / Prometheus aggregation by
  # service.name / gen_ai.* dimensions.
  local resource_attrs_json
  resource_attrs_json="$(_macf_audit_build_resource_attrs_json)"

  local body
  body="$(
    jq -n \
      --arg name "macf.app.gh_actions_write_total" \
      --arg ts_ns "$ts_ns" \
      --argjson attrs "$attrs_json" \
      --argjson resource_attrs "$resource_attrs_json" \
      '{
        resourceMetrics: [{
          resource: { attributes: $resource_attrs },
          scopeMetrics: [{
            scope: { name: "macf" },
            metrics: [{
              name: $name,
              description: "GitHub API actions:write invocations by MACF agent App",
              unit: "1",
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [{
                  asInt: "1",
                  startTimeUnixNano: $ts_ns,
                  timeUnixNano: $ts_ns,
                  attributes: $attrs
                }]
              }
            }]
          }]
        }]
      }' 2>/dev/null
  )" || return 1

  # aggregationTemporality = 1 = DELTA (per macf#281 Phase 2 convention).
  # DELTA is robust to N-process / restart topologies — every emission
  # is an independent delta point; collector aggregates by series identity.
  curl -sS -m 2 \
    -X POST \
    -H "Content-Type: application/json" \
    --data "$body" \
    "${endpoint}/v1/metrics" >/dev/null 2>&1 || return 1
}

# Classify and emit. Note: classification is intentionally permissive —
# wrapper forms (`sudo`, `bash -c "..."`, `GH_TOKEN=x ...`) all flow through
# the same regex because the wrapper-aware GH_PATTERN above already
# tolerates them; classify_action just looks for the `gh <verb>` substring.
_MACF_AUDIT_ACTION="$(_macf_audit_classify_action "$COMMAND")"
if [[ -n "$_MACF_AUDIT_ACTION" ]]; then
  _MACF_AUDIT_REPO="$(_macf_audit_parse_repo "$COMMAND")"
  _MACF_AUDIT_WORKFLOW="$(_macf_audit_parse_workflow "$COMMAND")"
  # Dispatch-allowlist enforcement: emit unconditionally (the audit-log
  # spec wants visibility into ALL dispatches; the allowlist drives the
  # dashboard's "unexpected workflow" alert, not script-side blocking).
  # `cancel` / `rerun` operate on runs not workflows — no allowlist
  # check applies. Future Path-2 promotion may convert this from
  # "always emit, let collector alert" to "warn-but-allow on non-allowlist
  # dispatches"; out of scope for #381 per DR-019 Amendment A § "Dispatch
  # allowlist + addition criteria" (operational alerting lives in
  # macf-devops-toolkit dashboard).
  _macf_audit_emit "$_MACF_AUDIT_ACTION" "$_MACF_AUDIT_REPO" "$_MACF_AUDIT_WORKFLOW" || true
fi

exit 0
