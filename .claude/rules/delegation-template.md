<!--
  This file is managed by `macf`. Do not edit directly — edits are
  overwritten on the next `macf update`. The canonical source lives at
  groundnuty/macf:plugin/rules/. To change a rule, file an issue or PR
  against that file in the macf repo, then run `macf update` here.
-->
# Delegation Template (canonical, shared)

**This file is the single source of truth for how one agent delegates work to
another.** It is copied into each agent workspace's `.claude/rules/` by
`macf init` and refreshed by `macf update` / `macf rules refresh`. Do not edit
workspace copies directly — edit the canonical file at
`groundnuty/macf:packages/macf/plugin/rules/delegation-template.md` and re-run
the distribution.

Applies to any MACF agent that hands off a task to a peer — coordinators
delegating to implementers, researchers delegating to reviewers, any agent
splitting off scope. Works whether the peer is another bot or a human.

---

## When to delegate vs do the work yourself

Delegation is for **asymmetric capability**, not ceremonial hand-off. Before
filing a delegation issue, ask: is the peer agent actually better positioned
to do this work than I am?

**Delegate when:**

- The peer has domain expertise the reporter lacks (framework TypeScript
  internals → code-agent; LaTeX CV typesetting → cv-architect; historical
  project research → cv-project-archaeologist)
- The peer owns the repo / the canonical source (framework changes →
  code-agent who owns `groundnuty/macf`)
- The peer has persistent context the reporter doesn't (long-running
  investigation, repository-specific conventions, team-facing
  relationships)
- The work would meaningfully benefit from review + merge discipline by a
  non-author (even if the reporter could technically do the work, the
  peer's second pair of eyes catches issues the author won't)

**Do the work yourself (skip delegation) when:**

- You have asymmetric context the peer would need to learn — delegation
  becomes "please copy my notes into a file" rather than real work
- You are the domain expert (rules about your own collaboration patterns,
  a postmortem of an incident you lived, a DR for a design you drove)
- The task is ceremonial packaging of material the reporter authored
  anyway (the peer adds no value beyond typing)
- The work is time-sensitive and the delegation round-trip would exceed
  the fix window

The test: if the peer's first action would be "ask the reporter for more
context / source material", you're delegating ceremony, not real work —
do it yourself. If the peer would immediately have everything they need
to start, delegate.

When you do the work yourself despite it being "in the peer's domain",
note it explicitly — either in the PR body or a handoff comment:

> "Authoring this directly rather than delegating to `<peer>` because the
> content is distilled from my own collaboration-pattern observations —
> `<peer>` would need me to write the text anyway. See
> delegation-template.md 'When to delegate' for the principle."

Transparency preserves the peer relationship: the peer sees the reasoning
instead of feeling bypassed, and the coordinator can push back if they
disagree with the self-authored call. Default to delegating when in
doubt — the PR review step gives the peer their voice regardless.

---

## The 6-section issue template

When you file a delegation issue for another agent, structure the body so the
peer can start without coming back for clarification. Consistency matters more
than any single section — the same headings in the same order make the body
scannable and automation-friendly.

```markdown
## Context

<What is this part of? Link to parent issue, design doc, DR. Why does this
task exist? What problem is it solving?>

## Goal

<One-sentence statement of what success looks like. If you can't write it in
one sentence, the task is too big — split first.>

## Acceptance Criteria

- [ ] <specific, testable, externally verifiable>
- [ ] <specific, testable, externally verifiable>
- [ ] <specific, testable, externally verifiable>

## Dependencies

- Depends on: #<N> (must be done first)
- Blocks: #<M> (waiting on this)
- (or "none" if truly standalone)

## Pointers

- Design ref: <path or link to the DR / spec / research doc>
- Files to touch: <paths>
- Existing patterns: <where to look in the codebase for reference>
- Prior art: <similar work already done>

## Notes

<Gotchas, tradeoffs you considered, alternatives rejected. Research-refresher
caveats — e.g., "your training data may be stale for library X; verify
current docs before implementing.">

---

@<peer-agent>[bot] please take a look and ask if anything is unclear.
```

The assignee label (`code-agent`, `cv-architect`, etc.) goes on issue
creation, not as the mention target — routing picks it up from the label.

### Why a fixed template

- **Predictability** — peer agents don't have to guess where the acceptance
  criteria are
- **Completeness check** — missing sections surface missing information at
  write time, not implement time
- **Parseability** — scripts, dashboards, and automation can reliably extract
  fields

Deviation from the template is allowed when the domain genuinely needs
different structure — e.g., research-findings tasks may need "Project
framing / Dates / Milestones / CV-angle hooks" instead of generic sections.
Keep the *shape* (multiple level-2 or level-3 headings identifying distinct
concerns); don't free-text a blob of requirements.

---

## Ask before filing

Before creating the issue, confirm with the requester (usually the user, but
it may be a coordinator peer):

> **Route this now or backlog?**
> 1. Now — peer agent picks it up immediately (applies assignee label, adds to board)
> 2. Backlog — sits on the board for later, unassigned

Getting this wrong creates noise: the assigned peer starts on something that
isn't ready, or a backlog item sits unprocessed because no one noticed the
label. Ask once; check the answer for each delegation.

---

## Labels on creation

- **Assignee label** (`code-agent`, `science-agent`, `cv-architect`,
  `writing-agent`, or whatever the target's routing label is) — the primary
  routing signal
- **Phase / area label** (`phase:P1`, `docs`, `research`, etc.) — optional
  classification
- **Type label** (`feat`, `fix`, `chore`, `docs`) — optional
- **Priority label** (`priority:P0`, `priority:P1`, etc.) — optional

Don't apply the assignee label in "Backlog" mode — routing picks up the label
and wakes the peer. Use a separate `backlog` label if your project has one,
or leave unassigned.

---

## After filing

1. Post a brief comment on any related issue / PR linking the new delegation:
   "Filed #<N> for this."
2. Add to the project board if not auto-added.
3. **Continue with other work — do not wait idle** for the peer to respond.
   You will be @mentioned when it's your turn again.

---

## Receiving work back

When the peer agent files a PR referencing your delegation issue:

1. You are @mentioned — check out the PR branch, read the diff (and relevant
   surrounding context, not just the diff lines).
2. Review honestly. Spend enough time to be sure. A quick LGTM on substantive
   work is worse than a thoughtful pushback.
3. If **LGTM**: approve + @mention the peer that they can merge.
4. If **changes needed**: list specifics (file:line references preferred),
   @mention peer, explain *why* (not just "change X to Y" — the reasoning
   matters for the peer to decide whether to push back or accept).
5. **Do not merge yourself.** The implementer merges after your approval,
   per coordination.md "merge-by-implementer" (they wrote the code; they
   own the merge).

After changes are pushed:

6. Re-review the updated diff — not the whole PR again, just the delta.
7. Either re-LGTM or list further concerns. @mention either way.

---

## Push-back acknowledgment

If the peer pushes back on your issue body or your review:

- Read their argument completely.
- If they're right, say so, adjust the issue body / requirements / review
  comments, and continue.
- If you disagree, explain *why* in concrete terms — cite the relevant DR,
  prior pattern in the codebase, or acceptance criteria. Abstract appeals
  ("standard practice", "clean code") are not substantive; point at something
  specific.
- If after discussion you still disagree, escalate to the requester (usually
  the user) rather than overriding. See `coordination.md` "Escalation".

This is the peer dynamic — not "you file, I obey."

---

## When a PR is not needed

Questions or discussions resolve in comments alone. The reporter closes the
issue when done — no PR required. Use this for clarifications, status
requests, or research-summary tasks where the output is the comment thread
itself (rare; prefer a committed doc + PR for anything citeable).

**Not "when you're in a hurry."** PR discipline (see `pr-discipline.md`) is
the default for any work that produces an artifact.

---

## Stage-appropriate delegation

| Stage | Routing mechanism | Can you delegate? |
|---|---|---|
| 0 | None (single agent) | No — you are the only agent; do the work yourself or defer |
| 1 | None (bot identity but solo) | No — same as stage 0 but with bot attribution |
| 2 | SSH + tmux routing | Yes — routing Action forwards issues / @mentions to peer |
| 3 | MACF channels | Yes — HTTP POST to peer's channel server |

Filing issues before routing is set up just piles them up unrouted. If the
peer agent doesn't exist yet, ask whether to file anyway (for tracking) or
defer until routing is online.

---

## When to modify this rule

- **Read:** every session start. This rule defines how delegations look.
- **Modify:** never directly in workspace copies. Edit the canonical file
  and re-distribute via `macf update` in each affected workspace.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the
  change, with rationale. Peer review applies.
