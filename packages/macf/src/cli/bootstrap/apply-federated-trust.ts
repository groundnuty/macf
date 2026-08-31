/**
 * `trust.federated_cas` registry publish — groundnuty/macf#810, DR-041
 * Amendment B, landing WITH its enforcement per `#1205`'s condition on the
 * removed `trust:` field ("must land with its enforcement, not ahead of
 * it").
 *
 * **Scope, deliberately narrow (the #810 ruling thread's own scoping call):
 * this module publishes the CA-trust MATERIAL only.** It does not touch
 * `.github/macf-fleet.json`'s per-agent-repo `federated_cas` project-NAME
 * list (`@groundnuty/macf-core`'s `guest.ts`), and it does not change
 * `resolveGuestAddress`'s cross-fleet ADDRESSING gate (same file) — both stay
 * exactly as they are today. Conflating trust-material publication with the
 * addressing gate's input source is a SEPARATE design question the `#810`
 * thread explicitly kept apart from this one ("different component,
 * different mechanism — conflating them muddies both", re: the sibling
 * mention-routing gap on the same issue). See this module's own doc below
 * for exactly what observable effect this DOES have.
 *
 * **The consumer this reaches, concretely.** `@groundnuty/macf-core`'s
 * `trust-bundle.ts::resolveFederatedCaBundle` resolves each project an
 * agent's `.github/macf-fleet.json` `federated_cas` list names to
 * `${toVariableSegment(project)}_CA_CERT` in ITS OWN registry scope, and
 * THROWS at channel-server startup if that variable is missing or empty
 * (`TrustBundleError` — "refusing to start with an INCOMPLETE trust
 * bundle"). `caCertVariableName` (`apply-ca.ts`) computes the IDENTICAL
 * formula. So publishing a declared `trust.federated_cas[].ca_bundle` under
 * `caCertVariableName(entry.project)`, in THIS FLEET's OWN registry scope
 * (`manifest.owner.registry` — the same scope `apply-ca.ts` publishes this
 * fleet's OWN CA cert to, fleet-scoped since groundnuty/macf#1373/#1375
 * fixed `registry-api-path`), lands the bundle in the EXACT variable that
 * ALREADY-SHIPPED consumer reads. Before this module ran: an agent whose
 * `.github/macf-fleet.json` names the guest project would THROW at startup
 * (the variable does not exist). After: it resolves, and the guest's CA
 * joins the trust bundle. That state transition — refuse-to-start →
 * resolves — is the observable effect this module exists to produce; it is
 * enforcement, not anticipation.
 *
 * **Registry-scope ONLY, no repo legs (unlike `apply-ca.ts::publishCaCertLegs`'s
 * two-place rule).** `resolveFederatedCaBundle` reads via
 * `varsClient.readVariable` — the channel-server's registry client — never a
 * repo variable. There is no second consumer to cover, so there is no second
 * leg to publish.
 *
 * **Create-only — the widening-guard FLOOR, not the full `#1330`
 * enumerate-and-name consent gate.** `ensureVariableCreated` never overwrites
 * an existing value: a NEW project's bundle is published and reported
 * `'created'`; an EXISTING project's bundle — even a materially DIFFERENT
 * one — reports `'already-present'` and is left untouched. This means a
 * changed `ca_bundle` for an already-federated project requires a deliberate
 * separate action (the registry variable must be removed first), never a
 * silent re-grant on a routine `apply`. This is the create-only floor
 * `apply-ca.ts`'s own doc establishes for the identical reason ("never
 * silently overwrite") — it is NOT `#1330`'s enumerate-and-name consent
 * prompt (that mechanism pins a LAST-APPROVED set in `fleet.lock` and diffs
 * against a LIVE-fetched set; there is no live fetch here, and this module
 * writes no lock entry). Building that fuller consent gate is left to a
 * follow-up increment; do not describe this module's behavior as though it
 * already were one.
 */
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetFederatedCa } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import type { CreateVariableResult } from './variable-write.js';
import type { EnsureVariableDeps, EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, skippedOutcomesFor } from './ensure-variable.js';
import { caCertVariableName } from './apply-ca.js';

export interface FederatedTrustApplyDeps {
  readonly checkRegistryPresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly createRegistryVariable: (registry: RegistryConfig, name: string, value: string) => Promise<CreateVariableResult>;
}

/** One `{@link EnsureVariableOutcome}` per declared `trust.federated_cas[]` entry, keyed by `project` (never by variable name — a project name is what a caller/renderer already has in hand from the manifest). */
export type FederatedTrustPublishResult = Readonly<Record<string, EnsureVariableOutcome>>;

/**
 * Create-only publish of every declared `trust.federated_cas[].ca_bundle` to
 * THIS fleet's own registry scope, under the GUEST project's `<SEG>_CA_CERT`
 * name (see module doc for why this is the exact variable the real consumer
 * reads). `ca_bundle` is public CA-certificate material — this function
 * never receives, produces, or could leak a private key.
 */
export async function publishFederatedTrustLegs(
  federatedCas: readonly FleetFederatedCa[],
  registry: RegistryConfig,
  deps: FederatedTrustApplyDeps,
): Promise<FederatedTrustPublishResult> {
  const legs: Record<string, EnsureVariableOutcome> = {};
  for (const entry of federatedCas) {
    const varName = caCertVariableName(entry.project);
    const depsForEntry: EnsureVariableDeps = {
      checkPresence: () => deps.checkRegistryPresence(registry, varName),
      create: () => deps.createRegistryVariable(registry, varName, entry.ca_bundle),
    };
    legs[entry.project] = await ensureVariableCreated(depsForEntry, `Federated-CA registry var "${varName}" (guest project "${entry.project}")`);
  }
  return legs;
}

/** The {@link FederatedTrustPublishResult} shape for "never attempted this run" — mirrors `apply-ca.ts::skippedCaPublish`'s always-present-even-on-abort discipline. Keyed by `project`, same as {@link publishFederatedTrustLegs}'s return (`skippedOutcomesFor` keys by whatever string list it's given — here, project names). */
export function skippedFederatedTrustPublish(federatedCas: readonly FleetFederatedCa[], reason: string): FederatedTrustPublishResult {
  return skippedOutcomesFor(
    federatedCas.map((entry) => entry.project),
    reason,
  );
}
