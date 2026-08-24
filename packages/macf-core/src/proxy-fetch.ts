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
 * floor version.
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
 * Resolves the proxy URL (if any) that should carry a request to
 * `targetUrl`, honoring `HTTPS_PROXY`/`HTTP_PROXY` (protocol-matched),
 * `ALL_PROXY` as a catch-all, and `NO_PROXY` exclusions — the same
 * variables `gh` already reads natively. Returns `undefined` when no proxy
 * applies, which is the common case and leaves the caller's behavior
 * byte-for-byte unchanged (macf#1144 AC: no regression when there is no
 * proxy).
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

  return firstNonEmpty(protocolSpecific, env['ALL_PROXY'], env['all_proxy']);
}

/**
 * Builds the `undici` dispatcher for `targetUrl`, or `undefined` when no
 * proxy applies. Split out from {@link proxyAwareFetch} so a call site that
 * builds its own `RequestInit` in stages can still get a dispatcher without
 * going through the fetch wrapper.
 */
export function resolveProxyDispatcher(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  return proxyUrl === undefined ? undefined : new ProxyAgent(proxyUrl);
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
