/**
 * Structural guard: silent-fallback-hazards.md's self-referential instance
 * counts must derive from the actual `### Instance N` headings (macf#937).
 *
 * The rule catalog stated its own instance count in prose by hand, in
 * several places, and the copies disagreed with each other AND with the
 * headings (the file's own thesis — an unchecked assertion silently drifts
 * from reality — applied to the file's own contents). Concretely, on the
 * commit this test lands against: the intro paragraph said "Twenty active
 * instances" (correct — 21 `### Instance N` headings, 1 retired), but the
 * very same sentence then said "Seventeen of eighteen active instances have
 * structural defenses" (an active-instance total of 18, not 20), the
 * "Defense-pattern emergence" header said "19-of-20", the summary prose said
 * "Nineteen of twenty", and a Pattern-A instance-count fragment said
 * "(10 of 18)" two sentences after asserting the active total was 19 — three
 * mutually disagreeing "N of M" claims plus one internally-inconsistent one,
 * in a single file.
 *
 * Two different fixes for two different kinds of claim:
 *
 *  - The ACTIVE-INSTANCE TOTAL and the NEXT-INSTANCE-NUMBER are mechanically
 *    derivable from the `### Instance N` headings alone (count them, subtract
 *    the ones marked retired, take the max + 1). This test derives both and
 *    asserts the prose matches — a forgotten bump now fails CI instead of
 *    shipping silently wrong.
 *
 *  - The "N of M active instances have structural defense" RATIO is not
 *    mechanically derivable without hardcoding, in this test, a per-instance
 *    judgment call about whether each one's defense is "applied" — which
 *    would just be a second hand-maintained copy of the same driftable fact
 *    (the disease this issue is about). That ratio was dropped from prose in
 *    favor of wording that cannot go stale ("most active instances..."); the
 *    regression test below pins that it doesn't creep back in as a fraction.
 *
 * Per `assert-the-wrong-path.md`: an assertion that merely reads the current
 * (already-correct) prose and reports "matches" would pass identically
 * whether it derives from the headings or is silently hardcoded. The decisive
 * proof is corrupting the HEADINGS (appending a fake `### Instance 22`) and
 * showing both the active-count and next-number assertions fail together —
 * see the PR/commit description for the corrupt-then-restore transcript.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rulesPath = join(repoRoot, 'plugin', 'rules', 'silent-fallback-hazards.md');

function body(): string {
  return readFileSync(rulesPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// number -> English word (the file's own prose style: "Twenty", "Nineteen",
// and — once the catalog grows past 20 — the compound form "Twenty-one").
// Only needs to cover the range this catalog will plausibly reach.
// ---------------------------------------------------------------------------
const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    throw new Error(`numberToWords: unsupported value ${n}`);
  }
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
  }
  throw new Error(`numberToWords: unsupported value ${n} (3-digit growth not expected for this catalog)`);
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface InstanceHeading {
  readonly number: number;
  readonly retired: boolean;
}

/**
 * Parse every `### Instance N ...` heading. Deliberately uses the loosest
 * anchor for the raw count (`^### Instance `) and cross-checks it against the
 * number-capturing regex, so a future heading in a format the number-capture
 * doesn't expect fails LOUD (undercounts visibly) rather than silently
 * dropping out of the active total — the same silent-undercount shape this
 * catalog itself warns about, reproduced in its own guard, would defeat the
 * point.
 */
function parseInstanceHeadings(text: string): InstanceHeading[] {
  const rawHeadingLines = text.match(/^### Instance /gm) ?? [];
  const headingRe = /^### Instance (\d+)(.*)$/gm;
  const out: InstanceHeading[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    const number = Number(m[1]);
    const rest = m[2];
    // A heading only counts as "retired" when the title BEGINS with the
    // word "retired" right after the dash (Instance 10's actual shape:
    // "### Instance 10 — retired (...)"). Instance 8's title contains the
    // word "retired" mid-sentence ("...on retired/wrong-port OTLP target")
    // and must NOT be mistaken for a retirement marker — the issue's own
    // filing miscounted this exact way (see the parser sanity test below).
    const retired = /^\s*[—–-]+\s*retired\b/i.test(rest);
    out.push({ number, retired });
  }
  if (out.length !== rawHeadingLines.length) {
    throw new Error(
      `parseInstanceHeadings: found ${rawHeadingLines.length} "### Instance " lines but only parsed ` +
        `${out.length} instance numbers — a heading is in a format this parser doesn't expect ` +
        '(the exact silent-undercount shape this catalog warns against, reproduced in its own guard).',
    );
  }
  return out;
}

describe('silent-fallback-hazards.md — self-referential instance counts stay derivable (#937)', () => {
  it('parses the instance headings and correctly distinguishes real retirement from an incidental substring', () => {
    const headings = parseInstanceHeadings(body());
    expect(headings.length).toBeGreaterThanOrEqual(20);

    const numbers = headings.map((h) => h.number);
    expect(new Set(numbers).size, 'instance numbers must be unique — a duplicate would silently corrupt the next-number derivation').toBe(numbers.length);

    const retiredNumbers = headings.filter((h) => h.retired).map((h) => h.number);
    expect(retiredNumbers).toContain(10);
    // Instance 8's heading text contains the word "retired" mid-sentence
    // ("...on retired/wrong-port OTLP target") — a naive substring grep for
    // "retired" (the shape #937's own filing used) miscounts this as a
    // second retirement. It is not one; the parser must not either.
    expect(retiredNumbers).not.toContain(8);
  });

  it('states the correct active-instance count in the intro paragraph', () => {
    const text = body();
    const headings = parseInstanceHeadings(text);
    const activeCount = headings.filter((h) => !h.retired).length;
    const expectedWord = titleCase(numberToWords(activeCount));

    const introMatch = text.match(/\b([A-Za-z-]+) active instances are documented below\b/);
    expect(introMatch, 'expected an "<N> active instances are documented below" sentence in the intro paragraph').not.toBeNull();
    expect(
      introMatch![1],
      `intro says "${introMatch![1]} active instances" but ${headings.length} headings minus ` +
        `${headings.filter((h) => h.retired).length} retired = ${activeCount} active ` +
        `(expected the word "${expectedWord}")`,
    ).toBe(expectedWord);
  });

  it('states the correct next-instance-number in the "when to add" section', () => {
    const text = body();
    const headings = parseInstanceHeadings(text);
    const maxNumber = Math.max(...headings.map((h) => h.number));
    const expectedNext = maxNumber + 1;

    const nextMatch = text.match(/the next number is \*\*(\d+)\*\*/);
    expect(nextMatch, 'expected a "the next number is **N**" sentence').not.toBeNull();
    expect(Number(nextMatch![1]), `highest instance heading is ${maxNumber}, so the next number should be ${expectedNext}`).toBe(expectedNext);
  });

  it('does not restate the active-instances-with-defense count as a hand-maintained fraction (regression)', () => {
    // These "N of M active instances have structural defense" claims were
    // the concrete drift #937 reported: three near-duplicate copies (the
    // intro sentence, the "Defense-pattern emergence" header, and the
    // summary prose before the per-instance table) disagreed with each
    // other and with the actual heading count. Computing "how many
    // instances have a defense" mechanically would require hardcoding a
    // per-instance verdict here — a second hand-maintained copy of the
    // same driftable fact. The fix drops the numeric fraction in favor of
    // wording that cannot go stale; this pins that it doesn't come back.
    const text = body();
    // \w+ covers BOTH the spelled-out form ("Nineteen of twenty") and the
    // digit form ("19 of 20") — the header used a third shape again
    // ("19-of-20"), so both a word-boundary space-separated pattern and a
    // hyphenated one are checked. "active" is optional in the first so
    // "19 of 20 active instances have structural defense" (the most likely
    // way this creeps back in) doesn't slip through a too-narrow regex.
    expect(text).not.toMatch(/[\w-]+ of [\w-]+ (active )?instances have structural defense/i);
    expect(text).not.toMatch(/\(\s*\d+\s*-of-\s*\d+\s+active instances have structural defense/i);
    // The Pattern-A instance-count fragment specifically read "(10 of 18)"
    // two sentences after the summary prose asserted the active total was
    // 19 — an internally-inconsistent duplicate of the same ratio, fixed to
    // "(10 of them)" (self-referential to the list it follows, not a
    // separately-tracked total that can drift out of step with it).
    expect(text).not.toContain('(10 of 18)');
  });
});
