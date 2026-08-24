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
}

export interface ResolvedVersions {
  readonly versions: VersionSet;
  readonly sources: {
    readonly cli: FetchStatus;
    readonly plugin: FetchStatus;
    readonly actions: FetchStatus;
  };
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
  try {
    const res = await proxyAwareFetch(`https://api.github.com/repos/${repo}/tags`, {
      headers: githubHeaders(),
    });
    if (!res.ok) return { status: classifyGithubError(res.status), value: null };
    const data = await res.json() as Array<{ name?: unknown }>;
    if (!Array.isArray(data)) return { status: 'invalid_response', value: null };

    const semverTags = data
      .map(t => typeof t.name === 'string' ? t.name : null)
      .filter((n): n is string => n !== null && /^v?\d+\.\d+\.\d+$/.test(n));

    if (semverTags.length === 0) return { status: 'not_published', value: null };

    semverTags.sort((a, b) => compareSemver(b, a)); // descending
    return { status: 'ok', value: semverTags[0]! };
  } catch {
    return { status: 'network_error', value: null };
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
  try {
    const res = await proxyAwareFetch('https://registry.npmjs.org/@groundnuty/macf', {
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 404) return { status: 'not_published', value: null };
    if (!res.ok) return { status: 'invalid_response', value: null };
    const data = await res.json() as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    if (typeof latest !== 'string' || !isValidSemver(latest)) {
      return { status: 'invalid_response', value: null };
    }
    return { status: 'ok', value: latest };
  } catch {
    return { status: 'network_error', value: null };
  }
}

/**
 * Fetch latest plugin version. Tries /releases/latest first, falls back
 * to /tags if no release exists (our marketplace uses bare tags).
 */
export async function fetchLatestPluginVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-marketplace';

  // Try /releases/latest first
  try {
    const res = await proxyAwareFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string') {
        const semver = tag.replace(/^v/, '');
        if (isValidSemver(semver)) return { status: 'ok', value: semver };
      }
      return { status: 'invalid_response', value: null };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null };
    // fall through to /tags (404 = no Release object; marketplace uses bare tags)
  } catch {
    return { status: 'network_error', value: null };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const semver = tagsResult.value.replace(/^v/, '');
  if (!isValidSemver(semver)) return { status: 'invalid_response', value: null };
  return { status: 'ok', value: semver };
}

/**
 * Fetch latest actions version. Tries /releases/latest first, falls back
 * to /tags. Returns major-only tag (v1.2.3 → v1) to match floating-major pins.
 */
export async function fetchLatestActionsVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-actions';

  try {
    const res = await proxyAwareFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string' && isValidActionsRef(tag)) {
        const m = /^v(\d+)/.exec(tag);
        return { status: 'ok', value: m ? `v${m[1]}` : tag };
      }
      return { status: 'invalid_response', value: null };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null };
  } catch {
    return { status: 'network_error', value: null };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const m = /^v(\d+)/.exec(tagsResult.value);
  if (!m) return { status: 'invalid_response', value: null };
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
 * Human-readable message for a non-ok fetch status. Used by callers to
 * print actionable warnings instead of the generic "network fetch failed".
 */
export function statusMessage(component: string, status: FetchStatus): string {
  switch (status) {
    case 'ok': return `${component}: ok`;
    case 'not_published': return `${component}: no published release found (using default)`;
    case 'network_error': return `${component}: network fetch failed (using default)`;
    case 'rate_limited': return `${component}: GitHub API rate-limited or unauthorized — set GH_TOKEN to raise the anon 60 req/h limit (using default)`;
    case 'invalid_response': return `${component}: unexpected response format (using default)`;
  }
}
