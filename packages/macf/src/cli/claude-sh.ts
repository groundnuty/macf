/**
 * Generate and write the per-workspace `claude.sh` launcher. Extracted
 * from `init.ts` so `macf update` can regenerate it when the template
 * changes (see #63 — workspaces init'd on older CLI versions end up
 * with stale launchers and no way to refresh short of re-running init).
 *
 * The launcher carries a "managed file" header telling users not to
 * edit it — same pattern as the rules distribution (#54). `macf update`
 * overwrites unconditionally; user customizations are expected to live
 * elsewhere (e.g., `.claude/settings.local.json` for env tweaks).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MacfAgentConfig } from './config.js';
import { ownerAccountFromRegistry } from './config.js';
import { MCP_SERVER_NAME } from './mcp-json.js';

// ---------------------------------------------------------------------------
// Legacy per-concern emitters (macf#342 PR-B note)
// ---------------------------------------------------------------------------
//
// `registryEnvLines`, `caPathLines`, `githubAppEnvLines`,
// `githubTokenAndIdentityLines`, `settingsGetHelperLines`,
// `otelTelemetryLines` were the file-private emitters that the
// pre-#342 monolithic `generateClaudeSh` composed. PR-A extracted
// equivalents into `env-files.ts` (`generateEnvRegistry`,
// `generateEnvCerts`, `generateEnvGitHub`, etc.) and PR-B refactored
// `generateClaudeSh` to a thin source-then-exec template — so these
// helpers are no longer called from inside this file.
//
// They're still EXPORTED (rather than deleted in PR-B) so PR-C's
// migration tooling can detect a legacy monolithic claude.sh by
// matching against their output (or call them as a regression-shape
// reference). PR-D removes them once PR-C migration ships.
//
// `otelTelemetryLines` stays internally needed too (claude-sh.test.ts
// asserts on its output as the canonical reference shape pre-migration).

/**
 * Emit shell `export MACF_REGISTRY_*` lines matching the registry
 * scope in `cfg`. The plugin's `src/config.ts` reads these three env
 * vars (MACF_REGISTRY_TYPE + per-type ORG / USER / REPO) on startup;
 * without them the plugin falls back to a hardcoded default repo and
 * 403s every registry op on consumers in other scopes. See macf#178.
 *
 * Exhaustive switch on the discriminated union — if a new RegistryConfig
 * variant is ever added, TypeScript fails the build here, forcing a
 * paired env-line update.
 */
export function registryEnvLines(cfg: MacfAgentConfig): string[] {
  switch (cfg.registry.type) {
    case 'repo':
      return [
        `export MACF_REGISTRY_TYPE="repo"`,
        `export MACF_REGISTRY_REPO="${cfg.registry.owner}/${cfg.registry.repo}"`,
      ];
    case 'org':
      return [
        `export MACF_REGISTRY_TYPE="org"`,
        `export MACF_REGISTRY_ORG="${cfg.registry.org}"`,
      ];
    case 'profile':
      return [
        `export MACF_REGISTRY_TYPE="profile"`,
        `export MACF_REGISTRY_USER="${cfg.registry.user}"`,
      ];
    case 'local':
      // DR-024 / macf#322 PR-B: no-GitHub-mode launcher branch. The
      // channel-server reads MACF_REGISTRY_PATH and dispatches through
      // `createRegistryFromConfig` to LocalRegistryClient. No GitHub
      // App, no token mint. The path was resolved at `macf init --local`
      // time; quoting matches the existing shell-double-quoted template.
      return [
        `export MACF_REGISTRY_TYPE="local"`,
        `export MACF_REGISTRY_PATH="${cfg.registry.path}"`,
      ];
  }
}

/**
 * True when this config runs in local-registry mode (DR-024). Used by
 * the launcher template to short-circuit GitHub-coupled steps (token
 * mint, App env exports, `gen_ai.agent.*` OTel attrs that key off the
 * bot identity).
 */
function isLocalMode(cfg: MacfAgentConfig): boolean {
  return cfg.registry.type === 'local';
}

/**
 * Emit the `macf_settings_get` shell function (macf#313).
 *
 * Reads `.env.<name>` from `<workspace>/.claude/settings.local.json`
 * via `jq`. Returns empty string if the file/key is missing or `jq`
 * isn't installed. Used by the settings-driven identity overrides
 * (see `generateClaudeSh`'s identity block) and the OTel endpoint
 * settings layer.
 *
 * Defined before any caller in the generated script. Idempotent —
 * calling it with no settings.local.json present is safe (just returns
 * empty).
 */
export function settingsGetHelperLines(): string[] {
  return [
    '',
    '# Settings-driven identity helper (macf#313). Reads `.env.<NAME>` from',
    '# .claude/settings.local.json via jq; returns empty string if file/key',
    '# missing or jq absent. Used by the identity-override block below + the',
    '# OTel endpoint settings layer to prefer operator-edited settings.local.json',
    '# over baked defaults, without forcing operators to edit this launcher.',
    'macf_settings_get() {',
    '  local var_name="$1"',
    '  if [ -f "$SCRIPT_DIR/.claude/settings.local.json" ] && command -v jq >/dev/null 2>&1; then',
    '    jq -r ".env.${var_name} // empty" "$SCRIPT_DIR/.claude/settings.local.json" 2>/dev/null',
    '  fi',
    '}',
  ];
}

/**
 * Emit the tmux self-wrap block (macf#313).
 *
 * If `$TMUX` is unset (operator launched outside tmux) AND
 * `MACF_NO_TMUX_WRAP` isn't `1`, the script `exec`s itself inside a
 * tmux session named `<MACF_PROJECT>@<MACF_ROUTING_LABEL>`. Re-attach if
 * the session already exists; otherwise create a new session and exec
 * into it. Eliminates operator-discipline dependency for canonical
 * session naming (coordination.md §Canonical tmux launch pattern).
 *
 * The session keys on `MACF_ROUTING_LABEL` (the registry key / cert CN /
 * DR-031 watchdog + reconcile/resume target), NOT `MACF_AGENT_NAME` (the
 * OTEL display name). For an agent where name != routing_label (e.g.
 * science: name=macf-science-agent, routing_label=science-agent) keying
 * on the agent-name would produce `macf@macf-science-agent`, invisible to
 * the watchdog that targets `macf@science-agent` (macf#678). Where
 * name == routing_label (code/devops/auditor) this is a no-op.
 *
 * Path-2 promotion of the canonical-session-name rule: pre-#313, the
 * rule existed as text-only doc that operators had to manually wrap
 * `tmux new-session -d -s "<project>@<agent>" "./claude.sh"`. Post-#313,
 * bare `./claude.sh` produces the same canonical session structurally.
 *
 * Order requirement: `MACF_PROJECT` and `MACF_ROUTING_LABEL` must be
 * exported before this block (so `$SESSION_NAME` resolves correctly).
 * `generateClaudeSh` orders accordingly — env.identity (which exports
 * both, `MACF_ROUTING_LABEL` defaulting to `MACF_AGENT_NAME`) is sourced
 * by the env.* loop above this block.
 *
 * Opt-out: `MACF_NO_TMUX_WRAP=1 ./claude.sh` for operator-driven manual
 * launches outside tmux (e.g., debug sessions, single-shot CLI use, CI).
 * Sister convention to `MACF_OTEL_DISABLED=1`, `MACF_SKIP_TOKEN_CHECK=1`.
 */
function tmuxSelfWrapLines(): string[] {
  return [
    '',
    '# Tmux self-wrap (macf#313 Path-2 promotion of coordination.md',
    '# §Canonical tmux launch pattern). If launched outside tmux and the',
    '# operator hasn\'t opted out, re-exec inside a tmux session named',
    '# <MACF_PROJECT>@<MACF_ROUTING_LABEL>. Attach if the session exists;',
    '# otherwise create a new one. The second invocation (inside tmux)',
    '# has $TMUX set and skips the wrap.',
    '#',
    '# Env-isolation guarantee (macf#340): when `tmux new-session` runs',
    '# against an already-running tmux server, the new session\'s env is',
    '# initialized from the SERVER\'S GLOBAL env (set once at server',
    '# start), NOT the calling shell\'s env. So a second `./claude.sh`',
    '# from a different workspace would inherit the FIRST agent\'s',
    '# MACF_ROUTING_LABEL from server-global — `${VAR:-default}` shortcut',
    '# preserves the leaked value, causing AGENT_COLLISION on register.',
    '# The `-e VAR=VAL` flags built from MACF_TMUX_PASSTHROUGH below pin',
    '# session-level env that overrides server-global, ensuring this',
    '# workspace\'s identity wins. Array-iteration pattern + unset-guard',
    '# means the var list is single-source-of-truth + adding a new var',
    '# is one line + unset vars (e.g., GH_TOKEN in local mode) skip',
    '# cleanly without breaking generation.',
    '#',
    '# Opt-out: MACF_NO_TMUX_WRAP=1 ./claude.sh',
    '#   For operator-driven manual launches outside tmux, debug sessions,',
    '#   single-shot CLI use, CI environments.',
    'if [ -z "${TMUX:-}" ] && [ "${MACF_NO_TMUX_WRAP:-}" != "1" ]; then',
    '  SESSION_NAME="${MACF_PROJECT}@${MACF_ROUTING_LABEL}"',
    '  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then',
    '    exec tmux attach -t "$SESSION_NAME"',
    '  else',
    '    # Capture every MACF_* env var currently exported in this outer',
    '    # shell + pass each via `-e` to tmux new-session. Pattern-driven',
    '    # rather than hard-coded list: future MACF_* additions are picked',
    '    # up automatically; vars not set at wrap-time (e.g., cert paths',
    '    # exported AFTER this block in the inner re-execed shell) are',
    '    # naturally absent — they are set fresh per invocation, so no',
    '    # leak risk through tmux server-global env. macf#340.',
    '    MACF_TMUX_E_ARGS=()',
    '    while IFS= read -r macf_env_line; do',
    '      MACF_TMUX_E_ARGS+=("-e" "$macf_env_line")',
    '    done < <(env | grep -E "^MACF_" || true)',
    '    exec tmux new-session "${MACF_TMUX_E_ARGS[@]}" -s "$SESSION_NAME" -c "$SCRIPT_DIR" "$0" "$@"',
    '  fi',
    'fi',
  ];
}

/**
 * Emit the channel-notifications enablement block (macf#632).
 *
 * Claude Code v2.1.80+ gates the MCP "channel notifications" push — the async
 * surface that delivers routed coordination notifications to the agent — behind
 * a launch flag. Without it the macf-agent MCP server logs `"Channel
 * notifications skipped: server plugin:macf-agent:macf-agent not in --channels
 * list for this session"` and every routed ping is silently dropped (the
 * fleet-wide failure mode this block fixes).
 *
 * The flag value is the DEV form `--dangerously-load-development-channels
 * server:macf-agent`, NOT plain `--channels plugin:macf-agent:macf-agent`: the
 * `--plugin-dir`-mounted macf-agent plugin (DR-013) is not on Anthropic's
 * curated channel allowlist, so the curated `--channels` flag rejects it; the
 * development-channels dev-flag is the only form that accepts a non-allowlisted
 * plugin server. Verified empirically against claude 2.1.195.
 *
 * The generated block sets `MACF_CHANNELS_ARGS` (expanded UNQUOTED into the
 * `exec claude` line so the two-token flag word-splits into two argv entries)
 * with three escape hatches, in priority order:
 *   - MACF_CHANNELS_DISABLED=1 → empty (no flag); sister to MACF_OTEL_DISABLED.
 *   - a preset MACF_CHANNELS_ARGS in the env → respected verbatim (operator
 *     override; also bypasses the version gate — the operator owns the value).
 *   - else → the canonical dev-flag, GATED on Claude Code >= 2.1.80.
 *
 * Version gate: on a Claude Code older than 2.1.80 (or an unparseable version),
 * the block leaves MACF_CHANNELS_ARGS empty and warns LOUDLY to stderr that
 * channel notifications are unavailable + that an update is needed — rather than
 * passing a flag the older binary would reject and fail the launch on. A parse
 * failure never aborts the launch (warn + proceed).
 *
 * Placed AFTER the tmux self-wrap so only the in-tmux (inner) invocation runs
 * `claude --version`; the outer pre-wrap invocation is replaced by `exec tmux`
 * before reaching here.
 */
function channelNotificationsLines(): string[] {
  return [
    '',
    '# Channel notifications enablement (macf#632). Claude Code v2.1.80+ gates',
    '# the MCP channel-notification push (routed-coordination delivery) behind a',
    '# launch flag; without it the macf-agent MCP server logs "Channel',
    '# notifications skipped: ... not in --channels list" and routed pings are',
    "# silently dropped. The dev-flag form is required because the --plugin-dir",
    "# macf-agent plugin is not on Anthropic's curated channel allowlist.",
    '#',
    '# Escape hatches (priority order): MACF_CHANNELS_DISABLED=1 omits the flag;',
    '# a preset MACF_CHANNELS_ARGS is respected verbatim (and bypasses the',
    '# version gate); else the canonical dev-flag gated on Claude Code >= 2.1.80.',
    '#',
    '# $MACF_CHANNELS_ARGS is expanded UNQUOTED in the exec line below so the',
    '# two-token flag word-splits into two argv entries.',
    '',
    '# Parse the running Claude Code version (X.Y.Z) for the >= 2.1.80 gate. An',
    '# unparseable/absent version is treated as old (flag left off + loud warn).',
    "macf_cc_ver=\"$(claude --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1 || true)\"",
    'macf_channels_supported=0',
    'if [ -n "$macf_cc_ver" ]; then',
    '  macf_cc_major="${macf_cc_ver%%.*}"',
    '  macf_cc_rest="${macf_cc_ver#*.}"',
    '  macf_cc_minor="${macf_cc_rest%%.*}"',
    '  macf_cc_patch="${macf_cc_ver##*.}"',
    '  if [ "${macf_cc_major:-0}" -gt 2 ] \\',
    '     || { [ "${macf_cc_major:-0}" -eq 2 ] && [ "${macf_cc_minor:-0}" -gt 1 ]; } \\',
    '     || { [ "${macf_cc_major:-0}" -eq 2 ] && [ "${macf_cc_minor:-0}" -eq 1 ] && [ "${macf_cc_patch:-0}" -ge 80 ]; }; then',
    '    macf_channels_supported=1',
    '  fi',
    'fi',
    '',
    'if [ "${MACF_CHANNELS_DISABLED:-}" = "1" ]; then',
    '  MACF_CHANNELS_ARGS=""',
    'elif [ -n "${MACF_CHANNELS_ARGS:-}" ]; then',
    '  : # operator-supplied override — respect it verbatim (version gate bypassed)',
    'elif [ "$macf_channels_supported" = "1" ]; then',
    `  MACF_CHANNELS_ARGS="--dangerously-load-development-channels server:${MCP_SERVER_NAME}"`,
    'else',
    '  MACF_CHANNELS_ARGS=""',
    '  echo "WARNING: Claude Code ${macf_cc_ver:-<unknown>} is older than 2.1.80" >&2',
    '  echo "WARNING: (or its version was unparseable) — MACF channel notifications are" >&2',
    '  echo "WARNING: UNAVAILABLE this session; routed issues/PRs/mentions will be SILENTLY" >&2',
    '  echo "WARNING: dropped. Update Claude Code to >= 2.1.80 to enable them." >&2',
    'fi',
  ];
}

/**
 * Emit the interactive-prompt auto-responder start block (DR-033, macf#645).
 *
 * Claude Code introduces interactive LAUNCH prompts with no `-p` bypass (the
 * channels dev-flag ack, the resume-summary choice, more over time). For
 * unattended/cron relaunch (DR-031) — and to spare operators the manual click —
 * `claude.sh` starts `macf-prompt-watcher.sh` in the background right before
 * `exec claude`. The watcher polls THIS tmux pane during the startup window,
 * auto-answers KNOWN ceremony prompts from the allowlist, and — crucially —
 * ALERTs (never answers) an unknown prompt-like frame (Inv 1). See DR-033 for
 * the three constitutional invariants.
 *
 * Placed AFTER the tmux self-wrap so only the in-tmux (inner) invocation starts
 * a watcher — the outer pre-wrap invocation is replaced by `exec tmux` before
 * reaching here, and $TMUX / $TMUX_PANE are only set inside tmux. The watcher is
 * a separate process; it survives the subsequent `exec claude` (exec replaces
 * this shell's image but does not signal its children) and self-terminates when
 * the startup window elapses.
 *
 * Gates:
 *   - MACF_PROMPT_AUTORESPOND_DISABLED=1 → skip (sister to MACF_OTEL_DISABLED /
 *     MACF_CHANNELS_DISABLED). The watcher itself honors the same flag as
 *     defense-in-depth.
 *   - only when $TMUX is set (in-tmux) AND $TMUX_PANE is known — otherwise there
 *     is no deterministic pane to watch (e.g. MACF_NO_TMUX_WRAP launches).
 *   - only when the watcher script exists (older/partial workspaces skip
 *     cleanly).
 */
function promptWatcherLines(): string[] {
  return [
    '',
    '# Interactive-prompt auto-responder (macf#645 / DR-033). Start the pane',
    '# watcher in the background so it can auto-clear KNOWN launch ceremony',
    '# prompts (allowlist-only; unknown prompt-like frames are ALERTed, never',
    '# answered — Inv 1) during the startup window. Only runs in-tmux (a',
    '# deterministic $TMUX_PANE to watch); survives the claude launch below as a',
    '# separate process and self-exits when the window elapses. Opt-out:',
    '# MACF_PROMPT_AUTORESPOND_DISABLED=1 (sister to MACF_OTEL_DISABLED).',
    'if [ "${MACF_PROMPT_AUTORESPOND_DISABLED:-}" != "1" ] \\',
    '   && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] \\',
    '   && [ -x "$SCRIPT_DIR/.claude/scripts/macf-prompt-watcher.sh" ]; then',
    '  "$SCRIPT_DIR/.claude/scripts/macf-prompt-watcher.sh" "$TMUX_PANE" &',
    'fi',
  ];
}

/**
 * Emit the launch-boundary `GH_TOKEN` full-shape validation block (macf#821).
 *
 * **The incident this closes:** a resumed session carried an unexpected-shape
 * `GH_TOKEN` in the claude process env (383 chars — a `ghs_`+fragment with
 * an embedded JWT, inherited from the relaunch/resume path and NOT
 * overwritten by the `env.github` mint). The #140 `check-gh-token.sh`
 * PreToolUse hook correctly hard-blocked every `gh` command — but the
 * session was unrecoverable FROM INSIDE: the hook validates the *ambient*
 * env, so an in-command re-mint can never satisfy it (Bash-tool shells
 * don't persist env back to the hook), and `MACF_SKIP_TOKEN_CHECK=1` is
 * also read from the hook's own env, so it can't be set from inside either.
 * One bad env value at launch = every GitHub op bricked until an
 * operator-side relaunch — a deadlock by construction.
 *
 * **Correction (#825, post-merge same day):** the 383-char value above was
 * NOT corrupt — it was a VALID GitHub App installation token in the new
 * `ghs_<app-id>_<JWT>` format GitHub began rolling out 2026-04-24 (see the
 * `^ghs_[A-Za-z0-9._-]+$` predicate below). The #140 hook's block was a
 * false positive against the old 40-char-only predicate, not a correctly
 * caught corruption. The launch/deadlock mechanics this function defends
 * against are unchanged; only the incident's root cause was reframed.
 *
 * **Pattern B (silent-fallback-hazards.md):** reject/replace the bad shape
 * at the boundary where it enters, so the #140 hook never faces an ambient
 * value the session can't recover from. This is a LAUNCH-time assertion,
 * complementary to (not a replacement for) the #140 hook's own per-command
 * check.
 *
 * **Regex MUST match the #140 hook's predicate exactly**
 * (`check-gh-token.sh`'s `^ghs_[A-Za-z0-9._-]+$`, anchored full-shape — not a
 * prefix check; see #364/#365 on why a prefix-only check is bypassable, and
 * #825/#826 on why the charset — not the length — is the load-bearing
 * invariant: GitHub's own token format changed shape but the injection-safe
 * charset still holds). If this launch check used a looser or different
 * predicate, a token could pass here and still be rejected once inside the
 * session — recreating the exact deadlock this exists to prevent.
 *
 * **Placement (why it must sit here, after `promptWatcherLines()`, right
 * before the final `exec claude` block):** the tmux self-wrap
 * (`tmuxSelfWrapLines()`) `exec`s a brand-new `claude.sh` process inside
 * tmux when it fires — that process re-runs the ENTIRE script from the top,
 * including the `env.*` source loop, so `GH_TOKEN` is re-minted fresh in
 * the tmux-wrapped (inner) invocation. `GH_TOKEN` is NOT among the
 * `MACF_*`-prefixed vars the wrap passes through via `-e` (macf#340), so
 * validating right after the `env.*` loop would run BEFORE the wrap
 * discards that shell's state — checking a value about to be thrown away.
 * Placed here (after the wrap, channel-notifications, and prompt-watcher
 * blocks — mirroring their own "only the in-tmux invocation reaches this
 * point" placement rationale), the check naturally runs exactly ONCE, in
 * whichever invocation is actually about to `exec claude` — the outer
 * (pre-wrap) invocation never reaches this point (it's replaced by `exec
 * tmux ...` first), and the inner/no-wrap invocation reaches it with its
 * own freshly-sourced `env.*` state intact.
 *
 * **App-mode** (`github_app` configured — `APP_ID`/`INSTALL_ID`/`KEY_PATH`
 * exported by `env.github`): a shape mismatch triggers a re-mint via the
 * same fail-loud helper `env.github` itself uses (bare assignment +
 * explicit `|| exit`, never `export GH_TOKEN=$(...)` — that form masks the
 * substitution's exit status per `gh-token-attribution-traps.md` §3 / SC2155
 * and would reintroduce silent-fallback Instance 12 into the launcher
 * itself). If the re-minted value STILL doesn't match, abort LOUDLY before
 * `exec claude` — never start a session the #140 hook will immediately and
 * unrecoverably deadlock.
 *
 * **Local-mode (DR-024):** no App creds exist to re-mint from. A legitimately
 * EMPTY `GH_TOKEN` is fine (local-mode never calls `gh`) — no-op. A
 * non-empty-but-malformed value (the same inherited-not-overwritten class,
 * just with nothing to re-mint against) is cleared with a warning so it
 * can't linger in the exported env.
 */
export function launchTokenValidationLines(config: MacfAgentConfig): string[] {
  if (isLocalMode(config)) {
    return [
      '',
      '# Launch-boundary GH_TOKEN validation (macf#821) — local-registry mode.',
      '# DR-024 local-mode legitimately runs with GH_TOKEN unset (no GitHub App,',
      '# no token mint) — that case is fine, no-op. But a malformed/inherited',
      '# value (e.g. carried in from a resumed/relaunched shell, per the #821',
      "# incident) is still possible even here, and worth clearing — local-mode",
      '# doesn\'t call `gh`, but leaving a malformed value in the exported env is',
      '# pure downside.',
      '# Full-shape check (anchored `^ghs_[A-Za-z0-9._-]+$`), matching the #140',
      '# check-gh-token.sh hook\'s own predicate — NOT a prefix check (#364/#365).',
      '# Charset (not length) is the load-bearing invariant: accepts both the',
      '# old 40-char opaque form AND GitHub\'s new `ghs_<app-id>_<JWT>` format',
      '# (dots/dashes, variable length) while still excluding shell metachars —',
      '# see #825/#826.',
      'if [ -n "${GH_TOKEN:-}" ] && ! [[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9._-]+$ ]]; then',
      '  echo "WARNING: GH_TOKEN is set but malformed in local-registry" >&2',
      '  echo "WARNING: mode (no App creds here to re-mint from) — clearing it." >&2',
      '  unset GH_TOKEN',
      'fi',
    ];
  }

  return [
    '',
    '# Launch-boundary GH_TOKEN validation (macf#821) — Pattern B: reject/replace',
    '# a bad token shape at the boundary where it enters, so the #140',
    '# check-gh-token.sh PreToolUse hook never faces an ambient value the',
    '# session cannot recover from (that hook validates the AMBIENT env only —',
    '# an in-command re-mint can never satisfy it, and its own',
    '# MACF_SKIP_TOKEN_CHECK=1 override is unreachable from inside a bricked',
    '# session either). Validates the FINAL value here, immediately before',
    '# `exec claude` below — regardless of whether GH_TOKEN got that value from',
    '# the env.github mint or an unclobbered inherited value from the',
    '# relaunch/resume path (the observed incident class).',
    '#',
    '# Full-shape check, NOT a prefix check: anchored `^ghs_[A-Za-z0-9._-]+$`,',
    '# matching the #140 hook\'s own predicate exactly (check-gh-token.sh) — the',
    '# launch check and the hook check MUST agree, or a token could pass here',
    '# and still be rejected once inside the session. Charset (not length) is',
    '# the load-bearing invariant: accepts both the old 40-char opaque form',
    '# AND GitHub\'s new `ghs_<app-id>_<JWT>` format (dots/dashes, variable',
    '# length) while still excluding shell metacharacters — see #825/#826.',
    'if ! [[ "${GH_TOKEN:-}" =~ ^ghs_[A-Za-z0-9._-]+$ ]]; then',
    '  echo "WARNING: GH_TOKEN does not match the expected ghs_" >&2',
    '  echo "WARNING: installation-token shape at the launch boundary — re-minting" >&2',
    '  echo "WARNING: before exec." >&2',
    '  GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \\',
    '      --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {',
    '    echo "FATAL: GH_TOKEN re-mint failed at the launch boundary —" >&2',
    '    echo "FATAL: see stderr above. Aborting before exec claude: a bad token" >&2',
    '    echo "FATAL: here would deadlock the gh-token safety hook from INSIDE the session" >&2',
    '    echo "FATAL: (unrecoverable — the hook reads ambient env; its own" >&2',
    '    echo "FATAL: MACF_SKIP_TOKEN_CHECK=1 override cannot be set from a" >&2',
    '    echo "FATAL: Bash-tool shell either). Fix the underlying cause (App" >&2',
    '    echo "FATAL: creds / clock drift / key), then relaunch: ./claude.sh" >&2',
    '    exit 1',
    '  }',
    '  export GH_TOKEN',
    '  if ! [[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9._-]+$ ]]; then',
    '    echo "FATAL: freshly re-minted GH_TOKEN STILL does not match" >&2',
    '    echo "FATAL: the expected shape. Aborting before exec claude rather" >&2',
    '    echo "FATAL: than starting a session the gh-token safety hook would immediately and" >&2',
    '    echo "FATAL: unrecoverably block. Fix the underlying cause, then" >&2',
    '    echo "FATAL: relaunch: ./claude.sh" >&2',
    '    exit 1',
    '  fi',
    'fi',
  ];
}

/**
 * Emit the Claude Code native OTEL telemetry env block into the
 * generated `claude.sh`. Three mandatory gates per Claude Code docs
 * — missing any one of them → zero traces emit:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1       master gate
 *   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1  additional gate (traces are beta)
 *   OTEL_TRACES_EXPORTER=otlp            choose exporter (default is none)
 *
 * See code.claude.com/docs/en/monitoring-usage § Traces (beta).
 *
 * Knobs at `macf init` / `macf update` time (read from calling shell
 * env, NOT persisted to macf-agent.json — observability is a
 * deployment-topology concern, not a per-agent-identity setting):
 *
 *   MACF_OTEL_DISABLED=1       → omit the block entirely. For
 *                                deployments without an observability
 *                                stack; avoids retry-spam to a
 *                                non-existent collector. See macf#197.
 *   MACF_OTEL_ENDPOINT=<url>   → bake a custom default into the
 *                                generated `claude.sh` (template-time
 *                                override). For central obs hosts
 *                                reachable over Tailscale / other
 *                                network paths.
 *
 * Default endpoint is
 * `http://orzech-dev-agents-monitoring.tail491af.ts.net:4318` — the
 * dedicated monitoring VM reached over Tailscale (macf#516, 2026-06-17).
 * The stack moved off the per-host k3d cluster to its own VM, so agents
 * are now cross-VM over the tailnet — `127.0.0.1` no longer reaches the
 * collector. The VM uses OTel-native ports (no `+10000` k3d serverlb
 * offset): OTLP HTTP `:4318`, OTLP gRPC `:4317`, Tempo query `:3200`.
 * The old k3d loopback defaults (the +10000 serverlb ports per
 * macf#418/#282) are DEAD. Aligns with the
 * `MACF_ADVERTISE_HOST ?? '127.0.0.1'` sibling
 * default in this file (advertise-host stays loopback — only the OTLP
 * collector moved off-host).
 *
 * Run-time override: the GENERATED claude.sh emits
 * `${OTEL_EXPORTER_OTLP_ENDPOINT:-<default>}` so a per-launch
 * `OTEL_EXPORTER_OTLP_ENDPOINT=<url>` in the operator's shell wins
 * over the baked default. Two-layer override pattern:
 *   - Template-time (`MACF_OTEL_ENDPOINT` at `macf init` / `macf update`):
 *     bakes a different default into claude.sh
 *   - Run-time (`OTEL_EXPORTER_OTLP_ENDPOINT` before `./claude.sh`):
 *     overrides the baked default for that launch
 *
 * Exported for unit tests.
 *
 * @param env — defaults to `process.env`; tests inject a fake.
 */
export function otelTelemetryLines(
  config: MacfAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env['MACF_OTEL_DISABLED'] === '1' || env['MACF_OTEL_DISABLED'] === 'true') {
    return [];
  }

  const endpoint =
    env['MACF_OTEL_ENDPOINT'] ?? 'http://orzech-dev-agents-monitoring.tail491af.ts.net:4318';

  // The endpoint value gets embedded verbatim in a shell double-
  // quoted export. Reject chars that would break quoting or trigger
  // substitution: `"`, `$`, backtick, backslash, newline. Same
  // allowlist pattern as validateInitOpts on keyPath.
  if (/["$`\\\n\r]/.test(endpoint)) {
    throw new Error(
      `MACF_OTEL_ENDPOINT contains a shell-unsafe character. ` +
        `Got: ${JSON.stringify(endpoint)}. ` +
        `Expected a plain URL like http://host:port.`,
    );
  }

  return [
    '',
    '# macf#197 + macf#245: Claude Code native OTEL telemetry → observability stack.',
    '# Three telemetry signal gates — each independent, ALL required for the',
    '# corresponding signal to emit (per code.claude.com/docs/en/monitoring-usage):',
    '#   CLAUDE_CODE_ENABLE_TELEMETRY        — master telemetry gate (all signals)',
    '#   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA — additional gate for traces (still beta)',
    '#   OTEL_TRACES_EXPORTER=otlp           — emit traces (default: none)',
    '#   OTEL_METRICS_EXPORTER=otlp          — emit metrics (default: none)',
    '#   OTEL_LOGS_EXPORTER=otlp             — emit logs (default: none)',
    '# Without the per-signal exporter env vars, that signal silently emits',
    '# nothing even if the master gate is on (#245 surfaced the metrics+logs',
    '# gap — only traces had the exporter set; metrics + logs were dark).',
    '# Omit the whole block by setting MACF_OTEL_DISABLED=1 at `macf update`',
    '# time — e.g. deployments without the obs stack running locally.',
    '# Endpoint override has two layers (groundnuty/macf#282):',
    '#   - Template-time: MACF_OTEL_ENDPOINT=<url> at `macf init` /',
    '#     `macf update` bakes a different default into this script',
    '#   - Run-time: OTEL_EXPORTER_OTLP_ENDPOINT=<url> in the shell',
    '#     BEFORE invoking ./claude.sh overrides the baked default',
    '#     (per-launch knob; matches OTel canonical env var name)',
    'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
    'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
    'export OTEL_TRACES_EXPORTER=otlp',
    'export OTEL_METRICS_EXPORTER=otlp',
    'export OTEL_LOGS_EXPORTER=otlp',
    // 4-layer endpoint resolution chain (macf#313):
    //   1. OTEL_EXPORTER_OTLP_ENDPOINT (runtime env, canonical OTel name) — wins
    //   2. MACF_OTEL_ENDPOINT (runtime env)
    //   3. settings.local.json `.env.MACF_OTEL_ENDPOINT` (operator-edited)
    //   4. Baked default from macf init/update (template-time MACF_OTEL_ENDPOINT)
    // The MACF_OTEL_ENDPOINT runtime+settings layer was added in #313 to
    // close the gap between the existing template-time MACF_OTEL_ENDPOINT
    // (bakes into this script at macf init/update) and the canonical
    // runtime override (OTEL_EXPORTER_OTLP_ENDPOINT). Operators who want
    // per-launch endpoint changes without re-running macf update now have
    // settings.local.json `.env.MACF_OTEL_ENDPOINT` as the ergonomic path.
    `MACF_OTEL_ENDPOINT="\${MACF_OTEL_ENDPOINT:-$(macf_settings_get MACF_OTEL_ENDPOINT)}"`,
    `MACF_OTEL_ENDPOINT="\${MACF_OTEL_ENDPOINT:-${endpoint}}"`,
    'export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"',
    'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `export OTEL_SERVICE_NAME="macf-agent-${config.agent_name}"`,
    `export OTEL_RESOURCE_ATTRIBUTES="gen_ai.agent.name=${config.agent_name},gen_ai.agent.role=${config.agent_role},service.namespace=macf"`,
  ];
}

/**
 * Claude Code session-resume flags for the final `exec claude ...`.
 * Permanent agents reattach to the prior session so context persists
 * across relaunches (same ergonomics as macf-science-agent /
 * macf-code-agent's existing tmux wrappers). Worker agents skip `-c`
 * because every invocation is fresh by design. See macf#178 Gap 5.
 *
 * Exhaustive switch on `agent_type` so adding a new type is a compile
 * error that forces a paired flag policy decision.
 */
function resumeFlags(cfg: MacfAgentConfig): string[] {
  switch (cfg.agent_type) {
    case 'permanent':
      return ['-c'];
    case 'worker':
      return [];
  }
}

const MANAGED_HEADER_LINES = [
  '# This file is managed by `macf`. Do not edit directly — edits are',
  '# overwritten on the next `macf update`. The template lives at',
  '# groundnuty/macf:src/cli/claude-sh.ts. To change the launcher, file',
  '# an issue or PR against that file, then run `macf update` here.',
];

/**
 * Distinctive, stable substring of the managed-file header that EVERY
 * macf-generated `claude.sh` carries (it is the leading, punctuation-free
 * span of `MANAGED_HEADER_LINES[0]`). Used by `hasManagedHeader` to tell a
 * macf-managed launcher apart from a hand-authored one.
 *
 * **Why this exact slice:** it is a literal prefix of `MANAGED_HEADER_LINES[0]`
 * (the `claude-sh.test.ts` `hasManagedHeader` suite asserts that, AND that a
 * freshly `generateClaudeSh`'d launcher contains it — so the sentinel can't
 * silently drift from what's emitted), and it stops BEFORE the em-dash so a
 * minor reword of the header tail won't break detection. Distinctive enough
 * that a hand-authored launcher (e.g. the framework repo's own `claude.sh`,
 * which opens `# Launcher for macf-code-agent`) won't accidentally match.
 */
const MANAGED_HEADER_SENTINEL = '# This file is managed by `macf`.';

/**
 * True when `content` is a macf-generated `claude.sh` — i.e. it carries the
 * managed-file header sentinel. False for a hand-authored / operator-owned
 * launcher that lacks the header.
 *
 * This is the discriminator `macf update` uses to decide regenerate-vs-preserve
 * for `claude.sh` (DR-029, groundnuty/macf#623): a header-LESS launcher is
 * operator-authored and must be preserved (warn, don't clobber), never
 * overwritten by the generic template. It is the same managed-header
 * discriminator the `.claude/.macf/env.*` + `host-prelude.sh` managed files use.
 */
export function hasManagedHeader(content: string): boolean {
  return content.includes(MANAGED_HEADER_SENTINEL);
}

/**
 * Emit GitHub-App env exports (`APP_ID`, `INSTALL_ID`, `KEY_PATH` + the
 * relative-path resolver) when running in a GitHub-backed registry mode.
 *
 * In local-registry mode (DR-024) the launcher does not mint a token —
 * `github_app` is absent on the config, every export here would resolve
 * to `undefined`, and the downstream token-mint block is skipped anyway
 * (`githubTokenAndIdentityLines`). Returning `[]` keeps the launcher
 * lean instead of emitting `export APP_ID=""` placeholders that imply
 * "this is a misconfigured GitHub-mode agent."
 */
export function githubAppEnvLines(cfg: MacfAgentConfig): string[] {
  if (isLocalMode(cfg) || !cfg.github_app) return [];
  return [
    `export APP_ID="${cfg.github_app.app_id}"`,
    `export INSTALL_ID="${cfg.github_app.install_id}"`,
    `export KEY_PATH="${cfg.github_app.key_path}"`,
    // Resolve KEY_PATH against $SCRIPT_DIR if it's relative. Absolute
    // paths (e.g., operators who stored the key under /etc or /opt)
    // pass through unchanged. Previously KEY_PATH stayed relative and
    // broke the moment the agent cd'd to another repo — attribution
    // trap fires on the next `gh` call. See #140 + coordination.md
    // Token & Git Hygiene (cross-repo cwd trap note).
    'case "$KEY_PATH" in',
    '  /*) ;;  # already absolute',
    '  *) KEY_PATH="$SCRIPT_DIR/$KEY_PATH" ;;',
    'esac',
    'export KEY_PATH',
  ];
}

/**
 * Emit per-project CA + agent cert path exports.
 *
 * In local-registry mode (DR-024) the CA lives next to the registry
 * file (`~/.macf/registry/<project>.ca.{crt,key}`) — set at
 * `macf init --local` time. In GitHub mode it lives under
 * `~/.macf/certs/<owner>/<project>/` (owner-scoped as of macf#1277).
 * Both modes need MACF_CA_CERT / MACF_CA_KEY exported so the
 * channel-server can load the CA for mTLS (and the GitHub-mode `/sign`
 * endpoint, which doesn't fire in local mode).
 *
 * **GitHub mode: runtime shell resolution, NOT a Node-side `existsSync`
 * check (macf#1277).** This function stays a PURE generator (no disk I/O —
 * see this file's module doc + `env-files.ts`'s identical twin
 * `generateEnvCerts`) by emitting a runtime `[ -f ... ]` fallback chain
 * INTO the launcher itself, evaluated by the AGENT's shell at actual
 * launch time rather than decided once at generation time:
 *
 *  1. the owner-scoped conventional path — used if a CA already lives
 *     there (a fresh mint, or an already-migrated fleet)
 *  2. the pre-#1277 project-scoped, owner-less legacy path — used ONLY
 *     when tier 1 is absent AND tier 2 has a file (an EXISTING fleet
 *     whose CA was materialized before this change; `macf-trial` at
 *     the time #1277 was filed)
 *  3. the owner-scoped conventional path again — the fallback-of-last-
 *     resort when NEITHER tier has a file yet (nothing to point at but
 *     the correct future location; the channel-server fails loud on a
 *     missing CA rather than this launcher inventing or minting one)
 *
 * This is what makes "the generated launcher for a pre-#1277 fleet keeps
 * resolving without a re-deploy" true regardless of WHEN or WHERE
 * `macf update` regenerates the launcher relative to the CA materialize
 * step — the decision is deferred to the machine that actually has the
 * CA on disk, at the moment it actually matters (agent launch), not
 * baked in at generation time.
 */
export function caPathLines(cfg: MacfAgentConfig): string[] {
  if (isLocalMode(cfg)) {
    // Pre-resolve the local-registry directory at template time so the
    // launcher doesn't need to expand `~` or recompute the path. Tilde
    // is already resolved in cfg.registry.path (init.ts uses os.homedir()).
    const registryDir = posixDirname(
      cfg.registry.type === 'local' ? cfg.registry.path : '',
    );
    return [
      `export MACF_CA_CERT="${registryDir}/${cfg.project}.ca.crt"`,
      `export MACF_CA_KEY="${registryDir}/${cfg.project}.ca.key"`,
    ];
  }
  const owner = ownerAccountFromRegistry(cfg.registry);
  const conventionalCert = `$HOME/.macf/certs/${owner}/${cfg.project}/ca-cert.pem`;
  const conventionalKey = `$HOME/.macf/certs/${owner}/${cfg.project}/ca-key.pem`;
  const legacyCert = `$HOME/.macf/certs/${cfg.project}/ca-cert.pem`;
  const legacyKey = `$HOME/.macf/certs/${cfg.project}/ca-key.pem`;
  return [
    `if [ -f "${conventionalCert}" ]; then`,
    `  export MACF_CA_CERT="${conventionalCert}"`,
    `  export MACF_CA_KEY="${conventionalKey}"`,
    `elif [ -f "${legacyCert}" ]; then`,
    '  # macf#1277: pre-owner-scoping fleet — CA still lives at the legacy',
    '  # project-scoped path. Read-old, never write/migrate here.',
    `  export MACF_CA_CERT="${legacyCert}"`,
    `  export MACF_CA_KEY="${legacyKey}"`,
    'else',
    `  export MACF_CA_CERT="${conventionalCert}"`,
    `  export MACF_CA_KEY="${conventionalKey}"`,
    'fi',
  ];
}

/**
 * Compute POSIX-style dirname without pulling in node:path at template
 * generation time. The local-mode CA paths derive from the registry
 * file path (e.g. `/home/u/.macf/registry/project.json` →
 * `/home/u/.macf/registry`); using `path.dirname` is overkill and
 * couples the template to the host's OS path semantics. The launcher
 * always runs on POSIX-shaped filesystems (see DR-024 §threat model).
 */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return p.slice(0, idx);
}

/**
 * Emit the GitHub bot-token mint block + `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME`
 * exports. Both depend on the bot's GitHub identity — neither makes
 * sense in local-registry mode (DR-024 §"Routing trade-offs":
 * commits land as the local user, not as `app/<bot>[bot]`).
 *
 * Local-mode launcher emits a synthetic identity comment block instead,
 * so anyone reading the script sees the explicit "no GitHub here"
 * trade-off rather than a missing-export silence.
 */
export function githubTokenAndIdentityLines(cfg: MacfAgentConfig): string[] {
  if (isLocalMode(cfg)) {
    return [
      '# DR-024 / macf#322: local-registry mode. No GitHub App token is',
      '# minted (no APP_ID / INSTALL_ID / KEY_PATH); commits land as the',
      '# local user, not as `app/<bot>[bot]`. Coordination uses the local',
      '# registry file at $MACF_REGISTRY_PATH; agents reach each other via',
      '# direct mTLS POST /notify. See DR-024 §"Routing trade-offs".',
      '',
      `echo "Starting ${cfg.agent_name} (${cfg.agent_role}) [local-registry mode]..."`,
      '',
    ];
  }
  return [
    '# Bot token generation — fail loud. The helper validates the ghs_ prefix',
    '# and surfaces diagnostics (clock drift, bad key, wrong App/install ID).',
    '# Do NOT inline the bare CLI here — without pipefail, a failed fetch piped',
    '# through jq would succeed, GH_TOKEN would become "null", and Claude Code',
    '# would silently fall back to stored `gh auth login` as the user. See the',
    '# attribution-trap section of coordination.md Token & Git Hygiene.',
    'GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \\',
    '    --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {',
    '  echo "FATAL: bot token generation failed — see stderr above." >&2',
    '  exit 1',
    '}',
    'export GH_TOKEN',
    '',
    `export GIT_AUTHOR_NAME="${cfg.agent_name}[bot]"`,
    `export GIT_COMMITTER_NAME="${cfg.agent_name}[bot]"`,
    '',
    `echo "Starting ${cfg.agent_name} (${cfg.agent_role})..."`,
  ];
}

/**
 * Build the full `claude.sh` content for a given agent config. Pure
 * function — no I/O. Used by both `macf init` (first write) and
 * `macf update` (refresh).
 *
 * **Thin source-then-exec template (macf#342 PR-B).** All per-concern
 * env exports moved into separate files under `<workspace>/.claude/.macf/`,
 * sourced here via a single shell glob loop. claude.sh now carries only
 * orchestration: shebang + managed header, SCRIPT_DIR resolution,
 * source-loop, optional non-cleanly-bucketed exports (MACF_HOST /
 * MACF_ADVERTISE_HOST / MACF_DEBUG — see PR body for rationale), tmux
 * self-wrap (macf#340 env-isolation preserved), a launch-boundary
 * `GH_TOKEN` full-shape validation (macf#821 — see
 * `launchTokenValidationLines`), and the conditional `exec claude` block.
 *
 * **Source order is alphabetical** (shell glob expansion). The
 * underscore-prefixed `env._helpers` sorts BEFORE alphabetical-letter
 * siblings, so its function definitions (`macf_settings_get`) are
 * available when `env.identity` and `env.telemetry` are sourced later.
 *
 * **Backward compat**: this thin template depends on the env.* files
 * existing in `.claude/.macf/`. PR-B's `init` writes both env.* files
 * AND claude.sh in lockstep, so fresh inits and re-runs are safe.
 * Existing workspaces with the pre-#342 monolithic claude.sh continue
 * to work UNTIL their claude.sh is regenerated — at which point they
 * also need the env.* files. PR-C ships the migrate-existing path.
 */
export function generateClaudeSh(config: MacfAgentConfig): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `# MACF Agent Launcher: ${config.agent_name}`,
    ...MANAGED_HEADER_LINES,
    '#',
    '# This is a THIN launcher (macf#342). All per-concern env exports',
    '# (identity, GitHub, certs, registry, telemetry, tmux) live in separate',
    '# files under .claude/.macf/env.* and are sourced via the loop below.',
    '# To regenerate after a config change, run `macf update` here.',
    '#',
    '# Canonical per-concern env files (sourced alphabetically):',
    '#   env._helpers   — library: jq settings helper (sourced FIRST per underscore prefix)',
    '#   env.certs      — cert + log paths                                        (macf-managed)',
    '#   env.github     — App creds + bot token mint + git author/committer       (macf-managed; empty in local-mode)',
    '#   env.identity   — project / agent name / role / type / workspace dir      (macf-managed)',
    '#   env.registry   — registry type + per-type pointer                        (macf-managed)',
    '#   env.telemetry  — OTel gates + endpoint                                   (operator-managed; preserved by macf update)',
    '#   env.tmux       — wake-path session + window targets                      (operator-managed; preserved by macf update)',
    '#',
    '# Extension model: add operator-custom env files as `env.local.<name>` or',
    '# `env.zz.<name>` so they sort AFTER the canonical seven (lowercase letters',
    '# > underscore in ASCII, so .local.* and .zz.* both sort late). The thin',
    '# source-loop below picks them up automatically — no edit to this file needed.',
    '# See docs/configuration.md for the full reference (macf#342).',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    '',
    '# Host toolchain bootstrap (DR-031 piece 4). Source host-prelude.sh',
    '# FIRST — before the env.* loop, the tmux self-wrap, and the final claude',
    '# launch — so the toolchain (claude / jq / node / tmux) is on PATH when the',
    '# launch context has a MINIMAL env that did not inherit the operator',
    '# login-shell PATH: cron, a detached restart-self relauncher, or a',
    '# container entrypoint. The env.* files (token mint needs gh/jq/openssl)',
    '# and claude itself depend on the toolchain this re-establishes; it is',
    '# macf-managed + re-detected (devbox/brew/none) on every `macf update`.',
    '# The `[ -f ] &&` form is set -e safe (the left of && is not the final',
    "# command) and lets a workspace lacking the file (older init) still",
    "# launch. The same path is consumed by restart-self's relauncher.",
    '[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source "$SCRIPT_DIR/.claude/.macf/host-prelude.sh"',
    '',
    '# Source per-concern env files (macf#342). Shell glob sorts',
    '# alphabetically, so env._helpers (underscore prefix sorts before',
    '# letters) loads first and defines macf_settings_get used by',
    '# env.identity and env.telemetry. The `[ -f ]` guard tolerates the',
    '# (very unusual) case where the directory exists but a sibling tool',
    '# created a non-file glob match.',
    '#',
    '# Operator-custom env files (override or extend canonical config):',
    '# use `env.local.<name>` or `env.zz.<name>` prefix so they sort',
    '# AFTER all macf-managed canonical files (env._helpers / env.certs /',
    '# env.github / env.identity / env.registry / env.telemetry / env.tmux).',
    '# Bash glob sorts ASCII: uppercase A-Z (0x41-0x5A) BEFORE underscore',
    '# (0x5F) BEFORE lowercase a-z (0x61-0x7A). An operator-added file like',
    '# `env.UPPERCASE_OVERRIDE` would sort before `env._helpers` and source',
    '# in a context without macf_settings_get defined yet — followed by',
    '# `env.identity` calling that undefined function. Stick to the',
    '# `env.local.*` or `env.zz.*` convention to avoid the trap.',
    'if [ -d "$SCRIPT_DIR/.claude/.macf" ]; then',
    '  for f in "$SCRIPT_DIR/.claude/.macf"/env.*; do',
    '    [ -f "$f" ] && source "$f"',
    '  done',
    'fi',
    '',
    '# Channel-server runtime knobs that don\'t cleanly bucket into a',
    '# single env.* concern. MACF_HOST/MACF_ADVERTISE_HOST are network',
    '# transport (close to certs but not cert-related); MACF_DEBUG is a',
    '# global verbosity gate. Kept in claude.sh as orchestration; PR-D',
    '# may refactor into a dedicated env.channel-server file.',
    '#',
    '# Listen on all interfaces; advertise the routable host below. When',
    '# advertise_host is unset in macf-agent.json, fall back to 127.0.0.1',
    '# (the plugin\'s existing default — keeps backward compat for',
    '# workspaces that haven\'t set the field yet). See macf#178.',
    'export MACF_HOST="0.0.0.0"',
    `export MACF_ADVERTISE_HOST="${config.advertise_host ?? '127.0.0.1'}"`,
    'export MACF_DEBUG="${MACF_DEBUG:-false}"',
    '',
    "# macf#642: the channel-server's native log path — its forensic trail. The",
    '# comms-ledger + turn-receipt sink are siblings derived from it, and the',
    '# channel-server reads MACF_LOG_PATH via @groundnuty/macf-core config. The',
    '# whole cluster lives in the agent HOME under the XDG state dir (per-agent',
    '# <project>@<agent> subdir, matching the forensic-log default base + the',
    '# tmux session name) — OUT of the repo so it never clutters or is committed.',
    "# For a fully macf-init'd workspace env.certs already exports this (sourced",
    '# above) to the SAME path, so the ${VAR:-default} form preserves it and only',
    '# supplies the default for an older/partial workspace whose env.certs',
    '# predates the var.',
    `export MACF_LOG_PATH="\${MACF_LOG_PATH:-\${XDG_STATE_HOME:-$HOME/.local/state}/macf/${config.project}@${config.agent_name}/channel.log}"`,
    ...tmuxSelfWrapLines(),
    ...channelNotificationsLines(),
    ...promptWatcherLines(),
    ...launchTokenValidationLines(config),
    '',
    // --plugin-dir loads the pinned macf-agent plugin from this workspace
    // (per DR-013). Additive — user-scope plugins still load alongside.
    // `-c` (for permanent agents) reattaches to the prior Claude Code
    // session so context persists across relaunches; worker agents skip
    // it so every invocation is fresh. See macf#178 Gap 5.
    //
    // MACF_TEST=1 bypasses the `-c` auto-resume for clean-state smoke
    // tests — `-c` errors with "No deferred tool marker found" when the
    // prior session state is missing/partial. Normal production runs
    // (MACF_TEST unset) get the resume-by-default behavior. See
    // macf#189 sub-item 4.
    //
    // Permanent agents resume with `-c`, but fall back to a FRESH session
    // when no conversation is resumable for this workspace (first launch, or
    // history keyed under a different/physical path) — otherwise `claude -c`
    // exits non-zero immediately and the launch dies with no agent. The
    // resume attempt isn't `exec`'d so the `||` fallback can fire; the
    // fallback IS `exec`'d (terminal). CV-migration dogfooding finding #6.
    // $MACF_CHANNELS_ARGS is expanded UNQUOTED (channelNotificationsLines above
    // set it) so the two-token `--dangerously-load-development-channels
    // server:macf-agent` flag word-splits into two argv entries; an empty value
    // (opt-out / old claude) expands to nothing. SC2086 is intentional here.
    '# shellcheck disable=SC2086',
    'if [ -n "${MACF_TEST:-}" ]; then',
    '  exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"',
    'else',
    ...(resumeFlags(config).length > 0
      ? [
          `  claude ${resumeFlags(config).join(' ')} --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"`,
        ]
      : ['  exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"']),
    'fi',
    '',
  ].join('\n');
}

/**
 * Write `claude.sh` into the workspace at 0755. Overwrites any existing
 * content — the managed-file header warns users against hand-editing.
 */
export function writeClaudeSh(workspaceDir: string, config: MacfAgentConfig): string {
  const absDir = resolve(workspaceDir);
  const path = join(absDir, 'claude.sh');
  writeFileSync(path, generateClaudeSh(config), { mode: 0o755 });
  // writeFileSync's `mode` option only applies when creating a new file.
  // On overwrite, the existing mode (often 0o644 from a user's editor)
  // is kept — so we must explicitly chmod to make sure the launcher
  // stays executable after `macf update` rewrites it.
  chmodSync(path, 0o755);
  return path;
}
