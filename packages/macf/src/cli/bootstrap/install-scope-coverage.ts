/**
 * Installation-SCOPE-MEMBERSHIP drift — does a fleet-level App's `selected`
 * install actually COVER every repo the manifest currently declares
 * (groundnuty/macf#1220)? **Distinct from `install-scope.ts`'s
 * `installScopeDrift`**, which checks the install's `repository_selection`
 * MODE (`'selected'` vs `'all'`) — that check can read a healthy `'selected'`
 * install that is nonetheless STALE: `selected` is a fixed set fixed at
 * install time, and scaling a fleet by one agent does not retroactively
 * widen a pre-existing App's selection. Two different questions about the
 * same install: "is the MODE right" (install-scope.ts) vs "is the SET
 * right" (this module) — never conflate the two in naming or in a shared
 * function.
 *
 * **The live incident this closes.** Scaling `macf-trial` from 2 agents to
 * 3 created `trial-writing-agent`'s repo, and `apply` posted its runner
 * successfully — but `trial-runner-ops` was installed BEFORE that repo
 * existed, so its `selected` set still named only the original two agents.
 * The runner registration-token mint 404'd for the new repo, silently and
 * indefinitely: `apply` had already printed the CORRECT three-repo set in
 * its consent-gate-2 instruction text (`apply-agent.ts::installReposForIdentity`,
 * reused unchanged by {@link installScopeCoverageTargets} below — never a
 * second, hand-typed list) — but that instruction only fires when gate 2
 * itself re-opens, and a pre-existing App's gate never does.
 *
 * **Which Apps this covers, and why NOT every declared agent App too.** Only
 * `runner-ops` and the router App — the two FLEET-LEVEL identities whose
 * correct install target GROWS every time an agent is added
 * (`installReposForIdentity`'s runner-ops branch: "every declared agent's
 * repo"; `apply-router-app.ts::routerAppInstallRepos`: the registry target,
 * unaffected by agent count but included here for the SAME live-membership
 * reason). An ordinary agent's own App is scoped to its own repo (+ the
 * control repo, groundnuty/macf#1156) — a set that does not change shape
 * when a SIBLING agent is added, so it structurally cannot suffer this
 * drift from fleet-scaling. {@link evaluateInstallScopeCoverage} is still
 * role-agnostic (its own tests exercise it against an agent-shaped target
 * to pin that a correctly-scoped agent App reports `'covered'`, never
 * `'drift'`) — the SCOPING decision (which roles get a LIVE probe) lives in
 * {@link installScopeCoverageTargets} alone, not in the evaluator.
 *
 * **Why a per-repo JWT probe, not `GET /installation/repositories`.** The
 * paginated listing endpoint needs an INSTALLATION access token (a `ghs_`
 * exchange this tool never performs for itself) plus pagination.
 * `registry-repo-coverage.ts::checkRepoInAppInstallation`'s single-repo `GET
 * /repos/{owner}/{repo}/installation` under an App JWT already answers the
 * narrower question ("is THIS repo covered") with no token-exchange beyond
 * what a JWT mint from the vault-held PEM already requires — reused here
 * unchanged rather than building a second, differently-shaped live check.
 * This module therefore only ever reports MISSING repos (declared but not
 * confirmed covered) — it can never report an "installed but undeclared"
 * extra, because it never enumerates the installation's full repo set, only
 * probes the ones the manifest names. For the router App's SHARED scope
 * (`apply-router-app.ts`'s module doc: an owner-keyed, cross-fleet-reused
 * App) this asymmetry is exactly right — THIS fleet's manifest is not that
 * App's complete expected set, so reporting missing-per-this-fleet is
 * correct while reporting extras would be a false positive against a
 * legitimately shared App.
 *
 * **Honest-unknown, at TWO independent points (Amendment A).** (1) No
 * credential to probe with (no `--vault`/`--identity-key`, or this fleet's
 * vault has no PEM/App-ID for this role) — every expected repo for that
 * role reads `'unknown'`, no live call attempted. (2) A probed `'absent'`
 * for a repo whose OWN existence this run cannot independently confirm
 * `'present'` — collapses to `'unknown'`, never `'drift'`. `GET
 * /repos/{owner}/{repo}/installation` 404s identically for "not in this
 * App's selected set" and "this repo does not exist (yet)"
 * (`registry-repo-coverage.ts`'s own documented ambiguity for the single-
 * repo case); reporting drift for a repo this run never confirmed exists
 * would misdirect the operator toward "add it to Repository access" when
 * the repo may not even be there yet to add. {@link repoExistencePresence}
 * is the disambiguator: it reads the SAME per-agent `repo: Presence` /
 * `controlRepoPresence` facts `githubRegistryObserver` already observes for
 * unrelated reasons, never a new existence probe of its own.
 */
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveControlRepoName } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import { installReposForIdentity, writeScratchPem, cleanupScratchPem } from './apply-agent.js';
import { RUNNER_OPS_ROLE, deriveRunnerOpsHandle, runnerOpsNeeded } from './apply-runner-ops.js';
import { ROUTER_APP_ROLE, deriveRouterAppHandle, routerAppInstallRepos } from './apply-router-app.js';
import type { RouterAppScope } from './apply-router-app.js';
import { checkRepoInAppInstallation } from './registry-repo-coverage.js';
import { splitOwnerRepo } from './observer.js';
import type { VaultReadOptions } from './vault-read.js';
import { readVault, vaultRouterAppId, vaultRouterAppKeyPem, vaultRunnerOpsPrivateKeyPem } from './vault-read.js';
import { VaultError } from './vault-write.js';

// --- Declared side (pure, manifest-derived — never a second hand-typed list) ---

/** One fleet-level App this run checks scope-membership coverage for. */
export interface InstallScopeCoverageTarget {
  readonly role: string;
  readonly appHandle: string;
  readonly expectedRepos: readonly string[];
}

/**
 * `runner-ops` (only when {@link runnerOpsNeeded}) + the router App (only
 * when {@link routerAppInstallRepos} names a target — empty for
 * `registry.type: org|local`, which have no App-install surface here; see
 * that function's own doc). Zero-to-two entries. Pure; zero I/O — same
 * "derive from the manifest, never hard-code" discipline
 * `installReposForIdentity`/`routerAppInstallRepos` already establish, one
 * level up.
 */
export function installScopeCoverageTargets(manifest: FleetManifest): readonly InstallScopeCoverageTarget[] {
  const fleetName = manifest.metadata.name;
  const targets: InstallScopeCoverageTarget[] = [];
  if (runnerOpsNeeded(manifest)) {
    targets.push({
      role: RUNNER_OPS_ROLE,
      appHandle: deriveRunnerOpsHandle(fleetName),
      expectedRepos: installReposForIdentity(RUNNER_OPS_ROLE, manifest),
    });
  }
  const routerRepos = routerAppInstallRepos(manifest);
  if (routerRepos.length > 0) {
    const routerScope: RouterAppScope = manifest.transport.router_app_scope === 'per-fleet' ? 'per-fleet' : 'shared';
    targets.push({
      role: ROUTER_APP_ROLE,
      appHandle: deriveRouterAppHandle(fleetName, manifest.owner.account, routerScope),
      expectedRepos: routerRepos,
    });
  }
  return targets;
}

// --- Evaluation (pure diff — the decisive core) ---

export type InstallScopeCoverageStatus = 'covered' | 'drift' | 'unknown';

export interface InstallScopeCoverageEntry extends InstallScopeCoverageTarget {
  readonly status: InstallScopeCoverageStatus;
  /** Confirmed NOT covered — this run independently confirmed the repo exists AND the probe read `'absent'`. */
  readonly missingRepos: readonly string[];
  /** Could not be confirmed either way — no credential, a probe failure, or an `'absent'` probe whose repo existence isn't itself confirmed. */
  readonly unverifiedRepos: readonly string[];
  /** Present exactly when `status !== 'covered'` — nothing to say about a clean match. */
  readonly message?: string;
}

/**
 * `Add <repos> under "Repository access" ... never "All repositories"` —
 * runner-ops holds `administration:write` (see `apply-runner-ops.ts`'s
 * ratchet doc); naming the narrow fix explicitly is what keeps an operator
 * from reaching for the broad one out of expedience.
 */
export function installScopeCoverageDriftMessage(appHandle: string, missingRepos: readonly string[]): string {
  const noun = missingRepos.length === 1 ? 'this repo' : 'these repos';
  return (
    `App "${appHandle}" is missing repository access to ${missingRepos.join(', ')} — add exactly ${noun} under ` +
    '"Repository access" on the App\'s install page (never "All repositories"), then click "Save."'
  );
}

export function installScopeCoverageUnknownMessage(appHandle: string, unverifiedRepos: readonly string[]): string {
  return (
    `Could not confirm whether App "${appHandle}"'s installation covers ${unverifiedRepos.join(', ')} — check ` +
    'manually: GitHub, Settings, Applications, the App, Configure, Repository access.'
  );
}

/**
 * Pure per-target diff — total over every `expectedRepos` entry, never
 * throws. `repoExistence` is a plain lookup (never I/O here — see this
 * module's doc for why the disambiguation reads already-observed facts).
 */
export function evaluateInstallScopeCoverage(
  target: InstallScopeCoverageTarget,
  repoExistence: (repo: string) => Presence,
  probed: Readonly<Record<string, Presence>>,
): InstallScopeCoverageEntry {
  const missingRepos: string[] = [];
  const unverifiedRepos: string[] = [];
  for (const repo of target.expectedRepos) {
    const probedPresence = probed[repo] ?? 'unknown';
    const verdict = probedPresence === 'absent' && repoExistence(repo) !== 'present' ? 'unknown' : probedPresence;
    if (verdict === 'absent') missingRepos.push(repo);
    else if (verdict === 'unknown') unverifiedRepos.push(repo);
  }
  if (missingRepos.length > 0) {
    return { ...target, status: 'drift', missingRepos, unverifiedRepos, message: installScopeCoverageDriftMessage(target.appHandle, missingRepos) };
  }
  if (unverifiedRepos.length > 0) {
    return { ...target, status: 'unknown', missingRepos: [], unverifiedRepos, message: installScopeCoverageUnknownMessage(target.appHandle, unverifiedRepos) };
  }
  return { ...target, status: 'covered', missingRepos: [], unverifiedRepos: [] };
}

/**
 * The existence disambiguator (see module doc's "Honest-unknown, at TWO
 * independent points"). `agentRepoPresence` is keyed by ROLE (mirrors
 * `ObservedState.agents`'s own key), narrowed to just the one field this
 * function reads — never the whole `ObservedAgentState` shape, so a caller
 * only has to supply what this module actually uses.
 */
export function repoExistencePresence(
  manifest: FleetManifest,
  agentRepoPresence: Readonly<Record<string, Presence>>,
  controlRepoPresence: Presence,
  fullRepoName: string,
): Presence {
  const controlRepoFullName = `${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`;
  if (fullRepoName === controlRepoFullName) return controlRepoPresence;
  const owningAgent = manifest.agents.find((a) => a.repo === fullRepoName);
  return owningAgent === undefined ? 'unknown' : (agentRepoPresence[owningAgent.role] ?? 'unknown');
}

// --- Live probe (the real I/O leaf) ---

/**
 * One App's per-repo probe, reusing `registry-repo-coverage.ts`'s single-
 * repo JWT-authed check (see module doc for why not the paginated listing
 * endpoint). A repo string that doesn't parse as `owner/repo` reads
 * `'unknown'` without attempting a call — defensive; `FleetAgentSchema`
 * only enforces `min(1)`, no shape regex.
 */
export async function probeInstallScopeCoverage(
  appId: string,
  keyPath: string,
  expectedRepos: readonly string[],
  checkFn: (appId: string, keyPath: string, owner: string, repo: string) => Promise<Presence> = checkRepoInAppInstallation,
): Promise<Readonly<Record<string, Presence>>> {
  const out: Record<string, Presence> = {};
  for (const full of expectedRepos) {
    const split = splitOwnerRepo(full);
    out[full] = split === undefined ? 'unknown' : await checkFn(appId, keyPath, split.owner, split.name);
  }
  return out;
}

// --- Orchestration — vault read + credential resolution + probe + evaluate ---

export interface InstallScopeCoverageDeps {
  readonly probeFn?: (appId: string, keyPath: string, owner: string, repo: string) => Promise<Presence>;
  readonly readVaultFn?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
}

/**
 * Resolve ONE target's App-JWT credential from `fleet.lock` (`app_id`) +
 * the already-decrypted vault (`raw`, PEM). `undefined` when either half is
 * missing — this run either has no lock entry for the role yet, or the
 * vault holds no PEM for it (never provisioned, or provisioned outside
 * this vault). The router App's SHARED-scope `'vault-reused'` outcome
 * deliberately writes NO `fleet.lock` entry (`apply-router-app.ts`'s module
 * doc), so its `appId` falls back to {@link vaultRouterAppId} — the ONLY
 * role this fallback applies to; runner-ops and every agent App always get
 * a lock entry once created, so their `appId` comes from the lock alone.
 */
function resolveCoverageCredential(role: string, fleetName: string, lock: FleetLock | null, raw: Readonly<Record<string, string>>): { readonly appId: string; readonly pem: string } | undefined {
  const lockAppId = lock?.agents.find((a) => a.role === role)?.app_id;
  const appId = lockAppId ?? (role === ROUTER_APP_ROLE ? vaultRouterAppId(raw) : undefined);
  const pem = role === RUNNER_OPS_ROLE ? vaultRunnerOpsPrivateKeyPem(raw, fleetName) : role === ROUTER_APP_ROLE ? vaultRouterAppKeyPem(raw) : undefined;
  return appId === undefined || pem === undefined ? undefined : { appId, pem };
}

/** Every target's entry, all `'unknown'`, all `expectedRepos` unverified — the shared "nothing was checked this run" shape both the vault-flags-absent and vault-read-failure paths below produce. */
function allUnverified(targets: readonly InstallScopeCoverageTarget[], reason: string): Readonly<Record<string, InstallScopeCoverageEntry>> {
  const out: Record<string, InstallScopeCoverageEntry> = {};
  for (const target of targets) {
    out[target.role] = { ...target, status: 'unknown', missingRepos: [], unverifiedRepos: target.expectedRepos, message: reason };
  }
  return out;
}

/**
 * The whole run's install-scope-coverage observation — one entry per
 * {@link installScopeCoverageTargets} target, keyed by role. Self-contained
 * (owns its own vault read, mirrors `commands/bootstrap-apply.ts::resolveVaultAgentPems`'s
 * "never throws, degrade to honest-unknown" shape) rather than requiring
 * every caller to pre-decrypt — `plan`/`status`/`apply` each already do
 * their OWN independent `readVault` for OTHER fields (see
 * `commands/bootstrap-apply.ts`'s several separate `readVault` call sites);
 * one more independent, cheap local decrypt is the established idiom here,
 * not a new one.
 *
 * `vaultOpts === undefined` (no `--vault`/`--identity-key` this run) and a
 * failed decrypt both degrade to the IDENTICAL "every expected repo is
 * unverified" shape via {@link allUnverified} — Amendment A's honest-
 * unknown floor applies before ANY network I/O is attempted, not just
 * after a failed one, and a caller cannot tell "vault-free run" from
 * "vault read failed" apart from the `message` text, exactly the
 * distinction `resolveVaultAgentPems`'s own log line preserves.
 */
export async function computeInstallScopeCoverage(
  manifest: FleetManifest,
  lock: FleetLock | null,
  agentRepoPresence: Readonly<Record<string, Presence>>,
  controlRepoPresence: Presence,
  vaultOpts: VaultReadOptions | undefined,
  deps?: InstallScopeCoverageDeps,
): Promise<Readonly<Record<string, InstallScopeCoverageEntry>>> {
  const targets = installScopeCoverageTargets(manifest);
  if (targets.length === 0) return {};
  if (vaultOpts === undefined) {
    return allUnverified(targets, 'install-scope coverage was not checked this run — no --vault/--identity-key given.');
  }

  const doReadVault = deps?.readVaultFn ?? readVault;
  let raw: Readonly<Record<string, string>>;
  try {
    raw = await doReadVault(vaultOpts);
  } catch (err) {
    const reason = err instanceof VaultError || err instanceof Error ? err.message : String(err);
    return allUnverified(targets, `install-scope coverage was not checked this run — the vault could not be read (${reason}).`);
  }

  const probeFn = deps?.probeFn ?? checkRepoInAppInstallation;
  const out: Record<string, InstallScopeCoverageEntry> = {};
  for (const target of targets) {
    const credential = resolveCoverageCredential(target.role, manifest.metadata.name, lock, raw);
    if (credential === undefined) {
      out[target.role] = {
        ...target,
        status: 'unknown',
        missingRepos: [],
        unverifiedRepos: target.expectedRepos,
        message: installScopeCoverageUnknownMessage(target.appHandle, target.expectedRepos),
      };
      continue;
    }
    const keyPath = writeScratchPem(target.role, credential.pem);
    try {
      const probed = await probeInstallScopeCoverage(credential.appId, keyPath, target.expectedRepos, probeFn);
      const existence = (repo: string): Presence => repoExistencePresence(manifest, agentRepoPresence, controlRepoPresence, repo);
      out[target.role] = evaluateInstallScopeCoverage(target, existence, probed);
    } finally {
      cleanupScratchPem(keyPath);
    }
  }
  return out;
}

// --- Formatting ---

/** `true` when ANY target is confirmed drift — the incomplete-fleet verdict this module exists to surface. */
export function hasInstallScopeCoverageDrift(entries: Readonly<Record<string, InstallScopeCoverageEntry>>): boolean {
  return Object.values(entries).some((e) => e.status === 'drift');
}

/** One line per NON-covered target — `'covered'` entries render nothing (mirrors `formatInstallScopeDriftLines`'s "only the problem is loud" convention). */
export function formatInstallScopeCoverageLines(entries: Readonly<Record<string, InstallScopeCoverageEntry>>): readonly string[] {
  const lines: string[] = [];
  for (const entry of Object.values(entries)) {
    if (entry.status === 'covered') continue;
    const label = entry.status === 'drift' ? 'WARNING' : 'unknown';
    lines.push(`install-scope-coverage: ${label} — ${entry.message ?? ''}`);
  }
  return lines;
}

/** `--json` shape for one entry — snake_case, same convention every sibling notice in this CLI uses. */
export function installScopeCoverageEntryToJson(entry: InstallScopeCoverageEntry): unknown {
  return {
    role: entry.role,
    app_handle: entry.appHandle,
    expected_repos: entry.expectedRepos,
    status: entry.status,
    missing_repos: entry.missingRepos,
    unverified_repos: entry.unverifiedRepos,
    ...(entry.message !== undefined ? { message: entry.message } : {}),
  };
}
