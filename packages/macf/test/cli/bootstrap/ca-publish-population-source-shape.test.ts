/**
 * Static source-shape regression guard, groundnuty/macf#1345 SUPERSEDED by
 * macf#800 — history kept because the shape this guards against is the
 * SAME class of hazard `row4-apply-untouched-source-shape.test.ts` guards
 * (a call site can regress back to a form this repo has already had a real
 * incident from), just a different call site.
 *
 * **#1345 (original):** `apply-fleet.ts` called `apply-ca.ts::publishCaCertLegs`
 * / `apply-ca.ts::skippedCaPublish` with a `repos` argument that was
 * supposed to be `routerCarryingRepos` (agent repos PLUS the control repo
 * when it carries the router) but was actually `confirmedRepos` (agent
 * repos ONLY) — the control repo silently never got the CA cert.
 *
 * **#800 (this file's current guard):** the per-repo CA write is GONE
 * entirely — `publishCaCertLegs`/`skippedCaPublish` no longer take a
 * `repos` argument at all; the CA cert is written ONCE, at the fleet's
 * registry scope (see `apply-ca.ts`'s module doc). #1345's original
 * question ("is the repos argument the RIGHT population?") is therefore
 * moot — there is no repos argument to get wrong. The regression class
 * that remains is coarser but real: **a repos-shaped argument reappearing
 * at either call site at all** would mean someone re-introduced the
 * per-repo write #800 removed (with whatever identifier, right or wrong —
 * `apply-ca.test.ts`'s/`apply-fleet.test.ts`'s DECISIVE behavioral spies on
 * `createRepoVariable`/`checkRepoPresence` are the stronger, PRIMARY guard
 * against that regression; this file is a static, secondary backstop
 * mirroring `row4-apply-untouched-source-shape.test.ts`'s "prove the
 * literal shape doesn't exist in source" discipline).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The two call sites this guard tracks. */
export interface CaPublishCallSite {
  readonly callee: 'publishCaCertLegs' | 'skippedCaPublish';
  /** Total argument count found at the call site, or `undefined` if the call site was not found at all. */
  readonly argCount: number | undefined;
}

/**
 * Extracts the argument COUNT (not identity — #800 removed the positional
 * slot #1345 cared about identifying) for `publishCaCertLegs(...)` /
 * `skippedCaPublish(...)` from source text. Counts top-level commas
 * (deliberately naive — every real call site at either name in this
 * codebase is a flat argument list with no nested parens/commas in an
 * argument value, verified by the "sanity: both call sites found" test
 * below reading the REAL file, not just the synthetic fixtures).
 */
export function extractCaPublishCallSites(source: string): readonly CaPublishCallSite[] {
  const results: CaPublishCallSite[] = [];
  const publishMatch = /publishCaCertLegs\(([^)]*)\)/.exec(source);
  results.push({ callee: 'publishCaCertLegs', argCount: publishMatch?.[1] === undefined ? undefined : publishMatch[1].split(',').length });
  const skippedMatch = /skippedCaPublish\(([^)]*)\)/.exec(source);
  results.push({ callee: 'skippedCaPublish', argCount: skippedMatch?.[1] === undefined ? undefined : skippedMatch[1].split(',').length });
  return results;
}

/** #800's post-fix arity: `publishCaCertLegs(certPem, fleetName, registry, deps)` = 4; `skippedCaPublish(reason)` = 1. Neither carries a `repos` slot any more. */
const EXPECTED_ARG_COUNT: Readonly<Record<CaPublishCallSite['callee'], number>> = {
  publishCaCertLegs: 4,
  skippedCaPublish: 1,
};

/** Violations: a found call site whose arg count does NOT match #800's post-fix arity (including the pre-#800 5-arg / 2-arg shape a `repos` parameter would reintroduce). */
function violations(source: string): readonly CaPublishCallSite[] {
  return extractCaPublishCallSites(source).filter((site) => site.argCount !== undefined && site.argCount !== EXPECTED_ARG_COUNT[site.callee]);
}

const applyFleetPath = fileURLToPath(new URL('../../../src/cli/bootstrap/apply-fleet.ts', import.meta.url));

describe('CA-cert publish call sites carry no repos-population argument (groundnuty/macf#800 structural guard, superseding the #1345 identity-check)', () => {
  // --- Decisive: prove the scanner actually fires -------------------------
  // Per assert-the-wrong-path.md: a check that only ever reports "clean" is
  // indistinguishable from a broken check.
  it('FIRES on the exact pre-#800 regression shape (a repos argument reintroduced on both calls)', () => {
    const bad = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, routerCarryingRepos, deps.trustDeps)",
      "  : skippedCaPublish(routerCarryingRepos, caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    const found = violations(bad);
    expect(found).toHaveLength(2);
    expect(found.map((v) => v.callee).sort()).toEqual(['publishCaCertLegs', 'skippedCaPublish']);
  });

  it('FIRES on a partial regression — only ONE of the two calls reverted', () => {
    const bad = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, deps.trustDeps)",
      "  : skippedCaPublish(routerCarryingRepos, caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    const found = violations(bad);
    expect(found).toHaveLength(1);
    expect(found[0]?.callee).toBe('skippedCaPublish');
  });

  it('does NOT fire when both calls carry the #800 post-fix arity (no repos argument)', () => {
    const ok = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, deps.trustDeps)",
      "  : skippedCaPublish(caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    expect(violations(ok)).toEqual([]);
  });

  // --- The real tree --------------------------------------------------------

  it('sanity: both call sites are actually found in the real apply-fleet.ts (a renamed/restructured call site would silently pass an empty-violations check otherwise)', () => {
    const source = readFileSync(applyFleetPath, 'utf-8');
    const sites = extractCaPublishCallSites(source);
    expect(sites.find((s) => s.callee === 'publishCaCertLegs')?.argCount).toBeDefined();
    expect(sites.find((s) => s.callee === 'skippedCaPublish')?.argCount).toBeDefined();
  });

  it('apply-fleet.ts itself: neither CA-cert call site carries a repos-population argument', () => {
    const source = readFileSync(applyFleetPath, 'utf-8');
    expect(violations(source)).toEqual([]);
  });
});
