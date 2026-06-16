# Project-tier rules — location, format, distribution, precedence

> Status: infrastructure for DR-026 F3 (macf#501). This doc specifies the
> on-disk tiers + how project rules ship. It does NOT specify the §4
> invariant-checker that *enforces* "never contradict" — that is a separate,
> gated slice of DR-026.

## The three-tier rule model (DR-026 §3)

Coordination knowledge lives in three tiers with three change-difficulties:

| Tier | What | Where it lives | Distributed by |
|---|---|---|---|
| **1. Universal / product** | reporter-owns-closure, token hygiene, the routing protocol | shipped IN the CLI at `plugin/rules/*.md` → workspace `.claude/rules/*.md` | `macf init` / `macf update` / `macf rules refresh` (`copyCanonicalRules`) |
| **2. Project** | per-deployment specializations (e.g. a deployment's CI gate, a cluster-investigation pattern) | `<source>` → workspace `.claude/rules/project/*.md` | `macf update` / `macf rules refresh` (`fetchProjectRules`); seeded by `macf init` |
| **3. Agent-private** | one agent's own habits / memory | the agent's own `.claude/` + memory | the agent itself |

The **project tier is the new abstraction** this issue makes first-class. It
already existed informally as `CLAUDE.md` prose (the science-agent token
file-cache pattern, the macf-repo `make -f dev.mk check` Stop-hook, devops's
cluster patterns). F3 gives it a real on-disk home + a distribution path.

## Location (on-disk tier-distinguishability)

- Universal rules: `.claude/rules/*.md` (flat — unchanged).
- Project rules: `.claude/rules/project/*.md` (a **subdir**).

The subdir is deliberate: the two tiers are distinguishable on disk by path
alone, giving the DR-026 §4 subordination check a clean target (it can validate
every `.claude/rules/project/*.md` against the protected-invariant set without
guessing which flat rule is universal vs project).

Project rules **never overwrite or shadow** universal rules — they live in a
different directory, and the universal-rule copy path (`copyCanonicalRules` →
`.claude/rules/`) is untouched by the project-rule path.

## Source config — `MACF_PROJECT_RULES_SOURCE`

Project rules are **project-owned**, not shipped in the npm product — so the CLI
cannot bundle them, and there is no implicit "coordination repo" to pull from
(a multi-repo deployment has no single repo). The source is therefore an
**explicit operator config**: `MACF_PROJECT_RULES_SOURCE`, set in the
operator-managed env file `.claude/.macf/env.project-rules`.

Two accepted forms:

1. **GitHub repo + subdir** — `<owner>/<repo>//<path>`, e.g.
   `groundnuty/macf//project-rules`. The `//` separates the `owner/repo` from
   the in-repo path. Fetched via a shallow `git clone --depth 1` of the default
   branch (mirrors `plugin-fetcher.ts`'s clone-copy-discard mechanism + its
   `gh`/App auth posture for private repos), then `*.md` from `<clone>/<path>/`
   is copied into the dest subdir.
2. **Local directory path** — anything WITHOUT `//` that resolves to a
   directory. Copied directly (no clone). For single-host deployments pointing
   at a checked-out repo or a plain rules directory.

**Unset / empty → no-op.** The tier is optional, exactly like a workspace with
no universal rules. Distribution returns "0 files copied" and never errors. A
malformed source string warns and skips (it does not crash `macf update`).

## Distribution mechanics

- `macf init` — creates `.claude/rules/project/` and seeds a **generic,
  format-demonstrating** `EXAMPLE.project-rule.md.example`. The seed is
  deployment-agnostic (init ships to every deployment — a genomics deployment
  must not receive a macf `dev.mk` rule). The `.example` suffix keeps it out of
  the live-rule set (only `*.md` are loaded + managed). Init does NOT fetch from
  the source — it stays offline-safe + generic.
- `macf update` — fetches from `MACF_PROJECT_RULES_SOURCE` into
  `.claude/rules/project/`. No-op when unset. Only `*.md` are managed, so the
  `.example` seed survives.
- `macf rules refresh` — same fetch, for non-init'd workspaces (the macf repo
  itself, CV, etc.).

## Precedence — documented here, enforced by §4 (not F3)

Project rules may **add to / specialize** the universal protocol. They may
**never contradict or weaken** its protected invariants — for example:

- reporter-owns-closure accountability
- the identity ↔ attribution guarantee (bot-token hygiene)
- the no-self-merge / LGTM gate

If a project rule looks like it relaxes a universal invariant, it is wrong by
construction. F3 (this issue) only lays down the on-disk tiers + the
distribution path; the **§4 invariant-checker** that validates each proposal
against the protected set before the operator ratifies is a separate, gated
DR-026 slice. The tiers are the precondition for that check, not the check
itself.

## Note — the MACF substrate is hand-wired

The MACF substrate agents (science / code / devops) are rule-based and do NOT
run `macf init` / `macf update`, so macf's own `project-rules/` reach the
substrate the hand-wired way (like the structural hooks). This issue is the
**consumer-deployment** auto-distribution + the format/location; do not assume
the substrate auto-pulls.
