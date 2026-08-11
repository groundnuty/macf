# PR Discipline (canonical, shared)

**This file is the single source of truth for how MACF agents use pull
requests as the default merge checkpoint.** It is copied into each agent
workspace's `.claude/rules/` by `macf init` and refreshed by `macf update`
/ `macf rules refresh`. Do not edit workspace copies directly — edit the
canonical file at
`groundnuty/macf:packages/macf/plugin/rules/pr-discipline.md` and re-run
the distribution.

---

## The default: PR for every artifact

**Every agent-authored change that produces a persistent artifact goes
through a pull request, not a direct commit to the default branch.**

This applies uniformly to:

- Source code (`.ts`, `.py`, `.sh`, etc.)
- Tests
- Rules + docs (`.md`)
- Config (`package.json`, `tsconfig.json`, workflow files)
- Research + findings documents
- Generated artifacts (when committed to the repo)

The PR is the merge checkpoint. Without it:

- No peer review — the reviewer who's supposed to validate can't
- No CI — tests / linters / build checks don't run on the change in
  isolation
- No audit trail — "who approved what" becomes a git-blame archaeology
  problem instead of a PR-comment lookup
- No rollback point — reverting one PR is one command; reverting a string
  of direct commits requires cherry-pick-reversing each

The cost of a PR is ~30 seconds of typing. The cost of skipping it is
paid once something goes wrong.

---

## The narrow exceptions

**Direct commit to default branch is acceptable only when ALL of these
hold:**

- The change is operator-authored at the terminal, not agent-generated
- It's a trivial recovery (typo in a config file, emergency secret rotation,
  obvious one-line unbreak)
- The operator takes responsibility verbally in a follow-up channel (team
  chat, issue comment, etc.)

**Examples that are NOT exceptions** — use a PR:

- "It's just a research doc" — still a PR
- "It's just comments" — still a PR
- "It's a small fix" — still a PR
- "CI doesn't apply to this file type" — still a PR (the review discipline
  does)
- "I'm the only one working on this repo" — still a PR (audit trail
  matters)
- "It's a content-only change, no logic" — still a PR

If you find yourself reaching for `git commit && git push origin main`
as an agent, you're probably violating this rule. Stop, branch, push, PR.

---

## PR anatomy

### Branch name

Reflects the change type + scope. Common patterns:

- `feat/<issue-number>-<slug>` — new feature
- `fix/<issue-number>-<slug>` — bug fix
- `chore/<slug>` — version bumps, dep updates, renames
- `docs/<slug>` — docs-only
- `research/<date>-<slug>` — research findings
- `refactor/<slug>` — structural changes without behaviour change

### PR title

Follows conventional commits format:

```
<type>(<scope>): <description starting lowercase>
```

Examples:

- `fix(cli): reject empty MACF_AGENT_NAME with actionable error`
- `docs(design): add dr-022 amendment j — first-publish-path gotchas`
- `research: 2026-04-22 observability stack landscape`

### PR body

Structure (scale each section to the change size):

```markdown
Refs #<issue-number>
<or: Closes #<issue-number> only if the PR author and the issue reporter are the same agent>

## Summary

<What changed and why, 1–3 sentences.>

## Approach

<How, briefly. Why this approach and not alternatives.>

## Test plan

- [x] Specific verification step
- [x] Specific verification step
- [ ] Operator-verification (if applicable)

## Notes

<Gotchas, related issues, follow-ups.>
```

---

## `Refs #N` vs `Closes #N`

Governed by **reporter-owns-closure** (see `coordination.md`):

- **`Closes #N`**: PR author == issue reporter. Auto-close on merge is
  fine because the same agent is approving the closure.
- **`Refs #N`**: PR author != issue reporter. The issue reporter verifies
  the fix before closing — auto-close bypasses that verification.

When in doubt, use `Refs`. It's the safer default.

Same applies to the close-keyword siblings: `Fixes`, `Resolves`, `Fix`,
`Close`, `Resolve`, and their tense variants. If the issue is
foreign-reporter, use `Refs` for all of them.

---

## The review loop

1. **Implementer opens the PR**, @mentions the reviewer on the issue
   thread with a pointer to the PR.
2. **Reviewer checks out the branch**, reads the diff in context, LGTMs
   or lists concerns. See `peer-dynamic.md` for what substantive review
   looks like.
3. **If concerns**: implementer pushes fix commits (don't force-push the
   review history), @mentions the reviewer again.
4. **Once LGTM**: implementer merges. See below.
5. **After merge**: implementer posts the closure handoff on the
   originating issue, per `coordination.md` rule 1.

---

## How to submit LGTM — formal review, not comment

**LGTM and "request changes" decisions MUST be submitted as formal GitHub
reviews via `gh pr review --approve` or `gh pr review --request-changes`,
not as plain `gh pr comment` text.**

```bash
# CORRECT — formal review submission
gh pr review <PR-number> --repo <owner>/<repo> --approve --body-file <review.md>

# CORRECT — formal request-changes submission
gh pr review <PR-number> --repo <owner>/<repo> --request-changes --body-file <review.md>

# WRONG — review communicated only via issue/PR comment
gh pr comment <PR-number> --repo <owner>/<repo> --body "LGTM, you can merge"
gh issue comment <issue-N> --repo <owner>/<repo> --body "@<author> LGTM on PR #M"
```

**Why this matters structurally:**

Formal review submission fires GitHub's `pull_request_review` webhook
event with `state in {approved, changes_requested}`. The MACF routing
Action's `route-by-pr-review-state` job (macf-actions v3.3.0+, per
macf-actions#39) listens for this exact event and notifies the PR author's
channel-server directly — independent of whether the reviewer @mentioned
the author in the body. **This is the structural defense for the
LGTM→merge handoff: the state-change IS the wake signal.**

If the LGTM is communicated only as a plain `gh pr comment`,
`pull_request_review` never fires; routing falls back to `route-by-mention`
which depends on body parsing (and `mention-routing-hygiene.md §5`
backtick-suppression discipline can suppress what looks like an addressing
mention). Empirically observed: cv-e2e-test rehearsals #9, #10, #11b
(2026-04-29 and 2026-04-30) — agents merged PRs without firing
`pull_request_review` at all, leaving `route-by-pr-review-state` an
untested code path despite being shipped via macf-actions v3.3.0.

**Same shape as the silent-fallback hazard class (`silent-fallback-hazards.md`):
the comment-form succeeds at the API boundary (`gh pr comment` returns 0)
but the semantic outcome (wake recipient via routing-Action's structural
defense) silently doesn't happen. Pattern A defense at the discipline
layer: assert the LGTM uses a state-change-firing mechanism, not just
text-on-the-thread.**

**The body content of the formal review** is the same kind of content you'd
otherwise put in a comment — substantive review notes, what's strong, what
needs changes, dispositions on prior feedback. The `--body-file` path is
the canonical way to pass that body without shell-quoting issues (per the
backticks-in-comments hazard noted in `mention-routing-hygiene.md`).

**This rule complements `coordination.md §Communication 2`** ("discussion
in issue comments, not PR comments"). The two surfaces serve different
purposes:

- **State-change events** (LGTM, request-changes) fire on the PR via
  formal review submission — engages the routing-Action structural
  defense (`route-by-pr-review-state`).
- **Substantive discussion ABOUT the work** persists on the issue thread
  — visible on the Projects board, persists after the PR is merged or
  closed.

Both surfaces are load-bearing. Don't skip the formal review thinking
"the issue thread is the canonical place"; don't skip the issue-thread
discussion thinking "the formal review covers everything."

**Verifying your review actually landed as a state-change** (per
`verify-before-claim.md §2`):

```bash
# After gh pr review, confirm a state-change review exists.
# Filter for APPROVED or CHANGES_REQUESTED specifically — `[-1]` alone
# can mistake a follow-up COMMENTED review for the missing state-change.
gh pr view <PR-number> --repo <owner>/<repo> --json reviews \
  --jq '[.reviews[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")]
        | last // "no state-change review"'
```

If the most recent state-change review is missing (output: `"no state-change
review"`) OR the most recent review overall has `state == "COMMENTED"` and
no prior state-change exists, the review was submitted as a comment-style
review and won't fire the `pull_request_review.submitted` event with an
actionable state — the routing won't engage. Re-submit with `--approve` or
`--request-changes`.

**When `--comment` (no state change) IS appropriate:**

- **Mid-review clarifying questions** — partial-review feedback before completing the read-through, asking the implementer to disambiguate before you decide
- **Partial-review notes** — observations on parts of the diff while the rest is in flight (e.g., "skimmed the `src/server.ts` changes; will read tests next pass")
- **Out-of-band observations** — comments on a PR that's not blocking your LGTM/changes decision (style nits, future-work suggestions, links to adjacent context)
- **Review-pickup acknowledgment** — comment like *"picking this up; will review tonight"* or *"queued behind X; ETA Y"* so the PR author knows when to expect feedback. Coordination-discipline (saves the implementer from polling) but isn't a state-change.

These don't fire structural routing; agents on both sides should treat them as informational, not as merge-gating signals.

---

## Merge-by-implementer

**The implementer who wrote the PR merges it, not the reviewer.**

Reasons:

- The implementer owns the change — they know whether the latest commit is
  actually the right state to land.
- The implementer has context on CI status, whether any flaky tests are
  noise, whether the branch needs a rebase.
- Reviewer-merge ambiguates responsibility — if the merge is broken, who
  owned it? The coordination model assumes a clear owner per action.

**The reviewer's role ends at the LGTM.** After that, the implementer
decides the merge timing (wait for CI green, rebase on main if needed,
retry on flaky CI, etc.) and executes.

If the PR author is blocked (e.g., offline), the reviewer may merge after
an explicit hand-off comment — but that's exception, not default.

### When the reviewer is absent or unreachable

**Without an explicit LGTM from the reviewer, the implementer does NOT merge — even if waiting indefinitely.**

When a PR has been open for an extended period without reviewer signal:

1. **@mention the reviewer again** on the originating issue — they may have missed routing (silent-fallback hazards class; see `silent-fallback-hazards.md` Instance 3 for a concrete failure mode where routing succeeds at the API layer but the recipient never sees the prompt)
2. **If still no response after a reasonable interval** (judgment call based on session pacing — minutes for fast-cycle work, an hour or more for deeper review): **escalate to the issue reporter** with `@<reporter>`
3. **The reporter decides**:
   - Re-route the review to a different reviewer
   - Accept self-merge as exception (with explicit comment on the PR documenting why the LGTM gate was bypassed)
   - Close the PR if the work is no longer needed

**Self-merging without LGTM is a protocol violation**, except via the explicit reporter-sanctioned exception above. The only other sanctioned merge-without-explicit-LGTM path is the "PR author offline → reviewer merges with hand-off comment" exception described in the previous paragraph.

**Why this rule exists.** The LGTM gate is structural — it ensures that someone other than the implementer has read the diff in context. Self-merge without LGTM bypasses that quality gate even if the work is correct. The escalation path preserves the gate's intent (someone else makes the merge decision) while providing a clear path forward when the registered reviewer is unreachable.

This rule was surfaced 2026-04-26 during the macf-testbed#229 Phase C iter 4 sweep — a tester self-merged when its harness driver (acting as the de-facto reviewer) was killed mid-poll. The work was correct and the scenario AC was met, but the LGTM precondition wasn't. Codified here so the protocol covers reviewer-absence symmetrically with the existing implementer-absence case.

#### Operator-sanctioned exception (groundnuty/macf#822)

When the reporter/operator sanctions a self-merge per step 3 above, `MACF_SKIP_LGTM_CHECK=1` is **NOT** the mechanism — it is a **launch-time / operator-only** flag, read from the session's process env at `./claude.sh` launch and fixed for the session's lifetime. An agent cannot set it in-session (a Bash-tool `export` runs in a subshell that never reaches the hook's process env) — see the flag's own block-stderr for the mechanics. #822 Part 1 corrected every `check-*.sh` hook's stderr to state this honestly rather than presenting `export MACF_SKIP_LGTM_CHECK=1` as an in-session fix. #822 Part 2 (this section) gives the agent an actually-usable in-band path, in preference order:

**(c) Preferred — an operator-authored GitHub artifact (un-forgeable, hook-verified).** When the workspace has `MACF_OPERATOR_LOGIN` configured (`operator_login` in `.macf/macf-agent.json`, flowing to the `MACF_OPERATOR_LOGIN` env var via `env.identity`), `check-lgtm-gate.sh` clears on **either**:

- a formal `gh pr review --approve` from the operator's own login (the operator counts as any other non-author reviewer — no special-casing needed), **or**
- a one-line PR comment authored by the operator's own login containing the exact marker `[macf-sanction-merge]` (case-insensitive) — e.g. `gh pr comment <N> --body "Reviewer's offline, sanctioning this one. [macf-sanction-merge]"`.

Either form is **un-forgeable**: an agent cannot post a GitHub review or comment attributed to the operator's own account, so the gate is verifying a real artifact, not trusting the agent's self-attestation. Same one-click (or one-comment) friction as a verbal "you can approve for me," but structurally checkable — see `check-lgtm-gate.sh`'s "operator-login sanction-comment path" for the exact query. Direction (c) is the operator + `macf-science-agent[bot]` + `macf-auditor[bot]`-advisory-reviewed outcome of #822 Part 2 (governance record: `groundnuty/macf#822`, comments 2026-08-11).

**(a) Fallback — verbal sanction, recorded in the durable artifact.** When the operator sanctions verbally (a chat message, a terminal instruction) and declines to touch GitHub — `MACF_OPERATOR_LOGIN` isn't configured, or the operator just doesn't want to click anything — the agent uses the documented direct route (e.g. `gh api` to merge, bypassing `gh pr merge` so the hook's exact-subcommand match doesn't even engage) and **records the sanction verbatim in the durable artifact**: the squash-commit body or the issue close comment, quoting who sanctioned it and why. This is self-attested, not hook-verified — acceptable specifically because it stays rare and always leaves an audit trail. **The sweepable invariant this creates:** every merge lacking a non-author APPROVED review MUST carry a recorded sanction (in the squash body, close comment, or PR thread) that names who authorized it. Auditing that invariant — a periodic sweep for gate-bypassed merges lacking a recorded sanction, plus a matching reflection-ledger entry per merge — is `macf-auditor[bot]`'s DR-026 follow-up (propose-only; not built as part of #822 Part 2 itself).

`MACF_SKIP_*` flags across the whole hook family stay **operator/launch-only** (per #822 Part 1) — there is no agent-usable in-session escape hatch for `check-gh-token.sh` / `check-mention-routing.sh` / `check-close-keyword.sh` / `check-gh-attribution.sh` / `check-auditor-never-acts.sh`, because none of those hooks have a legitimate agent-side sanctioned-exception the way the LGTM gate does (agents never do user-attributed ops, so there's no "the operator sanctions this specific bypass" case for the token/mention/close/attribution family — those either hold or the agent fixes its command). The LGTM gate is the one hook in the family with an agent-usable exception, because "operator sanctions a specific merge" is a real, recurring, legitimate case (§"When the reviewer is absent or unreachable" above) that the other hooks don't have an analog for.

### Before merging

Check `mergeStateStatus` via `gh pr view <N> --json mergeStateStatus`:

- `CLEAN` → merge
- `UNSTABLE` → a required check failed or is in-flight. Wait if
  in-flight, fix if failed
- `BEHIND` → rebase on main, force-push, re-check
- `DIRTY` → conflicts, resolve, push, re-check
- `BLOCKED` → branch protection rules not met — check reviews, required
  checks, status checks
- `UNKNOWN` → GitHub is still computing, wait ~30–60s and re-query

See `coordination.md` "When You're Stuck" for the full routing table.

Don't merge on `UNSTABLE` assuming the failing check is unrelated. If the
check is required, investigate it before merging.

### Squash vs merge vs rebase

Prefer **squash**. One PR = one commit on main. Keeps the history linear
and the commit log scannable.

Use merge-commit style only when the PR legitimately captures multiple
independent changes that should be preserved as separate commits.
Don't use rebase-merge unless the project has a specific reason.

---

## After the merge

1. **Delete the remote branch.** (GitHub prompts; take the prompt.)
2. **Post the closure handoff on the originating issue** (`coordination.md`
   rule 1):

    > `@<reporter>` PR #N merged as `<commit-sha>`. Ready for you to close
    > when verified.

3. **Do NOT close the issue yourself if you weren't the reporter.** Let
   the reporter verify + close. See `coordination.md` failure-mode-B for
   when you ARE the reporter (then close yourself).

---

## CI-aware merge timing

If the repository uses CI on PRs:

- Wait for at least the `check` job to complete before merging (or whatever
  the required-status-checks list demands).
- `UNSTABLE` + `in-flight` → wait
- `UNSTABLE` + `failed` → investigate + fix, then re-push
- Don't merge-and-then-hope-the-CI-was-flaky. If required checks failed,
  fix them before merging.

For fire-and-forget trivial changes (e.g., typo fix), waiting for CI is
still right — it's a minute, and it protects against "the typo fix broke
the build" because someone's CI job depends on the exact string you
changed.

---

## Structural enforcement — `check-lgtm-gate.sh` PreToolUse hook

Per `groundnuty/macf#270` (DR-023 UC-2), the "no LGTM = no merge" rule (codified above in §"How to submit LGTM" + §"When the reviewer is absent or unreachable" + §"Merge-by-implementer") is enforced by a Claude Code PreToolUse hook on `Bash` tool calls. The hook intercepts `gh pr merge` invocations, queries the target PR's review state via `gh pr view --json author,reviews,comments`, and BLOCKs (`exit 2` with stderr explanation) when no APPROVED review from a non-author exists AND no operator-sanction comment clears it (see below).

**Architectural shape (DR-023 amendment 2026-04-27):** this is a bash command-type hook, NOT `type: "mcp_tool"`. PreToolUse-blocking semantics + mcp_tool's non-blocking-on-disconnect failure mode are structurally incompatible — a missing or transiently-disconnected MCP server would silently allow the merge. Bash form fires uniformly across substrate workspaces (where the `macf-agent` MCP server is permanently off per operator directive 2026-04-27) AND consumer workspaces (startup window + transient disconnect periods produce silent-fail paths under mcp_tool). Same reasoning UC-4 (`check-mention-routing.sh`, PR #275) demonstrated empirically.

**The hook is the same shape as `check-gh-token.sh` (#140) + `check-mention-routing.sh` (#244 + #272):** a bash script distributed via `macf init` / `macf update` / `macf rules refresh` to every workspace's `.claude/scripts/check-lgtm-gate.sh` with the entry registered in `.claude/settings.json` `hooks.PreToolUse`. Substrate workspaces, tester agents, CV consumers, and future MACF-consumer projects all get the protection uniformly.

**Decision rule** (subject to refinement; documented for transparency):

- Command does NOT match `gh pr merge` (exact subcommand, wrapper-aware) → allow (other gh subcommands pass through unchanged)
- Command matches but no PR number can be extracted → allow (defense-in-depth; gh itself surfaces the usage error)
- Command matches AND `gh pr view --json author,reviews,comments` returns at least one APPROVED review where reviewer login != author login (after normalizing `app/` prefix + `[bot]` suffix) → allow
- Command matches AND `MACF_OPERATOR_LOGIN` is configured AND a PR comment authored by that exact login contains the marker `[macf-sanction-merge]` (case-insensitive) → allow (macf#822 Part 2, direction (c) — un-forgeable, since an agent cannot post a comment attributed to the operator's own account; see §"Operator-sanctioned exception" above)
- Command matches AND neither of the above holds → BLOCK with stderr citing this rule + the missing-LGTM diagnosis + the `MACF_SKIP_LGTM_CHECK=1` operator override + the operator-sanction-comment path
- Any infrastructure failure (gh missing, network 404/5xx, malformed JSON) → fail-open (allow). Same defense-in-depth posture as `check-gh-token.sh` and `check-mention-routing.sh` — the hook closes residual policy slips, not all merge paths

**Wrapper coverage:** the regex matches `gh pr merge` preceded by `sudo`, `env VAR=...`, `watch`, `ionice`, `setsid`, `nice`, `time`, bare-`VAR=...` env-prefix forms, and shell wrappers (`bash -c "gh pr merge ..."`, `sh -c`, `zsh -c`, including flag-prefixed forms like `bash -lc`). Same wrapper allow-list as `check-gh-token.sh` + `check-mention-routing.sh`. Chained-form leadins `;` `|` `&&` covered.

**False-positive trade-off:** the hook leans toward false-positive over false-negative on parse-failure paths. PR-number extraction tolerates URL form (`https://github.com/owner/repo/pull/N`), `owner/repo#N` shorthand, and quoted positionals. Bare `gh pr merge` (no positional, gh prompts interactively) passes through unblocked — the operator's discipline catches it because the prompt is visible.

**Override (`MACF_SKIP_LGTM_CHECK=1`) is launch-time / operator only** — read from the session's process env at `./claude.sh` launch, fixed for the session's lifetime. An in-session `export MACF_SKIP_LGTM_CHECK=1` from a Bash tool call does NOT reach the hook (Bash-tool commands run in a subshell that never persists into the session's env); to use it, the operator sets it before launch (or in the workspace's `.claude/.macf/env.*` files) and relaunches (macf#822 Part 1). It covers the same exceptions documented in §"When the reviewer is absent or unreachable":

- Reporter-sanctioned self-merge after extended reviewer absence
- The "PR author offline → reviewer merges with hand-off comment" exception
- Urgent reverts where waiting for review is itself a hazard

**For an agent-usable mid-session exception, use the operator-login sanction-comment path (macf#822 Part 2, direction (c))** documented in §"Operator-sanctioned exception" above — un-forgeable, hook-verified, no relaunch required. Fall back to (a) (verbal sanction + recorded artifact) only when `MACF_OPERATOR_LOGIN` isn't configured or the operator declines to touch GitHub.

Per the `check-gh-token.sh` precedent, structural enforcement plus an escape hatch outperforms behavioral discipline alone.

**Empirical motivation:** `groundnuty/macf-testbed#229` Phase C iter 4 sweep (2026-04-26) recorded a self-merge-without-LGTM incident — a tester self-merged when its harness driver (acting as the de-facto reviewer) was killed mid-poll. Codified in §"When the reviewer is absent or unreachable" same day. The hook closes the residual: rule-discipline catches most cases; structural enforcement catches the slips that remain.

---

## When to modify this rule

- **Read:** every session start.
- **Modify:** never directly in workspace copies. Edit the canonical file
  and re-distribute via `macf update`.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing
  the change, with rationale + the incident that surfaced the need.
