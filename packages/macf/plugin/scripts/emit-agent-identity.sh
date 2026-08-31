#!/usr/bin/env bash
#
# emit-agent-identity.sh — Claude Code SessionStart hook (groundnuty/macf#664)
# that surfaces THIS agent's own identity as context on EVERY session start —
# including a `claude -c` RESUME, not only a genuinely fresh start.
#
# THE GAP THIS CLOSES (#664): an agent's name/role/project were never in any
# auto-loaded context — only in runtime artifacts (`.macf/macf-agent.json`,
# the `MACF_*` env vars `claude.sh` sources from `env.identity`). The bridge
# from file/env into context was previously an ACTION —
# `coordination.md`'s "sanity-check your identity at session start" nudge,
# pointing at `macf-whoami.sh` — that a genuinely fresh session naturally
# performs (nothing else to do at turn 1) but a RESUMED session, already mid
# an existing conversation with no fresh-start trigger, never runs. Identity
# was therefore a runtime lookup a resumed session simply skipped, not
# something that failed to load. Observed live on the `icsoc-2026` fleet:
# a fresh agent self-identified correctly; two `claude -c`-resumed peers in
# the same fleet could tell they were "part of a fleet" but not *which*
# agent. This hook closes the gap by injecting identity DECLARATIVELY at
# every `SessionStart` (see "deliberately matcher-less" below) instead of
# depending on an agent-initiated action.
#
# CORRECTION (#664 comment, live during the ppam-2026 promotion — BINDING,
# not merely informative): `macf-whoami.sh` is NOT an identity reporter. It
# confirms a TOKEN's ATTRIBUTION (a `ghs_` bot installation token vs a
# `gho_`/`ghp_` user token, and for a user token, the login) — it does not
# name the agent (no project / agent_name / role / routing_label). An agent
# told to "run macf-whoami.sh and operate as that agent" correctly pushed
# back: the output never contains an agent name. This hook therefore NEVER
# invokes `macf-whoami.sh` — identity comes exclusively from the two sources
# below. `macf-whoami.sh` keeps its existing job (token-attribution
# sanity-check); this hook does not replace it, because it answers a
# different question.
#
# AUTHORITATIVE SOURCES, in priority order — both are the "authoritative
# identity" per the #664 comment, not source-then-fallback-of-last-resort:
#
#   1. `.macf/macf-agent.json` — `project` / `agent_name` / `agent_role` /
#      `routing_label` / `github_app.bot_login`. Present for `macf init`'d
#      consumer workspaces AND every permanent hand-wired substrate
#      workspace verified live (code-agent's own `.macf/macf-agent.json`
#      carries all of these). Always 2-space `JSON.stringify(cfg, null, 2)`
#      pretty-printed (`config.ts::writeAgentConfig`) — one `"key": "value"`
#      pair per line — which is what makes the line-based bash extraction
#      below (no `jq`/`node` dependency) reliable rather than a hack: this
#      is not a general JSON parser, it is a parser for exactly the shape
#      this repo's own writer produces.
#
#   2. `MACF_PROJECT` / `MACF_AGENT_NAME` / `MACF_AGENT_ROLE` /
#      `MACF_ROUTING_LABEL` env — sourced by `claude.sh` from
#      `.claude/.macf/env.identity` before it execs `claude`, so this hook's
#      own child process inherits them regardless of whether
#      `macf-agent.json` is present. This is the ONLY source for a
#      `git worktree add` linked-worktree worker
#      (`Agent(isolation:"worktree")`, `agent-identity.md` "Parallel Issue
#      Execution with Teams"): `.macf/` is workspace-local + gitignored
#      (`check-framework-surface.sh`'s own WORKTREE FALSE-ALARM GUARD), so a
#      worker's checkout never has it — yet the worker inherits the
#      spawning session's `MACF_*` env byte-for-byte (verified live,
#      groundnuty/macf#1042). Env is a REAL identity signal there, not a
#      degraded fallback.
#
# HONEST-UNKNOWN FLOOR (required, not incidental): neither source resolves
# (both absent, unreadable, or missing a required field) → say so EXPLICITLY
# and NAME NO GUESSED IDENTITY. Never falls back to the workspace directory
# name, the tmux session name, a git remote, or any other inference — a
# confidently wrong identity is worse than an admitted unknown: an agent
# that believes it is the wrong peer can misroute delegated work,
# mis-attribute its own actions, or violate `coordination.md`'s
# one-agent-per-issue rule, none of which self-correct the way "I don't
# know, let me check" does.
#
# DELIBERATELY MATCHER-LESS (same posture as check-framework-surface.sh):
# fires on every `SessionStart` — `startup`, `resume`, `clear`, `compact`,
# `fork` — because #664's entire gap was resume-only identity. Unlike
# `macf-startup-pickup.sh` (narrowed to `matcher: "startup"` by #930, since
# an unwanted work-pickup PROMPT SUBMISSION mid-compaction or inside a
# subagent is actively harmful), this hook only ever DEPOSITS a context
# string — there is no submit step, no subagent-targeting concern, and the
# whole point is to also cover the sources #930 excludes there.
#
# NO "BARE CHECKOUT" NOISE CONCERN (unlike check-framework-surface.sh, which
# gates on a managed-workspace guard before evaluating): this script ships
# in the plugin (`${CLAUDE_PLUGIN_ROOT}/scripts/`) and only ever runs in a
# workspace that has the macf plugin mounted via `--plugin-dir` — i.e.
# already a genuine macf-agent context. A plain non-macf Claude Code project
# never loads this hook at all, so there is nothing to guard against.
#
# Hook contract (SessionStart): JSON on stdin (drained, unused — this hook
# deliberately does not discriminate by `source`, see above). STDOUT is
# injected into the agent's context on exit 0 (same mechanism
# check-framework-surface.sh / check-channel-alive.sh use). NEVER blocks the
# session: an internal fault below the trap falls through to the
# honest-unknown message, not to a crash or to silence.
#
# Override: MACF_SKIP_IDENTITY_CHECK=1.
#
# Refs: groundnuty/macf#664 (this hook) + its binding correction comment;
#       groundnuty/macf#671 (identity must be re-established on PROMOTION,
#       not only on first init — this hook re-reads both sources fresh every
#       session, so a promoted identity is picked up on the very next
#       resume/relaunch with no extra work); DR-026 (auditor propose-only —
#       identity is informational for every role, no role gate needed here).
set -uo pipefail
trap 'exit 0' ERR

if [ "${MACF_SKIP_IDENTITY_CHECK:-}" = "1" ]; then
  exit 0
fi

# Drain + ignore the SessionStart payload — no field needed; this hook fires
# on every source deliberately (see file header). Never block on stdin.
cat >/dev/null 2>&1 || true

WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"

# _json_str_field <file> <key> — extract the first `"<key>": "<value>"`
# occurrence from a 2-space pretty-printed JSON file (one key per line — see
# the file header for why this is safe rather than a hack). Prints nothing
# (not an error) when the key is absent or the file can't be read.
#
# ALWAYS returns 0, even on a no-match `grep` — a field being legitimately
# absent (an optional field like `routing_label`, or a required field
# missing from a malformed file) is an expected OUTCOME this script branches
# on, not a script fault. Under this file's `set -o pipefail` +
# `trap 'exit 0' ERR`, a bare no-match `grep` inside the pipe would otherwise
# propagate as pipeline failure and fire the ERR trap — silently short-
# circuiting the WHOLE hook (no identity, no honest-unknown message either)
# on the very first optional field that happened to be absent. Caught live
# while smoke-testing this script against a fixture missing `routing_label`.
_json_str_field() {
  { grep -m1 "\"$2\"[[:space:]]*:[[:space:]]*\"" "$1" 2>/dev/null \
    | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; } || true
}

PROJECT=""
AGENT_NAME=""
AGENT_ROLE=""
ROUTING_LABEL=""
BOT_LOGIN=""
IDENTITY_SOURCE=""

# --- Source 1: .macf/macf-agent.json ---------------------------------------
if [ -n "$WORKSPACE" ]; then
  AGENT_JSON="$WORKSPACE/.macf/macf-agent.json"
  if [ -f "$AGENT_JSON" ] && [ -r "$AGENT_JSON" ]; then
    FILE_PROJECT="$(_json_str_field "$AGENT_JSON" project)"
    FILE_AGENT_NAME="$(_json_str_field "$AGENT_JSON" agent_name)"
    FILE_AGENT_ROLE="$(_json_str_field "$AGENT_JSON" agent_role)"
    # project/agent_name/agent_role are non-optional per MacfAgentConfigSchema
    # (config.ts) — treat the file as unusable (fall through to env) rather
    # than emit a partial identity if any of the three required fields
    # didn't parse.
    if [ -n "$FILE_PROJECT" ] && [ -n "$FILE_AGENT_NAME" ] && [ -n "$FILE_AGENT_ROLE" ]; then
      PROJECT="$FILE_PROJECT"
      AGENT_NAME="$FILE_AGENT_NAME"
      AGENT_ROLE="$FILE_AGENT_ROLE"
      ROUTING_LABEL="$(_json_str_field "$AGENT_JSON" routing_label)"
      BOT_LOGIN="$(_json_str_field "$AGENT_JSON" bot_login)"
      IDENTITY_SOURCE="macf-agent.json"
    fi
  fi
fi

# --- Source 2: the MACF_* environment (claude.sh / env.identity) -----------
# Only consulted when source 1 didn't resolve — but this is priority, not
# fallback-of-last-resort: for a linked-worktree worker this IS the
# authoritative source (see file header).
if [ -z "$IDENTITY_SOURCE" ]; then
  if [ -n "${MACF_PROJECT:-}" ] && [ -n "${MACF_AGENT_NAME:-}" ] && [ -n "${MACF_AGENT_ROLE:-}" ]; then
    PROJECT="$MACF_PROJECT"
    AGENT_NAME="$MACF_AGENT_NAME"
    AGENT_ROLE="$MACF_AGENT_ROLE"
    ROUTING_LABEL="${MACF_ROUTING_LABEL:-}"
    IDENTITY_SOURCE="the MACF_* environment"
  fi
fi

# --- Emit --------------------------------------------------------------
if [ -n "$IDENTITY_SOURCE" ]; then
  EFFECTIVE_ROUTING_LABEL="${ROUTING_LABEL:-$AGENT_NAME}"
  {
    printf 'You are the MACF agent "%s" (role: %s) in project "%s".\n' "$AGENT_NAME" "$AGENT_ROLE" "$PROJECT"
    printf 'Routing label: %s.\n' "$EFFECTIVE_ROUTING_LABEL"
    if [ -n "$BOT_LOGIN" ]; then
      printf 'GitHub bot identity: %s.\n' "$BOT_LOGIN"
    fi
    printf '(identity source: %s — not macf-whoami.sh, which only confirms token attribution, see groundnuty/macf#664)\n' "$IDENTITY_SOURCE"
    printf 'Run `macf whoami` for the full self-discovery report (registry, cert CN+expiry, versions, token type).\n'
  } 2>/dev/null || true
else
  cat <<'UNKNOWN'
[macf] Agent identity could not be determined — neither .macf/macf-agent.json
nor the MACF_PROJECT/MACF_AGENT_NAME/MACF_AGENT_ROLE environment resolved a
complete identity for this workspace. This workspace does NOT know which
MACF agent it is. Do not assume an identity from the directory name, the
tmux session name, or a GH token (macf-whoami.sh confirms token attribution
only — it does not name an agent). If this is unexpected, run `macf whoami`
or `macf doctor` or inspect `.macf/macf-agent.json` directly.
UNKNOWN
fi

exit 0
