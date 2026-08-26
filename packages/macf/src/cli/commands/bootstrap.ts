/**
 * `macf bootstrap plan` CLI entry point (DR-043 Slice 1a, groundnuty/macf#838).
 *
 * Wires `fleet-manifest.ts` (parse), `observer.ts` (read-only observe), and
 * `plan.ts` (pure reconcile + render) into a `--json`-safe command. This
 * file intentionally has NO `apply` subcommand yet — Slice 1a is read-only
 * plan-only by design (DR-043 §"Rollout": plan-only retrofit of the two
 * existing fleets is the reconciler's OWN acceptance test). The shape below
 * (`RunBootstrapPlanOptions` / `BootstrapPlanDeps` / a single `run*`
 * function) is deliberately the same shape `apply` will slot into next to,
 * once Slice 2 builds it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlanFailure } from '../bootstrap/plan.js';
import {
  checkVaultFlagsComplete,
  computePlan,
  countAppsToCreate,
  fleetPlanFailureToJson,
  fleetPlanToJson,
  formatOperatorInteractionLine,
  formatPlanText,
  operatorInteractionBudget,
  operatorInteractionToJson,
} from '../bootstrap/plan.js';
import type { AgentRegistryObservation } from '../bootstrap/observer.js';
import { githubRegistryObserver, readAgentRegistryInfo, vaultAwareObserver } from '../bootstrap/observer.js';
import { advertiseHostDriftEntryToJson, detectAdvertiseHostDrift, formatAdvertiseHostDriftLines } from '../bootstrap/advertise-host-drift.js';

export interface RunBootstrapPlanOptions {
  readonly file: string;
  readonly json?: boolean;
  /**
   * Optional vault-aware observation (DR-043 Amendment D phase 3). When
   * BOTH this and `identityKeyPath` are given, `plan` decrypts the vault
   * (this CLI is the operator-privileged plane, §D4 — the same posture
   * `apply` already runs under) and lifts per-agent/CA presence into
   * `ObservedState` via `vaultAwareObserver`. Omitting either (the Slice
   * 1a/2 default) keeps `plan` fully vault-free, exactly as before this
   * increment — never a partial or guessed vault read.
   */
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
}

/** Injectable seam so tests drive the command without touching `gh` / the filesystem lock read. */
export interface BootstrapPlanDeps {
  readonly observe: FleetObserverFn;
  /**
   * groundnuty/macf#1203 — same signature as `observer.ts::readAgentRegistryInfo`
   * (production wiring passes that function directly, mirroring
   * `commands/bootstrap-status.ts::BootstrapStatusDeps`). OPTIONAL and
   * deliberately so: every pre-existing test in `bootstrap.test.ts` builds a
   * `BootstrapPlanDeps` literal without this field, and it must keep
   * compiling + running fully offline. When omitted, `runBootstrapPlan`
   * makes ZERO registry reads and every role's advertise-host comparison
   * degrades to the honest-unknown "registry not queried this run" —
   * `advertise-host-drift.ts::detectAdvertiseHostDrift`'s own fallback for a
   * role missing from its registry map, never a network call.
   */
  readonly readAgentRegistry?: (registry: RegistryConfig, fleetName: string, role: string) => Promise<AgentRegistryObservation>;
}

/**
 * Exported (only) for `bootstrap.test.ts`'s real-vault-observer test, which
 * needs to exercise this function's ACTUAL wiring while overriding just the
 * `readAgentRegistry` leg (groundnuty/macf#1203's per-agent `gh api` reads
 * make that one test network-latency-sensitive; nothing else in this
 * module's test suite calls this directly — every other test injects a
 * full `BootstrapPlanDeps` and never reaches this function at all).
 */
export function resolveDeps(manifestPath: string, vaultPath?: string, identityKeyPath?: string): BootstrapPlanDeps {
  if (vaultPath !== undefined && identityKeyPath !== undefined) {
    return {
      observe: (manifest: FleetManifest) =>
        vaultAwareObserver(manifest, manifestPath, { vaultPath, identityPath: identityKeyPath }),
      readAgentRegistry: readAgentRegistryInfo,
    };
  }
  return { observe: (manifest: FleetManifest) => githubRegistryObserver(manifest, manifestPath), readAgentRegistry: readAgentRegistryInfo };
}

function renderFailure(failure: FleetPlanFailure, opts: RunBootstrapPlanOptions): number {
  // macf#830 lesson: the plain-text message ALWAYS goes to stderr; under
  // --json we ALSO print a valid, non-empty JSON {error} object to stdout —
  // never empty-stdout+exit-0, never empty-stdout+exit-nonzero.
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

/**
 * `macf bootstrap plan -f fleet.yaml [--json]` entry point. READ-ONLY end to
 * end: parses the manifest, observes current state (read-only `gh` calls +
 * a `fleet.lock` read — see `observer.ts`), computes the plan, renders it.
 * No apply, no mutation, no browser, no exchange.
 *
 * Returns the shell exit code (0 on a successfully-computed plan — a plan
 * full of `create` items is still a SUCCESSFUL run; only a failure to even
 * produce a plan is non-zero). NEVER exits the process directly — every
 * failure path (missing file, schema-validation error, an observer throw)
 * is caught and rendered via `renderFailure`.
 */
export async function runBootstrapPlan(
  opts: RunBootstrapPlanOptions,
  deps?: BootstrapPlanDeps,
): Promise<number> {
  // Half-specified `--vault`/`--identity-key` pair — refuse LOUD rather than
  // silently falling back to the vault-free observer (macf#913: this check
  // is now shared with `bootstrap apply`'s own vault-aware confirm — see
  // `plan.ts::checkVaultFlagsComplete`'s doc for the full rationale).
  const vaultFlagsFailure = checkVaultFlagsComplete(opts.vaultPath, opts.identityKeyPath);
  if (vaultFlagsFailure !== undefined) {
    return renderFailure(vaultFlagsFailure, opts);
  }

  const manifestPath = resolvePath(opts.file);

  if (!existsSync(manifestPath)) {
    return renderFailure(
      { code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` },
      opts,
    );
  }

  let manifest: FleetManifest;
  try {
    manifest = parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return renderFailure(
      {
        code: 'manifest_invalid',
        message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
      },
      opts,
    );
  }

  const resolved = deps ?? resolveDeps(manifestPath, opts.vaultPath, opts.identityKeyPath);

  try {
    const observed = await resolved.observe(manifest);
    const plan = computePlan(manifest, observed);
    // groundnuty/macf#880 — the operator's consent-click budget, projected
    // from the SAME `plan.items` this render already computed (no new
    // observation; see `plan.ts`'s "Operator interaction budget" section
    // doc for why `--vault`/`--identity-key` on `plan` itself never tightens
    // this number — only `apply`'s confirm-before-create guard can).
    const budget = operatorInteractionBudget(countAppsToCreate(plan.items));

    // groundnuty/macf#1203 — declared `network.advertise_host` vs. each
    // agent's OWN live registration, reported here as a section BESIDE
    // `plan.items` rather than folded into them: `apply` has no code path
    // that writes an agent's own registry entry (see
    // `advertise-host-drift.ts`'s module doc), so modeling it as a
    // create/update `PlanItem` would wrongly imply `apply` could converge
    // it. Registry map built the SAME way `bootstrap status` already builds
    // one (`commands/bootstrap-status.ts`) — one best-effort, never-throws
    // read per declared agent.
    const registry: Record<string, AgentRegistryObservation> = {};
    if (resolved.readAgentRegistry !== undefined) {
      for (const agent of manifest.agents) {
        registry[agent.role] = await resolved.readAgentRegistry(manifest.owner.registry, manifest.metadata.name, agent.role);
      }
    }
    const advertiseHostDrift = detectAdvertiseHostDrift(
      manifest.network.advertise_host,
      registry,
      manifest.agents.map((a) => a.role),
    );

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...(fleetPlanToJson(plan) as Record<string, unknown>),
            operator_interaction: operatorInteractionToJson(budget),
            advertise_host_drift: advertiseHostDrift.map(advertiseHostDriftEntryToJson),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatPlanText(plan));
      console.log('');
      console.log(formatOperatorInteractionLine(budget));
      console.log('');
      console.log(formatAdvertiseHostDriftLines(advertiseHostDrift).join('\n'));
    }
    return 0;
  } catch (err) {
    return renderFailure(
      { code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) },
      opts,
    );
  }
}
