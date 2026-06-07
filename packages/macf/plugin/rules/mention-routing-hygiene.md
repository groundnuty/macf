# Mention-Routing Hygiene

**GitHub `@handle[bot]` mentions fire the Agent Router workflow regardless of surrounding context. When you are writing *about* an agent — quoting its output, analyzing its behavior, describing it in documentation — code-format the handle to suppress routing. Raw handles are reserved for intentional routing targets.**

GitHub's @mention semantics treat any bare `@handle` in a comment or PR body as a routable signal. The macf-actions router picks these up and forwards the reference to the named agent's tmux session, regardless of whether the reference was in an addressing context ("please take a look") or a describing context ("tester-2's response was…"). When described-not-addressed mentions fire routing, the referenced agent receives an ambient ping asking for an action that was never actually requested. For rules-loaded agents, this typically triggers scope-discipline reasoning (read context, recognize content-reference, cite `agent-identity.md §Not-for-testers`, stand down) and a response comment explaining why. Multiply this across scenario PRs that analyze tester behavior, insight documents that reference agents as research subjects, or cross-agent research commentary — testers and other agents get pinged for every describing use of their handle.

The fix is one character per handle: wrap the `@` and bracketed `[bot]` in backticks. The convention is cheap to apply; the cost of skipping it is proportional to how much the fleet writes about other agents.

---

## 1. The two modes

**Addressing** — you want the agent to see this and respond / act:

    @macf-code-agent[bot] please review PR #12 when convenient.

**Describing** — you are writing about the agent; no routing needed:

    The `@macf-tester-2-agent[bot]` response quoted `coordination.md` rule 1 verbatim.

The difference is a single pair of backticks. Both forms still render recognizably in GitHub's UI; only the raw form fires routing.

**Decision rule when unsure:** ask whether the agent receiving this comment should treat it as an action ask. If yes → raw. If no → backticked.

---

## 2. Contexts where describing happens

These are the common places the describing form applies. Not exhaustive; the principle generalizes:

- **PR bodies** quoting another agent's output verbatim (scenario transcripts, review excerpts, observation snippets)
- **Issue bodies and comments** analyzing agent behavior for research or post-mortem purposes
- **Observation logs** and **insight documents** referencing agents as research subjects
- **Canonical rule files and documentation** citing agent handles as examples
- **Paper drafts** and **research notes** in which agents are data, not interlocutors
- **Cross-agent commentary** where you are synthesizing what multiple agents did

In each of these, raw `@handle` will fire routing. Backtick-wrap.

Handles inside fenced code blocks (triple-backtick) or 4-space-indented blocks are already safe — GitHub's mention parser skips code contexts. Backtick-wrapping is for inline prose where a bare `@handle` would otherwise be parsed as a routing target.

---

## 3. Contexts where addressing happens

These are the legitimate routing targets — keep the raw form:

- The closing line of a PR body that asks a reviewer to look: `@macf-science-agent[bot] ready for review.`
- Direct replies on a thread where you expect the agent to act: `@macf-code-agent[bot] pushback: see file:line ref below.`
- Handoff comments: `@<reporter> ready for you to close when verified.`
- Escalation pings when blocked.

If a comment contains both describing and addressing references to the same agent, the describing form gets backticks and the addressing form stays raw.

---

## 4. Verification check before posting

For any comment or PR body that contains agent handles, grep the draft:

    grep -nE '@[a-zA-Z][a-zA-Z0-9_-]*\[bot\]' <draft-file>

(This pattern matches the broadened `HANDLE_PATTERN` documented in §7 — covers macf-* fleet, future CV fleet, and third-party bots like `dependabot[bot]` / `github-actions[bot]`.)

For each line returned: is this line an action ask (raw stays) or a content reference (backticks wrap)?

If you don't want to verify per-line, the safe default is: **backtick by default, un-backtick only the addressing lines**.

Drafts you run through this check regularly: scenario PR bodies that include preserved artifacts, observation-log entries, insight files, review comments that quote the agent being reviewed.

---

## 5. Alternative forms (same effect, lower readability)

All three of these suppress routing; the choice is stylistic:

- **Backticks** (preferred): `` `@macf-tester-2-agent[bot]` ``
- **Escape sequences**: `\@macf-tester-2-agent\[bot\]`
- **Label form**: "tester-2" or "the tester-2 agent" (for prose where a full handle isn't needed)

Backticks are preferred because they render as inline code in GitHub's Markdown, which is semantically meaningful ("this is a handle identifier being referenced") and visually distinct from raw routing targets.

---

## 6. Symmetry — this rule applies to every agent

The convention is **bidirectional** across the fleet. Every agent that writes commentary referencing other agents applies the same rule:

- Science-agent writing about testers → backticks
- Code-agent writing about testers → backticks
- Testers writing about each other → backticks
- Operator-thread comments quoting agent output → backticks (operator is human but the convention applies for consistency)
- Devops, CV, future-fleet agents → backticks

Asymmetric adoption breaks the protocol: if only some agents escape handles, the others continue leaking routing from the contexts they miss. Symmetric adoption is what makes the convention enforceable.

---

## Why this rule exists

Routing is a global side-effect. Unlike most GitHub semantics, `@mention`-based routing in MACF does not differentiate the grammatical role of the handle — whether the sentence is about the agent, directed at the agent, or merely mentions the agent in passing. The router sees the handle and fires.

Without the backtick convention, every describing use of a handle produces a false-positive ping. For rules-loaded agents that correctly apply scope-discipline when incorrectly routed, this means they must spend attention reading the context, identifying that they were referenced-not-addressed, citing the applicable rule, and posting a stand-down comment. Each firing is a few seconds of noise per agent — but the describing form of a handle is far more common than the addressing form, so the noise accumulates quickly.

The failure-mode was observed on `macf-testbed#9` and `#18` (2026-04-24): a single rules-loaded tester received three ambient routing pings across two scenario PRs, correctly disciplined each response with scope-preserving rationale, and escalated the third firing into a cross-session-commitment-tracking critique of the author. That sequence of responses was appropriate — but it was also three response turns that could have been prevented by one keystroke of backticks per handle reference in the PR bodies.

The rule is cheap to apply, symmetric across the fleet, and eliminates a class of false-positive routing that otherwise compounds with every describing use of an agent handle.

---

## 7. Structural enforcement — `check-mention-routing.sh` PreToolUse hook

Per `groundnuty/macf#244` + `#272`, this rule is enforced by a Claude Code PreToolUse hook on `Bash` tool calls. The hook intercepts `gh issue comment` / `gh pr comment` / `gh issue close --comment` / `gh pr close --comment` invocations, parses the `--body` content, and runs **two checks** that BLOCK (`exit 2` with stderr explanation):

- **Check B — must-not-leak (macf#272, shipped PR #275):** raw `@<bot>[bot]` patterns in describing-context positions (mid-line, not backticked, not at line-start) would fire false-positive routing per §5. Applies to all comment-emit subcommands including `gh (issue|pr) close --comment` (leak prevention is independent of recipient semantics).
- **Check A — must-have-mention (macf#244):** comment bodies with zero routing-active `@<bot>[bot]` mentions silently fail to reach the recipient peer agent per §Communication 2 ("a comment without @mention is invisible to the recipient agent"). Routing-active = NOT wrapped in backticks; both line-start addressing AND mid-line describing-leaks count toward the active total. Applies only to `gh (issue|pr) comment` — close subcommands are bypassed because self-close verification comments are canonically reporter-internal (no recipient).

The hook is the same shape as `check-gh-token.sh` (#140 attribution-trap defense) — bash command-type hook distributed via `macf init` / `macf update` / `macf rules refresh` to every workspace's `.claude/scripts/check-mention-routing.sh` with the entry registered in `.claude/settings.json` `hooks.PreToolUse`. Substrate workspaces, tester agents, CV consumers, and future MACF-consumer projects all get the protection uniformly.

Because the hook is registered as a path-invocation (`"command": "$CLAUDE_PROJECT_DIR/.claude/scripts/check-mention-routing.sh"`), Claude Code execs the script fresh on every event, so a change to the **script body** goes live on the very next event as soon as the file is synced on disk — a `macf update` that updates the script is immediately in force for consumers with no session relaunch and no relaunch-coordination needed. Only a change to the hook **registration** in `.claude/settings.json` (or to the launch environment) requires a relaunch to take effect.

**Heuristic** (subject to refinement; documented for transparency):

- Already wrapped in backticks (`` `@<bot>[bot]` ``) → routing-suppressed; allowed (canonical describing form §5); does NOT count toward Check A
- At line-start (after optional whitespace, blockquote `>`, or list-item markers `* ` / `- ` / `1. `) → routing-active; allowed by Check B (canonical addressing form §3); counts toward Check A
- Mid-line raw mention → routing-active; Check B BLOCK with stderr citing this rule + the offending line + the `MACF_SKIP_MENTION_CHECK=1` operator override
- Zero routing-active mentions in body (Check A) → BLOCK; only fires when neither line-start addressing nor (any other) routing-active mention is present

**Pattern scope (broadened per macf#276):** the hook's `HANDLE_PATTERN` matches ANY `@<handle>[bot]` shape — not just `@macf-*-agent[bot]`. Specifically:

```
HANDLE_PATTERN='@[a-zA-Z][a-zA-Z0-9_-]*[[]bot[]]'
```

Coverage:

- **macf-* fleet** (`macf-code-agent`, `macf-science-agent`, `macf-tester-N-agent`, `macf-devops-agent`) — original target.
- **Future CV fleet** (`cv-architect`, `academic-resume-author`, similar shapes) — naming convention may not follow `<prefix>-*-agent`; the broadened pattern accommodates whatever shapes consumer projects choose.
- **Future MACF-consumer fleets** — same logic; durable across naming conventions.
- **Third-party bots** (`dependabot`, `github-actions`) — these don't fire MACF routing (not in the agent registry, so the routing-Action workflow drops them silently), but blocking their describing-context use is consistent style. Operators can use `MACF_SKIP_MENTION_CHECK=1` for the rare legitimate describing-context use of a third-party bot handle.

The first-character-must-be-letter constraint excludes `@1bot[bot]` / `@_bot[bot]` / `@-bot[bot]` / `@[bot]` (no handle body) — none of which are valid GitHub handles anyway.

**Note on code blocks (clarification per macf#277):** The hook does NOT parse Markdown structure. Triple-backtick fences and 4-space-indent code blocks are both currently passed by the hook, but the *mechanism* differs:

- **Triple-backtick code blocks** — pass via the *adjacent-backtick check* in the heuristic (the `` ` `` characters bracketing the block satisfy the "already wrapped in backticks" predicate at the handle's character positions).
- **4-space-indented code blocks** — pass via the *line-start addressing allowance*, not via code-block recognition. The leading whitespace satisfies the line-start regex `^[[:space:]>]*([0-9]+\.[[:space:]]+|[-*][[:space:]]+)?` ahead of `@<bot>[bot]`, so the line is treated as addressing form (§3) and allowed. Same outcome as the triple-backtick case, different reasoning.

This is a heuristic side-effect, not an explicit code-block parser. If a future refinement tightens the line-start allowance (e.g., requires the FIRST non-whitespace character on the line to be `@`), 4-space-indented examples would need explicit backtick-wrapping or the `MACF_SKIP_MENTION_CHECK=1` override on the affected `gh ... comment` invocation. GitHub's renderer parses code blocks correctly regardless — the documented routing-firing risk (§2) is unaffected by the hook's heuristic.

**False-positive trade-off:** The heuristic leans toward false-positive over false-negative. Edge cases the heuristic flags:

- Single-line bodies with addressing form right after `--body "` (no preceding newline) — operator should typically put addressing on its own line in multi-line bodies
- Line-start mentions that are actually describing-with-bot-as-subject ("`@bot`'s response was clean") — these are uncommon; canonical idiom puts describing references inside prose

The override (`MACF_SKIP_MENTION_CHECK=1`) handles legitimate cases. Per the `check-gh-token.sh` precedent, structural enforcement plus an escape hatch outperforms behavioral discipline alone.

**Empirical motivation:** `groundnuty/macf-science-agent:research/2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md` recorded 6 self-observed routing-hygiene class breaches in 1.5 days. Codification of this rule (§1-6 above) caught ~80%; the structural hook closes the remaining 20%.
