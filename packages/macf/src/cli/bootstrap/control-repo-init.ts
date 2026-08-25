/**
 * `macf bootstrap control-repo init` — the scoped migration verb over
 * `provisionControlRepo` (`control-repo.ts`, step 0 of `bootstrap apply`).
 * groundnuty/macf#878.
 *
 * **Why this verb exists, not just `bootstrap apply`.** `provisionControlRepo`
 * is reachable ONLY through `applyFleet`'s full run today (`apply-fleet.ts`).
 * `applyFleet`'s per-agent `confirmBeforeCreateGuard` (`apply-agent.ts`)
 * unconditionally authorizes `create` for any role with NO `fleet.lock`
 * entry — which is EVERY role on a fleet that predates the control-plane-repo
 * model (a real GitHub App already exists for that role; there was simply
 * never a lock file recording it). The groundnuty/macf#967 App-name-collision
 * pre-flight now refuses that case loudly instead of attempting a silent
 * duplicate — but a refusal per role is still the wrong tool for "give this
 * fleet a control-plane repo": it means the operator has to run the FULL
 * `bootstrap apply` (browser-gate machinery, router-App/routing-secrets/
 * deploy phases and all) against a fleet this verb has no business touching,
 * just to reach step 0. This command runs ONLY step 0 — create-or-reuse the
 * control repo, commit `fleet.yaml` — and stops. It shares NO code path with
 * `applyFleet`'s per-agent loop; its dependency graph never reaches an
 * agent's App, install, repo, or the vault.
 *
 * This module holds the real-deps bundle + `--json`/text rendering only.
 * `provisionControlRepo` itself is untouched and does the actual ownership
 * classification + create/reuse/archived/foreign decision — this module only
 * formats what that function already decided. See `commands/bootstrap-
 * control-repo-init.ts` for the CLI wiring that calls both.
 *
 * ## What this verb does NOT do (read before invoking against a live fleet)
 *
 *  - Never touches an agent's App, install, repo, or `fleet.lock` — the
 *    per-agent identity plane is exactly as `bootstrap apply`/`bootstrap
 *    plan` already observe/reconcile it, before AND after this verb runs.
 *  - Never touches `secrets/vault.age`. Moving + re-encrypting an existing
 *    fleet's vault to a new recipients list is an operator-performed,
 *    decrypt-capable step this tool deliberately never automates — a
 *    `created`/`reused` result from this command says NOTHING about whether
 *    the vault has moved into the control repo yet.
 *  - Never seeds `fleet.lock` from live-observed state. A control repo this
 *    verb just created still makes every `bootstrap plan` role render
 *    `create, LOW CONFIDENCE` until a future lock-seeding/adoption increment
 *    lands — this verb closes the repo-custody gap only, never the
 *    plan-honesty gap.
 *  - Never un-archives a control repo silently. An `ours-archived` result
 *    (this fleet's own control repo, but archived) is reported as a
 *    refusal, same as `foreign` — revival is a deliberate, confirmed act
 *    this command does not perform (no `--confirm-unarchive` flag exists on
 *    this verb; `opts?.confirmUnarchive` is left `undefined`, the safe
 *    default `provisionControlRepo` already documents).
 *
 * ## Idempotence
 *
 * Re-running this command against an already-migrated fleet is a pure no-op
 * on GitHub — `provisionControlRepo`'s `ours` branch clones the existing
 * checkout but never re-creates the repo or re-commits `fleet.yaml` (see
 * that function's own test suite, `control-repo.test.ts`). This module's
 * `mutated` field surfaces that distinction explicitly in `--json` output
 * so a caller scripting repeated runs never mistakes "ran again cleanly" for
 * "wrote something new."
 */
import type { ControlRepoDeps, ControlRepoOutcome } from './control-repo.js';
import { checkControlRepoMeta, realControlRepoCommitAndPush, realReadControlManifestFile } from './control-repo.js';
import { realCreateRepo } from './repo-create.js';
import { realUnarchiveRepo } from './repo-archive.js';
import { realCloneRepo } from './apply-repo-init.js';

/**
 * The real `<fleet>-control` provisioning primitives for the STANDALONE
 * migration verb — the SAME functions `bootstrap apply`'s own
 * `REAL_CONTROL_REPO_DEPS` wires (`commands/bootstrap-apply.ts`), assembled
 * fresh here rather than imported from that file so this verb's dependency
 * graph never reaches into `bootstrap apply`'s per-agent/router-App/deploy
 * machinery — see this module's doc.
 */
export const REAL_CONTROL_REPO_INIT_DEPS: ControlRepoDeps = {
  checkMeta: checkControlRepoMeta,
  readManifestFile: realReadControlManifestFile,
  createRepo: realCreateRepo,
  unarchiveRepo: realUnarchiveRepo,
  cloneRepo: realCloneRepo,
  commitAndPush: realControlRepoCommitAndPush,
};

export const CONTROL_REPO_INIT_JSON_SCHEMA_VERSION = 1;

export interface ControlRepoInitJson {
  readonly schema_version: number;
  readonly fleet: string;
  readonly repo: string;
  readonly status: ControlRepoOutcome['status'];
  /** Whether THIS run wrote anything new to GitHub (repo create + first commit, or an un-archive). `false` for every other status, including a successful `reused`. */
  readonly mutated: boolean;
  readonly message: string;
}

/**
 * `created`/`revived` are the only statuses that write something NEW to
 * GitHub this run — `reused` clones an existing checkout but recommits
 * nothing (`provisionControlRepo`'s own doc + test suite).
 */
function controlRepoInitMutated(status: ControlRepoOutcome['status']): boolean {
  return status === 'created' || status === 'revived';
}

/**
 * 0 for `created`/`reused`/`revived` (the run did what it was asked, whether
 * or not anything changed on GitHub); 1 for `archived`/`foreign`/`failed` —
 * a refusal or an honest-unknown existence read, NEVER silently treated as
 * success. This is the honest-unknown floor applied at the exit-code
 * boundary: a fleet whose control-repo layout cannot be determined must
 * fail the run, not report a false "already migrated"/"created".
 */
export function controlRepoInitExitCode(outcome: ControlRepoOutcome): number {
  return outcome.status === 'created' || outcome.status === 'reused' || outcome.status === 'revived' ? 0 : 1;
}

function controlRepoInitMessage(outcome: ControlRepoOutcome, fleetName: string): string {
  switch (outcome.status) {
    case 'created':
      return (
        `Created ${outcome.repo} and committed fleet.yaml as its first act — fleet "${fleetName}" had no ` +
        'control-plane repo before this run. It was NOT previously migrated to the per-fleet control-plane ' +
        'repo layout. The vault and fleet.lock are untouched by this command — see this run\'s "what this ' +
        'verb does NOT do" note.'
      );
    case 'reused':
      return (
        `${outcome.repo} already exists and its committed fleet.yaml matches this manifest — already migrated. ` +
        'No changes made.'
      );
    case 'revived':
      return (
        `${outcome.repo} was archived and has just been revived (un-archived), then reused as an existing ` +
        'control repo. No content changes made — its committed fleet.yaml already matched this manifest.'
      );
    case 'archived':
      return (
        `${outcome.repo} is this fleet's OWN control-plane repo, but it is currently archived. Revival requires ` +
        `an explicit confirmation this command does not perform. No changes made. ${outcome.reason}`
      );
    case 'foreign':
      return (
        `${outcome.repo} already exists but is not this fleet's control-plane repo. Refusing to touch it. ` +
        `No changes made. ${outcome.reason}`
      );
    case 'failed':
      return `Could not provision the control-plane repo for fleet "${fleetName}" (${outcome.repo}): ${outcome.reason}`;
  }
}

export function controlRepoInitOutcomeToJson(outcome: ControlRepoOutcome, fleetName: string): ControlRepoInitJson {
  return {
    schema_version: CONTROL_REPO_INIT_JSON_SCHEMA_VERSION,
    fleet: fleetName,
    repo: outcome.repo,
    status: outcome.status,
    mutated: controlRepoInitMutated(outcome.status),
    message: controlRepoInitMessage(outcome, fleetName),
  };
}

export function formatControlRepoInitText(outcome: ControlRepoOutcome, fleetName: string): string {
  return controlRepoInitMessage(outcome, fleetName);
}
