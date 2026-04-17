# Coordination Rules (canonical, shared)

**This file is the single source of truth for cross-cutting coordination rules that apply to every MACF agent.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update`. Do not edit workspace copies directly — edit this file and re-run `macf update`.

> **Workspaces without full `macf init`** (e.g. `groundnuty/macf` itself, or any Claude Code workspace operated by a bot that isn't a MACF-registered agent) can still get these canonical rules via `macf rules refresh --dir <workspace>`. Same copy, no App credentials or registry required.

The rules here are topology-agnostic: they work whether the project uses a science-agent coordinator (like macf) or peer-to-peer agents with direct user oversight (like CV).

---

## Issue Lifecycle

1. **The reporter owns the issue closure.** The agent who opened an issue is the only one who closes it. This rule has two failure modes — both costly, both silent. Check for both before posting a merge-handoff comment.

   **Failure mode A — closing an issue you didn't open.** Two ways this happens:
   - *Auto-close via PR keywords.* GitHub's auto-close keywords in a PR body or commit message close the referenced issue on merge, bypassing the reporter. **Never use any of these 9 variants when the issue was filed by someone else:** `Closes #N`, `Fixes #N`, `Resolves #N`, `Close #N`, `Fix #N`, `Resolve #N`, `Closed #N`, `Fixed #N`, `Resolved #N`. Use **`Refs #N`** instead.
   - *Manual close via `gh issue close`.* Don't close someone else's issue even after merging the implementation. Post the handoff comment and stop.

   **Failure mode B — waiting for yourself to close.** When the issue's reporter is YOU (you filed the issue during an audit, a follow-up split-off, or self-observed bug), there is no one else to close it. Don't post `@<other-agent> ready for you to close when verified` — no one is waiting to do that for you. After your PR merges, close the issue yourself with a verification comment. Silent stall otherwise: the queue fills with in-review issues that never clear.

   **Self-check before posting any merge-handoff comment:**

        gh issue view <N> --json author --jq '.author.login'

   - Author is someone else (user or another agent) → post `@<author> PR #M merged, ready for you to close when verified.` and STOP.
   - Author is YOU (your `app/<bot-name>` login) → close the issue yourself:

            gh issue close <N> --reason completed --comment "Verified on main after PR #M merged. Closing as reporter."

   Also self-check PR bodies before pushing:

        git log -1 --pretty=%B  # or the PR body draft
        # grep for any of: Closes Fixes Resolves Close Fix Resolve Closed Fixed Resolved

   If any of those appear and the referenced issue was filed by someone else, replace with `Refs #N`.

   **Why this rule matters:** Reporter-owns-closure gives the reporter a chance to verify the fix matches their intent before the issue disappears from their queue. In a multi-agent workflow, the reporter often has context the implementer doesn't (why it was filed at that priority, what the acceptance criteria really meant, what adjacent work it blocks). Auto-close strips that context; reflexive handoff on self-filed issues wastes it.

2. **Work through the queue without prompting.** When an issue is complete, check your assigned-label queue and pick up the next one immediately. Do NOT ask the reporter to ping you or reply "continue" before starting. Only wait when (a) your PR is in review, or (b) the queue is empty. If an issue is ambiguous, ask clarifying questions on that issue and move to the next queued one while waiting.

3. **Never remove your own agent label.** Status labels (`in-progress`, `in-review`, `blocked`) swap as work moves; assignment labels stay.

---

## Communication

1. **@mention in EVERY comment.** Routing depends on it. A comment without @mention is invisible to the recipient agent.

2. **All discussion in issue comments, not PR comments.** Issue threads are visible on the Projects board and persist after PRs are merged or closed.

3. **Concise comments** — 1-3 sentences unless detail is needed.

---

## When You're Stuck — Escalation

1. **Treat definitive GitHub states as action signals, not wait signals.** For PR merge status, check `gh pr view <N> --json mergeStateStatus,mergeable`:
   - `CLEAN` → merge
   - `UNKNOWN` → GitHub is still computing; wait up to ~60s
   - `DIRTY` / `CONFLICTING` → rebase onto main and resolve conflicts
   - `BEHIND` → rebase onto main, force-push
   - `BLOCKED` → check reviews / required checks / branch protection
   - `UNSTABLE` → a required check failed; fix it

   Only `UNKNOWN` means "keep waiting." Anything else means your turn to act.

   **Exception — CI-completion routing (macf-actions v1.3+).** When you receive a CI-completion routing notification (`PR #N: CI SUCCESS/FAILED ...`) and `gh pr view` returns `UNKNOWN` or `UNSTABLE` immediately after, the notification was fired by one workflow's `check_suite.completed` while another workflow on the same commit is still in-flight. The rollup hasn't resolved yet. Wait ~30s and re-query; don't force-merge until the full rollup goes `CLEAN`. See `groundnuty/macf-actions#6` for background.

2. **Escalate to the issue reporter.** When you've tried to resolve and are still stuck, @mention the reporter of the issue you're working on:

        GH_TOKEN=$GH_TOKEN gh issue comment <N> --repo <owner>/<repo> --body "@<reporter> blocked on <X> — tried <Y>, need <Z>."

   Universal rule: an agent escalates to the entity that tasked it — which is the issue reporter. Same entity that owns closing the issue (see Issue Lifecycle rule 1). This holds across any topology:
   - macf (code-agent → science-agent → user)
   - CV (cv-agents → user directly)
   - Experiments (workers → experiment orchestrator → science-agent)

   The chain flows from who opened the issue. You don't need to know the topology — you just @mention the reporter.

3. **The reporter decides the next step.** They may act directly, involve a coordinator, or bring in the user. Do not reach past the reporter to the user unless the reporter has explicitly said they can't help.

---

## Peer Dynamic

You are a peer to the agents and humans you work with, not a subordinate and not a superior.

- **Push back** when an issue has wrong scope, missing context, flawed design, or conflicts with prior decisions
- **Ask clarifying questions** before proceeding on ambiguous requirements — wait for answers
- **Defend your implementation choices** with concrete reasoning if the reviewer disagrees
- **Accept valid feedback** and push fixes promptly
- **Research before implementing** — your training data may be outdated. Look up current SDK/library/API docs (context7, WebSearch, WebFetch) before using them

The goal is correctness through dialogue, not compliance.

---

## Submitting a Prompt to a Claude Code TUI (tmux)

When a hook or script needs to programmatically submit a prompt to a Claude Code TUI running in tmux, **always use the canonical helper**:

        .claude/scripts/tmux-send-to-claude.sh <session-or-empty> "<prompt text>"

Pass `""` for the session to target the current pane.

**Never** call `tmux send-keys "<prompt>" Enter` inline. Claude Code's TUI is in multi-line input mode by default, so a single Enter inserts a newline instead of submitting — the prompt sits in the buffer unsubmitted. The helper handles the submit-quirk correctly: clear existing input with `C-u`, send the text with a first Enter, sleep 1 second (load-bearing — without it tmux batches both Enters and Claude processes them atomically as "newline + newline"), then send a second Enter that actually submits.

The helper is distributed to every agent workspace by `macf init` and refreshed by `macf update` (same mechanism as this rules file). If you're writing a new hook or automation that needs to prompt Claude, use the helper — do not re-implement the pattern.

---

## Token & Git Hygiene

1. **Refresh GH_TOKEN before every `gh` or `git push`** — tokens are 1-hour installation tokens. Use the canonical helper, and **fail loud** if it doesn't work:

        GH_TOKEN=$(./.claude/scripts/macf-gh-token.sh \
          --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
        export GH_TOKEN

   **Never** use the naive `export GH_TOKEN=$(gh token generate ... | jq -r '.token')` pattern — if `gh token generate` fails, jq's success masks the error (no `pipefail`), `GH_TOKEN` becomes the string `"null"`, and every subsequent `gh` operation silently falls back to the stored `gh auth login` as the user. This is the attribution trap: your PRs and comments get written as the user, not the bot, and nothing surfaces the mismatch until cross-agent routing breaks.

   The helper uses `--token-only`, `set -euo pipefail`, validates the `ghs_` prefix, and emits actionable diagnostics (clock drift, missing key, bad PEM, wrong App/installation ID) on failure.

2. **Sanity-check your identity** at session start or when something feels off:

        GH_TOKEN=$GH_TOKEN ./.claude/scripts/macf-whoami.sh

   Bot tokens (`ghs_*`) print `bot installation token`. A user token (`ghp_*`, `gho_*`, `ghu_*`) prints the user login and exits non-zero with a warning — that's the attribution trap firing.

3. **When token generation fails, diagnose — don't work around it.** Common causes observed in practice:

   - **Clock drift** — "JWT could not be decoded" usually means this machine's clock is skewed beyond GitHub's JWT tolerance. Check `timedatectl status` (expect `System clock synchronized: yes`).
   - **Key mismatch** — `.github-app-key.pem` on disk doesn't match the App's registered public key (typically after a key rotation on GitHub without syncing locally). Compare fingerprints:

            openssl rsa -in "$KEY_PATH" -pubout -outform DER 2>/dev/null | openssl dgst -sha256

     against the SHA256 shown on GitHub → App settings → Private keys.
   - **Wrong App/installation ID** — double-check `$APP_ID` and `$INSTALL_ID` in `.claude/settings.local.json`.
   - **Missing App permission** — a 401 on a specific endpoint (e.g. `gh run list` returns 401 while `gh issue list` works) typically means the App lacks the permission for that resource. Coordinator/review agents especially need `actions: read` to debug team workflow runs — see DR-019 for the full required permission set. A missing permission is another flavor of the attribution trap: the bot call 401s, `gh` falls through to stored user auth, operations run as the user without surfacing the issue.

4. **Never bake tokens into `git remote set-url`** — use `-c url.insteadOf` for each push so tokens don't persist in remote URLs.

5. **Never leave uncommitted changes** in the working tree at the end of a turn.

6. **Never commit** `.github-app-key.pem`, tokens, or secrets. `.gitignore` should exclude them, but also verify untracked files before staging.

---

## When to Read vs. Modify These Rules

- **Read:** Every session start. These rules define how you coordinate.
- **Modify:** Never directly in workspace copies. Edit the canonical file at `plugin/rules/coordination.md` in `groundnuty/macf`, then run `macf update` in each affected workspace.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale. Peer-review applies.
