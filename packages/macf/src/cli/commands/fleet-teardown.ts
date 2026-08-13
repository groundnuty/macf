/**
 * `macf fleet deactivate` / `macf fleet archive` — DR-043 Amendment G, the
 * REVERSIBLE half of the fleet teardown ladder (groundnuty/macf#867). See
 * `bootstrap/teardown.ts`'s module doc for the full design (exact-key
 * targeting, the ownership gate, why `deactivate` never touches repo-scoped
 * state). `delete-apps` / `destroy` are explicitly OUT OF SCOPE here.
 *
 * Same shape as `bootstrap-apply.ts`: a read-only plan/inventory is built +
 * rendered FIRST (the DR-035 §4 plan-approve-once artifact), ONE explicit
 * confirmation is obtained (`--yes` skips it for automation), THEN the
 * mutating step runs. `--json` always emits a valid, non-empty JSON object
 * on stdout, even on failure (macf#830 lesson).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import { checkControlRepoMeta, realReadControlManifestFile } from '../bootstrap/control-repo.js';
import { checkRegistryVariablePresence } from '../bootstrap/observer.js';
import { realDeleteRegistryVariable } from '../bootstrap/variable-write.js';
import { realArchiveRepo } from '../bootstrap/repo-archive.js';
import type {
  ArchivePlan,
  DeactivateInventoryEntry,
  DeactivatePlan,
  DeactivateTarget,
  RepoArchiveOutcome,
  TeardownControlRepoDeps,
  TeardownGate,
  TeardownRepoArchiveDeps,
  TeardownVariableDeps,
  VariableTeardownOutcome,
} from '../bootstrap/teardown.js';
import { buildArchivePlan, buildDeactivatePlan, executeArchiveRepos, executeDeactivate } from '../bootstrap/teardown.js';

export const FLEET_TEARDOWN_JSON_SCHEMA_VERSION = 1;

export interface RunFleetTeardownOptions {
  readonly file: string;
  /** Skip the interactive confirmation prompt (the one non-interactive escape, mirroring `bootstrap apply --yes`). */
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** Injectable seam so tests drive the command without touching `gh` / stdin. */
export interface FleetTeardownDeps extends TeardownControlRepoDeps, TeardownVariableDeps, TeardownRepoArchiveDeps {
  readonly confirm: (question: string) => Promise<boolean>;
}

// --- Real (production) deps ---

/** Real y/N prompt on stderr (stdout stays clean for a `--json` render) — same shape as `bootstrap-apply.ts`'s `realConfirmPlan`. */
async function realConfirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function resolveDeps(): FleetTeardownDeps {
  return {
    checkMeta: checkControlRepoMeta,
    readManifestFile: realReadControlManifestFile,
    checkRegistryPresence: checkRegistryVariablePresence,
    deleteRegistryVariable: realDeleteRegistryVariable,
    archiveRepo: realArchiveRepo,
    confirm: realConfirm,
  };
}

// --- Manifest loading (shared failure shape) ---

interface TeardownFailure {
  readonly code: string;
  readonly message: string;
}

function failureToJson(failure: TeardownFailure): unknown {
  return { schema_version: FLEET_TEARDOWN_JSON_SCHEMA_VERSION, error: failure };
}

function renderFailure(failure: TeardownFailure, opts: RunFleetTeardownOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(failureToJson(failure), null, 2));
  }
  return 1;
}

function loadManifest(opts: RunFleetTeardownOptions): FleetManifest | TeardownFailure {
  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return { code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` };
  }
  try {
    return parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { code: 'manifest_invalid', message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isFailure(x: FleetManifest | TeardownFailure): x is TeardownFailure {
  return 'code' in x;
}

// --- Rendering (never a credential value — this surface has none) ---

function formatGateLine(gate: TeardownGate): string {
  if (gate.allowed) return `Control repo ownership: ${gate.ownership.kind.toUpperCase()} — proceeding.`;
  return `⚠ REFUSED — ${gate.reason ?? 'ownership check did not authorize teardown.'}`;
}

function formatInventoryLines(inventory: readonly DeactivateInventoryEntry[]): string[] {
  return inventory.map((e) => `  ${e.target.kind.padEnd(20)} ${e.target.name.padEnd(40)} currently: ${e.presence}`);
}

function formatVariableOutcomeLines(outcomes: readonly VariableTeardownOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.target.kind.padEnd(20)} ${o.target.name.padEnd(40)} ${o.status.toUpperCase()}${suffix}`;
  });
}

function formatRepoOutcomeLines(outcomes: readonly RepoArchiveOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.repo}: ${o.status.toUpperCase()}${suffix}`;
  });
}

function planTargetsPreview(targets: readonly DeactivateTarget[]): string[] {
  return [
    'The following EXACT registry keys would be removed (never a prefix sweep — DR-043 Amendment G):',
    ...targets.map((t) => `  ${t.kind.padEnd(20)} ${t.name}`),
  ];
}

// --- deactivate ---

export interface DeactivateResult {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly outcomes: readonly VariableTeardownOutcome[];
}

function deactivateResultToJson(result: DeactivateResult): unknown {
  return {
    schema_version: FLEET_TEARDOWN_JSON_SCHEMA_VERSION,
    mode: 'deactivate',
    fleet: result.fleet,
    gate: { allowed: result.gate.allowed, ownership: result.gate.ownership, reason: result.gate.reason ?? null },
    outcomes: result.outcomes.map((o) => ({ ...o })),
  };
}

function deactivateExitCode(result: DeactivateResult): number {
  if (!result.gate.allowed) return 1;
  return result.outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

/**
 * `macf fleet deactivate -f fleet.yaml [--yes] [--json]`. Returns the shell
 * exit code. NEVER exits the process directly.
 */
export async function runFleetDeactivate(opts: RunFleetTeardownOptions, deps?: FleetTeardownDeps): Promise<number> {
  const loaded = loadManifest(opts);
  if (isFailure(loaded)) return renderFailure(loaded, opts);
  const manifest = loaded;

  const resolved = deps ?? resolveDeps();
  const plan: DeactivatePlan = await buildDeactivatePlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result: DeactivateResult = { fleet: plan.fleet, gate: plan.gate, outcomes: [] };
    if (opts.json) console.log(JSON.stringify(deactivateResultToJson(result), null, 2));
    return deactivateExitCode(result);
  }

  process.stderr.write(`${planTargetsPreview(plan.targets).join('\n')}\n\n`);
  process.stderr.write('Current registry state:\n');
  process.stderr.write(`${formatInventoryLines(plan.inventory).join('\n')}\n`);

  const approved = opts.yes === true ? true : await resolved.confirm(`\nDeactivate fleet "${plan.fleet}" (remove ${String(plan.targets.length)} registry key(s))?`);
  if (!approved) {
    console.error('Aborted by operator — nothing was removed.');
    return 1;
  }

  const outcomes = await executeDeactivate(manifest, plan.targets, resolved);
  const result: DeactivateResult = { fleet: plan.fleet, gate: plan.gate, outcomes };

  if (opts.json) {
    console.log(JSON.stringify(deactivateResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(outcomes).join('\n'));
  }
  return deactivateExitCode(result);
}

// --- archive ---

export interface ArchiveResult extends DeactivateResult {
  readonly repoOutcomes: readonly RepoArchiveOutcome[];
}

function archiveResultToJson(result: ArchiveResult): unknown {
  return { ...(deactivateResultToJson(result) as Record<string, unknown>), mode: 'archive', repo_outcomes: result.repoOutcomes.map((o) => ({ ...o })) };
}

function archiveExitCode(result: ArchiveResult): number {
  if (deactivateExitCode(result) !== 0) return 1;
  return result.repoOutcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

/**
 * `macf fleet archive -f fleet.yaml [--yes] [--json]` — `deactivate` +
 * archives the control repo and every agent repo (DR-043 Amendment G's
 * cumulative rungs). Returns the shell exit code. NEVER exits the process
 * directly.
 */
export async function runFleetArchive(opts: RunFleetTeardownOptions, deps?: FleetTeardownDeps): Promise<number> {
  const loaded = loadManifest(opts);
  if (isFailure(loaded)) return renderFailure(loaded, opts);
  const manifest = loaded;

  const resolved = deps ?? resolveDeps();
  const plan: ArchivePlan = await buildArchivePlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result: ArchiveResult = { fleet: plan.fleet, gate: plan.gate, outcomes: [], repoOutcomes: [] };
    if (opts.json) console.log(JSON.stringify(archiveResultToJson(result), null, 2));
    return archiveExitCode(result);
  }

  process.stderr.write(`${planTargetsPreview(plan.targets).join('\n')}\n\n`);
  process.stderr.write('Current registry state:\n');
  process.stderr.write(`${formatInventoryLines(plan.inventory).join('\n')}\n\n`);
  process.stderr.write('The following repos would be ARCHIVED (read-only; reversible via `apply`):\n');
  process.stderr.write(`${plan.repoTargets.map((r) => `  ${r}`).join('\n')}\n`);

  const approved =
    opts.yes === true
      ? true
      : await resolved.confirm(
          `\nArchive fleet "${plan.fleet}" (remove ${String(plan.targets.length)} registry key(s) + archive ${String(plan.repoTargets.length)} repo(s))?`,
        );
  if (!approved) {
    console.error('Aborted by operator — nothing was removed or archived.');
    return 1;
  }

  const outcomes = await executeDeactivate(manifest, plan.targets, resolved);
  const repoOutcomes = await executeArchiveRepos(plan.repoTargets, resolved);
  const result: ArchiveResult = { fleet: plan.fleet, gate: plan.gate, outcomes, repoOutcomes };

  if (opts.json) {
    console.log(JSON.stringify(archiveResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(outcomes).join('\n'));
    console.log('');
    console.log(formatRepoOutcomeLines(repoOutcomes).join('\n'));
  }
  return archiveExitCode(result);
}
