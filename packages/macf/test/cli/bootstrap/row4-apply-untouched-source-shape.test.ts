/**
 * Static source-shape regression guard (groundnuty/macf#1229, DR-043
 * Amendment P3) — "orphan never appears with a deletion side-effect in any
 * code path." This change scopes row 4 to `computePlan` (plan-side
 * computation only); `apply`'s execution path is deliberately untouched
 * (see `plan.ts`'s `planItemApplyCoverage` — `'orphan'` is `'implemented'`
 * for exactly this reason: "apply correctly does nothing" IS the designed
 * behavior, not a gap to fill later).
 *
 * `planItemApplyCoverage`/`unimplementedReasonFor` are the RUNTIME proof
 * that an `'orphan'` item is never routed toward `unimplementedByApply`
 * (see `plan.test.ts`'s "orphan is ALWAYS planItemApplyCoverage
 * 'implemented'" test). This file is the COMPLEMENTARY static proof: the
 * literal verb string `'orphan'` never appears anywhere in the apply
 * EXECUTION surface (`apply-*.ts` under `src/cli/bootstrap/`, plus the
 * `bootstrap-apply.ts` command driver) — so a future edit to one of those
 * files cannot silently start acting on it without a NEW string appearing
 * where none exists today. Mirrors `install-scope-source-shape.test.ts`'s
 * own precedent (groundnuty/macf#1128) for the same class of guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches a single- or double-quoted `'orphan'` string literal (the `PlanVerb` value), not the English word inside prose. */
const ORPHAN_VERB_LITERAL_PATTERN = /['"]orphan['"]/;

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

export interface OrphanVerbReference {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scans TypeScript source for a quoted `'orphan'` literal outside comments — pure, same shape `scanSourceForRepoSelectionComparison` uses. */
export function scanSourceForOrphanVerbLiteral(source: string, fileLabel: string): OrphanVerbReference[] {
  const violations: OrphanVerbReference[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!ORPHAN_VERB_LITERAL_PATTERN.test(line)) continue;
    if (isCommentLine(trimmed)) continue;
    violations.push({ file: fileLabel, line: i + 1, text: trimmed });
  }
  return violations;
}

const bootstrapDir = fileURLToPath(new URL('../../../src/cli/bootstrap', import.meta.url));
const commandsDir = fileURLToPath(new URL('../../../src/cli/commands', import.meta.url));

function listApplyFiles(): readonly string[] {
  const bootstrapFiles = readdirSync(bootstrapDir)
    .filter((f) => f.startsWith('apply-') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(bootstrapDir, f));
  const bootstrapApplyCommand = join(commandsDir, 'bootstrap-apply.ts');
  return [...bootstrapFiles, bootstrapApplyCommand];
}

describe('the "orphan" verb literal never appears in apply\'s execution surface (groundnuty/macf#1229 structural guard)', () => {
  // --- Decisive: prove the scanner actually fires -------------------------
  // Per assert-the-wrong-path.md: a check that only ever reports "clean" is
  // indistinguishable from a broken check.
  it('FIRES on a deliberately injected occurrence (single-quoted)', () => {
    const bad = ["  if (item.verb === 'orphan') { await deleteResource(item); }"].join('\n');
    const violations = scanSourceForOrphanVerbLiteral(bad, 'synthetic-bad.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toContain('orphan');
  });

  it('also FIRES on the double-quoted form', () => {
    const bad = ['  const kind = "orphan";'].join('\n');
    expect(scanSourceForOrphanVerbLiteral(bad, 'synthetic-bad-2.ts')).toHaveLength(1);
  });

  it('does NOT fire on a comment describing the verb (maintainer prose is fine)', () => {
    const ok = ["  // 'orphan' items are never actioned by apply — see plan.ts", "  // an 'orphan' item is an instruction to the operator"].join('\n');
    expect(scanSourceForOrphanVerbLiteral(ok, 'synthetic-ok.ts')).toHaveLength(0);
  });

  it("does NOT fire on the plain English word 'orphaned'/'orphan' in unquoted prose", () => {
    const ok = ['  // an orphaned resource is reported, never deleted', "  const note = `orphan: ${role}`;"].join('\n');
    // Backtick template literals are deliberately NOT matched by the quote
    // pattern — apply's execution surface would need a real STRING-LITERAL
    // comparison against the verb (`===`/case) to act on it, not a
    // human-readable log line that happens to say the word.
    expect(scanSourceForOrphanVerbLiteral(ok, 'synthetic-ok-2.ts')).toHaveLength(0);
  });

  // --- The real tree --------------------------------------------------------

  it('sanity: the scanner sees the real apply-fleet.ts file (not just synthetic strings)', () => {
    const applyFleetPath = join(bootstrapDir, 'apply-fleet.ts');
    const source = readFileSync(applyFleetPath, 'utf-8');
    expect(source.length).toBeGreaterThan(100);
  });

  it('no apply-*.ts file (nor the bootstrap-apply.ts command driver) references the "orphan" verb literal', () => {
    const files = listApplyFiles();
    expect(files.length).toBeGreaterThanOrEqual(12); // sanity: the walker found the apply-*.ts family + the command driver

    const violators = files.flatMap((f) => scanSourceForOrphanVerbLiteral(readFileSync(f, 'utf-8'), f));
    expect(violators).toEqual([]);
  });
});
