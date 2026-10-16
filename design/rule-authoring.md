# Writing and testing a rule

Maintainer guidance for authoring canonical rules in `packages/macf/plugin/rules/`. It is not distributed to workspaces.

## Test the rule against its own instances before writing it

A rule is written from instances, and those instances are its test suite. Run three checks before writing:

1. Membership: is every instance I listed in the class I described? One unifying mechanism can fit three cases and quietly under-serve a fourth.
2. Recognition: hide the diagnosis, then ask whether the stated trigger alone would flag each instance. The author already knows the answer and supplies the recognition the rule lacks. A rule inherits the trigger of the instance that prompted it, and that trigger is usually narrower than the rule.
3. Exclusion: name the nearest thing that is not an instance, and confirm the stated form rejects it. A form that recognises every candidate is a mood, not a trigger, and it certifies the mistakes its remedy cannot fix. The artifact is a pair (an in-case, an out-case, and the line between them). Asking whether the rule has counterexamples is a different question: that tests whether the rule is true, not whether its form discriminates.

Readers re-running the instance list against the stated rule catch these failures; the author rarely does. Do this before publishing, because a canonical rule reaches every workspace.

## When a correction should become a rule

Codify when a peer's correction names a recurring shape, when a concession carries framing worth keeping past the thread, or when a canonical rule misfired in a way its text does not cover. A one-off bug is not a pattern; a lesson an existing rule already states needs a reference, not a copy; a concession made only to keep the peace should be argued instead.

Several agents codifying the same lesson independently is useful evidence that it generalises. Apply the rule on the next decision after writing it.

## Where a rule lives

Distribute only what every fleet needs. Framework-internal material goes in `design/` or a path-scoped rule. Edit the canonical file, never a workspace copy, and retire a removed file by adding its basename to `RETIRED_CANONICAL_RULES` in `packages/macf/src/cli/rules.ts`.
