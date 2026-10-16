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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { PACKAGE_VERSION } from '../package-version.js';

export const MANAGED_HEADER = [
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
 * Refuse loudly, before writing anything, when a directory `copyCanonicalRules`
 * / `copyCanonicalScripts` is about to read from does not exist on this CLI
 * install.
 *
 * Historically each copy primitive skipped a missing source dir individually
 * (`if (!existsSync(dir)) continue`) and returned/reported success over
 * nothing written — correct in isolation (an optional dir really might be
 * absent), but wrong once EVERY listed dir is a required canonical source: a
 * real CLI install always ships all of them (`package.json` `files[]`), so an
 * absent one is a packaging defect, not an expected state. groundnuty/macf#1403
 * is the concrete instance — every npm-published CLI through 0.2.59 shipped
 * `plugin/rules/` + `scripts/` but never `plugin/scripts/` (the `files[]`
 * entry was never added when the 7 load-bearing hooks moved there in #749),
 * so `copyCanonicalScripts` silently wrote 0 of the 14 scripts that live
 * there and told every caller it succeeded.
 *
 * Deliberately narrow: this asserts the SOURCE DIRECTORY exists, not that it
 * has anything left to copy — a source dir that exists but yields zero
 * files needing a refresh (everything already current, or genuinely empty)
 * stays silent, exactly as before. Only "the canonical source itself is
 * missing" is loud. Matches the ratified failure policy in DR-044 Decision 6
 * ("fail loudly and eagerly ... the cleanest, simplest reasons ... as fast
 * as possible") — one aggregated error naming every missing dir, not one
 * error per dir.
 */
function assertCanonicalSourceDirsExist(dirs: readonly string[]): void {
  const missing = dirs.filter((dir) => !existsSync(dir));
  if (missing.length === 0) return;
  throw new Error(
    `macf v${PACKAGE_VERSION}: canonical source director${missing.length === 1 ? 'y' : 'ies'} missing from ` +
    `this CLI install: ${missing.join(', ')}. This CLI cannot distribute the files it ships from here — ` +
    'reinstall @groundnuty/macf, or if reinstalling does not fix it, file a packaging bug against ' +
    'groundnuty/macf.',
  );
}

/**
 * Copy every .md file from the canonical rules dir to <workspace>/.claude/rules/.
 * Existing macf-managed files are overwritten (the canonical source wins);
 * existing files without the managed header are kept (see
 * `copyCanonicalRulesDetailed`).
 *
 * Returns the list of copied filenames (basenames). Throws when the
 * canonical dir doesn't exist — see `assertCanonicalSourceDirsExist` — a
 * missing canonical source is always a packaging defect on a real CLI
 * install, never a state to silently tolerate.
 */
export function copyCanonicalRules(workspaceDir: string, options: {
  readonly canonicalDir?: string;
} = {}): readonly string[] {
  return copyCanonicalRulesDetailed(workspaceDir, options).copied;
}

/**
 * True when `existing` (a workspace rule file's content) is operator-authored
 * rather than a macf-managed copy: it lacks the managed header and is not
 * byte-identical to what macf would write. Same predicate `retireCanonicalRules`
 * uses, so copy and retirement agree on who owns a file.
 */
export function isOperatorAuthoredRule(existing: string, canonicalContent: string, rawSource?: string): boolean {
  return !beginsWithManagedHeader(existing) && existing !== canonicalContent && existing !== rawSource;
}

/**
 * `copyCanonicalRules` plus the names it declined to overwrite: a destination
 * file with no managed header is operator-authored (e.g. a workspace
 * template's own `pr-discipline.md`), so it is kept and listed in `kept`.
 * Warns once per kept file via `options.warn` (default `console.warn`).
 */
export function copyCanonicalRulesDetailed(workspaceDir: string, options: {
  readonly canonicalDir?: string;
  readonly warn?: (message: string) => void;
} = {}): { readonly copied: readonly string[]; readonly kept: readonly string[] } {
  const sourceDir = options.canonicalDir ?? canonicalRulesDir();
  assertCanonicalSourceDirsExist([sourceDir]);
  const warn = options.warn ?? ((m: string) => console.warn(m));

  const targetDir = join(resolve(workspaceDir), '.claude', 'rules');
  mkdirSync(targetDir, { recursive: true });

  const copied: string[] = [];
  const kept: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const src = join(sourceDir, entry.name);
    const dst = join(targetDir, entry.name);
    const raw = readFileSync(src, 'utf-8');
    const out = computeCanonicalRuleContent(raw);
    let dstStat: ReturnType<typeof lstatSync> | undefined;
    try { dstStat = lstatSync(dst); } catch { dstStat = undefined; }
    // Never write through a symlink: it would overwrite the link's target, possibly outside the workspace.
    if (dstStat?.isSymbolicLink()) {
      kept.push(entry.name);
      warn(
        `  Warning: .claude/rules/${entry.name} is a symbolic link, so macf leaves it alone rather than ` +
        'write through it. Replace it with a regular file or delete it, then run `macf update`.',
      );
      continue;
    }
    if (dstStat?.isFile() && isOperatorAuthoredRule(readFileSync(dst, 'utf-8'), out, raw)) {
      kept.push(entry.name);
      warn(
        `  Warning: .claude/rules/${entry.name} has no macf managed header, so it is operator-authored — ` +
        'left in place, not replaced by the canonical rule of the same name. Rename it to keep both, ' +
        'or delete it and run `macf update` to take the canonical one.',
      );
      continue;
    }
    writeFileSync(dst, out);
    copied.push(entry.name);
  }
  return { copied, kept };
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
  if (rawContent.startsWith('<!--')) return rawContent;
  // A `---` YAML frontmatter block must stay byte-identical at the very top:
  // Claude Code reads `paths:` only from there (#1465). The header goes after
  // the closing `---`, never above it.
  const fm = FRONTMATTER_RE.exec(rawContent);
  if (fm !== null) {
    const block = fm[0].endsWith('\n') ? fm[0] : fm[0] + '\n';
    return block + MANAGED_HEADER + rawContent.slice(fm[0].length);
  }
  return MANAGED_HEADER + rawContent;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Canonical rule file names that were removed or renamed upstream. A workspace
 * copy of one stays loaded forever unless something deletes it, so every
 * distributing command (`init`, `update`, `rules refresh`) removes these —
 * only when the copy still carries the managed header (see
 * `retireCanonicalRules`). Append a basename here in the same change that
 * deletes or renames the canonical source.
 */
export const RETIRED_CANONICAL_RULES: readonly string[] = [
  'check-before-propose.md',
  'codify-at-correction-time.md',
  'execute-on-directive.md',
  'model-era-compatibility.md',
];

/** True when `content` begins with the managed header, directly or right after a leading frontmatter block. */
function beginsWithManagedHeader(content: string): boolean {
  if (content.startsWith(MANAGED_HEADER)) return true;
  const fm = FRONTMATTER_RE.exec(content);
  if (fm === null) return false;
  return content.slice(fm[0].length).startsWith(MANAGED_HEADER);
}

function assertRetiredNameSafe(name: string): void {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name) || name.includes('..')) {
    throw new Error(`retired canonical rule name must be a plain *.md basename, got: ${name}`);
  }
}

/**
 * Retired rule copies in `<workspace>/.claude/rules/`, split by ownership:
 * `managed` still begin with the macf managed header (safe to delete);
 * `operatorAuthored` do not (never touched). Absent files appear in neither.
 */
export function findRetiredRuleCopies(workspaceDir: string, options: {
  readonly retired?: readonly string[];
} = {}): { readonly managed: readonly string[]; readonly operatorAuthored: readonly string[] } {
  const managed: string[] = [];
  const operatorAuthored: string[] = [];
  const dir = join(resolve(workspaceDir), '.claude', 'rules');
  for (const name of options.retired ?? RETIRED_CANONICAL_RULES) {
    assertRetiredNameSafe(name);
    const path = join(dir, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    (beginsWithManagedHeader(readFileSync(path, 'utf-8')) ? managed : operatorAuthored).push(name);
  }
  return { managed, operatorAuthored };
}

/**
 * Delete each retired rule copy that still carries the managed header; keep
 * (and warn once per file about) any without it. Deletes nothing outside
 * `.claude/rules/` and nothing not named in `retired`. Idempotent.
 */
export function retireCanonicalRules(workspaceDir: string, options: {
  readonly retired?: readonly string[];
  readonly warn?: (message: string) => void;
} = {}): { readonly removed: readonly string[]; readonly kept: readonly string[] } {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const { managed, operatorAuthored } = findRetiredRuleCopies(workspaceDir, options);
  const dir = join(resolve(workspaceDir), '.claude', 'rules');
  for (const name of managed) unlinkSync(join(dir, name));
  for (const name of operatorAuthored) {
    warn(
      `  Warning: .claude/rules/${name} is a retired canonical rule name but has no macf managed ` +
      'header, so it is operator-authored — left in place. Delete it by hand if it is not wanted.',
    );
  }
  return { removed: managed, kept: operatorAuthored };
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
 * no overlap is expected in practice). Throws (`assertCanonicalSourceDirsExist`)
 * when EITHER source dir doesn't exist — a real CLI install always ships
 * both, so a missing one is a packaging defect (groundnuty/macf#1403), not a
 * state to silently tolerate. Naming BOTH in one error when both are absent,
 * per DR-044 Decision 6's "one reason, once" failure policy.
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
  assertCanonicalSourceDirsExist(sourceDirs.map(({ dir }) => dir));

  const targetDir = join(resolve(workspaceDir), '.claude', 'scripts');
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];

  for (const { dir: sourceDir, excluded } of sourceDirs) {
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
