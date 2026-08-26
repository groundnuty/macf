/**
 * `macf bootstrap status` CLI entry point (groundnuty/macf#1017).
 *
 * READ-ONLY end to end, same posture as `macf bootstrap plan`
 * (`commands/bootstrap.ts`) — this file mirrors that one's shape
 * deliberately (`RunBootstrapStatusOptions` / `BootstrapStatusDeps` /
 * `resolveDeps` / `renderFailure`), extended with ONE additional injectable
 * read (`readAgentRegistry`) for the runtime-identity slice `plan` never
 * needed. Renders `ObservedState` straight through `status.ts`'s pure
 * `computeBootstrapStatus` — never calls `computePlan`; there is no diff
 * here, only "what is there right now."
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlanFailure } from '../bootstrap/plan.js';
import { checkVaultFlagsComplete, fleetPlanFailureToJson } from '../bootstrap/plan.js';
import type { AgentRegistryObservation } from '../bootstrap/observer.js';
import { githubRegistryObserver, readAgentRegistryInfo, vaultAwareObserver } from '../bootstrap/observer.js';
import { bootstrapStatusToJson, computeBootstrapStatus, formatBootstrapStatusText } from '../bootstrap/status.js';
import type { Presence } from '../bootstrap/plan.js';
import { computeInstallScopeCoverage, formatInstallScopeCoverageLines, installScopeCoverageEntryToJson } from '../bootstrap/install-scope-coverage.js';

export interface RunBootstrapStatusOptions {
  readonly file: string;
  readonly json?: boolean;
  /** Same contract as `bootstrap plan`'s pair — see `commands/bootstrap.ts::RunBootstrapPlanOptions` doc. */
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
}

/** Injectable seam so tests drive the command without touching `gh` / the filesystem lock read / the network. */
export interface BootstrapStatusDeps {
  readonly observe: FleetObserverFn;
  /** Same signature as `observer.ts::readAgentRegistryInfo` — production wiring passes that function directly. */
  readonly readAgentRegistry: (registry: RegistryConfig, fleetName: string, role: string) => Promise<AgentRegistryObservation>;
}

function resolveDeps(manifestPath: string, vaultPath?: string, identityKeyPath?: string): BootstrapStatusDeps {
  const observe: FleetObserverFn =
    vaultPath !== undefined && identityKeyPath !== undefined
      ? (manifest: FleetManifest) => vaultAwareObserver(manifest, manifestPath, { vaultPath, identityPath: identityKeyPath })
      : (manifest: FleetManifest) => githubRegistryObserver(manifest, manifestPath);
  return { observe, readAgentRegistry: readAgentRegistryInfo };
}

function renderFailure(failure: FleetPlanFailure, opts: RunBootstrapStatusOptions): number {
  // macf#830 lesson (same as `bootstrap plan`): plain-text message ALWAYS to
  // stderr; under --json ALSO a valid, non-empty JSON {error} object to
  // stdout — never empty-stdout+exit-0, never empty-stdout+exit-nonzero.
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

/**
 * `macf bootstrap status -f fleet.yaml [--json]` entry point. READ-ONLY end
 * to end: parses the manifest, observes current state (the SAME observer
 * `bootstrap plan` uses), reads each declared agent's registry-registration
 * entry (best-effort, honest-`unknown` on any failure), renders — no diff,
 * nothing written, nothing mutated.
 *
 * Returns the shell exit code. NEVER exits the process directly — every
 * failure path is caught and rendered via `renderFailure`, same contract as
 * `runBootstrapPlan`.
 */
export async function runBootstrapStatus(
  opts: RunBootstrapStatusOptions,
  deps?: BootstrapStatusDeps,
): Promise<number> {
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

    // Runtime-identity slice (macf#1017) — one registry read per declared
    // agent, best-effort, NEVER throws (see `observer.ts::readAgentRegistryInfo`'s
    // doc); a failed/partial read degrades that ONE agent's row to
    // `unknown`, never aborts the whole render (same "partially-provisioned
    // fleet must still render" requirement `computeBootstrapStatus` honors
    // for every other field).
    const registry: Record<string, AgentRegistryObservation> = {};
    for (const agent of manifest.agents) {
      registry[agent.role] = await resolved.readAgentRegistry(manifest.owner.registry, manifest.metadata.name, agent.role);
    }

    const view = computeBootstrapStatus(manifest, observed, registry);

    // groundnuty/macf#1220 — SAME section, SAME vault gate, as
    // `commands/bootstrap.ts::runBootstrapPlan`'s own wiring (see that
    // function's comment for the full rationale). Appended beside `view`
    // rather than threaded through `computeBootstrapStatus`/`FleetStatusView`
    // — unlike `advertiseHostDrift` (threaded through `AgentStatusView`,
    // a pure per-agent comparison with no I/O of its own), THIS check is
    // its OWN live, credentialed vault-read + JWT probe; folding it into
    // `computeBootstrapStatus` would make that function impure. Keeping it
    // a standalone append is the SAME shape `bootstrap.ts`'s plan command
    // already uses for this identical check.
    const installScopeCoverage =
      opts.vaultPath !== undefined && opts.identityKeyPath !== undefined
        ? await computeInstallScopeCoverage(
            manifest,
            observed.lock,
            Object.fromEntries(Object.entries(observed.agents).map(([role, a]) => [role, a.repo])) as Readonly<Record<string, Presence>>,
            observed.controlRepoPresence,
            { vaultPath: opts.vaultPath, identityPath: opts.identityKeyPath },
          )
        : {};
    const installScopeCoverageLines = formatInstallScopeCoverageLines(installScopeCoverage);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...(bootstrapStatusToJson(view) as Record<string, unknown>),
            ...(Object.keys(installScopeCoverage).length > 0
              ? { install_scope_coverage: Object.values(installScopeCoverage).map(installScopeCoverageEntryToJson) }
              : {}),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatBootstrapStatusText(view));
      if (installScopeCoverageLines.length > 0) {
        console.log('');
        console.log(installScopeCoverageLines.join('\n'));
      }
    }
    return 0;
  } catch (err) {
    return renderFailure(
      { code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) },
      opts,
    );
  }
}
