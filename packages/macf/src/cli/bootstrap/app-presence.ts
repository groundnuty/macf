/**
 * Live App-presence resolution — "ask, don't predict" (groundnuty/macf#967).
 *
 * **The bug this module closes.** `app-identity-removal.ts::checkAppSlugPresence`
 * reads `GET /apps/{predicted-slug}` with whatever `gh` auth is ambient. That
 * endpoint 404s for a PRIVATE App the caller isn't authenticated AS (via that
 * App's own JWT) — verified live 2026-08-18: an operator who owns/administers
 * `macf-experiment` still got 404s at `GET /apps/macf-experiment-code-agent`
 * and `GET /apps/macf-experiment-science-agent`, for Apps that were fully
 * present and installed. A 404 at this endpoint is therefore AMBIGUOUS for a
 * private App (every fleet App is created `public: false` —
 * `app-manifest.ts`) — it cannot distinguish "genuinely absent" from "exists,
 * private, this token cannot see it." Reading that ambiguous 404 as a
 * confident `'absent'` is the exact inversion DR-043 Amendment A's
 * honest-unknown floor forbids (silent-fallback hazard class: "the API can
 * confirm present, never prove absent").
 *
 * **The fix: ask an authoritative source first.** `GET /orgs/{org}/installations`
 * (verified against the current GitHub REST docs, 2026-08-18) enumerates
 * every App installed on an org, and is authoritative for org-owned fleets —
 * it requires organization-OWNER authentication (classic/OAuth tokens
 * additionally need `admin:read`), which the operator-privileged bootstrap
 * CLI's ambient `gh auth login` session already carries when the operator
 * owns the fleet's org (DR-035 §2 — this tool drives the operator's own `gh`,
 * never a bot token). {@link resolveAppPresence} tries this listing FIRST for
 * an org-owned fleet; a definitive match (or definitive non-match, since the
 * listing is a complete enumeration) resolves `'present'`/`'absent'` with
 * confidence. Only when the listing is unavailable (permission-denied,
 * network failure) — or the fleet is personal-account-owned, where NO
 * ambient-auth listing endpoint exists at all (`identity-confirm.ts`'s own
 * module doc: `/user/installations` 403s on both bot tokens AND the
 * operator's own `gh auth login` token, live-verified 2026-08-11 macf#838) —
 * does this module fall back to the old predicted-slug check, and even then
 * a 404 there degrades to `'unknown'`, never `'absent'` (the honest-unknown
 * floor this whole module exists to restore).
 *
 * Both real I/O leaves ({@link listOrgAppInstallations},
 * `app-identity-removal.ts::checkAppSlugPresence}) are thin `execFile('gh',
 * ...)` wrappers, untested directly — same posture `observer.test.ts`'s
 * module doc establishes for `checkRepoExists`/`readRepoVariable`.
 * {@link resolveAppPresence} is the pure COMPOSITION over an injected deps
 * seam (mirrors `observer.ts::checkRunnerUsableByRepo`'s same shape) — THAT
 * is what's fully tested, including the decisive "App exists but the token
 * cannot see it" scenario a mocked always-visible seam cannot reproduce.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Presence } from './plan.js';
import { getStderr } from './observer.js';
import { checkAppSlugPresence } from './app-identity-removal.js';

const execFileAsync = promisify(execFile);

/** The minimal owner shape every function here needs — same narrow inline convention `app-identity-removal.ts::appSettingsAdvancedUrl` already uses (a `FleetManifest['owner']` is always assignable here; no need to import the wider type). */
export interface AppOwnerRef {
  readonly account: string;
  readonly type: 'user' | 'org';
}

/** One org-installed App, as surfaced by `GET /orgs/{org}/installations`. */
export interface OrgInstallationRecord {
  readonly appId: string;
  readonly appSlug: string;
  readonly accountLogin: string;
}

/**
 * `'ok'` — the listing call succeeded; `installations` is the COMPLETE set
 * (our fleets have single-digit App counts — no pagination needed, same
 * `per_page=100`-single-page precedent `identity-confirm.ts::confirmAppInstallation`
 * already establishes). `'forbidden'` — a confirmed HTTP 403 (the caller
 * isn't an organization owner, or lacks `admin:read`) — distinguished from
 * `'unknown'` so {@link resolveAppPresence} can name the specific,
 * actionable cause. `'unknown'` — any other failure (network, `gh` missing,
 * malformed body). NEVER throws.
 */
export type OrgInstallationsOutcome =
  | { readonly kind: 'ok'; readonly installations: readonly OrgInstallationRecord[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Parse a `GET /orgs/{org}/installations` JSON body (`{total_count,
 * installations: [...]}` — verified against the current GitHub REST docs,
 * 2026-08-18) into installation records. Pure + tolerant: a non-object body,
 * a missing/non-array `installations`, or an entry missing `app_id` is
 * skipped rather than thrown on — same defensive posture
 * `identity-confirm.ts::parseAppInstallations` already establishes for the
 * sibling `GET /app/installations` shape.
 */
export function parseOrgInstallations(json: unknown): OrgInstallationRecord[] {
  if (typeof json !== 'object' || json === null || !('installations' in json)) return [];
  const list = (json as { readonly installations?: unknown }).installations;
  if (!Array.isArray(list)) return [];
  const out: OrgInstallationRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { app_id, app_slug, account } = item as Record<string, unknown>;
    if (app_id === undefined || app_id === null) continue;
    const appId = String(app_id);
    if (appId.length === 0) continue;
    const appSlug = typeof app_slug === 'string' ? app_slug : '';
    const accountLogin =
      account !== null && typeof account === 'object' && typeof (account as Record<string, unknown>).login === 'string'
        ? ((account as Record<string, unknown>).login as string)
        : '';
    out.push({ appId, appSlug, accountLogin });
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read-only `GET /orgs/{org}/installations?per_page=100` via the ambient
 * `gh` auth (this tool is operator-privileged — DR-035 §2 — never a bot
 * token). Authoritative for what's installed on an org WHEN it succeeds: an
 * organization owner's own listing enumerates every App installed there, so
 * a slug/app_id absent from the result is a confident negative, not a guess.
 * NEVER throws.
 */
export async function listOrgAppInstallations(org: string): Promise<OrgInstallationsOutcome> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `orgs/${org}/installations?per_page=100`], { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(stdout);
    return { kind: 'ok', installations: parseOrgInstallations(parsed) };
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 403|Forbidden/i.test(stderr)) return { kind: 'forbidden' };
    return { kind: 'unknown', reason: stderr.trim().length > 0 ? stderr.trim() : errMessage(err) };
  }
}

/** The full result of {@link resolveAppPresence} — richer than the bare {@link Presence} its `checkAppPresence`/`checkAppNameCollision` callers ultimately consume, so a caller that wants the diagnostic detail (not just the tri-state) can read it directly. */
export interface AppPresenceResult {
  readonly presence: Presence;
  /** The REAL, GitHub-confirmed app_id — only set on a `'present'` result resolved via the org-installations listing (never on the predicted-slug fallback, which cannot see this field for a private App). */
  readonly appId?: string;
  /** The REAL, GitHub-confirmed slug — may differ from the predicted one GitHub appended a disambiguating suffix at creation; see `app-identity-removal.ts::AppIdentityTarget.appSlug`'s doc for the same caveat. */
  readonly appSlug?: string;
  readonly accountLogin?: string;
  readonly method: 'org-installations-listing' | 'predicted-slug-fallback';
  /** Always populated on the fallback path (says WHY the listing wasn't used, even on a confident `'present'`) and whenever `presence === 'unknown'`. `undefined` only for a listing-confirmed `'present'`/`'absent'`, which need no caveat. */
  readonly reason?: string;
}

export interface AppPresenceDeps {
  readonly listOrgInstallations?: (org: string) => Promise<OrgInstallationsOutcome>;
  readonly checkPredictedSlug?: (appSlug: string) => Promise<Presence>;
}

/**
 * Fall back to the predicted-slug check when the org-installations listing
 * wasn't usable (unavailable, forbidden, or the fleet is personal-account-
 * owned). `unavailableReason` is ALWAYS carried into the result's `reason` —
 * even on a `'present'` outcome — so a caller/operator can see WHICH method
 * actually confirmed the read (macf#967's "fall back to prediction … and say
 * which was used").
 *
 * A `'present'` predicted-slug read is trustworthy (a 200 is unambiguous
 * evidence either way). A non-`'present'` read is NOT — see module doc: a
 * 404 there cannot distinguish "genuinely absent" from "exists, private,
 * invisible to this token" — so it degrades to `'unknown'`, never `'absent'`.
 */
async function fallbackToPredictedSlug(
  predictedSlug: string,
  checkPredictedSlug: (appSlug: string) => Promise<Presence>,
  unavailableReason: string,
): Promise<AppPresenceResult> {
  const fallback = await checkPredictedSlug(predictedSlug);
  if (fallback === 'present') {
    return {
      presence: 'present',
      method: 'predicted-slug-fallback',
      reason: `${unavailableReason} — fell back to the predicted-slug check (GET /apps/${predictedSlug}), which confirmed the App exists.`,
    };
  }
  return {
    presence: 'unknown',
    method: 'predicted-slug-fallback',
    reason:
      `${unavailableReason} — fell back to the predicted-slug check (GET /apps/${predictedSlug}), which came back ` +
      'inconclusive. That endpoint cannot distinguish "genuinely absent" from "exists, private, and this token ' +
      'cannot see it" — verify manually (Settings → Developer settings → GitHub Apps) before assuming this App is ' +
      'gone.',
  };
}

/**
 * Resolve an App's live presence honestly — "ask, don't predict" (module
 * doc). Tries `GET /orgs/{owner}/installations` first for an org-owned
 * fleet (authoritative: a listing MATCH is `'present'` with real
 * appId/appSlug/accountLogin; a listing MISS is a confident `'absent'`,
 * since the listing enumerates everything installed on that org). Falls
 * back to the predicted-slug check — degrading any inconclusive read to
 * `'unknown'`, never `'absent'` — when the listing is unavailable
 * (forbidden/network-failure) OR the fleet is personal-account-owned (no
 * ambient-auth listing endpoint exists there at all — module doc). NEVER
 * throws (every branch below terminates in a `Promise<AppPresenceResult>`,
 * and both injected leaf deps are themselves documented never-throw).
 */
export async function resolveAppPresence(
  owner: AppOwnerRef,
  predictedSlug: string,
  knownAppId?: string,
  deps: AppPresenceDeps = {},
): Promise<AppPresenceResult> {
  const listOrgInstallations = deps.listOrgInstallations ?? listOrgAppInstallations;
  const checkPredictedSlug = deps.checkPredictedSlug ?? checkAppSlugPresence;

  if (owner.type === 'org') {
    const listing = await listOrgInstallations(owner.account);
    if (listing.kind === 'ok') {
      const match = listing.installations.find((i) => i.appSlug === predictedSlug || (knownAppId !== undefined && i.appId === knownAppId));
      if (match !== undefined) {
        return { presence: 'present', appId: match.appId, appSlug: match.appSlug, accountLogin: match.accountLogin, method: 'org-installations-listing' };
      }
      return {
        presence: 'absent',
        method: 'org-installations-listing',
        reason:
          `no App matching "${predictedSlug}"${knownAppId !== undefined ? ` (app_id ${knownAppId})` : ''} was found among the ` +
          `${String(listing.installations.length)} App(s) installed on org "${owner.account}" — an org owner's own installations ` +
          'listing enumerates everything installed there, so this is a confident negative.',
      };
    }
    const why =
      listing.kind === 'forbidden'
        ? `insufficient permission to list org "${owner.account}"'s App installations (HTTP 403 — the caller must be an ` +
          'organization owner; OAuth/classic-PAT tokens additionally need admin:read)'
        : `could not list org "${owner.account}"'s App installations (${listing.reason})`;
    return fallbackToPredictedSlug(predictedSlug, checkPredictedSlug, why);
  }

  return fallbackToPredictedSlug(
    predictedSlug,
    checkPredictedSlug,
    `App "${predictedSlug}" is owned by a personal account ("${owner.account}"), not an organization — GitHub exposes no ` +
      "installations-listing endpoint reachable with ambient `gh` auth for personal accounts (verified live: `/user/installations` " +
      "403s on both bot installation tokens AND the operator's own `gh auth login` token — see identity-confirm.ts's module doc)",
  );
}

/**
 * Bare-`Presence` convenience wrapper — the shape `app-identity-removal.ts`'s
 * `AppDeletionDeps.checkAppPresence` and `apply-agent.ts`'s
 * `AgentApplyDeps.checkAppNameCollision` both wire directly (a bare
 * reference, no manifest-bound closure needed — both callers already have
 * `owner` in scope and pass it at CALL time, so this stays a plain,
 * `toBe`-pinnable top-level export for `apply-deps-wiring.test.ts`).
 */
export async function resolveAppPresenceStatus(
  owner: AppOwnerRef,
  predictedSlug: string,
  knownAppId?: string,
  deps: AppPresenceDeps = {},
): Promise<Presence> {
  const result = await resolveAppPresence(owner, predictedSlug, knownAppId, deps);
  return result.presence;
}

/**
 * The pre-flight App-name-collision refusal (groundnuty/macf#967 Defect 2) —
 * pure text builder for `apply-agent.ts::applyIdentity`'s create path,
 * exported so the CLI-level render layer and tests can assert against it
 * without re-deriving the wording. Names BOTH available remedies, matching
 * the shape #932's preflight refusals already established (refuse on an
 * unsatisfiable configuration before it costs a browser click, naming
 * exactly what to do next): delete the foreign App (an operator-only action
 * — GitHub has no API for it, `app-identity-removal.ts`'s module doc), or
 * re-run with `--vault`/`--identity-key` if the operator holds its
 * credentials (`apply-agent.ts::confirmBeforeCreateGuard`'s EXISTING reuse
 * path, groundnuty/macf#913 — this message does not duplicate that logic,
 * only points at it).
 */
export function appNameCollisionRefusalMessage(appSlug: string, settingsUrl: string): string {
  return (
    `App "${appSlug}" already exists but is not in this fleet's vault, so its ownership cannot be proven and its ` +
    'private key cannot be recovered (GitHub has no API for that — regeneration is GUI-only). Either delete it at ' +
    `${settingsUrl}, or re-run with --vault/--identity-key if you hold its credentials.`
  );
}
