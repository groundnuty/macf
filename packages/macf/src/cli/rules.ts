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
 *
 * **DR-039 phase 2 (groundnuty/macf#698):** the 7 load-bearing hook
 * scripts single-sourced into the plugin's `hooks/hooks.json` at DR-039
 * Decision 2 (`check-gh-token.sh`, `check-mention-routing.sh`,
 * `check-lgtm-gate.sh`, `check-close-keyword.sh`, `check-gh-attribution.sh`,
 * `check-channel-alive.sh`, `harvest-reflection.sh`) moved a second time —
 * their FILES now live at `<package-root>/plugin/scripts/*.sh` (tamper-
 * resistant: the plugin invokes them via `${CLAUDE_PLUGIN_ROOT}/scripts/`, so
 * an agent editing its workspace `.claude/scripts/` copy no longer changes
 * what the hook actually runs). `copyCanonicalScripts` still distributes a
 * compat copy of those 7 to `<workspace>/.claude/scripts/` — hand-wired
 * substrate hooks (`settings.json`-registered, pre-DR-039 workspaces) and
 * non-plugin-init'd workspaces still reference that path — so it now reads
 * from TWO source directories: the legacy `<package-root>/scripts/` (helper
 * scripts + the 3 hooks that remain hand-wired) and the new
 * `<package-root>/plugin/scripts/` (the 7 migrated hooks, alongside the
 * plugin-only `mark-turn-state.sh`, which is deliberately excluded from the
 * `.claude/scripts/` compat copy — see `PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT`).
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
    const out = computeCanonicalRuleContent(content);
    writeFileSync(dst, out);
    copied.push(entry.name);
  }
  return copied;
}

/**
 * The set of rule basenames `copyCanonicalRules` WOULD write to
 * `<workspace>/.claude/rules/` right now — enumeration only, no workspace
 * involved. Mirrors `copyCanonicalRules`'s own filter (`.md` files in the
 * canonical rules dir) exactly, so the two can never drift apart — same
 * discipline as `listDistributedScriptNames` for `.claude/scripts/`.
 *
 * Used by `macf doctor`'s distributed-rule-currency check (groundnuty/macf#1360
 * "consider whether the same gap applies to rules, not just scripts" — the
 * auditor's own stale workspace had BOTH a nineteen-day-stale
 * `check-gh-token.sh` AND rule files that had drifted behind canonical, and
 * only the script half had a doctor check).
 *
 * Deliberately does NOT include per-agent identity files
 * (`agent-identity.md`, `gh-token-refresh.md`, project-tier rules under
 * `.claude/rules/project/`) — those are not part of `canonicalRulesDir()`'s
 * flat `.md` listing, so they fall outside `copyCanonicalRules`'s own
 * filter and outside this population too. A workspace carrying extra
 * files beyond this list is not itself a currency defect.
 */
export function listDistributedRuleNames(options: {
  readonly canonicalDir?: string;
} = {}): readonly string[] {
  const sourceDir = options.canonicalDir ?? canonicalRulesDir();
  if (!existsSync(sourceDir)) return [];

  const names: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    names.push(entry.name);
  }
  return names.sort();
}

/**
 * Apply the same header-prepend logic `copyCanonicalRules` uses (avoid
 * double-prepending on re-copy) to a canonical rule file's raw content. Pure
 * — exported (DR-040 Decision 3 / macf#698 R1) so `computeCanonicalRuleFile`
 * below AND `copyCanonicalRules` above share one implementation.
 */
function computeCanonicalRuleContent(rawContent: string): string {
  return rawContent.startsWith('<!--') ? rawContent : MANAGED_HEADER + rawContent;
}

/**
 * Compute what `copyCanonicalRules` WOULD write for a single rule file
 * `name` (e.g. `coordination.md`), WITHOUT writing anything — the canonical-
 * compute tier-check's per-file-type primitive for `.claude/rules/*.md`
 * (DR-040 Decision 3 / macf#698 R1). Returns `null` when the canonical
 * source directory doesn't carry that filename (nothing to compute against —
 * the caller's fail-safe default is `genuine-delta`).
 */
export function computeCanonicalRuleFile(name: string, options: {
  readonly canonicalDir?: string;
} = {}): string | null {
  const sourceDir = options.canonicalDir ?? canonicalRulesDir();
  const src = join(sourceDir, name);
  if (!existsSync(src)) return null;
  return computeCanonicalRuleContent(readFileSync(src, 'utf-8'));
}

/**
 * Path to the LEGACY canonical scripts directory shipped with the CLI —
 * agent-invoked helpers (`macf-gh-token.sh`, `macf-whoami.sh`,
 * `tmux-send-to-claude.sh`) plus the 3 hooks that remain hand-wired in
 * `.claude/settings.json` post-DR-039 (`check-auditor-never-acts.sh`,
 * `emit-turn-receipt.sh`, `check-channels-enabled.sh`).
 */
export function canonicalScriptsDir(packageRoot: string = findCliPackageRoot()): string {
  return join(packageRoot, 'scripts');
}

/**
 * Path to the canonical PLUGIN scripts directory shipped with the CLI
 * (`<package-root>/plugin/scripts/`). Since DR-039 phase 2
 * (groundnuty/macf#698) this is the canonical home of the 7 load-bearing
 * hook scripts the plugin's `hooks/hooks.json` invokes via
 * `${CLAUDE_PLUGIN_ROOT}/scripts/`, alongside the pre-existing
 * plugin-only `mark-turn-state.sh`.
 */
export function canonicalPluginScriptsDir(packageRoot: string = findCliPackageRoot()): string {
  return join(packageRoot, 'plugin', 'scripts');
}

/**
 * Scripts that live under `canonicalPluginScriptsDir()` but are NEVER
 * distributed to `<workspace>/.claude/scripts/` — they have no hand-wired
 * `.claude/scripts/`-path consumer (they're invoked exclusively via
 * `${CLAUDE_PLUGIN_ROOT}/scripts/` from the plugin's own `hooks.json`), so a
 * compat copy would just be dead weight in the workspace.
 */
const PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT: ReadonlySet<string> = new Set(['mark-turn-state.sh']);

/**
 * Copy every .sh file from the canonical scripts dirs to
 * <workspace>/.claude/scripts/. Preserves executable mode (0o755).
 *
 * Reads from TWO source directories (DR-039 phase 2, groundnuty/macf#698):
 * the legacy `canonicalScriptsDir()` (helper scripts + the 3 hand-wired
 * hooks) and `canonicalPluginScriptsDir()` (the 7 hook scripts that moved
 * into the plugin — one canonical source feeding two consumers: the
 * plugin's own `hooks.json` mount AND this `.claude/scripts/` compat copy).
 * `PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT` filters out plugin-only scripts
 * (`mark-turn-state.sh`) that have no `.claude/scripts/`-path consumer.
 *
 * Unlike copyCanonicalRules, no header is injected — shell scripts
 * can't take HTML comments, and the shebang + usage comment in the
 * source already documents managed status.
 *
 * Returns copied basenames (deduplicated across both source dirs, though
 * no overlap is expected in practice). Missing source dirs are skipped
 * individually (not a hard failure) — the target dir is created only if at
 * least one source dir exists and yields a script to copy.
 */
/**
 * Scripts that live in the canonical dir for co-location but are REPO-LOCAL
 * to `groundnuty/macf` — they operate on things a consumer workspace does not
 * have (`design/decisions/*.md`, the release pipeline), so distributing them
 * ships dead weight to every fleet. Excluded from `copyCanonicalScripts`
 * (groundnuty/macf#998).
 *
 * `release.sh`/`release.test.sh` were already being distributed before this
 * set existed; adding them here corrects that rather than preserving it.
 */
export const CANONICAL_SCRIPTS_REPO_LOCAL: ReadonlySet<string> = new Set([
  'check-dr-citations.sh',
  'check-dr-citations-diff.sh',
  'release.sh',
  'release.test.sh',
]);

export function copyCanonicalScripts(workspaceDir: string, options: {
  readonly canonicalDir?: string;
  readonly pluginScriptsDir?: string;
} = {}): readonly string[] {
  const sourceDirs: readonly { readonly dir: string; readonly excluded: ReadonlySet<string> }[] = [
    { dir: options.canonicalDir ?? canonicalScriptsDir(), excluded: CANONICAL_SCRIPTS_REPO_LOCAL },
    { dir: options.pluginScriptsDir ?? canonicalPluginScriptsDir(), excluded: PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT },
  ];

  const targetDir = join(resolve(workspaceDir), '.claude', 'scripts');
  const copied: string[] = [];

  for (const { dir: sourceDir, excluded } of sourceDirs) {
    if (!existsSync(sourceDir)) continue;
    mkdirSync(targetDir, { recursive: true });
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      if (excluded.has(entry.name)) continue;
      const src = join(sourceDir, entry.name);
      const dst = join(targetDir, entry.name);
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      copied.push(entry.name);
    }
  }
  return copied;
}

/**
 * The set of script basenames `copyCanonicalScripts` WOULD write to
 * `<workspace>/.claude/scripts/` right now, given the two canonical source
 * dirs — enumeration only, no workspace involved. Mirrors
 * `copyCanonicalScripts`'s own filter (`.sh` files, minus each dir's
 * exclusion set) exactly, so the two can never drift apart.
 *
 * Used by `macf doctor`'s distributed-script-currency check
 * (groundnuty/macf#1362) to know what "current" means for a workspace
 * before comparing any on-disk file against it.
 */
export function listDistributedScriptNames(options: {
  readonly canonicalDir?: string;
  readonly pluginScriptsDir?: string;
} = {}): readonly string[] {
  const sourceDirs: readonly { readonly dir: string; readonly excluded: ReadonlySet<string> }[] = [
    { dir: options.canonicalDir ?? canonicalScriptsDir(), excluded: CANONICAL_SCRIPTS_REPO_LOCAL },
    { dir: options.pluginScriptsDir ?? canonicalPluginScriptsDir(), excluded: PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT },
  ];

  const names = new Set<string>();
  for (const { dir, excluded } of sourceDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      if (excluded.has(entry.name)) continue;
      names.add(entry.name);
    }
  }
  return [...names].sort();
}

/**
 * Compute the bytes `copyCanonicalScripts` WOULD write for a single script
 * `name` (e.g. `macf-gh-token.sh`), WITHOUT writing anything — the
 * canonical-compute tier-check's per-file-type primitive for
 * `.claude/scripts/*` (DR-040 Decision 3 / macf#698 R1).
 *
 * Mirrors `copyCanonicalScripts`'s two-source-dir winner semantics exactly:
 * that function iterates the legacy dir FIRST then the plugin dir SECOND,
 * copying to the SAME target path — so when a filename exists in both, the
 * plugin dir's bytes are what actually lands on disk (the later copy wins).
 * A name that is `PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT` (currently only
 * `mark-turn-state.sh`) is never distributed to `.claude/scripts/` at all —
 * returns `null` (not managed at this path) even if a stray same-named file
 * happens to sit there.
 *
 * Returns `null` when neither source dir carries the filename — nothing to
 * compute against (the caller's fail-safe default is `genuine-delta`).
 */
export function computeCanonicalScriptFile(name: string, options: {
  readonly canonicalDir?: string;
  readonly pluginScriptsDir?: string;
} = {}): Buffer | null {
  if (PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT.has(name)) return null;

  const pluginDir = options.pluginScriptsDir ?? canonicalPluginScriptsDir();
  const pluginPath = join(pluginDir, name);
  if (existsSync(pluginPath)) return readFileSync(pluginPath);

  const legacyDir = options.canonicalDir ?? canonicalScriptsDir();
  const legacyPath = join(legacyDir, name);
  if (existsSync(legacyPath)) return readFileSync(legacyPath);

  return null;
}
