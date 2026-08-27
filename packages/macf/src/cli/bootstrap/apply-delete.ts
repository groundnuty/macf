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
 * **`'secret_fingerprint'` STAYS non-executable — groundnuty/macf#1296
 * resolves the REPO, not the whole item, and this is a deliberate, flagged
 * divergence from that issue's literal "resolves its target" phrasing (its
 * own close condition names only the repo-orphan URL — see #1281 — never a
 * `secret_fingerprint` state change, so this reading is consistent with the
 * issue's own gate, not merely a narrower option).** `fleet.lock.agents[].repo`
 * (once populated, `#1296`) DOES resolve WHICH REPO a dropped role's secret
 * lived on — that repo is now threaded through and NAMED in the skip reason
 * below, replacing the old "not recorded anywhere apply can read" text. But
 * naming the repo is not the same as knowing WHAT TO DELETE: the fingerprint
 * this item is about (`app_private_key` / `client_secret` / `webhook_secret`)
 * is sourced ENTIRELY from `fleet.lock` (`observer.ts`'s `fingerprints:
 * lockEntry?.fingerprints ?? {}` — verified for both a declared and an extra
 * role) and is never written to the registry as a variable anywhere in this
 * codebase (`secretFingerprintItem`'s own comment: live-registry drift-
 * detection is a Slice-2 concern, not exercised yet) — so there is no
 * `variableName` this module could resolve without inventing one. Inventing
 * a name and calling `deleteRepoVariable` against it would be exactly the
 * "destructive call against a target the operator never named" blast radius
 * the ruling excluded for repos/Apps, just at a smaller scale — so this
 * module still refuses to execute, honestly, now WITH the repo named when
 * `#1296` makes it known. Wiring true execution needs a registry-variable
 * naming convention this codebase does not have today; that is a follow-up,
 * not a guess here.
 *
 * `'routing'` IS executable: `routingDroppedItem` (`plan.ts`) only ever fires
 * when `routing.runner` is undeclared but the AGENTS themselves are still
 * declared — so `manifest.agents[0]?.repo` (the SAME representative-repo
 * derivation `computePlan`'s own call site uses) is a real, still-declared
 * repo, not a guess.
 */
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
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

const SECRET_FINGERPRINT_SKIP_REASON_NO_REPO =
  'the repo this secret lives on is not recorded anywhere apply can read (an older fleet.lock, or a role whose ' +
  'entry never carried a repo) — apply will not guess a target; remove it by hand if it should go away.';

function secretFingerprintSkipReason(repo: string | undefined): string {
  if (repo === undefined) return SECRET_FINGERPRINT_SKIP_REASON_NO_REPO;
  // groundnuty/macf#1296 — the repo is now KNOWN (read from fleet.lock,
  // never guessed), but there is still no registry-variable name to target
  // — see this module's own doc for why that is a distinct, unresolved gap.
  return (
    `this secret lived in "${repo}" (from fleet.lock), but apply has no registry-variable name to target it by ` +
    '— fingerprints are lock-only bookkeeping, never written to the registry as a variable in this codebase ' +
    '(Slice-2 drift-detection is not implemented yet) — apply will not guess a target; remove it by hand if it should go away.'
  );
}

/**
 * `agent:<role>:secret_fingerprint:<name>` → `<role>`, the SAME target shape
 * `plan.ts`'s row-4 `extraRoles` loop builds. Pure string parse — no
 * assumption about `name`'s shape beyond "no colon" (secret names are
 * `app_private_key`/`client_secret`/`webhook_secret` today, none of which
 * contain one).
 */
function roleFromSecretFingerprintTarget(target: string): string | undefined {
  const match = /^agent:([^:]+):secret_fingerprint:/.exec(target);
  return match?.[1];
}

/**
 * Pure. `manifest.agents[0]?.repo` mirrors `plan.ts`'s `computePlan` call
 * site for `routingDroppedItem` EXACTLY (`representativeRepo = manifest.agents[0]?.repo`)
 * — the approval-text enumeration and this execution decision must never
 * name different repos for the same item.
 *
 * `lock` (groundnuty/macf#1296) — the SAME prior/observed `fleet.lock` the
 * rest of `apply` reads (`observed.lock` at the `bootstrap-apply.ts` call
 * site) — `undefined`/`null` degrades to the pre-#1296 "repo unknown"
 * wording exactly, never a crash on a caller that hasn't been updated.
 */
export function planDeletionActions(manifest: FleetManifest, deleteItems: readonly PlanItem[], lock?: FleetLock | null): readonly DeletionAction[] {
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
    // see this module's doc) is not executable this increment, but the repo
    // it lived on is now NAMED when the lock records it (#1296).
    const role = roleFromSecretFingerprintTarget(item.target);
    const lockedRepo = role !== undefined ? lock?.agents.find((a) => a.role === role)?.repo : undefined;
    return { item, executable: false, reason: secretFingerprintSkipReason(lockedRepo) };
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
