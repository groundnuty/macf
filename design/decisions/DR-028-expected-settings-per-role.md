# DR-028: Canonical expected-`settings.json`-per-role + the settings validator/scaffolder

**Status:** Proposed
**Date:** 2026-06-25
**Trigger:** `groundnuty/macf#533` (the 2026-06-25 onboarding-UX pass, after `macf#530`). Standing up `macf-auditor-agent` as a **pure-`macf init`** agent (no `agentic-repo-template`) exposed that **`macf init` ships no usable Bash/edit permission set**: its `permissions.allow` is built as `[...preserved, ...PLUGIN_SKILL_PERMISSIONS, ...PLUGIN_MCP_TOOL_PERMISSIONS]` (`settings-writer.ts:710`) — only `Skill(...)` + `mcp__plugin…` entries, **no `Bash(*)`/`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Agent`, no `deny` floor, no role-aware hooks**. So a freshly-init'd agent prompts on *every* command. The three substrate agents (code/science/devops) don't hit this only because their `settings.json` was **hand-wired** — and even they prompt on memory edits (code/science have no `Write`/`Edit` in `allow`).

## Context

Operator framing (`#533`): *"check for settings that should be in place and propose + generate them for the user if he wishes; and if settings are present, read + validate them against the agent's tasks"* — *"model it on code/devops/science, as they mostly work."*

This is **DR-019's sibling, one layer down**: DR-019 is the doctrine for the *GitHub App* permission set (and `macf doctor` checks live token perms against it); DR-028 is the doctrine for the *Claude Code `settings.json`* an agent runs under. And it is **the auditor's own pattern (check → propose → operator-ratifies) applied to `settings.json`** instead of coordination rules (kinship with DR-026).

**Grounded harvest (the three working agents, read 2026-06-25):**
- **deny is the real guardrail** — devops's is the most complete (credential-reads + dotfile-writes + dangerous-cmds); science's + code's are subsets. devops's `deny` is the canonical floor seed.
- **`Bash(*)` (broad), not narrow `Bash(...)` patterns** — canonical macf commands use `$GH_TOKEN` / `$MACF_WORKSPACE_DIR`, which Claude Code flags "Contains simple_expansion", defeating narrow allow-patterns. So **only `Bash(*)` actually suppresses prompts** → the model uses broad `Bash(*)` and relies on **`deny` + the PreToolUse hooks** as the real defense, not allow-narrowing. (Doctrine point: defense = deny-list + hooks, not allow-enumeration.)
- The memory-edit prompt is closed by `Write`/`Edit` in `allow` **plus** the per-agent memory dir in `additionalDirectories` (the dir is *outside* the project root — tool-allow alone doesn't cover an out-of-project path; lived in `macf-science-agent`'s `settings.local.json`).

## Decision

**1. Adopt a canonical, role-aware expected-settings model — a universal floor + per-role deltas — encoded as a single data structure in the CLI (`settings-writer.ts`), consumed by BOTH `macf init` (generate) and `macf doctor` (validate/repair).** One source of truth; no per-role template files (they would drift from the validator's expectations).

**Universal floor (every role):**
- **`allow`:** `Bash(*)`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`, `+ PLUGIN_SKILL_PERMISSIONS + PLUGIN_MCP_TOOL_PERMISSIONS` (the macf skill/mcp entries already emitted).
- **`deny` (the safety floor — devops's set is the seed):** credential reads (`~/.ssh/id_*`, `~/.ssh/*.pem`, `~/.aws/**`, `~/.gnupg/**`, `~/.kube/**`, `~/.config/gcloud/**`, `~/.netrc`, `~/.config/gh/**`, history files); config/dotfile writes (`~/.claude/settings.json`, `~/.claude.json`, `~/.ssh/**`, shell rc/profile, `~/.gitconfig`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, `~/.netrc`); dangerous commands (`sudo *`, `rm -rf /`, all force-push variants, `git commit --no-verify`/`-n`).
- **`additionalDirectories`:** the agent's per-agent memory dir (`~/.claude/projects/<encoded-workspace>/memory/`) — so memory edits don't prompt despite being out-of-project.
- **`sandbox`:** `filesystem.allowRead:["/proc/self/fd"]` + the canonical `excludedCommands` set (already installed per `macf#211`).
- **hooks:** PreToolUse **`check-gh-token` + `check-mention-routing` + `check-lgtm-gate` + `check-close-keyword`**; PostToolUse **`check-gh-attribution`**; UserPromptSubmit **`emit-turn-receipt`**; PreCompact **reflection-harvest** (F2, `macf#508`). *(lgtm-gate + close-keyword are in the floor for all roles: they only fire on `gh pr merge` / close-keyword-in-body, so they are harmless for an agent that never files PRs and correct for every one that does — fewer role branches than gating them.)*

**Per-role deltas:**
- **auditor:** **+ `check-auditor-never-acts.sh` PreToolUse (REQUIRED).** Note: the auditor still gets `Write`/`Edit` (it writes proposals/digests locally) — `never-acts` is **hook-enforced** on `gh pr merge`/`issue close` (DR-026 §1/§4), *not* permission-removed. The validator must treat a missing never-acts hook on an auditor as an **error**, not drift.
- **code / science / devops:** universal floor as-is (they all file + review PRs).
- **per-role MCP servers:** each role's `allow` carries the MCP servers it uses (e.g. writer → Scholar-Gateway/LaTeX; devops → its observability/research set). Encoded as a role delta, not floor.

**2. The capability — extend `macf doctor` (not a new `macf settings` command).** `doctor` already reads the merged `settings.json`+`settings.local.json` and checks `Write`/`Edit` presence (`macf#296`/`#305`) against DR-019; the settings-expectation check is the same surface (one diagnostic entrypoint), so:
- **`macf doctor`** (read-only, default): reports expected-vs-actual per the agent's role — **missing** entries AND **drift** (present-but-wrong), like its existing checks. Never mutates.
- **`macf doctor --fix`** : shows the diff and, **on explicit operator consent (never silent)**, generates the missing/corrected entries — preserving operator-authored extras (same merge-preserve discipline `settings-writer.ts` already uses for non-macf allow entries + the `macf#211` sandbox excludes).
- **Role inference:** from the agent's config (`env.identity` role / `--role`); `doctor` warns if role is indeterminable rather than guessing.

**3. `macf init` emits the full role-aware floor+delta** (not just skill/mcp perms) — fixing the originating bug. Same `ROLE_SETTINGS_MODEL` source as `doctor`, so init-output and doctor-expectation can't diverge.

**4. The per-role model also encodes the channel-server-LOAD mechanism (Addendum 2026-06-25, `#533`/`#108`/`#534`).** "How a home loads its channel server" is the natural sibling of the settings model — one per-role onboarding contract covering *settings* **and** *loader*. Decided (science doctrine + code-agent framework-owner read, `#533`):
- **Substrate roles (science/code/devops) → a MINIMAL channel-server-only plugin loaded via `claude.sh --plugin-dir`.** A `.claude-plugin/plugin.json` carrying *only* the channel-server `mcpServers` entry — **no hooks/skills/agents**. Uses the **proven** load path (`--plugin-dir`'s `mcpServers` spawns the server, exactly as CV/auditor do) while staying **not a `macf init` consumer** (`macf#273` + the homes invariant). The "minimal / no hooks" part is load-bearing: the full plugin's `hooks.json` would **double** the substrate's *hand-wired* hooks (the CC 2.1.x duplicate-hooks class v0.2.36 fixed for consumers).
- **Greenfield / `macf init`'d roles (CV consumers, the auditor) → the full `macf-agent` plugin** — they are consumers by construction, so the full plugin (hooks+skills+agents+mcpServers) is correct *for them*.
- **`MACF_AGENT_NAME` override is part of the loader config:** the channel server needs the *routing-label* (`devops-agent`) for its registry key + cert CN, while the substrate `claude.sh` sets the *bot-name* (`macf-devops-agent`) for OTEL — so the minimal plugin's `mcpServers.env` overrides `MACF_AGENT_NAME` to the label (the auditor dodged this only because name==label). *(A cleaner framework fix — splitting OTEL-name from routing-name — is filed separately by code-agent; until then, the env-override is the recipe.)*
- **Mechanism proof = code-agent-owned (`#533`):** nobody has loaded a *stripped* channel-server-only plugin via `--plugin-dir` yet (the proven case is the full plugin). code-agent owns confirming a minimal `plugin.json` (just `mcpServers`) loads + spawns + registers. **Documented fallback if it won't:** **(B)-stripped** — the full plugin with `hooks.json` removed (avoids the hook-doubling). This addendum records the *decision* (A) + the *fallback*; it does not assert the minimal-plugin loads until code-agent proves it (avoiding the `.mcp.json` mistake that prompted this).

## Alternatives considered
- **New `macf settings` command** — rejected: fragments the diagnostic surface; `doctor` already owns "is this agent healthy?" + reads permissions.
- **Per-role template files** — rejected: two sources of truth (template vs validator) drift; a data table feeds both generate + validate.
- **Narrow `Bash(...)` allow-patterns instead of `Bash(*)`+deny** — rejected: `simple_expansion` on `$GH_TOKEN`/`$MACF_WORKSPACE_DIR` defeats narrow patterns (they don't suppress prompts); the deny-list + hooks are the real guardrail.
- **One-size-fits-all settings (no role-awareness)** — rejected: the auditor's `never-acts` hook is *required* for it and meaningless elsewhere; MCP sets differ per role. Validation must be role-appropriate.
- **Auto-fix silently on init/doctor** — rejected: operator-consent is doctrine (kinship with DR-026's operator-ratifies; matches `macf#530`'s warn-don't-throw).

## Consequences
**Positive.** Pure-`macf init` agents are usable out of the box (no prompt-on-everything); the memory-edit prompt closes fleet-wide; a consistent safety floor (`deny`) applies to every agent; drift (not just absence) is caught; the check→propose→consent UX matches the auditor doctrine; one data model drives both init + doctor.
**Negative / risk.** `Bash(*)` is broad — accepted because `simple_expansion` defeats the alternative and the deny-list+hooks carry the defense (documented as doctrine, not oversight). Role-inference can be wrong → `doctor` warns rather than guesses. The `deny` floor is long → maintained as one constant, seeded from devops's set.

## Scope
**IN:** the `ROLE_SETTINGS_MODEL` (floor + role deltas) in `settings-writer.ts`; `macf init` emitting it; `macf doctor` reporting drift + `--fix` generating on consent; role inference.
**OUT / future:** auto-installing per-role MCP *servers* (this DR covers the *permission* entries, not server provisioning); a settings *lint* in CI; splitting the overloaded `MACF_AGENT_NAME` (separate onboarding-cluster issue — OTEL-name vs routing-label).

## Resolved questions (code-agent review, `#534`)
- **memory-dir `additionalDirectories` → FLOOR, not optional.** Out-of-project paths aren't covered by tool-allow (`Write`/`Edit`) alone — `additionalDirectories` is the mechanism — and it was already needed for science. **Live empirical test available:** the auditor stopgap has broad `Write`/`Edit` but **no** memory `additionalDirectories`, so if the auditor still prompts on memory after the operator restarts it, that proves it required. Included as floor either way.
- **write-split → split by PORTABILITY (sharpens the original lean).** Portable, role-relative entries (`allow`/`deny`/`hooks`/`sandbox`) → committed **`settings.json`** (team-visible, refreshable by `macf update`). The memory-dir `additionalDirectories` is an **absolute, machine-specific path** (`/home/ubuntu/…` vs `/Users/…`) → it goes to the **gitignored `settings.local.json`** (committing it would be wrong on another machine). So `--fix` writes the portable floor to `settings.json` and the machine-specific `additionalDirectories` to `settings.local.json`.

## References
- `macf#533` (this design ask) · `macf#530` (the App-key onboarding sibling) · DR-019 (App-permission doctrine — the sibling) · DR-026 (the auditor; the check→propose→ratify pattern + the `never-acts` hook) · `macf#211` (canonical sandbox excludes) · `macf#296`/`#305` (doctor's existing perm-read) · `macf#508` (PreCompact reflection hook)
- Grounded sources: `groundnuty/macf:.claude/settings.json` (code) · `macf-science-agent:.claude/settings.json` · `macf-devops-toolkit:.claude/settings.json` (the `deny` floor seed) · `settings-writer.ts` (`PLUGIN_SKILL_PERMISSIONS`, the `allow`-build at :710) · `commands/doctor.ts`
