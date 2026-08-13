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
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlanFailure } from '../bootstrap/plan.js';
import { computePlan, fleetPlanFailureToJson, fleetPlanToJson, formatPlanText } from '../bootstrap/plan.js';
import { githubRegistryObserver, vaultAwareObserver } from '../bootstrap/observer.js';

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
}

function resolveDeps(manifestPath: string, vaultPath?: string, identityKeyPath?: string): BootstrapPlanDeps {
  if (vaultPath !== undefined && identityKeyPath !== undefined) {
    return {
      observe: (manifest: FleetManifest) =>
        vaultAwareObserver(manifest, manifestPath, { vaultPath, identityPath: identityKeyPath }),
    };
  }
  return { observe: (manifest: FleetManifest) => githubRegistryObserver(manifest, manifestPath) };
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
  // silently falling back to the vault-free observer. Without this check,
  // `--vault <path>` alone (identity-key forgotten) produces a plan
  // byte-identical to a vault-free run — no `[vault: ...]` fact anywhere,
  // no signal the operator's intent (vault-aware observation) was never
  // honored. That is exactly the shape `plan.ts`'s own
  // skippedSections/unimplementedByApply machinery exists to prevent for
  // manifest sections ("a plan that lists items apply will never attempt
  // manufactures false confidence") and the silent-fallback class this
  // codebase's Instance 15 documents at the launcher-flag layer — a
  // half-given flag pair is the CLI-argument-boundary version of the same
  // hazard. `plan` is read-only (never consent-gated, never irreversible),
  // so this is a REFUSE at the CLI boundary rather than a degrade-to-warn:
  // simpler than threading a partial-flags warning through `ObservedState`,
  // and the operator can immediately supply the missing flag and re-run.
  if ((opts.vaultPath === undefined) !== (opts.identityKeyPath === undefined)) {
    return renderFailure(
      {
        code: 'vault_flags_incomplete',
        message:
          '--vault and --identity-key must be given TOGETHER or not at all — ' +
          `only ${opts.vaultPath !== undefined ? '--vault' : '--identity-key'} was given. Supply both for a ` +
          'vault-aware plan (DR-043 Amendment D phase 3), or neither for the vault-free default.',
      },
      opts,
    );
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

    if (opts.json) {
      console.log(JSON.stringify(fleetPlanToJson(plan), null, 2));
    } else {
      console.log(formatPlanText(plan));
    }
    return 0;
  } catch (err) {
    return renderFailure(
      { code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) },
      opts,
    );
  }
}
