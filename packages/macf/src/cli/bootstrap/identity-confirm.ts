/**
 * `confirmAppInstallation` — the DR-043 Amendment-A credential-bearing identity
 * read (Slice 2, groundnuty/macf#838). The ONE primitive reused at all three
 * identity call-sites (plan-confirm · `apply` install-poll · `apply`
 * confirm-before-create guard): given an App's numeric id + its private-key
 * PEM, mint an App JWT and ask GitHub `GET /app/installations` whether the App
 * exists and is installed **now**.
 *
 * This file is also the DR-043 §D2 consent-gate-2 home (Slice 2b increment 3,
 * groundnuty/macf#838): {@link waitForAppInstallation} polls
 * {@link confirmAppInstallation} while the operator clicks **Install** in
 * their own browser, and {@link appInstallationUrl} is the pure helper for
 * the page they open. Sibling to `manifest-flow-server.ts` (consent gate 1) —
 * same "deterministic code, no browser-driving" posture, but gate 2 has no
 * REST create endpoint to call at all (§D2 point 2): the only API-side signal
 * of a completed install is this same identity read, polled.
 *
 * Why this and nothing else (DR-043 §Amendment-A):
 *   - `/user/installations` (ambient-auth enumerate) 403s on BOTH bot
 *     installation tokens AND the operator's `gh auth login` token — it needs a
 *     GitHub-App user-to-server token no flow holds. Verified 2026-08-11 (#838).
 *   - workspace-file / registry-var presence is inference dressed as
 *     observation (A2 · silent-fallback Instance 16, presence-by-proxy).
 *   - PEM→App-JWT→`GET /app/installations` is the only read that *confirms*
 *     against GitHub. Proved live by spike #837 and re-verified against
 *     `macf-code-agent` on 2026-08-11.
 *
 * **A4 epistemic floor — present-detector ONLY, but `app-no-install` /
 * `installed-unexpected-target` are AUTHORITATIVE.** `GET /app/installations`
 * under the App's OWN JWT (the JWT's `iss` claim IS the App id) enumerates
 * *that App's* installations completely — unlike the rejected
 * `/user/installations` mechanism, there is no partial-visibility concern
 * here, because the endpoint's scope is exactly "installs of the App this
 * JWT authenticates as," not "everything this account can see." So a valid
 * JWT that comes back with zero installs, or with installs that don't match
 * what the caller expected, is a **confirmed, high-confidence** read — NOT a
 * degraded one. Only a JWT-mint failure, a 401, a network error, a timeout,
 * or a malformed body degrade to `unconfirmable` — and `unconfirmable` keeps
 * the honest floor: it NEVER implies `absent`, only "couldn't ask GitHub this
 * time." The caller degrades `unconfirmable` to `unknown`; the other two
 * non-`confirmed` statuses are actionable as-is (see `IdentityConfirmation`'s
 * doc for why they're kept distinct rather than folded into one bucket).
 *
 * The JWT is signed by `gh token generate --jwt` (RS256 via `gh`, no Node
 * crypto reimpl) — the same mechanism `doctor.ts::fetchInstallationPermissions`
 * already uses. `parseAppInstallations` + `selectConfirmedInstall` are pure +
 * exported for unit testing; the `gh`/`fetch` wrapper is a thin I/O leaf,
 * untested per the observer convention.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Bound BOTH the `gh` exec and the GitHub fetch (macf#841 review nit c): an
 * unbounded network call would hang whatever awaits `confirmAppInstallation`
 * — including a poll loop that's supposed to keep the operator informed. A
 * timeout degrades to `unconfirmable` exactly like any other failure (never
 * throws) so a stall never escapes as anything other than the honest
 * present-detector floor.
 */
const IDENTITY_EXEC_TIMEOUT_MS = 10_000;
const IDENTITY_FETCH_TIMEOUT_MS = 10_000;

/** One confirmed installation, as surfaced by `GET /app/installations`. */
export interface ConfirmedInstall {
  /** `.app_id`, stringified (API returns a number) — pairs with `fleet.lock`'s string form. */
  readonly appId: string;
  /** `.id`, stringified — the installation id. */
  readonly installId: string;
  /** `.app_slug` — equals `deriveAppHandle(fleet, role)` for a correctly-paired PEM. */
  readonly appSlug: string;
  /** `.account.login` — the account (user or org) the install landed on. `''` when absent from the body. */
  readonly accountLogin: string;
}

/**
 * The App identity a caller expects a confirmed install to belong to
 * (macf#841 review nit d). Every field given must match; omit a field to
 * not filter on it. `undefined` (no `ExpectedIdentity` at all) preserves the
 * original "trust the first entry" default — agent Apps install on exactly
 * one account in the common case, and most callers don't yet have a prior
 * identity to check against (e.g. a brand-new App's very first poll).
 */
export interface ExpectedIdentity {
  readonly appSlug?: string;
  readonly accountLogin?: string;
}

/**
 * Result of a credential-bearing identity read.
 *   - `confirmed`                  — App exists AND a matching install
 *                                    exists; carries the live ids (§ module
 *                                    doc: AUTHORITATIVE, not a degraded
 *                                    read).
 *   - `app-no-install`             — the JWT was valid (App exists) and
 *                                    GitHub returned LITERALLY ZERO
 *                                    installs. AUTHORITATIVE, not degraded
 *                                    (§ module doc A4) — a strong
 *                                    create-the-install (or, mid-poll,
 *                                    "not yet") signal.
 *   - `installed-unexpected-target` — the JWT was valid AND GitHub returned
 *                                    one or more installs, but NONE matched
 *                                    the caller's `ExpectedIdentity`. Kept
 *                                    DISTINCT from `app-no-install` on
 *                                    purpose (macf#841 review, fixed after
 *                                    an initial draft folded the two
 *                                    together): "nothing installed yet" and
 *                                    "installed, but not where expected"
 *                                    are different facts an apply-time
 *                                    caller needs to tell apart — the
 *                                    latter is exactly the DR-043
 *                                    Amendment-A §A2 lock-vs-live DRIFT
 *                                    case (App deleted+recreated, a stale
 *                                    test install shadowing the real one),
 *                                    which §A2 requires surfacing as
 *                                    `update` + `confirm_required`, never
 *                                    silently resolving. Carries the
 *                                    `installs` actually seen so the
 *                                    caller can report/diagnose them.
 *   - `unconfirmable`              — JWT mint failed / 401 / network /
 *                                    timeout / bad body — GitHub was never
 *                                    successfully asked at all. NEVER
 *                                    `absent` (A4). The caller degrades to
 *                                    `unknown`.
 */
export type IdentityConfirmation =
  | { readonly status: 'confirmed'; readonly install: ConfirmedInstall }
  | { readonly status: 'app-no-install' }
  | { readonly status: 'installed-unexpected-target'; readonly installs: readonly ConfirmedInstall[] }
  | { readonly status: 'unconfirmable' };

/**
 * Parse a `GET /app/installations` JSON body (an array of installation objects)
 * into confirmed installs. Pure + tolerant: a non-array, or entries missing
 * `id` / `app_id`, are skipped rather than thrown on. `id` + `app_id` arrive as
 * JSON numbers and are stringified. `account.login` is optional in the body
 * shape we tolerate; a missing/malformed `account` yields `accountLogin: ''`.
 */
export function parseAppInstallations(json: unknown): ConfirmedInstall[] {
  if (!Array.isArray(json)) return [];
  const out: ConfirmedInstall[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const { id, app_id, app_slug, account } = item as Record<string, unknown>;
    if (id === undefined || id === null || app_id === undefined || app_id === null) continue;
    const installId = String(id);
    const appId = String(app_id);
    if (installId.length === 0 || appId.length === 0) continue;
    const accountLogin =
      account !== null && typeof account === 'object' && typeof (account as Record<string, unknown>).login === 'string'
        ? ((account as Record<string, unknown>).login as string)
        : '';
    out.push({ appId, installId, appSlug: typeof app_slug === 'string' ? app_slug : '', accountLogin });
  }
  return out;
}

/**
 * Pick the install matching an `ExpectedIdentity`, when the caller has one
 * (macf#841 review nit d — "do not trust entry `[0]`"). Pure + exported for
 * testing.
 *
 * `GET /app/installations` is already scoped to the App identified by the
 * minted JWT, so in the common case every returned entry shares one
 * `appId`/`appSlug` — this selector defends against the SEPARATE hazard of
 * multiple installs on DIFFERENT accounts (e.g. a test install left on the
 * operator's personal account before the real org install lands, or a
 * re-created App's installs from before + after recreation). Matching on
 * `accountLogin` (and/or `appSlug`, belt-and-suspenders) picks the intended
 * one instead of whichever happened to sort first.
 *
 * Returns `undefined` when nothing matches (including the empty-list case) —
 * the caller (`confirmAppInstallation`) distinguishes WHY (zero installs vs
 * installs-that-don't-match — see `IdentityConfirmation`'s `app-no-install`
 * vs `installed-unexpected-target`), never silently substituting a
 * non-matching entry as if it were confirmed. This is what the DR-043
 * Amendment-A §A2 lock-vs-live drift check needs: the caller compares a
 * `confirmed` install's ids against `fleet.lock` itself; this function's
 * only job is not to hand back the wrong install in the first place.
 *
 * **`expected` given but carrying ZERO discriminating criteria (`{}`, both
 * fields `undefined`) is deliberately treated like "nothing matched," NOT
 * like "no `ExpectedIdentity` at all" (macf#846 review 3c).** The two are
 * different callers: `expected === undefined` is `confirmAppInstallation`'s
 * legitimate no-prior-identity case (a brand-new App's very first poll —
 * kept optional there on purpose). `expected: {}` is a caller who DID pass
 * an `ExpectedIdentity` object but it carries no actual criteria — treating
 * that the same as "trust the first entry" would silently reinstate the
 * exact false-consent hole `ExpectedIdentity` exists to close (an unrelated
 * stale install would satisfy a criterion-less filter vacuously). Failing
 * closed here is the pure-layer half of that defense; `waitForAppInstallation`
 * additionally rejects an all-undefined `expected` at entry, before any poll
 * — see its doc for why both levels are needed.
 */
export function selectConfirmedInstall(
  installs: readonly ConfirmedInstall[],
  expected?: ExpectedIdentity,
): ConfirmedInstall | undefined {
  if (installs.length === 0) return undefined;
  if (expected === undefined) return installs[0];
  if (expected.appSlug === undefined && expected.accountLogin === undefined) return undefined;
  return installs.find(
    (i) =>
      (expected.appSlug === undefined || i.appSlug === expected.appSlug) &&
      (expected.accountLogin === undefined || i.accountLogin === expected.accountLogin),
  );
}

/**
 * Confirm an App's installation live via PEM→App-JWT→`GET /app/installations`.
 * `appId` mints the JWT (`iss`); `keyPath` is the App's private-key PEM (from
 * the vault §D5, or an explicit key path — DR-043 A1). `expected`, when given,
 * disambiguates among multiple installs (macf#841 review nit d;
 * {@link selectConfirmedInstall}). NEVER throws — every failure (including a
 * timeout, nit c) resolves to `unconfirmable` (A4: present-detector only).
 *
 * `per_page=100`: our Apps realistically have 1–2 installs (an agent App
 * installs on its own fleet's account, occasionally a leftover test install
 * elsewhere) — a single generous page avoids implementing `Link`-header
 * pagination for a list that's never going to need it.
 */
export async function confirmAppInstallation(
  appId: string,
  keyPath: string,
  expected?: ExpectedIdentity,
): Promise<IdentityConfirmation> {
  let jwt: string;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['token', 'generate', '--app-id', appId, '--key', keyPath, '--jwt', '--token-only'],
      { encoding: 'utf-8', timeout: IDENTITY_EXEC_TIMEOUT_MS },
    );
    jwt = stdout.trim();
  } catch {
    return { status: 'unconfirmable' };
  }
  // A malformed/empty JWT (e.g. an error string leaked to stdout) is unconfirmable.
  if (!jwt.startsWith('eyJ')) return { status: 'unconfirmable' };

  let response: Response;
  try {
    response = await fetch('https://api.github.com/app/installations?per_page=100', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { status: 'unconfirmable' };
  }
  if (!response.ok) return { status: 'unconfirmable' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'unconfirmable' };
  }
  const installs = parseAppInstallations(body);
  if (installs.length === 0) return { status: 'app-no-install' };
  const install = selectConfirmedInstall(installs, expected);
  // installs.length > 0 here, so `undefined` can ONLY mean "expected was
  // given and nothing matched" (selectConfirmedInstall returns installs[0]
  // whenever expected is undefined) — the installed-unexpected-target /
  // drift case, kept distinct from the true-zero-installs case above.
  if (install === undefined) return { status: 'installed-unexpected-target', installs };
  return { status: 'confirmed', install };
}

// --- Consent gate 2 (§D2 point 2) — the install click + its API-side poll ---

/**
 * The install page the operator opens for consent gate 2.
 *
 * **What's actually verified (2026-08-11) vs inferred:** two current
 * (non-versioned) GitHub docs pages state this URL directly —
 * `https://docs.github.com/en/apps/sharing-github-apps` ("the app
 * installation URL: `http(s)://[hostname]/apps/<app name>/installations/new`")
 * and `https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party`
 * ("the app owner will direct you to `https://github.com/apps/APP-NAME/installations/new`").
 * Both describe the URL in a *sharing / third-party install* context. The
 * *owner-installs-their-own-App* doc
 * (`.../apps/using-github-apps/installing-your-own-github-app`) only gives UI
 * click-path steps (Settings → Developer settings → the App → Install App)
 * with **no URL at all** — so "this is the same URL the Install App button
 * routes through" is inference, not a doc-confirmed fact, and is flagged as
 * such here rather than asserted. It is GitHub's one documented, general
 * App-installation URL shape, and works for the App owner regardless of
 * public/private (installing is always owner-gated for a private App; only
 * who ELSE can reach this URL differs) — but if a future increment finds the
 * owner's "Install App" button actually resolves somewhere else, this is the
 * assumption to revisit.
 *
 * One shape regardless of user/org owner (per the docs above): GitHub
 * resolves the eligible install target(s) for the authenticated App-owning
 * operator who visits it — the CLI does not need to branch on `owner.type`
 * the way `manifestFormAction` (gate 1) does.
 *
 * `appSlug` must be the App's REAL, GitHub-assigned slug (from
 * `AppCredentials.slug`, `manifest-exchange.ts`) once one exists — GitHub
 * slugifies the submitted manifest `name` and may append a disambiguating
 * suffix on a global collision, so a *derived* handle (`deriveAppHandle`,
 * pre-creation) is only a PREDICTION of the slug. `apply --dry-run`'s render
 * uses the derived handle because no App exists yet to have a real slug;
 * a future increment that calls this AFTER the manifest exchange must pass
 * the exchange's returned `slug`, not re-derive it.
 */
export function appInstallationUrl(appSlug: string): string {
  return `https://github.com/apps/${appSlug}/installations/new`;
}

export interface WaitForAppInstallationOptions {
  readonly appId: string;
  readonly keyPath: string;
  /**
   * Disambiguates among multiple installs — see {@link selectConfirmedInstall}.
   * **REQUIRED (macf#846 review 3a — was optional through Slice 2b increment
   * 3).** If this could be omitted and a stale/unrelated install already
   * exists for this App (a leftover test install, a prior fleet's
   * misconfiguration), the very FIRST poll would resolve `confirmed`
   * immediately on that unrelated install — reporting a consent the operator
   * never gave, for an install they never clicked. Quoting the review:
   * "that's a false consent, not just a false diagnostic." A type-level MUST
   * so a future caller cannot quietly skip it. (`confirmAppInstallation`
   * itself, one layer down, KEEPS `expected` optional — its brand-new-App
   * very first poll legitimately has no prior identity to check against;
   * this function is the poll LOOP built on top of it, which always has a
   * fleet-owner account to check against by the time it's invoked.) Must
   * carry at least one of `appSlug`/`accountLogin` — an all-`undefined`
   * `{}` is rejected at entry, see {@link waitForAppInstallation}'s doc.
   */
  readonly expected: ExpectedIdentity;
  /** Overall budget. Default 10 min — matches gate 1's `startManifestFlow`. */
  readonly timeoutMs?: number;
  /** Delay between polls. Default 3s — frequent enough to feel live, far from busy-spin. */
  readonly pollIntervalMs?: number;
  /**
   * Injection seam for tests (never real network in unit tests) — defaults to
   * the real {@link confirmAppInstallation}.
   */
  readonly confirm?: (appId: string, keyPath: string, expected?: ExpectedIdentity) => Promise<IdentityConfirmation>;
  /**
   * Fired ONCE — the first time a poll observes `installed-unexpected-target`
   * (macf#846 review nit b). A wrong-account install won't fix itself by
   * waiting, so silently polling the full timeout budget before saying
   * anything is poor UX; this lets a caller surface it immediately while the
   * loop keeps polling (in case the operator also completes the CORRECT
   * install without cancelling). Never hard-codes `console` — callers decide
   * where the warning goes. Default: no-op.
   */
  readonly onUnexpectedTarget?: (installs: readonly ConfirmedInstall[]) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Build the poll-timeout error message, branched on the LAST observed
 * {@link IdentityConfirmation} rather than one generic sentence. Pure +
 * exported for testing.
 *
 * Naming the wrong cause is its own small hazard — `plan.ts`'s
 * `UNKNOWN_REASONS` comment makes the same call for its own per-kind
 * `unknown` diagnostics ("a diagnostic that names the wrong cause is a small
 * lie compounding with every run," macf#842 review). A timeout whose every
 * poll came back `unconfirmable` means GitHub was NEVER successfully asked —
 * that's a broken credential or network path, not "the operator hasn't
 * clicked yet," and telling the operator to go click a button they may have
 * already clicked (successfully) sends them chasing the wrong problem.
 */
export function waitForInstallTimeoutMessage(timeoutMs: number, last: IdentityConfirmation): string {
  const prefix = `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for the GitHub App install to appear`;
  switch (last.status) {
    case 'unconfirmable':
      return (
        `${prefix} — GitHub was NEVER successfully queried on any poll (JWT mint failure / 401 / network / ` +
        'per-request timeout). This is not necessarily "the operator hasn\'t clicked Install" — check the ' +
        'app-id↔key-path pairing and network reachability to api.github.com before re-running.'
      );
    case 'installed-unexpected-target': {
      const seen = last.installs.map((i) => `${i.appSlug || '(no slug)'}@${i.accountLogin || '(no account)'}`).join(', ');
      return (
        `${prefix} — the App IS installed, but not on the expected target (saw: ${seen || 'none'}). The ` +
        'operator may have picked the wrong account/org on the install page, or a stale install from a prior ' +
        'attempt is shadowing the intended one. Resolve the mismatch before re-running.'
      );
    }
    case 'app-no-install':
      return (
        `${prefix} (GET /app/installations still returns zero). The operator must click "Install" (and select ` +
        `repos) in the browser tab opened at the App's install page — re-run once the install is complete.`
      );
    case 'confirmed':
      // Unreachable — the loop below returns as soon as `confirmed` is seen,
      // before this function is ever called with it. Handled anyway so the
      // switch stays exhaustive: if `IdentityConfirmation` grows a new
      // variant, TypeScript's "not all code paths return" flags this
      // function rather than silently falling through to a stale message.
      return `${prefix} (unexpected: install was already confirmed — this indicates a bug in the poll loop, not the operator).`;
  }
}

/**
 * Poll {@link confirmAppInstallation} while the operator clicks **Install**
 * in the browser tab opened at {@link appInstallationUrl} — DR-043 §D2
 * consent gate 2 (Slice 2b increment 3, groundnuty/macf#838).
 *
 * Checks immediately (the operator may already have finished before this is
 * called), then on `pollIntervalMs` — NEVER busy-spins. Every non-`confirmed`
 * poll (including `unconfirmable`, a transient network hiccup) is tolerated
 * by simply continuing; `confirmAppInstallation` itself never throws
 * (§ module doc A4), so the only way this function throws is the overall
 * timeout — a loud, actionable error (via {@link waitForInstallTimeoutMessage}),
 * because a silent hang here would be indistinguishable from "still working."
 *
 * **Entry-time guard, not just a type (macf#846 review 3c):** an
 * `opts.expected` carrying ZERO discriminating criteria (`{}`) is rejected
 * IMMEDIATELY, before the first poll — not left to `selectConfirmedInstall`'s
 * pure-layer "no match" behavior alone. Without this, a `{}` polling a
 * CORRECTLY-installed App would run the full timeout budget and then throw
 * `waitForInstallTimeoutMessage`'s `installed-unexpected-target` message —
 * which names the WRONG cause (the install is fine; the caller's own
 * `expected` was vacuous) and is exactly the "a diagnostic that names the
 * wrong cause is a small lie" hazard `waitForInstallTimeoutMessage`'s own doc
 * warns about. Failing at entry means the actual bug (a caller-constructed
 * `{}`) is reported as itself, not disguised as an installation problem.
 */
export async function waitForAppInstallation(opts: WaitForAppInstallationOptions): Promise<ConfirmedInstall> {
  if (opts.expected.appSlug === undefined && opts.expected.accountLogin === undefined) {
    throw new Error(
      'waitForAppInstallation: `expected` must carry at least one of appSlug/accountLogin. An empty ' +
        'ExpectedIdentity ({}) would otherwise let the FIRST poll silently trust whatever install GitHub ' +
        'returns first — the exact false-consent hazard `expected` exists to prevent (macf#846 review 3a/3c). ' +
        "Supply the fleet owner's accountLogin at minimum.",
    );
  }

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const confirm = opts.confirm ?? confirmAppInstallation;
  const deadline = Date.now() + timeoutMs;
  let warnedUnexpectedTarget = false;

  let last: IdentityConfirmation;
  for (;;) {
    last = await confirm(opts.appId, opts.keyPath, opts.expected);
    if (last.status === 'confirmed') return last.install;

    if (last.status === 'installed-unexpected-target' && !warnedUnexpectedTarget) {
      warnedUnexpectedTarget = true;
      opts.onUnexpectedTarget?.(last.installs);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(waitForInstallTimeoutMessage(timeoutMs, last));
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
