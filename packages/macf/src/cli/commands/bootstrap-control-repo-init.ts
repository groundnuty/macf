/**
 * `macf bootstrap control-repo init` CLI entry point (groundnuty/macf#878).
 *
 * Mirrors `bootstrap-status.ts`'s shape: thin CLI wiring only. All decision
 * logic lives in `provisionControlRepo` (`../bootstrap/control-repo.js`,
 * unmodified by this issue) via the injected `ControlRepoDeps`; all
 * rendering lives in `../bootstrap/control-repo-init.js`. See that module's
 * doc for what this verb does and — just as load-bearing — what it
 * deliberately does NOT do (the vault, `fleet.lock`, and every agent's
 * identity plane are all untouched).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { ControlRepoDeps } from '../bootstrap/control-repo.js';
import { provisionControlRepo } from '../bootstrap/control-repo.js';
import type { FleetPlanFailure } from '../bootstrap/plan.js';
import { fleetPlanFailureToJson } from '../bootstrap/plan.js';
import {
  controlRepoInitExitCode,
  controlRepoInitOutcomeToJson,
  formatControlRepoInitText,
  REAL_CONTROL_REPO_INIT_DEPS,
} from '../bootstrap/control-repo-init.js';

export interface RunControlRepoInitOptions {
  readonly file: string;
  readonly json?: boolean;
}

function renderFailure(failure: FleetPlanFailure, json?: boolean): number {
  // macf#830 lesson (same as `bootstrap plan`/`bootstrap status`): plain-text
  // message ALWAYS to stderr; under --json ALSO a valid, non-empty JSON
  // {error} object to stdout — never empty-stdout+exit-0, never
  // empty-stdout+exit-nonzero.
  console.error(failure.message);
  if (json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

/**
 * `macf bootstrap control-repo init -f fleet.yaml [--json]` entry point.
 * Runs ONLY `provisionControlRepo` (step 0 of `bootstrap apply`) — no
 * per-agent identity, no vault, no `fleet.lock` write. Returns the shell
 * exit code. NEVER exits the process directly — every failure path is
 * caught and rendered via `renderFailure`, same contract as
 * `runBootstrapStatus`/`runBootstrapPlan`.
 */
export async function runBootstrapControlRepoInit(
  opts: RunControlRepoInitOptions,
  deps: ControlRepoDeps = REAL_CONTROL_REPO_INIT_DEPS,
): Promise<number> {
  const manifestPath = resolvePath(opts.file);

  if (!existsSync(manifestPath)) {
    return renderFailure({ code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` }, opts.json);
  }

  let manifest: FleetManifest;
  try {
    manifest = parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return renderFailure(
      { code: 'manifest_invalid', message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}` },
      opts.json,
    );
  }

  // `provisionControlRepo` NEVER throws (see its own doc) — every failure
  // mode, including an unconfirmable existence read, resolves into a
  // `ControlRepoOutcome` for the renderers below to report honestly.
  const outcome = await provisionControlRepo(manifest, manifestPath, deps);

  if (opts.json) {
    console.log(JSON.stringify(controlRepoInitOutcomeToJson(outcome, manifest.metadata.name), null, 2));
  } else {
    console.log(formatControlRepoInitText(outcome, manifest.metadata.name));
  }
  return controlRepoInitExitCode(outcome);
}
