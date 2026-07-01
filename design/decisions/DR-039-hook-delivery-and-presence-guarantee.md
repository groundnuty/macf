# DR-039: Where load-bearing hooks live + how MACF guarantees their presence

**Status:** Proposed
**Date:** 2026-07-01
**Trigger:** `macf-devops-agent` lost its post-compaction handoff. Root cause: devops's launcher loads `.macf/plugin-cs` (the DR-005 / `macf#533` mcpServers-only plugin — **no `hooks/` dir**), so it lacks the plugin's PreCompact `checkpoint_to_memory` hook that WRITES the session-handoff memory. code / science / auditor load the full `.macf/plugin` (`hooks.json` present) and get it; devops doesn't → nothing detailed survived its compaction. The **same** plugin-cs relic caused devops's version-tracking failure earlier the same day — one root cause, two symptoms. Operator-directed (2026-07-01); code-agent proposed the frame on `macf#731`; science authored + ratifies this DR.

## Context — the class: a silent-fallback at the hook layer

This is not a devops one-off. **Load-bearing hooks are delivered through fragile channels, and nothing asserts they are present** — a silent-fallback hazard (`silent-fallback-hazards.md`) at the hook layer, sibling to Instance 15 (the channels-enablement class, where a launcher silently omits a flag and the agent is deaf with no signal). The two fragile delivery channels:

- **Plugin `hooks.json`** — present only if the launcher loads the **full** plugin. A stripped variant (plugin-cs, mcpServers-only) silently drops every hook, and nothing surfaces the gap: the agent runs, coordinates, and just… never checkpoints / never guards. The failure is invisible until a downstream symptom (a lost handoff, a mis-attribution) surfaces far from the cause.
- **Project `settings.json`** — hooks wired here can vanish untraced: the agent can edit the file, `macf update` rewrites it, and `restart-self` **stashes** it (the same mechanism that reverted today's `claude.sh` sed). Anything load-bearing here can disappear with no signal.

The failure shape is the canonical one: success at every API boundary (the launcher starts, the plugin loads *something*, the session runs), semantic failure (a load-bearing hook is absent) invisible until it breaks elsewhere. The defense must guard at the **result-invariant** level — assert the load-bearing hook-set is actually present — not trust that the delivery channel carried it.

## Decision 1 — Primary home = plugin `hooks.json`; always load the full plugin; `macf doctor`/`update` ASSERTS the load-bearing hook-set is present

- **The plugin `hooks.json` is the primary home** for load-bearing hooks — it is the agent-runtime unit: versioned, `macf update`-refreshed, delivered atomically with the agent's identity + MCP server. A hook that lives with the plugin travels with every proper agent launch.
- **Always load the full plugin.** No stripped variant. plugin-cs (mcpServers-only) is retired (Decision 2).
- **`macf doctor` / `macf update` ASSERTS the load-bearing hook-set is present** — the structural defense (Pattern A: assert the result-invariant, don't trust the delivery channel). This catches a stripped launcher, a bad stash, or an agent-edit that dropped a hook **loudly**, at a deterministic checkpoint, instead of letting it surface as a distant symptom. Same shape as the `check-channels-enabled` startup guard (Instance 15's detect-half) and the fleet-health `doctor` asserts (DR-037).
- **NOT managed-settings** (`/etc/claude-code/…`): rejected — needs `sudo`, is not system-portable, and is machine-global (breaks project-isolation — a macf hook would fire for every project on the box).
- **User-scope `~/.claude/settings.json`** is the tier for *plugin-independent, survive-everything* hooks (outside the project git → a stash / `macf update` / agent-edit cannot drop them). Defined here, populated later (Decision 3).

## Decision 2 — Single-source the hooks into the plugin (dissolves plugin-cs + the lost-checkpoint + the doubling)

plugin-cs exists for exactly one reason: to avoid **doubling** the guards that were BOTH hand-wired in `settings.json` AND provided by the plugin. So "always load the full plugin" would **re-double** those `PreToolUse` / `PostToolUse` guards (each fires twice) — *unless* we single-source:

**The plugin owns ALL hook registration; stop hand-wiring duplicates in `settings.json`.** That one move dissolves plugin-cs, the lost-checkpoint, and the doubling together.

**Framing (load-bearing — this is an evolution, not a regression):** the hand-wired `settings.json` guards were a **pre-DR-029 workaround.** Substrate agents were rule-based — they did NOT run `macf init` / `update`, so the plugin's hooks were never delivered to them, and the guards had to be hand-wired across science / code / devops (see the substrate-structural-hooks arc). **Post-DR-029, substrate runs `macf init` → the plugin delivers the hooks properly → the hand-wiring is now redundant.** Single-sourcing into the plugin is the proper Stage-3 mechanism that the hand-wiring was a Stage-2 stand-in for.

**Scripts stay path-invoked; registration is single-sourced.** The hook **scripts** remain at `.claude/scripts/check-*.sh` (workbench-maintainable — a substrate agent can still evolve a guard's behavior, and a script change goes live on the next event with no relaunch), while the **registration** (which event, which matcher) is plugin-owned and single-source. This preserves substrate-workbench script evolution without re-doubling the registration.

**Retire plugin-cs** — its anti-doubling purpose is obsolete since `v0.2.36` dropped `manifest.hooks`; keeping it is now pure risk (the stripped-launcher silent-fallback of this DR's trigger).

## Decision 3 — The plugin↔user boundary; user-settings is DEFINED-but-EMPTY this iteration

- **MCP-tool hooks are mandatorily plugin-bound.** `checkpoint_to_memory` is a `mcp_tool` PreCompact hook — it needs the plugin's MCP server and **cannot** run from user-settings (there is no server there). All MCP-tool hooks live with the plugin, non-negotiably.
- **The bash guards are also plugin-bound** (per Decision 2's single-source).
- **The survival mechanism is the `macf doctor` ASSERT (Decision 1), NOT a user-settings copy.** The decided frame chose "doctor asserts the load-bearing set present" as the presence guarantee — that is what catches a stripped launcher / bad stash loudly. So this iteration does **not** populate user-settings; the doctor-assert is the survival tier.
- **User-settings = defined-but-reserved, with a HARD scoping contract.** A user-settings hook fires for **every** Claude session that OS-user runs — **including non-macf projects**, where a macf bash guard (e.g. `check-gh-token`) would **break the operator's unrelated work** (block `gh` in a non-macf repo). Therefore ANY future user-settings hook **MUST be macf-marker-scoped** (no-op unless a `.macf/` / project-marker is present) — non-negotiable, by contract. The tier + its scoping rule are defined now; it is populated only if/when a hook genuinely needs to survive a scenario where even the doctor-assert can't run (deferred — none does today).

**The explicit line:** MCP-tool-dependency OR needs-plugin-runtime → **plugin-bound** (cannot be user-settings). Everything load-bearing today → **plugin (single-source) + doctor-assert**. User-settings → **empty this iteration**, reserved + marker-scoped-by-contract for future plugin-independent survive-everything hooks.

## The load-bearing hook-set the doctor asserts

`macf doctor` / `update` asserts these are present (name-checked against the loaded plugin), warning loudly + offering repair if any is missing:

- **`checkpoint_to_memory`** — PreCompact `mcp_tool`; writes the session handoff memory (DR-034). Its absence is the trigger incident.
- **`check-gh-attribution`** — PostToolUse; the durable attribution guard (`macf#491`). Its absence silently re-opens the attribution trap.
- **`harvest-reflection`** — PreCompact; harvests the staged reflection (`reflection-staging.md`). Its absence silently loses session learning.
- **The PreToolUse guards** — `check-gh-token` (`#140`), `check-mention-routing` (`#244`/`#272`), `check-lgtm-gate` (`#270`), `check-close-keyword` (`#431`).

## Immediate stopgap (separate, non-blocking, operator-gated)

For devops **now**, pending the single-source migration: hand-wire `checkpoint_to_memory` as a PreCompact `mcp_tool` hook in its `settings.json` — plugin-cs provides the MCP server, so the tool is available even without the plugin's `hooks/` dir. This stops devops losing handoffs immediately. It is **superseded** by the Decision-2 migration (which delivers it via the full plugin), and it is not the fix — it is an unblock.

## Build split

- **Science:** this DR (the frame + the three decisions + the doctor-assert-as-survival contract).
- **code:** the implementation — the single-source migration (remove the hand-wired `settings.json` duplicates, always-load-the-full-plugin, retire plugin-cs) AND the `macf doctor` load-bearing-hook-set assertion + repair.

## Boundaries / non-goals

- **NOT managed-settings** (`/etc/claude-code/…`) — rejected (sudo, non-portable, machine-global; Decision 1).
- **NOT populating user-settings this iteration** — the tier is defined + contracted, not filled (Decision 3).
- **NOT relocating the hook scripts** — they stay path-invoked at `.claude/scripts/` (workbench-maintainable); only the *registration* single-sources into the plugin (Decision 2).
- **The stopgap is not the fix** — it is an operator-gated unblock, superseded by the migration.

## Consequences

- A stripped-launcher or bad-stash hook loss is caught **loudly at `macf doctor`/`update`**, not as a distant symptom (a lost handoff, a mis-attribution) — the silent-fallback becomes a loud, deterministic assertion.
- plugin-cs, the lost-checkpoint, and the guard-doubling are dissolved by one move (single-source into the plugin).
- The hand-wired substrate guards — a Stage-2 workaround — retire in favor of the proper Stage-3 plugin delivery (post-DR-029).
- A defined-but-empty user-settings tier + its marker-scoping contract are ready for a future hook that must survive even a doctor-can't-run scenario, without breaking non-macf projects.

## Open questions

1. **Doctor-assert repair action** — warn-only, or auto-repair (re-run the plugin load / `macf update`) on a missing hook? Lean: **warn + offer repair** (surface loudly, let the operator/agent trigger the fix), not silent auto-repair (which could mask a recurring root cause).
2. **`harvest-reflection` tier** — assert-as-load-bearing, or best-effort? Lean: **assert** — a lost reflection is lost session learning, same class as the lost checkpoint.
3. **The macf-marker predicate** for the future user-settings tier — a `.macf/` dir presence check, a settings marker, or an env var? Deferred to when the tier is first populated.

## Cross-references

- **DR-005** (agent-registration) — the plugin-loading model + the plugin-cs origin.
- **DR-002** (channel-per-agent) — the MCP-server-per-agent the MCP-tool hooks depend on.
- **DR-022 Amendment P** (channel-server `.mcp.json` mount) — the plugin-cs / channel-server relic lineage.
- **DR-029** (managed-vs-operator config taxonomy) — why the hand-wired guards are now redundant (substrate runs `macf init`).
- **DR-034** (compaction-drain) — `checkpoint_to_memory` / the PreCompact surface this asserts.
- **DR-037** (fleet operational layer) — the `macf doctor` fleet-command family this assertion joins.
- `silent-fallback-hazards.md` **Instance 15** (channels-enablement) — the sibling silent-fallback + the Pattern-A/B defense shape this reuses.
- `reflection-staging.md` — `harvest-reflection`.
- `macf#731` (this issue), `macf#491` (`check-gh-attribution`), `macf#140` / `#244` / `#270` / `#431` (the PreToolUse guards), `macf#533` (plugin-cs), `v0.2.36` (dropped `manifest.hooks`).
