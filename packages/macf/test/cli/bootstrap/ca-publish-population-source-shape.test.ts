/**
 * Static source-shape regression guard (groundnuty/macf#1345), mirroring
 * `install-scope-source-shape.test.ts` / `row4-apply-untouched-source-
 * shape.test.ts`'s own precedent for the SAME class of hazard: a rollout
 * site that hardcodes its own repo population instead of reading the ONE
 * derivation `apply` already computes.
 *
 * `apply-fleet.ts` calls `apply-ca.ts::publishCaCertLegs` /
 * `apply-ca.ts::skippedCaPublish` with a `repos` argument. The correct
 * population is `routerCarryingRepos` (`apply-control-repo-init.ts::
 * deriveRouterCarryingRepos` — agent repos PLUS the control repo when it
 * carries the router). Before this issue, both calls passed `confirmedRepos`
 * (agent repos ONLY) instead — the control repo, the fleet's actual
 * cross-agent routing surface (#1057), silently never got the CA cert.
 *
 * This is deliberately narrower than "no file may ever reference
 * `confirmedRepos`" — `confirmedRepos` is the CORRECT population for
 * several OTHER call sites in `apply-fleet.ts` (e.g. the runner-provisioning
 * loop, which is legitimately per-agent-repo-only, never the control repo).
 * The guard targets the two named call sites specifically, the same way
 * `install-scope-source-shape.test.ts` targets one named comparison rather
 * than banning a whole identifier fleet-wide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The two call sites whose `repos` argument must be `routerCarryingRepos`. */
export interface CaPublishCallSite {
  readonly callee: 'publishCaCertLegs' | 'skippedCaPublish';
  readonly reposArg: string | undefined;
}

/**
 * Extracts the `repos` argument actually passed to `publishCaCertLegs(...)`
 * / `skippedCaPublish(...)` from source text — the 4th positional argument
 * for the former (after `certPem, fleetName, registry`), the 1st for the
 * latter. `undefined` means the call site was not found at all (a
 * structural change this guard should also catch — see the "both call
 * sites are found" sanity test below).
 */
export function extractCaPublishCallSites(source: string): readonly CaPublishCallSite[] {
  const results: CaPublishCallSite[] = [];
  const publishMatch = /publishCaCertLegs\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*,/.exec(source);
  results.push({ callee: 'publishCaCertLegs', reposArg: publishMatch?.[1] });
  const skippedMatch = /skippedCaPublish\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(source);
  results.push({ callee: 'skippedCaPublish', reposArg: skippedMatch?.[1] });
  return results;
}

const REQUIRED_REPOS_ARG = 'routerCarryingRepos';

/** Violations: a found call site whose `repos` argument is NOT `routerCarryingRepos` (including the pre-#1345 `confirmedRepos` shape). */
function violations(source: string): readonly CaPublishCallSite[] {
  return extractCaPublishCallSites(source).filter((site) => site.reposArg !== undefined && site.reposArg !== REQUIRED_REPOS_ARG);
}

const applyFleetPath = fileURLToPath(new URL('../../../src/cli/bootstrap/apply-fleet.ts', import.meta.url));

describe('CA-cert publish call sites use routerCarryingRepos, not a hand-held population (groundnuty/macf#1345 structural guard)', () => {
  // --- Decisive: prove the scanner actually fires -------------------------
  // Per assert-the-wrong-path.md: a check that only ever reports "clean" is
  // indistinguishable from a broken check.
  it('FIRES on the exact pre-#1345 regression shape (confirmedRepos on both calls)', () => {
    const bad = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, confirmedRepos, deps.trustDeps)",
      "  : skippedCaPublish(confirmedRepos, caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    const found = violations(bad);
    expect(found).toHaveLength(2);
    expect(found.map((v) => v.callee).sort()).toEqual(['publishCaCertLegs', 'skippedCaPublish']);
  });

  it('FIRES on a partial regression — only ONE of the two calls reverted', () => {
    const bad = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, routerCarryingRepos, deps.trustDeps)",
      "  : skippedCaPublish(confirmedRepos, caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    const found = violations(bad);
    expect(found).toHaveLength(1);
    expect(found[0]?.callee).toBe('skippedCaPublish');
  });

  it('does NOT fire when both calls use routerCarryingRepos (the fixed shape)', () => {
    const ok = [
      "  ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, routerCarryingRepos, deps.trustDeps)",
      "  : skippedCaPublish(routerCarryingRepos, caSkipReason ?? 'CA cert unresolved');",
    ].join('\n');
    expect(violations(ok)).toEqual([]);
  });

  // --- The real tree --------------------------------------------------------

  it('sanity: both call sites are actually found in the real apply-fleet.ts (a renamed/restructured call site would silently pass an empty-violations check otherwise)', () => {
    const source = readFileSync(applyFleetPath, 'utf-8');
    const sites = extractCaPublishCallSites(source);
    expect(sites.find((s) => s.callee === 'publishCaCertLegs')?.reposArg).toBeDefined();
    expect(sites.find((s) => s.callee === 'skippedCaPublish')?.reposArg).toBeDefined();
  });

  it('apply-fleet.ts itself: neither CA-cert call site uses confirmedRepos (or anything other than routerCarryingRepos)', () => {
    const source = readFileSync(applyFleetPath, 'utf-8');
    expect(violations(source)).toEqual([]);
  });
});
