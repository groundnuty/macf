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
// groundnuty/macf#1197 — the operator secrets file: `plan` reports which
// source will supply each operator-input key it knows about, so a friend
// filling in the file can see the resolution BEFORE any gate opens. Loaded
// the same way `apply` does (see `bootstrap-apply.ts`'s own doc); `plan`
// has no credential flags of its own, so only the file/env tiers apply.
import { TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR } from '../bootstrap/apply-routing-secrets.js';
import { RUNNER_TOKEN_ENV_VAR } from '../bootstrap/apply-routing.js';
import { RUNNER_PLATFORM_ENDPOINT_ENV_VAR, registerRunnerPlatformEndpointFileTier } from '../bootstrap/runner-platform.js';
import type { OperatorInputSource } from '../bootstrap/operator-secrets-file.js';
import { formatOperatorInputProvenanceLine, readOperatorSecretsFile, resolveOperatorInput } from '../bootstrap/operator-secrets-file.js';
import type { Presence } from '../bootstrap/plan.js';
import { computeInstallScopeCoverage, formatInstallScopeCoverageLines, installScopeCoverageEntryToJson } from '../bootstrap/install-scope-coverage.js';

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
  /** `--secrets-file` (groundnuty/macf#1197) — per-fleet operator secrets file; see `operator-secrets-file.ts`'s module doc. Optional; absence is normal. */
  readonly secretsFilePath?: string;
  /** `--scope-secrets-file` (groundnuty/macf#1197) — per-scope operator secrets file, shared across a fleet's org/account. Lower precedence than {@link secretsFilePath}. */
  readonly scopeSecretsFilePath?: string;
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

/**
 * groundnuty/macf#1197 — which operator-secrets-file keys are RELEVANT to
 * this manifest (not every key in {@link OPERATOR_SECRETS_FILE_KEYS}
 * applies to every fleet — e.g. the Tailscale pair only matters when
 * `transport.tailscale_oauth_required` is declared). Mirrors the SAME
 * manifest predicates `checkTailscaleOauthPreflight`/
 * `checkRunnerTokenPreflight` already use, kept local to this file rather
 * than exported from `operator-secrets-file.ts` so that module stays
 * manifest-type-free (see its own doc — it is deliberately generic).
 */
function relevantOperatorInputKeys(manifest: FleetManifest): readonly string[] {
  const keys: string[] = [];
  if (manifest.transport.tailscale_oauth_required) {
    keys.push(TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR);
  }
  if (manifest.routing?.runner !== undefined) {
    keys.push(RUNNER_PLATFORM_ENDPOINT_ENV_VAR);
    if (manifest.routing.runner.runs_on === 'self-hosted') keys.push(RUNNER_TOKEN_ENV_VAR);
  }
  return keys;
}

/**
 * groundnuty/macf#1197 — "plan states which keys it will need... the
 * resolved source of each key is reportable." `plan` has no credential
 * flags of its own (only `--vault`/`--identity-key`), so only the
 * file/env tiers can resolve here — a `plan`-only "not supplied" for a key
 * that `apply --ts-oauth-client-id ...` would go on to satisfy is expected,
 * not a bug. Never touches a value, only `key`/`source` — safe to print
 * unconditionally (text AND `--json`).
 */
export function operatorInputProvenance(
  manifest: FleetManifest,
  fleetValues: Readonly<Record<string, string>> | undefined,
  scopeValues: Readonly<Record<string, string>> | undefined,
): readonly { readonly key: string; readonly source: OperatorInputSource }[] {
  return relevantOperatorInputKeys(manifest).map((key) => {
    const { source } = resolveOperatorInput(key, undefined, fleetValues, scopeValues);
    return { key, source };
  });
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

  // groundnuty/macf#1197 — same argument-boundary placement as the vault
  // check immediately above: a GIVEN --secrets-file/--scope-secrets-file
  // path that cannot be read refuses here, before the manifest is even
  // parsed. `undefined` (the common case) is not an error.
  const fleetSecretsRead = readOperatorSecretsFile(opts.secretsFilePath);
  if (fleetSecretsRead !== undefined && !fleetSecretsRead.ok) {
    return renderFailure({ code: 'operator_secrets_file_unreadable', message: fleetSecretsRead.message }, opts);
  }
  const scopeSecretsRead = readOperatorSecretsFile(opts.scopeSecretsFilePath);
  if (scopeSecretsRead !== undefined && !scopeSecretsRead.ok) {
    return renderFailure({ code: 'operator_secrets_file_unreadable', message: scopeSecretsRead.message }, opts);
  }
  const fleetSecretsValues = fleetSecretsRead?.ok === true ? fleetSecretsRead.values : undefined;
  const scopeSecretsValues = scopeSecretsRead?.ok === true ? scopeSecretsRead.values : undefined;
  // groundnuty/macf#1238 — register the runner-platform-endpoint file-tier
  // candidate BEFORE `resolved.observe(manifest)` below runs (that call
  // reaches `observer.ts::resolveRunnerPlatformEndpointWithProvenance`,
  // unchanged, via `githubRegistryObserver`/`vaultAwareObserver`), so a
  // file-only-sourced endpoint resolves to `source: 'fleet-file'`/
  // `'scope-file'` there too — matching `operatorInputProvenance` below,
  // instead of the pre-#1238 "not resolved" (observer.ts never saw the
  // file at all) or a `bootstrap-apply`-only mislabel as "environment
  // variable" (this command never planted `process.env`, so plan alone
  // never showed the wrong-source bug — but it DID show a disagreeing
  // "not resolved" against its own correct operator-inputs line; this
  // registration closes that gap too). See
  // `runner-platform.ts::registerRunnerPlatformEndpointFileTier`'s doc.
  registerRunnerPlatformEndpointFileTier(fleetSecretsValues?.[RUNNER_PLATFORM_ENDPOINT_ENV_VAR], scopeSecretsValues?.[RUNNER_PLATFORM_ENDPOINT_ENV_VAR]);

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
    // groundnuty/macf#1220 — fleet-level (runner-ops/router) App
    // installation-SCOPE-MEMBERSHIP drift: is a `selected` install's actual
    // repo set still current now that the manifest may have grown since it
    // was set? Needs an App JWT (see `install-scope-coverage.ts`'s module
    // doc) to actually PROBE, but — groundnuty/macf#1279 — `plan` calls
    // `computeInstallScopeCoverage` UNCONDITIONALLY, exactly as `apply` does
    // (macf#1268 / PR #1276) and for the identical reason: that function
    // ALREADY implements the exact "only when meaningful, say why otherwise"
    // contract this issue asks for. `installScopeCoverageTargets(manifest)`
    // — pure, manifest-only — returns ZERO targets when this fleet declares
    // neither a runner-ops App nor a router App needing one, so a fleet with
    // nothing to check makes ZERO I/O and this reads `{}`, silent, exactly
    // as before this fix. When targets ARE non-empty and `--vault`/
    // `--identity-key` are absent, `computeInstallScopeCoverage` returns one
    // honest `'unknown'` entry per target via its own `allUnverified` helper
    // — message `"install-scope coverage was not checked this run —
    // no --vault/--identity-key given."`, naming exactly what the operator
    // would supply. The PRE-#1279 bug was ONLY this call site discarding
    // that honest-unknown output via the ternary's `: {}` branch, regardless
    // of whether `targets` was empty or not — never a missing capability in
    // `install-scope-coverage.ts` itself (see PR #1276's identical rationale
    // for the `apply` call site).
    //
    // `plan` deliberately passes NO `deps` (no `onDrift`) — `computeInstallScopeCoverage`
    // is report-only here, same as `status`; only `apply`'s call site wires
    // the ACT half (`InstallScopeCoverageDeps.onDrift`'s own doc: opening a
    // browser consent gate from a read-only command would be its own
    // hazard).
    //
    // Computed BEFORE `computePlan` (moved here from after it, groundnuty/
    // macf#1129 / #1229 / DR-043 Amendment P2, row 3) so its entries can be
    // folded into `plan.items` as genuine `PlanItem`s (verb `update` for a
    // confirmed `'drift'`) rather than only ever rendered as a discarded
    // coverage-warning line — see `plan.ts::installScopeCoverageItem`'s
    // doc. `computePlan` itself stays I/O-free: the live per-repo JWT probe
    // (when a vault credential is available) already happened in THIS
    // await, above the call.
    const vaultOpts =
      opts.vaultPath !== undefined && opts.identityKeyPath !== undefined
        ? { vaultPath: opts.vaultPath, identityPath: opts.identityKeyPath }
        : undefined;
    const installScopeCoverage = await computeInstallScopeCoverage(
      manifest,
      observed.lock,
      Object.fromEntries(Object.entries(observed.agents).map(([role, a]) => [role, a.repo])) as Readonly<Record<string, Presence>>,
      observed.controlRepoPresence,
      vaultOpts,
    );
    const plan = computePlan(manifest, observed, Object.values(installScopeCoverage));
    // groundnuty/macf#880 — the operator's consent-click budget, projected
    // from the SAME `plan.items` this render already computed (no new
    // observation; see `plan.ts`'s "Operator interaction budget" section
    // doc for why `--vault`/`--identity-key` on `plan` itself never tightens
    // this number — only `apply`'s confirm-before-create guard can).
    // Unaffected by the `'install_scope'` items just folded in above:
    // `countAppsToCreate` filters on `kind ∈ {app, runner_ops, router_app}`,
    // and `installScopeCoverageItem` never emits those kinds nor a `'create'`
    // verb (drift → update, covered → noop, unknown → no item) — see that
    // function's own doc.
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

    // groundnuty/macf#1197 — "plan states which keys it will need... the
    // resolved source of each key is reportable." Appended as its OWN
    // section, never interleaved with the plan-item/drift computations
    // above.
    const operatorInputs = operatorInputProvenance(manifest, fleetSecretsValues, scopeSecretsValues);
    // `installScopeCoverage` is now computed above, before `computePlan` —
    // this section's TEXT/JSON rendering is otherwise UNCHANGED code: a
    // `status: 'unknown'` entry never became a `PlanItem` (honest-unknown —
    // see `installScopeCoverageItem`'s doc), so this is still the ONLY
    // surface naming its unverified repos. What DID change (macf#1279): the
    // flagless-run `'unknown'` entries this now unconditionally-called
    // function returns reach these SAME two renders unmodified —
    // `formatInstallScopeCoverageLines` already renders every non-`'covered'`
    // entry (the `--vault`-genuinely-ambiguous case and the
    // no-`--vault`-given "not checked this run" case share one code path,
    // one label ("unknown"), never a second wording), and the `--json`
    // `Object.keys(installScopeCoverage).length > 0` guard now goes true
    // whenever the manifest declares a fleet-level App target, independent
    // of whether the flags were given.
    const installScopeCoverageLines = formatInstallScopeCoverageLines(installScopeCoverage);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...(fleetPlanToJson(plan) as Record<string, unknown>),
            operator_interaction: operatorInteractionToJson(budget),
            advertise_host_drift: advertiseHostDrift.map(advertiseHostDriftEntryToJson),
            operator_inputs: operatorInputs,
            // groundnuty/macf#1309 — `lock === null` alone can't tell
            // "never provisioned" apart from "the lock read failed" (a
            // wrong-scope token, a private control repo, a network hiccup).
            // See `plan.ts::FleetLockSource`'s doc.
            fleet_lock_source: observed.lockSource ?? 'unreadable',
            ...(Object.keys(installScopeCoverage).length > 0
              ? { install_scope_coverage: Object.values(installScopeCoverage).map(installScopeCoverageEntryToJson) }
              : {}),
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
      console.log(`fleet.lock source: ${observed.lockSource ?? 'unreadable'}`);
      console.log('');
      console.log(formatAdvertiseHostDriftLines(advertiseHostDrift).join('\n'));
      if (operatorInputs.length > 0) {
        console.log('');
        console.log('Operator inputs:');
        for (const { key, source } of operatorInputs) {
          console.log(`  ${formatOperatorInputProvenanceLine(key, source)}`);
        }
      }
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
