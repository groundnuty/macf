/**
 * The runner-provisioning CONTRACT client (groundnuty/macf#943, DR-043
 * Amendment I) — `POST`/`DELETE` against `groundnuty/runner-platform`'s
 * tailnet-only HTTP API. `apply` calls `provisionRunner` per confirmed agent
 * repo (Amendment I2); `deprovisionRunner` exists for the teardown rung
 * Amendment I3/I5 specifies, but has NO caller yet — see this module's
 * "Teardown — deliberately unwired" section below for why.
 *
 * **Fetched live from `GET /` on `http://orzech-dev-agents-monitoring.
 * tail491af.ts.net:8088/` on 2026-08-25 while implementing this file** — the
 * issue's own body is nine days old at that point, and the contract had
 * grown in ways worth recording explicitly:
 *
 *   - **A `credentials` field, marked "usually" required — and the contract
 *     says to send it on EVERY provision, not just the first.** A private
 *     GitHub App can only be installed on the account that owns it (a GitHub
 *     structural rule, not a permissions setting), so the platform's OWN App
 *     "only works for one account." The issue's "three fields" framing
 *     predates this; `credentials` is a fourth. This module wires it for
 *     BOTH shapes `apply-fleet.ts` can supply it in — a freshly-minted
 *     credential (in memory) or a vault-resolved one (a reused App) — see
 *     {@link runnerPlatformCredentialsFromOutcome}'s doc.
 *   - **Two more endpoints** (`GET /runners?fleet=X` list, `GET /healthz`)
 *     — neither consumed here; #943's scope is the two verbs `apply`/
 *     teardown actually need.
 *   - **Idempotent, by the contract's own promise:** "`POST` the same repo
 *     twice and the second call updates in place... call it unconditionally;
 *     there is no does-it-exist check for you to perform." `apply-fleet.ts`
 *     relies on this directly — it POSTs every confirmed repo every run,
 *     never gating on a prior lock entry.
 *
 * Everything else (status codes, the mandatory unset-then-destroy teardown
 * order, the `warm: 0` non-immediacy) matches the issue body and DR-043
 * Amendment I verbatim.
 *
 * ## Non-fatal, by contract (Amendment I2)
 *
 * The contract's own doc: *"`502` should not fail your provisioning run...
 * A fleet must not fail to provision because the runner platform is down.
 * Report it and carry on."* Every function here returns a discriminated
 * {@link RunnerPlatformResult} — it NEVER throws (mirrors
 * `apply-routing.ts::RunnerRegistrationDeps.checkRunnerUsableByRepo`'s own
 * "never throws by contract" discipline) — so a caller can never accidentally
 * let a provisioning hiccup crash `apply`. The caller (`apply-fleet.ts`) logs
 * every outcome loudly and continues regardless of status.
 *
 * ## Honest-unknown floor (Amendment A4, `silent-fallback-hazards.md`)
 *
 * `'not-configured'` (the endpoint env var is unset) and `'unreachable'`
 * (network/timeout/DNS) are DISTINCT statuses from `'ok'` — never conflated
 * with "no runner needed" or silently treated as success. Both are non-fatal
 * to `apply` (same as `'cluster-problem'`/`'contract-error'`/`'not-ready'`),
 * but the CALLER's log line must say WHICH shape happened, because the
 * remediation differs (set the env var vs. wait for the cluster).
 *
 * ## The endpoint is discoverable, never guessed (groundnuty/macf#1211)
 *
 * `RUNNER_PLATFORM_ENDPOINT_ENV_VAR` (`MACF_RUNNER_PLATFORM_ENDPOINT`) started
 * as an env-var-only resolution (the original shape of this module,
 * mirroring `reconciler/run.ts`'s `TEMPO_QUERY_ENDPOINT` for the identical
 * class of resource — an operator's specific monitoring VM's Tailscale
 * hostname). That shape had a real gap: the value lived ONLY in whichever
 * shell exported it, undeclared anywhere a second operator (or a future
 * session) could discover it — the exact "an input that lives in someone's
 * head" class `groundnuty/macf#1211` was filed against. Two facts from the
 * original design still hold and motivate the resolution chain below:
 *
 *   1. **It is operator infrastructure, not per-fleet desired state.**
 *      Unlike almost everything else in `fleet.yaml`, which tailnet node
 *      runs the runner-provisioning API is a fact about an operator's
 *      SCOPE (an org or account), not about any one fleet's shape — every
 *      fleet on that scope shares the same platform. That is why the
 *      **scope-level GitHub Actions variable** (an org/account "shared
 *      fleet information" variable, the SAME kind of storage the CA
 *      certificate's registry leg already uses) is the tier the operator
 *      ruled should carry the common case: set once per scope, every fleet
 *      — including ones that don't exist yet — inherits it for free.
 *   2. **No baked-in hostname, ever.** Unlike `api.github.com` (universal),
 *      this host is one operator's private tailnet address — hardcoding a
 *      default would silently point every consumer at THIS deployment's
 *      cluster, producing a confident failure against someone else's
 *      infrastructure. Every tier below can be absent; the resolver never
 *      guesses one.
 *
 * **The full precedence chain, most explicit wins** (see
 * {@link resolveRunnerPlatformEndpointWithProvenance}):
 *
 *   1. **flag** — an explicit per-run override (`FleetApplyDeps.
 *      runnerPlatformEndpoint`; a future `--runner-platform-endpoint` CLI
 *      flag would land here, mirroring `--runner-token`'s own shape, but is
 *      NOT built this round for the same reason the original doc gave:
 *      wiring a new flag touches `commands/bootstrap-apply.ts`, a much
 *      wider-blast-radius file under concurrent edit).
 *   2. **env** — `MACF_RUNNER_PLATFORM_ENDPOINT`, read directly from
 *      `process.env` (never injected — matches this module's original,
 *      still-live convention).
 *   3. **scope** — the fleet's `owner.registry` scope's shared Actions
 *      variable, same name (`MACF_RUNNER_PLATFORM_ENDPOINT`). **This is a
 *      VARIABLE, never a secret** — the operator's own ruling: a tailnet
 *      address's access control is reachability, not obscurity, so it is
 *      read with `observer.ts::readRegistryVariable` — the SAME credential
 *      path (and the SAME `gh api .../actions/variables/<name>` call
 *      shape) every other registry-scope variable read in this codebase
 *      already uses. No new auth path.
 *   4. **manifest** — `transport.runner_platform_endpoint` in `fleet.yaml`,
 *      an optional per-fleet escape hatch for the unusual case a fleet
 *      genuinely needs a DIFFERENT platform than its scope's shared one, or
 *      the scope variable has not been set yet. Lowest tier deliberately:
 *      the common path is zero per-fleet configuration once the scope
 *      variable exists.
 *   5. **none** — `'not-configured'`, honest and non-fatal (Amendment A4);
 *      see {@link callRunnerPlatform}.
 *
 * `FleetApplyDeps.runnerPlatformEndpoint`/`runnerPlatformFetch`/
 * `observedRunnerPlatformEndpointScope` are all optional and injectable so
 * tests never read `process.env` or touch the network — production leaves
 * `runnerPlatformFetch` unset (real global `fetch`) and threads the other
 * two through from a live resolution `commands/bootstrap-apply.ts` already
 * performed once (see that file's own doc for the `observedActionsPins`
 * precedent this mirrors).
 *
 * ## Teardown — deliberately unwired (Amendment I3/I5)
 *
 * The issue's own AC4 says teardown must call `DELETE` "after unsetting
 * MACF_TRUSTED_ACTORS, never before." That precondition does not exist yet —
 * `teardown.ts` (the `deactivate`/`archive` rungs) never touches
 * `MACF_TRUSTED_ACTORS` at all (verified: a full grep of that file for the
 * string returns nothing). Amendment I5 is explicit that this is not a
 * "wire it later" gap to leave half-closed: *"The rung and its ordering must
 * land in the same change"* — adding `runnerctl destroy` (here: `DELETE
 * /runners/...`) to `deactivate` WITHOUT the mandatory unset-first order
 * would open exactly the stall-door I3 exists to prevent (a partial failure
 * leaving `MACF_TRUSTED_ACTORS` pointed at a runner that no longer exists —
 * every routed job then queues to timeout with no natural signal). Building
 * the unset-var primitive, wiring it into `deactivate`'s target derivation,
 * proving the mandatory order, AND wiring THIS module's
 * {@link deprovisionRunner} — all in one change — is a materially larger,
 * separate task from the apply-side POST wiring this round covers. Tracked
 * as an explicit follow-up rather than a silent gap; see this session's
 * report on groundnuty/macf#943 for the citation.
 *
 * {@link deprovisionRunner} is built now anyway (it shares
 * {@link callRunnerPlatform} with {@link provisionRunner} — a few lines, not
 * a separate implementation effort) so the follow-up is "wire the ordering
 * and call this," never "also write the client."
 */

import type { RunnerOpsApplyOutcome } from './apply-runner-ops.js';

/** No baked-in default — see this module's doc, "The endpoint is discoverable, never guessed." */
export const RUNNER_PLATFORM_ENDPOINT_ENV_VAR = 'MACF_RUNNER_PLATFORM_ENDPOINT';

/** The credential shape `POST /runners` accepts, verbatim per `GET /`'s live doc (field names are the contract's own JSON keys, snake_case, NOT this codebase's camelCase convention — deliberately unconverted so a diff against the live contract stays legible). */
export interface RunnerPlatformCredentials {
  readonly app_id: string;
  readonly installation_id: string;
  /** The App's private-key PEM. Secret — never log. */
  readonly private_key: string;
}

/** `POST /runners` request body — `repo` is the only required field; every other field mirrors the contract's own optionality + defaults (see `GET /`'s live doc, quoted in this module's header comment). */
export interface ProvisionRunnerRequest {
  readonly repo: string;
  readonly labels?: readonly string[];
  readonly warm?: number;
  readonly max?: number;
  readonly fleet?: string;
  readonly credentials?: RunnerPlatformCredentials;
}

/**
 * Honest-unknown-floor result (Amendment A4) — every branch is a DISTINCT,
 * textually-identifiable status; nothing here collapses "unreachable" into
 * "not needed" or "ok". `'ok'` mirrors the contract's `200` — see this
 * module's doc for why that is NOT the same fact as "the runner is usable"
 * (Amendment I2's OTHER guard, `apply-routing.ts::checkRunnerUsableByRepo`,
 * is untouched by this module and remains the actual usability gate).
 */
export type RunnerPlatformResult =
  | { readonly status: 'ok'; readonly applied?: readonly string[] }
  | { readonly status: 'contract-error'; readonly reason: string }
  | { readonly status: 'not-ready'; readonly reason: string }
  | { readonly status: 'cluster-problem'; readonly reason: string }
  | { readonly status: 'unreachable'; readonly reason: string }
  | { readonly status: 'not-configured'; readonly reason: string };

/** Empty-or-whitespace collapses to `undefined`; trailing slashes stripped so path-joining in {@link callRunnerPlatform} never double-slashes. Shared by every tier below so "unset" means the same thing regardless of WHICH tier supplied the raw candidate. */
function normalizeEndpointValue(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw.replace(/\/+$/, '');
}

/**
 * `explicit ?? process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR]`, normalized —
 * the ORIGINAL two-tier (flag/deps-override, then env) resolution this
 * module shipped with. Still exported and still used internally by
 * {@link resolveRunnerPlatformEndpointWithProvenance} (its top two tiers are
 * exactly this function's own logic) — kept as its own named export because
 * it is the simplest correct answer for a caller that only needs a VALUE,
 * never needs to report WHICH tier supplied it, and has no scope/manifest
 * candidate to offer (there is no other current caller of this narrower
 * form; {@link resolveRunnerPlatformEndpointWithProvenance} is what
 * `apply-fleet.ts`/`observer.ts` actually call as of groundnuty/macf#1211).
 */
export function resolveRunnerPlatformEndpoint(explicit: string | undefined): string | undefined {
  return normalizeEndpointValue(explicit) ?? normalizeEndpointValue(process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR]);
}

/**
 * Which precedence tier actually supplied the resolved value — groundnuty/
 * macf#1211's "plan names which source supplied it" requirement. `'flag'`
 * and `'env'` are reported distinctly even though they resolve through the
 * SAME `resolveRunnerPlatformEndpoint` call internally (see
 * {@link resolveRunnerPlatformEndpointWithProvenance}) — an operator reading
 * a plan/apply log line needs to know WHICH of the two to go change, not
 * just that "an override" won.
 */
export type RunnerPlatformEndpointSource = 'flag' | 'env' | 'scope' | 'manifest' | 'none';

/** The resolved value (if any) paired with the tier that supplied it — never a secret shape (see this module's doc); safe to print verbatim in plan/apply output. */
export interface RunnerPlatformEndpointResolution {
  readonly value: string | undefined;
  readonly source: RunnerPlatformEndpointSource;
}

/**
 * The full groundnuty/macf#1211 precedence chain — flag/deps-override, then
 * `MACF_RUNNER_PLATFORM_ENDPOINT` (env), then the fleet's registry-scope
 * shared Actions variable, then `transport.runner_platform_endpoint` in
 * `fleet.yaml`, then `'none'`. PURE — every candidate is already resolved by
 * the caller (an async scope-variable read, `process.env`, the parsed
 * manifest) and handed in as a plain string; this function does no I/O
 * itself, matching `plan.ts::computePlan`'s own "pure, no I/O" discipline so
 * both `observer.ts` (plan-time) and `apply-fleet.ts` (apply-time) can share
 * ONE precedence rule without either duplicating it or forcing the other to
 * mock a network call it doesn't need.
 */
export function resolveRunnerPlatformEndpointWithProvenance(candidates: {
  readonly explicit: string | undefined;
  readonly manifestValue: string | undefined;
  readonly scopeValue: string | undefined;
}): RunnerPlatformEndpointResolution {
  const flag = normalizeEndpointValue(candidates.explicit);
  if (flag !== undefined) return { value: flag, source: 'flag' };
  const env = normalizeEndpointValue(process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR]);
  if (env !== undefined) return { value: env, source: 'env' };
  const scope = normalizeEndpointValue(candidates.scopeValue);
  if (scope !== undefined) return { value: scope, source: 'scope' };
  const manifest = normalizeEndpointValue(candidates.manifestValue);
  if (manifest !== undefined) return { value: manifest, source: 'manifest' };
  return { value: undefined, source: 'none' };
}

const RUNNER_PLATFORM_ENDPOINT_SOURCE_LABEL: Readonly<Record<Exclude<RunnerPlatformEndpointSource, 'none'>, string>> = {
  flag: 'an explicit override supplied for this run',
  env: `the ${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} environment variable`,
  scope: "the scope's shared fleet variable (an org/account Actions variable — not a secret)",
  manifest: 'transport.runner_platform_endpoint in fleet.yaml',
};

/**
 * Human-readable rendering of a {@link RunnerPlatformEndpointResolution} —
 * shared by `apply-fleet.ts`'s log line and `plan.ts`'s plan item so the two
 * surfaces never describe the same fact in two different sentences. The
 * resolved VALUE (a tailnet URL) is printed verbatim, never redacted — the
 * operator's own ruling on groundnuty/macf#1211 is that this is a variable,
 * not a secret; reachability is the access control, not obscurity.
 */
export function describeRunnerPlatformEndpointResolution(resolution: RunnerPlatformEndpointResolution): string {
  if (resolution.source === 'none') {
    return (
      'not resolved — none of an explicit override, the ' +
      `${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} environment variable, the scope's shared fleet variable, or ` +
      'transport.runner_platform_endpoint in fleet.yaml is set'
    );
  }
  return `resolved via ${RUNNER_PLATFORM_ENDPOINT_SOURCE_LABEL[resolution.source]}: ${resolution.value ?? ''}`;
}

/** Injectable seam — production (`apply-fleet.ts`) leaves `fetchImpl` unset (real global `fetch`) and resolves `endpoint` via {@link resolveRunnerPlatformEndpointWithProvenance}'s `.value`; tests always inject both, so the suite never touches the network or `process.env`. */
export interface RunnerPlatformDeps {
  readonly endpoint: string | undefined;
  readonly fetchImpl?: typeof fetch;
  /** Default 15s — mirrors `reconciler/run.ts`'s Tempo-query timeout, the closest precedent for a tailnet-endpoint call in this codebase. */
  readonly timeoutMs?: number;
}

/** `err.cause` carries the real diagnosis on an undici `fetch` failure (`err.message` is always the opaque literal `"fetch failed"`) — same extraction `reconciler/run.ts::fetchProcessed` already uses for the identical class of tailnet-endpoint call. */
function fetchFailureDetail(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}

function extractBodyError(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const errorField = (parsed as { error?: unknown }).error;
  return typeof errorField === 'string' ? errorField : undefined;
}

function extractApplied(parsed: unknown): readonly string[] | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const appliedField = (parsed as { applied?: unknown }).applied;
  if (!Array.isArray(appliedField)) return undefined;
  return appliedField.filter((x): x is string => typeof x === 'string');
}

/**
 * The shared HTTP call — POST (with a JSON body) or DELETE (bare) against
 * one path. NEVER throws (see this module's doc, "Non-fatal, by contract").
 */
async function callRunnerPlatform(deps: RunnerPlatformDeps, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<RunnerPlatformResult> {
  if (deps.endpoint === undefined) {
    return {
      status: 'not-configured',
      reason:
        `${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} is not set — the runner-provisioning contract is tailnet-only with ` +
        'no baked-in default. Non-fatal: continuing without a provisioning attempt for this repo.',
    };
  }
  const fetchFn = deps.fetchImpl ?? fetch;
  const url = `${deps.endpoint}${path}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { status: 'unreachable', reason: `${method} ${url} unreachable — ${fetchFailureDetail(err)}. Non-fatal: continuing.` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  const bodyError = extractBodyError(parsed);
  // Status codes per GET /'s live "Status codes — branch on these" table
  // (200/400/404/502); anything else is treated the same as 502 — a cluster
  // problem the contract's own doc doesn't enumerate, still non-fatal.
  switch (res.status) {
    case 200:
      return { status: 'ok', ...(extractApplied(parsed) !== undefined ? { applied: extractApplied(parsed) } : {}) };
    case 400:
      return { status: 'contract-error', reason: bodyError ?? `HTTP 400 from ${url}` };
    case 404:
      return { status: 'not-ready', reason: bodyError ?? `HTTP 404 from ${url}` };
    case 502:
      return { status: 'cluster-problem', reason: bodyError ?? `HTTP 502 from ${url} — cluster problem. Non-fatal: continuing.` };
    default:
      return { status: 'cluster-problem', reason: bodyError ?? `HTTP ${String(res.status)} from ${url} (unexpected status). Non-fatal: continuing.` };
  }
}

/**
 * `POST /runners` — create-or-update, idempotent (see this module's doc).
 * Callable unconditionally, every `apply` run, for every confirmed self-
 * hosted-runner repo — there is no does-it-exist check to perform first.
 */
export function provisionRunner(deps: RunnerPlatformDeps, request: ProvisionRunnerRequest): Promise<RunnerPlatformResult> {
  return callRunnerPlatform(deps, 'POST', '/runners', request);
}

/**
 * `DELETE /runners/{owner}/{repo}` — symmetric to {@link provisionRunner}.
 * **No caller yet** — see this module's doc, "Teardown — deliberately
 * unwired," for why wiring this into `deactivate` is a separate follow-up,
 * not a gap left open by oversight. `repo` takes the SAME `"owner/name"`
 * shape every other repo string in this codebase uses (e.g. `FleetAgent.
 * repo`) — split internally, so a future caller never has to.
 */
export function deprovisionRunner(deps: RunnerPlatformDeps, repo: string): Promise<RunnerPlatformResult> {
  return callRunnerPlatform(deps, 'DELETE', `/runners/${repo}`);
}

// --- groundnuty/macf#1212: GET /runners/{owner}/{repo} — "is it up?" ---
//
// The operator's ruling on #1212 requires `apply` to WAIT for a runner it
// just told this contract to provision, unconditionally (no longer gated on
// `--runner-token`). A bounded wait needs two things this module's existing
// two verbs (POST/DELETE) don't provide: a live readiness read, AND a way to
// tell "still starting" apart from "will never start" — the issue's own
// measured example ("NOT starting: FailedUpdateRegistrationToken... this is
// not a startup delay — polling will not clear it") is a state no amount of
// re-polling resolves.
//
// **Verified live, not guessed** (2026-08-26, same tailnet host this
// module's header cites) — three real response shapes:
//
//   GET /runners/{owner}/{repo}  (ready)
//     200 { "ok": true, "repo": "...", "name": "...", "available": 1,
//           "note": "cluster-side only — confirm usability via GET
//           /repos/.../actions/runners before routing to it" }
//
//   GET /runners/{owner}/{repo}  (provisioned, not yet up, no failure logged)
//     404 { "ok": false, "repo": "...", "name": "...", "available": 0,
//           "note": "..." }                              -- NO `failure` key
//
//   GET /runners/{owner}/{repo}  (a genuinely terminal state)
//     404 { "ok": false, "repo": "...", "name": "...", "available": 0,
//           "note": "NOT starting: FailedUpdateRegistrationToken. This is
//           not a startup delay — polling will not clear it. ...",
//           "failure": { "reason": "FailedUpdateRegistrationToken",
//                         "message": "Updating registration token failed",
//                         "at": "2026-08-26T11:35:47Z", "count": 13916 } }
//
//   GET /runners/{owner}/{repo}  (never provisioned at all)
//     404 { "ok": false, "repo": "...", "error": "not provisioned" }
//
// The discriminator between "still starting" and "terminal" is the
// PRESENCE of the `failure` object, not the HTTP status (both non-ready
// shapes are 404 — this contract's status-code table only documents
// 200/400/404/502, deliberately coarser than the body). A response that
// carries `failure` is terminal; one that doesn't (whether or not `name`/
// `available` are present) is an honest "not yet" — this function never
// invents a THIRD bucket for "never provisioned at all" vs. "provisioned,
// not up yet": both are equally "nothing to wait past" from THIS
// function's point of view, and the caller (this run itself, having just
// POSTed) already knows which one it is.
//
// **Advisory only — this is deliberately NOT the readiness gate that
// licenses writing `MACF_TRUSTED_ACTORS`.** That gate stays
// `observer.ts::checkRunnerUsableByRepo` (GitHub's own runner list) exactly
// as macf#922/#1195 left it — this module's own header doc already warns
// "a pod can be running while GitHub has no usable runner registered...
// confirm against GitHub before you route anything to it." This function
// feeds a wait loop's progress narration and its terminal fast-exit only;
// an unparseable/unreachable/unconfigured response degrades to `'unknown'`
// (never a fabricated `'ready'` or `'failed'`) and the wait loop simply
// keeps trusting the GitHub-side check on its own schedule.
export type RunnerPlatformStatusResult =
  | { readonly status: 'ready'; readonly available: number }
  | { readonly status: 'starting'; readonly available: number }
  | { readonly status: 'failed'; readonly reason: string; readonly message: string }
  | { readonly status: 'unknown'; readonly reason: string };

function extractNumber(parsed: unknown, key: string): number | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function extractFailure(parsed: unknown): { readonly reason: string; readonly message: string } | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const failure = (parsed as { failure?: unknown }).failure;
  if (failure === null || typeof failure !== 'object') return undefined;
  const reason = (failure as Record<string, unknown>).reason;
  const message = (failure as Record<string, unknown>).message;
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  return { reason, message: typeof message === 'string' && message.length > 0 ? message : reason };
}

/**
 * `GET /runners/{owner}/{repo}` — see this section's doc above for the
 * verified shapes. NEVER throws (same "non-fatal by contract" discipline
 * {@link callRunnerPlatform} already carries) — every failure path
 * (endpoint unset, network error, an unparseable/unexpected body) degrades
 * to `'unknown'` rather than a fabricated ready/starting/failed verdict, per
 * this module's honest-unknown floor (Amendment A4).
 */
export async function checkRunnerPlatformStatus(deps: RunnerPlatformDeps, repo: string): Promise<RunnerPlatformStatusResult> {
  if (deps.endpoint === undefined) {
    return { status: 'unknown', reason: `${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} is not set — no platform-side status to report.` };
  }
  const fetchFn = deps.fetchImpl ?? fetch;
  const url = `${deps.endpoint}/runners/${repo}`;
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
  } catch (err) {
    return { status: 'unknown', reason: `GET ${url} unreachable — ${fetchFailureDetail(err)}.` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { status: 'unknown', reason: `GET ${url} returned a non-JSON body (HTTP ${String(res.status)}).` };
  }
  const available = extractNumber(parsed, 'available') ?? 0;
  if (res.status === 200) return { status: 'ready', available };
  if (res.status === 404) {
    const failure = extractFailure(parsed);
    if (failure !== undefined) return { status: 'failed', ...failure };
    return { status: 'starting', available };
  }
  return { status: 'unknown', reason: `GET ${url} returned HTTP ${String(res.status)} (unexpected for a status read).` };
}

/**
 * The runner-ops App's credential — TWO sources, because `GET /`'s own doc
 * is unambiguous that omitting one is not a neutral choice: *"Send it on
 * every provision... this service can write credentials and deliberately
 * cannot read them back... so it cannot tell you whether one is already
 * stored."* A credential-less `POST` therefore is NOT "same as before" on a
 * REUSED run — it is the contract falling back to its OWN App, "which only
 * works for one account" (almost never the fleet's). This was the run-2
 * regression an earlier increment of this module left as an open question
 * (does a credential-less POST touch the stored credential at all?) instead
 * of resolving — the doc above answers it: don't find out, always send one
 * when this run has ANY way to.
 *
 *   1. **Freshly minted THIS run** (`status === 'created'`) — the
 *      private-key PEM is already in process memory (`AgentApplyOutcome`'s
 *      `created` variant carries `credentials.pem` directly). No I/O.
 *   2. **`'reused'`/`'resumed-install'`** (the App already existed from a
 *      prior run) — `outcome` itself carries only `appId`/`installId`, but
 *      `apply-fleet.ts::resolveRunnerOpsVaultPem` can supply the PEM as an
 *      optional second argument here, sourced from the SAME vault-backed
 *      `AgentApplyDeps.resolveKeyPath` closure that already confirmed this
 *      reuse is real (only present when the operator supplied
 *      `--vault`/`--identity-key` THIS run AND the vault actually holds this
 *      role's key — see that function's doc for the full fallback chain).
 *
 * Every OTHER shape (`'skipped-unverified'`/`'drift'`/`'failed'`/
 * `'not-needed'`, or a `'reused'`/`'resumed-install'` outcome with no vault
 * PEM available) yields `undefined`, honestly — the caller (`apply-fleet.ts`)
 * logs WHY and the provisioning call proceeds credential-less rather than
 * refusing (Amendment I2: non-fatal).
 */
export function runnerPlatformCredentialsFromOutcome(outcome: RunnerOpsApplyOutcome, vaultPem?: string): RunnerPlatformCredentials | undefined {
  if (outcome.status === 'created') {
    return { app_id: outcome.appId, installation_id: outcome.installId, private_key: outcome.credentials.pem };
  }
  if ((outcome.status === 'reused' || outcome.status === 'resumed-install') && vaultPem !== undefined) {
    return { app_id: outcome.appId, installation_id: outcome.installId, private_key: vaultPem };
  }
  return undefined;
}
