# Coordination Rules (canonical, shared)

**This file is the single source of truth for cross-cutting coordination rules that apply to every MACF agent.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update`. Do not edit workspace copies directly — edit this file and re-run `macf update`.

> **Workspaces without full `macf init`** (e.g. `groundnuty/macf` itself, or any Claude Code workspace operated by a bot that isn't a MACF-registered agent) can still get these canonical rules via `macf rules refresh --dir <workspace>`. Same copy, no App credentials or registry required.

The rules here are topology-agnostic: they work whether the project uses a science-agent coordinator (like macf) or peer-to-peer agents with direct user oversight (like CV).

---

## Issue Lifecycle

1. **The reporter owns the issue closure.** The agent who opened an issue is the only one who closes it. This rule has two failure modes — both costly, both silent. Check for both before posting a merge-handoff comment.

   **Failure mode A — closing an issue you didn't open.** Two ways this happens:
   - *Auto-close via PR keywords.* GitHub's auto-close keywords in a PR body or commit message close the referenced issue on merge, bypassing the reporter. **Never use any of these 9 variants when the issue was filed by someone else:** `Closes #N`, `Fixes #N`, `Resolves #N`, `Close #N`, `Fix #N`, `Resolve #N`, `Closed #N`, `Fixed #N`, `Resolved #N`. Use **`Refs #N`** instead. The parser is negation- and context-blind (tables, checklists, quotes, and code fences do *not* shield the keyword), so this is now backstopped structurally: the `check-close-keyword.sh` PreToolUse hook (groundnuty/macf#431) intercepts `gh pr create` / `gh pr edit` whose body or title carries a close-keyword adjacent to a `#N` (or `owner/repo#N`) filed by another agent, and blocks with `exit 2`. Override with `MACF_SKIP_CLOSE_CHECK=1` for a deliberate cross-fix or your own issue.
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

   **Inversion warning — closure direction is independent of who implemented the fix.** A common failure mode after PR-merge handoffs: the reporter mistakes the implementer for the closer because the implementer just finished the work. Rule 1A says **reporter** owns closure, NOT **fix-author**:

   *(The 4 cases below assume merge-by-implementer per `pr-discipline.md` — `implementer == merger`. Different topologies expand the table accordingly.)*

   - **You filed the issue + you implemented the PR + you merged it** → **you close** (you're both reporter AND implementer).
   - **You filed the issue + a peer implemented the PR + the peer merged it** → **you still close** (you're the reporter; the peer is implementer-but-not-reporter; their action ends at "post handoff comment + stop" per failure mode A).
   - **A peer filed the issue + you implemented + you merged the PR** → **the peer closes** (they're the reporter; you @mention them with `ready for you to close when verified` per failure mode A).
   - **A peer filed the issue + a peer implemented + a peer merged the PR** → **reporter closes**; you're observer.

   The trap is symmetric to failure mode A. Failure mode A is "I close someone else's issue because I implemented the fix" (forgetting that fix-author ≠ reporter); the inverse is "I tell the implementer to self-close my issue because they merged the fix" (same forgetting, opposite direction). Both are the same conceptual mistake — substituting fix-authorship for issue-reportership.

   **Reinforced self-check after any PR-merge that addresses an issue:**

        gh issue view <N> --json author --jq '.author.login'

   - Output is YOUR login → **YOU close** with verification comment (regardless of who implemented). Run `gh issue close <N> --reason completed --comment "..."`.
   - Output is the peer's login → **THEY close**. Post `@<author> PR #M merged, ready for you to close when verified.` and STOP. Don't try to delegate the closure mechanics back to yourself.

   This check is one cheap shell command; the inversion is silent (the recipient may not catch it if they're not paying attention to attribution).

2. **Work through the queue without prompting.** When an issue is complete, check your assigned-label queue and pick up the next one immediately. Do NOT ask the reporter to ping you or reply "continue" before starting. Only wait when (a) your PR is in review, or (b) the queue is empty. If an issue is ambiguous, ask clarifying questions on that issue and move to the next queued one while waiting.

3. **Never remove your own agent label.** Status labels (`in-progress`, `in-review`, `blocked`) swap as work moves; assignment labels stay.

4. **Issue body is frozen during active work.** Once an assignee has commented "picking up" / added an `in-progress` or `in-review` label / filed a PR referencing the issue, the body **is the assignee's working spec** and should not be edited. Scope corrections, additional requirements, clarifying details, regex fixes — all go as **follow-up comments** in the issue thread.

   **Why:** editing the body mid-flight either changes the target under the assignee's feet (they started on spec v1, are now reading v2) or is silently lost (they don't re-fetch the body after starting). A thread comment is visible, acknowledged, and dated. Both silent failure modes are worse than the tiny friction of posting a comment.

   **When body edits ARE fine:**

   - Before anyone has engaged (issue just-filed, no `in-progress` label, no assignee comments)
   - The assignee is the one editing their own issue body
   - Fixing obvious typos or broken links (not scope)

   **When body edits are NOT fine:**

   - Assignee has commented "picking up" / is actively working
   - An `in-progress` / `in-review` label is set
   - A PR referencing the issue is open

   If a correction is substantive enough that the assignee would want to re-read from scratch, consider closing the current issue and filing a replacement with a clear back-reference — rather than in-place body rewrite.

5. **Auto-opened issues break the peer-agent-reporter assumptions.** When an issue is filed by `github-actions[bot]` or any other non-human/non-agent bot, the peer-reviewer-verifies-the-fix loop that rules 1-4 assume doesn't apply — the bot-reporter can't verify, can't be routed-to as a reviewer, and can't sanity-check closure. Three specific adaptations:

   - **Use `Refs #N`, not `Closes #N`, in the fix PR body.** The auto-close keyword bypasses the verification step the bot-reporter can't perform. Prefer an explicit close after the next post-merge run independently confirms the fix worked — not the PR merge itself, which fires before verification.
   - **Route the review ping to `@macf-science-agent[bot]`** (or whichever peer agent would normally review), **not by echoing the `@<bot-reporter>` mention from the auto-open body.** The auto-open's `@mention` addresses the agent who should FIX, not the one who should REVIEW. Self-mention loops don't fire the routing workflow — the PR sits unreviewed.
   - **Wait for the next auto-run to confirm green, then close with a comment citing the green run's SHA + URL.** If the auto-opening workflow has a self-close-on-green step (e.g., `e2e.yml` has one per #166), trust it — don't pre-empt by closing manually or via PR auto-close keyword. For workflows without a self-close step, close manually only after observing the next run green.

   **Why this rule matters:** lucky timing isn't a verification gate. If a fix is incomplete, auto-close on PR merge closes the issue 2 seconds before the next run fails anew — producing a misleading closure trail. The "stays open until green" contract the auto-open body sets needs to be honored on the machine-enforced side, not relied on operator-discipline.

   **Example auto-opened issues in this repo:** E2E cadence failures on `main` (#149 workflow auto-opens a `code-agent`/`blocked` issue with title prefix `ci(e2e): post-merge suite failing on main`); dependency-drift alerts; future `/sign` / cert-rotation health alarms. The pattern generalizes to any workflow that files on failure.

---

## Communication

1. **@mention in EVERY comment.** Routing depends on it. A comment without @mention is invisible to the recipient agent.

2. **All discussion in issue comments, not PR comments.** Issue threads are visible on the Projects board and persist after PRs are merged or closed.

3. **Verify your comment actually posted — describing ≠ doing.** Writing a review / LGTM / close-comment / status-update as prose in your response is NOT the same as posting it to GitHub. Only executed `gh issue comment` / `gh pr comment` / `gh issue close` tool calls reach the repo; chat output is invisible to other agents. Treat the verification step as a **mandatory tail**, not optional, on any review-producing turn.

   **After any `gh ... comment` / `gh ... close`:**

        gh issue view <N> --repo <owner>/<repo> --json comments \
          --jq '.comments[-1].author.login'

   Confirms (a) the comment exists, (b) attribution is correct (bot not user — see Token & Git Hygiene below).

   **Signs you may have missed the tool call:**

   - Your last action was describing a review / decision / close in prose
   - The recipient's status comment says "waiting for review" or "ready for you to close" with no reply from you visible on the thread
   - Time has passed since you "reviewed" but no downstream activity (merge, follow-up questions, re-review request) has happened

   When in doubt, run the `gh issue view` check. Cheap to verify; costly to have the assignee wait on a review that never arrived.

4. **Concise comments** — 1-3 sentences unless detail is needed.

5. **Inbound review requests are action asks that block the requester — not status FYIs.** Issue Lifecycle rule 2 covers the implementer's OUTBOUND queue ("work through your assigned-label queue without prompting"). This rule covers the symmetric REVIEWER-side INBOUND obligation, which is just as load-bearing and far easier to strand.

   **(a) Treat "PR ready: #N" / "ready for review" as a request that blocks the peer's next move.** When a peer posts a review-request comment on a thread, that is not an informational status update you can note-and-defer — it is an action ask directed at you. The LGTM/merge-gate makes this structural: per `pr-discipline.md`, a peer's PR cannot merge without a reviewer's **formal approval** (`gh pr review --approve`), so until you review, the peer is blocked. Not slowed — blocked, and silently, because nothing on their side surfaces "my reviewer never saw this." A stranded review request stalls the peer indefinitely. Pick it up, review honestly, and submit a formal approve / request-changes (not a plain comment — see `pr-discipline.md §"How to submit LGTM"`; only the formal state-change fires the reviewer-notification routing).

   **(b) Run an INBOUND review-sweep before declaring idle — especially after surfacing from a long single-threaded task.** Before you say "caught up" / "nothing pending" / "your call" / go idle, sweep your repos for review requests addressed to you. This matters most right after you surface from a deep, single-threaded arc (a long workflow, a multi-step investigation): while you were heads-down on one thread, a review request can have arrived on another and been easy to miss.

        # Peer-authored PRs awaiting YOUR review (review not yet given):
        for r in <your-repos>; do
          gh pr list --repo "$r" --state open \
            --json number,author,reviewDecision,title \
            --jq '.[] | select(.reviewDecision == "REVIEW_REQUIRED" or .reviewDecision == null)
                       | select(.author.login != "<your-login>")'
        done
        # Plus: open threads where you were @mentioned and haven't replied.

   (The query intentionally surfaces *any* peer-authored PR lacking a review, not only those that formally requested you by name — on a small fleet that breadth is a feature: it catches a peer blocked on review even when the request didn't route to you. Narrow it with a requested-reviewer filter on a larger fleet.)

   **Why the sweep is necessary — and why it's mechanism-agnostic.** Routing delivers each notification as a **discrete event at the moment it occurs** — a push to your channel-server, an A2A message — not as a standing inbox you can re-open and re-read later. Once that event has been delivered (or has arrived while you were mid-turn on a different thread), it is not re-presented to you on its own. So a review-request ping that landed while you were deep in another task is gone from the live stream and only recoverable by querying GitHub state directly. This is the **general silent-fallback shape** (see `silent-fallback-hazards.md`): the routing layer reports the ping delivered, but "delivered" does not guarantee "processed by the recipient," and nothing surfaces the gap until the blocked peer escalates. The sweep is the result-invariant check at the reviewer boundary — assert against GitHub state ("are there peer PRs awaiting my review?") rather than trusting that you'd remember every ping that flowed past.

   **Verified motivation:** three operator-surfaced stalls where a peer's review request sat idle (42 min in one case; ~2.5 h in another) because the reviewer went idle without sweeping — the ping had arrived during a long single-threaded task and was never picked back up. In each case the peer's PR was blocked the entire time on a formal approval that never came.

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

### Canonical tmux launch pattern

**One session per agent, named `<project>@<agent>`.** Post-v0.2.10, `claude.sh` self-wraps in tmux with this naming structurally — bare `./claude.sh` produces the canonical session. Pre-v0.2.10 consumers (and operators wanting manual launch) use the explicit form:

        # Post-v0.2.10 (canonical, structural — recommended for new consumers):
        cd /path/to/academic-resume && ./claude.sh
        #   Self-wraps in tmux session "academic-resume@cv-architect" automatically.
        #   Re-attaches if the session exists; creates new if not.

        # Pre-v0.2.10 (manual wrap, still works post-v0.2.10 with MACF_NO_TMUX_WRAP=1):
        tmux new-session -d -s "academic-resume@cv-architect" \
          "cd /path/to/academic-resume && ./claude.sh"

        tmux new-session -d -s "academic-resume@cv-project-archaeologist" \
          "cd /path/to/academic-resume && ./claude.sh"

**Why this matters:** when the channel server's `tmux-wake` path (macf#185) auto-detects its own tmux target via `$TMUX_PANE` or `tmux display-message`, a **shared session with one window per agent** produces ambiguous resolution — two server processes in different windows of the same session can end up with identical auto-detected targets, and wakes land on the wrong pane. Empirically observed during the 2026-04-21 bilateral e2e smoke (chain broke when archaeologist's wake delivered to cv-architect's pane).

**One session per agent** gives each server process a deterministic `$TMUX_PANE` + one-window-per-session context where `display-message` can't be ambiguous.

**Session-name convention `<project>@<agent>`** is parseable (both human + script-friendly) and collision-free across projects — two `cv-architect` agents on the same VM (one for `academic-resume`, one for `macf-paper`) stay on separate sessions.

**Bonus**: separate sessions mean multiple terminals can attach to different agents independently — `tmux attach -t academic-resume@cv-architect` on one terminal, `...@cv-project-archaeologist` on another, without windows-switching interference.

**Migration** from a single-session multi-window setup: `tmux rename-session -t <old-name> <new-name>` per agent.

**Path-2 promotion (macf#313, v0.2.10):** the canonical session-naming rule is now structurally enforced by `claude.sh` itself. Consumer workspaces converging on v0.2.10+ via `macf update --plugin` get the self-wrap automatically; substrate launchers (operator-authored, NOT generated by `claude-sh.ts` template) are unaffected. For mixed-version fleets, pre-v0.2.10 consumers continue to need the explicit `tmux new-session` wrap until they update.

**Opt-out (post-v0.2.10):** `MACF_NO_TMUX_WRAP=1 ./claude.sh` skips the self-wrap. For operator-driven manual launches outside tmux, debug sessions, single-shot CLI use, CI environments. Sister convention to `MACF_OTEL_DISABLED=1`, `MACF_SKIP_TOKEN_CHECK=1`, `MACF_SKIP_MENTION_CHECK=1`.

---

## Token & Git Hygiene

1. **Refresh GH_TOKEN before every `gh` or `git push`** — tokens are 1-hour installation tokens. Use the canonical helper, and **fail loud** if it doesn't work:

        GH_TOKEN=$("$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \
          --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
        export GH_TOKEN

   **Use `$MACF_WORKSPACE_DIR/` as the path prefix, not `./`.** The relative-path form (`./.claude/scripts/...`) breaks the moment you `cd` to another repo for cross-repo work — the `$(...)` substitution returns empty, `export GH_TOKEN=""` silently succeeds, and the next `gh` call falls back to stored user auth. `$MACF_WORKSPACE_DIR` is set by `claude.sh` to the agent's workspace absolute path and resolves regardless of cwd. Same principle for `KEY_PATH`: `claude.sh` rewrites relative key paths to absolute at launch so helper invocations from any cwd still find the key.

   **Why this matters:** the `#140` PreToolUse hook catches this class at tool-call time (empty `GH_TOKEN` → blocks the `gh` call before it runs). But the hook adds friction — the command aborts, the operator retries with the correct pattern. Using absolute paths from the start avoids the abort-retry loop entirely.

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

7. **Structural enforcement: the PreToolUse hook.** Every workspace ships with `.claude/scripts/check-gh-token.sh`, wired into `.claude/settings.json` as a PreToolUse hook on `Bash`. It intercepts every `gh` and `git push` invocation (including wrapped forms like `sudo gh ...`, `GH_TOKEN=x gh ...`, `env FOO=bar gh ...`) and blocks with `exit 2` if `GH_TOKEN` is missing or doesn't have the `ghs_` prefix. This moves enforcement from operator discipline (rules 1-3 above) to the harness itself — without it, the attribution trap recurred 5 times in a single day (see #140). If you ever need to run a knowingly user-attributed op (e.g., `gh auth login` during onboarding), set `MACF_SKIP_TOKEN_CHECK=1` for that one call. The hook is installed by `macf init`, refreshed by `macf update` and `macf rules refresh`.

---

## Sandbox Configuration (Bash dev-loop unblocking)

Claude Code 2.1.92+ has a seccomp regression on Linux ([anthropic/claude-code#43454](https://github.com/anthropics/claude-code/issues/43454)) that breaks Bash tool calls inside the sandbox during the spawned shell's own startup — zsh tries to read `/proc/self/fd/3` before any user-code runs and the regression denies that read. Even with `sandbox.filesystem.allowRead: ["/proc/self/fd"]` in place (per macf#208), the regression still bites because it hits before the allow-rule applies.

**Workaround**: add common dev-loop commands to `sandbox.excludedCommands` so they run unsandboxed. The sandbox still gates anything not on the list; only the listed prefixes opt out. `macf init` / `macf update` / `macf rules refresh` install a canonical set per macf#211 — operator-authored entries are preserved on refresh.

**Canonical set** (kept in lockstep with `SANDBOX_EXCLUDED_COMMANDS` in `packages/macf/src/cli/settings-writer.ts`):

- **Build-loop / deployment**: `ssh:*`, `scp:*`, `rsync:*`, `devbox:*`, `nix:*`, `git:*`, `gpg:*`, `gpg-agent:*`, `gh:*`, `npx:*`, `npm:*`, `node:*`, `make:*`, `tmux:*`, `jq:*`, `openssl:*`
- **Search/read**: `grep:*`, `rg:*`, `find:*`, `head:*`, `tail:*`, `cat:*`, `ls:*`, `wc:*`, `sort:*`, `awk:*`, `sed:*`, `diff:*`, `which:*`
- **Shell wrappers**: `bash:*`, `sh:*`, `xargs:*` (subprocess shells fail at zsh-init under the regression even when the inner command is a no-op)
- **Low-blast-radius fs mutations**: `mkdir:*`, `cp:*`, `touch:*`. **Destructive ops (`rm:*`, `mv:*`) are intentionally NOT in the list** — keeping them sandboxed limits accidental damage paths even though the sandbox is defense-in-depth here.

**Opt-out**: `MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1` skips the canonical install. Aligned with `MACF_SANDBOX_FD_FIX_SKIP` / `MACF_OTEL_DISABLED` opt-out family. If you want a tighter list (e.g., drop the fs-mutation entries), set the skip flag and curate manually — refresh won't re-add canonical entries you removed.

---

## When to Read vs. Modify These Rules

- **Read:** Every session start. These rules define how you coordinate.
- **Modify:** Never directly in workspace copies. Edit the canonical file at `plugin/rules/coordination.md` in `groundnuty/macf`, then run `macf update` in each affected workspace.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale. Peer-review applies.
