/**
 * Proxy-aware fetch — the one place every GitHub-API `fetch()` call site in
 * this codebase routes through.
 *
 * WHY (macf#1144): Node's built-in global `fetch` (undici under the hood)
 * does NOT read `HTTP_PROXY`/`HTTPS_PROXY` by default. `gh` (a Go binary;
 * `net/http` honors the env natively) and npm's registry client both work
 * transparently behind an operator's forward proxy; a bare `fetch()` call
 * silently bypasses it and fails with an opaque `TypeError: fetch failed`
 * (the real cause — `EAI_AGAIN`, `ENETUNREACH` — is nested in `err.cause`).
 * Because every OTHER tool on the same box succeeds, the symptom reads as
 * "this one host is unreachable" rather than "fetch ignores the proxy."
 *
 * Node 24+ ships an opt-in runtime fix (`NODE_USE_ENV_PROXY=1` /
 * `--use-env-proxy`), but this package's floor is Node 22 — `engines.node`
 * here and in `@groundnuty/macf` both say `>=22`, and CI's
 * `actions/setup-node` pins `node-version: 22`. Relying on a Node-24-only
 * flag against a Node-22 floor would be a silent no-op on the exact
 * versions this package is declared to support — the same class of defect
 * wearing a different hat. This module threads an explicit `undici`
 * `ProxyAgent` dispatcher through instead: it works on every Node version
 * back to whatever `undici` itself requires (7.x needs >=20.18.1, well
 * under the 22 floor), and — unlike the env-flag approach — is testable by
 * asserting the dispatcher was actually constructed/used, not merely that
 * a request "succeeded" (a machine with direct egress passes that
 * assertion either way; see `assert-the-wrong-path.md`).
 *
 * `process.env` mutation was considered and rejected: Node's global fetch
 * does not re-read `HTTP_PROXY`/`HTTPS_PROXY` per call on the < 24 runtimes
 * this package targets (there is no ambient env-driven proxy support to
 * mutate into), so an env-var-poke approach has nothing to attach to below
 * Node 24 — an explicit dispatcher is the only lever that works on the
 * floor version. Empirically verified (not assumed): a script that set
 * `process.env.NODE_USE_ENV_PROXY = '1'` and `process.env.HTTP_PROXY = …`
 * mid-run, before a fetch() call, produced the IDENTICAL `ENOTFOUND` as a
 * completely unconfigured run — the flag only took effect when present in
 * the environment the process was LAUNCHED with (confirmed by the same
 * script producing `ECONNREFUSED` instead, once `HTTP_PROXY` was passed at
 * launch, proving the launch-time config path is live and the mid-run
 * mutation path genuinely is not).
 *
 * Dispatchers are cached per resolved proxy URL (module-level, process
 * lifetime): `@groundnuty/macf-channel-server`'s `refresh-aware-client.ts`
 * wraps `createGitHubClient` — whose every call now flows through here —
 * and that process is long-lived (a whole Claude session; see
 * silent-fallback-hazards.md Instance 1's token-expiry sub-case, which
 * exists precisely because this process outlives a short CLI run). Without
 * caching, every registry heartbeat / `/sign` lookup would allocate a new
 * `ProxyAgent` — its own keep-alive socket pool and timers — that's never
 * closed. `@groundnuty/macf`'s own CLI invocations are short-lived
 * (O(1)-O(30) calls total) and wouldn't have shown this, which is exactly
 * why it needs stating rather than discovering later against the
 * long-lived consumer.
 */
import { ProxyAgent, type Dispatcher } from 'undici';

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * `NO_PROXY`/`no_proxy` matcher — comma-separated hostnames, each either an
 * exact host or a `.`-prefixed suffix (domain) match, or a bare `*` to
 * disable proxying for every request. Same convention `curl`/`gh` honor.
 */
function isNoProxyMatch(hostname: string, noProxy: string): boolean {
  const entries = noProxy
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  for (const entry of entries) {
    if (entry === '*') return true;
    const suffix = entry.startsWith('.') ? entry : `.${entry}`;
    if (hostname === entry || `.${hostname}`.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * `undici`'s `ProxyAgent` only understands `http:`/`https:` proxy URIs.
 * A `socks5:`/`socks5h:` value in `ALL_PROXY` is a normal `curl`/`git`
 * convention (this codebase's own dev boxes set `ALL_PROXY=socks5://…`
 * alongside `HTTP_PROXY`/`HTTPS_PROXY`) — `gh` handles it fine via Go's
 * proxy support, so treating it as a hard error here would invert the
 * exact fetch-vs-gh asymmetry macf#1144 is about. Unsupported schemes
 * degrade to "no proxy for this request" (the pre-fix, direct-fetch
 * behavior) rather than throwing — never worse than before the fix.
 */
function isSupportedProxyScheme(candidate: string): boolean {
  try {
    const scheme = new URL(candidate).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolves the proxy URL (if any) that should carry a request to
 * `targetUrl`, honoring `HTTPS_PROXY`/`HTTP_PROXY` (protocol-matched),
 * `ALL_PROXY` as a catch-all, and `NO_PROXY` exclusions — the same
 * variables `gh` already reads natively. Returns `undefined` when no proxy
 * applies (including an unsupported proxy scheme — see
 * {@link isSupportedProxyScheme}), which is the common case and leaves the
 * caller's behavior byte-for-byte unchanged (macf#1144 AC: no regression
 * when there is no proxy).
 *
 * Deliberately never logged anywhere in this module or its callers — a
 * proxy URL frequently carries embedded credentials
 * (`http://user:pass@host:port`).
 */
export function resolveProxyUrl(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const target = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;

  const noProxy = firstNonEmpty(env['NO_PROXY'], env['no_proxy']);
  if (noProxy !== undefined && isNoProxyMatch(target.hostname, noProxy)) return undefined;

  const protocolSpecific =
    target.protocol === 'https:'
      ? firstNonEmpty(env['HTTPS_PROXY'], env['https_proxy'])
      : firstNonEmpty(env['HTTP_PROXY'], env['http_proxy']);

  const candidate = firstNonEmpty(protocolSpecific, env['ALL_PROXY'], env['all_proxy']);
  if (candidate === undefined) return undefined;
  if (!isSupportedProxyScheme(candidate)) {
    // Loud-but-proceeds (never silent-fallback, per this repo's own
    // hazard catalog): tell the operator their proxy config for THIS
    // host isn't being used for GitHub calls, without ever printing the
    // (possibly credential-bearing) value itself — only its scheme.
    const scheme = (() => { try { return new URL(candidate).protocol; } catch { return '<unparseable>'; } })();
    console.error(
      `proxy-fetch: a proxy env var resolved to scheme "${scheme}" for ${target.hostname} — ` +
      'undici only supports http:/https: proxies; falling back to a direct (unproxied) connection.',
    );
    return undefined;
  }
  return candidate;
}

const dispatcherCache = new Map<string, Dispatcher>();

/**
 * Builds (or reuses) the `undici` dispatcher for `targetUrl`, or
 * `undefined` when no proxy applies. Cached per resolved proxy URL for the
 * lifetime of the process — see module doc for why an uncached
 * per-call `ProxyAgent` would leak in a long-lived consumer.
 *
 * Split out from {@link proxyAwareFetch} so a call site that builds its own
 * `RequestInit` in stages can still get a dispatcher without going through
 * the fetch wrapper.
 */
export function resolveProxyDispatcher(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  if (proxyUrl === undefined) return undefined;

  const cached = dispatcherCache.get(proxyUrl);
  if (cached !== undefined) return cached;

  const dispatcher = new ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Drop-in replacement for the global `fetch()` that honors
 * `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` + `NO_PROXY` when set, and is
 * IDENTICAL to a bare `fetch(url, init)` call when they are not — the
 * common case, unaffected by this change (macf#1144).
 */
export async function proxyAwareFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const dispatcher = resolveProxyDispatcher(url);
  if (dispatcher === undefined) return fetch(url, init);
  // The `undici` package's own `Dispatcher` type and the `undici-types`
  // copy bundled with `@types/node` (what the ambient global `fetch`'s
  // `RequestInit.dispatcher` is typed against) are two independently
  // versioned snapshots of the same shape — structurally compatible at
  // runtime (proven empirically: Node's built-in fetch accepts a
  // `ProxyAgent` built from the external `undici` package and genuinely
  // routes through it), but `tsc` sees a nominal mismatch on `compose()`
  // when the two packages drift a minor version apart. One targeted cast
  // at this single bridging point, not a widened `any` on the public API.
  return fetch(url, { ...init, dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']> });
}
