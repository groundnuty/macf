/**
 * Resolves latest stable versions for the three components pinned in
 * macf-agent.json: cli, plugin, actions. Each has a network fetcher
 * and a hardcoded fallback used when the lookup fails.
 *
 * Distinguishes:
 *   - ok            → value fetched successfully
 *   - not_published → HTTP 404 (package/release doesn't exist yet)
 *   - network_error → fetch threw (connection refused, timeout, DNS, ...)
 *   - rate_limited  → HTTP 403/429 from GitHub API, typically anon
 *                     rate-limit (60 req/h). See authHeaders() — if
 *                     `GH_TOKEN` is set in the environment the fetcher
 *                     uses it automatically (5000 req/h), so this
 *                     status fires only when anon AND quota-exhausted.
 *   - invalid_response → HTTP 200 but unparseable/schema-invalid
 *
 * The caller can produce clearer warnings than the old single "network
 * fetch failed" message. GitHub fetchers fall back from /releases/latest
 * to /tags so bare-tag versioning (no GitHub Release object) still works.
 *
 * `FetchResult.detail` (macf#777) carries the host + — for `network_error`
 * specifically — the underlying `err.cause` reason, since undici's
 * `TypeError: fetch failed` message is ALWAYS the literal string "fetch
 * failed" and is worthless on its own; `statusMessage()`'s optional 3rd arg
 * appends it. A caller that drops `.detail` (e.g. `resolveLatestVersions()`'s
 * `sources` field, which is `FetchStatus`-only) is unaffected — additive,
 * not a breaking change to the existing status classification.
 */

import { PACKAGE_VERSION } from '../package-version.js';
import { compareSemver, proxyAwareFetch } from '@groundnuty/macf-core';

// Re-exported for backward compatibility: `compareSemver` originated here, but
// now lives in macf-core so the channel-server's collision check (groundnuty/
// macf#424) shares one implementation. Existing importers keep working.
export { compareSemver };

export interface VersionSet {
  readonly cli: string;
  readonly plugin: string;
  readonly actions: string;
}

export type FetchStatus = 'ok' | 'not_published' | 'network_error' | 'rate_limited' | 'invalid_response';

/**
 * GitHub API headers. Uses `GH_TOKEN` from env if present — raises the
 * anonymous 60 req/h limit to 5000 req/h. Primary #186 fix: operators
 * on shared IPs (Tailscale, CI runners) were burning anon quota across
 * sessions + getting opaque "invalid_response" on subsequent runs.
 * `claude.sh` exports GH_TOKEN before `macf update` invocations, so
 * the token is available in the typical run path.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
  const token = process.env['GH_TOKEN'];
  if (token !== undefined && token !== '' && token !== 'null') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Map a non-ok GitHub API response to the appropriate FetchStatus.
 * 403/429 (rate-limit) and 401 (bad auth) both surface as `rate_limited`
 * — operator-facing warning distinguishes them from other schema/5xx
 * errors that come back as `invalid_response`.
 */
function classifyGithubError(status: number): FetchStatus {
  if (status === 404) return 'not_published';
  if (status === 401 || status === 403 || status === 429) return 'rate_limited';
  return 'invalid_response';
}

export interface FetchResult {
  readonly status: FetchStatus;
  readonly value: string | null;
  /**
   * Diagnostic detail for a non-'ok' status (macf#777) — `<host>: <reason>`.
   * `<reason>` is `err.cause.code` (a Node system-error code like `ENOTFOUND`
   * / `ECONNREFUSED`) or `.message` when the fetch itself threw
   * (`network_error` — undici's `TypeError: fetch failed` message is always
   * the literal string "fetch failed", worthless without the nested cause);
   * for a non-ok HTTP response (`not_published` / `rate_limited` /
   * `invalid_response`) it is just the host, since the status code itself
   * already carries the reason. `undefined` on 'ok' — nothing to report.
   */
  readonly detail?: string;
}

/**
 * Extracts the target host from a fetch URL for diagnostic messages — never
 * throws (an unparseable URL just echoes back unchanged).
 */
function fetchHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Turns a caught fetch() rejection into a `"<host>: <reason>"` diagnostic
 * (macf#777). Node's global `fetch` (undici) throws a bare `TypeError: fetch
 * failed` on any network-level failure — the message is ALWAYS the literal
 * string "fetch failed"; the actual reason (DNS failure, connection refused,
 * timeout, ...) is nested in `err.cause` as a Node system-error-ish object
 * with `.code`. Surfacing that code verbatim (never wrapped in an asserted
 * diagnosis) lets the reader distinguish "no route at all" from "a real
 * remote outage" — this function cannot itself tell those apart, so it must
 * not claim to. Same extraction `github-client.ts`'s `fetchOrThrow` already
 * uses for the registry-write path; duplicated here (not imported) to keep
 * this CLI-side module's only macf-core dependency the existing
 * `proxyAwareFetch`, not a second cross-package coupling for one helper.
 */
function describeFetchFailure(url: string, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
  const causeMessage = typeof cause?.message === 'string' ? cause.message : undefined;
  const reason = causeCode ?? causeMessage ?? error.message;
  return `${fetchHost(url)}: ${reason}`;
}

export interface ResolvedVersions {
  readonly versions: VersionSet;
  readonly sources: {
    readonly cli: FetchStatus;
    readonly plugin: FetchStatus;
    readonly actions: FetchStatus;
  };
}

/**
 * Thrown by {@link resolveLockstepVersionsOrThrow} — a real pin was expected
 * (no explicit version was available to the caller) and the network lookup
 * failed. `code` is always `'lockstep_versions_unresolvable'`; `message`
 * names, per failed component, why the lookup failed and which hardcoded
 * {@link FALLBACK_VERSIONS} value this function refused to silently return.
 */
export class VersionResolutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VersionResolutionError';
    this.code = code;
  }
}

export const FALLBACK_VERSIONS: VersionSet = {
  cli: PACKAGE_VERSION,
  // Bumped 2026-04-26 (testbed#229 + macf#259): v0.1.0 plugin manifest
  // shipped `mcpServers.macf-agent.command: "node"` against
  // `${CLAUDE_PLUGIN_ROOT}/dist/server.js`, which fails with
  // `Cannot find package '@modelcontextprotocol/sdk'` when Claude Code's
  // plugin loader spawns it (deps land in CLAUDE_PLUGIN_DATA, not
  // PLUGIN_ROOT). v0.2.0 cut over to `npx -y @groundnuty/macf-channel-server`
  // (DR-022 npm-dispatch), which sidesteps dep-resolution entirely.
  // When the version-resolver's network fetch fails (anon GitHub API
  // rate limit, 60 req/h — bites bootstrap scripts that don't preset
  // GH_TOKEN before `macf init`), this fallback was sticking consumers
  // on the broken v0.1.0. Bumped to '0.2.0' so the failure mode lands
  // on a working plugin.
  plugin: '0.2.0',
  actions: 'v1',
};

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
export const ACTIONS_TAG_PATTERN = /^v\d+(\.\d+){0,2}$/;

export function isValidSemver(v: string): boolean {
  return SEMVER_PATTERN.test(v);
}

export function isValidActionsRef(v: string): boolean {
  return ACTIONS_TAG_PATTERN.test(v) || v === 'main';
}

/**
 * Fetch the highest semver tag from a GitHub repo's /tags list.
 * Returns the tag name (with leading 'v' if present) or null with reason.
 */
async function fetchHighestTag(repo: string): Promise<FetchResult> {
  const url = `https://api.github.com/repos/${repo}/tags`;
  try {
    const res = await proxyAwareFetch(url, { headers: githubHeaders() });
    if (!res.ok) return { status: classifyGithubError(res.status), value: null, detail: fetchHost(url) };
    const data = await res.json() as Array<{ name?: unknown }>;
    if (!Array.isArray(data)) return { status: 'invalid_response', value: null, detail: fetchHost(url) };

    const semverTags = data
      .map(t => typeof t.name === 'string' ? t.name : null)
      .filter((n): n is string => n !== null && /^v?\d+\.\d+\.\d+$/.test(n));

    if (semverTags.length === 0) return { status: 'not_published', value: null, detail: fetchHost(url) };

    semverTags.sort((a, b) => compareSemver(b, a)); // descending
    return { status: 'ok', value: semverTags[0]! };
  } catch (err) {
    return { status: 'network_error', value: null, detail: describeFetchFailure(url, err) };
  }
}

/**
 * Fetch latest CLI version from npm registry.
 *
 * The package name is `@groundnuty/macf` (per `packages/macf/package.json`).
 * Pre-#335 this fetched `@macf/cli` — a typo from the original P5 design
 * before the `@groundnuty` org scope landed; that URL always 404'd, so
 * the resolver flagged the cli as `not_published` even when the version
 * was on npm. The cli pin then silently skipped bump (status filter in
 * `update.ts` excludes non-`'update'` rows). 4 CV workspaces hit the
 * stale-pin state on 2026-05-01 cycle. Fix: use the correct package URL.
 */
export async function fetchLatestCliVersion(): Promise<FetchResult> {
  const url = 'https://registry.npmjs.org/@groundnuty/macf';
  try {
    const res = await proxyAwareFetch(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) return { status: 'not_published', value: null, detail: fetchHost(url) };
    if (!res.ok) return { status: 'invalid_response', value: null, detail: fetchHost(url) };
    const data = await res.json() as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    if (typeof latest !== 'string' || !isValidSemver(latest)) {
      return { status: 'invalid_response', value: null, detail: fetchHost(url) };
    }
    return { status: 'ok', value: latest };
  } catch (err) {
    return { status: 'network_error', value: null, detail: describeFetchFailure(url, err) };
  }
}

/**
 * Fetch latest plugin version. Tries /releases/latest first, falls back
 * to /tags if no release exists (our marketplace uses bare tags).
 */
export async function fetchLatestPluginVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-marketplace';
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  // Try /releases/latest first
  try {
    const res = await proxyAwareFetch(url, { headers: githubHeaders() });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string') {
        const semver = tag.replace(/^v/, '');
        if (isValidSemver(semver)) return { status: 'ok', value: semver };
      }
      return { status: 'invalid_response', value: null, detail: fetchHost(url) };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null, detail: fetchHost(url) };
    // fall through to /tags (404 = no Release object; marketplace uses bare tags)
  } catch (err) {
    return { status: 'network_error', value: null, detail: describeFetchFailure(url, err) };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const semver = tagsResult.value.replace(/^v/, '');
  if (!isValidSemver(semver)) return { status: 'invalid_response', value: null, detail: fetchHost(url) };
  return { status: 'ok', value: semver };
}

/**
 * Fetch latest actions version. Tries /releases/latest first, falls back
 * to /tags. Returns major-only tag (v1.2.3 → v1) to match floating-major pins.
 */
export async function fetchLatestActionsVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-actions';
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const res = await proxyAwareFetch(url, { headers: githubHeaders() });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string' && isValidActionsRef(tag)) {
        const m = /^v(\d+)/.exec(tag);
        return { status: 'ok', value: m ? `v${m[1]}` : tag };
      }
      return { status: 'invalid_response', value: null, detail: fetchHost(url) };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null, detail: fetchHost(url) };
  } catch (err) {
    return { status: 'network_error', value: null, detail: describeFetchFailure(url, err) };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const m = /^v(\d+)/.exec(tagsResult.value);
  if (!m) return { status: 'invalid_response', value: null, detail: fetchHost(url) };
  return { status: 'ok', value: `v${m[1]}` };
}

/**
 * True for a fully-pinned immutable macf-actions tag (`vX.Y.Z`, three
 * components). A bare-major (`v3`) or bare-minor (`v3.4`) ref is a FLOATING
 * pointer GitHub re-points as new releases land — NOT immutable.
 */
export function isImmutableActionsTag(v: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(v);
}

/**
 * Resolve a floating macf-actions ref (`v3`, `v3.4`) to the latest immutable
 * full tag WITHIN that major (and minor, if given) — e.g. `v3` → `v3.4.1`.
 *
 * The router pin must be immutable so a fleet never silently receives a
 * behavioral change within a major (macf#797 — floating `@v3` currently even
 * lags `@v3.4.1`; operator decision 2026-07-05). This resolves "the latest at
 * bootstrap time" so the generated router is born pinned.
 *
 * - An already-immutable tag (`v3.4.1`) is returned unchanged (no network).
 * - `main` returns null (a dev ref; the caller leaves it as-is).
 * - A floating ref queries macf-actions' /tags, filters to `vMAJOR.*.*`
 *   (and `.MINOR.` when the ref carries a minor), and returns the highest.
 * - Any fetch failure / no match returns null so the caller can WARN + keep
 *   the floating ref rather than hard-fail (repo-init tolerates offline).
 */
export async function resolveActionsRefToFullTag(ref: string): Promise<string | null> {
  if (isImmutableActionsTag(ref)) return ref;
  const m = /^v(\d+)(?:\.(\d+))?$/.exec(ref);
  if (!m) return null; // 'main' or any non-`vMAJOR[.MINOR]` ref
  const prefix = m[2] !== undefined ? `v${m[1]}.${m[2]}.` : `v${m[1]}.`;
  try {
    const res = await proxyAwareFetch('https://api.github.com/repos/groundnuty/macf-actions/tags', {
      headers: githubHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ name?: unknown }>;
    if (!Array.isArray(data)) return null;
    const matching = data
      .map(t => (typeof t.name === 'string' ? t.name : null))
      .filter((n): n is string => n !== null && /^v\d+\.\d+\.\d+$/.test(n) && n.startsWith(prefix));
    if (matching.length === 0) return null;
    matching.sort((a, b) => compareSemver(b, a)); // descending
    return matching[0]!;
  } catch {
    return null;
  }
}

/**
 * Resolve latest versions for all three components, falling back on error.
 * All three fetches run in parallel.
 */
export async function resolveLatestVersions(): Promise<ResolvedVersions> {
  const [cli, plugin, actions] = await Promise.all([
    fetchLatestCliVersion(),
    fetchLatestPluginVersion(),
    fetchLatestActionsVersion(),
  ]);

  return {
    versions: {
      cli: cli.value ?? FALLBACK_VERSIONS.cli,
      plugin: plugin.value ?? FALLBACK_VERSIONS.plugin,
      actions: actions.value ?? FALLBACK_VERSIONS.actions,
    },
    sources: {
      cli: cli.status,
      plugin: plugin.status,
      actions: actions.status,
    },
  };
}

/**
 * The human-readable reason a non-'ok' {@link FetchStatus} failed — no
 * component name, no "(using default)" suffix, no detail. Shared by
 * {@link statusMessage} (the warn-and-degrade wording every existing caller
 * depends on byte-for-byte) and {@link resolveLockstepVersionsOrThrow}'s
 * loud-failure message (macf#1406), so the two can never describe the same
 * status differently.
 */
function fetchFailureReason(status: FetchStatus): string {
  switch (status) {
    case 'ok': return 'ok';
    case 'not_published': return 'no published release found';
    case 'network_error': return 'network fetch failed';
    case 'rate_limited': return 'GitHub API rate-limited or unauthorized — set GH_TOKEN to raise the anon 60 req/h limit';
    case 'invalid_response': return 'unexpected response format';
  }
}

/**
 * Human-readable message for a non-ok fetch status. Used by callers to
 * print actionable warnings instead of the generic "network fetch failed".
 *
 * `detail` (macf#777, optional — 3rd-arg addition, existing 2-arg call sites
 * unaffected) is `FetchResult.detail`: the host + (for `network_error`) the
 * underlying `err.cause` reason. Appended when present so the operator sees
 * WHICH endpoint rejected the call and WHY, not just a status label.
 */
export function statusMessage(component: string, status: FetchStatus, detail?: string): string {
  const base = status === 'ok'
    ? `${component}: ok`
    : `${component}: ${fetchFailureReason(status)} (using default)`;
  return detail ? `${base} — ${detail}` : base;
}

/**
 * Resolves `{cli, plugin, actions}` for a caller that needs every value to
 * actually BE a live pin — never {@link FALLBACK_VERSIONS} (macf#1406,
 * DR-044 Decision 6: fail loud, fail fast, "one reason, once"). Unlike
 * {@link resolveLatestVersions}, `plugin` is NEVER independently looked up
 * against the marketplace repo — it is DERIVED from `cli`, in lockstep,
 * because `release.sh::cmd_marketplace` always bumps the marketplace
 * `plugin.json` to the SAME `VERSION` the CLI release uses. Deriving it
 * rather than fetching it separately closes two things at once: one fewer
 * network call, and no possibility of the two independent lookups landing
 * on different values (a marketplace tag pushed a few seconds before/after
 * the matching npm publish, or one of the two endpoints failing while the
 * other succeeds).
 *
 * `actions` stays an independent lookup — its versioning is genuinely
 * decoupled from the CLI/plugin pair (`vX` major-only floating tags on a
 * separate release cadence).
 *
 * On any lookup failure, throws {@link VersionResolutionError} naming, per
 * failed component, why the fetch failed and which hardcoded
 * {@link FALLBACK_VERSIONS} value this function refused to silently return
 * — never the "print a warning to stderr and keep going" degrade
 * {@link resolveLatestVersions} performs. That warn-and-degrade path stays
 * exactly as-is and is UNCHANGED by this addition — it is the deliberate
 * offline-default `macf init`/`macf update` rely on (see
 * {@link FALLBACK_VERSIONS}'s own doc for why landing on a *working* plugin
 * matters for an operator genuinely offline). This function is for the one
 * caller (`macf fleet deploy`, via `bootstrap/fleet-deploy.ts`) where a
 * silently-wrong pin becomes an unattended, unguarded agent workspace with
 * nobody watching stderr — see `silent-fallback-hazards.md` Instance 17's
 * "assert the result, or degrade to unknown — never silently substitute a
 * default" floor, applied here to a version pin instead of a health check.
 */
export async function resolveLockstepVersionsOrThrow(): Promise<VersionSet> {
  const [cli, actions] = await Promise.all([fetchLatestCliVersion(), fetchLatestActionsVersion()]);

  const failures: string[] = [];
  if (cli.status !== 'ok') {
    const detail = cli.detail ? ` (${cli.detail})` : '';
    failures.push(
      `  - cli+plugin: ${fetchFailureReason(cli.status)}${detail} — refusing the hardcoded fallback ` +
        `("${FALLBACK_VERSIONS.cli}" / "${FALLBACK_VERSIONS.plugin}"; plugin locksteps to cli, so a cli ` +
        'lookup failure means plugin has no real pin either)',
    );
  }
  if (actions.status !== 'ok') {
    const detail = actions.detail ? ` (${actions.detail})` : '';
    failures.push(
      `  - actions: ${fetchFailureReason(actions.status)}${detail} — refusing the hardcoded fallback "${FALLBACK_VERSIONS.actions}"`,
    );
  }
  if (failures.length > 0) {
    throw new VersionResolutionError(
      'lockstep_versions_unresolvable',
      'fleet deploy: version resolution failed — refusing to silently pin the hardcoded default ' +
        `versions, since an unattended deploy landing on a mismatched pin is worse than an explicit ` +
        `failure naming exactly what to fix:\n${failures.join('\n')}`,
    );
  }

  return { cli: cli.value!, plugin: cli.value!, actions: actions.value! };
}
