#!/usr/bin/env bash
#
# harvest-reflection.sh — Claude Code PreCompact hook that harvests a *staged*
# reflection the agent maintains (`.claude/.macf/reflections/pending.json`),
# wraps it in the versioned reflection-schema envelope (groundnuty/macf#500,
# DR-026 F2 — see @groundnuty/macf-core `reflection.ts`), appends it as one
# line to a local JSONL ledger, and clears the stage. Local + cheap; F4's
# Monitor reads the ledger back.
#
# Hook contract (PreCompact): JSON on stdin carrying `session_id`,
# `transcript_path?`, `cwd`, `hook_event_name="PreCompact"`, `trigger`
# ("auto"|"manual"), `permission_mode`, `effort`. Registration is matcher-less.
# `$CLAUDE_PROJECT_DIR` is available.
#
# MACF doctrine (DR-023 §UC-3): observational + NON-BLOCKING. This hook ALWAYS
# `exit 0` — a non-zero exit would delay/block compaction and harm the operator.
# Every risky step is guarded (`|| true`) so an internal failure still emits a
# (possibly mechanical-only) record OR, worst case, exits 0 cleanly. There is
# NO `exit 2` anywhere. Fast + local (<100ms target; 30s hard timeout); no
# network.
#
# Override: MACF_SKIP_REFLECTION_HARVEST=1 bypasses (consistent with the
# MACF_SKIP_* hook family).
set -uo pipefail

# Final safety net: any genuinely unexpected fault past this point must NOT
# brick compaction. Fail open (exit 0), same posture as check-gh-attribution.sh.
trap 'exit 0' ERR

# Cheap operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_REFLECTION_HARVEST:-}" == "1" ]]; then
  exit 0
fi

# ── Read the PreCompact payload (all defensive: never fail on bad input) ──────
INPUT_JSON="$(cat 2>/dev/null || echo '')"
SESSION_ID="$(jq -r '.session_id // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
TRIGGER="$(jq -r '.trigger // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
PAYLOAD_CWD="$(jq -r '.cwd // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# `compaction_type` is the payload trigger when it's a known value, else null.
# Emitted as a JSON literal for `--argjson`: a quoted string ("auto"/"manual")
# or the bare null literal.
case "$TRIGGER" in
  auto|manual) COMPACTION_TYPE="\"$TRIGGER\"" ;;
  *)           COMPACTION_TYPE="null" ;;
esac

# ── Resolve the reflections dir + the staged pending file ─────────────────────
BASE_DIR="${CLAUDE_PROJECT_DIR:-$PAYLOAD_CWD}"
[[ -z "$BASE_DIR" ]] && BASE_DIR="."
DIR="$BASE_DIR/.claude/.macf/reflections"
PENDING="$DIR/pending.json"
mkdir -p "$DIR" 2>/dev/null || true

# ── Agent identity from the claude.sh-exported env (graceful when unset) ──────
AGENT_NAME="${MACF_AGENT_NAME:-}"
AGENT_ROLE="${MACF_AGENT_ROLE:-}"
PROJECT="${MACF_PROJECT:-}"
# Derive the bot login from the agent name: `<name>[bot]`, or empty if unknown.
if [[ -n "$AGENT_NAME" ]]; then
  AGENT_LOGIN="${AGENT_NAME}[bot]"
else
  AGENT_LOGIN=""
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"

# ── Read the staged reflection fields (each defaulted if absent/invalid) ──────
# Default to an empty stage object; only overwrite if pending.json is valid
# JSON. This yields a mechanical-only record when there's no (or a broken)
# stage — still emitted so the Monitor sees the compaction.
STAGE_JSON='{}'
if [[ -f "$PENDING" ]]; then
  if _stage="$(jq -c '.' "$PENDING" 2>/dev/null)" && [[ -n "$_stage" ]]; then
    STAGE_JSON="$_stage"
  fi
fi

# ── Build the envelope record with jq, merging the staged fields ──────────────
# Each staged array/string is defaulted inside jq so a partial stage is valid.
# `--argjson compaction_type` carries either a quoted string ("auto"/"manual")
# or the bare literal null.
RECORD="$(
  jq -cn \
    --arg schema_version "1.0" \
    --arg kind "macf.reflection" \
    --arg name "$AGENT_NAME" \
    --arg role "$AGENT_ROLE" \
    --arg login "$AGENT_LOGIN" \
    --arg project "$PROJECT" \
    --arg session_id "$SESSION_ID" \
    --arg timestamp "$TIMESTAMP" \
    --argjson compaction_type "$COMPACTION_TYPE" \
    --argjson stage "$STAGE_JSON" \
    '{
      schema_version: $schema_version,
      kind: $kind,
      agent: { name: $name, role: $role, login: $login },
      project: $project,
      session_id: $session_id,
      timestamp: $timestamp,
      trigger: "pre-compact",
      compaction_type: $compaction_type,
      observed_patterns:      ($stage.observed_patterns      // []),
      breaches:               ($stage.breaches               // []),
      rule_evolution_signals: ($stage.rule_evolution_signals // []),
      unresolved:             ($stage.unresolved             // []),
      synthesis:              ($stage.synthesis              // "")
    }' 2>/dev/null || echo ""
)"

# If even the jq build failed, bail cleanly — never block compaction.
[[ -z "$RECORD" ]] && exit 0

# ── Append the single-line record to the per-session JSONL ledger ─────────────
SAFE_SESSION="$SESSION_ID"
[[ -z "$SAFE_SESSION" ]] && SAFE_SESSION="unknown-session"
LEDGER="$DIR/${SAFE_SESSION}.jsonl"
printf '%s\n' "$RECORD" >>"$LEDGER" 2>/dev/null || true

# ── Clear the stage so the next session starts fresh ──────────────────────────
printf '%s\n' '{}' >"$PENDING" 2>/dev/null || true

exit 0
