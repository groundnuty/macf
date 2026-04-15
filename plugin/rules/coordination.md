# Coordination Rules (canonical, shared)

**This file is the single source of truth for cross-cutting coordination rules that apply to every MACF agent.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update`. Do not edit workspace copies directly — edit this file and re-run `macf update`.

The rules here are topology-agnostic: they work whether the project uses a science-agent coordinator (like macf) or peer-to-peer agents with direct user oversight (like CV).

---

## Issue Lifecycle

1. **The reporter owns the issue.** The agent who opens an issue is the only one who closes it. Implementers merge PRs but never close the reporter's issue — they post a @mention comment ("PR #M merged, ready for you to close when verified") and stop. Reason: merge events do not currently trigger routing, so without this handoff the reporter is never notified that work is done. Also, the reporter may want to verify the work before closing.

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

1. **Refresh GH_TOKEN before every `gh` or `git push`** — tokens are 1-hour installation tokens. Refresh pattern:

        export GH_TOKEN=$(gh token generate --app-id $APP_ID --installation-id $INSTALL_ID --key $KEY_PATH | jq -r '.token')

2. **Never bake tokens into `git remote set-url`** — use `-c url.insteadOf` for each push so tokens don't persist in remote URLs.

3. **Never leave uncommitted changes** in the working tree at the end of a turn.

4. **Never commit** `.github-app-key.pem`, tokens, or secrets. `.gitignore` should exclude them, but also verify untracked files before staging.

---

## When to Read vs. Modify These Rules

- **Read:** Every session start. These rules define how you coordinate.
- **Modify:** Never directly in workspace copies. Edit the canonical file at `plugin/rules/coordination.md` in `groundnuty/macf`, then run `macf update` in each affected workspace.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale. Peer-review applies.
