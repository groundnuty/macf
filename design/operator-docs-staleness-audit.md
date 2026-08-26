# Operator-facing docs staleness audit (2026-08)

**Purpose:** a set-membership audit of this repo's operator-facing
documentation against **current source** — never against another document —
following from `groundnuty/macf#1185`'s finding that a runbook gap (no
document told an operator a runner block was required for routing) cost a
live fleet an hour of investigation to recover.

**Method:** for each candidate, the verdict below is one of:

- **current** — describes today's behavior; verified against source directly.
- **superseded** — a newer mechanism now does what this doc describes by
  hand, and the doc doesn't say so.
- **design record, not a guide** — accurately scoped as a historical
  design/implementation artifact; not written or read as an operator
  how-to, so its age is not itself a defect.
- **incomplete** — accurate as far as it goes, but silent about something
  material an operator would need (the same shape as the defect that
  motivated this audit).

Every claim below was checked against the file it names or the source it
cites — grep/read commands were run against this repo's `main` (`2b3a55b`,
2026-08-25) while writing this audit; none of the verdicts below propagate
from a prior doc's framing.

---

## 1. `CLAUDE.md`

**Verdict: superseded (severe) — flagged, not fixed.**

The "Implementation Status" section's top-most entry reads **"Current state
(updated 2026-07-04)"** on `main` HEAD as of this audit (2026-08-25) —
confirmed directly: `grep -n "Current state" CLAUDE.md` returns exactly one
line, dated 2026-07-04. That is **seven weeks and dozens of merged PRs**
behind. More materially: `grep -n "DR-043\|bootstrap plan\|bootstrap apply\|fleet.yaml" CLAUDE.md`
returns **zero matches**. DR-043 — a 933-line design record with fifteen
amendments (A through O), a new CLI surface (`macf bootstrap
plan/apply/status/manifest scaffold`, `macf fleet
deploy/upgrade/deactivate/archive/delete-apps/destroy`), and the single
largest body of work on this repo in the last month — is **entirely absent**
from the canonical project guide's "Implementation Status" and "CLI
Surface" sections.

This is the closest thing in this audit to a **root cause** for the
incident `#1185` itself describes: the document every session (agent or
operator) is handed at the start of work never mentions that a
runner-declaration requirement exists, because it never mentions the
feature area exists at all.

**Why flagged, not fixed:** rewriting the Implementation Status narrative to
current state is a substantial undertaking (reconciling a changelog-style
section spanning many releases), and — concretely, checked at audit time —
this exact file is under **active, concurrent edit by a large number of
other sessions in this shared checkout** (this session's own coordinator
listed dozens of sibling agents working other `#11xx`/`#9xx` issues in
`groundnuty/macf` this same session). A speculative edit to CLAUDE.md's
hottest, most-contended section risks a conflict with work already in
flight elsewhere, for a fix (a full changelog rewrite) well beyond this
issue's scope. Recommend a **dedicated follow-up issue**, filed
independently so it can be picked up without competing with this one's
diff.

---

## 2. `README.md`

**Verdict: incomplete.**

`grep -n "bootstrap\|fleet.yaml\|DR-043" README.md` shows the only
"bootstrap" mentions are the pre-existing per-agent onboarding pointers
(`docs/quickstart.md`, `design/macf-consumer-onboarding.md`) — the README's
documentation index has no entry at all for fleet-level provisioning
(`macf bootstrap`, DR-043, or this runbook). An operator arriving at this
repo cold, standing up a **fleet** (not one consumer agent), would not
discover the declarative path exists from the README.

**Fixed this session:** added one line to README.md's documentation index
pointing at `design/fleet-deployment-runbook.md` and DR-043 — low-risk
(this file was not among the concurrently-edited files this session),
purely additive, and directly serves the discoverability goal this issue
exists for.

---

## 3. `design/macf-consumer-onboarding.md`

**Verdict: current, for what it covers — incomplete about the alternative.**

Verified against its own content (`grep -c bootstrap` → 23 hits): every use
of "bootstrap" in this document is the **generic verb** (standing up one
consumer agent's workspace via `macf init`), never `macf bootstrap`'s CLI
subcommand — this document predates DR-043 and was never in conflict with
it, because it answers a genuinely different question ("how do I bring up
one agent by hand") from the one DR-043 answers ("how do I declare a whole
fleet and let a CLI reconcile it"). Its content — App creation, `macf
init`, cert/registry wiring, `macf doctor` verification, rollback — remains
accurate for the manual per-agent path, which is still the only path for a
fleet that predates `fleet.yaml` or deliberately opts out of the declarative
model.

**The gap:** nothing in this document tells an operator that `macf
bootstrap apply` now automates most of what §2–§4 of this doc walks through
by hand, for an operator who's about to stand up a **new** fleet rather
than one more agent. An operator following this document today would spend
the full manual App-creation dance DR-043 exists to eliminate, simply
because this document doesn't mention the alternative.

**Not fixed this session** — out of scope: this document is long (369
lines) and well-structured for its actual audience (adding one agent, or a
fleet that predates the declarative model); a good fix is a short
pointer near the top ("standing up a new multi-agent fleet? see
`design/fleet-deployment-runbook.md` instead"), not a rewrite, but even that
narrow edit wasn't made here to keep this session's diff scoped to the new
runbook + audit. Flagged for a follow-up.

---

## 4. `design/phases/*` (12 files: `P1`–`P7`, `P-A2A-phase-{2,2d,3,4,5}`)

**Verdict: design record, not a guide.**

Read the header of all twelve files directly. Every one is formatted as a
**Goal / Depends-on / Design-decisions-referenced / Deliverables** spec —
the pre-implementation planning-doc shape, not a "here's how to operate
this" runbook shape. `P1`–`P7` document the original phased build of the
channel-server/registration/certs/CLI/plugin/routing/agent-template surface
(per `CLAUDE.md`: *"P1–P7 all implemented"*); the `P-A2A-phase-*` docs
document the A2A protocol integration arc, each carrying its own
`Status:`/`Issue:` header pinned to the PR that shipped it.

**Spot-checked for drift regardless:** `P4-cli.md`'s "Deliverables" list
(`macf` bare-listing agents from `~/.macf/agents.json`, `macf status`
pinging all agents) is now a small fraction of the actual CLI surface —
`packages/macf/src/cli/index.ts` registers an order of magnitude more
commands today (`fleet *`, `bootstrap *`, `routing doctor`, `registry
prune`, `restart-self`, …). This is **not** miscategorized as "superseded,"
because nothing about `P4-cli.md`'s framing claims to be a current
reference — it is explicitly a phase-1 deliverables list, and the CLI
growing far past its initial scope is exactly what a successful phase spec
predicts, not a defect in the spec.

**Not fixed, not flagged as needing a fix** — these are correctly historical
records. No operator reads a "P4: CLI" doc expecting the current `--help`
output; the runbook (§5) is explicit that `--help` is the living reference.

---

## 5. `use-cases/README.md`

**Verdict: current.** A one-screen index pointing at
`design/macf-consumer-onboarding.md` and the one existing recipe. No claims
to verify beyond the pointer, which resolves correctly.

---

## 6. `use-cases/scientific-paper-fleet.md`

**Verdict: incomplete — the sharpest finding in this audit, and directly
on-point for `#1185`.**

Unlike the other candidates, this document **does** have a DR-043 section
(added after the CLI existed — `grep -n "macf bootstrap"` shows a `§2-
bootstrap` section with a field-mapping table cross-referencing
`fleet-manifest.ts` directly, and the document explicitly states the schema
in code is authoritative over DR-043's own §D1 example). It is also
unusually honest about its own currency risk — item 7 of its own feedback
checklist reads: *"this section was rewritten from the DR-043 CLI's source,
not re-walked live end-to-end for this fleet."*

**Verified against source:** the field-mapping table (the table this
runbook's §2/§6 also builds from `fleet-manifest.ts`) has **no row for
`routing.runner`** — the exact field whose absence, undeclared, is the
"silent cost" incident `#1185` documents. The table predates DR-043
Amendment H (2026-08-13, the amendment that introduced the runner-
declaration requirement and `MACF_TRUSTED_ACTORS`) — so its omission isn't
an oversight relative to when it was written, it is simply older than the
requirement it's missing.

**Fixed this session:** added a `routing.runner` row to the field-mapping
table, matching this runbook's §2/§6.5, with a pointer to the runbook for
the full non-happy-path detail. Low-risk, single-file, directly closes the
gap this whole issue is about.

---

## 7. `tools/macf-bootstrap/`

**Verdict: current.** `tools/macf-bootstrap/README.md`'s own header already
states the DR-043 repositioning accurately and in detail: *"The actual
provisioning mechanism … now lives in the deterministic `macf bootstrap
plan|apply` CLI … This workspace's skill is now an optional conversational
front-end to that CLI."* It correctly names which of its own legacy
browser-rail scripts are no longer invoked but kept on disk
(`groundnuty/macf#877`), and points at
`.claude/skills/macf-bootstrap/SKILL.md` for the current procedure. No
claim in this document was found to contradict current source.

---

## 8. Adjacent documents found during this audit (not on the issue's original candidate list)

The issue named README, `macf-consumer-onboarding.md`, `phases/*`,
`use-cases/*`, and `tools/macf-bootstrap/`. Two more `design/*.md` files are
close enough in scope (operator-facing, fleet-adjacent) that skipping them
would leave an obvious gap in an audit specifically about this class of
staleness:

- **`design/operations-runbook.md`** — verdict: **current, different layer**.
  This is a per-agent, post-deployment operational-failure-mode runbook
  (cert lifecycle, port collisions, mTLS handshake failures) for an
  **already-running** Stage-3 agent. It has no DR-043 overlap to audit for
  drift against — provisioning and post-deployment operations are
  genuinely separate concerns, and this document doesn't claim to cover
  the former.
- **`design/add-agent-to-fleet.md`** — verdict: **current, narrower scope
  than its title suggests**. This document is explicitly scoped to adding
  an Nth agent to the **substrate** fleet (`macf`, `macf-actions`,
  `macf-devops-toolkit`, `macf-science-agent`) — a hand-run, non-`fleet.yaml`-
  governed set of repos that is *permanently* outside the DR-043 model (the
  substrate does not run `macf bootstrap`). It already carries an inline,
  accurate note that `macf bootstrap apply` automates the equivalent
  once-per-agent steps for a `fleet.yaml`-governed fleet. DR-043's own
  day-2 use-case catalog separately lists "add agent to a live fleet" as
  **design-covered but not fully built** for the declarative model — that is
  a gap in the *tool*, not in this document, and is out of scope for a docs
  audit.

---

## Summary table

| Doc | Verdict | Fixed this session? |
|---|---|---|
| `CLAUDE.md` | superseded (severe) | No — flagged; high-contention file, follow-up issue recommended |
| `README.md` | incomplete | **Yes** — added a pointer to the new runbook + DR-043 |
| `design/macf-consumer-onboarding.md` | current / incomplete about the alternative | No — flagged for a follow-up pointer |
| `design/phases/*` (12 files) | design record, not a guide | No fix needed |
| `use-cases/README.md` | current | No fix needed |
| `use-cases/scientific-paper-fleet.md` | incomplete (sharpest finding) | **Yes** — added the missing `routing.runner` field-mapping row |
| `tools/macf-bootstrap/` | current | No fix needed |
| `design/operations-runbook.md` (adjacent) | current, different layer | No fix needed |
| `design/add-agent-to-fleet.md` (adjacent) | current, narrower scope | No fix needed |

**Per-issue instruction, honored throughout:** no design record was deleted
or rewritten to become a runbook. DR-043 stays exactly as it is — the *why*
— and every fix above is a pointer or a missing row, never a rewrite of a
design record's own narrative.
