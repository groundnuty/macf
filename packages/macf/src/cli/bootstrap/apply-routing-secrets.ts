/**
 * The unified 6-secret routing publish — groundnuty/macf#1074, "a
 * declaratively-provisioned fleet cannot route while a hand-built one can."
 *
 * `macf-actions`' `agent-router.yml` declares SIX secrets as REQUIRED
 * `workflow_call` inputs (verified by fetching that file off `main`:
 * `gh api repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml`).
 * `apply-routing-client.ts` (groundnuty/macf#920/#986) already mints +
 * publishes TWO of them (`ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY`). This
 * module is the ONE place the OTHER four join them — `MACF_ROUTING_APP_ID`/
 * `MACF_ROUTING_APP_KEY` (the dedicated per-fleet router App,
 * `apply-router-app.ts`) and `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`
 * (operator-provided via the vault, Amendment C) — so the whole fleet is
 * published through exactly ONE per-repo emission, never a second publisher
 * (the task's hard constraint, and the shape that makes the decisive test
 * possible: asserting "all six secret names landed," not "two publish
 * calls each ran," which is precisely the aggregation gap that let a
 * two-of-six fleet ship green).
 *
 * **A live encoding bug this module fixes, found while implementing
 * #1074's decisive test (assert VALUE shape per name, not just that a
 * name exists).** `agent-router.yml`'s own consumption of the two secrets
 * `apply-routing-client.ts` already publishes:
 *
 * ```
 * echo "$ROUTING_CLIENT_CERT" | base64 -d > "$TMPDIR/c.pem"
 * echo "$ROUTING_CLIENT_KEY"  | base64 -d > "$TMPDIR/k.pem"
 * ```
 *
 * — expects BASE64 (matches `SKILL.md`'s own documented value format:
 * "`ROUTING_CLIENT_CERT` | base64 of `routing-action-cert.pem`"). But
 * `apply-routing-client.ts::publishRoutingClientSecrets` (retired by this
 * module) passed `secrets.certPem`/`secrets.keyPem` — RAW PEM text, from
 * BOTH its sources: `mintRoutingClientCert` returns raw PEM
 * (`generateClientCert` → `cert.toString('pem')`), and
 * `vaultRoutingClientCertPem`/`vaultRoutingClientKeyPem` explicitly
 * base64-DECODE the vault's `_B64` storage form back to raw PEM before
 * returning. Every repo #1073 published to therefore got the WRONG-VALUED
 * secret — `base64 -d` on a `-----BEGIN CERTIFICATE-----` line (which
 * contains `-`, not in the base64 alphabet) fails under the router job's
 * `set -euo pipefail`, so routing would have stayed dead even once all six
 * NAMES were present. Fixed here by base64-encoding at the resolution
 * boundary (see {@link routingClientValueFromOutcome}) — the two already-
 * shipped secrets get corrected the same run this module first publishes
 * the other four, since both flow through this ONE publisher now.
 *
 * **Per-field encoding, verified against `SKILL.md`'s explicit asymmetry
 * callout and the workflow's own consumption:**
 *
 *   | secret                | repo-secret encoding | source                          |
 *   |------------------------|----------------------|----------------------------------|
 *   | `MACF_ROUTING_APP_ID`  | raw (numeric string) | router App id (created/restored) |
 *   | `MACF_ROUTING_APP_KEY` | RAW PEM (NOT base64) | router App key (created/restored)|
 *   | `ROUTING_CLIENT_CERT`  | base64                | routing-client cert (mint/vault) |
 *   | `ROUTING_CLIENT_KEY`   | base64                | routing-client key (mint/vault)  |
 *   | `TS_OAUTH_CLIENT_ID`   | raw                   | vault (operator-supplied)         |
 *   | `TS_OAUTH_SECRET`      | raw                   | vault (operator-supplied)         |
 *
 * `apply-fleet.ts` resolves each of the six independently (a router App
 * created/reused/failed this run; a routing-client cert minted/restored/
 * unavailable; Tailscale declared-and-present/declared-and-absent/
 * undeclared) and calls {@link publishRoutingSecrets} exactly ONCE with the
 * resolved bag — a repo missing a value it needs reports a loud `'failed'`
 * leg (never a silent `'skipped'`) via {@link ensureVariableCreated}'s
 * existing create-only contract; a repo the fleet hasn't declared Tailscale
 * for reports an honest `'skipped'` (the value was never determined THIS
 * run, not refused).
 */
import type { Presence } from './plan.js';
import type { EnsureVariableDeps, EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, skippedOutcomesFor } from './ensure-variable.js';
import { ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME } from './apply-routing-client.js';

/** The router App's identity — raw numeric-string App ID. */
export const ROUTING_APP_ID_SECRET_NAME = 'MACF_ROUTING_APP_ID';
/** The router App's private key — RAW PEM (NOT base64) per `SKILL.md`'s asymmetry callout + `agent-router.yml`'s direct `actions/create-github-app-token` consumption (that action wants a raw PEM, unlike the two `ROUTING_CLIENT_*` secrets the router job itself base64-decodes by hand). */
export const ROUTING_APP_KEY_SECRET_NAME = 'MACF_ROUTING_APP_KEY';
/** Operator-supplied Tailscale OAuth client ID (Amendment C — never tool-minted). */
export const TS_OAUTH_CLIENT_ID_SECRET_NAME = 'TS_OAUTH_CLIENT_ID';
/** Operator-supplied Tailscale OAuth secret (Amendment C — never tool-minted). */
export const TS_OAUTH_SECRET_SECRET_NAME = 'TS_OAUTH_SECRET';

/**
 * The exact six secret names `agent-router.yml` declares as REQUIRED
 * `workflow_call` secrets — the single enumeration the decisive test
 * asserts against, and the ONLY place this list is written down (every
 * other reference in this module derives from it, never re-enumerates).
 */
export const ALL_ROUTING_SECRET_NAMES = [
  ROUTING_APP_ID_SECRET_NAME,
  ROUTING_APP_KEY_SECRET_NAME,
  ROUTING_CLIENT_CERT_SECRET_NAME,
  ROUTING_CLIENT_KEY_SECRET_NAME,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
] as const;

export type RoutingSecretName = (typeof ALL_ROUTING_SECRET_NAMES)[number];

/**
 * One secret's resolved value for THIS run, or an honest reason it isn't
 * available — never a fabricated placeholder. `value` is ALREADY in the
 * exact byte-form the repo secret needs (encoding applied at resolution
 * time, per the module doc's per-field encoding table) — this module's
 * {@link publishRoutingSecrets} never transforms a value, only transports
 * it.
 *
 * **Three states, not two — `'not-required'` is DISTINCT from
 * `'unavailable'` (groundnuty/macf#1074).** Both describe "no value in
 * hand this run," but they answer different questions and
 * {@link publishRoutingSecrets} treats them differently on a repo that
 * lacks the secret:
 *
 *   - `'unavailable'` — this run SHOULD have been able to provide the
 *     value (it was declared/expected) but couldn't (mint failed, vault
 *     restore came up empty, identity unresolved). A repo missing it is a
 *     genuine gap — LOUD `'failed'`, never silent.
 *   - `'not-required'` — this run was never ASKED to provide the value
 *     (e.g. `transport.tailscale_oauth_required` is `false` — the
 *     operator hasn't set up Tailscale for this fleet yet). A repo
 *     missing it is the EXPECTED, honest state — `'skipped'`, never
 *     `'failed'`. Without this distinction, every fleet that hasn't
 *     declared Tailscale yet would fail `apply` outright the moment any
 *     OTHER of the six secrets needed a fresh presence check — conflating
 *     "not ready yet" with "broken."
 *
 * Both still run `checkPresence` (the #986 "never blanket-skip" discipline
 * applies to `'not-required'` too — a repo that happens to already HAVE
 * the secret reports `'already-present'`, not a groundless `'skipped'`);
 * only the ABSENT-repo outcome differs.
 */
export type RoutingSecretResolution =
  | { readonly status: 'available'; readonly value: string }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'not-required'; readonly reason: string };

/** The resolved (or honestly-unavailable) value for EVERY one of the six secrets — what `apply-fleet.ts` assembles before calling {@link publishRoutingSecrets} exactly once. */
export type RoutingSecretsForPublish = Readonly<Record<RoutingSecretName, RoutingSecretResolution>>;

/** Per-secret, per-repo outcome — `result[name][repo]`. The decisive shape for #1074's test: asserting `Object.keys(result)` is exactly the six names (never silently two) AND that every declared repo has an entry under every name (never silently four-of-six repos, or four-of-six names). */
export type RoutingSecretsPublishResult = Readonly<Record<RoutingSecretName, Readonly<Record<string, EnsureVariableOutcome>>>>;

export interface RoutingSecretsPublishDeps {
  readonly checkRepoSecretPresence: (repo: string, name: string) => Promise<Presence>;
  readonly setRepoSecret: (repo: string, name: string, value: string) => Promise<void>;
}

/**
 * Base64-encode a raw PEM/text value for a repo secret that the router job
 * consumes via `base64 -d` — the fix for the encoding bug this module's doc
 * describes. `Buffer.from(value, 'utf-8').toString('base64')` — PEM text is
 * ASCII by construction, same encoding assumption `vault-write.ts::toBase64`
 * already makes for the identical byte class.
 */
export function toBase64ForSecret(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * Create-only per-repo deploy of ALL SIX routing secrets — the ONE
 * publisher (module doc's hard constraint). ALWAYS runs the
 * presence-check-then-maybe-create loop for EVERY given repo and EVERY one
 * of the six names, regardless of the resolution status — mirrors
 * `apply-routing-client.ts`'s (retired) per-repo idempotent-loop contract:
 * a repo already holding a secret reports `'already-present'`, for ANY
 * resolution status (including `'not-required'` — the #986 "never
 * blanket-skip" discipline is unconditional on presence, never on need).
 * For an ABSENT repo, the resolution status decides the outcome:
 *
 *   - `'available'` — created.
 *   - `'unavailable'` — a LOUD `'failed'` carrying the honest reason
 *     (never a silent `'skipped'` for a secret this run SHOULD have been
 *     able to provide — `ensureVariableCreated`'s create-only semantics,
 *     reused verbatim).
 *   - `'not-required'` — `'skipped'`, carrying the reason, WITHOUT ever
 *     invoking `create()` (so it never throws, never becomes `'failed'`) —
 *     see {@link RoutingSecretResolution}'s doc for why this third case
 *     exists.
 *
 * Never logs a secret value — `deps.setRepoSecret`'s own contract (the
 * value is piped to `gh secret set`'s STDIN, per
 * `apply-routing-client.ts::realSetRepoSecret`'s doc, reused unchanged by
 * `apply-fleet.ts`'s wiring); this function only ever handles opaque
 * `RoutingSecretResolution.value` strings, never inspecting or
 * transforming them.
 */
export async function publishRoutingSecrets(
  secrets: RoutingSecretsForPublish,
  repos: readonly string[],
  deps: RoutingSecretsPublishDeps,
): Promise<RoutingSecretsPublishResult> {
  const result = {} as Record<RoutingSecretName, Record<string, EnsureVariableOutcome>>;
  for (const name of ALL_ROUTING_SECRET_NAMES) result[name] = {};

  for (const repo of repos) {
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      const resolution = secrets[name];
      if (resolution.status === 'not-required') {
        const presence = await deps.checkRepoSecretPresence(repo, name);
        result[name][repo] = presence === 'present' ? { status: 'already-present' } : { status: 'skipped', reason: resolution.reason };
        continue;
      }
      const legDeps: EnsureVariableDeps = {
        checkPresence: () => deps.checkRepoSecretPresence(repo, name),
        create: async () => {
          if (resolution.status !== 'available') throw new Error(resolution.reason);
          await deps.setRepoSecret(repo, name, resolution.value);
          return 'created';
        },
      };
      result[name][repo] = await ensureVariableCreated(legDeps, `routing secret "${name}" on "${repo}"`);
    }
  }
  return result;
}

/**
 * The `RoutingSecretsPublishResult` shape for "never attempted this run" —
 * mirrors `apply-ca.ts::skippedCaPublish` / the retired
 * `apply-routing-client.ts::skippedRoutingClientPublish`. Used by
 * `apply-fleet.ts` for the ordering-safety case: a router App or
 * routing-client cert freshly minted THIS run but the batched vault write
 * hasn't landed yet (deploying an unvaulted export-class key would recreate
 * the #799 orphan-cert class) — every one of the six legs, for every repo,
 * reports the SAME skip reason, honest and uniform.
 */
export function skippedRoutingSecretsPublish(repos: readonly string[], reason: string): RoutingSecretsPublishResult {
  const result = {} as Record<RoutingSecretName, Record<string, EnsureVariableOutcome>>;
  for (const name of ALL_ROUTING_SECRET_NAMES) result[name] = skippedOutcomesFor(repos, reason);
  return result;
}

// --- The single bundled routing secret (groundnuty/macf#1112) ---
//
// `secrets: inherit` does not cross a GitHub org/enterprise scope boundary
// (GitHub's own docs: inherit only carries "in the same organization or
// enterprise" as the caller) — confirmed live on groundnuty/macf#1111: an
// org-owned fleet's caller failed at secret evaluation before any step ran.
// A caller in a dedicated org (the operator's stated future direction —
// "we will be creating fleets and dedicated organizations") cannot inherit
// macf-actions' secrets, and re-listing all six explicit names in every
// generated caller just defers the problem: a caller generated today lists
// six names, and a router that later needs a seventh fails on that STALE
// caller with the exact same error. The bundle removes the coupling rather
// than restating it — the caller's interface stops depending on the
// callee's secret set.
//
// `MACF_ROUTING_BUNDLE` is `base64(JSON)` of the same six values
// `publishRoutingSecrets` already resolves, keyed by their own secret
// names — single-line, opaque, and shell-safe (no embedded newlines or
// shell metacharacters at the top level; base64's own alphabet is safe
// for any downstream `${{ }}`/shell context), matching the encoding idiom
// `toBase64ForSecret` already uses for the routing-client cert/key pair.

/** The one secret name a bundle-capable generated caller passes, permanently — see `repo-init.ts::isBundleCapableActionsVersion` for the version gate that decides when a caller emits this form instead of `secrets: inherit`. */
export const ROUTING_BUNDLE_SECRET_NAME = 'MACF_ROUTING_BUNDLE';

/**
 * Pack all six resolved values into the bundle's wire form:
 * `base64(JSON.stringify({ <name>: <value>, ... }))`. Each value is passed
 * through UNCHANGED — `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` stay
 * base64-of-PEM (the per-field encoding table `apply-routing-secrets.ts`'s
 * module doc documents), `MACF_ROUTING_APP_KEY` stays raw multi-line PEM.
 * The JSON layer is a CONTAINER, never a re-encoding of the leaf values —
 * so `agent-router.yml`'s existing `echo "$ROUTING_CLIENT_CERT" | base64 -d`
 * consumption needs no change once a value is unpacked out of the bundle.
 */
export function packRoutingBundle(values: Readonly<Record<RoutingSecretName, string>>): string {
  const ordered: Record<string, string> = {};
  for (const name of ALL_ROUTING_SECRET_NAMES) ordered[name] = values[name];
  return Buffer.from(JSON.stringify(ordered), 'utf-8').toString('base64');
}

/**
 * Inverse of {@link packRoutingBundle} — decode + parse + validate every one
 * of the six keys is present as a non-empty string. Throws (never returns a
 * partial result) on malformed base64, malformed JSON, or ANY missing/empty
 * key, naming exactly which — the same "fail LOUD naming the missing one"
 * bar the reusable workflow's own bundle-unpack step (macf-actions#1112)
 * holds itself to, so a bug here can't silently regress into the "bundle
 * present but missing a key" trap the design was reviewed against.
 */
export function unpackRoutingBundle(bundle: string): Record<RoutingSecretName, string> {
  let json: string;
  try {
    json = Buffer.from(bundle, 'base64').toString('utf-8');
  } catch (err) {
    throw new Error(`${ROUTING_BUNDLE_SECRET_NAME} is not valid base64: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`${ROUTING_BUNDLE_SECRET_NAME} decoded but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${ROUTING_BUNDLE_SECRET_NAME} JSON is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const missing: string[] = [];
  const result = {} as Record<RoutingSecretName, string>;
  for (const name of ALL_ROUTING_SECRET_NAMES) {
    const value = record[name];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push(name);
      continue;
    }
    result[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(`${ROUTING_BUNDLE_SECRET_NAME} is missing required key(s): ${missing.join(', ')}`);
  }
  return result;
}

/**
 * Compose + create-only publish the ONE bundled routing secret, alongside
 * (never instead of) the six individual secrets `publishRoutingSecrets`
 * already handles — additive, per the design's hard requirement: existing
 * callers on `secrets: inherit` or explicit-six keep working untouched, and
 * a repo simply carries BOTH forms so either a legacy or a bundle-capable
 * caller finds what it needs.
 *
 * The bundle can only be correctly composed when ALL SIX resolutions are
 * `'available'` this run — Amendment D's whole-payload-writable contract
 * (never partial-write a value whose gap is unrecoverable once written).
 * Mirrors {@link RoutingSecretResolution}'s own two-state "no value in
 * hand" distinction, lifted to the aggregate — but the presence check
 * ALWAYS runs first, per repo, exactly like `publishRoutingSecrets`'s own
 * per-name loop (groundnuty/macf#986's "never blanket-skip" discipline,
 * lifted to the aggregate too): a repo that already HAS the bundle is
 * `'already-present'` regardless of whether THIS run could recompute it —
 * composability only decides the ABSENT-repo outcome:
 *
 *   - repo already has `MACF_ROUTING_BUNDLE` → `'already-present'`,
 *     UNCONDITIONALLY (never overwritten — same NOOP-on-present limitation
 *     the six individual secrets already accept; see this module's doc
 *     for why a value-correctness fix doesn't retroactively repair an
 *     already-written secret).
 *   - repo is absent it AND any leg `'unavailable'` → `'failed'` (a real
 *     gap this run should have been able to fill — never a silent skip).
 *   - repo is absent it, no leg `'unavailable'`, but at least one
 *     `'not-required'` (e.g. Tailscale not yet declared) → `'skipped'`
 *     (honest not-ready-yet, same bar the individual leg itself uses).
 *   - repo is absent it, all six `'available'` → compose + create.
 */
export async function publishRoutingBundle(
  secrets: RoutingSecretsForPublish,
  repos: readonly string[],
  deps: RoutingSecretsPublishDeps,
): Promise<Readonly<Record<string, EnsureVariableOutcome>>> {
  const unavailable = ALL_ROUTING_SECRET_NAMES.filter((name) => secrets[name].status === 'unavailable');
  const notRequired = ALL_ROUTING_SECRET_NAMES.filter((name) => secrets[name].status === 'not-required');

  // Compose the value ONLY when every leg is actually available — never
  // eagerly build a partial bundle just because we might not need it.
  let bundleValue: string | undefined;
  if (unavailable.length === 0 && notRequired.length === 0) {
    const values = {} as Record<RoutingSecretName, string>;
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      values[name] = (secrets[name] as { readonly status: 'available'; readonly value: string }).value;
    }
    bundleValue = packRoutingBundle(values);
  }

  const result: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    if (bundleValue !== undefined) {
      const legDeps: EnsureVariableDeps = {
        checkPresence: () => deps.checkRepoSecretPresence(repo, ROUTING_BUNDLE_SECRET_NAME),
        create: async () => {
          await deps.setRepoSecret(repo, ROUTING_BUNDLE_SECRET_NAME, bundleValue);
          return 'created';
        },
      };
      result[repo] = await ensureVariableCreated(legDeps, `routing secret "${ROUTING_BUNDLE_SECRET_NAME}" on "${repo}"`);
      continue;
    }
    // Not composable this run — but ALWAYS check presence first: a repo
    // that already carries a bundle from an earlier run is untouched
    // regardless of whether THIS run could recompute one.
    const presence = await deps.checkRepoSecretPresence(repo, ROUTING_BUNDLE_SECRET_NAME);
    if (presence === 'present') {
      result[repo] = { status: 'already-present' };
      continue;
    }
    if (unavailable.length > 0) {
      const reasons = unavailable.map((name) => `${name}: ${(secrets[name] as { readonly reason: string }).reason}`).join('; ');
      result[repo] = { status: 'failed', reason: `cannot compose ${ROUTING_BUNDLE_SECRET_NAME} — ${reasons}` };
    } else {
      const reasons = notRequired.map((name) => `${name}: ${(secrets[name] as { readonly reason: string }).reason}`).join('; ');
      result[repo] = { status: 'skipped', reason: `cannot compose ${ROUTING_BUNDLE_SECRET_NAME} yet — ${reasons}` };
    }
  }
  return result;
}

/** The bundle-publish sibling of {@link skippedRoutingSecretsPublish} — same "never attempted this run" shape, single-secret-name form. */
export function skippedRoutingBundlePublish(repos: readonly string[], reason: string): Readonly<Record<string, EnsureVariableOutcome>> {
  return skippedOutcomesFor(repos, reason);
}

// --- Tailscale-declared refuse-before-gate-1 preflight (groundnuty/macf#1074) ---

export const TAILSCALE_OAUTH_MISSING_CODE = 'tailscale_oauth_missing';

/** The shape `commands/bootstrap-apply.ts::renderFailure` accepts — mirrors `apply-routing.ts::RunnerTokenPreflightFailure`'s doc for why this is defined locally rather than imported from a shared location (zero cross-module runtime coupling for a type this narrow). */
export interface TailscaleOauthPreflightFailure {
  readonly code: string;
  readonly message: string;
}

export interface TailscaleOauthPreflightDeps {
  /**
   * Decrypt `vaultPath`/`identityPath` into the raw vault map — injected so
   * this preflight is unit-testable without real `age`. Production wiring
   * passes `vault-read.ts::readVault` verbatim. Any decrypt/parse failure
   * MUST propagate as a thrown error (this function's own try/catch turns
   * it into an honest refusal, never a silent pass) — same contract every
   * other vault-restore closure in this codebase follows for its OWN
   * internal try/catch, inverted here because a preflight's job is to
   * REFUSE on doubt, not degrade past it.
   */
  readonly readVault: (opts: { readonly vaultPath: string; readonly identityPath: string }) => Promise<Readonly<Record<string, string>>>;
}

/**
 * The groundnuty/macf#1074 ruling's refuse-before-gate-1 precedent, applied
 * to Tailscale: "Refuse before gate 1 if declared-and-absent, per Amendment
 * C's `age_recipients: []` refusal. Spending consent clicks on a fleet that
 * cannot route is the waste refusal exists to prevent." Mirrors
 * `apply-routing.ts::checkRunnerTokenPreflight`'s placement contract:
 * `commands/bootstrap-apply.ts::runBootstrapApply` calls this immediately
 * after the manifest parses, before ANY observe/plan-render/consent-gate
 * work — an operator who forgot to supply Tailscale OAuth never spends a
 * browser click and never even costs a read-only `gh` call.
 *
 * Three cases:
 *   1. **Not declared** (`transport.tailscale_oauth_required` is `false`,
 *      the default) — `undefined`. Undeclared is honest "not ready yet,"
 *      never an error (see `apply-routing-secrets.ts`'s module doc).
 *   2. **Declared, but `vaultPath`/`identityPath` not BOTH supplied** —
 *      REFUSE. There is no way to verify presence without decrypting, and
 *      per Amendment C's precedent an unverifiable declared-requirement
 *      refuses rather than silently proceeding on a fleet that might not
 *      be able to route.
 *   3. **Declared, both supplied** — decrypt + check
 *      `vaultTsOauthClientId`/`vaultTsOauthSecret` presence. Either
 *      missing (or the decrypt itself fails) — REFUSE. Both present —
 *      `undefined` (proceed; the publish-time resolution in
 *      `apply-fleet.ts` reads the SAME fields again independently, per
 *      this codebase's "each concern gets its own decrypt, not a hot
 *      path" convention already established for CA/routing-client
 *      restores).
 *
 * NEVER throws — a `deps.readVault` rejection is caught and folded into
 * the SAME refusal case 3 already returns (the decrypt failing IS the
 * "did not yield the values" case), never propagated as an unhandled
 * exception that would crash `runBootstrapApply` before it can render a
 * clean error.
 */
export async function checkTailscaleOauthPreflight(
  tailscaleOauthRequired: boolean,
  vaultPath: string | undefined,
  identityKeyPath: string | undefined,
  deps: TailscaleOauthPreflightDeps,
): Promise<TailscaleOauthPreflightFailure | undefined> {
  if (!tailscaleOauthRequired) return undefined;

  if (vaultPath === undefined || identityKeyPath === undefined) {
    return {
      code: TAILSCALE_OAUTH_MISSING_CODE,
      message:
        'transport.tailscale_oauth_required is declared, but --vault/--identity-key were not both supplied, so ' +
        `${TS_OAUTH_CLIENT_ID_SECRET_NAME}/${TS_OAUTH_SECRET_SECRET_NAME} cannot be verified present in the vault. ` +
        'Refusing before consent gate 1 — supply both flags so the operator-supplied Tailscale OAuth credentials ' +
        'can be confirmed, or unset transport.tailscale_oauth_required if this fleet genuinely does not need ' +
        'Tailscale routing yet.',
    };
  }

  const missing = (reason: string): TailscaleOauthPreflightFailure => ({
    code: TAILSCALE_OAUTH_MISSING_CODE,
    message:
      `transport.tailscale_oauth_required is declared, but the vault did not yield ${TS_OAUTH_CLIENT_ID_SECRET_NAME}/` +
      `${TS_OAUTH_SECRET_SECRET_NAME} (${reason}). Refusing before consent gate 1 — spending consent clicks on a ` +
      'fleet that cannot route is exactly the waste this refusal exists to prevent. ' +
      'Supply the operator-provided values into the vault, then re-run apply.',
  });

  try {
    const raw = await deps.readVault({ vaultPath, identityPath: identityKeyPath });
    const clientId = raw[TS_OAUTH_CLIENT_ID_SECRET_NAME];
    const secret = raw[TS_OAUTH_SECRET_SECRET_NAME];
    if (clientId === undefined || clientId.length === 0 || secret === undefined || secret.length === 0) {
      return missing('both fields present in the manifest requirement but absent or empty in the decrypted vault');
    }
    return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return missing(`vault decrypt failed: ${reason}`);
  }
}
