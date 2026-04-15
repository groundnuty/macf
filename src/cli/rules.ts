/**
 * Distribute canonical assets (coordination rules, helper scripts) from
 * the CLI package to each agent workspace's .claude/ subdirectory.
 *
 * The canonical files live at <package-root>/plugin/rules/*.md and
 * <package-root>/scripts/*.sh, shipped with the CLI (their version is
 * tied to the CLI version). On `macf init` we copy them once; on
 * `macf update` we re-copy (overwriting) so a CLI version bump
 * propagates updates to existing workspaces.
 *
 * Workspace rule copies get a header warning against direct edits.
 * Workspace script copies preserve 0755 mode so the hooks that call
 * them can execute.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const MANAGED_HEADER = [
  '<!--',
  '  This file is managed by `macf`. Do not edit directly — edits are',
  '  overwritten on the next `macf update`. The canonical source lives at',
  '  groundnuty/macf:plugin/rules/. To change a rule, file an issue or PR',
  '  against that file in the macf repo, then run `macf update` here.',
  '-->',
  '',
].join('\n');

/**
 * Locate the CLI package root by walking up from this module until a
 * package.json is found. Works for both the dev layout (running from
 * src/cli/) and the installed layout (running from dist/cli/).
 */
export function findCliPackageRoot(startUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate CLI package root walking up from ${fileURLToPath(startUrl)}`);
    }
    dir = parent;
  }
}

/**
 * Path to the canonical rules directory shipped with the CLI.
 */
export function canonicalRulesDir(packageRoot: string = findCliPackageRoot()): string {
  return join(packageRoot, 'plugin', 'rules');
}

/**
 * Copy every .md file from the canonical rules dir to <workspace>/.claude/rules/.
 * Existing files are overwritten (the canonical source wins).
 *
 * Returns the list of copied filenames (basenames). Returns empty array if
 * the canonical dir doesn't exist (e.g. CLI installed without the rules
 * payload — unlikely but safe to handle).
 */
export function copyCanonicalRules(workspaceDir: string, options: {
  readonly canonicalDir?: string;
} = {}): readonly string[] {
  const sourceDir = options.canonicalDir ?? canonicalRulesDir();
  if (!existsSync(sourceDir)) return [];

  const targetDir = join(resolve(workspaceDir), '.claude', 'rules');
  mkdirSync(targetDir, { recursive: true });

  const copied: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const src = join(sourceDir, entry.name);
    const dst = join(targetDir, entry.name);
    const content = readFileSync(src, 'utf-8');
    // Avoid double-prepending the header on re-copy.
    const out = content.startsWith('<!--') ? content : MANAGED_HEADER + content;
    writeFileSync(dst, out);
    copied.push(entry.name);
  }
  return copied;
}

/**
 * Path to the canonical scripts directory shipped with the CLI.
 */
export function canonicalScriptsDir(packageRoot: string = findCliPackageRoot()): string {
  return join(packageRoot, 'scripts');
}

/**
 * Copy every .sh file from the canonical scripts dir to
 * <workspace>/.claude/scripts/. Preserves executable mode (0o755).
 *
 * Unlike copyCanonicalRules, no header is injected — shell scripts
 * can't take HTML comments, and the shebang + usage comment in the
 * source already documents managed status.
 *
 * Returns copied basenames. Empty array if the canonical dir is missing.
 */
export function copyCanonicalScripts(workspaceDir: string, options: {
  readonly canonicalDir?: string;
} = {}): readonly string[] {
  const sourceDir = options.canonicalDir ?? canonicalScriptsDir();
  if (!existsSync(sourceDir)) return [];

  const targetDir = join(resolve(workspaceDir), '.claude', 'scripts');
  mkdirSync(targetDir, { recursive: true });

  const copied: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
    const src = join(sourceDir, entry.name);
    const dst = join(targetDir, entry.name);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
    copied.push(entry.name);
  }
  return copied;
}
