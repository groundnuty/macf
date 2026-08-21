/**
 * Structural guard: user-facing CLI output must not cite internal issue
 * trackers or design records (macf#1061).
 *
 * The operator's ruling (macf#1061): a message the end user reads —
 * `console.log`/`console.error`/`console.warn` text, a thrown `Error`
 * message, a plan/report string, a `--help` description — must stand on
 * its own. `(DR-043 Amendment L2.4)` or `(macf#907)` means nothing to
 * someone who was never in the room; a citation there is an internal
 * artifact leaking out of the tool, not an explanation. Code COMMENTS are
 * the opposite: they are for maintainers, and the DR-citation convention
 * (macf#998) depends on them staying intact.
 *
 * This test is the structural backstop for that split. Without it, the
 * next PR re-introduces a `(macf#NNNN)` in a `console.log` call and nobody
 * notices until an operator reads it — the exact failure mode #1061 filed
 * against. A test asserting "the current tree has zero violations" is
 * useless on its own (it would pass identically if the checker itself were
 * broken) — see `assert-the-wrong-path.md`. The decisive test below proves
 * the checker actually fires on a deliberately-bad synthetic line before
 * trusting its clean verdict on the real tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One line in production source that reads like an internal citation leaking into user-facing text. */
export interface CitationViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Matches the internal-reference shapes #1061 is about: a bare GitHub issue
 * number in this repo or a sibling one, or a design-decision-record label.
 * Deliberately narrower than "any `#123`" — a bare issue number with no
 * `macf`/`DR-` framing is common as legitimate DATA (e.g. an issue number
 * the tool discovered and is reporting, not a citation the author left).
 */
const CITATION_PATTERN = /\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b|\bmacf-actions#\d+\b|\bDR-0\d{2}\b|\bAmendment [A-Z0-9]\b/;

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/**
 * A string literal whose ENTIRE value is just the citation token (no
 * surrounding prose) — e.g. `ref: 'macf#1045',` inside an object that
 * feeds a `--json` payload. That's a machine-consumed correlation field, not
 * a sentence a human reads; distinct from the same token woven into a
 * message string (`` `... (macf#1045).` ``), which IS prose a human reads.
 */
const BARE_CITATION_TOKEN =
  /^[\w.]*:\s*['"`](macf#\d+|groundnuty\/macf#\d+|macf-actions#\d+|DR-0\d{2}(\s+§[^\s'"`]*)?(\s+Amendment\s+[A-Z0-9]+)?)['"`]\s*[,;]?$/;

/**
 * A string literal that is itself a `#`-prefixed comment line — the
 * convention this codebase uses to assemble generated shell/config files
 * (`claude.sh`, `.claude/.macf/env.*`, generated GitHub Actions YAML) line
 * by line as TS string arrays. Once written to disk, this text IS a
 * comment in that generated file — read by whoever inspects the launcher
 * or workflow source, the same audience as a `//` comment here — never
 * printed as a live CLI message. Only trips when the token+hash pair is at
 * the START of the string literal (a mid-string `#` inside real prose,
 * e.g. an md5-ish anchor, must not be swallowed by this exemption).
 */
function isEmbeddedGeneratedFileComment(line: string): boolean {
  const match = /['"`]\s*#/.exec(line);
  if (!match) return false;
  const prefix = line.slice(0, match.index);
  // Array-literal item (`[`/`,` immediately precedes the string, or the
  // string is alone on its line with only a `+` concatenation before it) or
  // a plain `const`/`export const` assignment. Deliberately does NOT match
  // a function-call open-paren (`console.log(`, `echo(` inside a template) —
  // that's a real call whose argument happens to start with `#`, not a
  // generated-file-content array item, and must stay in scope.
  return (
    /^\s*(export\s+)?(return\s+)?(const\s+)?[\w.]*\s*=?\s*['"`]?\s*\+?\s*$/.test(prefix) ||
    /[[,]\s*$/.test(prefix)
  );
}

/**
 * Scans TypeScript source for citation-shaped text outside comments.
 * Stateful over one construct: a `'<!--' ... '-->'` string-array pair,
 * this codebase's convention for embedding an HTML/Markdown comment block
 * into a generated `.md` file (e.g. the project-tier-rules managed-file
 * header) — same "read by whoever inspects the generated file" audience
 * as the `#`-comment convention above, just a different comment syntax.
 */
export function scanSourceForCitations(source: string, fileLabel: string): CitationViolation[] {
  const violations: CitationViolation[] = [];
  const lines = source.split('\n');
  let inHtmlCommentBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (/^['"`]<!--['"`],?$/.test(trimmed)) {
      inHtmlCommentBlock = true;
      continue;
    }
    if (/-->['"`],?$/.test(trimmed)) {
      inHtmlCommentBlock = false;
      continue;
    }
    if (inHtmlCommentBlock) continue;

    if (!CITATION_PATTERN.test(line)) continue;
    if (isCommentLine(trimmed)) continue;
    if (BARE_CITATION_TOKEN.test(trimmed)) continue;
    if (isEmbeddedGeneratedFileComment(line)) continue;

    violations.push({ file: fileLabel, line: i + 1, text: trimmed });
  }

  return violations;
}

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const cliSrcDir = fileURLToPath(new URL('../../src/cli', import.meta.url));

describe('no internal citations in user-facing CLI output (macf#1061 structural guard)', () => {
  // --- Decisive: prove the checker actually fires -------------------------
  // Per assert-the-wrong-path.md: a check that only ever reports "clean" is
  // indistinguishable from a broken check. This must fail loudly on a
  // deliberately bad line before the "the real tree is clean" assertion
  // below means anything.
  it('FIRES on a deliberately-introduced citation in a user-facing string', () => {
    const bad = [
      "  console.log('Refusing to run before the consent gate opens (DR-043 Amendment L2.4, macf#1045).');",
    ].join('\n');
    const violations = scanSourceForCitations(bad, 'synthetic-bad.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toContain('DR-043 Amendment L2.4');
  });

  it('also fires on the bare `macf#N` / `groundnuty/macf#N` / `Amendment X` shapes', () => {
    const bad = [
      "console.error('see groundnuty/macf#999 for background.');",
      "console.warn('blocked pending Amendment G ratification.');",
    ].join('\n');
    const violations = scanSourceForCitations(bad, 'synthetic-bad-2.ts');
    expect(violations).toHaveLength(2);
  });

  // --- False-positive guard: comments are NEVER flagged -------------------
  // The most likely way this guard becomes unusable: it starts blocking the
  // exact DR-citation convention (macf#998) that code comments are SUPPOSED
  // to carry. Assert explicitly, not just "the real tree passes" (which
  // would stay green even if comments silently stopped being scanned AND
  // started being flagged, as long as no one ran the file locally).
  it('does NOT fire on a `//` comment carrying the same citation', () => {
    const ok = "  // Refusing to run before the consent gate opens (DR-043 Amendment L2.4, macf#1045).";
    expect(scanSourceForCitations(ok, 'synthetic-comment.ts')).toHaveLength(0);
  });

  it('does NOT fire on a `/** */` JSDoc block carrying the same citation', () => {
    const ok = [
      '/**',
      ' * Refusing to run before the consent gate opens (DR-043 Amendment L2.4, macf#1045).',
      ' */',
    ].join('\n');
    expect(scanSourceForCitations(ok, 'synthetic-jsdoc.ts')).toHaveLength(0);
  });

  it('does NOT fire on a generated-file `#`-comment string (e.g. baked into claude.sh)', () => {
    const ok = "    '# Launch-boundary GH_TOKEN validation (macf#821) — local-registry mode.',";
    expect(scanSourceForCitations(ok, 'synthetic-generated-comment.ts')).toHaveLength(0);
  });

  it('does NOT fire on a `const`/`export const` marker constant that happens to be a `#`-comment', () => {
    // fleet-install-cron.ts's WATCHDOG_MARKER shape: a real crontab comment
    // line, also echoed back verbatim in the install-preview print — not a
    // distinct human-authored explanation string.
    const ok = "export const WATCHDOG_MARKER = '# macf-watchdog (DR-006)';";
    expect(scanSourceForCitations(ok, 'synthetic-marker-const.ts')).toHaveLength(0);
  });

  it('DOES fire on a real console.log call whose argument merely starts with "#" (not a generated-file comment)', () => {
    // The `[`/`,`/`=` prefix check must not be fooled by a function call's
    // open-paren — `console.log('#...)` is live terminal output, not a
    // generated-file array item, even though the string starts with '#'.
    const bad = "console.log('#1061 was fixed by macf#1062, see DR-044 for the ruling');";
    const violations = scanSourceForCitations(bad, 'synthetic-console-log-hash.ts');
    expect(violations).toHaveLength(1);
  });

  it('does NOT fire on an HTML-comment-block string array (e.g. a managed-file header)', () => {
    const ok = [
      "  '<!--',",
      "  '  PROJECT-TIER RULE (DR-026 §3 tier 2). Distributed by `macf` from this',",
      "  '-->',",
    ].join('\n');
    expect(scanSourceForCitations(ok, 'synthetic-html-comment.ts')).toHaveLength(0);
  });

  // --- False-positive guard: --json-only machine fields are NEVER flagged -
  it('does NOT fire on a bare citation token in a --json-only field (machine-consumed, inert to a human)', () => {
    const ok = "      citation_ref: 'macf#1045',";
    expect(scanSourceForCitations(ok, 'synthetic-json-field.ts')).toHaveLength(0);
  });

  it('DOES fire when that same token is woven into human-readable prose', () => {
    // The distinguishing feature is prose vs. bare token — not the field
    // name. A `reason`/`detail`/`citation` field IS in scope the moment its
    // value is a sentence, because that sentence is what gets rendered to
    // the operator (this repo's `doctor.ts` `citation` field is exactly
    // this shape — printed verbatim via `console.log`).
    const bad = "      citation: 'macf#491 — attribution-trap result-invariant backstop',";
    const violations = scanSourceForCitations(bad, 'synthetic-json-prose.ts');
    expect(violations).toHaveLength(1);
  });

  // --- The real guard: the actual CLI source tree is clean -----------------
  it('the real packages/macf/src/cli tree carries no internal citations outside comments', () => {
    const files = listTsFilesRecursive(cliSrcDir);
    expect(files.length).toBeGreaterThan(50); // sanity: the walker found the tree, not an empty dir

    const allViolations: CitationViolation[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const rel = relative(cliSrcDir, file);
      allViolations.push(...scanSourceForCitations(source, rel));
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${String(allViolations.length)} internal citation(s) in user-facing CLI output ` +
          `(macf#1061 — explain, don't cite):\n${report}`,
      );
    }
    expect(allViolations).toEqual([]);
  });
});
