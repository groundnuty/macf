/**
 * `confirmAppInstallation` — the DR-043 Amendment-A credential-bearing identity
 * read (Slice 2, groundnuty/macf#838). The ONE primitive reused at all three
 * identity call-sites (plan-confirm · `apply` install-poll · `apply`
 * confirm-before-create guard): given an App's numeric id + its private-key
 * PEM, mint an App JWT and ask GitHub `GET /app/installations` whether the App
 * exists and is installed **now**.
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
 * **A4 epistemic floor — present-detector ONLY.** A successful call proves
 * `present`; it can NEVER prove `absent`. A JWT-mint failure, a 401, an empty
 * install list, or a network error all resolve to `unconfirmable` (→ the
 * caller keeps its honest `unknown`), never `absent`.
 *
 * The JWT is signed by `gh token generate --jwt` (RS256 via `gh`, no Node
 * crypto reimpl) — the same mechanism `doctor.ts::fetchInstallationPermissions`
 * already uses. `parseAppInstallations` is pure + exported for unit testing;
 * the `gh`/`fetch` wrapper is a thin I/O leaf, untested per the observer
 * convention.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One confirmed installation, as surfaced by `GET /app/installations`. */
export interface ConfirmedInstall {
  /** `.app_id`, stringified (API returns a number) — pairs with `fleet.lock`'s string form. */
  readonly appId: string;
  /** `.id`, stringified — the installation id. */
  readonly installId: string;
  /** `.app_slug` — equals `deriveAppHandle(fleet, role)` for a correctly-paired PEM. */
  readonly appSlug: string;
}

/**
 * Result of a credential-bearing identity read.
 *   - `confirmed`      — App exists AND is installed; carries the live ids.
 *   - `app-no-install` — the JWT was valid (App exists) but 0 installs returned.
 *   - `unconfirmable`  — JWT mint failed / 401 / network / bad body. NEVER
 *                        `absent` (A4). The caller degrades to `unknown`.
 */
export type IdentityConfirmation =
  | { readonly status: 'confirmed'; readonly install: ConfirmedInstall }
  | { readonly status: 'app-no-install' }
  | { readonly status: 'unconfirmable' };

/**
 * Parse a `GET /app/installations` JSON body (an array of installation objects)
 * into confirmed installs. Pure + tolerant: a non-array, or entries missing
 * `id` / `app_id`, are skipped rather than thrown on. `id` + `app_id` arrive as
 * JSON numbers and are stringified.
 */
export function parseAppInstallations(json: unknown): ConfirmedInstall[] {
  if (!Array.isArray(json)) return [];
  const out: ConfirmedInstall[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const { id, app_id, app_slug } = item as Record<string, unknown>;
    if (id === undefined || id === null || app_id === undefined || app_id === null) continue;
    const installId = String(id);
    const appId = String(app_id);
    if (installId.length === 0 || appId.length === 0) continue;
    out.push({ appId, installId, appSlug: typeof app_slug === 'string' ? app_slug : '' });
  }
  return out;
}

/**
 * Confirm an App's installation live via PEM→App-JWT→`GET /app/installations`.
 * `appId` mints the JWT (`iss`); `keyPath` is the App's private-key PEM (from
 * the vault §D5, or an explicit key path — DR-043 A1). NEVER throws — every
 * failure resolves to `unconfirmable` (A4: present-detector only).
 *
 * Returns the FIRST confirmed install (agent Apps install on exactly one
 * account); callers cross-check `install.appSlug` / `install.appId` against the
 * expected derived handle + any `fleet.lock` record to detect drift (A2).
 */
export async function confirmAppInstallation(appId: string, keyPath: string): Promise<IdentityConfirmation> {
  let jwt: string;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['token', 'generate', '--app-id', appId, '--key', keyPath, '--jwt', '--token-only'],
      { encoding: 'utf-8' },
    );
    jwt = stdout.trim();
  } catch {
    return { status: 'unconfirmable' };
  }
  // A malformed/empty JWT (e.g. an error string leaked to stdout) is unconfirmable.
  if (!jwt.startsWith('eyJ')) return { status: 'unconfirmable' };

  let response: Response;
  try {
    response = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
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
  const [first] = parseAppInstallations(body);
  if (first === undefined) return { status: 'app-no-install' };
  return { status: 'confirmed', install: first };
}
