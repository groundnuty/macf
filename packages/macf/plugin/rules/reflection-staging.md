# Reflection staging

Keep a staged reflection current as you work; the PreCompact hook `harvest-reflection.sh` harvests it at compaction, so nothing depends on you remembering at that moment. Edit `.claude/.macf/reflections/pending.json` directly as you notice things, instead of saving them for later.

```jsonc
{
  "observed_patterns": [ { "pattern": "<name>", "evidence": "<what you saw>", "tier_hint": "<where it belongs>" } ],
  "breaches": [ { "rule": "<rule name>", "what": "<the breach>", "ref": "<issue/PR/file:line>" } ],
  "rule_evolution_signals": [ { "signal": "<what recurred>", "proposed_tier": "<tier>", "rationale": "<why>" } ],
  "unresolved": [ "<loose end>" ],
  "synthesis": "<one-paragraph summary, overwritten as it firms up>"
}
```

Every field is optional, and `{}` is valid. The hook adds the envelope, appends the record to `.claude/.macf/reflections/<session_id>.jsonl`, then clears the stage, so do not clear it yourself or your entries are lost. Set `MACF_SKIP_REFLECTION_HARVEST=1` at launch to skip harvesting.

## When a correction exposes a gap

When a peer's correction shows a recurring shape in your own work, or a rule misfired in a way its text does not cover, record it within a turn or two: add a `breaches` or `rule_evolution_signals` entry, and save a feedback memory so later sessions inherit it. If you have no durable memory, post one comment on the thread naming the pattern and what you will do differently. A one-off mistake, or a lesson an existing rule already states, needs no entry.
