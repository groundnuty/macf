/**
 * Per-agent GitHub App IDENTITY removal — DR-043 Amendment G's `delete-apps`
 * rung, and folded into `destroy` (which removes everything `delete-apps`
 * does plus the repositories — groundnuty/macf#867).
 *
 * **There is no REST path to delete a GitHub App registration — verified
 * 2026-08-13** against the CURRENT GitHub REST docs (WebFetch, not memory —
 * `check-before-propose.md`):
 *
 *   - `https://docs.github.com/en/apps/maintaining-github-apps/deleting-a-github-app`
 *     describes ONLY a web-UI click-path — "In the left sidebar, click
 *     Developer settings. In the left sidebar, click GitHub Apps. Select the
 *     GitHub App you want to delete. In the left sidebar, click Advanced.
 *     Click Delete GitHub App" (typing the App's name to confirm, then "I
 *     understand the consequences, delete this GitHub App"). No API
 *     alternative is offered anywhere on that page. The org-owned variant is
 *     the same click-path under the organization's own Developer settings.
 *   - `https://docs.github.com/en/rest/apps/apps` enumerates every GitHub
 *     Apps REST endpoint; its ONLY `DELETE` is
 *     `DELETE /app/installations/{installation_id}` — "Uninstalls a GitHub
 *     App on a user, organization, or enterprise account." That revokes the
 *     App's access grant on ONE account but does NOT delete the App
 *     registration itself and does NOT free its globally-unique slug — the
 *     entire point Amendment G's `delete-apps` rung exists for ("frees the
 *     globally-unique names", so a squatted name stops blocking
 *     re-provisioning the same manifest). Calling the installation-delete
 *     endpoint here would produce a confusing half-torn-down App (access
 *     revoked but the name still squatting) without achieving what the rung
 *     promises, so this module deliberately does NOT call it.
 *
 * So this module's ENTIRE job for the App-identity rung is: compute the
 * exact per-agent target set (pure, no I/O), OPTIONALLY read whether the
 * predicted slug is still live ({@link checkAppSlugPresence},
 * groundnuty/macf#917 — a READ, never a mutation), then REPORT — never
 * mutate, never claim success beyond "already absent" when a live read
 * actually confirms it. This is Amendment G's "report what could not be
 * done, never exit green" rail at its starkest: for this ONE rung, there is
 * NOTHING this codebase can do besides report and point at the URL, or —
 * now — honestly report that there is nothing left even to point at.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FleetLock, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle, parseFleetLock } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import { getStderr } from './observer.js';

const execFileAsync = promisify(execFile);

/**
 * Cited in every report line so an operator reading `delete-apps`/`destroy`
 * output doesn't have to trust a bare claim — see module doc for the
 * verification this note summarizes.
 */
export const APP_DELETION_HAS_NO_REST_PATH_NOTE =
  'GitHub has no REST endpoint to delete a GitHub App registration (verified against ' +
  'https://docs.github.com/en/apps/maintaining-github-apps/deleting-a-github-app + ' +
  'https://docs.github.com/en/rest/apps/apps — the only DELETE endpoint, ' +
  '/app/installations/{installation_id}, uninstalls but does not free the app slug). ' +
  'Browser-only: Settings → Developer settings → GitHub Apps → (select the App) → ' +
  'Advanced → "Delete GitHub App".';

export interface AppIdentityTarget {
  readonly role: string;
  /**
   * The App's BEST-KNOWN slug — {@link deriveAppHandle}'s output, a
   * PREDICTION (GitHub may have appended a disambiguating suffix on a
   * global name collision at creation time), never a GitHub-confirmed
   * value — same caveat `apply-agent.ts`'s identical "best-known slug for a
   * pre-existing App is the derived handle" situation already documents.
   * This module has no vault-read access to a confirmed slug (that would
   * mean decrypting `vault.age`, entirely out of scope for a report-only
   * step), so the predicted handle is the best available; the report line
   * says so via {@link APP_DELETION_HAS_NO_REST_PATH_NOTE}'s neighboring
   * caveat in the render layer.
   */
  readonly appSlug: string;
  readonly settingsUrl: string;
  /**
   * The AUTHORITATIVE App ID, when known — from `fleet.lock`'s recorded
   * `app_id` for this role, via {@link enrichAppIdentityTargetsWithLock}.
   * `undefined` when the lock is absent/unreadable/has no entry for this
   * role (a fleet that was never actually provisioned, or a first-ever
   * teardown attempt with no lock read wired in — see that function's
   * doc). When present, an operator can positively identify the App in
   * GitHub's Settings list even if `appSlug` (a PREDICTION) doesn't match
   * the real, GitHub-assigned slug.
   */
  readonly appId?: string;
  /**
   * `true` when this target was discovered ONLY via `fleet.lock` — its
   * `role` does not appear anywhere in `manifest.agents[]` (groundnuty/
   * macf#953). `fleet.lock` records what `apply` actually CREATED;
   * `manifest.agents[]` records only what `fleet.yaml` DECLARED, and at
   * least one identity — the runner-ops App (`RUNNER_OPS_ROLE`,
   * `apply-runner-ops.ts`) — is deliberately created OUTSIDE the manifest.
   * Undefined/`false` for every ordinary manifest-declared agent target;
   * `true` marks a target `computeAppIdentityTargets` could never have
   * produced on its own, surfaced by {@link enrichAppIdentityTargetsWithLock}'s
   * union step. The render layer (`fleet-teardown-destructive.ts`) uses this
   * to flag the target distinctly (a role `fleet.yaml` never declared is, by
   * construction, invisible to an operator skimming the manifest) — per
   * #953's "report it first, or mark it distinctly," these targets are ALSO
   * ordered first in the array {@link enrichAppIdentityTargetsWithLock}
   * returns.
   */
  readonly extraFromLock?: boolean;
}

/**
 * `https://github.com/settings/apps/<slug>/advanced` (personal-account-owned
 * App) or `https://github.com/organizations/<org>/settings/apps/<slug>/advanced`
 * (org-owned) — the Advanced tab the deletion click-path ends on (module
 * doc).
 *
 * **Inferred by symmetry with `manifest-flow-server.ts`'s
 * `manifestFormAction`** (the SAME user-vs-org branch, doc-confirmed for the
 * App-CREATION form's POST target), NOT itself doc-confirmed as a
 * direct-link URL — the GitHub docs describe only the click-path, never a
 * URL, for the deletion page. Flagged here the same way
 * `identity-confirm.ts`'s `appInstallationUrl` doc flags its own inferred
 * parts, rather than asserted as settled fact (`verify-before-claim.md`).
 */
export function appSettingsAdvancedUrl(owner: { readonly account: string; readonly type: 'user' | 'org' }, appSlug: string): string {
  return owner.type === 'org'
    ? `https://github.com/organizations/${owner.account}/settings/apps/${appSlug}/advanced`
    : `https://github.com/settings/apps/${appSlug}/advanced`;
}

/** One target per manifest agent, in manifest order — pure, no I/O. */
export function computeAppIdentityTargets(manifest: FleetManifest): readonly AppIdentityTarget[] {
  return manifest.agents.map((agent) => {
    const appSlug = deriveAppHandle(manifest.metadata.name, agent.role);
    return { role: agent.role, appSlug, settingsUrl: appSettingsAdvancedUrl(manifest.owner, appSlug) };
  });
}

/**
 * UNION + enrich derived App-identity targets against `fleet.lock` — two
 * jobs in one pass (groundnuty/macf#953):
 *
 *   1. **Enrich** (original behavior) — attach the AUTHORITATIVE `app_id`
 *      from `fleet.lock` onto any target whose `role` the lock also
 *      recorded. See {@link AppIdentityTarget.appId}'s doc for why this
 *      matters (the derived slug is a prediction; `fleet.lock`'s `app_id`
 *      is the authority for WHICH App actually exists).
 *   2. **Union** (the #953 fix) — `fleet.lock` is the record of what `apply`
 *      actually CREATED; `manifest.agents[]` (what `targets` was derived
 *      from, one layer up in `computeAppIdentityTargets`) is only what
 *      `fleet.yaml` DECLARED. A role `apply` created OUTSIDE the manifest
 *      — the runner-ops App is the concrete case (`RUNNER_OPS_ROLE`,
 *      `apply-runner-ops.ts`, deliberately never in `agents[]`) — would
 *      otherwise NEVER appear in `targets` at all, and `delete-apps`/
 *      `destroy` would silently omit it from the manual-deletion report:
 *      exactly the gap #953 reported (the WIDEST-privilege identity in the
 *      fleet, `administration:write`, went unreported on every teardown).
 *      Fixed GENERALLY, not by special-casing that one role name — this
 *      module never imports `RUNNER_OPS_ROLE`; ANY lock role absent from
 *      `targets` is unioned in, so the next non-agent identity a future App
 *      gains is covered by this same code path, not a fresh special case.
 *
 * Lock-only targets are marked {@link AppIdentityTarget.extraFromLock} and
 * PREPENDED — ordered BEFORE the manifest-derived targets — per #953's
 * "report it first, or mark it distinctly" (that field's own doc explains
 * why). The render layer (`fleet-teardown-destructive.ts`) adds the second
 * half — a visible `⚠` marker on the rendered line.
 *
 * Best-effort, additive-only, same posture as before this fix: `lockText`
 * absent/unparseable degrades to `targets` UNCHANGED (no union, no
 * enrichment) — NEVER throws, NEVER blocks a teardown run. This mirrors
 * every other best-effort read in this package (`realReadControlManifestFile`,
 * `checkControlRepoMeta`) — a failure to read auxiliary state is a reason to
 * report less, never a reason to refuse. A degraded (unreadable) lock means
 * this function can only report what the manifest already told it — it
 * CANNOT tell the caller "there are no extra identities," only "I don't
 * know." Surfacing THAT distinction honestly is {@link classifyLockReadability}'s
 * job, one layer up in `teardown-destructive.ts` — this function stays pure
 * over its inputs and never itself claims completeness.
 */
export function enrichAppIdentityTargetsWithLock(
  targets: readonly AppIdentityTarget[],
  lockText: string | undefined,
  manifest: FleetManifest,
): readonly AppIdentityTarget[] {
  if (lockText === undefined) return targets;
  let lock: FleetLock;
  try {
    lock = parseFleetLock(lockText);
  } catch {
    return targets;
  }

  const appIdByRole = new Map(lock.agents.map((a) => [a.role, a.app_id]));
  const enriched = targets.map((t) => {
    const appId = appIdByRole.get(t.role);
    return appId === undefined ? t : { ...t, appId };
  });

  const knownRoles = new Set(targets.map((t) => t.role));
  const extraTargets: AppIdentityTarget[] = lock.agents
    .filter((a) => !knownRoles.has(a.role))
    .map((a) => {
      const appSlug = deriveAppHandle(manifest.metadata.name, a.role);
      return {
        role: a.role,
        appSlug,
        settingsUrl: appSettingsAdvancedUrl(manifest.owner, appSlug),
        appId: a.app_id,
        extraFromLock: true,
      };
    });

  return [...extraTargets, ...enriched];
}

/**
 * `'read'` — `lockText` was present AND parsed as a valid `fleet.lock`
 * document. `'unreadable'` — `lockText` was `undefined` (nothing to read:
 * missing file, private-repo, network failure — see
 * `control-repo.ts::realReadControlFleetLockFile`'s doc) OR present but
 * failed schema validation (corrupt/malformed). Both `'unreadable'` causes
 * collapse to one status because from THIS function's caller's perspective
 * they mean the identical thing: the lock's role list cannot be trusted, so
 * {@link enrichAppIdentityTargetsWithLock}'s union step could not run.
 *
 * Exists so `teardown-destructive.ts` can attach an HONEST read-status to
 * its plan (groundnuty/macf#953's honest-unknown floor: "if the lock cannot
 * be read, say so — never infer 'no extra Apps exist' from an unreadable
 * lock") without re-deriving `fleet.lock` parsing logic independently — a
 * `'read'`-vs-`'unreadable'` classification of the EXACT SAME `lockText`
 * {@link enrichAppIdentityTargetsWithLock} was given, so the two can never
 * disagree about whether the lock was trustworthy.
 */
export type LockReadability = 'read' | 'unreadable';

export function classifyLockReadability(lockText: string | undefined): LockReadability {
  if (lockText === undefined) return 'unreadable';
  try {
    parseFleetLock(lockText);
    return 'read';
  } catch {
    return 'unreadable';
  }
}

export interface AppDeletionOutcome {
  readonly role: string;
  readonly appSlug: string;
  readonly settingsUrl: string;
  /** Carried through from {@link AppIdentityTarget.appId} — see that field's doc. */
  readonly appId?: string;
  /** Carried through from {@link AppIdentityTarget.extraFromLock} — see that field's doc (groundnuty/macf#953). */
  readonly extraFromLock?: boolean;
  /**
   * `'already-absent'` — groundnuty/macf#917 — ONLY when `deps.checkAppPresence`
   * was supplied AND returned `'absent'` (a confirmed 404 at the predicted
   * slug; see {@link checkAppSlugPresence}'s doc for the "predicted, not
   * GitHub-confirmed" caveat this status carries into `reason`). Every OTHER
   * case (no check wired, `'present'`, `'unknown'`) stays
   * `'manual-action-required'` — see module doc: this codebase can never
   * honestly report `'deleted'`, but it CAN now honestly report "nothing
   * left to do" once a live read confirms it.
   */
  readonly status: 'manual-action-required' | 'already-absent';
  readonly reason: string;
}

export interface AppDeletionDeps {
  /** Best-effort browser-open, same non-fatal posture as `apply-agent.ts`'s `announceAndOpenGate` — optional so a headless/CI/test caller can omit it entirely. */
  readonly openUrl?: (url: string) => Promise<void>;
  /**
   * Optional live presence check (groundnuty/macf#917) — see
   * {@link checkAppSlugPresence}. Omitted entirely, every target reports
   * `'manual-action-required'` exactly as before this fix (backward
   * compatible, never a new precondition — same additive posture as
   * `readFleetLock` one layer up in `teardown-destructive.ts`).
   */
  readonly checkAppPresence?: (appSlug: string) => Promise<Presence>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort LIVE presence read for an App's PREDICTED slug —
 * groundnuty/macf#917's `delete-apps`/`destroy` idempotency: re-running
 * either rung after the App was ALREADY manually deleted (the operator
 * completed the browser click-path this rung can only ever recommend)
 * should report "already absent," never instruct the browser deletion of
 * something that no longer exists.
 *
 * `GET /apps/{app_slug}` — unlike `identity-confirm.ts`'s
 * `GET /app/installations` — needs NO App-owned JWT; it is queryable with
 * ANY authenticated token (verified against the current GitHub REST docs,
 * `https://docs.github.com/en/rest/apps/apps#get-an-app`, 2026-08-13: "same
 * response schema as Get the authenticated app," 404 when the slug doesn't
 * exist, no App-JWT requirement documented). So this module's existing "no
 * vault-read access to a confirmed slug" limit (module doc) does NOT block
 * this read — the operator's own ambient `gh` auth is sufficient, same as
 * `control-repo.ts::checkControlRepoMeta`'s repo-presence read.
 *
 * **Caveat, carried into the caller's report text.** `appSlug` here is
 * STILL {@link AppIdentityTarget.appSlug}'s PREDICTION, never a GitHub-
 * confirmed real slug — a 404 at the predicted slug means "nothing at THIS
 * exact slug," a strong but not airtight already-absent signal (if GitHub
 * appended a disambiguating suffix at creation, the real App could still be
 * alive under a slug this check never queries — {@link AppIdentityTarget.appSlug}'s
 * own doc names the same limitation). This is why a 404 here degrades to
 * `'absent'`, never silently upgraded to "confirmed deleted" — the same
 * present-detector-honesty posture `identity-confirm.ts`'s module doc
 * establishes for the sibling identity-plane read (DR-043 Amendment A),
 * applied to this simpler, JWT-free endpoint.
 *
 * A non-404 failure (auth, network, rate-limit, `gh` missing) degrades to
 * `'unknown'` — NEVER throws, matching every other presence-read primitive
 * in this package (`checkControlRepoMeta`, `checkRepoExists`).
 */
export async function checkAppSlugPresence(appSlug: string): Promise<Presence> {
  try {
    await execFileAsync('gh', ['api', `apps/${appSlug}`], { encoding: 'utf-8' });
    return 'present';
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return 'absent';
    return 'unknown';
  }
}

/**
 * Report every App-identity target — NEVER mutates anything. `log` receives
 * the human-facing line BEFORE `deps.openUrl` is attempted — same "print
 * before open" ordering `apply-agent.ts`'s `announceAndOpenGate` doc
 * establishes (a live provisioning run showed `openUrl()` can silently
 * misfire, so the URL must already be on-screen before the open is even
 * attempted). When `deps.checkAppPresence` confirms `'absent'`
 * (groundnuty/macf#917), the target short-circuits to `'already-absent'`
 * BEFORE the manual-deletion line is logged and BEFORE `deps.openUrl` is
 * ever attempted — there is nothing to open a browser tab for.
 *
 * A target with {@link AppIdentityTarget.extraFromLock} set gets an extra
 * `⚠ NOT DECLARED IN fleet.yaml` marker PREPENDED to its log line
 * (groundnuty/macf#953 "mark it distinctly" — on top of the union step's
 * "report it first" ordering) — never folded into `reason`, which stays the
 * exact constant/404-detail text every other target gets, so existing
 * `reason`-matching callers are unaffected.
 */
export async function reportAppIdentityRemoval(
  targets: readonly AppIdentityTarget[],
  log: (line: string) => void,
  deps: AppDeletionDeps = {},
): Promise<readonly AppDeletionOutcome[]> {
  const out: AppDeletionOutcome[] = [];
  for (const t of targets) {
    const notInManifestMarker = t.extraFromLock
      ? '⚠ NOT DECLARED IN fleet.yaml (recovered from fleet.lock only — verify this is not the widest-privilege ' +
        'identity in the fleet, e.g. a runner-ops App with administration:write) — '
      : '';
    const presence = deps.checkAppPresence ? await deps.checkAppPresence(t.appSlug) : 'unknown';
    if (presence === 'absent') {
      const reason =
        `App "${t.appSlug}" returned 404 at its predicted slug — already absent, nothing to delete. (Slug is a ` +
        'PREDICTION, not GitHub-confirmed; if a disambiguating suffix was appended at creation, verify via ' +
        'Settings → Developer settings → GitHub Apps before assuming the App is fully gone.)';
      log(`Role "${t.role}": ${notInManifestMarker}${reason}`);
      out.push({ role: t.role, appSlug: t.appSlug, settingsUrl: t.settingsUrl, appId: t.appId, extraFromLock: t.extraFromLock, status: 'already-absent', reason });
      continue;
    }

    const slugCaveat = t.appId === undefined ? '(predicted slug — no fleet.lock entry to confirm it)' : `(predicted slug — confirmed App ID ${t.appId} from fleet.lock; use the ID to positively identify the App if the slug shown in Settings differs)`;
    log(`Role "${t.role}": ${notInManifestMarker}App "${t.appSlug}" ${slugCaveat}. ${APP_DELETION_HAS_NO_REST_PATH_NOTE} Delete at: ${t.settingsUrl}`);
    if (deps.openUrl) {
      try {
        await deps.openUrl(t.settingsUrl);
      } catch (err) {
        log(`Role "${t.role}": could not automatically open a browser (${errMessage(err)}) — use the URL above.`);
      }
    }
    out.push({
      role: t.role,
      appSlug: t.appSlug,
      settingsUrl: t.settingsUrl,
      appId: t.appId,
      extraFromLock: t.extraFromLock,
      status: 'manual-action-required',
      reason: APP_DELETION_HAS_NO_REST_PATH_NOTE,
    });
  }
  return out;
}
