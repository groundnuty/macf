/**
 * DR-043 §D6 write-back (groundnuty/macf#907) — the production writer behind
 * `macf fleet upgrade`'s `RollFleetDeps.recordDeployedVersion` seam
 * (`@groundnuty/macf-core`'s `fleet-upgrade.ts`). Turns a CONFIRMED
 * verify-green into a `fleet.lock` commit in the fleet's control repo
 * (DR-043 Amendment F) — the write `plan.ts`'s `ObservedAgentState.deployedVersion`
 * doc has, until this change, always described as absent ("no code path in
 * this repo writes one yet").
 *
 * **Why this lives here, not in `fleet-lock.ts`.** `fleet-lock.ts` is
 * deliberately I/O-thin (compose + serialize + a single-path read/write —
 * see its module doc: "the WRITER half"). This module is the ORCHESTRATION
 * around that writer for ONE specific caller (`macf fleet upgrade`'s
 * confirmed-green path): resolve the control repo, gate on ownership,
 * clone, find the agent's PRIOR identity (composeFleetLock requires
 * `appId`/`installId` — this writer never invents one), compose, write,
 * commit+push. Every actual read/write of `fleet.lock` still goes through
 * `fleet-lock.ts`'s `readFleetLockFile`/`composeFleetLock`/`writeFleetLock`
 * — this module never touches the file's bytes directly (macf#907's
 * explicit "reuse the existing writer, don't add a second one").
 *
 * **Ownership gate — never create, adopt, or un-archive.** Unlike
 * `provisionControlRepo` (which creates an ABSENT control repo as part of
 * `bootstrap apply`'s first act), this writer requires the control repo to
 * already be EXACTLY `'ours'`. `'absent'` / `'foreign'` / `'unknown'` /
 * `'ours-archived'` all refuse (see {@link recordDeployedVersionCore}) —
 * `macf fleet upgrade` runs from an agent's own operational context, not
 * the operator-privileged bootstrap tool, and has no business creating or
 * reviving a fleet's control-plane repo as a side effect of a version
 * bookkeeping write.
 *
 * **Opt-in, gated behind `-f, --file <path>`** (mirrors `fleet
 * deactivate`/`archive`'s existing `-f, --file` convention —
 * `check-before-propose.md`: match the established shape, don't invent a
 * new flag name). Omitted ⇒ `commands/fleet-upgrade.ts` never builds this
 * closure ⇒ `deployed_version` stays unwritten, byte-identical to
 * pre-macf#907 behavior — this feature is additive, never a default that
 * could surprise an operator who hasn't set up a control repo.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetManifest } from './fleet-manifest.js';
import { parseFleetManifest } from './fleet-manifest.js';
import type { ControlRepoMeta } from './control-repo.js';
import {
  classifyControlRepoOwnership,
  controlRepoFullName,
  checkControlRepoMeta,
  realReadControlManifestFile,
  realControlRepoCommitAndPush,
} from './control-repo.js';
import { realCloneRepo } from './apply-repo-init.js';
import { composeFleetLock, readFleetLockFile, writeFleetLock } from './fleet-lock.js';

/** Thrown by {@link recordDeployedVersionCore} on any refused/unsatisfiable write — always caught by `rollFleet`'s `recordDeployedVersion` caller and surfaced via the `'lock-write-failed'` event, never left to propagate. */
export class RecordDeployedVersionError extends Error {}

/** Injectable I/O seam — production binds the real `gh`/`git` primitives (see {@link realRecordDeployedVersionDeps}); tests supply fakes. Deliberately the SAME shape as `control-repo.ts`'s `ControlRepoDeps` minus the create/unarchive verbs this writer never calls. */
export interface RecordDeployedVersionDeps {
  readonly checkMeta: (repo: string) => Promise<ControlRepoMeta>;
  readonly readManifestFile: (repo: string) => Promise<string | undefined>;
  readonly cloneRepo: (url: string, destDir: string) => Promise<void>;
  readonly commitAndPush: (dir: string, message: string) => Promise<'pushed' | 'nothing-to-commit'>;
  /** Injectable so tests get a deterministic checkout dir instead of a fresh `mkdtemp` each run — same convention as `control-repo.ts`'s `ControlRepoOptions.makeScratchDir`. */
  readonly makeScratchDir: (prefix: string) => string;
  readonly cloneUrl?: (repo: string) => string;
}

function defaultCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * The orchestration core — pure w.r.t. its inputs beyond what `deps`
 * performs, fully unit-testable with fakes (no real `gh`/`git`). Given the
 * fleet's ALREADY-PARSED manifest plus (confirmed agent role, the fleet name
 * the roll believes it's targeting, the confirmed version), clones the
 * control repo and commits an updated `fleet.lock`. Throws
 * {@link RecordDeployedVersionError} on any refusal — the caller
 * (`rollFleet`) catches it.
 */
export async function recordDeployedVersionCore(
  manifest: FleetManifest,
  agentRole: string,
  fleetName: string,
  version: string,
  deps: RecordDeployedVersionDeps,
): Promise<void> {
  // Defensive — a `-f, --file` pointed at the wrong fleet.yaml would
  // otherwise silently write into a foreign fleet's control repo. Checked
  // BEFORE any I/O.
  if (manifest.metadata.name !== fleetName) {
    throw new RecordDeployedVersionError(
      `fleet.yaml at the configured --file declares fleet "${manifest.metadata.name}", but this roll is for ` +
        `"${fleetName}" — refusing to write deployed_version into a mismatched control repo.`,
    );
  }

  const repo = controlRepoFullName(manifest);
  const meta = await deps.checkMeta(repo);
  const manifestFileContent = meta.presence === 'present' ? await deps.readManifestFile(repo) : undefined;
  const ownership = classifyControlRepoOwnership(meta, manifestFileContent, manifest);
  // Ownership gate (module doc) — EXACTLY 'ours'. Never create ('absent'),
  // never adopt ('foreign'/'unknown'), never un-archive ('ours-archived') —
  // all of those are `bootstrap apply`'s job, gated on the operator's
  // explicit consent, not a side effect of a version bookkeeping write.
  if (ownership.kind !== 'ours') {
    throw new RecordDeployedVersionError(
      `control repo "${repo}" ownership is "${ownership.kind}", not "ours" — refusing to write deployed_version ` +
        '(this writer never creates, adopts, or un-archives a control repo; run `macf bootstrap apply` first).',
    );
  }

  const cloneUrl = deps.cloneUrl ?? defaultCloneUrl;
  const localDir = deps.makeScratchDir('macf-fleet-upgrade-lock-');
  await deps.cloneRepo(cloneUrl(repo), localDir);

  const lockPath = join(localDir, 'fleet.lock');
  const lock = readFleetLockFile(lockPath);
  const prior = lock?.agents.find((a) => a.role === agentRole);
  if (!prior) {
    // composeFleetLock requires appId/installId for every touched role —
    // inventing them here would be a worse bug than refusing (fail loud,
    // same posture as the rest of DR-043's writer surface).
    throw new RecordDeployedVersionError(
      `control repo "${repo}"'s fleet.lock has no prior entry for role "${agentRole}" — cannot record ` +
        'deployed_version without an existing app_id/install_id identity (run `macf bootstrap apply` first).',
    );
  }

  const composed = composeFleetLock({
    fleet: manifest.metadata.name,
    previous: lock,
    agentUpdates: { [agentRole]: { appId: prior.app_id, installId: prior.install_id, deployedVersion: version } },
  });
  writeFleetLock(lockPath, composed.lock);

  await deps.commitAndPush(
    localDir,
    `chore(bootstrap): record deployed_version ${version} for "${agentRole}" (DR-043 §D6, macf#907)`,
  );
}

/** Real deps — reuses the EXISTING `gh`/`git` I/O leaves (`control-repo.ts` + `apply-repo-init.ts`), never a second set of shell-outs. */
export const realRecordDeployedVersionDeps: RecordDeployedVersionDeps = {
  checkMeta: checkControlRepoMeta,
  readManifestFile: realReadControlManifestFile,
  cloneRepo: realCloneRepo,
  commitAndPush: realControlRepoCommitAndPush,
  makeScratchDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
};

/**
 * Build the `RollFleetDeps.recordDeployedVersion` closure from a LOCAL
 * `fleet.yaml` path (the `-f, --file` CLI flag — see
 * `commands/fleet-upgrade.ts`). Reads + parses the manifest ONCE at build
 * time (a roll's target fleet doesn't change mid-run; per-agent variance is
 * `recordDeployedVersionCore`'s `agentRole` param) — throws synchronously on
 * an unreadable/invalid manifest so the command fails loud at RESOLVE time,
 * before touching any agent, rather than failing per-agent mid-roll.
 */
export function buildRecordDeployedVersion(
  manifestPath: string,
  deps: RecordDeployedVersionDeps = realRecordDeployedVersionDeps,
): (agent: string, fleet: string, version: string) => Promise<void> {
  const manifest = parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  return (agent, fleet, version) => recordDeployedVersionCore(manifest, agent, fleet, version, deps);
}
