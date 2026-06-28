# DR-032: Canonical agent naming convention — project / role / name / routing-label / handle

**Status:** Accepted (ratified by operator 2026-06-28; see macf#651)
**Date:** 2026-06-26
**Trigger:** The fleet's agent-identity fields drifted into **three different patterns** with no generator-level enforcement (surfaced during devops's Stage-3 work + an operator review, `macf#587`). The OTEL `gen_ai.agent.name` now flowing per `/health`: `code-agent` / `science-agent` (role-agent), `macf-devops-agent` (stray project-prefix), `auditor` (bare role) — three shapes for one field. Two prior overload-splits set the stage but never landed a *canonical, enforced* convention: `macf#535` (`agent_name` vs the App slug — the `check-gh-attribution` false-positive) and `macf#538` (`MACF_AGENT_NAME` OTEL-name vs `MACF_ROUTING_LABEL` registry-key/cert-CN). This DR ratifies the convention; siblings: DR-008 (agent identity), `#535`/`#538`/`#542`/`#547` (the overload lineage).

## Context

There is no single "agent name" — there are **five identity-ish fields** that have been repeatedly conflated:

- the **OTEL telemetry name** (`gen_ai.agent.name`, `service.name`),
- the **role** (`gen_ai.agent.role`, and — load-bearing — the auditor never-acts hook),
- the **routing label** (registry key `MACF_AGENT_<LABEL>`, cert CN, `/health` identity, A2A card),
- the **GitHub handle** (the App slug `macf-<…>[bot]`, git attribution, `check-gh-attribution`),
- the **project/product** (`service.namespace`).

Every overload incident this lineage records — and the two I hit *this session* (the `.macf/macf-agent.json` `agent_name` collapse that false-positived `check-gh-attribution`; the `agent-config.json` `tmux_session` mismatch that silently killed Stage-2 routing) — is the same root cause: **these are distinct fields, but the generator bakes whatever it's given with no lint, so per-agent drift is unconstrained.** `macf init`'s own `--role` list is itself mixed (`auditor, code-agent, science-agent, devops-agent, writing-agent` — bare auditor, `-agent` for the rest), so the drift starts at the source.

## Decision

**Separate `project` from `role`; derive everything else. There is no stored "full name" — it is the concatenation.** The two stored truths are `project` + `role`; the rest is derived and lint-enforced.

| field | rule | example (devops) | example (auditor) | drives | env var |
|---|---|---|---|---|---|
| **project** | the product | `macf` | `macf` | OTEL `service.namespace` | `MACF_PROJECT` |
| **role** | **bare** | `devops` | `auditor` | `gen_ai.agent.role`; **never-acts hook** | `MACF_AGENT_ROLE` |
| **name** | `<role>-agent` | `devops-agent` | `auditor-agent` | `gen_ai.agent.name`, `service.name` | `MACF_AGENT_NAME` |
| **routing-label** | `<role>-agent` (= name) | `devops-agent` | `auditor-agent`¹ | registry key, cert CN, `/health`, A2A, routing | `MACF_ROUTING_LABEL` |
| **handle** | `macf-<role>-agent[bot]` (= `<project>-<name>[bot]`) | `macf-devops-agent[bot]` | `macf-auditor-agent[bot]` | git attribution, GitHub App, `check-gh-attribution` | derived → `.github_app.bot_login` + `GIT_AUTHOR_NAME` |

**Rationale (operator's):** the GitHub-visible identities are the **handle** (`macf-<role>-agent[bot]`) and the **routing-label** (`<role>-agent`); the telemetry **name** should equal the routing-label so telemetry / labels / `@mentions` all read as one family. A bare `devops` is an orphan matching neither; a `macf-`-prefixed *name* is redundant under `service.namespace=macf`.

### Constraint 1 (safety, non-negotiable) — `role` is bare, and the auditor's is exactly `auditor`

`check-auditor-never-acts.sh` (`macf#499`/`#551`) keys on `MACF_AGENT_ROLE == "auditor"`; a near-miss (`auditor-agent`) **silently disables the auditor's write-boundary safety hook**. Bare-role-uniform satisfies this with **zero special-case** — `role` is the *only* safety-load-bearing field, and it is deliberately the one field that is NOT decorated. (This is the trap devops hit + reverted this session: `role` and `name` are different fields; only `role` is safety-critical.)

### Constraint 2 (the load-bearing integration) — the **handle** is the attribution source, NOT `name`

The convention sets `name = <role>-agent` (e.g. `science-agent`) but the real GitHub bot login is the **handle** (`macf-science-agent[bot]`) — `name ≠ handle-stem`. So **attribution MUST read the handle, never the telemetry name.** Concretely:

- The generator MUST populate **`.macf/macf-agent.json:.github_app.bot_login = macf-<role>-agent[bot]`** (the handle) — the authoritative source `check-gh-attribution.sh` already prefers (DR-028), and the field the **identity-lint keys on**.
- `agent_name` (= `MACF_AGENT_NAME` = `<role>-agent`) is the telemetry name and is **explicitly NOT** the attribution source. `check-gh-attribution` already treats a name≠slug *Bot*-author as the legitimate `#535` case (allowed, no false-positive; only a *User*-author trips it) — so the convention is safe **provided `github_app.bot_login` is populated**. If it is absent, attribution silently degrades to the non-authoritative `agent_name` guess.
- git attribution stays via `GIT_AUTHOR_NAME` (= the handle), decoupled from `MACF_AGENT_NAME` — unchanged.

*(Transitional note: substrate band-aids that set `agent_name` = the App slug — e.g. science's `agent_name=macf-science-agent`, applied 2026-06-26 to dodge the false-positive before the hook's authoritative-`bot_login` path existed — are **superseded** by this convention: on the next DR-029 re-init they revert to `agent_name=science-agent` + `github_app.bot_login=macf-science-agent[bot]`.)*

### The 6th surface — the tmux session name + `agent-config.json` alignment

The identity also surfaces as the **tmux session name**, and it drifted: this session's silent Stage-2 routing drop was `agent-config.json:tmux_session = science-agent` (routing-label) vs the live session `macf@macf-science-agent` (`<project>@<handle-stem>`) — the v1.x router's `send-keys` targeted a non-existent session. The convention governs this surface too: the session name is **`<project>@<name>`** (`macf@<role>-agent`, e.g. `macf@science-agent`) — **decided** (devops, #588: it tracks the name/routing-label identifier family + is brief), and `agent-config.json:tmux_session` MUST equal it. The lint asserts the match. **Note:** this is a *session-rename migration* from the current `<project>@<handle-stem>` form (`macf@macf-science-agent`) — a **devops-side gated operational follow-up** (same class as the auditor routing-label cutover), NOT part of this DR's ratification; the lint flags the pending mismatch at WARN until the rename lands.

**Amendment (2026-06-27, `macf#596`) — the session keys on `name` across ALL four surfaces; agent-config check is assert-IF-PRESENT.** Two refinements, source-verified + empirically confirmed (devops's `MACF_AGENT_NAME` renames showed `tmux ls` → `macf@<name>` live):

- **One field drives the session everywhere: `name` (= `MACF_AGENT_NAME`).** `claude.sh` self-wraps `${MACF_PROJECT}@${MACF_AGENT_NAME}` (`claude-sh.ts:169`), `restart-self` (#597) kills/recreates that exact session, and the lint + `agent-config.json` must derive identically — so all four surfaces (claude.sh, restart-self, routing-doctor's session-check, agent-config) are **coupled by construction** on `name`. **`routing doctor`'s session-check must key on `name`, NOT `routing_label`** (they're equal under this convention, but **diverge in the `#538` escape-hatch**, where the session follows `name` — i.e. what `claude.sh` empirically creates). This empirically validates the §588 Option-A decision: `<project>@<name>` isn't merely "cleaner," it's literally what the source wraps.
- **The `agent-config.json:tmux_session` check is assert-IF-PRESENT — a missing `agent-config.json` is a PASS, not a FAIL.** v3 channel agents have **no** `agent-config.json` (it was the Stage-2 SSH-router's target list — vestigial on v3), so its absence is *correct*, not drift. The lint asserts the session match only when the file exists; absent → PASS. (Without this, the lint would false-fail every v3 agent.)

### Enforcement

1. **Generator (`env-files.ts` `generateEnvIdentity`):** derive `name = <role>-agent`, `routing-label = <role>-agent`, `handle = macf-<name>`, `bot_login = <handle>[bot]` from `project` + `role`. Reconcile the `--role` help list to **bare roles** (`auditor, code, science, devops, writing`).
2. **Identity-lint (`macf doctor` check + a sibling `check-*.sh`):** flag any agent whose name / routing-label / handle / `bot_login` / tmux-session don't satisfy the derivation, so drift can't silently recur. Keys on `github_app.bot_login` for attribution (Constraint 2); derives the expected session from `name` (`<project>@<name>`); and the `agent-config.json:tmux_session` check is **assert-if-present** (a missing `agent-config.json` is a PASS — correct on v3 channel agents, per the §6th-surface amendment).
3. **Telemetry-boundary lint (the runtime half, `macf#587`):** a Tempo tag-values assert — every emitted `gen_ai.agent.name` matches `^<role>-agent$`, every `gen_ai.agent.role` matches `^<role>$`. This is the **detect-side** complement to (2)'s static per-repo config-lint: it catches a non-conforming emitter **regardless of which component produced it** (Pattern A at the telemetry boundary). It is load-bearing because the convention spans **every emission surface**, not just `claude.sh`'s resource attrs — a live Tempo audit found `gen_ai.agent.name` emitted by **two paths** (Claude-native resource attrs from `claude.sh` AND MACF `invoke_agent`/`SignCsr` spans), the latter historically leaking the **SCREAMING_SNAKE registry-key** form. The complementary **prevent-side** is centralizing the registry-key→kebab normalization at the registry-read boundary (make `AgentInfo` carry the kebab routing-label first-class — DR-030 Amendment 2026-06-27 §5), so no telemetry/display consumer handles the raw key. (`fromVariableSegment` round-trips losslessly *because* this convention guarantees underscore-free kebab `name`/`routing-label`.) Net lint: static config-shape (per-repo) + telemetry-boundary Tempo-assert (all paths) + centralize-at-read (prevent).

**Amendment (2026-06-27, `macf#587`) — the convention governs EVERY emission path, not just `claude.sh`.** A live Tempo audit (devops) confirmed two emission paths with two conventions: Claude-native (`claude.sh` resource attrs, kebab-but-inconsistent — the staged relaunch fixes) and MACF `invoke_agent`/`SignCsr` spans (SCREAMING_SNAKE registry-key + the `#538` dual-key drift; per-site name-fixes `#593`/`#613` are in v0.2.40, not yet deployed — the live SCREAMING_SNAKE is pre-deploy). The durable resolution is the prevent+detect pair above (centralize-at-read + telemetry-boundary lint), not per-site patches; tracked as a DR-032/DR-006 follow-up.

## Boundaries

- **`role` is the only safety field** (Constraint 1) — the never-acts hook. Everything else is observability / routing / attribution ergonomics.
- **`name ≠ routing-label` remains *allowed*** (the `#538` split) for genuine edge cases, but the convention makes them **equal** (`<role>-agent`) as the default; the escape hatch is not the norm.
- **Substrate follows the convention** — post-DR-029 the substrate agents `macf init`, so they get the conventional shape by construction (this is what fixes the very drift that motivated the DR).
- **DR-008** (agent identity) is the parent; this DR is the *naming-convention + enforcement* refinement of it.

## Auditor routing-label migration — a gated follow-up, NOT this DR's ratification

The auditor's *telemetry name* (`auditor` → `auditor-agent`) is safety-free and already stopgapped (devops, `#587`). Its *routing-label* migration (`auditor` → `auditor-agent`) is **NOT** baked by ratifying this DR, because it is a **cert-CN regen + registry-key change (`MACF_AGENT_AUDITOR` → `MACF_AGENT_AUDITOR_AGENT`) + router cutover + co-verify** — Stage-3-flip-class operational blast radius (mis-sequence → the auditor goes off-channels mid-migration). So:

- This DR ratifies `routing-label = <role>-agent` as **canonical**.
- The auditor's routing-label cutover is a **separate, devops-owned, gated step** (cert regen → re-register → repin caller → co-verify), sequenced like the other Stage-3 flips.
- **Until it lands, the identity-lint treats the auditor's routing-label as known-pending-migration — a WARN, not a hard FAIL** — so it's visible without blocking.
- `role` stays exactly `auditor` throughout (Constraint 1, untouched).

## Ownership / build split

- **Design (science):** this DR.
- **Framework (code, `groundnuty/macf`):** the generator derivation (`env-files.ts`) + the `--role`-list reconciliation + the identity-lint (`macf doctor` + `check-*.sh`), keying attribution on `github_app.bot_login`.
- **Devops (`macf-devops-toolkit`):** the auditor routing-label gated cutover (the one migration) + the `agent-config.json` `tmux_session` reconciliation.

## Consequences

- A freshly `macf init`'d agent is **conformant by construction**; a lint catches drift before it ships — retiring the per-agent identity archaeology this session was full of.
- Telemetry / labels / `@mentions` / certs read as one coherent `<role>` family.
- The two incidents this session (attribution false-positive; silent Stage-2 session-name drop) become **lint failures**, not multi-hour diagnoses.
- One field migration carries operational cost (the auditor routing-label) — gated + deferred, not bundled.

## Resolved decisions (#588 review — code + devops)

1. **tmux session name field → `<project>@<name>`** (`macf@<role>-agent`). Decided by devops (the tmux/agent-config owner), accepting the session-rename migration from the current `<project>@<handle-stem>` form as a devops-side gated step. (Science had raised the zero-migration alternative `<project>@<handle-stem>`; devops weighed it and chose family-consistency, owning the rename cost.)
2. **tmux/agent-config surface → rule here, fix devops-side.** This DR specifies *which field drives the session name* + the lint asserts `agent-config.tmux_session` matches; the actual session-rename + `agent-config.json` alignment is a **devops operational follow-up (its own issue)**, not this DR's ratification.
3. **`name ≠ routing-label` escape-hatch lint severity → INFO** (not WARN) — it's a legitimate documented split (the `#538` substrate case + the auditor's interim routing-label pin), so it shouldn't warn.

## Auditor interim state (confirmed safe, devops #588)

The auditor is in the safe name-now / routing-deferred split, **fixed at source (no settings-override**, per the operator's "fix at the canonical record" directive): telemetry **name → `auditor-agent`** (baked in `macf-agent.json` + `env.identity`, effective next relaunch); **routing-label stays `auditor`** (pinned literal + cert `CN=auditor` + registry `MACF_AGENT_AUDITOR` untouched/live); **role stays exactly `auditor`** (Constraint 1, never touched). The `auditor`→`auditor-agent` routing-label cutover remains the devops-owned gated follow-up; lint-WARN-not-FAIL in the interim.

## References

DR-008 (agent identity — parent) · DR-028 (`macf doctor` + the `github_app.bot_login` authoritative source) · DR-029 (substrate `macf init` — why substrate now conforms) · `#535` (agent_name vs App slug) · `#538` (`MACF_AGENT_NAME` vs `MACF_ROUTING_LABEL`) · `#542`/`#547` (the split's cert/health/A2A wiring) · `#499`/`#551` (`check-auditor-never-acts` — Constraint 1) · `check-gh-attribution.sh` (Constraint 2) · `#587` (this design ask) · the 2026-06-26 silent-Stage-2 session-name-drop + attribution-false-positive incidents.
