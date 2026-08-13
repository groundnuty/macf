/**
 * `githubRegistryObserver` — the REAL, read-only `FleetObserverFn`
 * implementation for `macf bootstrap plan` (DR-043 Slice 1a, groundnuty/macf#838).
 *
 * This is the I/O LEAF (same split as `fleet-doctor.ts` / `fleet-doctor-inject.ts`):
 * every network/subprocess touch lives here, so `plan.ts`'s `computePlan` stays
 * pure and fully unit-tested against hand-built `ObservedState` fixtures. This
 * module itself is deliberately THIN and best-effort — every read degrades to
 * `'unknown'` (or `undefined`) rather than throwing, per DR-043 §D2's plan-time
 * constraint: **there is no JWT yet** (the App doesn't exist until `apply`
 * creates it), so App / install existence can only be inferred from
 * `fleet.lock` (populated by a PRIOR `apply`), never confirmed live. Repo
 * existence + repo-scoped Actions variables ARE plan-time-observable — those
 * use the operator's own ambient `gh` auth (this tool is operator-privileged
 * by design, DR-035 §2 / `macf-bootstrap-safety.md` — it never mints a
 * fleet-agent bot token).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveControlRepoName } from './fleet-manifest.js';
import type { FleetObserverFn, ObservedAgentState, ObservedState, Presence } from './plan.js';
import { readFleetLockFile } from './fleet-lock.js';
import { registryPathPrefix } from '../registry-helper.js';
import type { VaultAgentObservation, VaultCaObservation, VaultReadOptions } from './vault-read.js';
import { VaultError } from './vault-write.js';
import { queryVaultAgentPresence, queryVaultCaPresence, readVault } from './vault-read.js';

const execFileAsync = promisify(execFile);

/**
 * Read `fleet.lock` from the same directory as the manifest file. Returns
 * `null` when absent (a not-yet-provisioned fleet — the common Slice 1a
 * case) or malformed. NEVER throws. Thin wrapper over
 * `fleet-lock.ts::readFleetLockFile` (macf#857) — that function takes the
 * exact lock path directly (needed by `apply-fleet.ts`'s control-repo
 * self-heal read); this one derives it from a manifest file's directory.
 */
export function readFleetLock(manifestPath: string): FleetLock | null {
  return readFleetLockFile(join(dirname(manifestPath), 'fleet.lock'));
}

/**
 * Best-effort extraction of a caught `execFile` error's captured stderr.
 * Exported so `control-repo.ts` reuses the same 404-vs-other-failure
 * discrimination (Amendment F's `checkControlRepoMeta`) instead of
 * duplicating this parsing.
 */
export function getStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const s = (err as { readonly stderr?: unknown }).stderr;
    return typeof s === 'string' ? s : '';
  }
  return '';
}

/**
 * Read-only repo-existence check via `gh api repos/<owner>/<repo>`. A `gh`-
 * reported 404 is a confident `'absent'`; any other failure (auth, network,
 * rate-limit, `gh` missing) degrades to `'unknown'` rather than claiming
 * absence. NEVER throws.
 */
export async function checkRepoExists(repo: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/** One repo's presence + (when present) its `archived` bit — the shape {@link checkRepoArchivedState} returns. */
export interface RepoArchivedMeta {
  readonly presence: Presence;
  readonly archived?: boolean;
}

/**
 * Read-only `{archived}` probe — DR-043 Amendment G (groundnuty/macf#867):
 * `plan` needs to report an archived control repo as a DELIBERATE fleet
 * state (`plan.ts`'s new `control_repo` item), not as drift, and that read
 * has to happen at PLAN time (credential-free, live `gh`, per DR-043
 * Amendment A1) alongside every other repo/variable read this file already
 * does. Deliberately NOT `control-repo.ts::checkControlRepoMeta` reused
 * directly here — `control-repo.ts` already imports {@link getStderr} FROM
 * this module, so a reverse import (this module pulling a function back
 * FROM `control-repo.ts`) would create a circular module edge. Same
 * one-round-trip `gh api ... --jq '{archived: .archived}'` shape as that
 * function's sibling copy — a drift between the two would be caught by
 * their own tests, never silent.
 */
export async function checkRepoArchivedState(repo: string): Promise<RepoArchivedMeta> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}`, '--jq', '{archived: .archived}'], { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(stdout);
    const archived =
      typeof parsed === 'object' && parsed !== null && 'archived' in parsed && typeof (parsed as { archived: unknown }).archived === 'boolean'
        ? (parsed as { archived: boolean }).archived
        : undefined;
    return { presence: 'present', archived };
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return { presence: 'absent' };
    return { presence: 'unknown' };
  }
}

/**
 * Best-effort read-only repo-scoped Actions-variable read. Returns the
 * value, or `undefined` on ANY failure (missing var, no access, `gh`
 * absent) — this collapses "confirmed absent" and "couldn't tell" into one
 * signal, an intentional THIN-observer simplification (see module doc).
 * NEVER throws.
 */
export async function readRepoVariable(repo: string, name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'],
      { encoding: 'utf-8' },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read-only repo-scoped Actions-variable EXISTENCE check — the
 * absent/unknown-distinguishing sibling of {@link readRepoVariable} (which
 * collapses both into `undefined`; fine for the `routingRunsOn` VALUE read,
 * but not for the per-repo CA-var drift class the #806 acceptance test needs
 * to reproduce: telling a confirmed-404 repo-var apart from a couldn't-read
 * one, same split as {@link checkRepoExists}). A `gh`-reported 404 is a
 * confident `'absent'`; any other failure degrades to `'unknown'`. NEVER
 * throws (macf#839 review [BLOCKING] 3).
 */
export async function checkRepoVariablePresence(repo: string, name: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `repos/${repo}/actions/variables/${name}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Read-only registry-scope Actions-variable EXISTENCE check — the other leg
 * of the DR two-place rule (macf#806): the CA var lives on the registry
 * (`owner.registry`: profile/org/repo scope) AND on every agent repo (see
 * {@link checkRepoVariablePresence}). Reuses `registryPathPrefix` (the same
 * scope→API-path mapping the agent-side registry client uses) so this stays
 * in lockstep with how the registry is actually addressed. An unsupported
 * scope (`local` — no GitHub API path) or any read failure degrades to
 * `'unknown'` rather than throwing; a confirmed 404 is `'absent'`. NEVER
 * throws (macf#839 review [BLOCKING] 3).
 */
export async function checkRegistryVariablePresence(registry: RegistryConfig, name: string): Promise<Presence> {
  let pathPrefix: string;
  try {
    pathPrefix = registryPathPrefix(registry);
  } catch {
    return 'unknown';
  }
  try {
    await execFileAsync('gh', ['api', `${pathPrefix.replace(/^\//, '')}/actions/variables/${name}`], {
      encoding: 'utf-8',
    });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Best-effort read-only registry-scope Actions-variable VALUE read — the
 * registry-scope sibling of {@link readRepoVariable} (macf#838 Phase 2b, the
 * CA-reuse path: `apply-ca.ts::resolveCaCert` needs the EXISTING CA cert's
 * value to backfill any per-repo legs the #806 drift class left missing).
 * Returns `undefined` on ANY failure (missing var, no access, unsupported
 * registry scope, `gh` absent) — same "collapse absent + unreadable into one
 * signal" posture `readRepoVariable` already establishes; a caller that
 * needs to distinguish MUST run {@link checkRegistryVariablePresence} first
 * (which `resolveCaCert` does). NEVER throws.
 */
export async function readRegistryVariable(registry: RegistryConfig, name: string): Promise<string | undefined> {
  let pathPrefix: string;
  try {
    pathPrefix = registryPathPrefix(registry);
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `${pathPrefix.replace(/^\//, '')}/actions/variables/${name}`, '--jq', '.value'],
      { encoding: 'utf-8' },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real `FleetObserverFn`. `manifestPath` is the on-disk path to the
 * `fleet.yaml` that was parsed into `manifest` — used only to locate the
 * co-located `fleet.lock` (never re-parses the manifest itself).
 *
 * Per-agent: App + install existence come from `fleet.lock` ONLY (never
 * `'absent'` — a missing lock entry is `'unknown'`, since the App may simply
 * not have been provisioned via THIS tool yet, and we have no JWT to check
 * GitHub directly). Repo existence is a live `gh api` read. Fingerprints
 * are copied verbatim from the lock (never a live registry read in Slice 1a
 * — see `plan.ts`'s `secretFingerprintItem` doc for why drift-detection
 * there is a Slice-2 concern).
 *
 * CA presence is read at BOTH DR two-place-rule legs (macf#806, until
 * macf-actions#66 collapses it to one): the **registry** (`owner.registry` —
 * profile/org/repo scope, read once) AND a **per-agent-repo** copy on EVERY
 * agent's `repo` (macf#839 review [BLOCKING] 3 — a single "representative"
 * repo read cannot reproduce the #806 drift class: a per-repo var absent
 * while the registry + other repos have it).
 *
 * The routing runner var is read on a single REPRESENTATIVE caller repo —
 * `manifest.agents[0].repo` (macf#857 / DR-043 Amendment F review). Prior to
 * Amendment F this read `transport.vault_repo`, which (in every fleet seen
 * so far) happened to BE an agent repo; Amendment F removes `vault_repo`
 * entirely (the vault now lives in the derived `<fleet>-control` repo, which
 * is NEVER a routing caller — `MACF_ROUTING_RUNS_ON` is set per §D1 on
 * "every caller repo," and the control repo is not one). Reading it from the
 * control repo would make `routingRunsOn` permanently `undefined`, so
 * `routingItem` would emit `create` forever and the `noop`/`update`
 * branches would go permanently dead — a silent plan regression. `agents[0]`
 * preserves the original "one representative target" semantics;
 * `FleetManifestSchema.agents` is `.min(1)` so this is always populated at
 * the type level, but `noUncheckedIndexedAccess` still requires the runtime
 * guard below.
 *
 * The control repo's presence/archived state (DR-043 Amendment G,
 * `plan.ts`'s new `control_repo` item) is read the SAME way `checkRepoExists`
 * reads an agent repo — credential-free, live `gh` — via
 * {@link checkRepoArchivedState} against the SAME derived name
 * `control-repo.ts::controlRepoFullName` computes (`deriveControlRepoName`
 * imported from `fleet-manifest.ts`, not `controlRepoFullName` itself — see
 * `checkRepoArchivedState`'s doc for why this module can't import FROM
 * `control-repo.ts`).
 */
export async function githubRegistryObserver(manifest: FleetManifest, manifestPath: string): Promise<ObservedState> {
  const lock = readFleetLock(manifestPath);
  const seg = toVariableSegment(manifest.metadata.name);
  const caVarName = `${seg}_CA_CERT`;

  const agents: Record<string, ObservedAgentState> = {};
  const caRepos: Record<string, Presence> = {};

  for (const agent of manifest.agents) {
    const lockEntry = lock?.agents.find((a) => a.role === agent.role);
    const repo = await checkRepoExists(agent.repo);
    agents[agent.role] = {
      app: lockEntry ? 'present' : 'unknown',
      appId: lockEntry?.app_id,
      install: lockEntry ? 'present' : 'unknown',
      installId: lockEntry?.install_id,
      repo,
      fingerprints: lockEntry?.fingerprints ?? {},
      deployedVersion: lockEntry?.deployed_version,
    };
    caRepos[agent.repo] = await checkRepoVariablePresence(agent.repo, caVarName);
  }

  const caRegistry = await checkRegistryVariablePresence(manifest.owner.registry, caVarName);

  // macf#857 — representative caller repo; see this function's doc for why
  // it's `agents[0].repo`, not `transport.vault_repo` (removed) or the
  // control repo (never a routing caller).
  const representativeCallerRepo = manifest.agents[0]?.repo;
  const routingRunsOn =
    manifest.routing?.runner && representativeCallerRepo !== undefined
      ? await readRepoVariable(representativeCallerRepo, 'MACF_ROUTING_RUNS_ON')
      : undefined;

  // DR-043 Amendment G — same derived name `control-repo.ts::controlRepoFullName`
  // computes; see this function's doc for why it's re-derived here rather
  // than imported.
  const controlRepoMeta = await checkRepoArchivedState(`${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`);

  return {
    lock,
    agents,
    caRegistry,
    caRepos,
    routingRunsOn,
    controlRepoPresence: controlRepoMeta.presence,
    controlRepoArchived: controlRepoMeta.archived,
  };
}

// --- vaultAwareObserver — DR-043 Amendment D phase 3 ("the vault-aware observer") ---

/** Injectable seam for {@link vaultAwareObserver}'s tests — real defaults are `githubRegistryObserver` (bound to `manifestPath`) and `vault-read.ts::readVault`. */
export interface VaultAwareObserverDeps {
  readonly observe?: FleetObserverFn;
  readonly readVault?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
}

/**
 * `githubRegistryObserver`, decorated with vault-derived per-agent secret
 * presence + fleet-level CA-key presence — DR-043 Amendment D phase 3, named
 * literally in the DR's phasing table: *"Vault read → vault-aware observer +
 * read-only decrypt... lifts phase 2 into Amendment A's confirm tier."*
 *
 * **Operator-gated by construction, not by a runtime check.** A caller only
 * reaches this function by supplying `vaultOpts` — a vault path AND an age
 * identity-key PATH it already holds on disk. An agent context never holds
 * the fleet's age key (Amendment C: the key is operator-provided, never
 * tool-minted, never handed to a fleet agent), so it structurally cannot
 * construct these options for a REAL fleet's vault; this module's own tests
 * exercise it against synthetic keys only (`vault-read.ts`'s module doc).
 *
 * **Never a guess — always `confirmed` or honestly `unknown` (Amendment A4).**
 * Every vault-read failure (missing vault file, missing/unreadable identity,
 * wrong key, malformed plaintext — see `vault-read.ts::readVault`'s doc)
 * degrades the WHOLE decoration to `status: 'unknown'` with the causing
 * `VaultError`'s message (already scrubbed of secret material at the
 * source) as `reason` — NEVER `'absent'`. "An absent identity key is not
 * evidence of an empty vault" (this increment's own brief) is exactly this
 * floor: a caller who forgot `--identity-key`, or pointed it at the wrong
 * file, gets `unknown`, never a false "nothing's provisioned."
 *
 * The BASE observation (`githubRegistryObserver`'s `lock`/`caRepos`/
 * `routingRunsOn`/non-vault agent fields) is computed exactly as before and
 * carried through unchanged — this function ADDS `vault`/`vaultCa`, it never
 * revises anything the non-vault-aware observer already determined.
 */
export async function vaultAwareObserver(
  manifest: FleetManifest,
  manifestPath: string,
  vaultOpts: VaultReadOptions,
  deps?: VaultAwareObserverDeps,
): Promise<ObservedState> {
  const observe = deps?.observe ?? ((m: FleetManifest) => githubRegistryObserver(m, manifestPath));
  const doReadVault = deps?.readVault ?? readVault;

  const base = await observe(manifest);

  let raw: Readonly<Record<string, string>> | undefined;
  let unknownReason = 'vault not read (no vault/identity-key path given)';
  try {
    raw = await doReadVault(vaultOpts);
  } catch (err) {
    unknownReason = err instanceof VaultError || err instanceof Error ? err.message : String(err);
  }

  const agents: Record<string, ObservedAgentState> = {};
  for (const [role, obs] of Object.entries(base.agents)) {
    const vault: VaultAgentObservation =
      raw !== undefined
        ? { status: 'confirmed', presence: queryVaultAgentPresence(raw, manifest.metadata.name, role) }
        : { status: 'unknown', reason: unknownReason };
    agents[role] = { ...obs, vault };
  }

  const vaultCa: VaultCaObservation =
    raw !== undefined
      ? { status: 'confirmed', presence: queryVaultCaPresence(raw, manifest.metadata.name) }
      : { status: 'unknown', reason: unknownReason };

  return { ...base, agents, vaultCa };
}
