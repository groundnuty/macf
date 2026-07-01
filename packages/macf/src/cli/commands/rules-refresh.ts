/**
 * macf rules refresh: distribute canonical coordination rules + helper
 * scripts to a workspace, without requiring full `macf init`.
 *
 * `macf update` refreshes these assets too, but only for workspaces that
 * already have a `.macf/macf-agent.json`. Several Claude Code workspaces
 * coordinate with MACF agents but don't (or can't) run full `macf init`:
 *
 *   - groundnuty/macf — the framework repo where code-agent lives; its
 *     .claude/ is hand-curated and predates `macf init`.
 *   - groundnuty/macf-science-agent — same situation for science-agent.
 *   - Any workspace operated by a bot that isn't a MACF-registered agent
 *     but still wants the canonical coordination rules (escalation,
 *     mergeStateStatus interpretation, @mention routing, etc.).
 *
 * For those workspaces, `macf rules refresh --dir <path>` copies the same
 * canonical files that `macf init` / `macf update` would copy, with no
 * dependence on App credentials, registry, certs, or pin state.
 */
import { existsSync, statSync } from 'node:fs';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import { fetchProjectRules, PROJECT_RULES_SOURCE_ENV } from '../project-rules.js';
import { reportSeedPromptResponses, seedPromptResponsesConfig } from '../prompt-responses.js';
import { reportSeedStallSignatures, seedStallSignaturesConfig } from '../stall-signatures.js';
import { installGhTokenHook, installPluginSkillPermissions, installSandboxFdAllowRead, installSandboxExcludedCommands } from '../settings-writer.js';

export interface RulesRefreshResult {
  readonly rules: readonly string[];
  readonly scripts: readonly string[];
  readonly projectRules: readonly string[];
  readonly hookInstalled: boolean;
}

/**
 * Copy canonical rules + scripts into <targetDir>/.claude/. Target must
 * exist and be a directory. Returns copied filenames for caller logging.
 *
 * Unlike `macf update`, this does not read `.macf/macf-agent.json` — it
 * runs against any Claude Code workspace, MACF-init'd or not.
 */
export function rulesRefresh(targetDir: string): RulesRefreshResult {
  if (!existsSync(targetDir)) {
    throw new Error(`Target directory does not exist: ${targetDir}`);
  }
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`Target is not a directory: ${targetDir}`);
  }

  const rules = copyCanonicalRules(targetDir);
  const scripts = copyCanonicalScripts(targetDir);

  // Seed (if absent) / validate (if present) the interactive-prompt
  // auto-responder allowlist (.claude/.macf/prompt-responses.json, DR-033 /
  // macf#645). Operator-curated state, so it is seed-if-absent + never
  // clobbered — an existing file is only validated (loud Inv-2 feedback).
  const promptResponses = seedPromptResponsesConfig(targetDir);

  // Seed (if absent) / validate (if present) the stall-signature allowlist
  // (.claude/.macf/stall-signatures.json, DR-037 / macf#686) that `macf fleet
  // resume` matches idle panes against. Operator-curated → seed-if-absent + never
  // clobbered; an existing file is only validated.
  const stallSignatures = seedStallSignaturesConfig(targetDir);

  // Project-tier rules (DR-026 §3 / F3, macf#501) from
  // MACF_PROJECT_RULES_SOURCE into .claude/rules/project/. Unset → no-op (the
  // tier is optional). Lands in a SUBDIR so it can't shadow the universal
  // rules copied above. A fetch failure warns but doesn't abort the refresh
  // (rules + scripts already landed).
  let projectRules: readonly string[] = [];
  if ((process.env[PROJECT_RULES_SOURCE_ENV] ?? '').trim() !== '') {
    try {
      projectRules = fetchProjectRules(targetDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: project-rule refresh failed: ${msg}`);
    }
  }

  // Refresh the attribution-trap PreToolUse hook entry (merge-preserving,
  // per #140). Keeps non-init'd workspaces (the macf repo itself, CV,
  // etc.) in sync with the same structural guard as macf-init'd agents.
  installGhTokenHook(targetDir);

  // Pre-approve macf-agent plugin skills so SessionStart auto-pickup
  // + /macf-status / /macf-issues don't hit interactive approval
  // dialogs. See macf#189 sub-item 2.
  installPluginSkillPermissions(targetDir);

  // Install /proc/self/fd/** in sandbox.filesystem.allowRead so
  // every Bash tool call stops failing with permission-denied on
  // the harness fd. macf#200.
  installSandboxFdAllowRead(targetDir);

  // Install canonical sandbox.excludedCommands set (grep, find,
  // bash, etc. unsandboxed) — sidesteps claude-code#43454 seccomp
  // regression. macf#211.
  installSandboxExcludedCommands(targetDir);

  if (rules.length > 0) {
    console.log(`Refreshed ${rules.length} canonical rule file(s) in .claude/rules/:`);
    for (const name of rules) console.log(`  ${name}`);
  } else {
    console.log('No canonical rule files found in CLI package (nothing to copy).');
  }

  if (scripts.length > 0) {
    console.log(`Refreshed ${scripts.length} helper script(s) in .claude/scripts/:`);
    for (const name of scripts) console.log(`  ${name}`);
  }

  console.log('Refreshed gh-token guard hook in .claude/settings.json');

  reportSeedPromptResponses(promptResponses);
  reportSeedStallSignatures(stallSignatures);

  if (projectRules.length > 0) {
    console.log(`Refreshed ${projectRules.length} project-tier rule file(s) in .claude/rules/project/:`);
    for (const name of projectRules) console.log(`  ${name}`);
  }

  return { rules, scripts, projectRules, hookInstalled: true };
}
