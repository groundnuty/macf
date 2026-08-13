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
import type { FleetManifest } from './fleet-manifest.js';
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
 * Enrich derived App-identity targets with the RECORDED `app_id` from
 * `fleet.lock`, when available — see {@link AppIdentityTarget.appId}'s doc
 * for why this matters (the derived slug is a prediction; `fleet.lock`'s
 * `app_id` is the authority for WHICH App actually exists).
 *
 * Best-effort, additive-only: `lockText` absent/unparseable/lacking an
 * entry for a given role degrades that target back to slug-only — NEVER
 * throws, NEVER blocks a teardown run. This mirrors every other
 * best-effort read in this package (`realReadControlManifestFile`,
 * `checkControlRepoMeta`) — a failure to read auxiliary state is a reason
 * to report less, never a reason to refuse.
 */
export function enrichAppIdentityTargetsWithLock(
  targets: readonly AppIdentityTarget[],
  lockText: string | undefined,
): readonly AppIdentityTarget[] {
  if (lockText === undefined) return targets;
  let appIdByRole: ReadonlyMap<string, string>;
  try {
    const lock = parseFleetLock(lockText);
    appIdByRole = new Map(lock.agents.map((a) => [a.role, a.app_id]));
  } catch {
    return targets;
  }
  return targets.map((t) => {
    const appId = appIdByRole.get(t.role);
    return appId === undefined ? t : { ...t, appId };
  });
}

export interface AppDeletionOutcome {
  readonly role: string;
  readonly appSlug: string;
  readonly settingsUrl: string;
  /** Carried through from {@link AppIdentityTarget.appId} — see that field's doc. */
  readonly appId?: string;
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
 */
export async function reportAppIdentityRemoval(
  targets: readonly AppIdentityTarget[],
  log: (line: string) => void,
  deps: AppDeletionDeps = {},
): Promise<readonly AppDeletionOutcome[]> {
  const out: AppDeletionOutcome[] = [];
  for (const t of targets) {
    const presence = deps.checkAppPresence ? await deps.checkAppPresence(t.appSlug) : 'unknown';
    if (presence === 'absent') {
      const reason =
        `App "${t.appSlug}" returned 404 at its predicted slug — already absent, nothing to delete. (Slug is a ` +
        'PREDICTION, not GitHub-confirmed; if a disambiguating suffix was appended at creation, verify via ' +
        'Settings → Developer settings → GitHub Apps before assuming the App is fully gone.)';
      log(`Role "${t.role}": ${reason}`);
      out.push({ role: t.role, appSlug: t.appSlug, settingsUrl: t.settingsUrl, appId: t.appId, status: 'already-absent', reason });
      continue;
    }

    const slugCaveat = t.appId === undefined ? '(predicted slug — no fleet.lock entry to confirm it)' : `(predicted slug — confirmed App ID ${t.appId} from fleet.lock; use the ID to positively identify the App if the slug shown in Settings differs)`;
    log(`Role "${t.role}": App "${t.appSlug}" ${slugCaveat}. ${APP_DELETION_HAS_NO_REST_PATH_NOTE} Delete at: ${t.settingsUrl}`);
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
      status: 'manual-action-required',
      reason: APP_DELETION_HAS_NO_REST_PATH_NOTE,
    });
  }
  return out;
}
