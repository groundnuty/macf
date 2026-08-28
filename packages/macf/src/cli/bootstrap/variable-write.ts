/**
 * GitHub Actions variable writes — the shared write leaf behind DR-043
 * Phase 2b (groundnuty/macf#838 Amendment D phase 2): the CA two-place rule
 * (macf#806) and `MACF_TRUSTED_ACTORS` (macf#922; was `MACF_ROUTING_RUNS_ON`,
 * see `apply-routing.ts`'s module doc).
 *
 * **Create-only by construction, not by convention — for every write EXCEPT
 * the one added by groundnuty/macf#1319.** Every write here through
 * {@link realCreateVariable} is `gh api --method POST` — NEVER `PATCH`.
 * GitHub's variables-create endpoint responds `409 Conflict` when the name
 * already exists, so a caller can never accidentally clobber an existing
 * value through this primitive; the "already exists" case is a
 * distinguishable RESULT (`'exists'`), not success dressed up. This is
 * deliberately NOT `@groundnuty/macf-core`'s `createGitHubClient().writeVariable`
 * — that client is PATCH-then-POST (upsert), built for an AGENT reconciling
 * its own registry entry, and would violate DR-043's "never silently
 * overwrite" posture if reused here. {@link realUpdateVariable} (below) is
 * the ONE deliberate exception — a real `PATCH`, gated entirely by its own
 * ONE caller (`apply-routing.ts::reconcileTrustedActors`) confirming both
 * presence AND operator approval first; see that section's own doc.
 *

 * `buildCreateVariableArgs` is `PURE` — the "POST, not PATCH" property is
 * pinned by a unit test asserting the literal argv array, not left to a
 * comment that can drift from the implementation (macf#838 Phase 2b review).
 *
 * **Scope-aware since groundnuty/macf#866.** `POST /orgs/{org}/actions/variables`
 * requires a `visibility` field GitHub's repo-scope create endpoint doesn't
 * have (verified 2026-08-12 against the current GitHub REST docs —
 * `https://docs.github.com/en/rest/actions/variables?apiVersion=2022-11-28#create-an-organization-variable`
 * lists `name`/`value`/`visibility` as required, `visibility` in
 * `all`|`private`|`selected`, with `selected_repository_ids` required only
 * when `visibility` is `selected`; the sibling
 * `#create-a-repository-variable` section lists only `name`/`value` and
 * states no `visibility` field at all). The live #866 failure was an
 * org-scope registry write (`/orgs/macf-experiment`) 422ing with `object is
 * missing required key: visibility`. Detected from `pathPrefix`'s own shape
 * (`orgs/...` after the leading-slash strip below) — no caller signature
 * change needed; `registryPathPrefix` (`registry-helper.ts`) is the only
 * producer of an `orgs/...` prefix, for `registry.type === 'org'` only.
 *
 * **`{type: 'profile'}` registries do NOT need `visibility`.** They resolve
 * to `repos/<user>/<user>` (a REPO-scope path, using the user's own
 * "profile" repo as the storage location — see `registryPathPrefix`), not a
 * personal-account-level endpoint. Verified against the same GitHub REST
 * docs page: Actions variables exist ONLY at repository/organization/
 * environment scope — there is no `/users/{username}/actions/variables`
 * endpoint at all, so `{type: 'profile'}`'s repo-path choice isn't an
 * approximation of a "real" user-scope endpoint, it's the ONLY way to store
 * an account-level variable via this API. It correctly takes the same
 * (no-`visibility`) contract as `{type: 'repo'}`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { getStderr } from './observer.js';
import { registryPathPrefix } from '../registry-helper.js';

const execFileAsync = promisify(execFile);

export type CreateVariableResult = 'created' | 'exists';

/**
 * Pure — the exact `gh api` argv for a create-only variable write.
 * `pathPrefix` may carry a leading `/` (registry-scope prefixes from
 * `registryPathPrefix` do; repo-scope `repos/<owner>/<repo>` does not) —
 * stripped here, mirroring `observer.ts`'s own convention for the same
 * prefixes so both scopes can share one function.
 *
 * Org-scope (`orgs/<org>/...`) additionally carries `visibility=all` — see
 * the module doc for why `all` (not `private`/`selected`): the fleet CA cert
 * this write exists to publish must be readable by the routing workflow in
 * EVERY caller repo (macf#806's two-place-publish is the whole point of the
 * registry leg), so `all` is the only visibility that doesn't reintroduce a
 * per-repo allowlist this codebase doesn't otherwise maintain. `selected`
 * would additionally require threading `selected_repository_ids` through
 * this function — no caller needs that today, so it's intentionally not
 * exposed as a parameter (add one if/when a caller does).
 */
export function buildCreateVariableArgs(pathPrefix: string, name: string, value: string): readonly string[] {
  const prefix = pathPrefix.replace(/^\//, '');
  const args = ['api', `${prefix}/actions/variables`, '--method', 'POST', '-f', `name=${name}`, '-f', `value=${value}`];
  if (prefix.startsWith('orgs/')) {
    args.push('-f', 'visibility=all');
  }
  return args;
}

/**
 * Real create-only write. NEVER PATCHes — see module doc. `'exists'` means
 * the API reported a 409 (name already taken) — the caller decides what that
 * means (see `ensure-variable.ts::ensureVariableCreated`, the ONLY place
 * that's authorized to treat `'exists'` as anything other than a surprise).
 * Any OTHER failure (auth, network, malformed value) throws — never silently
 * swallowed.
 */
export async function realCreateVariable(pathPrefix: string, name: string, value: string): Promise<CreateVariableResult> {
  try {
    await execFileAsync('gh', [...buildCreateVariableArgs(pathPrefix, name, value)], { encoding: 'utf-8' });
    return 'created';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 409|already exists/i.test(stderr)) return 'exists';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh api create-variable failed for "${name}" at "${pathPrefix}": ${stderr || msg}`, { cause: err });
  }
}

export type CreateVariableFn = (pathPrefix: string, name: string, value: string) => Promise<CreateVariableResult>;

// --- Update (overwrite) write (groundnuty/macf#1319 — DR-043 Amendment P
// row 3 applied to MACF_TRUSTED_ACTORS) ---
//
// **The ONLY place this codebase overwrites an EXISTING Actions variable's
// value.** Every other write primitive in this file is deliberately
// create-only (see the module doc's "create-only by construction" section) —
// `realUpdateVariable` exists because #1319 identified ONE variable
// (`MACF_TRUSTED_ACTORS`) whose value is a PURE FUNCTION OF THE MANIFEST, so
// overwriting it with the manifest-derived value destroys no operator intent
// (the ruling: "never-clobber exists to protect operator intent... a
// manifest-derived variable carries no independent intent"). Nothing else in
// this codebase calls this function — see `apply-routing.ts::reconcileTrustedActors`,
// the ONE caller, for the confirmation gate that must run before it does.

export type UpdateVariableResult = 'updated' | 'absent';

/**
 * Pure — the exact `gh api` argv for an overwrite of an EXISTING variable's
 * value. `PATCH`, never `POST` — the create-endpoint's 409-on-exists
 * protection does not apply here; the caller (`reconcileTrustedActors`) is
 * responsible for confirming BOTH presence and operator approval before ever
 * calling this. Same leading-`/`-stripping convention as
 * {@link buildCreateVariableArgs}.
 */
export function buildUpdateVariableArgs(pathPrefix: string, name: string, value: string): readonly string[] {
  const prefix = pathPrefix.replace(/^\//, '');
  return ['api', `${prefix}/actions/variables/${name}`, '--method', 'PATCH', '-f', `value=${value}`];
}

/**
 * Real overwrite. `'absent'` means the API reported a 404 — the variable
 * vanished between the caller's own presence check and this write (a race,
 * or a stale read); the caller decides what that means (today:
 * `reconcileTrustedActors` reports it as `'failed'` rather than guessing).
 * Any OTHER failure (auth, network, malformed value) throws — never silently
 * swallowed, same contract as {@link realCreateVariable}.
 */
export async function realUpdateVariable(pathPrefix: string, name: string, value: string): Promise<UpdateVariableResult> {
  try {
    await execFileAsync('gh', [...buildUpdateVariableArgs(pathPrefix, name, value)], { encoding: 'utf-8' });
    return 'updated';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh api update-variable failed for "${name}" at "${pathPrefix}": ${stderr || msg}`, { cause: err });
  }
}

export type UpdateVariableFn = (pathPrefix: string, name: string, value: string) => Promise<UpdateVariableResult>;

// --- Delete-only writes (DR-043 Amendment G — the fleet teardown ladder, groundnuty/macf#867) ---
//
// `deactivate`'s registry-presence removal is the ONLY place this package
// ever deletes a GitHub Actions variable outside `deregisterConditional`'s
// agent-runtime path (`@groundnuty/macf-core`'s registry.ts — a DIFFERENT
// credential surface, the fetch-based `GitHubVariablesClient`, not this
// `gh`-CLI-shelling module). Mirrors `realCreateVariable`'s shape exactly
// (pure arg-builder + a thin exec wrapper that classifies ONE expected
// non-throwing outcome from stderr) so the two write directions stay
// side-by-side and easy to audit together.

/**
 * `groundnuty/macf#1206` — three-way, honest-unknown classification of a
 * variable-delete attempt. `'deregistered'` — the DELETE succeeded, i.e. the
 * variable EXISTED and is now gone. `'absent'` — the API reported a 404:
 * there was NOTHING to remove (either never written, or a previous teardown
 * already took it). `'unknown'` — the delete attempt did not return a
 * definitive success or 404 (auth, network, rate-limit, malformed registry
 * config) — presence/outcome could NOT be confirmed, and this is NEVER
 * collapsed into `'absent'` (that would misreport "nothing was there" when
 * the truth is "we couldn't tell"). Mirrors `app-identity-removal.ts`'s
 * `AppDeletionOutcome.status` three-way split (`'already-absent'` /
 * `'unknown'` / everything-else, groundnuty/macf#917 + #967) and
 * `observer.ts::checkRegistryVariablePresence`'s own `Presence` return
 * (`'present'|'absent'|'unknown'`) — same honest-unknown-floor shape,
 * applied to a DELETE response instead of a GET.
 */
export type DeleteVariableResult = 'deregistered' | 'absent' | 'unknown';

/** Pure — the exact `gh api` argv for a variable delete. Same leading-`/`-stripping convention as {@link buildCreateVariableArgs}. */
export function buildDeleteVariableArgs(pathPrefix: string, name: string): readonly string[] {
  const prefix = pathPrefix.replace(/^\//, '');
  return ['api', `${prefix}/actions/variables/${name}`, '--method', 'DELETE'];
}

/**
 * Real delete. `'absent'` means the API reported a 404 — GitHub's own
 * delete-variable contract treats "already gone" as an acceptable outcome
 * (`@groundnuty/macf-core`'s `github-client.ts::deleteVariable` treats
 * 204/404 identically), and DR-043 Amendment G's `deactivate` is explicitly
 * idempotent-on-rerun, so a 404 here is NOT a failure — it is the expected
 * steady state for e.g. `<SEG>_FEDERATED_CAS`, which nothing writes yet in
 * this codebase (day-2 federation is out of Slice-1a scope).
 *
 * **`groundnuty/macf#1206` — never throws.** Any OTHER outcome (auth,
 * network, insufficient scope, rate-limit) used to throw; it now classifies
 * to `'unknown'` instead — the SAME honest-unknown-floor posture
 * `checkRegistryVariablePresence` already applies to its own GET. A thrown
 * exception collapsed "we don't know what happened" into whatever the
 * caller's catch-block chose to call it (previously always `'failed'`,
 * indistinguishable from a confirmed operational failure); returning
 * `'unknown'` as DATA lets the caller (`teardown.ts::executeDeactivate`)
 * report the distinction honestly instead of guessing at it one layer up.
 */
export async function realDeleteVariable(pathPrefix: string, name: string): Promise<DeleteVariableResult> {
  try {
    await execFileAsync('gh', [...buildDeleteVariableArgs(pathPrefix, name)], { encoding: 'utf-8' });
    return 'deregistered';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

export type DeleteVariableFn = (pathPrefix: string, name: string) => Promise<DeleteVariableResult>;

/**
 * Real registry-scope delete — `registryPathPrefix` + {@link realDeleteVariable},
 * mirroring `apply-ca.ts::realCreateRegistryVariable`'s create-side wrapper.
 * The ONLY delete primitive DR-043 Amendment G's `deactivate` uses — its
 * target set (`teardown.ts::computeDeactivateTargets`) is registry-scope
 * ONLY by construction (never `repos/<agent-repo>` — see that module's doc
 * for why repo-scoped variables are explicitly out of `deactivate`'s blast
 * radius).
 *
 * `registryPathPrefix` degrades to `'unknown'` on a synchronous throw
 * (`registry.type === 'local'` — DR-024 mode, out of scope for a DR-043
 * fleet's registry but defensively guarded here) rather than letting the
 * exception escape uncaught — the SAME defensive shape
 * `observer.ts::checkRegistryVariablePresence` already applies around the
 * identical call (groundnuty/macf#1206's honest-unknown floor).
 */
export async function realDeleteRegistryVariable(registry: RegistryConfig, name: string): Promise<DeleteVariableResult> {
  let pathPrefix: string;
  try {
    pathPrefix = registryPathPrefix(registry);
  } catch {
    return 'unknown';
  }
  return realDeleteVariable(pathPrefix, name);
}
