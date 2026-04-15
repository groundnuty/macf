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

export interface RulesRefreshResult {
  readonly rules: readonly string[];
  readonly scripts: readonly string[];
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

  return { rules, scripts };
}
