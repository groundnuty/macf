# DR-029: Substrate config maintenance via backup → `macf init` → reintegrate → reflect

**Status:** Proposed
**Date:** 2026-06-25
**Trigger:** `macf#533` (the onboarding-UX pass) + the DR-027 phase-1 evidence: the devops substrate launcher was **hand-maintained**, drifted to an older generation, and shipped a real bug (dropped `MACF_HOST`/`MACF_ADVERTISE_HOST` → the channel server registered `127.0.0.1` instead of the FQDN; `macf-devops-toolkit#111`). Operator direction, 2026-06-25.

## Context

`macf#273` + `feedback_substrate_workspaces_dont_use_macf` established: **substrate workspaces (science/code/devops) are NOT `macf init` consumers** — they hand-maintain their `.claude/`. The rationale was real: (1) the full `macf-agent` plugin's hooks would **double** the hand-wired `settings.json` hooks; (2) rules-distribution would **overwrite** the authoritative *workbench* rules the substrate is the SOURCE of (circular).

But that forced hand-maintenance of **mechanical infrastructure** (`claude.sh` / `env.*` / the settings floor) — which has neither problem — and the hand-maintained copies **drifted** to an older generation and shipped the `#111` bug. An earlier synthesis (on `#533`) proposed a framework **`--mode substrate`** to emit a substrate-shaped subset. **The operator rejected it**: a special mode lets the substrate *avoid* the real `macf init`, hiding init bugs from the very agents that build the framework — the opposite of dogfooding.

## Decision

Substrate workspaces maintain their config by **periodically becoming real consumers and reconciling** — not by hand-maintaining divergent copies, and not via a special mode. The cycle, per agent:

1. **Backup** the agent's current `.claude/` + `claude.sh` + `env.*` + hand-wired state, out-of-tree.
2. **Run plain `macf init`** on the home — the exact path every consumer uses, no special-casing. The substrate now eats the real dogfood; any init gap is felt **here, first**.
3. **Reintegrate** from the backup only what the agent genuinely needs that init didn't deliver — its identity/App creds, genuine host-specifics (the `host-prelude` slot), and the authoritative workbench rules init's bundled copies would supersede.
4. **Reflect at each reintegration:** every *"I had to re-add X"* is a signal — **does X belong in the framework** (promote → canonical rule / launcher template / `ROLE_SETTINGS_MODEL`) **or is it a legitimate local-only** (host-prelude / identity)? **The reflection moment IS the graduate-up mechanism.**

Over cycles, reintegration shrinks toward zero as genuinely-canonical bits get promoted; plain `macf init` converges to "just works" for the substrate too.

**This supersedes the "substrate ≠ `macf init` consumer" stance** (`macf#273` / `feedback_substrate_workspaces_dont_use_macf`). The original blockers are resolved by the **backup + reintegrate**, not by avoidance:
- *circular rules-overwrite* → the backup preserves the authoritative workbench rules; reintegration restores them; reflection promotes genuine evolutions to canonical — i.e. the **workbench→canonical flow, now triggered by init friction** rather than left informal.
- *full-plugin hook duplication* → reconciled at reintegration (de-dupe; and reflect: should a hand-wired hook be *in* the plugin?).

## Why this over `--mode substrate`

- **True dogfooding.** The substrate feels real `macf init` bugs (the `#111` class) → we fix them before consumers hit them. The special mode would have *hidden* them behind a path no consumer runs.
- **The reintegration friction is a direct measure of framework-incompleteness** — and the most honest graduate-up signal there is ("what did I have to re-add?").
- **Less to build.** No `--mode substrate` — plain `macf init` already exists. The work is process + judgment, not framework code.

## Rollout (operational)

- **Per-agent, backup-first, one at a time** (canary discipline — `macf init` overwrites a *live* home, so each is a mini-cutover: backup → init → reintegrate → relaunch).
- **After** the DR-027 phase-1 channel cutover — do not disrupt in-flight migrations. devops's reconciled `claude.sh` (post-`#111`) is the **seed/reference** for what init should produce.
- Sequence **devops → code → science** (same blast-radius order as DR-027).
- The homes invariant holds: init runs on **each agent's own dir** — every agent keeps its own home (`feedback_every_agent_its_own_home_repo`).

## Relationship to DR-028

DR-028 defines the per-role expected-config **model** (the settings floor + loader + per-role values a home *should* have) + `macf doctor` validate. **DR-029 is HOW substrate homes reach/keep that model** — `init` + reintegrate, not a special scaffolder. `macf doctor`'s validate (expected-vs-actual) stays useful for *all* homes; for substrate the "fix" is **re-init + reintegrate**, not doctor-patching. The DR-028 launcher/loader addendum (`#536`) is what plain init now delivers.

## Consequences

**Positive.** Ends hand-maintenance drift (the `#111` class); true dogfooding; the graduate-up flow made concrete + operationalized; homes invariant preserved; the substrate stays the generative source (rules originate there → promote up; init pulls canonical down). 
**Negative / risk.** Reintegration is manual + judgment-heavy — but that *is* the point (the reflection). `macf init` on a live home is destructive without the backup → discipline required (backup-first, per-agent, relaunch). Mitigated by the per-agent mini-cutover sequence.

## Open questions

- **Cadence** — one-time graduation now, or periodic (re-init each major framework release, reintegration shrinking each time)? Lean: graduate now (get onto init-delivered configs), then periodic-light on major changes.
- **Reflection capture** — each "re-add X → promote?" that resolves *yes* becomes a code-agent promotion issue (canonical rule / template / model). Lean: yes, file the promotion as an issue so the graduate-up is auditable.

## References

`macf#533` (origin) · `macf-devops-toolkit#111` (the hand-maintenance bug that motivated it) · `macf#273` + `feedback_substrate_workspaces_dont_use_macf` (**superseded** by this) · DR-027 (phase-1; sequence-after) · DR-028 (the model this delivers; the `#536` launcher addendum) · `feedback_macf_design_workbench` / `feedback_canonical_distribution_excludes_substrate` (the generative flow this operationalizes) · `feedback_every_agent_its_own_home_repo` (homes invariant, preserved)
