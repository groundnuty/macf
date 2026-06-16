/**
 * Protected-invariant loader + subordination-check heuristics for the auditor
 * Plan membrane (groundnuty/macf#503, DR-026 G1).
 *
 * Loads `design/protected-invariants.md` (the ratified SECP guardrail core) and
 * surfaces, for a given candidate's text, WHICH invariant(s) it plausibly
 * touches and whether the text *reads like* a relaxation of one.
 *
 * CRITICAL — this module SURFACES; it never decides. `protected-invariants.md`
 * carries an amendment clause: the auditor may *propose* an operator-ratified
 * amendment to an invariant, so auto-dropping a candidate that touches one would
 * foreclose that constitutional path. We therefore mark — never reject. The
 * weaken-vs-amend call is the operator's (v1-manual) and, later, G3's.
 *
 * The match is a deliberately simple keyword/heuristic pass on the invariant
 * titles + a small curated keyword set per invariant. It is intentionally
 * generous (favours surfacing a touch over missing one): a false-positive
 * "touches invariant N" is cheap (operator eyeballs it), a false-negative is the
 * dangerous direction.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** One protected invariant, parsed from the ratified design doc. */
export interface ProtectedInvariant {
  /** 1-based ordinal as it appears in the doc. */
  readonly index: number;
  /** Short bold title (the text before the first period of the list item). */
  readonly title: string;
  /** The full list-item line (title + gloss + refs). */
  readonly text: string;
  /** Lowercased keyword tokens used for the heuristic touch-match. */
  readonly keywords: readonly string[];
}

/** A surfaced touchpoint: which invariant a candidate plausibly touches. */
export interface InvariantTouch {
  readonly index: number;
  readonly title: string;
  /** Tokens that matched (for operator transparency). */
  readonly matchedKeywords: readonly string[];
}

/**
 * Per-invariant curated keyword sets. Keyed by the 1-based ordinal in
 * `protected-invariants.md`. These augment the auto-extracted title words so the
 * touch-match catches paraphrases the title alone would miss (e.g. "merge"
 * mapping to the LGTM-gate invariant). Lowercase, matched as word-ish substrings.
 */
const CURATED_KEYWORDS: Readonly<Record<number, readonly string[]>> = {
  1: ['reporter', 'closure', 'close', 'owns', 'verify', 'verification'],
  2: ['identity', 'attribution', 'attributed', 'bot', 'token', 'impersonat'],
  3: ['merge', 'self-merge', 'lgtm', 'approve', 'approved', 'review', 'non-author'],
  4: ['routing', 'route', 'mention', '@mention', 'recipient', 'false-route'],
  5: ['auto-close', 'closes', 'fixes', 'resolves', 'refs', 'keyword'],
  6: ['fail-loud', 'silent', 'fallback', 'result-invariant', 'exit code', 'assert'],
  7: ['pr', 'pull request', 'artifact', 'rollback', 'review', 'ci'],
  8: ['auditor', 'never-acts', 'propose', 'proposes', 'merge', 'close', 'implement', 'act'],
  9: ['operator', 'ratifier', 'ratify', 'ratification', 'auto-applied', 'constitutional', 'human'],
  10: ['universal', 'locally', 'local', 'mutable', 'patch', 'upstream', 'product rule'],
};

/** Words too generic to be a meaningful touch-signal on their own. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'not', 'never', 'over', 'must', 'any',
  'every', 'that', 'this', 'its', 'are', 'all', 'who', 'how', 'a', 'an',
  'is', 'to', 'of', 'or', 'on', 'by', 'be', 'it', 'as', 'no',
]);

/** Phrases in candidate text that read like a *relaxation* of a guarantee. */
const RELAXATION_HINT =
  /\b(?:relax|weaken|loosen|drop|remove|skip|bypass|disable|waive|exempt|optional(?:ly)?|allow(?:ed|s)?\s+(?:self|auto|without)|no\s+longer\s+(?:require|need)|without\s+(?:a\s+)?(?:review|approval|mention|token)|self-merge|auto-merge|auto-close)\b/i;

/**
 * Parse the invariant list out of `protected-invariants.md`.
 *
 * The doc's invariants are an ordered Markdown list, each item shaped like:
 *   `1. **Reporter-owns-closure accountability.** The agent who ... (refs)`
 * We extract the bold title, the full line, and a keyword set (title words minus
 * stopwords, plus the curated set for that ordinal).
 */
export function parseInvariants(markdown: string): readonly ProtectedInvariant[] {
  const out: ProtectedInvariant[] = [];
  // Only parse list items under the "## The invariants" section, so the
  // "## Amending this set" numbered list (1./2./3.) is not mistaken for invariants.
  const section = sliceInvariantSection(markdown);
  const itemRe = /^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/;
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    const m = itemRe.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    const title = (m[2] ?? '').replace(/\.$/, '').trim();
    const text = line;
    const titleTokens = tokenize(title);
    const curated = CURATED_KEYWORDS[index] ?? [];
    const keywords = [...new Set([...titleTokens, ...curated.map((k) => k.toLowerCase())])];
    out.push({ index, title, text, keywords });
  }
  return out;
}

/**
 * Slice the markdown to the "## The invariants" section only (up to the next
 * `## ` heading). Falls back to the whole doc if the heading isn't found.
 */
function sliceInvariantSection(markdown: string): string {
  const lines = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+The invariants\s*$/i.test(lines[i]!.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return markdown;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Load the protected-invariant set from the repo's `design/protected-invariants.md`.
 *
 * `repoRoot` is the framework-source repo root (where `design/` lives). Returns
 * `[]` (never throws) when the file is absent — the membrane still runs and the
 * subordination-check simply surfaces nothing (loud-but-proceeds). A missing
 * invariant file is surfaced separately by the caller.
 */
export function loadInvariants(repoRoot: string): readonly ProtectedInvariant[] {
  const path = join(repoRoot, 'design', 'protected-invariants.md');
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return parseInvariants(raw);
}

/**
 * For a candidate's combined text, return which invariants it plausibly touches.
 *
 * A touch is recorded when ANY of the invariant's keywords appears (as a
 * substring) in the candidate text. Generous by design (see module header).
 */
export function invariantsTouched(
  candidateText: string,
  invariants: readonly ProtectedInvariant[],
): readonly InvariantTouch[] {
  const hay = candidateText.toLowerCase();
  const touches: InvariantTouch[] = [];
  for (const inv of invariants) {
    const matched = inv.keywords.filter((k) => hay.includes(k));
    if (matched.length > 0) {
      touches.push({ index: inv.index, title: inv.title, matchedKeywords: matched });
    }
  }
  return touches;
}

/**
 * Whether the candidate text reads like it RELAXES a guarantee. Heuristic only —
 * a `true` here means "flag HIGH-RISK for operator scrutiny", NOT "drop".
 */
export function readsAsRelaxation(candidateText: string): boolean {
  return RELAXATION_HINT.test(candidateText);
}
