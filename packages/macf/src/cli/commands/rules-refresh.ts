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
import { resolveCanonicalBranch } from '../config.js';
import { copyCanonicalAssetsGuarded } from '../canonical-overwrite-guard.js';
import { fetchProjectRules, PROJECT_RULES_SOURCE_ENV } from '../project-rules.js';
import { reportSeedPromptResponses, seedPromptResponsesConfig } from '../prompt-responses.js';
import { reportSeedStallSignatures, seedStallSignaturesConfig } from '../stall-signatures.js';
import { installGhTokenHook, installStartupPickupHook, installPluginSkillPermissions, installSandboxFdAllowRead, installSandboxExcludedCommands } from '../settings-writer.js';

export interface RulesRefreshOptions {
  /**
   * Deliberate-downgrade escape for the #1386-class stale-CLI-overwrite
   * guard (#1401 — this command has no `.macf/macf-agent.json` to read a
   * `canonicalBranch` override from, so it always judges against `main`
   * unless `MACF_CANONICAL_BRANCH` is set). Mirrors `macf update --force` /
   * `macf init --force`'s escape hatch for the same guard.
   */
  readonly force?: boolean;
}

export interface RulesRefreshResult {
  readonly rules: readonly string[];
  readonly scripts: readonly string[];
  readonly projectRules: readonly string[];
  readonly hookInstalled: boolean;
  /**
   * `true` when the stale-CLI-overwrite guard refused AND `force` was not
   * set, so neither rules nor scripts were copied this run (#1401).
   */
  readonly refused: boolean;
}

/**
 * Copy canonical rules + scripts into <targetDir>/.claude/. Target must
 * exist and be a directory. Returns copied filenames for caller logging.
 *
 * Unlike `macf update`, this does not read `.macf/macf-agent.json` — it
 * runs against any Claude Code workspace, MACF-init'd or not (including
 * `groundnuty/macf` itself — see this file's own top-of-file doc comment).
 * That is precisely why this command is exposed to the #1386 stale-CLI-
 * overwrite hazard just as much as `macf update`: it exists to write INTO
 * an already-populated, possibly hand-curated `.claude/` — routed through
 * `copyCanonicalAssetsGuarded` (#1401) with the same refuse/force/proceed
 * semantics `update` and `init` use.
 */
export function rulesRefresh(targetDir: string, options: RulesRefreshOptions = {}): RulesRefreshResult {
  if (!existsSync(targetDir)) {
    throw new Error(`Target directory does not exist: ${targetDir}`);
  }
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`Target is not a directory: ${targetDir}`);
  }

  const canonicalBranch = resolveCanonicalBranch(null);
  const copyOutcome = copyCanonicalAssetsGuarded(targetDir, {
    canonicalBranch,
    force: options.force,
  });
  if (copyOutcome.guard.kind === 'refuse') {
    if (copyOutcome.copied) {
      console.warn(`Warning: --force overriding a stale-CLI overwrite refusal: ${copyOutcome.guard.detail}`);
    } else {
      console.error(`Refused: ${copyOutcome.guard.detail}`);
    }
  } else if (copyOutcome.guard.kind === 'unknown') {
    console.warn(`Warning: ${copyOutcome.guard.detail}`);
  }
  const rules = copyOutcome.rules;
  const scripts = copyOutcome.scripts;

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

  // Refresh the canonical role-aware SessionStart work-pickup hook entry
  // (merge-preserving, DR-026/macf#768). No role is knowable in this
  // non-init'd path (no `.macf/macf-agent.json`), so the entry is written
  // unconditionally like the hooks above — the auditor's default-OFF gate
  // is enforced by the script itself reading `MACF_AGENT_ROLE` at runtime.
  installStartupPickupHook(targetDir);

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
  } else if (copyOutcome.copied) {
    // Distinct from a REFUSED copy (guard.kind === 'refuse' && !copied,
    // already reported via console.error above) — this branch is the
    // genuine "CLI installed without the rules payload" edge case.
    console.log('No canonical rule files found in CLI package (nothing to copy).');
  }

  if (scripts.length > 0) {
    console.log(`Refreshed ${scripts.length} helper script(s) in .claude/scripts/:`);
    for (const name of scripts) console.log(`  ${name}`);
  }

  console.log('Refreshed gh-token guard hook in .claude/settings.json');
  console.log('Refreshed SessionStart work-pickup hook in .claude/settings.json');

  reportSeedPromptResponses(promptResponses);
  reportSeedStallSignatures(stallSignatures);

  if (projectRules.length > 0) {
    console.log(`Refreshed ${projectRules.length} project-tier rule file(s) in .claude/rules/project/:`);
    for (const name of projectRules) console.log(`  ${name}`);
  }

  return { rules, scripts, projectRules, hookInstalled: true, refused: !copyOutcome.copied };
}
