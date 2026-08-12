/**
 * Create-only GitHub Actions variable writes — the shared write leaf behind
 * DR-043 Phase 2b (groundnuty/macf#838 Amendment D phase 2): the CA
 * two-place rule (macf#806) and `MACF_ROUTING_RUNS_ON`.
 *
 * **Create-only by construction, not by convention.** Every write here is
 * `gh api --method POST` — NEVER `PATCH`. GitHub's variables-create endpoint
 * responds `409 Conflict` when the name already exists, so a caller can never
 * accidentally clobber an existing value through this primitive; the
 * "already exists" case is a distinguishable RESULT (`'exists'`), not success
 * dressed up. This is deliberately NOT `@groundnuty/macf-core`'s
 * `createGitHubClient().writeVariable` — that client is PATCH-then-POST
 * (upsert), built for an AGENT reconciling its own registry entry, and would
 * violate DR-043's "never silently overwrite" posture if reused here.
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
import { getStderr } from './observer.js';

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
