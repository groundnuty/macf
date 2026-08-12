/**
 * `macf bootstrap apply` (DR-043 §D2/§D3, Slice 2b of groundnuty/macf#838).
 *
 * **`--dry-run` (unchanged, byte-identical to increments 1-3):** renders the
 * read-only plan plus the exact GitHub App-manifest documents (+ consent
 * gate 2 install URLs) that would be submitted — the DR-035 §4
 * plan-approve-once artifact, shown BEFORE any browser gate opens. Mutates
 * nothing.
 *
 * **Real apply (increment 5a — the orchestrator, THIS increment):** computes
 * the same plan, shows it plus the blast radius, obtains ONE explicit
 * operator approval (`--yes` to skip interactively, for automation), then
 * drives `apply-fleet.ts::applyFleet` — per-agent confirm-before-create
 * guard → consent gate 1 → consent gate 2 → repo-init → the single
 * whole-payload vault write → `fleet.lock`. See `apply-fleet.ts`'s module
 * doc for the full ordering rationale (why the vault write is batched, why
 * `fleet.lock` splits into two write moments) and `apply-agent.ts`'s module
 * doc for the per-agent gate-1→gate-2 window discussion. NEVER logs a
 * secret (PEM / client / webhook secret) — every render in this file reads
 * only `role`/`status`/`appId`/`installId`/`reason`/paths off the outcomes,
 * never `credentials`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { deriveAppHandle, parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlan, FleetPlanFailure, UnimplementedApplyItem } from '../bootstrap/plan.js';
import {
  computePlan,
  fleetPlanFailureToJson,
  fleetPlanToJson,
  formatPlanText,
  formatUnimplementedLines,
  summarizePlan,
} from '../bootstrap/plan.js';
import { githubRegistryObserver, readFleetLock } from '../bootstrap/observer.js';
import type { GitHubAppManifest } from '../bootstrap/app-manifest.js';
import { buildAppManifest, repoHomepageUrl } from '../bootstrap/app-manifest.js';
import { appInstallationUrl } from '../bootstrap/identity-confirm.js';
import { realAgentApplyDeps } from '../bootstrap/apply-agent.js';
import type { AgentApplyOutcome } from '../bootstrap/apply-agent.js';
import { realCloneRepo, realCommitAndPush } from '../bootstrap/apply-repo-init.js';
import type { RepoInitStepDeps } from '../bootstrap/apply-repo-init.js';
import { applyFleet } from '../bootstrap/apply-fleet.js';
import type { FleetApplyDeps, FleetApplyResult } from '../bootstrap/apply-fleet.js';

const execFileAsync = promisify(execFile);

/**
 * The redirect URL shown in a dry-run. The REAL one carries the ephemeral
 * listener's port, chosen at exchange time — a dry run binds nothing, so it
 * renders this placeholder rather than pretending to hold a port.
 */
export const DRY_RUN_REDIRECT_PLACEHOLDER = 'http://localhost:<port-chosen-at-apply-time>/callback';

export interface RunBootstrapApplyOptions {
  readonly file: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  /** Skip the interactive plan-approval prompt (DR-035 §4 plan-approve-once — this is the one non-interactive escape). */
  readonly yes?: boolean;
}

export interface BootstrapApplyDeps {
  readonly observe: FleetObserverFn;
}

/** Extends `apply-fleet.ts`'s `FleetApplyDeps` with the two apply-CLI-level seams: the plan-approval prompt + the prior-lock read. */
export interface MutateApplyDeps extends FleetApplyDeps {
  readonly confirmPlan: (plan: FleetPlan, creations: readonly PlannedAppCreation[]) => Promise<boolean>;
  readonly readPriorLock: (manifestPath: string) => ReturnType<typeof readFleetLock>;
}

/** One agent's would-be App creation, paired with the plan item that motivated it. */
export interface PlannedAppCreation {
  readonly role: string;
  readonly repo: string;
  readonly manifest: GitHubAppManifest;
  /**
   * Consent gate 2 (§D2 point 2) — the install-page URL the operator would
   * open, once this App exists. PREDICTED from `deriveAppHandle` (this App
   * doesn't exist yet at dry-run/approval-preview time, so there is no real
   * GitHub-assigned slug to read). GitHub slugifies the submitted manifest
   * `name` and may append a disambiguating suffix on a global collision —
   * the REAL apply path (`apply-agent.ts`) uses the exchange's returned
   * `AppCredentials.slug` instead, never re-derives it.
   */
  readonly installUrl: string;
}

/**
 * Which agents would get an App created, given a computed plan. Pure. An agent
 * whose `app` item is `noop` is NOT re-created — the confirm-before-create
 * guard (`apply-agent.ts::confirmBeforeCreateGuard`) additionally re-checks
 * live before any create actually fires.
 */
export function plannedAppCreations(
  manifest: FleetManifest,
  plan: FleetPlan,
  redirectUrl: string,
): readonly PlannedAppCreation[] {
  const creating = new Set(
    plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').map((i) => i.target),
  );
  const out: PlannedAppCreation[] = [];
  for (const agent of manifest.agents) {
    const target = `agent:${agent.role}:app:${deriveAppHandle(manifest.metadata.name, agent.role)}`;
    if (!creating.has(target)) continue;
    const appManifest = buildAppManifest({
      fleetName: manifest.metadata.name,
      role: agent.role,
      redirectUrl,
      homepageUrl: repoHomepageUrl(agent.repo),
    });
    out.push({
      role: agent.role,
      repo: agent.repo,
      manifest: appManifest,
      installUrl: appInstallationUrl(appManifest.name),
    });
  }
  return out;
}

/** Human render of the would-be App creations (pure — exported for tests). */
export function formatPlannedAppCreations(creations: readonly PlannedAppCreation[]): string {
  if (creations.length === 0) {
    return 'No GitHub Apps would be created (every declared agent already has one, or presence is confirmed).';
  }
  const parts: string[] = [
    `GitHub Apps that would be created (${String(creations.length)}) — consent gate 1 (§D2), one operator click each:`,
    '',
  ];
  for (const c of creations) {
    parts.push(`  • ${c.manifest.name}   (role: ${c.role}, home repo: ${c.repo})`);
    const perms = Object.entries(c.manifest.default_permissions)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    parts.push(`      permissions (DR-019): ${perms}`);
    parts.push(`      events: ${c.manifest.default_events.join(', ')}`);
    parts.push(`      public: ${String(c.manifest.public)}   webhook active: ${String(c.manifest.hook_attributes.active)}`);
    parts.push(`      consent gate 2 (install, after gate 1 creates the App): ${c.installUrl}`);
  }
  return parts.join('\n');
}

function renderFailure(failure: FleetPlanFailure, opts: RunBootstrapApplyOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

// --- Real (production) deps for the mutating path ---

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

/** Real y/N prompt on stderr (stdout stays clean for a `--json` render). */
async function realConfirmPlan(plan: FleetPlan, creations: readonly PlannedAppCreation[]): Promise<boolean> {
  const summary = summarizePlan(plan.items);
  process.stderr.write(
    `\nThis apply will CREATE ${String(summary.creates)} resource(s) (including ${String(creations.length)} GitHub ` +
      `App(s) — ${String(creations.length * 2)} browser consent click(s): manifest-create + install, per App), ` +
      `${String(summary.updates)} update(s) requiring confirmation at the point they occur, and leave ` +
      `${String(summary.noops)} already-present resource(s) untouched. Nothing is deleted (§D3 no-prune).\n`,
  );
  // macf#854 — the plan above already lists the NOT-IMPLEMENTED items loudly
  // (formatPlanText), but this is the LAST thing the operator reads before
  // typing "yes" — restate the count here so approving doesn't read as
  // approving work that will silently never happen.
  if (plan.unimplementedByApply.length > 0) {
    process.stderr.write(
      `⚠ ${String(plan.unimplementedByApply.length)} item(s) in the plan above are NOT IMPLEMENTED by apply yet — ` +
        'approving will NOT create or update them (see the ⚠ block in the plan above for which).\n',
    );
  }
  process.stderr.write('Type "yes" to proceed with this plan, anything else to abort: ');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

function resolveMutateDeps(manifestPath: string): MutateApplyDeps {
  const repoInitDeps: RepoInitStepDeps = { cloneRepo: realCloneRepo, commitAndPush: realCommitAndPush };
  return {
    // `writeRecoveryArtifact` is deliberately absent here — `apply-fleet.ts`
    // splices it in (it owns the fleet-level context that seam needs; see
    // its module doc's "Recovery-artifact lifecycle" section).
    buildAgentDeps: (log: (line: string) => void) => realAgentApplyDeps(realOpenUrl, log),
    repoInitDeps,
    vaultDeps: {},
    now: () => new Date(),
    log: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
    allowVaultVersion: process.env['MACF_BOOTSTRAP_VAULT_VERSION'] === '1',
    confirmPlan: realConfirmPlan,
    readPriorLock: () => readFleetLock(manifestPath),
  };
}

// --- Apply-result rendering (never a credential value) ---

export const FLEET_APPLY_JSON_SCHEMA_VERSION = 1;

function agentSummaryLines(result: FleetApplyResult): string[] {
  const lines: string[] = [];
  for (const rec of result.agents) {
    const id = rec.identity;
    switch (id.status) {
      case 'created':
        lines.push(`  ${rec.role}: CREATED (app_id ${id.appId}, install_id ${id.installId})`);
        break;
      case 'reused':
        lines.push(`  ${rec.role}: REUSED — already confirmed live (app_id ${id.appId}, install_id ${id.installId})`);
        break;
      case 'resumed-install':
        lines.push(`  ${rec.role}: RESUMED INSTALL (app_id ${id.appId}, install_id ${id.installId})`);
        break;
      case 'skipped-unverified':
        lines.push(`  ${rec.role}: SKIPPED (unverified) — ${id.reason}`);
        break;
      case 'drift':
        lines.push(`  ${rec.role}: DRIFT — ${id.reason}`);
        break;
      case 'failed':
        lines.push(`  ${rec.role}: FAILED — ${id.reason}`);
        break;
    }
    if (rec.repoInit) {
      lines.push(
        rec.repoInit.status === 'applied'
          ? `    repo-init: applied to ${rec.repoInit.repo} (pushed: ${String(rec.repoInit.pushed)})`
          : `    repo-init: FAILED on ${rec.repoInit.repo} — ${rec.repoInit.reason}`,
      );
    }
  }
  return lines;
}

/**
 * Human render of a completed (non-dry-run) apply result. Never a credential
 * value.
 *
 * `unimplemented` is the plan's `unimplementedByApply` (macf#854) — the
 * caller threads it through from the SAME plan the operator approved, so
 * this final summary names the same gap the pre-approval render did. This is
 * the ONLY place that gap is visible under `--yes` (which skips the
 * pre-approval render entirely) — see the module doc + plan.ts's "Apply
 * coverage" section. Defaults to `[]` so existing callers/tests that don't
 * thread it through keep compiling and rendering byte-identically.
 */
export function formatApplyResult(result: FleetApplyResult, unimplemented: readonly UnimplementedApplyItem[] = []): string {
  const parts: string[] = ['Agent identities:', ...agentSummaryLines(result), ''];
  switch (result.vault.status) {
    case 'skipped':
      parts.push('Vault: skipped (no agent needed fresh credentials this run).');
      break;
    case 'written':
      parts.push(`Vault: written to ${result.vault.path}${result.vault.versioned ? ' (versioned — a prior vault existed)' : ''}.`);
      break;
    case 'failed':
      parts.push(`Vault: FAILED — ${result.vault.reason}`);
      break;
  }
  parts.push(`fleet.lock: ${result.lockPath}`);
  if (result.identityChanges.length > 0) {
    parts.push('', `⚠ identity DRIFT detected (${String(result.identityChanges.length)}) — confirm before trusting fleet.lock:`);
    for (const c of result.identityChanges) {
      parts.push(`  ${c.role}.${c.field}: ${c.previous} → ${c.next}`);
    }
  }
  if (unimplemented.length > 0) {
    parts.push(
      '',
      `⚠ apply did NOT action ${String(unimplemented.length)} planned item(s) below — these are NOT IMPLEMENTED ` +
        'yet, this is not "nothing to do" (macf#854):',
      ...formatUnimplementedLines(unimplemented),
    );
  }
  return parts.join('\n');
}

/**
 * Redact an {@link AgentApplyOutcome} for JSON rendering. The `created`
 * variant carries the raw `AppCredentials` (PEM / client secret / webhook
 * secret) so `apply-fleet.ts` can assemble the vault payload — that object
 * must NEVER reach a log line or a `--json` envelope. Every other variant
 * carries no credential field to begin with; this still copies them
 * explicitly (rather than spreading) so a FUTURE variant that adds one is a
 * compile error here, not a silent leak.
 */
function redactIdentity(identity: AgentApplyOutcome): unknown {
  switch (identity.status) {
    case 'created':
      return { role: identity.role, status: identity.status, appId: identity.appId, installId: identity.installId };
    case 'reused':
    case 'resumed-install':
      return { role: identity.role, status: identity.status, appId: identity.appId, installId: identity.installId };
    case 'skipped-unverified':
      return { role: identity.role, status: identity.status, appId: identity.appId, reason: identity.reason };
    case 'drift':
      return { role: identity.role, status: identity.status, reason: identity.reason, installs: identity.installs };
    case 'failed':
      return { role: identity.role, status: identity.status, reason: identity.reason };
  }
}

/**
 * Structured `--json` render. Never a credential value — only status/id/path/
 * reason fields (see {@link redactIdentity}). `unimplemented` is the plan's
 * `unimplementedByApply` (macf#854); defaults to `[]` so existing
 * callers/tests keep compiling — see {@link formatApplyResult}'s doc for why
 * the caller threads it through.
 */
export function fleetApplyResultToJson(result: FleetApplyResult, unimplemented: readonly UnimplementedApplyItem[] = []): unknown {
  return {
    schema_version: FLEET_APPLY_JSON_SCHEMA_VERSION,
    agents: result.agents.map((rec) => ({ role: rec.role, identity: redactIdentity(rec.identity), repo_init: rec.repoInit ?? null })),
    vault: result.vault,
    lock_path: result.lockPath,
    identity_changes: result.identityChanges.map((c) => ({ ...c })),
    unimplemented_by_apply: unimplemented.map((i) => ({ ...i })),
  };
}

/** Non-zero when ANY agent needs operator attention (failed/drift/skipped-unverified/repo-init-failed) or the vault write failed. */
export function applyExitCode(result: FleetApplyResult): number {
  const agentBad = result.agents.some(
    (rec) =>
      rec.identity.status === 'failed' ||
      rec.identity.status === 'drift' ||
      rec.identity.status === 'skipped-unverified' ||
      rec.repoInit?.status === 'failed',
  );
  return agentBad || result.vault.status === 'failed' ? 1 : 0;
}

// --- Entry point ---

/**
 * `macf bootstrap apply -f fleet.yaml [--dry-run] [--yes] [--json]`.
 *
 * Returns the shell exit code. NEVER exits the process directly; every
 * failure path renders through {@link renderFailure} or the apply-result
 * renderers above.
 */
export async function runBootstrapApply(
  opts: RunBootstrapApplyOptions,
  deps?: BootstrapApplyDeps,
  mutateDeps?: MutateApplyDeps,
): Promise<number> {
  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return renderFailure({ code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` }, opts);
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

  const resolved = deps ?? { observe: (m: FleetManifest) => githubRegistryObserver(m, manifestPath) };

  try {
    const observed = await resolved.observe(manifest);
    const plan = computePlan(manifest, observed);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

    if (opts.dryRun === true) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ...(fleetPlanToJson(plan) as Record<string, unknown>), dry_run: true, planned_app_creations: creations.map((c) => ({ ...c })) },
            null,
            2,
          ),
        );
      } else {
        console.log(formatPlanText(plan));
        console.log('');
        console.log(formatPlannedAppCreations(creations));
        console.log('');
        console.log('DRY RUN — nothing was created, changed, or submitted.');
      }
      return 0;
    }

    // Real apply — the DR-035 §4 plan-approve-once artifact: show the FULL
    // plan + blast radius BEFORE any consent gate opens. Always stderr (even
    // without --json) so stdout is reserved for the FINAL result — the same
    // "stdout is data, stderr is narration" split `--json` needs to stay
    // clean; keeping it uniform (not conditional on opts.json) means a human
    // running without --json sees the identical preview a script would have
    // to skip past on stderr, rather than two different code paths.
    process.stderr.write(`${formatPlanText(plan)}\n\n${formatPlannedAppCreations(creations)}\n`);

    const mutate = mutateDeps ?? resolveMutateDeps(manifestPath);
    const approved = opts.yes === true ? true : await mutate.confirmPlan(plan, creations);
    if (!approved) {
      console.error('Aborted by operator — nothing was created, changed, or submitted.');
      return 1;
    }

    const priorLock = mutate.readPriorLock(manifestPath);
    const result = await applyFleet(manifest, manifestPath, priorLock, mutate);

    if (opts.json) {
      console.log(JSON.stringify(fleetApplyResultToJson(result, plan.unimplementedByApply), null, 2));
    } else {
      console.log('');
      console.log(formatApplyResult(result, plan.unimplementedByApply));
    }
    return applyExitCode(result);
  } catch (err) {
    return renderFailure({ code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) }, opts);
  }
}
