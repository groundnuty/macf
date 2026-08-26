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
 * **Token sourcing (groundnuty/macf#1221 — the "future increment" the
 * paragraph below promised).** This step's `tokenSource` is OPTIONAL —
 * `apply-fleet.ts` supplies one when {@link resolveControlRepoLabelTokenSource}
 * can find a legitimate credential, and omits it otherwise (the pre-#1221
 * degrade below still applies verbatim in that case). No NEW grant is
 * minted here: at Step 0.5 (control-repo-init runs BEFORE the per-agent
 * loop — no agent identity is created THIS run yet) the only legitimate
 * source is an ALREADY-EXISTING agent's vault-stored credential — the SAME
 * `resolveKeyPath(role, priorAppId)` primitive `apply-fleet.ts`'s
 * `resolveRunnerOpsVaultPem` already uses for the runner-ops App's reused
 * case, applied here across every DECLARED agent role instead of the single
 * runner-ops role (this module's doc, "Why the control repo, not peer-repo
 * access" — ANY declared agent's App install already reaches the control
 * repo). `undefined` (no `--vault`/`--identity-key` this run, or a
 * genuinely first-ever provision with no prior lock entry for any role) is
 * an honest "nothing to try," not an error — see
 * {@link resolveControlRepoLabelTokenSource}'s own doc.
 *
 * **What changes when a `tokenSource` IS supplied.** `repoInit()`'s
 * `generateToken()` now has a real credential to mint from, so `labels`
 * should ordinarily land `'ok'`. When it does NOT — the mint itself throws,
 * or some individual label POST fails — that is no longer the benign
 * "nothing was ever attempted" gap: a real credential was available and the
 * attempt still didn't fully succeed, which needs operator attention.
 * {@link controlRepoLabelsGoodEnough} (mirroring
 * `apply-repo-init.ts::labelsAreGoodEnough` exactly) captures this
 * distinction as `ControlRepoInitOutcome`'s `labelsGoodEnough` field;
 * `bootstrap-apply.ts::applyExitCode` reads it to report the fleet
 * incomplete WITHOUT aborting any other leg of the run (per
 * groundnuty/macf#1210's rule: a missing/failed input gates only its
 * dependents — here, whether routing can be confirmed usable — never the
 * whole run).
 *
 * **The sharper shape of the (now-narrowed) gap.** Every OTHER control-repo
 * operation this run performs — `gh repo create`, `gh api repos/…`, the
 * clone, the final push — runs on the OPERATOR's own `gh` auth
 * (`control-repo.ts`'s I/O leaves all shell out to `gh`), which already has
 * admin on a repo the operator owns. `createLabel` (`commands/repo-init.ts`)
 * is the ONE operation in this whole step that goes through a raw `fetch` +
 * Bearer App-installation token instead. This is deliberately NOT "fixed" by
 * reaching for the operator's own `gh` auth here too (e.g. `gh auth token`)
 * — that would be a NEW credential-resolution mechanism for this ONE call
 * site, diverging from `commands/repo-init.ts::repoInit()`'s single existing
 * `generateToken(tokenSource)` path that every other caller (agent repo-init,
 * a plain `macf repo-init` run) already goes through, and it would make
 * `repoInit()`'s label-creation identity depend on ambient `gh` login state
 * — a footgun for its non-bootstrap callers this issue does not license
 * introducing. The `TokenSource` plumbing `commands/repo-init.ts` already
 * has (macf#920) is the existing mechanism this fix threads further, not a
 * new one.
 */
import { existsSync } from 'node:fs';
import type { TokenSource } from '@groundnuty/macf-core';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
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
  /**
   * groundnuty/macf#1221 — threaded straight into `repoInit`'s own
   * `tokenSource` option (macf#920's existing plumbing), exactly the way
   * `apply-repo-init.ts::applyRepoInitForAgent` already does for the
   * per-agent path. Callers resolve this via
   * {@link resolveControlRepoLabelTokenSource} — never invented here.
   * Omitted (the default) preserves the exact pre-#1221 degrade:
   * `repoInit()`'s own `generateToken()` falls through to ambient env vars
   * and, finding none, reports `labels: {status: 'skipped'}`.
   */
  readonly tokenSource?: TokenSource;
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
      /**
       * groundnuty/macf#1221 — mirrors `apply-repo-init.ts`'s
       * `labelsAreGoodEnough` result exactly (see
       * {@link controlRepoLabelsGoodEnough}): `true` when `labels.status`
       * is `'ok'`, OR when no `tokenSource` was supplied this call (the
       * honest "nothing was ever attempted" gap — unchanged pre-#1221
       * behavior). `false` ONLY when a legitimate `tokenSource` WAS
       * supplied and labels still did not fully land — a genuine failure
       * that needs operator attention (`bootstrap-apply.ts::applyExitCode`
       * reads this field), distinct from the credential-unavailable case.
       */
      readonly labelsGoodEnough: boolean;
    }
  | {
      readonly repo: string;
      readonly agents: readonly string[];
      readonly status: 'failed';
      readonly reason: string;
    };

/**
 * Whether the control-repo label outcome is good enough to NOT need
 * operator attention — groundnuty/macf#1221, mirroring
 * `apply-repo-init.ts::labelsAreGoodEnough` exactly (same two-argument
 * shape, same rule): `'ok'` always is; a non-`'ok'` outcome is only a
 * genuine problem when `tokenSourceGiven` — a caller that supplied a
 * legitimate credential and still got a non-`'ok'` result hit a real
 * failure (API rejection, revoked key, network) that needs surfacing,
 * never silently absorbed into the same "labels will retry next run"
 * framing the credential-less case uses.
 */
function controlRepoLabelsGoodEnough(labels: LabelsOutcome, tokenSourceGiven: boolean): boolean {
  if (labels.status === 'ok') return true;
  return !tokenSourceGiven;
}

/**
 * Resolve a legitimate `TokenSource` for the control-repo label-creation
 * mint, from an ALREADY-EXISTING agent's vault-stored credential — never a
 * newly-minted one (none exist yet at Step 0.5, before `apply-fleet.ts`'s
 * per-agent loop runs). Mirrors `apply-fleet.ts::resolveRunnerOpsVaultPem`'s
 * exact mechanism (`resolveKeyPath(role, priorAppId)`, wired only under
 * `--vault`/`--identity-key`) applied across every DECLARED agent role
 * instead of the single runner-ops role — legitimate because ANY declared
 * agent's App install already reaches the control repo (this module's doc,
 * "Why the control repo, not peer-repo access"). Returns the FIRST role
 * that resolves, in `manifest.agents` declaration order, so the result is
 * deterministic for a given manifest + prior lock.
 *
 * `priorLock` is the run's ALREADY-READ prior lock (never a fresh read
 * here — the #1000 golden path: one reader per fact). A role absent from
 * it (a genuinely first-ever provision — no agent has ever been created for
 * this fleet) or `resolveKeyPath` returning `undefined` for every role (no
 * `--vault`/`--identity-key` this run, or the vault doesn't hold any
 * declared role's key) both resolve to `undefined` — an honest "nothing to
 * try," not a failure.
 *
 * **A returned `keyPath` that doesn't exist on disk is not a credential.**
 * The real `resolveKeyPath` implementation `writeFileSync`s the decrypted
 * PEM and only THEN returns its path — a genuine resolution always has a
 * readable file waiting at that path. A path to nothing (a test double
 * that fakes a non-empty return without ever writing content, or any other
 * caller that violates that contract) must not be treated as usable — it
 * would reach `generateToken()` and attempt a REAL `gh token generate`
 * subprocess against a key that was never actually written, producing a
 * confusing failure instead of the honest "nothing to try" this function
 * returns for every other absent-credential shape. `exists` defaults to
 * the real `existsSync`; tests inject a fake so this stays a plain,
 * synchronous, no-network check — same convention as
 * `bootstrap-apply.ts::findAvailableRecoveryArtifacts`'s own injectable
 * `exists` parameter.
 */
export function resolveControlRepoLabelTokenSource(
  manifest: FleetManifest,
  priorLock: FleetLock | null,
  resolveKeyPath: ((role: string, priorAppId: string) => string | undefined) | undefined,
  exists: (path: string) => boolean = existsSync,
): TokenSource | undefined {
  if (priorLock === null || resolveKeyPath === undefined) return undefined;
  for (const agent of manifest.agents) {
    const prior = priorLock.agents.find((a) => a.role === agent.role);
    if (prior === undefined) continue;
    const keyPath = resolveKeyPath(agent.role, prior.app_id);
    if (keyPath === undefined) continue;
    if (!exists(keyPath)) continue;
    return { appId: prior.app_id, installId: prior.install_id, keyPath };
  }
  return undefined;
}

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
      // groundnuty/macf#1221 — threaded straight into `repoInit`'s own
      // `tokenSource` option (macf#920's plumbing); omitted entirely when
      // the caller resolved none, so `generateToken()`'s pre-#1221 fallback
      // chain is unchanged for that case.
      ...(opts?.tokenSource !== undefined ? { tokenSource: opts.tokenSource } : {}),
      ...registryOpts,
    });
    return {
      repo,
      agents,
      status: 'written',
      labels: result.labels,
      workflowAndConfigAllowlisted: controlRepoWorkflowAllowlisted(),
      labelsGoodEnough: controlRepoLabelsGoodEnough(result.labels, opts?.tokenSource !== undefined),
    };
  } catch (err) {
    return { repo, agents, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
