# Reflection Staging (canonical, shared)

**Maintain a staged reflection as you work. At compaction it is harvested automatically.** This file is the single source of truth for the reflection-staging discipline; it is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update` / `macf rules refresh`. Do not edit workspace copies directly — edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/reflection-staging.md` and re-distribute.

Applies to every MACF agent. The mechanism is local + cheap and never blocks compaction (DR-026 F2, groundnuty/macf#500).

---

## What this is

You accumulate observations as you work — recurring patterns, canonical-rule breaches you committed or witnessed, signals that a rule should evolve, loose ends. Historically these lived in "remember to synthesize before compaction" / "codify at decision time" disciplines, which depended on you remembering to act at exactly the moment your context was about to be summarized away.

This rule gives those disciplines a **structural home**: a single file you keep current as you go. They stop being "remember to do X at compaction" and become "keep `pending.json` current." At compaction, the `harvest-reflection.sh` PreCompact hook reads the staged file, wraps it in the versioned reflection envelope, appends it to a local per-session JSONL ledger, and clears the stage for the next session. You never run the harvest by hand — the hook fires on both auto-compaction and manual `/compact`.

---

## The staged file

Maintain `.claude/.macf/reflections/pending.json` incrementally. It holds only the **protocol-signal fields** — the hook adds the envelope (`schema_version`, `kind`, agent identity, project, session id, timestamp, trigger, compaction type) at harvest time.

```jsonc
{
  // Recurring behaviour / coordination dynamic / workflow shape worth surfacing.
  "observed_patterns": [
    { "pattern": "<short name>", "evidence": "<what you saw / a ref>", "tier_hint": "<where it might belong>" }
  ],
  // Canonical-rule breaches you committed or witnessed this session.
  "breaches": [
    { "rule": "<rule name>", "what": "<the breach>", "ref": "<issue/PR/commit/file:line>" }
  ],
  // Signals that a coordination rule should evolve (proposals for governance).
  "rule_evolution_signals": [
    { "signal": "<what changed/recurred>", "proposed_tier": "<suggested tier>", "rationale": "<why>" }
  ],
  // Loose ends to pick up next session.
  "unresolved": [ "<string>", "<string>" ],
  // One-paragraph free-form synthesis of the session.
  "synthesis": "<prose>"
}
```

Every field is optional. An empty `{}` (the cleared state) is valid — the hook still emits a **mechanical-only** record at compaction so the Monitor sees that a compaction happened. Arrays default to `[]`, `synthesis` to `""`.

`observed_patterns[]` and `rule_evolution_signals[]` may carry an optional `key` field — reserved for deterministic cross-agent dedup later (additive; leave it out for now unless you have a stable key).

## How to keep it current

- **Append, don't wait.** When you notice a pattern, breach, or evolution signal mid-session, add it to the relevant array right then. Don't batch it for "later" — later is compaction, and the point is that the staging already happened.
- **Edit the file directly** (`Read` then `Edit`/`Write`). It is plain JSON in your workspace; no command or tool call is needed.
- **Keep `synthesis` a living summary.** Overwrite it as your understanding of the session firms up.
- **Don't clear it yourself.** The harvest hook clears the stage after appending. If you clear it, the next compaction emits a mechanical-only record and your observations are lost.

## Where it lands

- Ledger: `.claude/.macf/reflections/<session_id>.jsonl` (one JSON object per line, schema-validated by `@groundnuty/macf-core` `ReflectionRecordSchema`).
- The ledger is **local + observational** — DR-023 §UC-3 posture. The harvest never blocks compaction; an internal error fails open (`exit 0`).
- Opt out of harvesting for a session with `MACF_SKIP_REFLECTION_HARVEST=1`.

---

## When to read vs. modify

- **Read:** every session start. This rule defines how to stage your reflection.
- **Modify:** never directly in workspace copies. Edit the canonical file and re-distribute via `macf update`.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale. Peer review applies.
