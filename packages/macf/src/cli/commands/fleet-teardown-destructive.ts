/**
 * `macf fleet delete-apps` / `macf fleet destroy` — DR-043 Amendment G, the
 * IRREVERSIBLE half of the fleet teardown ladder (groundnuty/macf#867). See
 * `bootstrap/teardown-destructive.ts`'s module doc for the full design
 * (target derivation, the destroy acknowledgment ladder, the age-key-shred
 * opt-in). `deactivate` / `archive` (the reversible rungs) are a SEPARATE
 * command file (`fleet-teardown.ts`) — never merged into this one, per
 * Amendment G's "friction is the feature": different blast radii must not
 * be one typo apart.
 *
 * Same overall shape as `fleet-teardown.ts`: a read-only plan/inventory is
 * built + rendered FIRST, confirmation is obtained, THEN the mutating step
 * runs. `--json` always emits a valid, non-empty JSON object on stdout, even
 * on failure (macf#830 lesson).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import { checkControlRepoMeta, realReadControlFleetLockFile, realReadControlManifestFile } from '../bootstrap/control-repo.js';
import { checkRegistryVariablePresence } from '../bootstrap/observer.js';
import { realDeleteRegistryVariable } from '../bootstrap/variable-write.js';
import { realArchiveRepo } from '../bootstrap/repo-archive.js';
import { realDeleteRepo } from '../bootstrap/repo-destroy.js';
import { assertAgeIdentityReadable, realShredAgeIdentity } from '../bootstrap/age-key-shred.js';
import type { AppDeletionDeps, AppDeletionOutcome } from '../bootstrap/app-identity-removal.js';
import { resolveAppPresenceStatus } from '../bootstrap/app-presence.js';
import type { DeleteAppsPlan, DestroyPlan, DestroyRepoDeps, FleetLockReadStatus, RepoDestroyOutcome } from '../bootstrap/teardown-destructive.js';
import {
  buildDeleteAppsPlan,
  buildDestroyPlan,
  evaluateDestroyAcknowledgments,
  evaluateShredRequest,
  executeDeleteApps,
  executeDestroy,
} from '../bootstrap/teardown-destructive.js';
import type {
  DeactivateInventoryEntry,
  DeactivateTarget,
  RepoArchiveOutcome,
  TeardownAgentDeps,
  TeardownControlRepoDeps,
  TeardownGate,
  TeardownRepoArchiveDeps,
  TeardownVariableDeps,
  VariableTeardownOutcome,
} from '../bootstrap/teardown.js';

/**
 * `groundnuty/macf#1033` extended `executeDeactivate` (shared by `deactivate`
 * / `archive` / this module's `delete-apps` / `destroy`) to stop a LIVE
 * agent gracefully before deleting its registration. That graceful-stop
 * behavior is EXPLICITLY OUT OF SCOPE for `delete-apps`/`destroy`
 * (`teardown.ts`'s own module doc: "explicitly OUT OF SCOPE for this
 * module" — irreversible rungs need a separate, harder-to-reach command,
 * never new behavior smuggled in via a shared helper). This shim keeps
 * BOTH irreversible commands byte-for-byte behaviorally unchanged: every
 * `agent_registration` target is always classified `'dead'`, so
 * `executeDeactivate` takes the SAME direct-delete path it always did here
 * — only the TYPE surface grew (the shared function now requires
 * `TeardownAgentDeps`), never the runtime behavior of these two commands.
 */
const AGENT_STOP_OUT_OF_SCOPE_SHIM: TeardownAgentDeps = {
  checkAgentReachability: () => Promise.resolve('dead'),
  requestGracefulExit: () => Promise.resolve(),
  sleep: () => Promise.resolve(),
};

const execFileAsync = promisify(execFile);

export const FLEET_TEARDOWN_DESTRUCTIVE_JSON_SCHEMA_VERSION = 1;

/** The env-acknowledgment `destroy` requires — a dedicated var name, never reused from any other MACF env flag, so it can never be set "by accident" via an unrelated `MACF_*=1` export. */
export const DESTROY_ENV_ACK_VAR = 'MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES';

// --- Manifest loading (shared failure shape — same as fleet-teardown.ts) ---

interface TeardownFailure {
  readonly code: string;
  readonly message: string;
}

function failureToJson(mode: 'delete-apps' | 'destroy', failure: TeardownFailure): unknown {
  return { schema_version: FLEET_TEARDOWN_DESTRUCTIVE_JSON_SCHEMA_VERSION, mode, error: failure };
}

function renderFailure(mode: 'delete-apps' | 'destroy', failure: TeardownFailure, json: boolean | undefined): number {
  console.error(failure.message);
  if (json) console.log(JSON.stringify(failureToJson(mode, failure), null, 2));
  return 1;
}

function loadManifest(file: string): FleetManifest | TeardownFailure {
  const manifestPath = resolvePath(file);
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

function formatRegistryTargetsPreview(targets: readonly DeactivateTarget[]): string[] {
  return targets.map((t) => `  ${t.kind.padEnd(20)} ${t.name}`);
}

type RepoRungAction = 'archive' | 'delete';

/**
 * Honest-unknown caveat for the App-identity section (groundnuty/macf#953)
 * — surfaced whenever `fleet.lock` was not successfully read, so an
 * operator never mistakes "the lock couldn't be checked" for "the lock was
 * checked and found nothing extra beyond `fleet.yaml`." `undefined` (no
 * line) only for `'read'` — the one status where the App-identity section
 * above it can actually claim completeness.
 */
function formatLockReadCaveat(status: FleetLockReadStatus): string | undefined {
  if (status === 'read') return undefined;
  const why = status === 'not-attempted' ? 'was not read' : 'could not be read or parsed';
  return (
    `  ⚠ fleet.lock ${why} — cannot confirm whether ADDITIONAL non-agent App identities (e.g. a runner-ops App ` +
    "with administration:write) exist beyond what's listed above. This report may be INCOMPLETE."
  );
}

/** Shared "here is everything this run would touch" render, with irreversible items called out SEPARATELY from recoverable ones — the shared rail applies to BOTH `delete-apps` and `destroy`; only which section the repo list lands in differs. `action` is an explicit discriminator (never string-sniffed from a display label) so the branch can't silently drift from the label text. */
function formatFullInventory(plan: DeleteAppsPlan | DestroyPlan, action: RepoRungAction): string[] {
  const lines: string[] = [];
  lines.push('RECOVERABLE (free or cheap to revive):');
  lines.push('  Registry keys (EXACT — never a prefix sweep) — removed, free revival via `apply`:');
  lines.push(...formatRegistryTargetsPreview(plan.registryTargets).map((l) => `  ${l}`));
  lines.push('  Current registry state:');
  lines.push(...formatInventoryLines(plan.registryInventory).map((l) => `  ${l}`));
  lines.push('  App identities (revival cost: 2 browser clicks/agent to recreate) — cannot be deleted via API, manual step reported below:');
  for (const a of plan.appTargets) {
    const idSuffix = a.appId === undefined ? ' (predicted slug — no fleet.lock App ID to confirm it)' : ` (app_id ${a.appId}, confirmed from fleet.lock)`;
    // groundnuty/macf#953: a lock-only role (e.g. runner-ops) is marked
    // distinctly — it's already ordered FIRST by `enrichAppIdentityTargetsWithLock`
    // (see that function's doc), and gets a visible ⚠ here too.
    const marker = a.extraFromLock === true ? '⚠ NOT IN fleet.yaml (found via fleet.lock only) ' : '';
    lines.push(`    ${marker}${a.role.padEnd(20)} ${a.appSlug}${idSuffix}`);
  }
  const lockCaveat = formatLockReadCaveat(plan.lockReadStatus);
  if (lockCaveat !== undefined) lines.push(lockCaveat);
  lines.push('');
  if (action === 'archive') {
    lines.push('Repositories to be ARCHIVED (reversible via `apply`):');
    for (const r of plan.repoTargets) lines.push(`  ${r}`);
  } else {
    lines.push('⚠ IRREVERSIBLE — NO UNDO, EVER:');
    for (const r of plan.repoTargets) lines.push(`  ${r} (repository DELETE, not archive — agent repos first, control repo LAST)`);
  }
  return lines;
}

function formatVariableOutcomeLines(outcomes: readonly VariableTeardownOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.target.kind.padEnd(20)} ${o.target.name.padEnd(40)} ${o.status.toUpperCase()}${suffix}`;
  });
}

function formatRepoArchiveOutcomeLines(outcomes: readonly RepoArchiveOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.repo}: ${o.status.toUpperCase()}${suffix}`;
  });
}

function formatRepoDestroyOutcomeLines(outcomes: readonly RepoDestroyOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.repo}: ${o.status.toUpperCase()}${suffix}`;
  });
}

function formatAppOutcomeLines(outcomes: readonly AppDeletionOutcome[]): string[] {
  return outcomes.map((o) => {
    const idSuffix = o.appId === undefined ? '' : ` (app_id ${o.appId})`;
    // groundnuty/macf#917: an `'already-absent'` outcome has nothing to
    // point a browser at — render its own status line instead of the
    // fixed "MANUAL ACTION REQUIRED — <url>" shape every prior outcome used.
    // groundnuty/macf#967: `'unknown'` gets ITS OWN line too — never folded
    // into MANUAL ACTION REQUIRED (which implies a confirmed `'present'`)
    // nor into ALREADY-ABSENT (a confident negative) — see
    // `AppDeletionOutcome.status`'s doc for why the three stay distinct.
    const detail =
      o.status === 'already-absent'
        ? 'ALREADY-ABSENT — nothing to delete'
        : o.status === 'unknown'
          ? `UNKNOWN — could not verify; check manually: ${o.settingsUrl}`
          : `MANUAL ACTION REQUIRED — ${o.settingsUrl}`;
    // groundnuty/macf#953: mark a lock-only (not in fleet.yaml) role distinctly.
    const marker = o.extraFromLock === true ? '⚠ NOT IN fleet.yaml ' : '';
    return `  ${marker}${o.role.padEnd(20)} ${o.appSlug.padEnd(30)}${idSuffix} ${detail}`;
  });
}

// --- Real (production) deps ---

async function realOpenUrl(url: string): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    await execFileAsync('open', [url]);
  } else if (platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '""', url]);
  } else {
    await execFileAsync('xdg-open', [url]);
  }
}

/** Real y/N prompt on stderr (stdout stays clean for a `--json` render) — same shape as `fleet-teardown.ts`'s `realConfirm`. */
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

/** Real typed-text prompt — returns the RAW (trimmed) answer, never coerced to boolean, since `destroy`'s gate needs the exact string to compare against the fleet name. */
async function realConfirmFleetName(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// --- delete-apps ---

export interface RunFleetDeleteAppsOptions {
  readonly file: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

export interface FleetDeleteAppsDeps
  extends TeardownControlRepoDeps,
    Pick<TeardownVariableDeps, 'checkRegistryPresence' | 'deleteRegistryVariable'>,
    TeardownRepoArchiveDeps,
    TeardownAgentDeps,
    AppDeletionDeps {
  readonly confirm: (question: string) => Promise<boolean>;
  /** Best-effort `fleet.lock` App-ID enrichment — see `teardown-destructive.ts`'s `IrreversibleTeardownPlanDeps.readFleetLock` doc. Optional; omitting it degrades gracefully to slug-only App-identity targets. */
  readonly readFleetLock?: (repo: string) => Promise<string | undefined>;
}

/** Exported ONLY so `apply-deps-wiring.test.ts` can pin every field by identity (the "defined, tested, never wired" class that file exists to catch — see its module doc) — not otherwise part of this command's public surface. */
export function resolveDeleteAppsDeps(): FleetDeleteAppsDeps {
  return {
    checkMeta: checkControlRepoMeta,
    readManifestFile: realReadControlManifestFile,
    readFleetLock: realReadControlFleetLockFile,
    checkRegistryPresence: checkRegistryVariablePresence,
    deleteRegistryVariable: realDeleteRegistryVariable,
    archiveRepo: realArchiveRepo,
    openUrl: realOpenUrl,
    checkAppPresence: resolveAppPresenceStatus,
    confirm: realConfirm,
    ...AGENT_STOP_OUT_OF_SCOPE_SHIM,
  };
}

export interface DeleteAppsResult {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly registryOutcomes: readonly VariableTeardownOutcome[];
  readonly repoOutcomes: readonly RepoArchiveOutcome[];
  readonly appOutcomes: readonly AppDeletionOutcome[];
  /** Carried through from {@link DeleteAppsPlan.lockReadStatus} — groundnuty/macf#953's honest-unknown floor, surfaced to `--json` consumers too. */
  readonly lockReadStatus: FleetLockReadStatus;
}

function deleteAppsResultToJson(result: DeleteAppsResult): unknown {
  return {
    schema_version: FLEET_TEARDOWN_DESTRUCTIVE_JSON_SCHEMA_VERSION,
    mode: 'delete-apps',
    fleet: result.fleet,
    gate: { allowed: result.gate.allowed, ownership: result.gate.ownership, reason: result.gate.reason ?? null },
    registry_outcomes: result.registryOutcomes.map((o) => ({ ...o })),
    repo_outcomes: result.repoOutcomes.map((o) => ({ ...o })),
    app_outcomes: result.appOutcomes.map((o) => ({ ...o })),
    lock_read_status: result.lockReadStatus,
  };
}

/**
 * `delete-apps`'s exit code is non-zero whenever there is at least ONE App
 * identity outcome at all — which, per `app-identity-removal.ts`, is EVERY
 * App identity, always (there is no REST path to delete one). This is
 * deliberate: "report what could not be done, never exit green" (Amendment
 * G) means a `delete-apps` run can never honestly report full success while
 * ANY App-identity outcome exists. Exit 0 is reserved for the degenerate
 * empty-fleet case.
 *
 * **`'already-absent'` (groundnuty/macf#917) does NOT relax this — on
 * purpose, deliberated during review.** It reads tempting to treat a
 * confirmed-gone App as "nothing left to do" and let the exit go green.
 * Even though groundnuty/macf#967 upgraded the confidence behind
 * `'already-absent'` (an org-installations-listing MISS is authoritative,
 * not the ambiguous predicted-slug 404 alone — see
 * `app-presence.ts::resolveAppPresence`'s doc), the SAME read can still fall
 * back to the plain predicted-slug check (personal-account-owned fleets;
 * listing unavailable) — that fallback path never resolves `'already-absent'`
 * on its own (an inconclusive fallback degrades to `'unknown'` instead), but
 * a reader of this exit-code contract shouldn't have to know which resolution
 * PATH produced a given outcome to trust the code. Letting `'already-absent'`
 * flip the exit code to 0 would reintroduce exactly the false-absent-drives-
 * a-green-exit shape DR-043 Amendment A's "honest-unknown over false-
 * `present`" posture (and this rail's own "never exit green") exist to
 * prevent — and a NEW `'unknown'` outcome (groundnuty/macf#967) is even
 * LESS reason to go green: "couldn't verify" is never "nothing to do." The
 * `report` text changes (`'already-absent'`/`'unknown'` status, their
 * distinct render lines) — the exit-code contract does not.
 *
 * **`lockReadStatus` deliberately does NOT affect the exit code** (groundnuty/
 * macf#953). `result.appOutcomes.length > 0` already forces red for any
 * fleet (manifest `agents[]` requires >= 1), so gating on `lockReadStatus`
 * too would be unreachable dead code AND would silently change the one
 * documented exit-0 case above (degenerate empty-fleet) for the common
 * "no `readFleetLock` dep wired" path. The honest-unknown floor is carried
 * by `lock_read_status` in the `--json` payload and the loud
 * `formatLockReadCaveat` render line instead — visibility, not a new
 * gating condition.
 */
function deleteAppsExitCode(result: DeleteAppsResult): number {
  if (!result.gate.allowed) return 1;
  if (result.registryOutcomes.some((o) => o.status === 'failed')) return 1;
  if (result.repoOutcomes.some((o) => o.status === 'failed')) return 1;
  if (result.appOutcomes.length > 0) return 1;
  return 0;
}

/**
 * `macf fleet delete-apps -f fleet.yaml [--yes] [--json]`. Returns the shell
 * exit code. NEVER exits the process directly.
 */
export async function runFleetDeleteApps(opts: RunFleetDeleteAppsOptions, deps?: FleetDeleteAppsDeps): Promise<number> {
  const loaded = loadManifest(opts.file);
  if (isFailure(loaded)) return renderFailure('delete-apps', loaded, opts.json);
  const manifest = loaded;

  const resolved = deps ?? resolveDeleteAppsDeps();
  const plan: DeleteAppsPlan = await buildDeleteAppsPlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result: DeleteAppsResult = { fleet: plan.fleet, gate: plan.gate, registryOutcomes: [], repoOutcomes: [], appOutcomes: [], lockReadStatus: plan.lockReadStatus };
    if (opts.json) console.log(JSON.stringify(deleteAppsResultToJson(result), null, 2));
    return deleteAppsExitCode(result);
  }

  process.stderr.write(`${formatFullInventory(plan, 'archive').join('\n')}\n`);

  const approved =
    opts.yes === true
      ? true
      : await resolved.confirm(
          `\nRemove fleet "${plan.fleet}"'s registry keys, archive ${String(plan.repoTargets.length)} repo(s), and ` +
            `report ${String(plan.appTargets.length)} App identity(s) requiring MANUAL browser deletion?`,
        );
  if (!approved) {
    console.error('Aborted by operator — nothing was removed or archived.');
    return 1;
  }

  // Narration goes to stderr, NEVER stdout — `reportAppIdentityRemoval`
  // (invoked from `executeDeleteApps`/`executeDestroy` below) fires this
  // callback unconditionally, including under `--json`; if it wrote to
  // stdout it would interleave with the final `console.log(JSON.stringify(...))`
  // and corrupt the JSON payload a `--json` consumer parses. Same
  // "stdout is data, stderr is narration" split every other fleet-teardown
  // command in this package uses.
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const { registryOutcomes, repoOutcomes, appOutcomes } = await executeDeleteApps(manifest, plan, log, resolved);
  const result: DeleteAppsResult = { fleet: plan.fleet, gate: plan.gate, registryOutcomes, repoOutcomes, appOutcomes, lockReadStatus: plan.lockReadStatus };

  if (opts.json) {
    console.log(JSON.stringify(deleteAppsResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(registryOutcomes).join('\n'));
    console.log('');
    console.log(formatRepoArchiveOutcomeLines(repoOutcomes).join('\n'));
    console.log('');
    console.log(formatAppOutcomeLines(appOutcomes).join('\n'));
  }
  return deleteAppsExitCode(result);
}

// --- destroy ---

export interface RunFleetDestroyOptions {
  readonly file: string;
  /** `--destroy-repositories` — implied by NOTHING else (module doc). */
  readonly destroyRepositories?: boolean;
  readonly shredAgeKey?: boolean;
  readonly ageIdentity?: string;
  readonly json?: boolean;
}

export interface FleetDestroyDeps
  extends TeardownControlRepoDeps,
    Pick<TeardownVariableDeps, 'checkRegistryPresence' | 'deleteRegistryVariable'>,
    DestroyRepoDeps,
    TeardownAgentDeps,
    AppDeletionDeps {
  readonly confirmFleetName: (question: string) => Promise<string>;
  /**
   * The env-acknowledgment READ lives HERE, inside the tested unit — not
   * pre-resolved by the CLI wiring layer (`index.ts`) into a plain boolean
   * option. A prior revision took `envAck: boolean` as a `RunFleetDestroyOptions`
   * field, computed by `index.ts` from `process.env[DESTROY_ENV_ACK_VAR] === '1'`
   * — that put ONE of destroy's THREE required acknowledgments in untested
   * glue: `apply-deps-wiring.test.ts` pins every OTHER real primitive by
   * identity, but a future one-character edit to that `index.ts` line (e.g.
   * `envAck: true`) would silently reduce the ladder from three gates to
   * two, and no wiring pin would ever see it (exactly the "defined, tested,
   * never wired" class that file exists to catch). Defaults to a real
   * `process.env` read ({@link realReadEnv}), itself wiring-pinned.
   */
  readonly readEnv?: (name: string) => string | undefined;
  /**
   * Pre-flight readability check, run BEFORE any mutation — see
   * `age-key-shred.ts::assertAgeIdentityReadable` + this module's
   * `runFleetDestroy` doc for why a bad `--age-identity` path refuses the
   * ENTIRE run rather than deleting repositories and only then discovering
   * the shred can't proceed. Optional so a test that never opts into
   * shredding need not supply it.
   */
  readonly assertAgeIdentityReadable?: (identityPath: string) => void;
  /** Only ever invoked AFTER pre-flight validation + every acknowledgment has passed — see module doc. Optional so a test that never opts into shredding need not supply it. */
  readonly shredAgeIdentity?: (identityPath: string) => Promise<void>;
  /** Best-effort `fleet.lock` App-ID enrichment — see `teardown-destructive.ts`'s `IrreversibleTeardownPlanDeps.readFleetLock` doc. Optional; omitting it degrades gracefully to slug-only App-identity targets. */
  readonly readFleetLock?: (repo: string) => Promise<string | undefined>;
}

/** Real `process.env` read — the default {@link FleetDestroyDeps.readEnv}, exported + wiring-pinned so the env-acknowledgment read stays inside the tested surface (see that field's doc). */
export function realReadEnv(name: string): string | undefined {
  return process.env[name];
}

/** Exported ONLY so `apply-deps-wiring.test.ts` can pin every field by identity — see {@link resolveDeleteAppsDeps}'s doc for why. */
export function resolveDestroyDeps(): FleetDestroyDeps {
  return {
    checkMeta: checkControlRepoMeta,
    readManifestFile: realReadControlManifestFile,
    readFleetLock: realReadControlFleetLockFile,
    checkRegistryPresence: checkRegistryVariablePresence,
    deleteRegistryVariable: realDeleteRegistryVariable,
    deleteRepo: realDeleteRepo,
    openUrl: realOpenUrl,
    checkAppPresence: resolveAppPresenceStatus,
    confirmFleetName: realConfirmFleetName,
    readEnv: realReadEnv,
    assertAgeIdentityReadable,
    shredAgeIdentity: realShredAgeIdentity,
    ...AGENT_STOP_OUT_OF_SCOPE_SHIM,
  };
}

export interface DestroyResult {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly acknowledgmentsMissing: readonly string[];
  readonly registryOutcomes: readonly VariableTeardownOutcome[];
  readonly appOutcomes: readonly AppDeletionOutcome[];
  readonly repoOutcomes: readonly RepoDestroyOutcome[];
  readonly shredRequested: boolean;
  readonly shredPerformed: boolean;
  readonly shredReason?: string;
  /** Carried through from {@link DestroyPlan.lockReadStatus} — groundnuty/macf#953's honest-unknown floor, surfaced to `--json` consumers too. */
  readonly lockReadStatus: FleetLockReadStatus;
}

function destroyResultToJson(result: DestroyResult): unknown {
  return {
    schema_version: FLEET_TEARDOWN_DESTRUCTIVE_JSON_SCHEMA_VERSION,
    mode: 'destroy',
    fleet: result.fleet,
    gate: { allowed: result.gate.allowed, ownership: result.gate.ownership, reason: result.gate.reason ?? null },
    acknowledgments_missing: [...result.acknowledgmentsMissing],
    registry_outcomes: result.registryOutcomes.map((o) => ({ ...o })),
    app_outcomes: result.appOutcomes.map((o) => ({ ...o })),
    repo_outcomes: result.repoOutcomes.map((o) => ({ ...o })),
    shred_requested: result.shredRequested,
    shred_performed: result.shredPerformed,
    shred_reason: result.shredReason ?? null,
    lock_read_status: result.lockReadStatus,
  };
}

/**
 * Never green while ANY item remains incomplete — the ownership gate, the
 * acknowledgment ladder, any failed mutation, the App-identity report (ANY
 * outcome present forces red, including `'already-absent'` — see
 * `deleteAppsExitCode`'s doc for why groundnuty/macf#917 deliberately does
 * NOT relax this), and a requested-but-failed/refused shred all force a
 * non-zero exit. `lockReadStatus` deliberately does NOT gate the exit code
 * — see `deleteAppsExitCode`'s matching doc (groundnuty/macf#953) for why.
 */
function destroyExitCode(result: DestroyResult): number {
  if (!result.gate.allowed) return 1;
  if (result.acknowledgmentsMissing.length > 0) return 1;
  if (result.registryOutcomes.some((o) => o.status === 'failed')) return 1;
  if (result.repoOutcomes.some((o) => o.status === 'failed')) return 1;
  if (result.appOutcomes.length > 0) return 1;
  if (result.shredRequested && !result.shredPerformed) return 1;
  return 0;
}

/** Shared shape for every early-refusal return in {@link runFleetDestroy} — keeps the repeated result-construction below from drifting field-by-field. */
function destroyRefusalResult(
  plan: DestroyPlan,
  overrides: Partial<Omit<DestroyResult, 'fleet' | 'gate' | 'lockReadStatus'>>,
): DestroyResult {
  return {
    fleet: plan.fleet,
    gate: plan.gate,
    acknowledgmentsMissing: [],
    registryOutcomes: [],
    appOutcomes: [],
    repoOutcomes: [],
    shredRequested: false,
    shredPerformed: false,
    lockReadStatus: plan.lockReadStatus,
    ...overrides,
  };
}

/**
 * `macf fleet destroy -f fleet.yaml --destroy-repositories [--shred-age-key --age-identity <path>] [--json]`.
 * Returns the shell exit code. NEVER exits the process directly.
 *
 * Ordering (each step gates the next; a refusal at ANY step touches
 * NOTHING mutating): ownership gate → render the full inventory (read-only)
 * → age-key-shred PRE-FLIGHT validation (if `--shred-age-key` was passed,
 * BEFORE any repo is touched — see `age-key-shred.ts`'s module doc for why
 * a bad `--age-identity` must refuse the ENTIRE run rather than delete
 * repositories and only then discover the shred can't proceed) → the
 * 3-acknowledgment ladder → execute (registry delete, App report, repo
 * delete — agent repos before the control repo, see `buildDestroyPlan`'s
 * doc) → the age-key shred itself, now pre-validated.
 */
export async function runFleetDestroy(opts: RunFleetDestroyOptions, deps?: FleetDestroyDeps): Promise<number> {
  const loaded = loadManifest(opts.file);
  if (isFailure(loaded)) return renderFailure('destroy', loaded, opts.json);
  const manifest = loaded;

  const resolved = deps ?? resolveDestroyDeps();
  const plan: DestroyPlan = await buildDestroyPlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result = destroyRefusalResult(plan, {});
    if (opts.json) console.log(JSON.stringify(destroyResultToJson(result), null, 2));
    return destroyExitCode(result);
  }

  process.stderr.write(`${formatFullInventory(plan, 'delete').join('\n')}\n`);

  // --- age-key-shred PRE-FLIGHT — validated BEFORE anything is deleted ---
  const shredRequested = opts.shredAgeKey === true;
  const shredDecision = evaluateShredRequest({ shredRequested, identityPath: opts.ageIdentity });
  if (shredRequested && !shredDecision.proceed) {
    console.error(shredDecision.reason ?? 'shred request refused');
    const result = destroyRefusalResult(plan, { shredRequested, shredReason: shredDecision.reason });
    if (opts.json) console.log(JSON.stringify(destroyResultToJson(result), null, 2));
    return destroyExitCode(result);
  }
  if (shredRequested) {
    // shredDecision.proceed === true here (the branch above already
    // returned otherwise) — but "a path was given" is not "the path is
    // readable"; check readability BEFORE committing to the rest of the
    // run, same fail-fast-before-irreversible-work posture.
    const assertReadable = resolved.assertAgeIdentityReadable ?? assertAgeIdentityReadable;
    try {
      assertReadable(opts.ageIdentity as string);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(reason);
      const result = destroyRefusalResult(plan, { shredRequested, shredReason: reason });
      if (opts.json) console.log(JSON.stringify(destroyResultToJson(result), null, 2));
      return destroyExitCode(result);
    }
    process.stderr.write(
      '⚠ --shred-age-key requested (pre-flight validated — the path exists and is readable): the age identity ' +
        'key WILL ALSO be cryptographically shredded, AFTER the repositories are deleted. This is the single ' +
        'action with NO recovery whatsoever, and it ALSO makes `deactivate`/`archive` non-revivable for this ' +
        'fleet\'s App credentials — their "free revival" depends on the vault still being decryptable.\n',
    );
  }

  const destroyRepositoriesFlag = opts.destroyRepositories === true;
  const readEnv = resolved.readEnv ?? realReadEnv;
  const envAck = readEnv(DESTROY_ENV_ACK_VAR) === '1';
  // The interactive typed-name prompt is skipped once the cheap boolean
  // gates already fail — see module doc: don't demand the scary
  // confirmation on a run that's refused regardless.
  const typedFleetName = destroyRepositoriesFlag && envAck ? await resolved.confirmFleetName(`\nType the fleet name "${plan.fleet}" to confirm IRREVERSIBLE deletion of its repositories: `) : '';
  const ack = evaluateDestroyAcknowledgments(plan.fleet, { destroyRepositoriesFlag, envAck, typedFleetName });

  if (!ack.allowed) {
    for (const m of ack.missing) console.error(`Refused — ${m}`);
    const result = destroyRefusalResult(plan, { acknowledgmentsMissing: ack.missing, shredRequested });
    if (opts.json) console.log(JSON.stringify(destroyResultToJson(result), null, 2));
    return destroyExitCode(result);
  }

  // Narration goes to stderr, NEVER stdout — `reportAppIdentityRemoval`
  // (invoked from `executeDeleteApps`/`executeDestroy` below) fires this
  // callback unconditionally, including under `--json`; if it wrote to
  // stdout it would interleave with the final `console.log(JSON.stringify(...))`
  // and corrupt the JSON payload a `--json` consumer parses. Same
  // "stdout is data, stderr is narration" split every other fleet-teardown
  // command in this package uses.
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const { registryOutcomes, appOutcomes, repoOutcomes } = await executeDestroy(manifest, plan, log, resolved);

  // The shred itself — pre-flight-validated above, but still defensively
  // try/caught (TOCTOU: the file could vanish between the pre-flight check
  // and here, or `unlinkSync` could hit a transient permission error).
  let shredPerformed = false;
  let shredReason: string | undefined;
  if (shredRequested) {
    if (resolved.shredAgeIdentity === undefined) {
      shredReason = 'no shredAgeIdentity dependency wired — nothing was shredded.';
      console.error(shredReason);
    } else {
      try {
        await resolved.shredAgeIdentity(opts.ageIdentity as string);
        shredPerformed = true;
        console.log(`Age identity at "${opts.ageIdentity as string}" shredded.`);
      } catch (err) {
        shredReason = err instanceof Error ? err.message : String(err);
        console.error(`Age identity shred FAILED: ${shredReason}`);
      }
    }
  }

  const result: DestroyResult = {
    fleet: plan.fleet,
    gate: plan.gate,
    acknowledgmentsMissing: [],
    registryOutcomes,
    appOutcomes,
    repoOutcomes,
    shredRequested,
    shredPerformed,
    shredReason,
    lockReadStatus: plan.lockReadStatus,
  };

  if (opts.json) {
    console.log(JSON.stringify(destroyResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(registryOutcomes).join('\n'));
    console.log('');
    console.log(formatAppOutcomeLines(appOutcomes).join('\n'));
    console.log('');
    console.log(formatRepoDestroyOutcomeLines(repoOutcomes).join('\n'));
  }
  return destroyExitCode(result);
}
