# DR-033: Interactive-prompt auto-responder — the allowlist-only safety contract

**Status:** Proposed
**Date:** 2026-06-28
**Trigger:** Claude Code introduces **interactive launch prompts with no documented headless/`-p` bypass** — the channels dev-flag (`"I am using this for local development"`), the resume-summary prompt (`"Resume full session as-is"`), and likely more over time (Anthropic differentiates `-p`-priced headless from the interactive TUI, so required-click moments are here to stay). MACF needs **unattended/cron relaunch** (DR-031 supervision + `macf-devops-toolkit#543`) and wants operator-launches to not stall on manual clicks. The mechanism: an **allowlist-driven interactive-prompt auto-responder wired into `claude.sh`** (`macf#645`). Because a wrong auto-answer can approve a permission grant or a destructive action, the **allowlist-only / never-answer-unknown / ceremony-not-authorization** invariants are constitutional — hence a DR, sibling to the auditor never-acts contract (DR-026). Design seeded by code-agent (`#645`), safety-contract shaped by science.

## Context

The two known launch prompts both fire at startup, render in the launcher's known tmux pane (the self-wrap), and have no `-p` bypass. The generic answer is to **drive the TUI** — watch the pane, match output against a curated allowlist, send the configured keystroke — rather than ask Anthropic for a headless flag. This is the third leg of unattended operation, alongside reliability (`#642`/#643) and channels (`#641`).

The danger is intrinsic: a mechanism that auto-answers TUI prompts is one signature-drift or one mis-scoped entry away from **auto-approving something that required a human** — a permission grant, a folder-trust, a destructive confirmation. The whole design is therefore organized around *what it must refuse to answer*, not what it answers.

## Decision

A generic, extensible **allowlist-driven auto-responder** wired into `claude.sh`, governed by three constitutional invariants. New Claude Code prompt → add a vetted config entry, not code.

**Mechanism** (reuses the `tmux send-keys` primitive we already own): `claude.sh` starts a startup-window pane watcher alongside the session → **match** pane output against a curated allowlist of `{name, signature, send, max_fires}` → **send** the configured keystroke → **verify the intended outcome**. Config lives in canonical `.claude/.macf/prompt-responses.json`, shipped by `macf init/update`, operator-extensible.

### Invariant 1 (constitutional) — allowlist-only; unknown prompt → alert, NEVER answer

Only auto-answer a prompt with an explicit, vetted `{signature → exact response}` entry. An unrecognized prompt-like pattern (a `❯` menu or `(y/n)` not on the allowlist) → **alert loudly (to the `#642` forensic log + operator) and do NOT answer.** Silence-on-unknown beats a wrong answer: a wrong keystroke could select a permission grant or a destructive option. This is the load-bearing safety property — the part a naive "detect any prompt + answer it" gets dangerously wrong.

### Invariant 2 (constitutional) — ceremony-acks ONLY; never authorization/permission/destructive prompts

The allowlist is for **ceremony acknowledgments** the operator has pre-decided fleet-wide (the dev-channels dev-flag ack, the resume-summary choice) — NOT for **authorization** prompts. The mechanism MUST NOT auto-answer a permission grant, a folder/tool **trust** prompt, or a **destructive confirmation** (`delete N files?`, `overwrite?`) — those require operator presence by definition, even if someone tries to allowlist them. This is the stronger sibling of Invariant 1: Invariant 1 refuses prompts *not on* the allowlist; Invariant 2 constrains *what may go on* the allowlist.

Enforcement is principle + mechanism: the DR states the ceremony-only rule and canonical seeds are vetted to it; **and** the config loader loud-warns (or refuses) when a signature looks authorization-shaped — substrings like `(y/n)`, `allow`, `trust`, `delete`, `overwrite`, `permission`, `grant` — operator-override available but never silent. Operator-added entries are operator-owned risk; the canonical mechanism makes the ceremony-only intent loud.

### Invariant 3 (the silent-fallback guard) — the signature must GUARANTEE the configured `send` still means the intended option

A response is typically an **ordinal** (`send: "2"`). If a future Claude Code reorders the menu (or inserts an option), `"2"` selects a *different* option — and a "did the prompt clear?" check **still passes**, because a wrong answer also clears the prompt. That is a wrong-answer-that-looks-fine — the silent-fallback shape (`silent-fallback-hazards.md`).

So the **signature must capture the full menu frame including the option text at the position the `send` targets** — e.g. the match requires the rendered block to contain `❯ 1. … / 2. Resume full session as-is`, so "option 2 is exactly this text" is part of the match. Any reorder / reword / inserted option then **breaks the match → falls through to Invariant 1 (alert, don't answer)** — safe — instead of firing a now-wrong ordinal. **The signature is not "what prompt is this"; it is "is the world still exactly as the `send` assumes."**

### Verify the RIGHT outcome, not just "prompt cleared"

After sending, re-capture and confirm the **expected post-answer state** (the session proceeded to the agent-ready prompt / the specific next screen), NOT merely that the signature disappeared — a *wrong* answer also makes it disappear. "Cleared" ≠ "correctly answered" (Pattern A: assert the intended result-invariant, not the absence of the prompt). Covers the RC "typed-but-no-Enter / typed-wrong" hazard (silent-fallback Instance 3).

### Operational guards

- **Per-prompt fire cap** (`max_fires`, default 1) — an auto-responder that fires repeatedly on a recurring pattern is itself a hazard.
- **Startup-window scoping** — the watcher runs only during the launch window, so a signature can't match the agent's own later output (false-positive defense).
- **Timing** — wait until the whole signature (all options) is rendered before sending.
- **All auto-answers logged** to the `#642` forensic log (the same trail unknown-prompt alerts land in).
- **Live-verify against the REAL prompts, never `-p`** — the prompts don't render in print mode; the watcher must run against the real pane and check (the `claude -p` lesson).

## Config (signatures as data, not code)

Canonical `.claude/.macf/prompt-responses.json`, shipped by `macf init/update`. Seed entries (ceremony-acks, vetted to Invariant 2):

```jsonc
[
  { "name": "dev-channels",   "signature": "<full frame incl. '❯ 1. ' + 'I am using this for local development'>", "send": "1", "max_fires": 1 },
  { "name": "resume-summary", "signature": "<full frame incl. the option text at position 2>",                     "send": "2", "max_fires": 1 }
]
```

(Signatures shown abbreviated; per Invariant 3 each must capture the option text at the `send` position, not just a substring of the prompt.)

## Composition with the unattended-operation family

The three legs interlock:
- The **dev-channels** seed (`send: "1"`) is what makes **`#641`'s native channels** work unattended (the dev-flag ack no longer needs a human click).
- **Unknown-prompt alerts** land in **`#642`'s** guaranteed forensic log.
- The **`macf-devops-toolkit#543` cron supervisor** (DR-031 unattended relaunch) is the highest-stakes consumer — **no operator present to catch a mis-answer**, so Invariants 1–3 matter most there.

## Boundaries

- **Not** a general TUI-automation framework — strictly the curated launch-prompt allowlist. Mid-session prompts (if Anthropic adds them) are a scoped extension, same invariants.
- **DR-026 (auditor):** the never-answer-authorization invariant is the same family as never-acts — a structural refusal to take a class of action, enforced by contract not just discipline.
- **`#642`/#643 (forensic log):** the alert + audit sink; this DR produces alerts, that one guarantees they're recorded.

## Ownership / build split

- **Design (science):** this DR + the three constitutional invariants.
- **Framework (code, `groundnuty/macf`):** the `claude-sh.ts` watcher integration (detect → match-allowlist → send → verify-outcome), the allowlist distribution via `macf init/update`, the config-loader authorization-shape warn (Invariant 2).
- **Devops (`macf-devops-toolkit`):** `#543` cron supervisor consumes the same mechanism for unattended relaunch.

## Consequences

- Operator-launches clear known ceremony prompts automatically; cron/unattended relaunch (DR-031/#543) works.
- A new Claude Code prompt is a vetted config entry, not a code change — and an *un*-added prompt fails safe (alert, not answer).
- A small attack/foot-gun surface (auto-driving the TUI) bounded by three constitutional invariants + the forensic trail.

## Open questions

1. **Authorization-shape enforcement strictness** (Invariant 2): loud-warn vs hard-refuse on `(y/n)`/`allow`/`trust`/`delete` substrings at config-load (lean: loud-warn + operator-override, hard-refuse on the most dangerous — `delete`/`overwrite`/`trust`).
2. **Signature form** (Invariant 3): full-frame text capture vs a structured `{option-N-text}` schema (lean: structured, so the `send`↔option-text binding is explicit + machine-checkable, not a fragile substring).
3. **Watcher lifetime:** startup-window-only (covers the two known prompts) vs lightweight-persistent (if mid-session prompts appear) — start startup-only.

## References

`macf#645` (the design seed + the operator's "go around the prompts" framing) · DR-031 + `macf-devops-toolkit#543` (the unattended-relaunch consumer) · `macf#641` (channels — the dev-flag ack this unblocks) · `macf#642`/#643 (the forensic-log alert sink) · DR-026 (auditor never-acts — the sibling structural-refusal contract) · silent-fallback-hazards.md (Invariant 3 = the wrong-answer-looks-fine shape; Instance 3 = RC typed-no-Enter) · `anthropics/claude-code#42486` (no headless bypass for the interactive prompts).
