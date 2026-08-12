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
 */
export function buildCreateVariableArgs(pathPrefix: string, name: string, value: string): readonly string[] {
  const prefix = pathPrefix.replace(/^\//, '');
  return ['api', `${prefix}/actions/variables`, '--method', 'POST', '-f', `name=${name}`, '-f', `value=${value}`];
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
