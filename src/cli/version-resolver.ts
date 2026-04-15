/**
 * Resolves latest stable versions for the three components pinned in
 * macf-agent.json: cli, plugin, actions. Each has a network fetcher
 * and a hardcoded fallback used when the network is unavailable.
 */

export interface VersionSet {
  readonly cli: string;
  readonly plugin: string;
  readonly actions: string;
}

export interface ResolvedVersions {
  readonly versions: VersionSet;
  readonly sources: {
    readonly cli: 'network' | 'fallback';
    readonly plugin: 'network' | 'fallback';
    readonly actions: 'network' | 'fallback';
  };
}

export const FALLBACK_VERSIONS: VersionSet = {
  cli: '0.1.0',
  plugin: '0.1.0',
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
 * Fetch latest CLI version from npm registry.
 * Returns null on network/parse error.
 */
export async function fetchLatestCliVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@macf/cli', {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    return typeof latest === 'string' && isValidSemver(latest) ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Fetch latest plugin version from GitHub releases.
 */
export async function fetchLatestPluginVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/repos/groundnuty/macf-marketplace/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name?: string };
    const tag = data.tag_name;
    if (typeof tag !== 'string') return null;
    const semver = tag.replace(/^v/, '');
    return isValidSemver(semver) ? semver : null;
  } catch {
    return null;
  }
}

/**
 * Fetch latest actions version from GitHub releases.
 * Returns major-only tag (e.g., "v1") to match the floating-major pin convention.
 */
export async function fetchLatestActionsVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/repos/groundnuty/macf-actions/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name?: string };
    const tag = data.tag_name;
    if (typeof tag !== 'string' || !isValidActionsRef(tag)) return null;
    const majorMatch = /^v(\d+)/.exec(tag);
    return majorMatch ? `v${majorMatch[1]}` : tag;
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
      cli: cli ?? FALLBACK_VERSIONS.cli,
      plugin: plugin ?? FALLBACK_VERSIONS.plugin,
      actions: actions ?? FALLBACK_VERSIONS.actions,
    },
    sources: {
      cli: cli !== null ? 'network' : 'fallback',
      plugin: plugin !== null ? 'network' : 'fallback',
      actions: actions !== null ? 'network' : 'fallback',
    },
  };
}
