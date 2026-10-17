# Delegating work

Delegate when the peer is better placed than you: it owns the repo or has the domain expertise or persistent context, or you want a non-author to review. Do the work yourself when the peer's first move would be to ask you for your notes, or when you are the domain expert; say so in the PR or handoff comment so the peer is not left guessing.

Write the issue with six sections, in this order: Context, Goal, Acceptance Criteria, Dependencies, Pointers, Notes. The assignee label routes the issue; a mention in its body does not.

Decide whether the work is for now or the backlog; ask only when someone asked you to delegate and left the timing unclear. Now means the assignee label goes on at creation, which wakes the peer. Backlog means a `backlog` label and no assignee label. After filing, continue with other work; you are mentioned when it is your turn.

## Verifications to forbid

In the Acceptance Criteria, name any obvious verification that would prove nothing, and say why; leaving it unlisted is not enough.

- Circular: a reference value derived from what it checks (scaffold a manifest from live state, then diff it against live state; a fixture and its expectation built by the same helper). Agreement proves nothing, so there is no correct version.
- Unspecified consequence: if an issue says a state is "a skip, not a halt" but not what it exits, the test will invent an exit code. Put the consequence in the Acceptance Criteria ("a roll that leaves any agent behind exits 2").
- Excluded case: a population that cannot produce the failing case (all-created fixtures, a warm org). Ask which case the population lacks, and whether that is the case the code gets wrong.
