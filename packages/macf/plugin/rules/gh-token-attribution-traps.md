# gh-token attribution-trap failure modes

**Six ways `gh` operations silently mis-attribute to the user account instead of the bot, and the patterns that prevent them.**

When a bot agent runs `gh` commands, multiple silent failure modes cause ops to attribute to the user account instead of the bot. Because the content the agent posts is what it intended, mis-attribution is **invisible unless explicitly checked.** Past incidents:

- Code-agent's merge-handoff comments posted under operator's account for an entire session — discovered only when cross-agent routing started failing
- PR #16/#17 author mis-attribution surfaced during routine review (not by attribution itself)
- 5+ recurring instances logged across science-agent + code-agent memory before this rule was canonicalized

This is a **silent-fallback hazard class**: tool operations succeed at the API boundary, semantic-level failure (wrong identity / wrong scope / wrong target) is invisible until something downstream breaks. Defenses must guard at the *result-invariant* level, not the *exit-code* level.

---

## The six failure modes

### 1. Wrong private key file

GitHub rotated the App's private key (or the operator put the wrong .pem in the workspace). Local `.github-app-key.pem` doesn't match what GitHub has registered. Every JWT fails with `"A JSON web token could not be decoded"`. `gh token generate` exits non-zero, `GH_TOKEN=$(...)` captures empty, `gh` silently falls through to stored `gh auth login` as the user.

**Detect:**
```bash
# Compare local fingerprint with GitHub's (visible on the App settings page)
openssl rsa -in <key.pem> -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64
```
Should match the "SHA256:..." shown on `github.com/settings/apps/<app>`.

### 2. Clock drift between VM and GitHub

If `iat` in the JWT is ahead of GitHub's clock (VM runs fast, or even a few seconds skew), GitHub rejects the JWT as "from the future" — same `"JSON web token could not be decoded"` error. Intermittent: sometimes valid, sometimes not, depending on the moment.

**Fix:** use a 180-second back-window on `iat` (not the 60s default):
```bash
iat=$((now - 180))    # 3 minutes in the past — tolerates up to 3 min of clock skew
exp=$((now + 420))    # still 10 min total lifetime (180 past + 420 future)
```

### 3. `gh` silent fallback to stored user auth

When `GH_TOKEN` is empty or invalid, `gh` falls through to `~/.config/gh/hosts.yml` if present. Ops succeed, content is correct, but `author` on the created resource is the user account.

**Fix:** fail loud. Never use `export GH_TOKEN=$(gh token generate ... | jq)` as a one-liner; it swallows errors. Pattern:
```bash
# Assert token was generated AND has the bot prefix
TOKEN=$(.claude/scripts/macf-gh-token.sh --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {
  echo "FATAL: token-gen failed" >&2; exit 1
}
[ -n "$TOKEN" ] || { echo "FATAL: empty token" >&2; exit 1; }
case "$TOKEN" in ghs_*) ;; *) echo "FATAL: bad token prefix" >&2; exit 1 ;; esac
export GH_TOKEN="$TOKEN"
```

**Why the bare `TOKEN=$(...)` + separate `export`, never `export GH_TOKEN=$(...)`:** `export` is a builtin whose own exit status (`0`) *replaces* the command-substitution's, so `export GH_TOKEN=$(helper) || exit 1` and `export GH_TOKEN=$(helper) && gh ...` both proceed even when the helper failed (ShellCheck SC2155). The failure only propagates from a **bare** assignment (`TOKEN=$(helper) || …`). This is load-bearing under GitHub's intermittent token-endpoint 401s: a refresh that can yield an empty token *without aborting* the dependent `gh` ops re-creates mode #3 (witnessed 2026-06-12 — `cv-architect` posted 4 comments as the operator under a transient 401).

**The PreToolUse hook does NOT cover this.** `check-gh-token.sh` validates the *ambient* `GH_TOKEN` before the command runs, so an inline `export GH_TOKEN=$(...) && gh ...` (refresh-chain *or* file-cache read) reassigns the token *after* the hook has already passed — the hook is structurally blind to it (silent-fallback **Instance 12**, `silent-fallback-hazards.md`). Refresh in a **separate step** (to a pre-validated file, or a bare-assigned var with the checks above), never inline in the `gh` command. The durable structural cover is a result-invariant **PostToolUse** `author`-check (macf#489), not the PreToolUse precondition.

### 4. Wrong `gh auth` on the VM providing fallback

Having `gh auth login` configured as a user account creates the fallback surface in #3. Even a "good" setup where the script is correct can hide a broken bot token because `gh` quietly uses the user auth.

**Best hardening:** remove stored `gh auth login` on agent VMs entirely — then broken bot tokens fail loudly with "no auth," not silently as the user.

**Tradeoff:** interactive `gh` inspection by a human on the VM also requires a token. Usually acceptable for dedicated agent VMs.

### 5. Helper script missing from workspace (path 127, silent empty capture)

Non-init'd workspace had never received `.claude/scripts/macf-gh-token.sh` because the operator forgot to run `macf rules refresh` after the helper was introduced. Calling `./.claude/scripts/macf-gh-token.sh ...` returned exit 127 ("no such file") — but with `export GH_TOKEN=$(helper 2>/dev/null)` the 127 is silently discarded, stdout is empty, `GH_TOKEN=""`, `gh` falls through to stored user auth.

Compounds modes #3 + #4: all the bot ops look normal but post as the user. Only noticed when a human checked a comment URL.

**Fix:** use `macf rules refresh --dir <workspace>` to install canonical `macf-gh-token.sh` + `macf-whoami.sh` + `tmux-send-to-claude.sh`. Workbench-only workspaces (substrate agents) still need this — the helpers are distributed via a separate mechanism from full `macf init`.

Also: **always validate token prefix in the chain, not just in the helper.** Even a correctly-installed helper can fail (rotated key, clock drift) and return empty. Chain guard:

```bash
GH_TOKEN=$(./.claude/scripts/macf-gh-token.sh ...) \
  && [[ "$GH_TOKEN" == ghs_* ]] \
  || { echo "FATAL: bad token"; exit 1; }
export GH_TOKEN
```

The `[[ ... == ghs_* ]]` check catches both empty and junk-output cases (e.g., the "(eval):1: no such file" leak when stderr was merged into stdout).

### 6. Relative path to helper (or key) breaks on cross-repo `cd`

When an agent `cd`'s to another repo for cross-repo work (e.g., code-agent editing `macf-actions` from its `macf` workspace), `./.claude/scripts/...` doesn't resolve from the new cwd, and relative `$KEY_PATH` can't be read either.

`$(...)` command substitution swallows the helper's exit 127 silently, returns empty string. `export GH_TOKEN=""` succeeds with no error. Next `gh` call falls through to stored user auth. Mode-3 silent fallback, triggered by path breakage.

**Fix (canonical, post macf#161):**

- `claude.sh` exports `MACF_WORKSPACE_DIR="$SCRIPT_DIR"` — the workspace absolute path, available in all agent env regardless of cwd.
- `claude.sh` absolutizes `KEY_PATH` via `case` on leading slash (preserves operator-absolute paths like `/etc/macf/keys/...`, rewrites relative default to `$SCRIPT_DIR/$KEY_PATH`).
- All canonical agent templates use `$MACF_WORKSPACE_DIR/.claude/scripts/...` (NOT relative `./...`).

**Why mode 6 is distinct from mode 5:** mode 5 is "helper script file missing from workspace entirely." Mode 6 is "helper present in workspace, but reachable only via a path that breaks on cross-repo cwd." Mode 5's fix is installing the helper (`macf rules refresh`); mode 6's fix is using an absolute path to it (`$MACF_WORKSPACE_DIR/...`).

---

## Verifying identity after ops

Don't trust; verify. A token that "looks right" can still be misattributed due to a subtle env issue. Spot-check at session start:

```bash
# After posting any comment in a session, sanity-check ONE post:
GH_TOKEN=$T gh api "/repos/$REPO/issues/comments/$ID" --jq '.user.login'
# Expect: <bot-name>[bot]; FAIL if it shows the operator's user account
```

Do this once at session start (cheap), then trust. Mid-session re-checks not needed unless something suspicious happens.

The `macf-whoami.sh` helper canonicalizes this check:

```bash
.claude/scripts/macf-whoami.sh
# Prints the actor identity associated with current $GH_TOKEN
```

---

## Canonical pattern (distilled)

```bash
# Token acquisition — fails loud, token-prefix validated
TOKEN=$(.claude/scripts/macf-gh-token.sh --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") \
  || { echo "FATAL: token gen failed" >&2; exit 1; }

# Chain the op immediately so token doesn't linger in env
GH_TOKEN=$TOKEN gh issue comment <N> --repo <owner>/<repo> --body "..."
```

The helper script `macf-gh-token.sh` must:
1. Use `set -euo pipefail`
2. Use 180s `iat` back-window for clock drift tolerance
3. Validate token prefix is `ghs_` (installation token); refuse to print user PATs (`ghp_*`, `gho_*`)
4. Print nothing to stdout on failure (only stderr)

---

## Structural backstop: PreToolUse hook (macf#140)

Workspaces include a `PreToolUse` hook that intercepts `gh` and `git push` invocations and blocks with `exit 2` if `GH_TOKEN` is missing or doesn't have the `ghs_` prefix. This catches mode 3, 5, and 6 at the call site rather than after the fact.

Distribution: `macf init` / `macf update` / `macf rules refresh` install the hook + the helper scripts together.

When intentionally bypassing the hook for a knowingly user-attributed op (e.g., `gh auth login` during onboarding), set `MACF_SKIP_TOKEN_CHECK=1` for that one call.

---

## Structural backstop: in-runner token refresh in macf-channel-server (macf#317)

The 6 failure modes above all describe **token-acquisition** (the new token coming back wrong); macf#317 surfaced a 7th class — **token-expiry** during long-running sessions. Bot installation tokens have a 1-hour TTL by design; `claude.sh` mints a fresh token at session start and exports `GH_TOKEN`, but **macf-channel-server inherits this fixed token via `process.env` and has no in-runner refresh** absent the macf#317 fix. After 1 hour, every gh-API-using handler (notify_peer's registry lookups, /sign's varsClient calls) 401s. Witnessed 2026-05-01: cv-architect Stop hook 401 at ~67min uptime.

The expiry sub-case is **shape-distinct** from modes 1–6: the token is `ghs_*` (right prefix), it was generated correctly, the helper script is installed, the path resolves — it's just stale. Helper-prefix-checking + PreToolUse hooks don't catch it; the structural fix is in-process refresh.

**v0.2.11+ defense:** macf-channel-server's `token-refresh.ts` + `refresh-aware-client.ts` modules. The token-refresher caches the current token in-process for ~50 minutes (10-min safety margin under 1hr TTL); on every gh-API call, the refresh-aware client gets a current token (cached or fresh); on 401, the wrapper force-refreshes + retries once. Refresh failures throw with diagnostic — channel-server fails loud rather than silently using a stale token. Implementation cites `silent-fallback-hazards.md Instance 1 (expiry sub-case)` in the diagnostic message so 401s in the field surface the canonical reference.

**Operator note:** the structural defense is automatic for consumer-fleet workspaces (npm-installed `@groundnuty/macf-channel-server@0.2.11+`). Substrate workspaces / bash-terminal sessions still need the operator-discipline pattern in `gh-token-refresh.md` ("refresh before every `gh` or `git push`").

---

## How this relates to other canonical rules

- `coordination.md` § "Token & Git Hygiene" documents the canonical helper invocation; this rule provides the failure-mode catalog the helper is designed to defend against.
- `pr-discipline.md` documents auto-close-keyword hazards in PR bodies; same shape (silent-fallback hazard at the API boundary) but different surface.

---

## Why this rule exists

Silent mis-attribution is a coordination failure mode that breaks routing workflows (workflow @-mention iteration sees user identity on bot-emitted posts; routing doesn't fire) and audit trails (paper-trail evidence shows wrong actors). The trap is mature — recurred 5+ instances across two substrate agents before this rule canonicalized — and prevention is straightforward once the failure modes are catalogued.

Pattern: defenses target *result-invariants* (token has `ghs_` prefix; spot-check actor on a known post), not *exit-code-success* (which silent fallbacks satisfy). This generalizes beyond gh-tokens to other tool/API surfaces with silent-fallback hazards.
