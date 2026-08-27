/**
 * DR-043 Amendment P3 — execution wiring for `verb: 'delete'` plan items
 * (groundnuty/macf#1272, operator ruling 2026-08-27). Verbatim: *"no it
 * cannot remove repositories, this is too big and irreversible blast
 * radius, but everything else is ok... naturally part of the life cycle."*
 *
 * This module is scoped to EXACTLY the two `PlanItemKind` values `plan.ts`'s
 * row 4 ever assigns `verb: 'delete'` — `'routing'` (the `MACF_TRUSTED_ACTORS`
 * repo variable) and `'secret_fingerprint'` (a repo secret). `'app'`/`'repo'`
 * NEVER emit `'delete'` — they emit `'orphan'`, which this module never
 * reads or actions, matching `row4-apply-untouched-source-shape.test.ts`'s
 * existing static guard: nothing here even needs the string `'orphan'`,
 * because filtering a plan's items on `verb === 'delete'` already excludes
 * every orphan item by construction.
 *
 * **`'secret_fingerprint'` is NOT executable this increment.** Its only
 * producer (`computePlan`'s `extraRoles` loop in `plan.ts`) fires for a role
 * observed in `fleet.lock` but no longer declared in `fleet.yaml` — and
 * `FleetLockAgentSchema` carries no `repo` field, so the repo that secret
 * lives on is unrecoverable from any data this module (or `bootstrap-apply.ts`)
 * can read; `githubRegistryObserver` (`observer.ts`) also only ever populates
 * `observed.agents` from `manifest.agents`, never for a role the manifest no
 * longer declares. Guessing a repo (by naming convention or otherwise) would
 * be exactly the "destructive call against a target the operator never named"
 * blast radius the ruling excluded for repos/Apps — so this module refuses
 * rather than guesses, and reports the item as skipped with an honest
 * reason. Wiring this properly needs a role→repo record this codebase does
 * not keep today; that is a follow-up, not a guess here.
 *
 * `'routing'` IS executable: `routingDroppedItem` (`plan.ts`) only ever fires
 * when `routing.runner` is undeclared but the AGENTS themselves are still
 * declared — so `manifest.agents[0]?.repo` (the SAME representative-repo
 * derivation `computePlan`'s own call site uses) is a real, still-declared
 * repo, not a guess.
 */
import type { FleetManifest } from './fleet-manifest.js';
import type { PlanItem } from './plan.js';
import { realDeleteVariable, type DeleteVariableResult } from './variable-write.js';
import { TRUSTED_ACTORS_VAR } from './apply-routing.js';

/**
 * One `delete`-verb plan item, resolved into either an executable
 * repo-variable delete or an honest reason it cannot be attempted this run.
 * Pure — no I/O, so the SAME array can be built once and reused for both the
 * pre-approval enumeration and the post-approval execution, which is the
 * load-bearing property: the approval text and what actually gets deleted
 * must never be able to name different things (groundnuty/macf#1272's own
 * blocker, generalized).
 */
export type DeletionAction =
  | { readonly item: PlanItem; readonly executable: true; readonly repo: string; readonly variableName: string }
  | { readonly item: PlanItem; readonly executable: false; readonly reason: string };

const SECRET_FINGERPRINT_SKIP_REASON =
  'the repo this secret lives on is not recorded anywhere apply can read (fleet.lock does not carry a role→repo ' +
  'mapping for a role no longer declared) — apply will not guess a target; remove it by hand if it should go away.';

/**
 * Pure. `manifest.agents[0]?.repo` mirrors `plan.ts`'s `computePlan` call
 * site for `routingDroppedItem` EXACTLY (`representativeRepo = manifest.agents[0]?.repo`)
 * — the approval-text enumeration and this execution decision must never
 * name different repos for the same item.
 */
export function planDeletionActions(manifest: FleetManifest, deleteItems: readonly PlanItem[]): readonly DeletionAction[] {
  return deleteItems.map((item): DeletionAction => {
    if (item.kind === 'routing') {
      const repo = manifest.agents[0]?.repo;
      if (repo === undefined) {
        return {
          item,
          executable: false,
          reason: 'no agent repos are declared in this manifest — cannot resolve which repo carries MACF_TRUSTED_ACTORS.',
        };
      }
      return { item, executable: true, repo, variableName: TRUSTED_ACTORS_VAR };
    }
    // Every other delete-eligible kind (today: only 'secret_fingerprint' —
    // see this module's doc) is not executable this increment.
    return { item, executable: false, reason: SECRET_FINGERPRINT_SKIP_REASON };
  });
}

/** One executed (or skipped) delete outcome — never a credential value. */
export interface DeletionOutcome {
  readonly kind: string;
  readonly target: string;
  readonly status: 'deleted' | 'already-absent' | 'unknown' | 'skipped';
  readonly reason?: string;
}

export interface ApplyDeleteDeps {
  readonly deleteRepoVariable: (repo: string, name: string) => Promise<DeleteVariableResult>;
}

function classifyVariableDelete(result: DeleteVariableResult): DeletionOutcome['status'] {
  switch (result) {
    case 'deregistered':
      return 'deleted';
    case 'absent':
      return 'already-absent';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Executes every EXECUTABLE action; reports every non-executable one as
 * `'skipped'` with its reason — never silently dropped. Never throws:
 * `deps.deleteRepoVariable` (real default: {@link realDeleteRepoVariable}, a
 * thin wrapper over `variable-write.ts::realDeleteVariable`) already
 * classifies every failure mode (auth/network/rate-limit/malformed) as
 * `'unknown'` rather than throwing — macf#1206's honest-unknown floor,
 * inherited here rather than re-implemented.
 */
export async function runDeletionPhase(actions: readonly DeletionAction[], deps: ApplyDeleteDeps): Promise<readonly DeletionOutcome[]> {
  const out: DeletionOutcome[] = [];
  for (const action of actions) {
    if (!action.executable) {
      out.push({ kind: action.item.kind, target: action.item.target, status: 'skipped', reason: action.reason });
      continue;
    }
    const result = await deps.deleteRepoVariable(action.repo, action.variableName);
    out.push({ kind: action.item.kind, target: action.item.target, status: classifyVariableDelete(result) });
  }
  return out;
}

/** Real repo-scope delete — `variable-write.ts::realDeleteVariable` against `repos/<owner>/<repo>`, mirroring `apply-ca.ts::realCreateRepoVariable`'s create-side wrapper shape. */
export function realDeleteRepoVariable(repo: string, name: string): Promise<DeleteVariableResult> {
  return realDeleteVariable(`repos/${repo}`, name);
}

export const REAL_APPLY_DELETE_DEPS: ApplyDeleteDeps = { deleteRepoVariable: realDeleteRepoVariable };
