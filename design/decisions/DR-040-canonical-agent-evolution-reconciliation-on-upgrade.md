# DR-040: Canonical-vs-agent-evolution reconciliation on fleet upgrade

**Status:** Proposed
**Date:** 2026-07-02
**Trigger:** Rolling the fleet onto v0.2.48 (operator-driven, 2026-07-02) surfaced the general problem: `macf fleet upgrade` must run `macf update`, which overwrites the agent's macf-managed config (`CLAUDE.md`, `claude.sh`, `.claude/settings.json`, `.claude/rules/*.md`) — but agents **mutate those files as they operate**, and that mutation is not noise: it is the framework's intended self-evolution. Overwriting it silently destroys agent contributions; refusing to upgrade when it is present strands the agent on a stale version. The config-dirty guard (DR-037 Amendment B, `macf#722`) correctly *objects* rather than clobbering, but leaves the operator to manually stash/commit/resolve per agent, per file — the operator was hand-relaying the guard's messages during the v0.2.48 roll. This DR defines the boundary between plugin-delivered (canonical, tamper-resistant) content and the irreducible agent-editable set, and a **safe, agent-driven, operator-hands-off reconciliation protocol** for the latter. Operator-directed (2026-07-02 brainstorm); code-agent researched feasibility + drafts this proposal; science authors/ratifies; devops reviews the supervision/cron-facing primitives.

## Context — two forces in tension

1. **Everything operational must be git-tracked.** Agents run as (or will run as) ephemeral pods with **git-based persistence**: anything not tracked-and-committed is lost on restart. So the full operational state + accumulated knowledge (rules, settings, memories) must live in git. Untracked ⇒ gone.
2. **Agent self-mutation IS the framework's engine.** The mutation of rules and the creation of memories — an agent codifying a lesson, tightening a rule, recording a hazard — is the inherent evolution MACF exists to produce (cf. the auditor, DR-026; codify-at-correction-time). Freezing it would defeat the point.

These collide at upgrade: canonical distribution (macf update overwrites managed files) vs preserved agent evolution (those same files carry the agent's contributions). The resolution has two halves: **(A) shrink the collision surface** by delivering what we can via the tamper-resistant plugin instead of agent-editable `.claude/`; and **(B) reconcile the irreducible remainder** with an agent-driven protocol that treats the agent as the owner + first-line auditor of its own evolution.

## Decision 1 — The plugin-delivery boundary (what can leave `.claude/`, verified against Claude Code)

Researched against the current Claude Code plugin model (official docs + the CC source `utils/plugins/pluginLoader.ts`). A plugin's contribution surface is: commands, agents/subagents, hooks, MCP servers, LSP servers, monitors, skills, output-styles, `bin/`, and a *limited* `settings.json` (**only** `agent` + `subagentStatusLine` keys). There is **no** `rules`/`memory`/`CLAUDE.md`/context field.

| Canonical content | Plugin-deliverable? | Basis |
|---|---|---|
| **Hook scripts** (`check-*.sh`, `harvest-reflection.sh`) | ✅ YES | `${CLAUDE_PLUGIN_ROOT}` (documented; already used by our `mark-turn-state.sh`) |
| Hook *registration* (`hooks.json`) | ✅ already | DR-039 |
| **Rules** (`.claude/rules/*.md`) | ❌ NO | *"a `CLAUDE.md` at the plugin root is not loaded as project context; plugins contribute context through skills, agents, and hooks."* No rules/memory field in the plugin loader. |
| **Permissions** (`settings.json` allow/deny) | ❌ NO | Plugin `settings.json` supports only `agent` + `subagentStatusLine` |
| `CLAUDE.md`, `claude.sh` | ❌ NO (inherent) | project doc + launcher — per-workspace by nature |

**So the plugin can absorb the hook *scripts* (tamper-resistance win — an agent cannot defeat an enforcement hook by editing `.claude/scripts/`, because the plugin hook runs the plugin-mounted copy), but rules + permissions + CLAUDE.md + claude.sh MUST remain project-scoped in git.** The "deliver everything via plugin" ideal is not reachable in current Claude Code; this DR does not pretend otherwise.

**Q1 (immediate, independent slice):** move the 7 hook scripts into `packages/macf/plugin/scripts/` and switch `hooks.json` to `${CLAUDE_PLUGIN_ROOT}/scripts/…` (DR-039 phase 2). Additive; `.claude/scripts/` compat copies retained until the substrate's hand-wired hooks retire under DR-039.

## Decision 2 — The irreducible agent-editable canonical set (exact files, never patterns)

The files that (a) cannot move to the plugin and (b) the agent can mutate:

- `CLAUDE.md`
- `claude.sh`
- `.claude/settings.json`
- `.claude/rules/*.md` (the canonical rule files — enumerated exactly at reconcile time, not wildcarded)

**Exact filenames, never matching patterns.** This is the same lesson as the config-dirty guard's `.claude/**` over-match (Decision 6): a wildcard sweeps in runtime files (logs, `audit.log`, agent scratch) that `macf update` never touches, producing false CONFIG-DIRTY objections. The reconcile protocol operates on an **exact, enumerated allow-list** of macf-distributed files, computed from the CLI's own distribution manifest — nothing else.

## Decision 3 — The reconcile-upgrade protocol (agent-driven, operator-hands-off)

When `macf fleet upgrade` reaches an agent whose Decision-2 files are dirty:

1. **Tier first (cheap, avoids the expensive path).** For each dirty file, compare its content to what `macf update` *would* write (canonical for this workspace). **Already-canonical** (the common case — a stale branch behind the release, e.g. code-agent on v0.2.48's roll) ⇒ auto-resolve (commit/no-op), no agent involvement. Only a **genuine local delta** proceeds to the agent reconcile.
2. **Stash exactly those files, uniquely named:** `git stash push -m "macf-reconcile-<agent>-<target-version>" -- <exact file list>`. Selective stash is a real git primitive; the unique message is the later success key (matched by message, stable across the `stash@{N}` stack shifting). *(restart-self already stashes config during relaunch — DR-039 Trigger — so a stash-in-the-loop is not a new hazard here.)*
3. **`macf update`** — regenerates the now-clean managed files to canonical.
4. **Restart into a FRESH session** (Decision 5) with a **reconcile prompt injected in place of the normal startup issue-queue** — the prompt: *"You were upgraded to <version>. Your local edits to <files> were stashed as `<stash-name>`. Re-apply the ones that are genuine evolution on top of the new canonical, discard the rest. If you are UNSURE whether a change should survive, HALT and leave the stash for the operator — do not guess. When done and the tree is clean, drop the stash (`git stash drop <ref-matching <stash-name>>`)."* The reconcile is **self-contained** (stash + new files + git); it does not need the agent's prior conversation — which is exactly why a fresh session is correct (Decision 5).
5. **Success is a result-invariant, not turn-completion.** The roll asserts, layered: (a) the uniquely-named stash is **gone** (the agent's explicit done-signal), (b) `git status --porcelain` for the Decision-2 files is clean, (c) optional reconcile-done receipt. Turn-ended alone is insufficient.
6. **Transactional halt on failure.** If the stash is not dropped within a bound, or the tree is not clean, or the agent HALTed → **stop the roll** (do not advance to the next agent), **preserve the stash** (nothing lost — recoverable), alert the operator. Same "full transaction or none" as `macf#725/#726`.

Nothing is ever destroyed: the stash preserves the agent's edits through the whole flow; a failed reconcile is rolled back by restoring the stash.

## Decision 4 — Prerequisite primitive: the maintenance lock (upgrade ≠ outage)

Once a supervision cron (DR-031) keeps agents alive, it will race the upgrade: a mid-upgrade agent is *intentionally* down, but the watchdog reads "down" as an outage and relaunches it — colliding with the roll (double-launch, wrong session). Fix: an explicit **maintenance-state lock**.

- The upgrade sets a lock (`agent`, `started-at`, `target-version`) **before stopping the agent**, releases it at the end. The watchdog checks it: **locked ⇒ intentional maintenance, skip relaunch; unlocked + down ⇒ real outage, relaunch.** This is the upgrade/outage distinction made explicit rather than inferred.
- **TTL** is the safety valve: a lock older than a bound is ignored by the watchdog (a *crashed* upgrade cannot lock an agent out of keep-alive forever).
- **Backstop:** even if the watchdog races the window, `#733`'s identity-aware collision detection catches a double-launch at the channel-server layer.

This one lock delivers **three** effects the reconcile needs: (a) watchdog suppression (upgrade ≠ outage), (b) **routing freeze** — no peer messages injected mid-reconcile (queue, do **not** drop, and release after), and (c) the upgrade flow **owns every restart in the window**, which is what makes resume-by-id (Decision 5) safe. It is a DR-031 supervision primitive useful independent of this DR — any planned restart must not look like an outage — so it should be built first, standalone.

## Decision 5 — Prerequisite primitive: resume by session-id, not `-c`

The reconcile runs in a fresh session (self-contained; avoids taxing/overflowing a near-full operational session). But `claude.sh`'s `-c` (resume-latest) would then resume the **reconcile** session, not the agent's real operational session. Fix:

- **Capture the original operational session-id up front** — restart-self already does this (it logs `pre uuid=<id>` and asserts the transcript survived). Restart *after* reconcile with `--resume <original-id>` (explicit), not `-c`. The reconcile session is never resumed; it lingers only as an older transcript (optional cleanup).
- **Deeper:** `-c` is inherently fragile — *any* interleaved session (reconcile, a debug launch, a raced watchdog) breaks "latest = mine." The robust long-term direction is agents resuming by a **persisted operational-session-id**, not `-c`. The reconcile flow forces the issue; framework-wide adoption is recommended.

The maintenance lock (Decision 4) protects the window in which the reconcile session is "latest," so nothing else fires `-c` while it is.

## Decision 6 — Config-dirty guard precision (narrow the pattern; stop false-positives)

`ROLL_TOUCHED_CONFIG_PATTERNS` is `['.claude/**', 'CLAUDE.md', 'claude.sh', 'env.local.*']`. `.claude/**` over-matches: it flags runtime files `macf update` never writes (e.g. devops's `.claude/audit.log`, appended by a custom `ConfigChange` hook, hence perpetually git-dirty) as "macf update would overwrite" — a false CONFIG-DIRTY objection. Narrow it to the **exact distributed paths** (`.claude/rules/**`, `.claude/scripts/**` until Q1 drops it, `.claude/settings.json`, the managed `.claude/.macf/env.*`) — the same exact-file discipline as Decision 2 — and gitignore runtime artifacts like `audit.log`. This is the precise reconcile input; a wildcard both over-objects and mis-lists.

## Decision 7 — Governance: the agent as first-line auditor of its own evolution

The reconcile (Decision 3 step 4) is the agent deciding what of its local evolution to carry onto canonical — the agent acting as **its own auditor for its own workspace**. The mods it keeps are the **graduation signal**: they compose upward with the fleet auditor (DR-026), which promotes agent-kept evolution to framework-canonical. For consumer fleets with **no** local auditor (the auditor exists only in the substrate fleet today), the reconcile should emit a **graduation-candidate report** — what the agent kept + its rationale — surfaced to the framework maintainers. So agent-driven evolution flows up **without** every fleet needing its own auditor. This is the concrete answer to "should consumer agents drive framework evolution, and how": yes — locally via reconcile, fleet-wide via the auditor or the graduation report.

## Rollout / sequencing

1. **Q1 (now, independent):** hook scripts → plugin (`${CLAUDE_PLUGIN_ROOT}`), DR-039 phase 2. Tamper-resistance; shrinks the collision surface.
2. **Decision 6 (small):** narrow the config-dirty pattern + gitignore runtime artifacts. Removes the false-positive objections (unblocks e.g. devops's `audit.log`).
3. **Decisions 4 + 5 (prerequisite primitives):** maintenance-lock (devops-owned, cron-facing) + resume-by-session-id. Buildable + useful standalone; the reconcile cannot be safe without them.
4. **Decision 3 (the protocol):** stash + fresh-session reconcile + layered success + transactional halt + tiering — on top of 4+5.
5. **Decision 7:** graduation-candidate report for auditor-less fleets.

## Open questions for review

- **(devops)** Maintenance-lock home + shape — a workspace marker vs a registry flag; how the watchdog cron reads it; the TTL bound; interaction with `macf fleet reconcile`/`install-cron`.
- **(science)** Is the fresh-session reconcile the right context model, or should a *summarized* slice of the original session be handed in? The DR argues fresh-is-correct (self-contained task); confirm.
- **(science)** Graduation-candidate report format + destination for auditor-less consumer fleets.
- The `-c` → persisted-operational-session-id move (Decision 5): framework-wide now, or scoped to the reconcile flow first?

## Reviewers

- **science** — authors/owns this DR; Proposed→Accepted is the operator's ratification call (not code-agent's, not a reviewer's).
- **devops** — reviews Decisions 4 (maintenance-lock / cron) + 6 (guard) as the supervision/cron owner.

## When to read vs modify

- **Read:** when touching fleet-upgrade, restart-self, the supervision cron (DR-031), the plugin-delivery boundary, or the config-dirty guard.
- **Modify:** never in workspace copies. Edit the canonical DR + re-distribute. Disagree? Open an issue with the incident that showed it wrong.
