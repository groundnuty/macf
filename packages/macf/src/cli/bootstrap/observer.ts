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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { parseFleetLock } from './fleet-manifest.js';
import type { ObservedAgentState, ObservedState, Presence } from './plan.js';

const execFileAsync = promisify(execFile);

/**
 * Read `fleet.lock` from the same directory as the manifest file. Returns
 * `null` when absent (a not-yet-provisioned fleet — the common Slice 1a
 * case) or malformed. NEVER throws.
 */
export function readFleetLock(manifestPath: string): FleetLock | null {
  const lockPath = join(dirname(manifestPath), 'fleet.lock');
  if (!existsSync(lockPath)) return null;
  try {
    return parseFleetLock(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Best-effort extraction of a caught `execFile` error's captured stderr. */
function getStderr(err: unknown): string {
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
 * Fleet-level: CA presence + the routing runner var are both READ on
 * `transport.vault_repo` (a single, always-declared representative target)
 * — a real repo-scoped Actions-variable read, degrading to `'unknown'` /
 * `undefined` on any failure.
 */
export async function githubRegistryObserver(manifest: FleetManifest, manifestPath: string): Promise<ObservedState> {
  const lock = readFleetLock(manifestPath);
  const agents: Record<string, ObservedAgentState> = {};

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
  }

  const seg = toVariableSegment(manifest.metadata.name);
  const caVarValue = await readRepoVariable(manifest.transport.vault_repo, `${seg}_CA_CERT`);
  const ca: Presence = caVarValue !== undefined ? 'present' : 'unknown';

  const routingRunsOn = manifest.routing?.runner
    ? await readRepoVariable(manifest.transport.vault_repo, 'MACF_ROUTING_RUNS_ON')
    : undefined;

  return { lock, agents, ca, routingRunsOn };
}
