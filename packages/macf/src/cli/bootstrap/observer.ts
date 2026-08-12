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
import type { ObservedAgentState, ObservedState, Presence } from './plan.js';
import { readFleetLockFile } from './fleet-lock.js';
import { registryPathPrefix } from '../registry-helper.js';

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

  return { lock, agents, caRegistry, caRepos, routingRunsOn };
}
