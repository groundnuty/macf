/**
 * `repo-init` for the CONTROL repo (groundnuty/macf#1057) — installs the
 * router workflow + one assignment label per DECLARED fleet agent + the
 * status labels onto `<fleet>-control`, so cross-agent coordination has a
 * repo every agent's App can already reach without any new install grant.
 *
 * **Why the control repo, not peer-repo access.** #1057 found a provisioned
 * fleet's agents online for hours, never able to exchange a routed message:
 * each agent's App is installed only on its own repo + the control repo, so
 * routing to a PEER agent's repo 404s (invisible, not merely unauthorized).
 * The ruling (science-agent + operator, #1057 thread): coordination issues
 * live in the control repo, because it is the one repo every agent's App
 * ALREADY reaches — the alternative (installing every agent's App on every
 * OTHER agent's repo) would each hand out that App's WHOLE declared
 * permission set (GitHub App permissions are per-App, not per-repo — DR-019
 * includes `contents: write` + `workflows: write`) just to get the
 * `issues: write` routing actually needs. The control repo needs zero new
 * grants because agent Apps are already installed there.
 *
 * **Reuses `commands/repo-init.ts::repoInit` VERBATIM** — the same "#1000
 * golden path" `apply-repo-init.ts` already established for per-agent repos:
 * the routing plane is `macf repo-init`-generated, never hand-templated
 * (macf#797/#805/#806). The control repo is simply a repo-init TARGET with
 * the FULL declared agent list, rather than one agent's own role.
 *
 * **Deliberately does NOT reuse `apply-repo-init.ts::applyRepoInitForAgent`
 * verbatim** — that function owns its OWN scratch clone + an IMMEDIATE `-A`
 * commit+push, both wrong here:
 *   - `-A` would violate Amendment F's "sealed-or-public ONLY, explicit
 *     allowlist, never `-A`" invariant (`control-repo.ts`'s module doc) —
 *     the control-repo checkout this function writes into is the SAME
 *     long-lived `controlDir` that accumulates `fleet.lock` / `secrets/
 *     vault.age` across the whole `apply` run; committing everything in it
 *     with `-A` risks sweeping in exactly the plaintext-vault / in-flight
 *     recovery-artifact class that module's "Phase-3 forward guard" warns
 *     about.
 *   - A second, independent scratch clone + immediate push would race
 *     `controlDir` itself: `apply-fleet.ts` pushes `controlDir` exactly
 *     ONCE, at the very end of the run (`syncControlRepo`). A separate
 *     clone pushing to `origin` first would leave `controlDir`'s local HEAD
 *     behind `origin`, breaking that final push.
 *
 * So this module runs `repoInit()` straight against the ALREADY-CLONED
 * `controlDir` — no clone, no commit, no push of its own. The caller
 * (`apply-fleet.ts`) commits everything `controlDir` has accumulated by the
 * end of the run — including whatever this step wrote — in ONE final
 * `syncControlRepo` / `control-repo.ts::realControlRepoCommitAndPush` call.
 *
 * **Finding (#1057 review) — the files this step writes are NOT currently
 * part of `control-repo.ts::CONTROL_REPO_COMMIT_ALLOWLIST`.** That allowlist
 * is `['fleet.yaml', 'fleet.lock', 'secrets/vault.age', '.gitignore']` —
 * `.github/workflows/agent-router.yml` and `.github/agent-config.json` (the
 * two paths `repoInit()` actually writes) are ABSENT from it.
 * `control-repo.ts`'s own module doc DOES name "workflows" as permitted
 * sealed-or-public content in principle (Amendment F: *"vault.age
 * (encrypted), fleet.yaml/fleet.lock (secret-free), workflows, attested
 * non-secret signals"*), but the ENFORCEMENT array was never extended to the
 * two paths this step needs. Per #1057's explicit instruction, this module
 * does NOT widen that allowlist itself — {@link controlRepoWorkflowAllowlisted}
 * makes the gap OBSERVABLE (a boolean on this step's own outcome, checked
 * fresh against the live allowlist — never a hand-copied literal that could
 * drift), rather than silently letting `realControlRepoCommitAndPush` drop
 * the files at the final push with no signal anywhere. Until a future PR
 * deliberately extends `CONTROL_REPO_COMMIT_ALLOWLIST`, the router workflow
 * this step writes is NOT actually pushed to `<fleet>-control` — it exists
 * only in the ephemeral `controlDir` checkout, which is deleted at the end
 * of the run. **Labels are UNAFFECTED by this gap** — label creation is a
 * live GitHub API call inside `repoInit()`, entirely independent of
 * git-committed content.
 *
 * **Token sourcing (no new grant, per this issue's hard constraint).** This
 * step passes NO explicit `tokenSource` — same posture `apply-repo-init.ts`
 * already accepts for its `reused`/`resumed-install` agent paths (see that
 * module's doc): a Mac-side `apply` run has no ambient bot credentials, so
 * `repoInit()`'s own `generateToken()` degrades to `labels: {status:
 * 'skipped'}` rather than throwing. Minting a token here would mean either
 * inventing a NEW control-repo-scoped credential (a new grant — exactly what
 * this design avoids) or reusing one agent's App opportunistically (an
 * assumption this codebase does not currently guarantee — no code path
 * installs every declared agent's App onto the control repo; it happens to
 * hold today only because the operator's own gate-2 install click included
 * it).
 *
 * **The sharper shape of the gap.** Every OTHER control-repo operation this
 * run performs — `gh repo create`, `gh api repos/…`, the clone, the final
 * push — runs on the OPERATOR's own `gh` auth (`control-repo.ts`'s I/O
 * leaves all shell out to `gh`), which already has admin on a repo the
 * operator owns. `createLabel` (`commands/repo-init.ts`) is the ONE
 * operation in this whole step that goes through a raw `fetch` + Bearer
 * App-installation token instead — so the one authority that should
 * naturally govern operator-owned ground (the operator's own `gh` session)
 * is structurally unreachable from that specific code path. Labels
 * therefore can't work here today without EITHER a legitimate token source
 * (the gap this doc's first paragraph describes) OR a second,
 * `gh`-auth-based label-creation primitive — and the latter is exactly the
 * duplicate mechanism `#1000`'s golden path (and this thread's own
 * correction of a near-duplicate label path) rules out. Label creation
 * therefore degrades gracefully today; a future increment that threads a
 * legitimate token source can tighten this the same way macf#920 tightened
 * the per-agent `created` path.
 */
import type { FleetManifest } from './fleet-manifest.js';
import type { LabelsOutcome } from '../commands/repo-init.js';
import { repoInit as realRepoInit } from '../commands/repo-init.js';
import { DEFAULT_ACTIONS_VERSION, repoInitRegistryOptions } from './apply-repo-init.js';
import { CONTROL_REPO_COMMIT_ALLOWLIST, controlRepoFullName } from './control-repo.js';

/** The two paths `repoInit()` writes that this step cares about — see this module's doc's "Finding" section. Exported so tests assert against the SAME literals rather than a second hand-copied pair. */
export const CONTROL_REPO_WORKFLOW_RELATIVE_PATH = '.github/workflows/agent-router.yml';
export const CONTROL_REPO_AGENT_CONFIG_RELATIVE_PATH = '.github/agent-config.json';

/**
 * Whether `CONTROL_REPO_COMMIT_ALLOWLIST` currently includes BOTH paths
 * `repoInit()` writes — checked fresh against the live array (never a
 * hand-copied boolean), so a future PR that extends the allowlist flips this
 * to `true` automatically, with no change needed here. See this module's
 * doc's "Finding" section.
 */
export function controlRepoWorkflowAllowlisted(): boolean {
  return (
    CONTROL_REPO_COMMIT_ALLOWLIST.includes(CONTROL_REPO_WORKFLOW_RELATIVE_PATH) &&
    CONTROL_REPO_COMMIT_ALLOWLIST.includes(CONTROL_REPO_AGENT_CONFIG_RELATIVE_PATH)
  );
}

export interface ControlRepoInitDeps {
  /**
   * Injectable so tests never make a real network call — defaults to the
   * real `repoInit` (`commands/repo-init.ts`). Production reuses the EXACT
   * SAME function object already threaded via
   * `FleetApplyDeps.repoInitDeps.repoInit` (`apply-fleet.ts`'s call site) —
   * no new required dependency, and no new place a fake needs wiring in any
   * existing test.
   */
  readonly repoInit?: typeof realRepoInit;
}

/**
 * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
 * — mirrors `apply-repo-init.ts::RepoInitStepOptions`'s `actionsVersion`/
 * `force` pair exactly, for the SAME reason: the caller computes the
 * reconcile decision once, via `resolveActionsPinReconcile`, from the
 * ALREADY-OBSERVED `ObservedState.controlRepoActionsPin` — this module
 * never reads it itself. Omitted (both undefined) preserves the exact
 * pre-#1072 fallback (`manifest.versions?.actions ?? DEFAULT_ACTIONS_VERSION`,
 * always `force: false`).
 */
export interface ControlRepoInitOptions {
  readonly actionsVersion?: string;
  readonly force?: boolean;
}

export type ControlRepoInitOutcome =
  | {
      readonly repo: string;
      /** Every role `manifest.agents[]` declares, in manifest order — the decisive #1057 requirement is ALL of them, not just one. */
      readonly agents: readonly string[];
      readonly status: 'written';
      readonly labels: LabelsOutcome;
      /** See {@link controlRepoWorkflowAllowlisted}'s doc. `false` today — a known, reported gap, not a silent drop. */
      readonly workflowAndConfigAllowlisted: boolean;
    }
  | {
      readonly repo: string;
      readonly agents: readonly string[];
      readonly status: 'failed';
      readonly reason: string;
    };

/**
 * Whether the control repo, as of THIS run's `applyControlRepoInit` outcome,
 * actually carries a router workflow that will reach GitHub — i.e. whether
 * it belongs in the target-repo set for anything the router job itself
 * needs (groundnuty/macf#1071's fix: derive the publish target set from
 * "repos that carry the router" instead of a hand-maintained agent-repo
 * list, which is exactly what let the control repo — a NEW router-carrying
 * repo added by #1057/#1070 — go unpublished).
 *
 * Requires BOTH:
 *   - `status === 'written'` — `repoInit()` actually wrote the workflow file
 *     into `controlDir`'s working tree this run (a `'failed'` repo-init, or
 *     the caller's `{ status: 'skipped' }` fallback for an aborted apply,
 *     never wrote anything to check).
 *   - `workflowAndConfigAllowlisted` — the write is actually going to be
 *     COMMITTED to the repo (`controlRepoWorkflowAllowlisted`'s doc): a
 *     `'written'` outcome whose files aren't allowlisted for commit exists
 *     only in the ephemeral `controlDir` checkout, which dies with the
 *     process — publishing a secret to a repo whose router workflow was
 *     never actually pushed would orphan it on a repo the router job never
 *     evaluates.
 *
 * Pure — no I/O, just reads the already-computed outcome.
 */
export function controlRepoCarriesRouter(outcome: ControlRepoInitOutcome | { readonly status: 'skipped' }): boolean {
  return outcome.status === 'written' && outcome.workflowAndConfigAllowlisted;
}

/**
 * The publish target set for anything the router job itself needs (today:
 * all six routing secrets — `apply-fleet.ts`'s call site, feeding
 * `apply-routing-secrets.ts::publishRoutingSecrets`; groundnuty/macf#1074
 * generalized the ONE caller of this function from two secrets to six,
 * reusing this SAME target-set derivation rather than building a second
 * one) — every agent repo CONFIRMED to exist this run, plus the control
 * repo IF (and only if) {@link controlRepoCarriesRouter}. Pure — no I/O,
 * just combines two already-computed facts.
 *
 * groundnuty/macf#1071 — this IS the fix's decisive derivation: the OLD
 * code passed the confirmed-agent-repo list alone to
 * `publishRoutingClientSecrets` (`apply-routing-client.ts`, since retired
 * by #1074 — see `apply-routing-secrets.ts`), an implicit "agent repos
 * only" assumption. That assumption is exactly what let the control repo —
 * a NEW router-carrying repo added by #1057/#1070 — stay outside every
 * per-repo publish loop no matter how many times `apply` re-ran: nothing
 * was hand-maintaining an "also target the control repo" case, because
 * nothing derived the target set FROM router-carrying-ness in the first
 * place.
 */
export function deriveRouterCarryingRepos(
  confirmedAgentRepos: readonly string[],
  controlRepo: { readonly repo: string },
  controlRepoInit: ControlRepoInitOutcome | { readonly status: 'skipped' },
): readonly string[] {
  return controlRepoCarriesRouter(controlRepoInit) ? [...confirmedAgentRepos, controlRepo.repo] : confirmedAgentRepos;
}

/**
 * Run `repoInit()` against the control repo's ALREADY-CLONED checkout
 * (`controlDir` — `control-repo.ts::provisionControlRepo`'s `localDir`),
 * requesting a label for EVERY declared fleet agent. Writes files into
 * `controlDir`'s working tree only — commit/push is the caller's job (see
 * this module's doc). NEVER throws — every failure resolves to `status:
 * 'failed'`, mirroring `apply-repo-init.ts::applyRepoInitForAgent`'s own
 * contract.
 */
export async function applyControlRepoInit(
  controlDir: string,
  manifest: FleetManifest,
  deps?: ControlRepoInitDeps,
  opts?: ControlRepoInitOptions,
): Promise<ControlRepoInitOutcome> {
  const repo = controlRepoFullName(manifest);
  const agents = manifest.agents.map((a) => a.role);
  const runRepoInit = deps?.repoInit ?? realRepoInit;
  try {
    const registryOpts = repoInitRegistryOptions(manifest.owner.registry);
    const result = await runRepoInit(controlDir, {
      repo,
      // groundnuty/macf#1072 — see `ControlRepoInitOptions`'s doc.
      actionsVersion: opts?.actionsVersion ?? manifest.versions?.actions ?? DEFAULT_ACTIONS_VERSION,
      // ALL declared agents, comma-joined — `repoInit`'s own `agents` option
      // shape (`commands/repo-init.ts`: `opts.agents.split(',')`). This is
      // the single line that makes the control repo carry every agent's
      // label instead of one.
      agents: agents.join(','),
      force: opts?.force ?? false,
      project: manifest.metadata.name,
      ...registryOpts,
    });
    return {
      repo,
      agents,
      status: 'written',
      labels: result.labels,
      workflowAndConfigAllowlisted: controlRepoWorkflowAllowlisted(),
    };
  } catch (err) {
    return { repo, agents, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
