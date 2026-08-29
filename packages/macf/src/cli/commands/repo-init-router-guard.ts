/**
 * Result-invariant check for the generated Agent Router workflow
 * (groundnuty/macf#886).
 *
 * `repo-init.ts`'s own `generateWorkflow()` is the single source of truth
 * for what the router workflow is SUPPOSED to contain — its comments
 * already explain why each `on:` trigger and each `permissions:` key
 * exists (e.g. the icsoc-2026 routing outage that motivated the
 * permissions block, groundnuty/macf#797). What this module adds is an
 * independent CHECK, run against the actual generated string right before
 * it is written to disk: does the emission really carry every element the
 * reusable workflow's jobs consume?
 *
 * This catches degradation regardless of cause — a stale `dist/` build (the
 * reported incident), a bad flag combination nobody has hit yet, or a
 * future refactor of `generateWorkflow()` that drops a line by accident.
 * Verifying the ARTIFACT (what actually got emitted) is preferred here over
 * verifying the TOOLCHAIN (whether `dist/` looks fresh): a toolchain check
 * is a proxy for "the output is probably fine" and both under- and
 * over-fires — it cannot see a defect from a cause other than staleness,
 * and (per `build-info.ts`'s own fail-soft doc) it has no signal at all for
 * an install with no `.git/` directory, which is exactly the install shape
 * a real degraded emission was diagnosed from. An artifact check has
 * neither gap: it looks at the one thing that actually matters, the bytes
 * about to be written.
 *
 * Required-element derivation: every entry below is something the
 * reusable workflow's own jobs read — not merely one of the two symptoms
 * the reporting incident happened to notice. Traced from
 * `generateWorkflow()`'s own inline comments:
 *   - `issues` / `issue_comment` / `pull_request` / `pull_request_review` /
 *     `check_suite` triggers each back a distinct routing job
 *     (label/close routing, comment-mention routing, PR routing incl. the
 *     macf#980 draft/DIRTY-recovery paths, review-state routing, and
 *     CI-completion routing respectively).
 *   - the `permissions:` block, and each of its four keys — dropping the
 *     whole block fails the reusable-workflow call at composition
 *     (`startup_failure`, the icsoc-2026 outage); dropping `checks: read`
 *     alone 403s just the CI-completion job.
 *   - the `uses:` reference to the reusable workflow itself, and a way to
 *     get it the repo secrets it needs — `secrets: inherit` (same-org/
 *     enterprise caller only), the explicit six-name form (groundnuty/
 *     macf#1338 — the v3+ default; `inherit` does NOT cross a GitHub org/
 *     enterprise scope boundary, which is the case for every provisioned
 *     fleet), or the `MACF_ROUTING_BUNDLE` single-secret form (groundnuty/
 *     macf#1112, for a not-yet-released bundle-capable pin) — without one
 *     of these, the `route:` job cannot invoke the reusable workflow with
 *     the repo secrets it needs.
 *
 * Deliberately scoped to the VERSION-INDEPENDENT baseline `generateWorkflow`
 * always emits. The v3-only `with: { project, registry-api-path }` block is
 * NOT checked here — whether it belongs is a version-conditional contract
 * already covered by `generateWorkflow`'s own test suite ("omits with: for
 * a v1 pin", etc.); folding it into this guard would false-positive on a
 * correct v1/v2 emission that intentionally has no `with:` block.
 */

import { ALL_ROUTING_SECRET_NAMES, ROUTING_BUNDLE_SECRET_NAME } from '../bootstrap/apply-routing-secrets.js';

export interface RouterWorkflowRequirement {
  readonly name: string;
  readonly check: (content: string) => boolean;
  /** What to do about it — plain prose, no internal issue/DR citations (user-facing). */
  readonly fixHint: string;
}

function hasTriggerBlock(content: string, trigger: string, typesValue: string): boolean {
  const pattern = new RegExp(`\\n  ${trigger}:\\n {4}types: \\[${typesValue}\\]`);
  return pattern.test(content);
}

export const ROUTER_WORKFLOW_REQUIREMENTS: readonly RouterWorkflowRequirement[] = [
  {
    name: 'issues trigger (labeled, closed)',
    check: (c) => hasTriggerBlock(c, 'issues', 'labeled, closed'),
    fixHint: 'add an `issues:` trigger subscribing to `[labeled, closed]` under `on:` — label- and close-based routing depend on it.',
  },
  {
    name: 'issue_comment trigger (created)',
    check: (c) => hasTriggerBlock(c, 'issue_comment', 'created'),
    fixHint: 'add an `issue_comment:` trigger subscribing to `[created]` under `on:` — comment-mention routing depends on it.',
  },
  {
    name: 'pull_request trigger (opened, ready_for_review, synchronize)',
    check: (c) => hasTriggerBlock(c, 'pull_request', 'opened, ready_for_review, synchronize'),
    fixHint: 'add a `pull_request:` trigger subscribing to `[opened, ready_for_review, synchronize]` under `on:` — PR routing, including the draft/unmergeable-recovery paths, depends on it.',
  },
  {
    name: 'pull_request_review trigger (submitted)',
    check: (c) => hasTriggerBlock(c, 'pull_request_review', 'submitted'),
    fixHint: 'add a `pull_request_review:` trigger subscribing to `[submitted]` under `on:` — review-state routing (approve / changes-requested notifications) depends on it.',
  },
  {
    name: 'check_suite trigger (completed)',
    check: (c) => hasTriggerBlock(c, 'check_suite', 'completed'),
    fixHint: 'add a `check_suite:` trigger subscribing to `[completed]` under `on:` — CI-completion routing depends on it.',
  },
  {
    name: 'permissions block present',
    check: (c) => /\npermissions:\n/.test(c),
    fixHint: 'add a `permissions:` block between `on:` and `jobs:` — without it the reusable-workflow call fails at composition and nothing routes at all.',
  },
  {
    name: 'permissions.contents: read',
    check: (c) => c.includes('\n  contents: read'),
    fixHint: 'add `contents: read` under `permissions:`.',
  },
  {
    name: 'permissions.issues: write',
    check: (c) => c.includes('\n  issues: write'),
    fixHint: 'add `issues: write` under `permissions:` — without it every labeling/commenting routing job fails.',
  },
  {
    name: 'permissions.pull-requests: read',
    check: (c) => c.includes('\n  pull-requests: read'),
    fixHint: 'add `pull-requests: read` under `permissions:`.',
  },
  {
    name: 'permissions.checks: read',
    check: (c) => c.includes('\n  checks: read'),
    fixHint: 'add `checks: read` under `permissions:` — without it the CI-completion job is refused access inside the reusable workflow.',
  },
  {
    name: 'reusable workflow reference (uses:)',
    check: (c) => c.includes('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@'),
    fixHint: 'the `route:` job must call `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@<version>` — without it nothing routes at all.',
  },
  {
    // Three valid "the callee gets its secrets" mechanisms, per
    // `repo-init.ts::generateWorkflow`'s own version gating (groundnuty/
    // macf#1112 / #1338):
    //   - `secrets: inherit` — same-GitHub-org/enterprise caller only
    //     (legacy v1.x/v2.x substrate pins; `inherit` is scoped by GitHub
    //     to "the same organization or enterprise," verified against the
    //     live docs, so this form is WRONG for a cross-org v3+ caller).
    //   - the explicit six-name form (`MACF_ROUTING_APP_ID:`, etc.) — the
    //     v3+ default below the bundle threshold; unrestricted by org
    //     boundary, and exactly what every released v3.x tag's
    //     `workflow_call.secrets` block declares (verified live,
    //     v3.0.0..v3.4.2). `ALL_ROUTING_SECRET_NAMES[0]` is checked as the
    //     representative name — `generateWorkflow` emits all six or none.
    //   - `secrets: { MACF_ROUTING_BUNDLE: ... }` — the bundle form, for a
    //     pin at/above the not-yet-released bundle threshold.
    // Any ONE of the three satisfies this requirement — checking for
    // exactly one literal would false-positive on the other two correct
    // forms. Same "deliberately scoped to the version-independent
    // baseline" posture this module's doc already states for the `with:`
    // block.
    name: 'secrets propagation (secrets: inherit OR explicit six-name OR MACF_ROUTING_BUNDLE)',
    check: (c) => c.includes('secrets: inherit') || c.includes(`${ALL_ROUTING_SECRET_NAMES[0]}:`) || c.includes(`${ROUTING_BUNDLE_SECRET_NAME}:`),
    fixHint:
      'add `secrets: inherit` (same-GitHub-scope caller only — see groundnuty/macf#1338), the explicit six-name ' +
      '`secrets:` block (safe across a GitHub org/enterprise scope boundary), or the `secrets: { MACF_ROUTING_BUNDLE: ... }` ' +
      'bundle form (also safe across scope boundaries, once macf-actions ships a bundle-capable release) to the ' +
      '`route:` job — without one of these the reusable workflow has no repo secrets to route with.',
  },
];

/** Every requirement the generated content fails, in declaration order. Pure — no I/O. */
export function findMissingRouterWorkflowRequirements(
  content: string,
): readonly RouterWorkflowRequirement[] {
  return ROUTER_WORKFLOW_REQUIREMENTS.filter((req) => !req.check(content));
}

/**
 * Throws if the generated router workflow is missing any required element.
 * Fails LOUD (a thrown Error, not a warning) — a degraded routing plane
 * that "looks provisioned" and silently cannot do part of its job is never
 * an acceptable output to write to disk. The message names every missing
 * element individually, not just "invalid workflow", so the operator does
 * not have to diff the output by hand to find out what a warning-in-a-
 * stream-nobody-reads would have hidden.
 */
export function assertRouterWorkflowWellFormed(content: string): void {
  const missing = findMissingRouterWorkflowRequirements(content);
  if (missing.length === 0) return;
  const detail = missing.map((m) => `  - ${m.name}: ${m.fixHint}`).join('\n');
  throw new Error(
    `Refusing to write agent-router.yml: the generated content is missing ${String(missing.length)} ` +
      `required element(s):\n${detail}\n` +
      'This usually means the installed macf CLI is out of date. Update to the latest CLI ' +
      '(rebuild from source, or reinstall the latest published version) and re-run repo-init.',
  );
}
