/**
 * Project-tier rule distribution (groundnuty/macf#501, DR-026 F3).
 *
 * The three-tier rule model (DR-026 §3) splits coordination knowledge into:
 *   1. Universal / product rules — shipped IN the CLI at `plugin/rules/*.md`,
 *      copied to `.claude/rules/*.md` (see rules.ts `copyCanonicalRules`).
 *   2. **Project rules** — per-deployment, NOT shipped in the npm product. This
 *      module. Sourced from an explicit config and copied to a SUBDIR
 *      `.claude/rules/project/*.md` so the universal and project tiers are
 *      distinguishable on disk (DR-026 §4's subordination check needs a clean
 *      target to match against).
 *   3. Agent-private rules — an agent's own `.claude/rules/` / memory; out of
 *      scope here.
 *
 * **Why explicit config, not "the coordination repo".** A multi-repo deployment
 * has no single repo to implicitly pull project rules from, so the source MUST
 * be configured. `MACF_PROJECT_RULES_SOURCE` carries it, in one of two forms:
 *
 *   - `<owner>/<repo>//<path>`  — a GitHub repo + subdir (e.g.
 *                                 `groundnuty/macf//project-rules`). Fetched via
 *                                 a shallow `git clone` of the default branch,
 *                                 mirroring plugin-fetcher.ts (reuse, don't
 *                                 reinvent). The `//` separates repo from path.
 *   - a local directory path     — anything WITHOUT the `//` separator that
 *                                 resolves to a directory on disk. Copied
 *                                 directly (no clone). Lets a single-host
 *                                 deployment point at a checked-out repo or a
 *                                 plain rules directory.
 *
 * **Optional tier — never errors on absence.** When the env var is unset/empty,
 * `fetchProjectRules` is a no-op returning `[]`. The tier is optional, exactly
 * like a workspace that has no universal rules: absence is normal, not a fault.
 *
 * **No shadow of the universal tier.** Project rules land under
 * `.claude/rules/project/`, a different subdir from the universal
 * `.claude/rules/*.md`. The universal-rule copy path (rules.ts) is untouched,
 * so this can never overwrite a universal rule.
 *
 * **Precedence (documented, NOT enforced here).** Project rules *add to /
 * specialize* the universal protocol; they never weaken it. The §4
 * invariant-check that enforces "never contradict" is a separate (gated) slice
 * of DR-026 — F3 only lays down the on-disk tiers. See
 * `design/project-tier-rules.md`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Env var carrying the project-rules source (operator-managed config). */
export const PROJECT_RULES_SOURCE_ENV = 'MACF_PROJECT_RULES_SOURCE';

/**
 * Header prepended to each copied project rule, marking the on-disk tier +
 * the managed-from-source contract. Distinct wording from the universal-rule
 * MANAGED_HEADER (rules.ts) so an operator inspecting a file knows which tier
 * it belongs to + where it came from.
 */
const PROJECT_RULE_HEADER = [
  '<!--',
  '  PROJECT-TIER RULE (DR-026 §3 tier 2). Distributed by `macf` from this',
  `  deployment's project-rules source (\`${PROJECT_RULES_SOURCE_ENV}\`). Do not`,
  '  edit this workspace copy — edits are overwritten on the next `macf update`.',
  '  Edit the rule at the source, then re-run `macf update` here.',
  '',
  '  Project rules ADD TO / SPECIALIZE the universal rules in',
  '  .claude/rules/*.md; they must never contradict or weaken them',
  '  (DR-026 §4). See design/project-tier-rules.md.',
  '-->',
  '',
].join('\n');

/**
 * Destination directory for project-tier rules within a workspace:
 * `<workspace>/.claude/rules/project/`. A SUBDIR of the universal-rule dir so
 * the two tiers are distinguishable on disk.
 */
export function workspaceProjectRulesDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.claude', 'rules', 'project');
}

/**
 * Parsed shape of a `MACF_PROJECT_RULES_SOURCE` value.
 *
 *   - `kind: 'github'` — `<owner>/<repo>//<path>` form: fetched via git clone.
 *   - `kind: 'local'`  — a local directory path: copied directly.
 */
export type ProjectRulesSource =
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string; readonly subpath: string }
  | { readonly kind: 'local'; readonly dir: string };

/**
 * Parse a `MACF_PROJECT_RULES_SOURCE` value into a discriminated source.
 *
 * The `//` separator disambiguates the two forms unambiguously: a GitHub
 * `<owner>/<repo>//<path>` always contains `//`, a local filesystem path
 * never does (`//` collapses to `/` on POSIX and isn't a meaningful path
 * token). So presence of `//` selects the github form; absence selects local.
 *
 * Returns `undefined` for an empty/whitespace-only value (caller treats as
 * no-op) or a malformed github form (missing owner/repo/path segment) —
 * malformed is surfaced by the caller as a warning, not a parse crash.
 */
export function parseProjectRulesSource(raw: string | undefined): ProjectRulesSource | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;

  const sepIdx = value.indexOf('//');
  if (sepIdx < 0) {
    // No `//` → local directory path.
    return { kind: 'local', dir: value };
  }

  const repoPart = value.slice(0, sepIdx);
  const subpath = value.slice(sepIdx + 2).replace(/^\/+|\/+$/g, '');
  const ownerRepo = repoPart.split('/');
  if (ownerRepo.length !== 2 || !ownerRepo[0] || !ownerRepo[1] || subpath === '') {
    // Malformed github form (e.g. "owner//path" with no repo, or trailing
    // empty subpath). Don't throw — caller warns + skips.
    return undefined;
  }
  return { kind: 'github', owner: ownerRepo[0], repo: ownerRepo[1], subpath };
}

export interface FetchProjectRulesOptions {
  /** Override the env value (defaults to process.env[MACF_PROJECT_RULES_SOURCE]). */
  readonly source?: string;
  /**
   * Override the GitHub base URL for the github-source form (tests point this
   * at a local bare repo). Defaults to `https://github.com`.
   */
  readonly githubBaseUrl?: string;
}

const DEFAULT_GITHUB_BASE_URL = 'https://github.com';

/**
 * Distribute project-tier rules into `<workspace>/.claude/rules/project/`.
 *
 * Resolves the source from `MACF_PROJECT_RULES_SOURCE` (or `options.source`):
 *   - Unset/empty/whitespace → NO-OP, returns `[]`. The tier is optional.
 *   - `<owner>/<repo>//<path>` → shallow git clone the default branch (mirrors
 *     plugin-fetcher.ts), copy `<clone>/<path>/*.md` to the dest subdir.
 *   - a local directory path → copy `<dir>/*.md` directly.
 *
 * Only `*.md` files are copied (a `.example` template, a README, etc. in the
 * source are ignored — same filter as the universal-rule copy). Each copied
 * file gets the PROJECT_RULE_HEADER prepended (unless it already opens with an
 * HTML comment, to avoid double-stacking).
 *
 * **Idempotent + non-destructive to other tiers.** The dest is a fresh subdir;
 * the universal `.claude/rules/*.md` files are never touched (different path).
 * Re-running overwrites the project subdir's `*.md` files with the current
 * source content. A `.example` seed (from `macf init`) is preserved — only
 * `*.md` files are managed here.
 *
 * Throws only on a genuine fetch failure (git clone error, source path is a
 * file not a directory, the github subpath is missing in the clone). A
 * malformed source string is a no-op-with-warning, NOT a throw, so a typo'd
 * config can't break `macf update`.
 *
 * @returns the list of copied basenames (empty when the source is unset or
 *   the source dir has no `*.md` files).
 */
export function fetchProjectRules(
  workspaceDir: string,
  options: FetchProjectRulesOptions = {},
): readonly string[] {
  const raw = options.source ?? process.env[PROJECT_RULES_SOURCE_ENV];
  const parsed = parseProjectRulesSource(raw);
  if (parsed === undefined) {
    if ((raw ?? '').trim() !== '') {
      // Non-empty but unparseable — surface it; don't silently drop.
      process.stderr.write(
        `Warning: ${PROJECT_RULES_SOURCE_ENV}="${raw}" is malformed.\n` +
          `  Expected "<owner>/<repo>//<path>" (e.g. groundnuty/macf//project-rules)\n` +
          `  or a local directory path. Skipping project-rule distribution.\n`,
      );
    }
    return [];
  }

  if (parsed.kind === 'local') {
    const srcDir = resolve(parsed.dir);
    if (!existsSync(srcDir)) {
      throw new Error(
        `${PROJECT_RULES_SOURCE_ENV} local source does not exist: ${srcDir}`,
      );
    }
    if (!statSync(srcDir).isDirectory()) {
      throw new Error(
        `${PROJECT_RULES_SOURCE_ENV} local source is not a directory: ${srcDir}`,
      );
    }
    return copyMarkdownRules(srcDir, workspaceProjectRulesDir(workspaceDir));
  }

  // github form — shallow-clone the default branch (mirrors plugin-fetcher.ts),
  // copy the subpath's *.md files, discard the clone.
  const baseUrl = options.githubBaseUrl ?? DEFAULT_GITHUB_BASE_URL;
  const repoUrl = `${baseUrl}/${parsed.owner}/${parsed.repo}`;
  const tmpClone = mkdtempSync(join(tmpdir(), 'macf-project-rules-clone-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', repoUrl, tmpClone], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const srcDir = join(tmpClone, parsed.subpath);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      throw new Error(
        `Project-rules subpath "${parsed.subpath}" not found in ${repoUrl}. ` +
          `Check ${PROJECT_RULES_SOURCE_ENV} and the repo layout.`,
      );
    }
    return copyMarkdownRules(srcDir, workspaceProjectRulesDir(workspaceDir));
  } catch (err) {
    if (err instanceof Error && err.message.includes('subpath')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch project rules from ${repoUrl}: ${msg}. ` +
        `Check network access + that ${PROJECT_RULES_SOURCE_ENV} is correct.`,
      { cause: err },
    );
  } finally {
    rmSync(tmpClone, { recursive: true, force: true });
  }
}

/**
 * Copy every `*.md` file from `srcDir` to `destDir`, prepending the
 * project-rule header. Creates `destDir` (mkdir -p). Returns copied basenames.
 * Shared by both the local and github source paths.
 */
function copyMarkdownRules(srcDir: string, destDir: string): readonly string[] {
  mkdirSync(destDir, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = readFileSync(join(srcDir, entry.name), 'utf-8');
    const out = content.startsWith('<!--') ? content : PROJECT_RULE_HEADER + content;
    writeFileSync(join(destDir, entry.name), out);
    copied.push(entry.name);
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Seed (.example) template — written by `macf init`
// ---------------------------------------------------------------------------

/**
 * Basename of the seed template `macf init` drops into the project-rules
 * subdir. The `.example` suffix keeps it OUT of the live-rule set (only `*.md`
 * are loaded as rules + managed by `fetchProjectRules`), so it self-documents
 * the tier + gives the DR-026 §4 auditor a format to match without becoming a
 * rule itself.
 */
export const PROJECT_RULE_SEED_NAME = 'EXAMPLE.project-rule.md.example';

/**
 * Generic, deployment-agnostic seed content for the project-rules tier.
 *
 * CRITICAL: this ships via `macf init` to EVERY deployment, so it must NOT be
 * macf-specific. A genomics deployment must not receive a macf `dev.mk` rule.
 * The body demonstrates the FORMAT + the precedence contract with neutral
 * placeholders only — never a concrete macf rule.
 */
export function projectRuleSeedContent(): string {
  return [
    '<!--',
    '  EXAMPLE project-tier rule (template, not active).',
    '',
    '  This file ends in `.example`, so `macf` does NOT load it as a live rule',
    '  and does NOT overwrite it on `macf update` (only `*.md` files in this',
    '  directory are managed). It self-documents the project-rules tier and',
    '  gives the DR-026 §4 auditor a format to match.',
    '-->',
    '',
    '# Project-tier rules (`.claude/rules/project/`)',
    '',
    'This directory holds **project-tier** coordination rules (DR-026 §3, tier 2):',
    'per-deployment rules that ADD TO or SPECIALIZE the universal rules in the',
    'parent `.claude/rules/*.md` directory.',
    '',
    '## Where these come from',
    '',
    'Project rules are distributed by `macf` from this deployment\'s configured',
    'source, set via the `MACF_PROJECT_RULES_SOURCE` operator config in',
    '`.claude/.macf/env.project-rules`. The source is one of:',
    '',
    '- `<owner>/<repo>//<path>` — a GitHub repo + subdir',
    '  (e.g. `your-org/your-coordination-repo//project-rules`)',
    '- a local directory path — for single-host deployments',
    '',
    'When `MACF_PROJECT_RULES_SOURCE` is unset, this tier is empty (it is',
    'optional). Authored rules live at the SOURCE, not in this workspace copy —',
    'edit them there, then run `macf update` here.',
    '',
    '## Precedence (the one hard contract)',
    '',
    'Project rules may **add to / specialize** the universal protocol but must',
    '**never contradict or weaken** its protected invariants (e.g. reporter-owns',
    'closure, the identity↔attribution guarantee, the no-self-merge / LGTM gate).',
    'See `design/project-tier-rules.md` for the full precedence model.',
    '',
    '## Format to follow (replace this example)',
    '',
    'A project rule is a Markdown file. Name it `*.md` (this `.example` is a',
    'template, not a rule). Suggested shape — adapt to your deployment:',
    '',
    '```markdown',
    '# <Short rule title>',
    '',
    '## Applies to',
    '',
    '<Which agents / repos / situations this project rule governs.>',
    '',
    '## Rule',
    '',
    '<The specialization. State what it ADDS to the universal protocol — never',
    'what it weakens. If it looks like it relaxes a universal invariant, it is',
    'wrong by construction (DR-026 §4).>',
    '',
    '## Rationale',
    '',
    '<Why this deployment needs it. Link the incident / pattern it codifies.>',
    '```',
    '',
  ].join('\n');
}

/**
 * Seed the project-rules subdir with the generic `.example` template
 * (`macf init`). Creates `.claude/rules/project/` (mkdir -p) and writes the
 * `.example` file. Idempotent: overwrites the `.example` with the current
 * canonical template — it's a managed example, not operator state. Returns the
 * seeded basename.
 *
 * Deliberately does NOT fetch from `MACF_PROJECT_RULES_SOURCE` — `macf init`
 * only lays down the tier + its self-documenting seed; `macf update` (and
 * `macf rules refresh`) pull the actual rules from the source. This keeps init
 * generic (it ships to every deployment) and offline-safe.
 */
export function seedProjectRulesDir(workspaceDir: string): string {
  const destDir = workspaceProjectRulesDir(workspaceDir);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, PROJECT_RULE_SEED_NAME), projectRuleSeedContent());
  return PROJECT_RULE_SEED_NAME;
}
