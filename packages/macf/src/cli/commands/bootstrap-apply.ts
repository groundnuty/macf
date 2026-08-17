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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { join, resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { deriveAppHandle, parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlan, FleetPlanFailure, ObservedState, UnimplementedApplyItem } from '../bootstrap/plan.js';
import {
  checkVaultFlagsComplete,
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
import { appInstallationUrl, confirmAppInstallation as realConfirmAppInstallation } from '../bootstrap/identity-confirm.js';
import type { ExpectedIdentity, IdentityConfirmation } from '../bootstrap/identity-confirm.js';
import { confirmBeforeCreateGuard, realAgentApplyDeps } from '../bootstrap/apply-agent.js';
import type { AgentApplyOutcome, CreateGuardDecision, CreateGuardDeps } from '../bootstrap/apply-agent.js';
import { realCloneRepo, realCommitAndPush } from '../bootstrap/apply-repo-init.js';
import type { AgentRepoDeps, RepoInitStepDeps } from '../bootstrap/apply-repo-init.js';
import { applyFleet } from '../bootstrap/apply-fleet.js';
import type { ControlRepoSyncOutcome, FleetApplyDeps, FleetApplyResult } from '../bootstrap/apply-fleet.js';
import type { ControlRepoDeps } from '../bootstrap/control-repo.js';
import { checkControlRepoMeta, realControlRepoCommitAndPush, realReadControlManifestFile } from '../bootstrap/control-repo.js';
import { realUnarchiveRepo } from '../bootstrap/repo-archive.js';
import {
  checkRepoExists,
  checkRepoSecretPresence,
  checkRepoVariablePresence,
  checkRegistryVariablePresence,
  checkRunnerUsableByRepo,
  readRegistryVariable,
} from '../bootstrap/observer.js';
import { realCreateRepo } from '../bootstrap/repo-create.js';
import type { CaApplyDeps } from '../bootstrap/apply-ca.js';
import { realCreateRegistryVariable, realCreateRepoVariable, realMintCa } from '../bootstrap/apply-ca.js';
import type { EnsureVariableOutcome } from '../bootstrap/ensure-variable.js';
import type { RoutingClientApplyDeps } from '../bootstrap/apply-routing-client.js';
import { realMintRoutingClient, realSetRepoSecret } from '../bootstrap/apply-routing-client.js';
import type { RunnerRegistrationDeps } from '../bootstrap/apply-routing.js';
import { checkRunnerTokenPreflight, RUNNER_TOKEN_ENV_VAR } from '../bootstrap/apply-routing.js';
import { readVault, vaultAgentPrivateKeyPem } from '../bootstrap/vault-read.js';
import type { VaultReadOptions } from '../bootstrap/vault-read.js';
import type { LabelsOutcome } from './repo-init.js';

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
  /**
   * Vault-aware confirm-before-create (DR-043 Amendment A, macf#913) —
   * mirrors `bootstrap plan`'s own `--vault`/`--identity-key` pair
   * (`commands/bootstrap.ts`, `plan.ts::checkVaultFlagsComplete`). When BOTH
   * are given, `apply` decrypts the vault in memory, recovers each agent's
   * PEM, and confirms a role WITH a prior `fleet.lock` entry live against
   * GitHub BEFORE deciding whether to open consent gate 1 — a confirmed App
   * is reused, gate 1 is never opened (`resolveMutateDeps`'s `resolveKeyPath`
   * wiring, consumed by `apply-agent.ts::confirmBeforeCreateGuard`).
   * Omitting either (the default, unchanged behaviour) keeps `apply` exactly
   * as it was before this flag existed. Half-given is refused loud.
   */
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
  /**
   * `--runner-token` (macf#929) — the CLI-flag form of the register-before-
   * route POLICY gate `apply-routing.ts::publishTrustedActorsGated` enforces.
   * `undefined` here does NOT necessarily mean "no token": `runBootstrapApply`
   * falls back to the {@link RUNNER_TOKEN_ENV_VAR} env var when this is unset
   * (CLI flag wins on conflict) — see the resolution right after the
   * manifest is parsed, shared by BOTH the macf#932 pre-flight refusal
   * (before consent gate 1) AND `resolveMutateDeps`. NEVER logged, NEVER
   * copied onto any rendered result (mirrors `FleetApplyDeps.runnerToken`'s
   * own doc).
   */
  readonly runnerToken?: string;
}

export interface BootstrapApplyDeps {
  readonly observe: FleetObserverFn;
  /**
   * Injectable seam for tests (macf#913) — real default is
   * `vault-read.ts::readVault`. Never invoked unless BOTH `opts.vaultPath`
   * and `opts.identityKeyPath` were given (see `checkVaultFlagsComplete`).
   */
  readonly readVault?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  /**
   * Injectable seam for tests (macf#913) — real default is
   * `identity-confirm.ts::confirmAppInstallation`. Used ONLY by the
   * `--dry-run` / pre-approval vault-aware PREVIEW (a read-only GET,
   * consistent with `--dry-run`'s "mutates nothing" contract); the real
   * mutating path gets its OWN copy via `resolveMutateDeps`'s
   * `buildAgentDeps` — this seam never influences what apply actually does.
   */
  readonly confirmAppInstallation?: (appId: string, keyPath: string, expected?: ExpectedIdentity) => Promise<IdentityConfirmation>;
}

/** Extends `apply-fleet.ts`'s `FleetApplyDeps` with the three apply-CLI-level seams: the plan-approval prompt, the prior-lock read, and vault-scratch cleanup. */
export interface MutateApplyDeps extends FleetApplyDeps {
  readonly confirmPlan: (plan: FleetPlan, creations: readonly PlannedAppCreation[]) => Promise<boolean>;
  readonly readPriorLock: (manifestPath: string) => ReturnType<typeof readFleetLock>;
  /**
   * Cleanup for any vault-derived scratch PEM file(s) `resolveMutateDeps`'s
   * `resolveKeyPath` closure wrote this run (macf#913) — see that function's
   * doc. `undefined`/omitted is a no-op (vault-aware confirm wasn't
   * configured this run, or a test's fake deps don't need one).
   * `runBootstrapApply` ALWAYS invokes it in a `finally`, so a scratch PEM
   * never outlives the run regardless of how `applyFleet` exits.
   */
  readonly cleanupVaultScratch?: () => void;
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

// --- Vault-aware identity confirm — DR-043 Amendment A (macf#913) ---
//
// The false-promise this closes: through DR-043 Amendment D phase 3, ONLY
// `plan` had `--vault`/`--identity-key` — `apply` had no such flags at all,
// so `plan`'s own "a vault-aware confirm runs during apply" text
// (`plan.ts::UNKNOWN_REASONS.identity`, fixed alongside this change) was
// simply false. Consequence for a fleet whose App already exists but is
// unconfirmable (the state after `macf fleet archive` + revival — DR-043
// Amendment G): apply had no way to reuse it, so a role WITH a prior
// `fleet.lock` entry fell all the way to `skip-unverified`
// (`apply-agent.ts::confirmBeforeCreateGuard`'s existing, ALREADY-BUILT
// `resolveKeyPath` seam — its own doc names this exact gap: "A future
// increment wires this to the age-decrypted vault"). This section IS that
// increment.

/**
 * Decrypt `opts.vaultPath`/`opts.identityKeyPath` (when BOTH given) into a
 * per-ROLE PEM map — the shared vault-aware-confirm precondition for BOTH
 * `--dry-run`'s preview and the real mutating path's confirm-before-create
 * guard. `undefined` means "vault-aware confirm is NOT engaged this run" —
 * either because the flags weren't given (the vault-free default, unchanged
 * behaviour) OR because the decrypt failed.
 *
 * **Amendment A's honest-unknown floor applies to the failure case too:** a
 * failed decrypt must never be read as "no App exists" nor fabricate a false
 * "confirmed" — it degrades to EXACTLY the pre-macf#913 behaviour
 * (fleet.lock-driven skip-unverified/create), the same floor
 * `vaultAwareObserver` already establishes for `plan`. The causing error is
 * logged via `log` (never `console.error`/`console.log` directly — this
 * function has no opinion on whether the caller is mid-`--json` render) so
 * the operator sees WHY vault-aware confirm didn't engage rather than
 * silence; every `VaultError` message from `vault-read.ts` is pre-scrubbed
 * of secret material at the source (see that module's doc), so logging it
 * verbatim is safe — never a PEM, client secret, or webhook secret.
 */
async function resolveVaultAgentPems(
  manifest: FleetManifest,
  vaultOpts: Pick<RunBootstrapApplyOptions, 'vaultPath' | 'identityKeyPath'>,
  doReadVault: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, string> | undefined> {
  if (vaultOpts.vaultPath === undefined || vaultOpts.identityKeyPath === undefined) return undefined;

  let raw: Readonly<Record<string, string>>;
  try {
    raw = await doReadVault({ vaultPath: vaultOpts.vaultPath, identityPath: vaultOpts.identityKeyPath });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `Vault-aware confirm UNAVAILABLE this run — ${reason} — falling back to the vault-free confirm-before-create ` +
        'guard (DR-043 Amendment A: this is NOT evidence any App is absent, only that the vault could not be read).',
    );
    return undefined;
  }

  const pems = new Map<string, string>();
  for (const agent of manifest.agents) {
    const pem = vaultAgentPrivateKeyPem(raw, manifest.metadata.name, agent.role);
    if (pem !== undefined) pems.set(agent.role, pem);
  }
  return pems;
}

/**
 * Preview what `confirmBeforeCreateGuard` would decide for every agent —
 * NEVER mutates (`confirmAppInstallation` is a read-only `GET`, consistent
 * with `--dry-run`'s "mutates nothing" contract). Consulted by BOTH
 * `--dry-run` (requirement: "surface which path it would take, before
 * spending a click," macf#913) and the real mutating path's pre-approval
 * render, so an operator never sees "N Apps would be created" when some
 * would actually be silently reused.
 *
 * **This is a best-effort EXPLANATION, not the source of truth for what
 * apply will do.** `prior` here comes from `observed.lock` — whatever
 * `fleet.lock` this run's OBSERVER could see (the SAME source `plan.ts`'s
 * own `app`/`install` items already read; for the default
 * `githubRegistryObserver` that's the OPERATOR's LOCAL manifest directory,
 * per that module's doc). The REAL apply-time decision is made
 * independently inside `applyFleet` (via `resolveMutateDeps`'s
 * `resolveKeyPath` wiring), using `fleet.lock` freshly re-read from the
 * control-repo's OWN clone — which can see MORE than this preview when the
 * operator's local directory has no copy (e.g. an archived-then-revived
 * fleet whose lock lives only in `<fleet>-control`, never locally cloned;
 * see `apply-fleet.ts`'s own "self-heal" comment). A stale/absent preview
 * therefore never blocks or misdirects the real run — worst case it
 * under-reports a reuse the real run still gets right.
 */
async function previewIdentityDecisions(
  manifest: FleetManifest,
  observed: ObservedState,
  vaultAgentPems: ReadonlyMap<string, string>,
  confirmAppInstallation: CreateGuardDeps['confirmAppInstallation'],
): Promise<ReadonlyMap<string, CreateGuardDecision>> {
  const scratchDirs: string[] = [];
  const resolveKeyPath = (role: string): string | undefined => {
    const pem = vaultAgentPems.get(role);
    if (pem === undefined) return undefined;
    const dir = mkdtempSync(join(tmpdir(), `macf-bootstrap-vault-preview-${role}-`));
    scratchDirs.push(dir);
    const path = join(dir, 'key.pem');
    writeFileSync(path, pem, { mode: 0o600 });
    return path;
  };

  const out = new Map<string, CreateGuardDecision>();
  try {
    for (const agent of manifest.agents) {
      const prior = observed.lock?.agents.find((a) => a.role === agent.role);
      const expected: ExpectedIdentity = {
        appSlug: deriveAppHandle(manifest.metadata.name, agent.role),
        accountLogin: manifest.owner.account,
      };
      const decision = await confirmBeforeCreateGuard(agent.role, prior, expected, { confirmAppInstallation, resolveKeyPath });
      out.set(agent.role, decision);
    }
  } finally {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort — never let scratch-file cleanup mask the preview result */
      }
    }
  }
  return out;
}

/** Drop a planned creation whose vault-aware preview says it would NOT actually be created — reused, resumable, drifted, or refused-unverified all mean "gate 1 will not open for this role." Pure. */
function filterCreationsByPreview(
  creations: readonly PlannedAppCreation[],
  preview: ReadonlyMap<string, CreateGuardDecision>,
): readonly PlannedAppCreation[] {
  return creations.filter((c) => (preview.get(c.role)?.action ?? 'create') === 'create');
}

/** One `<role>: <PATH>` line for {@link formatIdentityPreview} — never a credential value (`CreateGuardDecision` carries none). */
function formatIdentityDecisionLine(role: string, decision: CreateGuardDecision): string {
  switch (decision.action) {
    case 'create':
      return `  • ${role}: CREATE — no confirmed prior App; consent gate 1 WILL open.`;
    case 'reuse-confirmed':
      return (
        `  • ${role}: REUSE — confirmed live (app_id ${decision.install.appId}, install_id ` +
        `${decision.install.installId}); consent gate 1 will be SKIPPED.`
      );
    case 'resume-install':
      return `  • ${role}: RESUME INSTALL — app_id ${decision.appId} exists with zero installs; gate 1 will be SKIPPED, gate 2 (install) will run.`;
    case 'skip-unverified':
      return `  • ${role}: SKIP (unverified) — ${decision.reason}`;
    case 'drift':
      return `  • ${role}: DRIFT — ${decision.reason}`;
  }
}

/** Human render of the vault-aware confirm-before-create preview (macf#913) — never a credential value. */
export function formatIdentityPreview(decisions: ReadonlyMap<string, CreateGuardDecision>): string {
  return [
    'Vault-aware identity confirm (DR-043 Amendment A) — which path each agent would take:',
    ...[...decisions.entries()].map(([role, decision]) => formatIdentityDecisionLine(role, decision)),
  ].join('\n');
}

/** `--json` render of the preview — never a credential value (every `CreateGuardDecision` variant carries only role/status/appId/installId/reason/installs, verified against `apply-agent.ts`'s own union). */
function identityPreviewToJson(decisions: ReadonlyMap<string, CreateGuardDecision>): unknown {
  return Object.fromEntries([...decisions.entries()].map(([role, decision]) => [role, { ...decision }]));
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

/**
 * DR-043 Amendment F (macf#857) — the real `<fleet>-control` provisioning
 * primitives. `commitAndPush` is deliberately `realControlRepoCommitAndPush`
 * (the explicit-allowlist commit), NOT the `-A` `realCommitAndPush` used
 * below for agent-repo `repoInitDeps` — see `control-repo.ts`'s
 * "git-committed content invariant" doc section (#857 review) for why the
 * two checkouts need different commit primitives.
 */
const REAL_CONTROL_REPO_DEPS: ControlRepoDeps = {
  checkMeta: checkControlRepoMeta,
  readManifestFile: realReadControlManifestFile,
  createRepo: realCreateRepo,
  unarchiveRepo: realUnarchiveRepo,
  cloneRepo: realCloneRepo,
  commitAndPush: realControlRepoCommitAndPush,
};

/** macf#857 — the real agent-repo-ensure primitives (`checkRepoExists` is the SAME read `observer.ts`'s plan-time repo-presence check uses; `createRepo` is the SAME primitive the control repo uses, with a template). */
const REAL_AGENT_REPO_DEPS: AgentRepoDeps = {
  checkExists: checkRepoExists,
  createRepo: realCreateRepo,
};

/**
 * DR-043 Amendment D phase 2 (macf#838, macf#854's CA/routing gap) — the
 * real CA-ceremony + two-place-publish + routing-var deps. Every
 * presence-check function here is the SAME one `observer.ts`'s plan-time
 * reads already use (`checkRegistryVariablePresence` / `readRegistryVariable`
 * / `checkRepoVariablePresence` / `checkRunnerUsableByRepo`) — plan and apply
 * agree on what "present"/"registered-and-usable" means at the exact same
 * call sites, by construction, not by convention. `checkRunnerUsableByRepo`
 * (macf#922, org-scope-corrected by macf#924) is the register-before-route
 * gate `apply-routing.ts::publishTrustedActors` checks per-repo before every
 * write.
 */
const REAL_TRUST_DEPS: CaApplyDeps & RunnerRegistrationDeps = {
  checkRegistryPresence: checkRegistryVariablePresence,
  readRegistryVariable,
  createRegistryVariable: realCreateRegistryVariable,
  checkRepoPresence: checkRepoVariablePresence,
  createRepoVariable: realCreateRepoVariable,
  mintCa: realMintCa,
  checkRunnerUsableByRepo,
};

/**
 * DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) — the real
 * mint-or-skip + create-only per-repo secret-deploy deps. `checkRepoSecretPresence`
 * is the SAME read `plan`'s (future) routing-client observation would use
 * (`observer.ts`, matching `REAL_TRUST_DEPS`'s own "plan and apply agree by
 * construction" discipline); `setRepoSecret`/`mint` are the real `gh secret
 * set`-via-stdin + `certs.ts::mintRoutingClientCert` primitives.
 */
const REAL_ROUTING_CLIENT_DEPS: RoutingClientApplyDeps = {
  checkRepoSecretPresence,
  setRepoSecret: realSetRepoSecret,
  mint: realMintRoutingClient,
};

/**
 * Build the REAL (production) mutating deps. Exported ONLY so a test can assert
 * the wiring by identity (macf#857 review): a security primitive can be
 * defined, unit-tested, and never actually called — which is exactly what
 * happened here (commit `2bbc4c3` added the explicit-allowlist commit but left
 * this function wiring the control repo to the `-A` primitive, so the fix was
 * inert in production while its own unit tests passed green). Unit-testing a
 * primitive against itself cannot see that; only asserting through THIS seam
 * can. Pure — it builds a plain object and performs no I/O until a field is
 * invoked — so a test may call it directly.
 */
export function resolveMutateDeps(
  manifestPath: string,
  vaultAgentPems?: ReadonlyMap<string, string>,
  // macf#929 — resolved CLI-flag/env-var token (see `runBootstrapApply`'s
  // resolution right before this is called); threaded verbatim onto
  // `FleetApplyDeps.runnerToken`, never read anywhere else in this function.
  runnerToken?: string,
): MutateApplyDeps {
  const repoInitDeps: RepoInitStepDeps = { cloneRepo: realCloneRepo, commitAndPush: realCommitAndPush };

  // macf#913 — the vault-aware confirm-before-create guard's key resolver.
  // ONE scratch dir for the WHOLE run (not one per role), created lazily on
  // first use so a vault-free run (the common case) never touches the
  // filesystem for this. `undefined` — the field omitted entirely, not set
  // to `undefined` — when no vault map was supplied: `confirmBeforeCreateGuard`
  // then takes EXACTLY its pre-macf#913 path (skip-unverified for a role with
  // a prior lock entry, unconditional create otherwise). `cleanupVaultScratch`
  // below is `runBootstrapApply`'s obligation to call once the run is fully
  // done — see `MutateApplyDeps.cleanupVaultScratch`'s doc.
  let vaultScratchDir: string | undefined;
  const resolveKeyPath =
    vaultAgentPems !== undefined
      ? (role: string): string | undefined => {
          const pem = vaultAgentPems.get(role);
          if (pem === undefined) return undefined;
          vaultScratchDir ??= mkdtempSync(join(tmpdir(), 'macf-bootstrap-vault-confirm-'));
          const path = join(vaultScratchDir, `${role}.pem`);
          writeFileSync(path, pem, { mode: 0o600 });
          return path;
        }
      : undefined;

  return {
    // `writeRecoveryArtifact` is deliberately absent here — `apply-fleet.ts`
    // splices it in (it owns the fleet-level context that seam needs; see
    // its module doc's "Recovery-artifact lifecycle" section).
    buildAgentDeps: (log: (line: string) => void) => ({
      ...realAgentApplyDeps(realOpenUrl, log),
      ...(resolveKeyPath !== undefined ? { resolveKeyPath } : {}),
    }),
    repoInitDeps,
    vaultDeps: {},
    controlRepoDeps: REAL_CONTROL_REPO_DEPS,
    // DR-043 Amendment G — reaching `applyFleet` at all means the operator
    // already gave the ONE plan-approve-once "yes" this run needed (see
    // `runBootstrapApply` below); if that plan showed a control-repo-
    // archived item (`plan.ts`'s new `control_repo` kind), THIS is the
    // approval that authorizes `provisionControlRepo` to un-archive it.
    // `false`/absent is the only unsafe alternative here — never invert
    // this to a conditional without also re-deriving it from the actual
    // approved plan.
    controlRepoOptions: { confirmUnarchive: true },
    agentRepoDeps: REAL_AGENT_REPO_DEPS,
    trustDeps: REAL_TRUST_DEPS,
    routingClientDeps: REAL_ROUTING_CLIENT_DEPS,
    now: () => new Date(),
    log: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
    allowVaultVersion: process.env['MACF_BOOTSTRAP_VAULT_VERSION'] === '1',
    // macf#929 — POLICY only (see apply-routing.ts::publishTrustedActorsGated's
    // doc); `runnerTokenPollOptions` is deliberately left unset here, taking
    // that function's real 10min/3s deploy-window defaults.
    runnerToken,
    confirmPlan: realConfirmPlan,
    // DR-043 Amendment F residual (macf#857): this still reads from the
    // OPERATOR's local manifest directory, not the (not-yet-cloned, at this
    // point in the flow) control-repo checkout. `applyFleet`'s own
    // checkout-lock self-heal (see its module doc) makes this harmless on a
    // REUSE run — the checkout's own `fleet.lock`, once cloned, wins over
    // whatever this returns. Fully closing the gap (reading `fleet.lock`
    // from the control repo BEFORE this function even runs) needs
    // `provisionControlRepo` to run ahead of this call, which is a bigger
    // reshuffle than this increment's scope — left for a later phase.
    readPriorLock: () => readFleetLock(manifestPath),
    cleanupVaultScratch: () => {
      if (vaultScratchDir !== undefined) {
        try {
          rmSync(vaultScratchDir, { recursive: true, force: true });
        } catch {
          /* best-effort — never let scratch-file cleanup mask the apply result */
        }
      }
    },
  };
}

// --- Apply-result rendering (never a credential value) ---

export const FLEET_APPLY_JSON_SCHEMA_VERSION = 1;

/**
 * The control-repo status line — ALWAYS rendered first (macf#857), so a
 * `foreign`/`failed` step-0 abort is visible in the SAME place a normal run's
 * "Agent identities:" summary would be, not just as a bare non-zero exit
 * code. This matters most under `--yes`, which skips the pre-approval render
 * entirely — this final-result render is the ONLY output a script sees, so
 * an abort that's only distinguishable by exit code (same shape #854/#861
 * already closed for `unimplementedByApply`) would be a regression.
 */
function formatControlRepoLine(result: FleetApplyResult): string {
  const cr = result.controlRepo;
  switch (cr.status) {
    case 'created':
      return `CREATED "${cr.repo}" (checkout: ${cr.localDir})`;
    case 'reused':
      return `REUSED "${cr.repo}" (checkout: ${cr.localDir})`;
    case 'revived':
      return `REVIVED "${cr.repo}" (was archived — DR-043 Amendment G; checkout: ${cr.localDir})`;
    case 'foreign':
      return `⚠ ABORTED — "${cr.repo}" exists but is not this fleet's control repo: ${cr.reason}`;
    case 'archived':
      return `⚠ ABORTED — "${cr.repo}" is archived and revival was not confirmed: ${cr.reason}`;
    case 'failed':
      return `⚠ ABORTED — could not provision "${cr.repo}": ${cr.reason}`;
  }
}

/** The final control-repo sync line (macf#857) — see `ControlRepoSyncOutcome`'s doc. */
function formatControlRepoSyncLine(sync: ControlRepoSyncOutcome): string {
  switch (sync.status) {
    case 'skipped':
      return 'skipped (control repo was not provisioned this run — see the Control repo line above).';
    case 'pushed':
      return 'pushed.';
    case 'nothing-to-commit':
      return 'nothing to push (no fleet.lock/vault.age change this run).';
    case 'failed':
      return `⚠ FAILED — ${sync.reason} (fleet.lock/vault.age changes exist only in the local checkout; re-run apply to retry the push).`;
  }
}

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
          ? `    repo-init: applied to ${rec.repoInit.repo} (pushed: ${String(rec.repoInit.pushed)}) — ${formatLabelsLine(rec.repoInit.labels)}`
          : `    repo-init: FAILED on ${rec.repoInit.repo} — ${rec.repoInit.reason}`,
      );
    }
  }
  return lines;
}

/**
 * One clause describing the label-creation outcome (groundnuty/macf#920) —
 * appended to `agentSummaryLines`'s `repo-init: applied` line so a
 * `reused`/`resumed-install` role's SKIPPED labels (the pre-existing,
 * acknowledged gap `applyRepoInitForAgent`'s doc names — no credentials
 * threaded for that path yet) never renders as bare, unqualified silence
 * even though the step's overall `status` is still `'applied'` (this repo's
 * own "never let a gap render as silence" discipline, `plan.ts`'s
 * `unimplementedByApply` applied at the render layer here).
 */
function formatLabelsLine(labels: LabelsOutcome): string {
  switch (labels.status) {
    case 'ok':
      return `labels: ok (${String(labels.created.length)} created, ${String(labels.existed.length)} already present)`;
    case 'partial-failure':
      return `labels: FAILED for ${labels.failed.join(', ')}`;
    case 'skipped':
      return `labels: skipped — ${labels.reason}`;
  }
}

/** One `<label>: <status>` line, appending `— <reason>` for `failed`/`skipped` — the shared render shape for `EnsureVariableOutcome` (macf#838 Amendment D phase 2). NEVER a value — the type carries none. */
function formatVariableLegLine(label: string, leg: EnsureVariableOutcome): string {
  const suffix = leg.status === 'failed' || leg.status === 'skipped' ? ` — ${leg.reason}` : '.';
  return `  ${label}: ${leg.status.toUpperCase()}${suffix}`;
}

/** CA ceremony + two-place publish render (macf#838 Amendment D phase 2). Never a credential value — `result.ca.resolve` is the redacted `CaApplyOutcome` (fingerprint only, never cert/key PEM). */
function caSummaryLines(result: FleetApplyResult): string[] {
  const r = result.ca.resolve;
  const resolveLine =
    r.status === 'failed'
      ? `CA: FAILED to resolve — ${r.reason}`
      : `CA: ${r.status.toUpperCase()}${r.certFingerprint !== undefined ? ` (fingerprint ${r.certFingerprint})` : ''}`;
  const lines = [resolveLine, formatVariableLegLine('registry leg', result.ca.registryLeg)];
  for (const [repo, leg] of Object.entries(result.ca.repoLegs)) {
    lines.push(formatVariableLegLine(`repo leg (${repo})`, leg));
  }
  return lines;
}

/** `MACF_TRUSTED_ACTORS` per-repo render (macf#838 Amendment D phase 2; corrected target macf#922). Empty when `routing.runner` wasn't declared, or its `runs_on` isn't `"self-hosted"`. A `'skipped'` leg (rendered via `formatVariableLegLine`'s reason suffix) means the register-before-route gate blocked the write — visible here even under `--yes`, which skips the pre-approval plan render entirely. */
function routingSummaryLines(result: FleetApplyResult): string[] {
  const entries = Object.entries(result.routing);
  if (entries.length === 0) return [];
  const lines = ['Routing (MACF_TRUSTED_ACTORS):'];
  for (const [repo, leg] of entries) lines.push(formatVariableLegLine(repo, leg));
  return lines;
}

/** Routing-client mint + per-repo secret-deploy render (groundnuty/macf#920 gap 2). Never a credential value — `result.routingClient.mint` is the redacted `RedactedRoutingClientMint` (status/reason only, never cert/key PEM). */
function routingClientSummaryLines(result: FleetApplyResult): string[] {
  const m = result.routingClient.mint;
  const lines = [m.status === 'minted' ? 'Routing-client cert: MINTED (CN=routing-action).' : `Routing-client cert: SKIPPED — ${m.reason}`];
  for (const [repo, leg] of Object.entries(result.routingClient.certLegs)) {
    lines.push(formatVariableLegLine(`cert leg (${repo})`, leg));
  }
  for (const [repo, leg] of Object.entries(result.routingClient.keyLegs)) {
    lines.push(formatVariableLegLine(`key leg (${repo})`, leg));
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
  const parts: string[] = [`Control repo: ${formatControlRepoLine(result)}`, '', 'Agent identities:', ...agentSummaryLines(result), ''];
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
  parts.push(`Control repo sync: ${formatControlRepoSyncLine(result.controlRepoSync)}`);
  parts.push('', ...caSummaryLines(result));
  const routingLines = routingSummaryLines(result);
  if (routingLines.length > 0) parts.push('', ...routingLines);
  parts.push('', ...routingClientSummaryLines(result));
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
    control_repo: result.controlRepo,
    control_repo_sync: result.controlRepoSync,
    agents: result.agents.map((rec) => ({ role: rec.role, identity: redactIdentity(rec.identity), repo_init: rec.repoInit ?? null })),
    vault: result.vault,
    lock_path: result.lockPath,
    identity_changes: result.identityChanges.map((c) => ({ ...c })),
    unimplemented_by_apply: unimplemented.map((i) => ({ ...i })),
    // `result.ca.resolve` is ALREADY the redacted `CaApplyOutcome`
    // (fingerprint only — see `apply-ca.ts::redactCaResolve`); `registryLeg`/
    // `repoLegs`/`routing` are `EnsureVariableOutcome`s, which carry no
    // credential field at all. Safe to spread verbatim (macf#838 Amendment D
    // phase 2).
    ca: { resolve: { ...result.ca.resolve }, registry_leg: { ...result.ca.registryLeg }, repo_legs: { ...result.ca.repoLegs } },
    routing: { ...result.routing },
    // `result.routingClient.mint` is ALREADY the redacted `RedactedRoutingClientMint`
    // (status/reason only — see `apply-fleet.ts::redactRoutingClientMint`);
    // `certLegs`/`keyLegs` are `EnsureVariableOutcome`s, which carry no
    // credential field. Safe to spread verbatim (groundnuty/macf#920 gap 2).
    routing_client: {
      mint: { ...result.routingClient.mint },
      cert_legs: { ...result.routingClient.certLegs },
      key_legs: { ...result.routingClient.keyLegs },
    },
  };
}

/**
 * Non-zero when: the control repo could not be provisioned this run
 * (`foreign`/`failed`/`archived` — DR-043 Amendment G added `archived`
 * alongside macf#857's `foreign`/`failed`; the entire run aborted in all
 * three cases), OR the final control-repo sync failed (durable-locally-but-
 * not-pushed is still an operator-attention state), OR ANY agent needs
 * operator attention (failed/drift/skipped-unverified/repo-init-failed), OR
 * the vault write failed.
 */
export function applyExitCode(result: FleetApplyResult): number {
  const controlRepoBad =
    result.controlRepo.status === 'foreign' || result.controlRepo.status === 'failed' || result.controlRepo.status === 'archived';
  const controlRepoSyncBad = result.controlRepoSync.status === 'failed';
  const agentBad = result.agents.some(
    (rec) =>
      rec.identity.status === 'failed' ||
      rec.identity.status === 'drift' ||
      rec.identity.status === 'skipped-unverified' ||
      rec.repoInit?.status === 'failed',
  );
  // DR-043 Amendment D phase 2 (macf#838) — a CA resolve failure or ANY
  // publish-leg failure needs operator attention, same bar as an agent
  // failure. A 'skipped' leg does NOT independently fail the run here — it
  // is always a SYMPTOM of an already-`ca.resolve.status === 'failed'` or
  // `vault.status === 'failed'` state, both already covered below.
  const caBad =
    result.ca.resolve.status === 'failed' ||
    result.ca.registryLeg.status === 'failed' ||
    Object.values(result.ca.repoLegs).some((leg) => leg.status === 'failed');
  const routingBad = Object.values(result.routing).some((leg) => leg.status === 'failed');
  // DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) — same
  // 'skipped' vs 'failed' distinction as `caBad` above: a `'skipped'` mint is
  // the EXPECTED steady state on an ordinary re-run of an already-provisioned
  // fleet (CA reused, or the routing-client key already vaulted from a prior
  // run) — only an actual publish-leg `'failed'` needs operator attention.
  const routingClientBad =
    Object.values(result.routingClient.certLegs).some((leg) => leg.status === 'failed') ||
    Object.values(result.routingClient.keyLegs).some((leg) => leg.status === 'failed');
  return controlRepoBad || controlRepoSyncBad || agentBad || result.vault.status === 'failed' || caBad || routingBad || routingClientBad ? 1 : 0;
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
  // macf#913 — mirrors `bootstrap plan`'s own XOR refusal
  // (`plan.ts::checkVaultFlagsComplete`'s doc); fires BEFORE the
  // manifest-file check, same ordering `plan` uses (an argument error, not a
  // manifest error).
  const vaultFlagsFailure = checkVaultFlagsComplete(opts.vaultPath, opts.identityKeyPath);
  if (vaultFlagsFailure !== undefined) {
    return renderFailure(vaultFlagsFailure, opts);
  }

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

  // macf#929 — CLI flag wins on conflict; MACF_BOOTSTRAP_RUNNER_TOKEN is the
  // fallback (same "flag, then env" precedence `--min-agents`/
  // MACF_PROPOSE_MIN_AGENTS already establishes in index.ts). Resolved HERE
  // (moved up from immediately before `resolveMutateDeps` — macf#932) so
  // BOTH the pre-flight refusal below AND the real mutating wiring further
  // down read the exact same resolved value; there is exactly one place this
  // precedence is computed.
  const resolvedRunnerToken = opts.runnerToken ?? process.env[RUNNER_TOKEN_ENV_VAR];

  // macf#932 — refuse BEFORE consent gate 1 ever opens, not merely before
  // the LATE gate deep inside `applyFleet`'s routing block
  // (`apply-routing.ts::publishTrustedActorsGated`, UNCHANGED, still the
  // actual enforcement point — see `checkRunnerTokenPreflight`'s doc for the
  // full "why move this earlier" rationale + why the late gate stays
  // authoritative). Fires immediately after the manifest is parsed, before
  // ANY observe/plan-render/consent-gate work — an operator who forgot the
  // flag never spends a browser click and never even costs a read-only `gh`
  // call. Skipped for `--dry-run`: a dry run never opens a gate to begin
  // with, and its own plan render already carries the SAME requirement note
  // unconditionally (`plan.ts::runnerClassReason`'s `RUNNER_TOKEN_PLAN_NOTE`,
  // macf#932 requirement 3) — nothing is hidden from a `--dry-run` operator
  // either.
  if (opts.dryRun !== true) {
    const runnerTokenFailure = checkRunnerTokenPreflight(manifest.routing, resolvedRunnerToken);
    if (runnerTokenFailure !== undefined) {
      return renderFailure(runnerTokenFailure, opts);
    }
  }

  const resolved = deps ?? { observe: (m: FleetManifest) => githubRegistryObserver(m, manifestPath) };
  const stderrLog = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  try {
    const observed = await resolved.observe(manifest);
    const plan = computePlan(manifest, observed);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

    // macf#913 — decrypted ONCE (when both flags given), shared by BOTH the
    // `--dry-run` preview below and the real mutating path's
    // confirm-before-create guard (`resolveMutateDeps`). See
    // `resolveVaultAgentPems`'s doc for the honest-unknown degrade-on-failure
    // contract.
    const vaultAgentPems = await resolveVaultAgentPems(manifest, opts, deps?.readVault ?? readVault, stderrLog);
    const preview =
      vaultAgentPems !== undefined
        ? await previewIdentityDecisions(manifest, observed, vaultAgentPems, deps?.confirmAppInstallation ?? realConfirmAppInstallation)
        : undefined;
    // requirement 4 (macf#913): an operator must learn which path apply
    // would ACTUALLY take before spending a browser click — a role the
    // preview confirms live is dropped from "would be created" in BOTH the
    // `--dry-run` render below AND the real path's pre-approval render.
    const displayCreations = preview !== undefined ? filterCreationsByPreview(creations, preview) : creations;

    if (opts.dryRun === true) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...(fleetPlanToJson(plan) as Record<string, unknown>),
              dry_run: true,
              planned_app_creations: displayCreations.map((c) => ({ ...c })),
              ...(preview !== undefined ? { vault_identity_preview: identityPreviewToJson(preview) } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(formatPlanText(plan));
        console.log('');
        console.log(formatPlannedAppCreations(displayCreations));
        if (preview !== undefined) {
          console.log('');
          console.log(formatIdentityPreview(preview));
        }
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
    process.stderr.write(`${formatPlanText(plan)}\n\n${formatPlannedAppCreations(displayCreations)}\n`);
    if (preview !== undefined) {
      process.stderr.write(`\n${formatIdentityPreview(preview)}\n`);
    }

    // macf#929/#932 — `resolvedRunnerToken` was already computed above (right
    // after manifest parsing, shared with the pre-flight refusal); reused
    // verbatim here, not inside `resolveMutateDeps`, so that function stays a
    // pure plain-object builder — no `process.env` read hidden inside it for
    // this field (unlike the pre-existing `allowVaultVersion` line above it,
    // which this does NOT imitate).
    const mutate = mutateDeps ?? resolveMutateDeps(manifestPath, vaultAgentPems, resolvedRunnerToken);
    try {
      const approved = opts.yes === true ? true : await mutate.confirmPlan(plan, displayCreations);
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
    } finally {
      // macf#913 — a vault-derived scratch PEM must never outlive this run,
      // regardless of how it ends (declined, applyFleet threw, or a clean
      // return above). No-op when vault-aware confirm wasn't configured, or
      // resolveKeyPath was never actually invoked this run.
      mutate.cleanupVaultScratch?.();
    }
  } catch (err) {
    return renderFailure({ code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) }, opts);
  }
}
