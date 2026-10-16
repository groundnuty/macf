# Re-auditing rules when the model family changes

The canonical rules in `packages/macf/plugin/rules/` are loaded in full at every session start, so they have to fit the model that reads them. A rule written to correct an older model's habit can cause over-verification, repeated confirmation or a nudge toward a failure the newer model would not make. Re-audit after each model family change (currently Claude Opus 5.5 and Sonnet 5.5).

## Procedure

1. Run `/doctor prompt-audit` in Claude Code, or the `prompt-audit` subcommand of the `claude-api` skill. It checks instruction files against the current model's guidance.
2. Read the model's behaviour notes in the `claude-api` skill's `shared/model-migration.md` before deciding what a rule should say. Take claims about model behaviour from there; do not write them from memory.
3. For each sentence in a rule, ask three questions:
   - Is it a fact the model cannot know (commands, labels, paths, identities)? Keep it, once.
   - Does a hook in `packages/macf/plugin/hooks/hooks.json` already enforce it? Shrink it to the behaviour, its reason and the hook's name.
   - Is it general practice the model follows unprompted? Shrink it to the project-specific point, or remove it.
4. Keep a prohibition only for a failure the current model still makes. The audit guidance says an instruction to verify "now causes over-verification", and that a prohibition against a failure the model was not going to make can anchor it toward that failure.
5. When a rule file is merged or removed, add its basename to `RETIRED_CANONICAL_RULES` in `packages/macf/src/cli/rules.ts`, or every workspace keeps the old copy loaded.
6. Grep for references to the file and its section names (`packages`, `docs`, `design`, `.github`) and retarget them.
