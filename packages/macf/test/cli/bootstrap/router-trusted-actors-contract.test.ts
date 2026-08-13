/**
 * The DECISIVE test for macf#922: assert the GitHub Actions variable(s)
 * `macf bootstrap apply` provisions for runner selection are the EXACT set
 * the v3 router's `pick-runner` job actually reads — not the set a prior
 * increment merely believed it read (`MACF_ROUTING_RUNS_ON`, which has zero
 * consumers on the v3 line; see `apply-routing.ts`'s module doc). A test
 * that only checks "we wrote MACF_TRUSTED_ACTORS" would have passed
 * identically for the wrong variable name — this test instead pins the name
 * against a citation of the router's own source, AND (when a sibling
 * `macf-actions` checkout is available) parses that source live.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { TRUSTED_ACTORS_VAR } from '../../../src/cli/bootstrap/apply-routing.js';

/**
 * The COMPLETE set of `vars.MACF_*` GitHub Actions variables referenced
 * ANYWHERE in `agent-router.yml` — pinned as a literal so this test catches
 * drift without requiring a live `macf-actions` clone in every environment
 * that runs it (CI checkouts of `groundnuty/macf` alone don't have one).
 *
 * Verified 2026-08-13 against `groundnuty/macf-actions`
 * `.github/workflows/agent-router.yml` on `main` (`8e2aa48`), `v3.4.1`
 * (`39eb8f1`), and `v3.4.2` (`8e2aa48`) via `grep -n 'vars\.MACF_'
 * .github/workflows/agent-router.yml` — line 111, ONE match, in the
 * `pick-runner` job:
 *
 *     TRUSTED_ACTORS: ${{ vars.MACF_TRUSTED_ACTORS }}
 *
 * The router's other `MACF_*` references (`secrets.MACF_ROUTING_APP_ID` /
 * `secrets.MACF_ROUTING_APP_KEY`, the App-token-mint credentials) are
 * `secrets.*`, not `vars.*`, and are workflow-caller SECRETS supplied by the
 * consuming repo's `.github/workflows/agent-router.yml` caller block — not
 * something `bootstrap apply` provisions as a repo VARIABLE at all. The
 * per-project CA cert var (`<SEG>_CA_CERT`) is read dynamically inside a
 * `run:` block via `gh api` with a computed name, so it can never appear as
 * a static `vars.<literal>` reference — it is a SEPARATE apply module's
 * responsibility (`apply-ca.ts`), correctly out of scope for this pin.
 */
const EXPECTED_ROUTER_VARS_VARS = ['MACF_TRUSTED_ACTORS'] as const;

/** Matches a static `${{ vars.MACF_<NAME> }}` (or bare `vars.MACF_<NAME>`) reference in workflow YAML. */
const VARS_MACF_RE = /vars\.(MACF_[A-Z0-9_]+)/g;

function extractVarsMacfReferences(workflowText: string): string[] {
  const found = new Set<string>();
  for (const m of workflowText.matchAll(VARS_MACF_RE)) {
    const name = m[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

describe('extractVarsMacfReferences (self-test of the parser used below)', () => {
  it('finds every distinct vars.MACF_* reference, deduped and sorted', () => {
    const text = [
      'env:',
      '  A: ${{ vars.MACF_TRUSTED_ACTORS }}',
      '  B: ${{ vars.MACF_TRUSTED_ACTORS }}', // repeated — must dedupe
      '  C: ${{ secrets.MACF_ROUTING_APP_ID }}', // secrets.*, must NOT match
      '  D: ${{ vars.MACF_ZZZ }}',
    ].join('\n');
    expect(extractVarsMacfReferences(text)).toEqual(['MACF_TRUSTED_ACTORS', 'MACF_ZZZ']);
  });

  it('finds nothing when there are no vars.MACF_* references', () => {
    expect(extractVarsMacfReferences('env:\n  X: ${{ secrets.MACF_ROUTING_APP_KEY }}\n')).toEqual([]);
  });
});

describe('MACF_TRUSTED_ACTORS matches the router\'s actual read (macf#922 — the decisive test)', () => {
  it('TRUSTED_ACTORS_VAR — the constant apply-routing.ts writes — equals the pinned expected set (exactly one entry)', () => {
    expect(EXPECTED_ROUTER_VARS_VARS).toEqual(['MACF_TRUSTED_ACTORS']);
    expect(TRUSTED_ACTORS_VAR).toBe(EXPECTED_ROUTER_VARS_VARS[0]);
  });

  it('never regresses to the retired, unconsumed MACF_ROUTING_RUNS_ON name', () => {
    expect(TRUSTED_ACTORS_VAR).not.toBe('MACF_ROUTING_RUNS_ON');
  });

  // Best-effort LIVE parse against a sibling `macf-actions` checkout, when
  // one is available on this machine (the task brief's own dev environment
  // has one at /home/ubuntu/repos/groundnuty/macf-actions). Skips loudly —
  // never fails the suite — when no checkout is found, since a CI checkout
  // of `groundnuty/macf` alone has no reason to also clone a sibling repo.
  // Override the path via MACF_ACTIONS_CHECKOUT for a different clone
  // location.
  const checkoutRoot = process.env['MACF_ACTIONS_CHECKOUT'] ?? '/home/ubuntu/repos/groundnuty/macf-actions';
  const workflowPath = `${checkoutRoot}/.github/workflows/agent-router.yml`;

  it('LIVE PARSE (skips when no macf-actions checkout is present): the router\'s vars.MACF_* set equals what apply provisions for runner selection', () => {
    if (!existsSync(workflowPath)) {
      console.warn(
        `SKIP (router-trusted-actors-contract): no macf-actions checkout found at "${workflowPath}" — the live ` +
          'parse did not run this pass. The literal pin above (EXPECTED_ROUTER_VARS_VARS) still guards drift. ' +
          'Set MACF_ACTIONS_CHECKOUT to exercise the live parse.',
      );
      return;
    }
    const text = readFileSync(workflowPath, 'utf-8');
    const found = extractVarsMacfReferences(text);
    expect(found).toEqual(EXPECTED_ROUTER_VARS_VARS.slice().sort());
    expect(found).toContain(TRUSTED_ACTORS_VAR);
  });
});
