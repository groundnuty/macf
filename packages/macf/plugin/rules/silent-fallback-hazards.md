# Silent fallbacks

An operation can report success (exit 0, HTTP 200, a green run) while its outcome is wrong: the wrong identity, the wrong target, or nothing happened at all. The exit code cannot show this, so check the result.

## What to do

- After a write that matters, check its result where no hook does: the content of the file you wrote, the receipt the recipient logged. `check-gh-attribution.sh` already checks who authored a comment, issue, PR or close.
- When a check cannot see what it is checking (an unreachable endpoint, a write-only secret, a 404 on a private resource), report the result as unknown, not as passing.
- Before treating any output as evidence, ask whether it would look different if your claim were false. If not, it proves nothing.
- Find your own files, logs and targets from your identity (your config and environment), not by scanning for the newest match; on a shared host the newest match is often a peer's.
- Where you can, make the bad state impossible (validate input before writing, reject a malformed payload) rather than detecting it afterwards.
- Treat a green CI or router run as proof that the run finished, not that it delivered: a delivered and a dropped message produce the same green run. Check the routed line and the recipient's receipt.

## How to recognise one

Suspect a silent fallback when an operation succeeded but something downstream is wrong, when both the intended path and a fallback path report success, or when finding the failure takes a check of the result rather than of an error.

## Defence patterns

Other rules and code cite these by letter.

- A: after the operation, assert the result (who authored the post, what was written, that a receipt was logged).
- B: before the operation, validate the input on the properties you own (non-empty, expected prefix, safe characters), not on a provider's internal format, which can change.
- C: confirm a tmux delivery by a change in the captured pane content; `#{session_activity}` does not track agent activity.
- D: at a workflow's start, check every required secret and variable and report all the missing ones in one error.
- E: decide in the receiver's code, from the event type, which notifications start a turn, so agents cannot trigger each other in a loop.

## Instance index

Code, hooks and docs cite incidents as "Instance N". Each is described in `design/silent-fallback-catalog.md` in groundnuty/macf.

1 a missing token falls back to the user's login · 2 close keywords fire regardless of context · 3 a tmux wake is swallowed by another input consumer or a dialog · 4 two log stores answer the same query differently · 5 a misnamed workflow secret is substituted as empty · 6 agents notify each other in a loop · 7 counters reset with each short-lived process · 8 telemetry goes to a dead endpoint · 9 a failed publish leaves orphan attestations · 10 retired · 11 a retrying action exits 0 after every retry failed · 12 a guard checks the command as written, not what it does · 13 review routing misses the agent gated on the review · 14 a mention with no anchor and no message · 15 a missing channels flag leaves the agent deaf · 16 a CA rotation orphans copies it cannot update · 17 a health check asserts a proxy, not the property · 18 a one-agent routing table · 19 a stale copy produces confident wrong output · 20 the subject is found by scanning, not by identity · 21 the tests never exercise the seam that broke
