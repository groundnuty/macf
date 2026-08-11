/**
 * GitHub App-manifest `code` → App credentials exchange (DR-043 §D2 consent
 * gate 1, Slice 2b increment 2 of groundnuty/macf#838).
 *
 * TypeScript port of `tools/macf-bootstrap/.claude/scripts/bootstrap-exchange-manifest.sh`
 * (DR-035 §3/§5) — "mechanism promoted to code" per DR-043. The shell version
 * read the `code` off the browser URL via the chrome-devtools MCP; DR-043
 * replaces that with a localhost redirect the CLI catches itself
 * (`manifest-flow-server.ts`), which is what removes the browser-driving rail
 * entirely. The redemption half below is otherwise a faithful port, **including
 * its two hard-won guards**:
 *
 *   1. **Fail loud on non-2xx**, carrying GitHub's own error body plus the
 *      single-use/short-lived hint (a manifest code is one-shot, ~1h).
 *   2. **Result-invariant asserts (Pattern A)** — a 2xx carrying an empty
 *      `app_id` or `pem` is a FAILURE, not a success. Accepting it would write a
 *      useless vault entry and the missing private key would only surface much
 *      later, at first token mint.
 *
 * `POST /app-manifests/{code}/conversions` returns the App's id, slug, client
 * id/secret, webhook secret **and the private-key PEM** — so the key flows
 * straight into the vault (§D5) and is never manually downloaded.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The exact field set the vault consumes (DR-035 §5). `appId` is stringified (`.id` is a JSON number). */
export interface AppCredentials {
  readonly appId: string;
  readonly name: string;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  /** The App's private-key PEM. Secret — never log, never write outside the vault. */
  readonly pem: string;
}

/** Thrown when the exchange fails or returns a semantically-empty success. */
export class ManifestExchangeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManifestExchangeError';
    this.code = code;
  }
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * Normalize + validate a conversions response. Pure — exported for testing.
 *
 * Missing optional fields become empty strings (never collapse the object), but
 * `app_id` and `pem` are **load-bearing**: an empty either one throws, because a
 * "successful" exchange without a private key produces an App that can never
 * mint a token (the silent-fallback shape the shell guard was added for).
 */
export function normalizeConversionResponse(json: unknown): AppCredentials {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ManifestExchangeError(
      'exchange_malformed',
      'App-manifest exchange: conversions response was not a JSON object.',
    );
  }
  const o = json as Record<string, unknown>;
  const creds: AppCredentials = {
    appId: asString(o.id),
    name: asString(o.name),
    slug: asString(o.slug),
    clientId: asString(o.client_id),
    clientSecret: asString(o.client_secret),
    webhookSecret: asString(o.webhook_secret),
    pem: asString(o.pem),
  };
  if (creds.appId.length === 0) {
    throw new ManifestExchangeError(
      'exchange_no_app_id',
      'App-manifest exchange succeeded but returned no app_id — refusing to treat this as a created App.',
    );
  }
  if (creds.pem.length === 0) {
    throw new ManifestExchangeError(
      'exchange_no_pem',
      'App-manifest exchange succeeded but returned no private key (pem) — the App would be unable to ' +
        'mint any token. Refusing to record it.',
    );
  }
  return creds;
}

/** Best-effort extraction of a caught `execFile` error's captured stderr. */
function getStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const s = (err as { readonly stderr?: unknown }).stderr;
    if (typeof s === 'string') return s;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Redeem a manifest `code` for the created App's credentials via
 * `gh api --method POST /app-manifests/<code>/conversions` (operator-ambient
 * auth — this runs in the operator-privileged provisioning plane, DR-043 §D4).
 *
 * Throws {@link ManifestExchangeError} on any failure — never returns partial
 * credentials. The caller (`apply`) surfaces the message and aborts that agent's
 * provisioning rather than continuing with a keyless App.
 */
export async function exchangeManifestCode(code: string): Promise<AppCredentials> {
  if (code.trim().length === 0) {
    throw new ManifestExchangeError('exchange_no_code', 'App-manifest exchange: no code given.');
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'gh',
      ['api', '--method', 'POST', `/app-manifests/${code}/conversions`],
      { encoding: 'utf-8' },
    ));
  } catch (err) {
    throw new ManifestExchangeError(
      'exchange_http_error',
      `App-manifest exchange failed for the returned code. A manifest code is single-use and ` +
        `short-lived (~1h) — if it was already redeemed or has expired, re-run the flow to mint a ` +
        `fresh one. GitHub said: ${getStderr(err).trim()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ManifestExchangeError(
      'exchange_malformed',
      'App-manifest exchange: conversions response did not parse as JSON.',
    );
  }
  return normalizeConversionResponse(parsed);
}
