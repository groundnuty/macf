/**
 * The ONE shared post-gate-2 `repository_selection === 'selected'` guard —
 * every App-install gate in a fleet (agent Apps, the router App, runner-ops)
 * builds its `validateInstall` closure around this single function
 * (groundnuty/macf#1128). Before this module existed, ONLY the runner-ops
 * App had this refusal (`apply-runner-ops.ts::validateRunnerOpsInstall`,
 * now removed in favor of this shared implementation); the router App had
 * an independently-maintained BYTE-DIFFERENT copy
 * (`apply-router-app.ts::validateRouterAppInstall`, also removed); ordinary
 * agent Apps had NO enforcement at all. Two live fleets reproduced the gap
 * for exactly the App type that had zero enforcement: a coordination agent
 * App installed with `repository_selection: "all"`, carrying its DR-019
 * permission set — including `contents:write` — onto every repository in
 * the org, including repos outside the fleet. The operator's own framing of
 * what a consent gate owes: "whatever I click and whenever the mechanism
 * moves on, it should validate: did I actually abide by the instructions?"
 * — this function is that validation, generalized to every App type instead
 * of one.
 *
 * **Why this can only be enforced here, after the fact.** GitHub's
 * App-manifest flow has NO field to FORCE the installed repo scope at
 * creation time (verified against GitHub's REST reference — there is no
 * `repository_selection` parameter anywhere in the manifest-conversion
 * endpoint). `repository_selection` is exclusively an INSTALLATION-time
 * choice the operator makes by clicking "Only select repositories" (vs
 * "All repositories") on the gate-2 install page. Scoping the install
 * "before it is ever exported" therefore cannot be done by constraining the
 * request — it can only be done by verifying the RESULT and refusing
 * outright when it doesn't hold, never silently accepting an `"all"`-scoped
 * install as if it were fine.
 *
 * **Why this takes the raw `repositorySelection` value, not a whole
 * `ConfirmedInstall`.** The only field this check ever reads is
 * `install.repositorySelection` — passing the bare value lets the SAME
 * function serve two callers with different shaped inputs: `apply`'s
 * post-gate-2 check (has a live `ConfirmedInstall`, via
 * {@link buildInstallScopeValidator}) and `plan`'s already-provisioned-fleet
 * drift notice (only has the observed string, no `ConfirmedInstall` at all
 * — see `plan.ts`'s `installScopeDriftNotices`). A signature that demanded
 * a `ConfirmedInstall` would force the drift-notice caller to fabricate one.
 *
 * **Rejects anything that ISN'T the exact string `"selected"`** — not
 * merely "not `all`" — so a body that omits `repository_selection` entirely
 * (a malformed/future API shape) fails CLOSED rather than silently passing.
 * Unchanged from the original runner-ops-only version.
 *
 * **What this does NOT verify:** that the *specific* repos selected are
 * exactly the expected set (vs. some OTHER subset that also happens to be
 * "selected," not "all"). Confirming that needs `GET
 * /installation/repositories` under an installation token — flagged, same
 * as before generalization, as future work.
 *
 * **No second copy, ever.** `install-scope-source-shape.test.ts` statically
 * scans this package's source for a re-derived `repositorySelection ===`
 * comparison outside this file, so a future App type cannot silently grow
 * its own inline check the way the router App once did.
 */
import type { ConfirmedInstall } from './identity-confirm.js';

export function validateInstallRepositoryScope(repositorySelection: string | undefined, appHandle: string): string | undefined {
  if (repositorySelection === 'selected') return undefined;
  return (
    `App "${appHandle}": repository_selection must be "selected" (scoped to only the repos this App needs) — ` +
    `observed "${repositorySelection ?? '(not reported by GitHub)'}" . GitHub's App-manifest flow has no field ` +
    'to force this at creation time; the operator must open the install page, choose "Only select repositories," ' +
    'and pick exactly the repos this App needs — never "All repositories" (a broader install grants this App\'s ' +
    "permission set on every repo it can see, including repos outside this fleet — blast-radius the fleet does " +
    "not need). Correct the installation's repository access on GitHub, then re-run apply."
  );
}

/**
 * `AgentApplyDeps.validateInstall`-shaped closure over ONE fixed
 * `appHandle` — mirrors `registry-repo-coverage.ts::
 * buildRegistryRepoValidateInstall`'s naming + shape (a per-App closure,
 * built once per App-install call site in `apply-fleet.ts`). Synchronous —
 * the check itself does no I/O, the live `ConfirmedInstall` was already
 * fetched by gate 2's own poll — but `AgentApplyDeps.validateInstall`
 * accepts a hook that may be sync or async (`apply-agent.ts`'s own doc on
 * that field), and the caller always `await`s the result regardless, so a
 * plain synchronous return is a valid implementation of that hook shape.
 */
export function buildInstallScopeValidator(appHandle: string): (install: ConfirmedInstall) => string | undefined {
  return (install) => validateInstallRepositoryScope(install.repositorySelection, appHandle);
}
