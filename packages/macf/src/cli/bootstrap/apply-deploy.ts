/**
 * `macf bootstrap apply`'s default deploy phase (groundnuty/macf#1013).
 *
 * WHY: after the first fully-functional declarative provision, the operator
 * asked *"why was the fleet built with two commands, not one?"* The
 * two-phase GitHub-then-workspace split STAYS — the operator's own words:
 * *"I very much like and respect this separation that first we were
 * creating everything GitHub related, and then we could actually provision
 * agents."* This module is `apply` finishing the job the manifest already
 * describes, in the SAME phase order — not a third phase, not a collapse of
 * the two. And per the operator's directive: *"Deployment should be
 * default, definitely."*
 *
 * **Golden-path rule (macf#1000; the SAME rule #1011 applied to cert
 * issuance, applied here to deploy).** This module calls {@link
 * realDeployAgent} — the EXACT function `commands/fleet-deploy.ts`'s
 * `runFleetDeploy` (i.e. `macf fleet deploy`) invokes — once per declared
 * agent. It never reimplements clone / key-write / CA-materialize /
 * cert-issue itself; `deployAgentFn` is injectable ONLY so tests can assert
 * the CALL COUNT (the decisive proof this module composes rather than
 * reimplements — a test asserting "a workspace exists" would ALSO pass
 * against a reimplementation, which is exactly what must not happen).
 * Production code never overrides it.
 *
 * **Never rolls back the GitHub side (macf#1013 requirement 4).** A deploy
 * failure for one agent must not abort the others, and nothing here ever
 * touches the `FleetApplyResult` `applyFleet` already produced — the
 * GitHub-side state is durable by the time this module runs at all (DR-043
 * Amendment B); rolling it back on a workspace-materialization failure
 * would be strictly worse than a partially-deployed fleet.
 *
 * **Never logs credential material.** {@link DeployPhaseAgentResult} carries
 * only the SAME `FleetDeployOutcome` shape `commands/fleet-deploy.ts`
 * already renders (`role`/`status`/`appId`/`installId`/paths/fingerprints —
 * see that module's own doc) — this file adds no new field that could carry
 * a secret.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { FleetManifest } from './fleet-manifest.js';
import type { FleetDeployDeps, FleetDeployOutcome } from './fleet-deploy.js';
import { deployAgent as realDeployAgent } from './fleet-deploy.js';
import type { VaultReadOptions } from './vault-read.js';

/**
 * One declared agent's outcome from THIS apply run's deploy phase.
 * `destDir` is the resolved workspace path — the SAME resolution
 * `commands/fleet-deploy.ts::runFleetDeploy` applies when `--dir` is
 * omitted (`resolvePath(agent.deploy_path)`) — paired with the
 * `FleetDeployOutcome` {@link realDeployAgent} itself returned.
 */
export interface DeployPhaseAgentResult {
  readonly role: string;
  readonly destDir: string;
  readonly outcome: DeployPhaseOutcome;
}

/** An agent whose `deploy_path` this host cannot create, so no deploy was attempted. Never counted as a failure. */
export interface DeploySkippedOutcome {
  readonly role: string;
  readonly status: 'skipped';
  readonly reason: string;
}

/** What the deploy phase records per agent: a real {@link FleetDeployOutcome}, or a host-skip. */
export type DeployPhaseOutcome = FleetDeployOutcome | DeploySkippedOutcome;

/**
 * Whether this host can create `path`: the path exists, or its nearest
 * EXISTING ancestor is a directory this process can write. A writability
 * fact, not a guess about which host owns the path.
 */
export function checkDeployPathCreatable(path: string): { readonly ok: true } | { readonly ok: false; readonly ancestor: string } {
  let current = path;
  for (;;) {
    let exists = true;
    try {
      statSync(current);
    } catch {
      exists = false;
    }
    if (exists) {
      if (current === path) return { ok: true };
      try {
        accessSync(current, fsConstants.W_OK);
        return { ok: true };
      } catch {
        return { ok: false, ancestor: current };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { ok: false, ancestor: current };
    current = parent;
  }
}

/**
 * Mirrors `commands/fleet-deploy.ts::FleetDeployCommandDeps` — `FleetDeployDeps`
 * plus the ONE seam this module adds (`deployAgentFn`; see the module doc's
 * "Golden-path rule" section for why it exists and why production never
 * overrides it).
 */
export interface ApplyDeployPhaseDeps extends FleetDeployDeps {
  readonly deployAgentFn?: typeof realDeployAgent;
  /** Test seam for {@link checkDeployPathCreatable}; production never overrides it. */
  readonly checkPathCreatable?: typeof checkDeployPathCreatable;
}

/**
 * Deploys every declared agent whose `deploy_path` this host can create
 * (macf#1013 requirement 1). The macf#1013 design rejected filtering by a
 * same-host GUESS; the skip here is a writability FACT instead: the nearest
 * existing ancestor of `deploy_path` is not writable by this process (e.g.
 * `/home/ubuntu/...` on the operator's Mac), so deploying could only fail
 * with ENOENT. Such an agent gets `status: 'skipped'`, which does not fail
 * the run; a real deploy failure on a writable host still does. Sequential, not `Promise.all` — deliberate: `deployAgent` shells
 * out to `git`/`gh`/age-adjacent crypto per agent, a fleet is small (single
 * digits of agents, DR-043's own scope) by construction, and interleaved
 * stdout/stderr narration from `deps.log` across parallel agents would be
 * unreadable.
 *
 * NEVER throws — {@link realDeployAgent} itself catches every internal
 * failure into `{status:'failed', reason}` (see that function's own doc:
 * "the outer catch below"), so a per-agent failure here is always DATA in
 * the returned array, never a rejected promise the caller must additionally
 * guard — this is what makes "one agent fails, the others still deploy"
 * (macf#1013 requirement 4) fall out of a plain `for` loop rather than
 * needing its own try/catch per iteration.
 */
export async function runApplyDeployPhase(
  manifest: FleetManifest,
  flags: VaultReadOptions,
  deps: ApplyDeployPhaseDeps,
): Promise<readonly DeployPhaseAgentResult[]> {
  const deployAgentFn = deps.deployAgentFn ?? realDeployAgent;
  const results: DeployPhaseAgentResult[] = [];
  for (const agent of manifest.agents) {
    const destDir = resolvePath(agent.deploy_path);
    const creatable = (deps.checkPathCreatable ?? checkDeployPathCreatable)(destDir);
    if (!creatable.ok) {
      results.push({
        role: agent.role,
        destDir,
        outcome: { role: agent.role, status: 'skipped', reason: `this host cannot create ${destDir} (${creatable.ancestor} is not writable)` },
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential by design, see module doc.
    const outcome = await deployAgentFn(agent, manifest, destDir, flags, deps);
    results.push({ role: agent.role, destDir, outcome });
  }
  return results;
}

/** `true` when at least one {@link DeployPhaseAgentResult} in `results` has `outcome.status === 'failed'` — the exact predicate `applyExitCode` (macf#1013 requirement 4: "partial failure exits non-zero") ORs into its existing bad-condition list. */
export function anyDeployFailed(results: readonly DeployPhaseAgentResult[]): boolean {
  return results.some((r) => r.outcome.status === 'failed');
}
