/**
 * Provisioning live-smoke primitives (groundnuty/macf#869) — the durable
 * close for a bug class that recurred five times in the DR-043 arc: a test
 * that fakes GitHub's API can pin OUR OWN request shape from inside the
 * seam, but cannot observe GitHub's side of the contract at all. The
 * clearest instance (macf#866) shipped a unit-tested-green org-variable
 * write whose 422 ("missing required key: visibility") was invisible to
 * any test built entirely out of injected fakes.
 *
 * **Design constraint this module is built around**: creating a NEW GitHub
 * App needs the operator's own browser (the manifest form + the install
 * click — DR-043 §D2 gates 1/2). That makes a "provision a fresh App,
 * verify, tear down" loop fundamentally NOT repeatable unattended, no
 * matter how cheap teardown gets — every run would still cost a click. So
 * every check in this module is built to run against EXISTING,
 * operator-designated credentials/targets (an already-installed App, an
 * already-existing repo/org) rather than creating anything new. That is
 * what makes it re-runnable in CI or by hand with zero consent clicks.
 *
 * Every check here is split into a PURE contract-assertion function (takes
 * already-fetched data, returns pass/fail + a human-readable reason) and a
 * thin injectable I/O wrapper around it. The pure half is what
 * `test/cli/bootstrap/live-smoke.test.ts` exercises with a deliberately
 * malformed fake response — proving the assertion actually catches a
 * contract violation, not just that it runs. The I/O half is what
 * `test/live-smoke/provisioning-live-smoke.test.ts` (opt-in, credentialed,
 * excluded from the default `vitest run`) points at the real GitHub API.
 *
 * **Scope, deliberately narrower than the issue's original wishlist:**
 *   - App-JWT -> `GET /app/installations`: covered, read-only.
 *   - Actions-variable create+delete at repo AND org scope: covered — a
 *     real write is unavoidable here, since a read cannot tell you whether
 *     a POST will be accepted (that is exactly what macf#866 needed). Each
 *     round trip is a create of a freshly-named, never-seen-before
 *     variable followed immediately by its own delete — net effect zero,
 *     same shape as a database migration test that rolls back.
 *   - Repo creation from a template: NOT exercised end-to-end. Actually
 *     generating a repo per run, then deleting it, is exactly the
 *     "easy repeatable repository removal" shape the operator has ruled
 *     out standing — a live-smoke is not the place to introduce it. What
 *     IS covered is a READ-ONLY preflight — confirm the template repo is
 *     still reachable and still reports `is_template: true` — which is
 *     the one precondition the `--template` flag depends on. It does NOT
 *     verify the generate-endpoint's own accept/reject contract; see this
 *     module's test file + the issue report for the explicit tradeoff.
 *   - App-manifest conversion (`POST /app-manifests/{code}/conversions`):
 *     NOT reachable at all without a human pasting a one-shot code they
 *     can only get by clicking through the manifest form. Not attempted
 *     here; `manifest-exchange.ts`'s existing pure-parser unit tests are
 *     the closest available coverage.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IdentityConfirmation } from './identity-confirm.js';
import { confirmAppInstallation } from './identity-confirm.js';
import type { CreateVariableFn, DeleteVariableFn } from './variable-write.js';
import { getStderr } from './observer.js';

const execFileAsync = promisify(execFile);

/** Bounds the one `gh api` read this module adds on top of the primitives it reuses (mirrors `identity-confirm.ts`'s own exec/fetch timeouts — a hung read must not hang whatever awaits it). */
const TEMPLATE_FETCH_TIMEOUT_MS = 10_000;

/** Shared pass/fail + human-readable-reason shape across every check in this module. */
export interface ContractCheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

// --- Check: App-JWT -> GET /app/installations still carries repository_selection ---

/**
 * Pure. Given an already-resolved {@link IdentityConfirmation}, decide
 * whether the response shape our provisioning code depends on still holds.
 * `install-scope.ts`'s post-install-gate refusal treats a MISSING
 * `repository_selection` as "not reported by GitHub" and fails closed on
 * every apply from that point on — this function is what a live-smoke run
 * uses to catch that BEFORE an operator hits it mid-apply.
 */
export function assertRepositorySelectionPresent(confirmation: IdentityConfirmation): ContractCheckResult {
  switch (confirmation.status) {
    case 'confirmed':
      if (confirmation.install.repositorySelection === undefined) {
        return {
          ok: false,
          detail:
            'GET /app/installations returned a confirmed install with no "repository_selection" field. Every ' +
            'install-time scope check in this codebase treats a missing field as "not reported by GitHub" and ' +
            'fails closed — which means GitHub changed a response shape this tool depends on.',
        };
      }
      return { ok: true, detail: `confirmed install carries repository_selection="${confirmation.install.repositorySelection}".` };
    case 'installed-unexpected-target': {
      const missing = confirmation.installs.filter((i) => i.repositorySelection === undefined);
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `${String(missing.length)} of ${String(confirmation.installs.length)} returned install(s) are missing "repository_selection".`,
        };
      }
      return { ok: true, detail: `${String(confirmation.installs.length)} returned install(s) all carry repository_selection.` };
    }
    case 'app-no-install':
      return { ok: true, detail: 'the App exists with zero installs — nothing to check here, not a contract violation.' };
    case 'unconfirmable':
      return {
        ok: false,
        detail:
          'GitHub could not be reached at all — JWT mint failed, a network error, or a non-2xx response. Check ' +
          'the live-smoke App id / key path pairing and network reachability to api.github.com.',
      };
  }
}

/** Injectable seam over {@link confirmAppInstallation} — defaults to the real implementation. */
export type ConfirmFn = typeof confirmAppInstallation;

/**
 * Live check: mint a JWT for `appId`/`keyPath` (an EXISTING, already-installed
 * App — this function creates nothing), read its installations, and apply
 * {@link assertRepositorySelectionPresent}. Read-only end to end.
 */
export async function checkInstallationsContract(
  appId: string,
  keyPath: string,
  confirm: ConfirmFn = confirmAppInstallation,
): Promise<ContractCheckResult> {
  const confirmation = await confirm(appId, keyPath);
  return assertRepositorySelectionPresent(confirmation);
}

// --- Check: Actions-variable create+delete round trip (repo AND org scope) ---

/**
 * Build a variable name this run has never used before — collision would
 * make a `'created'` result ambiguous with a stale leftover from a prior
 * run. Exported so a test can assert the shape without relying on real
 * timing.
 */
export function buildLiveSmokeVariableName(now: number, rand: string): string {
  return `MACF_LIVE_SMOKE_${String(now)}_${rand}`.toUpperCase();
}

/**
 * Live check: create a freshly-named Actions variable at `pathPrefix`
 * (`repos/<owner>/<repo>` or `orgs/<org>`), then delete it immediately.
 * Net effect on the target is zero either way — but along the way this
 * exercises the REAL create-endpoint contract (org scope additionally
 * requires `visibility`, the macf#866 shape a fake request builder cannot
 * see) and the real delete-endpoint contract.
 *
 * Every non-happy outcome is reported with the underlying `gh api` error
 * text, never swallowed — a caller reading `result.detail` on failure sees
 * exactly what GitHub said. A create that succeeds but whose cleanup delete
 * then fails is reported as a FAILURE (not silently treated as "the check
 * passed, cleanup is a side note") — the leftover variable's name is named
 * explicitly in the detail so an operator can remove it by hand.
 */
export async function runVariableRoundTrip(
  pathPrefix: string,
  createFn: CreateVariableFn,
  deleteFn: DeleteVariableFn,
  now: () => number = Date.now,
  rand: () => string = () => Math.random().toString(36).slice(2, 8),
): Promise<ContractCheckResult> {
  const name = buildLiveSmokeVariableName(now(), rand());

  let created: Awaited<ReturnType<CreateVariableFn>>;
  try {
    created = await createFn(pathPrefix, name, 'provisioning-live-smoke-probe');
  } catch (err) {
    return { ok: false, detail: `create at "${pathPrefix}" failed: ${describeError(err)}` };
  }
  if (created !== 'created') {
    return {
      ok: false,
      detail:
        `create at "${pathPrefix}" returned "${created}" for a freshly-generated name ("${name}") — expected ` +
        '"created". A collision on a fresh name is itself suspicious (a prior run\'s cleanup may have failed).',
    };
  }

  try {
    const deleted = await deleteFn(pathPrefix, name);
    if (deleted !== 'deleted') {
      return {
        ok: false,
        detail: `create at "${pathPrefix}" succeeded but the immediate cleanup delete returned "${deleted}" (expected "deleted") for "${name}".`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      detail:
        `create at "${pathPrefix}" succeeded but cleanup delete FAILED — "${name}" may still exist at ` +
        `"${pathPrefix}" and needs manual removal: ${describeError(err)}`,
    };
  }

  return { ok: true, detail: `round-trip create+delete at "${pathPrefix}" succeeded (name="${name}").` };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Check: repo-creation-from-template preflight (read-only) ---

/**
 * Pure. `repo-create.ts`'s `--template` flag depends on the template repo
 * still existing and still reporting `is_template: true` — a template
 * that's been renamed, deleted, or converted to an ordinary repo would
 * make every agent-repo creation from it fail (or silently misbehave) the
 * next time `apply` runs. This does NOT verify the generate-endpoint's own
 * accept/reject contract (that needs an actual repo-creation call, which
 * this module deliberately does not make — see the module doc).
 */
export function assertIsTemplateContract(body: unknown, templateRepo: string): ContractCheckResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: `"${templateRepo}": the repo-read response was not a JSON object — cannot check is_template.` };
  }
  const isTemplate = (body as Record<string, unknown>).is_template;
  if (isTemplate !== true) {
    return {
      ok: false,
      detail: `"${templateRepo}" reports is_template=${JSON.stringify(isTemplate)} (expected true) — repo creation from this template would fail or silently stop being a template-derived repo.`,
    };
  }
  return { ok: true, detail: `"${templateRepo}" is reachable and is_template=true.` };
}

/** Injectable seam so the orchestration below is testable without a real `gh api` call. */
export type FetchRepoJsonFn = (repo: string) => Promise<unknown>;

/** Real read: `gh api repos/<owner>/<repo>`, parsed as JSON. Bounded so a stalled read cannot hang the caller. */
export async function realFetchRepoJson(repo: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}`], {
      encoding: 'utf-8',
      timeout: TEMPLATE_FETCH_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const stderr = getStderr(err);
    throw new Error(`gh api repos/${repo} failed: ${stderr || describeError(err)}`, { cause: err });
  }
}

/** Live check: read `templateRepo` and apply {@link assertIsTemplateContract}. Read-only end to end — creates nothing. */
export async function checkTemplateRepoContract(
  templateRepo: string,
  fetchRepoJson: FetchRepoJsonFn = realFetchRepoJson,
): Promise<ContractCheckResult> {
  let body: unknown;
  try {
    body = await fetchRepoJson(templateRepo);
  } catch (err) {
    return { ok: false, detail: `"${templateRepo}" unreachable: ${describeError(err)}` };
  }
  return assertIsTemplateContract(body, templateRepo);
}
