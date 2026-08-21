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
 */
export type RoutingSecretResolution = { readonly status: 'available'; readonly value: string } | { readonly status: 'unavailable'; readonly reason: string };

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
 * of the six names, regardless of whether any individual secret's
 * resolution is `'available'` — mirrors `apply-routing-client.ts`'s
 * (retired) per-repo idempotent-loop contract: a repo already holding a
 * secret reports `'already-present'`; a repo missing one whose resolution
 * is `'unavailable'` reports a loud `'failed'` carrying the honest reason
 * (never a silent `'skipped'` for a secret this run SHOULD have been able
 * to provide); `ensureVariableCreated`'s own create-only semantics are
 * reused verbatim, never re-implemented.
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
