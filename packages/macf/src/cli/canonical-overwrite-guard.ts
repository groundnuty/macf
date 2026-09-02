/**
 * Refuse a stale-CLI overwrite of canonical rules/scripts (groundnuty/macf#1386).
 *
 * `copyCanonicalRules` / `copyCanonicalScripts` (rules.ts) always overwrite
 * `<workspace>/.claude/{rules,scripts}/` from the INSTALLED CLI's own
 * bundled templates — their own doc comment states the assumption plainly:
 * "a newer CLI version always wins, even when pins are unchanged." Nothing
 * previously checked that the CLI actually IS newer. When `findCliPackageRoot()`
 * resolves to a git checkout that is itself behind its own canonical branch
 * (a dev-linked / monorepo-checkout install left unrebuilt/unpulled), the
 * assumption inverts: the "newer" CLI ships OLDER rule/script content, and
 * `macf update` silently reverts any workspace file that had since been
 * refreshed from a fresher source — deleting the very evidence (a canonical
 * rule) that would have told the operator not to run it.
 *
 * `groundnuty/macf#1384` made `macf doctor` WARN about this same staleness
 * axis. A warning is read-only; it cannot stop the write. This module is the
 * refusal — the structural half `#1384` could not become on its own.
 *
 * Deliberately reuses `detectCheckoutCurrency` (`#1376`, build-info.ts)
 * rather than inventing a second staleness notion. It is asked a different
 * question than doctor's own `checkCheckoutCurrency(projectDir, config)`:
 * doctor asks "is the WORKSPACE behind canonical"; this asks "is the CLI's
 * OWN source checkout (`packageRoot`) behind ITS OWN canonical branch" —
 * answered by pointing `detectCheckoutCurrency`'s `projectDir` parameter AT
 * `packageRoot` itself. The function's identity check (does `projectDir`
 * carry the same package name as `packageRoot`) trivially passes when the
 * two paths are identical, so this reduces cleanly to "is `packageRoot` a
 * git checkout, and how far behind `origin/<canonicalBranch>` is it" —
 * `not-a-checkout` for an ordinary npm install (no `.git/` at all), exactly
 * the case that must be left unaffected.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultGitRunner, detectCheckoutCurrency } from './build-info.js';
import type { GitRunner } from './build-info.js';
import {
  canonicalPluginScriptsDir,
  canonicalRulesDir,
  canonicalScriptsDir,
  computeCanonicalRuleFile,
  computeCanonicalScriptFile,
  listDistributedRuleNames,
  listDistributedScriptNames,
} from './rules.js';

export type CanonicalOverwriteGuardResult =
  | { readonly kind: 'proceed'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string }
  | { readonly kind: 'refuse'; readonly detail: string; readonly files: readonly string[] };

/**
 * Every `.claude/rules/*.md` + `.claude/scripts/*.sh` file that ALREADY
 * EXISTS in `workspaceDir` and would be written with DIFFERENT bytes by
 * `copyCanonicalRules(workspaceDir)` / `copyCanonicalScripts(workspaceDir)`
 * given `packageRoot`'s current canonical sources.
 *
 * A file absent from the canonical source is excluded — neither
 * `copyCanonicalRules` nor `copyCanonicalScripts` ever DELETES a target
 * file that isn't present in their source directories (see their own doc
 * comments in rules.ts), so such a file would not actually be "overwritten"
 * by running them; there is nothing to refuse on its behalf.
 *
 * Returned paths are workspace-relative (`.claude/rules/<name>` /
 * `.claude/scripts/<name>`) — stable, human-readable identifiers for the
 * refusal message, independent of `workspaceDir`'s absolute location.
 */
function distributedFilesThatWouldChange(
  workspaceDir: string,
  packageRoot: string,
): readonly string[] {
  const changed: string[] = [];

  const rulesSourceDir = canonicalRulesDir(packageRoot);
  for (const name of listDistributedRuleNames({ canonicalDir: rulesSourceDir })) {
    const computed = computeCanonicalRuleFile(name, { canonicalDir: rulesSourceDir });
    if (computed === null) continue;
    const target = join(workspaceDir, '.claude', 'rules', name);
    if (!existsSync(target)) continue;
    if (readFileSync(target, 'utf-8') !== computed) {
      changed.push(join('.claude', 'rules', name));
    }
  }

  const scriptsLegacyDir = canonicalScriptsDir(packageRoot);
  const scriptsPluginDir = canonicalPluginScriptsDir(packageRoot);
  for (const name of listDistributedScriptNames({
    canonicalDir: scriptsLegacyDir,
    pluginScriptsDir: scriptsPluginDir,
  })) {
    const computed = computeCanonicalScriptFile(name, {
      canonicalDir: scriptsLegacyDir,
      pluginScriptsDir: scriptsPluginDir,
    });
    if (computed === null) continue;
    const target = join(workspaceDir, '.claude', 'scripts', name);
    if (!existsSync(target)) continue;
    if (!readFileSync(target).equals(computed)) {
      changed.push(join('.claude', 'scripts', name));
    }
  }

  return changed;
}

/**
 * Decide whether `copyCanonicalRules(workspaceDir)` / `copyCanonicalScripts
 * (workspaceDir)` are safe to run given `packageRoot`'s (the installed
 * CLI's own source) currency against `canonicalBranch`.
 *
 * - `proceed` — either `packageRoot` isn't a git checkout at all (ordinary
 *   npm install — `#144`/`#1372`'s territory, unaffected), or its checkout
 *   is current (0 commits behind), or it IS behind but no distributed file
 *   on disk would actually change (identical content, or nothing to
 *   protect yet — a fresh workspace with no `.claude/rules/` copies).
 * - `unknown` — `packageRoot`'s currency could not be determined (no
 *   `origin` remote configured, or the canonical ref hasn't been fetched
 *   locally). NEVER refuses on an undeterminable reference point — say so
 *   and let the write proceed, same "honest-unknown over guess" floor
 *   `detectCheckoutCurrency` itself documents.
 * - `refuse` — `packageRoot` is measurably behind `canonicalBranch` AND at
 *   least one existing workspace file would be overwritten with different
 *   bytes. `files` names every such file (workspace-relative paths).
 *
 * Callers honor `refuse` unless the operator has explicitly opted into a
 * deliberate downgrade (`update`'s `--force` flag) — this function itself
 * has no opinion on overrides; it only reports the safety verdict.
 */
export function checkCanonicalOverwriteSafety(
  workspaceDir: string,
  packageRoot: string,
  canonicalBranch: string,
  gitRunner: GitRunner = defaultGitRunner,
): CanonicalOverwriteGuardResult {
  const currency = detectCheckoutCurrency(packageRoot, packageRoot, canonicalBranch, gitRunner);

  if (currency.kind === 'not-a-checkout') {
    return {
      kind: 'proceed',
      detail: 'the installed CLI is not a git checkout (ordinary npm install) — nothing to compare',
    };
  }

  if (currency.kind === 'no-upstream' || currency.kind === 'unreadable') {
    const reason =
      currency.kind === 'no-upstream'
        ? 'no `origin` remote configured'
        : currency.reason;
    return {
      kind: 'unknown',
      detail:
        `cannot determine whether the installed CLI's own checkout is current (${reason}) — ` +
        `proceeding without a currency check`,
    };
  }

  // currency.kind === 'ok' from here.
  if (currency.commitCount === 0) {
    return {
      kind: 'proceed',
      detail: `the installed CLI's checkout is current with ${currency.upstream}`,
    };
  }

  const files = distributedFilesThatWouldChange(workspaceDir, packageRoot);
  if (files.length === 0) {
    return {
      kind: 'proceed',
      detail:
        `the installed CLI's checkout is ${currency.commitCount} commit(s) behind ${currency.upstream}, ` +
        `but no distributed file on disk differs from what it would write`,
    };
  }

  return {
    kind: 'refuse',
    files,
    detail:
      `the installed CLI's checkout is ${currency.commitCount} commit(s) behind ${currency.upstream} — ` +
      `refusing to overwrite ${files.length} file(s) that differ from what this stale CLI would write: ` +
      `${files.join(', ')}. Update the CLI first (\`macf self-update\`), or re-run with --force to ` +
      `overwrite anyway (a deliberate downgrade).`,
  };
}
