import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Stale-issue-citation sweep (groundnuty/macf#1299).
 *
 * `#1289`'s reporter-side stall sweep (`reporter-stall.ts`) surfaces
 * QUIET issues — but quietness is the wrong signal for the shape this
 * module catches. An issue fixed by a STRANGER's PR is never quiet from
 * the reporter's perspective (they never touched it again because they
 * never knew); a sweep keyed on `updatedAt` age cannot see it. The
 * motivating instance (`#793`) quoted `check-channel-alive.sh`'s log-
 * resolution code verbatim and sat six weeks after an unrelated PR
 * changed that exact code out from under it — no self-filed-stall sweep,
 * no auto-close, nothing surfaced the drift. **The signal lives in the
 * divergence between the issue TEXT and the TREE**, which no queue-shaped
 * check reads.
 *
 * SCOPING (load-bearing — see the issue thread's "where your precedent
 * does not carry"): `check-dr-citations.sh` (macf#998) works cheaply
 * because a DR citation is STRUCTURED — a `(file, exact-test-name)` pair
 * that either resolves or doesn't. An issue's quoted code fence is
 * unstructured prose; "does this string exist anywhere in the tree" is a
 * far weaker predicate that fires on every rename/reformat/refactor
 * (`#1099`'s always-fires shape). This module narrows to the structured
 * SUBSET: a fence is only a candidate when the prose immediately above it
 * names a file (bare filename like `` `check-channel-alive.sh` `` counts
 * — `#793` used exactly that form — or a full repo-relative path). A
 * fence with no nameable path anywhere in its immediate context is OUT OF
 * SCOPE, not flagged, not reported as unknown — silently skipped. This is
 * the difference between "grep the whole tree" (noisy) and "check this
 * one path" (the same predicate `check-dr-citations.sh` already runs
 * successfully).
 *
 * VERDICTS — three, deliberately distinct (conflating them is exactly how
 * the issue warns the noise starts):
 *   - `stale`   — the named path EXISTS, but the quoted code (whitespace-
 *                 normalized) is no longer a substring of it. The
 *                 reportable candidate.
 *   - `unknown` — the named path could not be resolved to any file in the
 *                 tree at all (moved/renamed/deleted, or a basename that
 *                 no longer exists anywhere). A moved file is a DIFFERENT
 *                 fact from a changed line; reporting both as "stale"
 *                 would blur exactly the distinction the issue asks for.
 *   - (silent)  — the quoted code still matches (mod whitespace), OR the
 *                 fence had no nameable path, OR the basename resolved to
 *                 more than one file (ambiguous — see `resolveCitationPath`
 *                 doc for why ambiguity degrades to silence, not a guess).
 *
 * REFORMAT-INSENSITIVITY: `bodyContainsNormalizedSequence` trims each
 * line, collapses internal whitespace runs to one space, and drops blank
 * lines before comparing — a contiguous SUBSEQUENCE match survives
 * indentation changes, tab/space conversion, trailing whitespace, and
 * blank-line insertion/removal. It does NOT survive a genuine content
 * change (which is exactly the point) or a line-reordering refactor
 * (deliberately not attempted — a fuzzy diff here would trade the "no
 * false positive on reformatting" requirement for a "no false NEGATIVE on
 * a real edit" regression the issue never asked for).
 *
 * CAP DISCLOSURE: `stale`/`unknown` are each truncated to `limit`
 * independently; `totalStale`/`totalUnknown` carry the pre-cap counts so
 * `formatStaleCitationReport` can say "N of M" rather than rendering a
 * capped list that looks identical to a complete one (`#1289`/`#1170`
 * precedent — a truncated list presented as complete is its own defect).
 *
 * This module NEVER closes or comments on anything it finds — it is a
 * read-only report generator. The reporter still owns closure (see
 * `coordination.md §Issue Lifecycle 1`); "the code you quoted has
 * changed" is a signal, not a verdict.
 */

export interface StaleCitationCandidate {
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  /** Repo-relative POSIX path the citation resolved to. */
  readonly path: string;
  readonly verdict: 'stale';
  /** First non-blank line of the quoted snippet, truncated — enough to
   * recognize the citation in a report line without dumping the fence. */
  readonly snippet: string;
}

export interface UnknownCitation {
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  /** The raw token exactly as it appeared near the fence — there is no
   * resolved repo-relative path to show, by definition of this verdict. */
  readonly rawToken: string;
  readonly verdict: 'unknown';
}

export interface StaleCitationResult {
  readonly stale: readonly StaleCitationCandidate[];
  readonly unknown: readonly UnknownCitation[];
  /** Pre-cap count of `stale` candidates found, before `limit` truncated
   * the list — see module doc "CAP DISCLOSURE". */
  readonly totalStale: number;
  /** Pre-cap count of `unknown` candidates found. */
  readonly totalUnknown: number;
  readonly issuesScanned: number;
}

export interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
}

interface RawCitation {
  readonly rawToken: string;
  readonly codeLines: readonly string[];
}

/**
 * Default cap on REPORTED candidates per verdict bucket, independent of
 * how many are actually found. Mirrors `DEFAULT_REPORTER_STALL_LIMIT`'s
 * reasoning (`reporter-stall.ts`) — bound session-to-session noise rather
 * than widen a threshold, which just moves the same wall of text
 * elsewhere.
 */
export const DEFAULT_STALE_CITATION_LIMIT = 10;

/**
 * Default cap on how many open issues a single sweep fetches. `gh issue
 * list` defaults to 30 with no `--limit`; this sweep needs the FULL open
 * set (a stale citation can be sitting on issue #1 as easily as #1300), so
 * the default is generous rather than silently truncating the input to
 * the scan.
 */
export const DEFAULT_ISSUE_FETCH_LIMIT = 500;

const FENCE_RE = /^\s*```/;

/** How many non-blank lines immediately above a fence to search for a
 * path mention, before giving up on the fence entirely (out of scope). */
const MAX_CONTEXT_LINES = 5;

/**
 * A path-like token: a recognizable code/doc file extension, optionally
 * preceded by directory components. Deliberately requires an extension
 * (excludes bare extension-less tokens — too noisy) but does NOT require a
 * `/` — `#793`'s own citation named a bare `` `check-channel-alive.sh` ``
 * with no directory, and the issue explicitly counts that as "a named
 * file path".
 */
const PATH_TOKEN_RE =
  /`?((?:[\w.-]+\/)*[\w-]+\.(?:sh|bash|zsh|ts|tsx|js|mjs|cjs|jsx|py|rb|go|rs|java|kt|md|json|ya?ml|toml|sql|c|cc|cpp|h|hpp|css|html))`?/;

/**
 * Walk `body` for fenced code blocks and, for each one, the nearest
 * path-like token in the non-blank lines immediately above it. A fence
 * with no such token anywhere in its immediate context, or with only
 * blank content, is dropped (out of scope) — never surfaced as a weaker
 * "unknown" verdict, which would misrepresent "we found no path to check"
 * as "we found a path and it's gone".
 */
export function extractCitations(body: string): readonly RawCitation[] {
  const lines = body.split(/\r?\n/);
  const citations: RawCitation[] = [];
  let i = 0;
  while (i < lines.length) {
    if (FENCE_RE.test(lines[i]!)) {
      const fenceStart = i;
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j]!)) {
        codeLines.push(lines[j]!);
        j += 1;
      }
      if (j >= lines.length) {
        // Unterminated fence (malformed markdown) — nothing reliable to
        // extract; stop scanning rather than guess at a close.
        break;
      }
      const rawToken = findNearestPathToken(lines, fenceStart);
      if (rawToken && codeLines.some((l) => l.trim().length > 0)) {
        citations.push({ rawToken, codeLines });
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return citations;
}

function findNearestPathToken(lines: readonly string[], fenceStart: number): string | undefined {
  let checked = 0;
  for (let k = fenceStart - 1; k >= 0 && checked < MAX_CONTEXT_LINES; k -= 1) {
    const line = lines[k]!;
    if (line.trim().length === 0) {
      // Stop at the first blank line above the fence — the path mention
      // must be in the same paragraph, not several paragraphs earlier in
      // an unrelated section of the body.
      break;
    }
    checked += 1;
    const m = PATH_TOKEN_RE.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function normalizeLines(lines: readonly string[]): readonly string[] {
  return lines.map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.length > 0);
}

/**
 * True when `codeLines` (whitespace-normalized, blank lines dropped)
 * appears as a contiguous subsequence of `fileContent`'s lines (same
 * normalization). Reformat-insensitive by construction — see module doc.
 * An empty needle (a fence with only blank lines, which `extractCitations`
 * already drops) trivially "matches" rather than ever being reported
 * stale.
 */
export function bodyContainsNormalizedSequence(
  fileContent: string,
  codeLines: readonly string[],
): boolean {
  const needle = normalizeLines(codeLines);
  if (needle.length === 0) return true;
  const haystack = normalizeLines(fileContent.split(/\r?\n/));
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let matchesHere = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matchesHere = false;
        break;
      }
    }
    if (matchesHere) return true;
  }
  return false;
}

export interface TreeAccess {
  readonly fileExists: (relPath: string) => boolean;
  readonly readFile: (relPath: string) => string;
  /** Every file in the tree whose basename matches `basename`, as
   * repo-relative POSIX paths. Called only when the literal token doesn't
   * exist as a path (bare-filename mentions, or a path that has moved). */
  readonly findByBasename: (basename: string) => readonly string[];
}

export type CitationResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous' };

/**
 * Resolve a raw citation token to a single repo-relative path.
 *
 * Exact match first (handles full paths, e.g. the Dependencies-section
 * style `packages/macf/plugin/scripts/check-channel-alive.sh`). Falling
 * back to a basename search handles the bare-filename-mention style
 * (`#793`'s actual citation) — but ONLY when it resolves UNIQUELY.
 *
 * Zero matches -> `unknown` ("the path itself is gone" per the issue's
 * own required behaviour). More than one match -> `ambiguous`: this
 * module deliberately does NOT guess which of several same-named files
 * was meant — a wrong guess risks exactly the false-positive/false-
 * "unknown" noise the issue warns against, and an ambiguous basename is
 * rare enough (checked against this repo's own tree) that silently
 * skipping it costs little recall for a real reliability win.
 */
export function resolveCitationPath(rawToken: string, tree: TreeAccess): CitationResolution {
  const normalized = rawToken.replace(/^\.\//, '');
  if (tree.fileExists(normalized)) {
    return { kind: 'resolved', path: normalized };
  }
  const basename = normalized.split('/').pop() ?? normalized;
  const matches = tree.findByBasename(basename);
  if (matches.length === 1) return { kind: 'resolved', path: matches[0]! };
  if (matches.length === 0) return { kind: 'unknown' };
  return { kind: 'ambiguous' };
}

const DEFAULT_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.macf', 'coverage', '.worktrees']);

function walkFiles(root: string): readonly string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

/**
 * Real-filesystem `TreeAccess`, rooted at `treeRoot`. The basename index is
 * built lazily and only once per instance (one sweep run), not once per
 * citation — a repo-sized `readdirSync` walk is fine to pay once, not N
 * times across however many fences the open-issue set contains.
 */
export function createDefaultTreeAccess(treeRoot: string): TreeAccess {
  let indexed: readonly string[] | undefined;
  const index = (): readonly string[] => {
    indexed ??= walkFiles(treeRoot);
    return indexed;
  };
  return {
    fileExists: (relPath) => existsSync(join(treeRoot, relPath)),
    readFile: (relPath) => readFileSync(join(treeRoot, relPath), 'utf-8'),
    findByBasename: (basename) =>
      index()
        .filter((p) => p.endsWith(sep + basename) || p === join(treeRoot, basename))
        .map((p) => relative(treeRoot, p).split(sep).join('/')),
  };
}

async function defaultListOpenIssues(
  repo: string,
  token: string,
  issueLimit: number,
): Promise<readonly RawIssue[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--json', 'number,title,body,url',
    '--limit', String(issueLimit),
  ], {
    encoding: 'utf-8',
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as readonly RawIssue[];
}

function firstNonBlankLine(lines: readonly string[]): string {
  const line = lines.find((l) => l.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/**
 * Run the sweep: fetch every open issue in `config.repo`, extract citations
 * carrying a named file path, resolve each against `config.tree` (default:
 * the real filesystem at `process.cwd()`), and report `stale` /  `unknown`
 * candidates. Never mutates anything on GitHub — read-only by construction
 * (no `gh issue close` / `gh issue comment` call exists in this module).
 */
export async function checkStaleIssueCitations(config: {
  readonly repo: string;
  readonly token: string;
  readonly limit?: number;
  readonly issueLimit?: number;
  /** Override for tests; defaults to a real-filesystem walk of `process.cwd()`. */
  readonly tree?: TreeAccess;
  /** Override for tests; defaults to `gh issue list --state open`. */
  readonly listOpenIssues?: (
    repo: string,
    token: string,
    issueLimit: number,
  ) => Promise<readonly RawIssue[]>;
}): Promise<StaleCitationResult> {
  const limit = config.limit ?? DEFAULT_STALE_CITATION_LIMIT;
  const issueLimit = config.issueLimit ?? DEFAULT_ISSUE_FETCH_LIMIT;
  const tree = config.tree ?? createDefaultTreeAccess(process.cwd());
  const listOpenIssues = config.listOpenIssues ?? defaultListOpenIssues;

  const issues = await listOpenIssues(config.repo, config.token, issueLimit);

  const stale: StaleCitationCandidate[] = [];
  const unknown: UnknownCitation[] = [];

  for (const issue of issues) {
    const citations = extractCitations(issue.body ?? '');
    const resolvedPathsSeen = new Set<string>();

    for (const citation of citations) {
      const resolution = resolveCitationPath(citation.rawToken, tree);

      if (resolution.kind === 'ambiguous') {
        // See resolveCitationPath doc — deliberately silent, not a guess.
        continue;
      }

      if (resolution.kind === 'unknown') {
        unknown.push({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          rawToken: citation.rawToken,
          verdict: 'unknown',
        });
        continue;
      }

      // Dedupe: multiple fences in one issue resolving to the same file
      // should surface once, not once per fence.
      if (resolvedPathsSeen.has(resolution.path)) continue;

      let content: string;
      try {
        content = tree.readFile(resolution.path);
      } catch {
        // Resolved a moment ago but unreadable now (race / permissions) —
        // degrade to unknown rather than assert a false "stale".
        unknown.push({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          rawToken: citation.rawToken,
          verdict: 'unknown',
        });
        continue;
      }

      if (!bodyContainsNormalizedSequence(content, citation.codeLines)) {
        resolvedPathsSeen.add(resolution.path);
        stale.push({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          path: resolution.path,
          verdict: 'stale',
          snippet: firstNonBlankLine(citation.codeLines),
        });
      }
    }
  }

  return {
    stale: stale.slice(0, limit),
    unknown: unknown.slice(0, limit),
    totalStale: stale.length,
    totalUnknown: unknown.length,
    issuesScanned: issues.length,
  };
}

/**
 * Render `checkStaleIssueCitations`'s result as a plain-text report.
 * Discloses the cap whenever it actually truncated a list (see module doc
 * "CAP DISCLOSURE") and closes with the reporter-owns-closure reminder —
 * this module never asserts a candidate should be closed.
 */
export function formatStaleCitationReport(result: StaleCitationResult): string {
  const lines: string[] = [`Scanned ${result.issuesScanned} open issue(s) for stale code citations.`];

  if (result.stale.length === 0 && result.unknown.length === 0) {
    lines.push('No stale-citation candidates found.');
    return lines.join('\n');
  }

  if (result.stale.length > 0) {
    const capNote =
      result.totalStale > result.stale.length
        ? ` (showing ${result.stale.length} of ${result.totalStale})`
        : '';
    lines.push(`Stale-citation candidates${capNote}:`);
    for (const c of result.stale) {
      const urlSuffix = c.url ? ` (${c.url})` : '';
      lines.push(`  #${c.number} ${c.title} — ${c.path}: "${c.snippet}"${urlSuffix}`);
    }
  }

  if (result.unknown.length > 0) {
    const capNote =
      result.totalUnknown > result.unknown.length
        ? ` (showing ${result.unknown.length} of ${result.totalUnknown})`
        : '';
    lines.push(`Unknown-path citations${capNote}:`);
    for (const c of result.unknown) {
      const urlSuffix = c.url ? ` (${c.url})` : '';
      lines.push(`  #${c.number} ${c.title} — path not found: ${c.rawToken}${urlSuffix}`);
    }
  }

  lines.push('These are candidates only — the reporter still owns closure; verify before acting.');
  return lines.join('\n');
}

// --- Standalone CLI entry (groundnuty/macf#1299) ---
//
// Deliberately NOT wired into macf-plugin-cli.ts / format.ts — this module
// is a self-contained script-equivalent (per the issue's own "a new script
// ... or the plugin lib if that fits better"), runnable directly once
// built:
//
//   GH_TOKEN=<token> node dist/plugin/lib/stale-issue-citations.js \
//     --repo owner/repo [--limit N] [--issue-limit N] [--tree PATH]
//
// Wiring this into the `macf issues` skill surface (macf-plugin-cli.ts +
// format.ts's combined-report renderer) is a natural follow-up, left for a
// separate PR to avoid colliding with concurrent work on those shared
// files.

function parseFlag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = parseFlag(args, 'repo');
  if (!repo) {
    process.stderr.write(
      'Usage: stale-issue-citations.js --repo <owner/repo> [--limit N] [--issue-limit N] [--tree PATH]\n',
    );
    process.exitCode = 1;
    return;
  }
  const token = process.env['GH_TOKEN'] ?? '';
  if (!token) {
    process.stderr.write('FATAL: GH_TOKEN is not set.\n');
    process.exitCode = 1;
    return;
  }
  const limitFlag = parseFlag(args, 'limit');
  const issueLimitFlag = parseFlag(args, 'issue-limit');
  const treeRoot = parseFlag(args, 'tree') ?? process.cwd();

  try {
    const result = await checkStaleIssueCitations({
      repo,
      token,
      ...(limitFlag ? { limit: Number(limitFlag) } : {}),
      ...(issueLimitFlag ? { issueLimit: Number(issueLimitFlag) } : {}),
      tree: createDefaultTreeAccess(treeRoot),
    });
    process.stdout.write(`${formatStaleCitationReport(result)}\n`);
  } catch (err) {
    process.stderr.write(
      `FATAL: stale-issue-citations sweep failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
