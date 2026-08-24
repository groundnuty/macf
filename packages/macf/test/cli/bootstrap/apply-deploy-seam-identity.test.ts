/**
 * Identity-assertion test for `apply`'s deploy seam (groundnuty/macf#1024).
 *
 * **Why this file exists, and why it is separate from `apply-deps-wiring.test.ts`.**
 * `#1023` gave `apply-deploy.ts::runApplyDeployPhase` an injectable
 * `deployAgentFn` seam (`deps.deployAgentFn ?? realDeployAgent`) so tests can
 * assert the golden-path CALL COUNT without touching the network — but
 * nothing asserted that the PRODUCTION path's default actually resolves to
 * `realDeployAgent` itself, as opposed to merely being *callable*. A
 * same-signature wrapper substituted at the production wiring site
 * (`commands/bootstrap-apply.ts::resolveApplyDeployDeps`) would satisfy
 * every existing check — `#1023`'s own tests assert CALL COUNT through an
 * injected fake, never through the real resolver — while silently
 * reintroducing a second, divergent deploy path. That is the EXACT shape
 * `#1000` produced in this same subsystem (a second cert-issuance path that
 * agreed with the first only by luck) and the reason the operator's
 * golden-path directive exists at all: *"We have golden paths of doing one
 * thing and one thing only — that will prevent us from having multiple ways
 * that might fail while trying to realize the same outcome."*
 *
 * This is a NEW file (not an addition to `apply-deps-wiring.test.ts`) per
 * this issue's own delivery constraint — avoids touching a file another
 * agent may be editing concurrently. The two files import the same
 * production resolver family and could be merged later with no semantic
 * change.
 *
 * **What this test asserts (macf#1024 AC1+AC2).** `resolveApplyDeployDeps()`
 * — the ONE production wiring site `runBootstrapApply` falls back to when no
 * `deployDeps` override is supplied (`resolved.deployDeps ?? {
 * ...resolveApplyDeployDeps(), log: stderrLog }`, see that call site in
 * `bootstrap-apply.ts`) — returns a `deployAgentFn` field that is `===
 * realDeployAgent` (the SAME `deployAgent` export `fleet-deploy.ts` and
 * `commands/fleet-deploy.ts`'s own `resolveDeps()` use for the standalone
 * `macf fleet deploy` command). `toBe` is reference-identity, not
 * structural/shape equality — a same-signature wrapper function is a
 * DIFFERENT reference and fails this assertion immediately, satisfying
 * AC2's "fails if a same-signature wrapper is substituted" requirement by
 * construction, not by a separate simulated-substitution test (the wrapper
 * class this assertion defeats produces a `false` on `===` unconditionally
 * — there is no wrapper shape that would pass `toBe(realDeployAgent)`
 * except literally re-exporting the same function reference). This was
 * verified empirically during authorship: temporarily rewriting
 * `resolveApplyDeployDeps`'s `deployAgentFn` field to a transparent
 * pass-through wrapper (`(...args) => realDeployAgent(...args)`) made this
 * exact test FAIL (`expected [Function] to be [Function]` — different
 * references), confirming the assertion is non-vacuous per `#1011`'s
 * practice; the wiring was reverted immediately after.
 *
 * **What this does NOT cover (macf#1024 AC3 + honest scope, per #1111's
 * "state what a green run does not prove" lesson, applied deliberately by
 * `#869`):**
 *
 * - Does NOT prove `runBootstrapApply` actually CALLS `resolveApplyDeployDeps()`
 *   at its one call site — only that IF called, its output is correctly
 *   wired. The symmetric gap exists for EVERY sibling test in
 *   `apply-deps-wiring.test.ts` (e.g. `resolveMutateDeps` is asserted the
 *   same way, never proven-invoked) — this is the established scope
 *   boundary of the "wiring-identity" test family in this codebase, not a
 *   gap unique to this file. Catching a resolver that is defined, wired
 *   correctly internally, and never CALLED needs a behavioral/integration
 *   test (see `apply-fleet.test.ts`'s "decisive routability test",
 *   macf#920, for that different technique), which is out of scope here —
 *   this file's whole point is the narrower, cheaper, non-network assertion
 *   AC1/AC2 ask for.
 * - Does NOT exercise `realDeployAgent`'s own behavior (clone / cert-issue /
 *   CA-materialize) — that is `fleet-deploy.test.ts`'s job. This file only
 *   proves WHICH function apply's default deploy phase would call, never
 *   whether that function does the right thing once called.
 * - Does NOT cover `runApplyDeployPhase`'s internal `deps.deployAgentFn ??
 *   realDeployAgent` fallback line itself changing to point somewhere else
 *   — a source-shape change to `apply-deploy.ts` inside `src/cli/bootstrap/`
 *   (out of scope for this PR; see the module's own doc for that seam's
 *   contract). A future edit to THAT line would need its own pin inside
 *   `apply-deploy.ts`'s own test coverage, not this file, which only pins
 *   the resolver in `commands/bootstrap-apply.ts`.
 * - This is the complement to `#869`'s live-smoke gate, not a duplicate of
 *   it: `#869` proves apply's REAL API contracts (auth, scope, "who is
 *   asking") against live GitHub, deliberately scoping OUT plan/apply
 *   parity and internal composition questions because they are not API
 *   contracts. This file proves the opposite half — a purely LOCAL,
 *   offline, structural assertion that apply's own composition never
 *   silently reimplements or substitutes what it claims to delegate to —
 *   the "role" AC3 asks any future sequencer (e.g. a `fleet up`) to receive
 *   the same treatment for.
 */
import { describe, it, expect } from 'vitest';
import { resolveApplyDeployDeps } from '../../../src/cli/commands/bootstrap-apply.js';
import { deployAgent as realDeployAgent } from '../../../src/cli/bootstrap/fleet-deploy.js';

describe('apply deploy-phase seam identity (groundnuty/macf#1024)', () => {
  it('wires the default deploy dependency to the REAL deployAgent — not merely something callable', () => {
    const deployDeps = resolveApplyDeployDeps();
    expect(deployDeps.deployAgentFn).toBe(realDeployAgent);
  });

  it('resolveApplyDeployDeps performs no I/O — pure object construction, safe to call directly in a test', () => {
    // Mirrors `apply-deps-wiring.test.ts`'s `resolveMutateDeps` no-I/O pin
    // (same file, line ~72) — same reasoning: nothing above should throw or
    // touch the network just from building the deps object.
    expect(() => resolveApplyDeployDeps()).not.toThrow();
  });
});
