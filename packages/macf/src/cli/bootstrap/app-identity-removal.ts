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
 * exact per-agent target set (pure, no I/O), then REPORT — never mutate,
 * never claim success. This is Amendment G's "report what could not be
 * done, never exit green" rail at its starkest: for this ONE rung, there is
 * NOTHING this codebase can do besides report and point at the URL.
 */
import type { FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle, parseFleetLock } from './fleet-manifest.js';

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
  /** ALWAYS `'manual-action-required'` — see module doc; this codebase can never honestly report `'deleted'` for this rung. */
  readonly status: 'manual-action-required';
  readonly reason: string;
}

export interface AppDeletionDeps {
  /** Best-effort browser-open, same non-fatal posture as `apply-agent.ts`'s `announceAndOpenGate` — optional so a headless/CI/test caller can omit it entirely. */
  readonly openUrl?: (url: string) => Promise<void>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Report every App-identity target — NEVER mutates anything, NEVER returns
 * a status other than `'manual-action-required'`. `log` receives the
 * human-facing line BEFORE `deps.openUrl` is attempted — same "print before
 * open" ordering `apply-agent.ts`'s `announceAndOpenGate` doc establishes (a
 * live provisioning run showed `openUrl()` can silently misfire, so the URL
 * must already be on-screen before the open is even attempted).
 */
export async function reportAppIdentityRemoval(
  targets: readonly AppIdentityTarget[],
  log: (line: string) => void,
  deps: AppDeletionDeps = {},
): Promise<readonly AppDeletionOutcome[]> {
  const out: AppDeletionOutcome[] = [];
  for (const t of targets) {
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
