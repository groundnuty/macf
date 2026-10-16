# Delegation issue template

The full template for an issue that hands work to another agent. The distributed rule `delegation-template.md` holds the short core; this is the long form to copy from.

```markdown
## Context

<What this is part of: link the parent issue, design doc or DR. Why the task exists.>

## Goal

<One sentence stating success. If it needs more, split the task first.>

## Acceptance Criteria

- [ ] <specific, testable, externally verifiable>

## Dependencies

- Depends on: #<N>
- Blocks: #<M>
- (or "none")

## Pointers

- Design ref: <path or link>
- Files to touch: <paths>
- Existing patterns: <where to look>
- Prior art: <similar work already done>

## Notes

<Gotchas, tradeoffs, rejected alternatives; library docs the assignee should re-check.>

---

@<peer-agent>[bot] please take a look and ask if anything is unclear.
```

- Keep the headings and their order, so a peer finds the acceptance criteria without hunting and scripts can extract fields. Deviate only when the domain needs different sections (research tasks, for example), and keep several distinct level-2 or level-3 headings.
- Apply the assignee label (`code-agent`, `science-agent` and so on) at creation. It routes the issue. For backlog mode apply no assignee label and use a `backlog` label if the project has one.
- Optional labels: area (`phase:P1`, `docs`), type (`feat`, `fix`, `chore`), priority (`priority:P0`).

## After filing

1. Comment "Filed #<N> for this." on any related issue or PR.
2. Add the issue to the project board if it is not added automatically.
3. Continue with other work; you are @mentioned when it is your turn again.

## Receiving the work back

1. When the peer opens a PR, read the diff with its surrounding code, not only the hunks.
2. Review with `gh pr review --approve` or `--request-changes` (see `pr-discipline.md`); give reasons with file:line and @mention the peer.
3. After a push, review the delta only, then approve or list what remains.
4. The implementer merges; the reviewer does not.
5. If the peer pushes back, read it fully, adjust if they are right, and if you still disagree give a concrete reason (a DR, a codebase pattern, an acceptance criterion). Escalate to the requester rather than overriding.

## When no PR is needed

Questions and clarifications resolve in comments, and the reporter closes the issue. Anything that produces an artifact gets a PR.

## Delegation by routing stage

Stage 0 and 1 (no routing): nobody to delegate to. Stage 2 (SSH and tmux) and stage 3 (MACF channels): the routing action forwards labelled issues and mentions to the peer. Filing before routing exists only piles up unrouted issues, so ask whether to file for tracking or wait.
