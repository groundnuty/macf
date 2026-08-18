/**
 * The ephemeral localhost listener for GitHub's App-manifest flow — DR-043 §D2
 * consent gate 1 (Slice 2b increment 2, groundnuty/macf#838), extended
 * (groundnuty/macf#952) to ALSO serve consent gate 2's install interstitial —
 * see {@link startInstallInterstitial} below.
 *
 * **This is what removes the browser-driving rail.** The DR-035 skill drove the
 * operator's Chrome through the manifest flow via the chrome-devtools MCP and
 * read the `?code=` off the post-redirect URL — which required a default-deny
 * URL allowlist precisely because an LLM was steering a logged-in browser.
 * Here the CLI binds an ephemeral `127.0.0.1` port, serves a self-submitting
 * form, and GitHub redirects the code back to it. The operator's only action is
 * clicking **Create GitHub App** in their own normal browser. Deterministic
 * code cannot wander off-script, so no allowlist rail is needed.
 *
 * Binding is `127.0.0.1`-only (never `0.0.0.0`): the callback carries a
 * credential-bearing one-shot code, so the listener must not be reachable off
 * the host. The server is single-shot — it closes as soon as it has the code.
 *
 * **groundnuty/macf#952 — why gate 2 reuses this SAME ephemeral-listener
 * primitive rather than a new implementation.** The operator's first live
 * install picked GitHub's "All repositories" over "Only select repositories"
 * because nothing told them which to choose UNTIL `apply` refused the result
 * afterward (#943's `validateRunnerOpsInstall` backstop, unchanged by this
 * file). Sending the operator straight to GitHub's own install page leaves us
 * with zero control over what they see before they click. The fix is the same
 * shape as gate 1: serve OUR OWN page first (the instruction), then link out.
 * {@link bindEphemeralListener} is the ONE `createServer` + `listen(0,
 * '127.0.0.1', …)` primitive both {@link startManifestFlow} (gate 1) and
 * {@link startInstallInterstitial} (gate 2) build on — no new dependency, no
 * second server *implementation*. A second live `Server` OBJECT per gate is
 * unavoidable (gate 1's listener is already closed by the time gate 2 opens
 * on the create path, and the resume-install path — `apply-agent.ts`'s
 * `decision.action === 'resume-install'` — has no gate-1 listener to reuse at
 * all, since gate 1 never ran that turn) — sharing the bind/close CODE is
 * what "reuse it" means here.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHubAppManifest } from './app-manifest.js';

/**
 * Bind ONE ephemeral `127.0.0.1` HTTP listener — the shared primitive behind
 * both {@link startManifestFlow} and {@link startInstallInterstitial} (see
 * module doc). The caller attaches its own `'request'` handler AFTER bind
 * (both current callers need the bound port to build the content they serve
 * — gate 1's `redirect_url`, gate 2's own-URL-independent content doesn't
 * strictly need it, but the symmetry keeps one bind/attach shape for both).
 */
async function bindEphemeralListener(): Promise<{ readonly server: Server; readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 ONLY — see module doc.
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  };
  return { server, baseUrl, close };
}

/** Where the manifest form POSTs: personal-account vs organization App creation. */
export function manifestFormAction(owner: { readonly account: string; readonly type: 'user' | 'org' }): string {
  return owner.type === 'org'
    ? `https://github.com/organizations/${owner.account}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

/** Minimal HTML escape for embedding the manifest JSON in a form value. */
export function escapeHtmlAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Total consent gates per identity (create-manifest + install) — DR-043 §D2. Shared by both pages' "gate N of GATE_TOTAL" numbering (groundnuty/macf#952). */
export const GATE_TOTAL = 2;

/**
 * The self-submitting form GitHub's manifest flow requires: a POST to
 * `settings/apps/new` with the manifest JSON in a `manifest` field. Pure —
 * exported for testing.
 *
 * **groundnuty/macf#971 — a BARE redirect, not an instruction surface.**
 * groundnuty/macf#952 (via #962) put the gate-1 explanation ON this page —
 * but this page's `<script>` (below) submits it before a human can read a
 * single word, so the explanation was unreadable BY CONSTRUCTION. The
 * operator confirmed it live: "if I cannot see them, I'm not sure why they
 * are there." The explanation now lives in the terminal line
 * `apply-agent.ts::applyIdentity` prints immediately before `openUrl` —
 * the surface the operator actually reads — and this page keeps only
 * what a human might need in the RARE case auto-submit doesn't fire
 * (JS disabled, a slow/failed script load): identifying context + the
 * manual "Continue to GitHub" fallback button. No prose paragraph that
 * only the auto-submit race would ever hide from view.
 */
export function renderManifestForm(manifest: GitHubAppManifest, action: string, role: string): string {
  const json = escapeHtmlAttribute(JSON.stringify(manifest));
  const name = escapeHtmlAttribute(manifest.name);
  const roleEsc = escapeHtmlAttribute(role);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Consent gate 1 of ${String(GATE_TOTAL)} — creating ${name}</title></head>
<body>
<h1>Consent gate 1 of ${String(GATE_TOTAL)} — role "${roleEsc}"</h1>
<p>Creating GitHub App: <strong>${name}</strong></p>
<p>If this page does not advance on its own, press the button below.</p>
<form id="macf-manifest-form" method="post" action="${escapeHtmlAttribute(action)}">
  <input type="hidden" name="manifest" value="${json}">
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('macf-manifest-form').submit();</script>
</body></html>`;
}

/** The page shown after GitHub redirects back with the code. */
export function renderCallbackPage(appName: string, ok: boolean): string {
  return ok
    ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtmlAttribute(appName)} created</title></head>
<body><h1>✅ ${escapeHtmlAttribute(appName)} created</h1>
<p>You can close this tab and return to the terminal.</p></body></html>`
    : `<!doctype html><html><head><meta charset="utf-8"><title>No code received</title></head>
<body><h1>⚠️ No manifest code in the redirect</h1>
<p>Return to the terminal — the CLI will report the failure.</p></body></html>`;
}

export interface ManifestFlowHandles {
  /** Open THIS in a browser to start the flow (serves the self-submitting form). */
  readonly startUrl: string;
  /** The redirect_url the manifest must declare — must match what was submitted. */
  readonly redirectUrl: string;
  /** Resolves with the one-shot `code`; rejects on timeout or a code-less callback. */
  waitForCode: () => Promise<string>;
  /** Idempotent shutdown. Always call (e.g. in a `finally`). */
  close: () => Promise<void>;
}

export interface StartManifestFlowOptions {
  /**
   * Builds the manifest to serve, given the listener's OWN callback URL.
   * Called only after binding — the port (and therefore `redirectUrl`) isn't
   * known before then. This is what makes "the `redirect_url` embedded in the
   * served manifest" and "the URL GitHub will actually redirect the code to"
   * the same value BY CONSTRUCTION, rather than by caller discipline: GitHub
   * echoes the one-shot `code` to the `redirect_url` field declared INSIDE the
   * submitted manifest, not to wherever the form happened to be served from
   * (groundnuty/macf#843 — a pre-built manifest with a placeholder/stale
   * `redirect_url` serves fine but the callback never arrives, and
   * `waitForCode()` silently times out after 10 minutes).
   */
  readonly buildManifest: (redirectUrl: string) => GitHubAppManifest;
  readonly formAction: string;
  /** How long to wait for the operator's click before giving up. Default 10 min. */
  readonly timeoutMs?: number;
  /** The role this App is being created for — rendered into the served page's `<h1>` (identifying label only; the explanation is terminal-only, groundnuty/macf#971). */
  readonly role: string;
}

/**
 * Start the single-shot manifest-flow listener on an ephemeral 127.0.0.1 port.
 *
 * Binds FIRST, then calls `opts.buildManifest(redirectUrl)` with the
 * now-known callback URL, and serves exactly that manifest for the lifetime of
 * this listener — so the manifest GitHub receives and the callback URL this
 * server listens on can never diverge. `redirectUrl` is also returned on the
 * handles for callers/tests that want to assert the two match without
 * re-deriving the URL themselves.
 */
export async function startManifestFlow(opts: StartManifestFlowOptions): Promise<ManifestFlowHandles> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // codePromise is created eagerly at bind time but its real consumer —
  // waitForCode() — may attach much later, or never (e.g. the caller aborts
  // before calling it). A rejection (code-less callback, or the timeout below)
  // firing before anything is listening is an unhandled rejection at the
  // process level. This inert catch only exists to keep the promise settled;
  // waitForCode() still awaits `codePromise` directly and surfaces the same
  // rejection to its own caller.
  codePromise.catch(() => {
    /* swallowed on purpose — see comment above; waitForCode() re-surfaces it */
  });

  // No request listener yet — the handler below needs the manifest, which in
  // turn needs `redirectUrl`, which only exists after `listen()` resolves.
  const { server, baseUrl: base, close } = await bindEphemeralListener();
  const redirectUrl = `${base}/callback`;

  // Build the REAL manifest now — `redirectUrl` is the listener's own
  // callback URL, not a placeholder chosen before the port existed (#843).
  const manifest = opts.buildManifest(redirectUrl);

  // Attached synchronously, in the same tick as `listen()` resolving — no
  // request can reach the server before this fires (nothing outside this
  // function has the URL yet), so `manifest` is never read uninitialized.
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackPage(manifest.name, Boolean(code)));
      if (code) resolveCode(code);
      else rejectCode(new Error('GitHub redirected to the callback without a `code` parameter.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderManifestForm(manifest, opts.formAction, opts.role));
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return {
    startUrl: `${base}/`,
    redirectUrl,
    waitForCode: () => {
      const timer = setTimeout(() => {
        rejectCode(
          new Error(
            `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for the GitHub App-manifest ` +
              'callback. The operator must click "Create GitHub App" in the opened browser tab. If the browser ' +
              // Re-print the URL in the failure message itself — a live
              // provisioning run showed `openUrl()` can silently misfire (the
              // process exits 0 but no tab actually appears), and the timeout
              // is exactly the moment the operator most needs a copy/
              // pasteable fallback. `startUrl` (== `${base}/`, above) is
              // captured by this closure at bind time, so it's always the
              // real listener URL, not a placeholder.
              `never opened (or you closed it), open this URL yourself: ${base}/`,
          ),
        );
      }, timeoutMs);
      // `.finally()` (not async/await) so `result` is the actual promise handed
      // to the caller — letting us attach the same inert-catch protection this
      // function's own promise needs. `codePromise` rejecting is guarded by the
      // eager catch above, but `result` is a *freshly created* promise every
      // call; the caller (e.g. `await fetch(...); await expect(waitForCode())`)
      // often has a genuine async gap between receiving it and attaching their
      // own `.then()`/`.catch()`/`await`. If `result` rejects inside that gap,
      // it is — independently of `codePromise` — its own unhandled rejection.
      // Multiple handlers on one promise don't interfere with each other, so
      // this inert catch doesn't change what the real caller observes.
      const result = codePromise.finally(() => { clearTimeout(timer); });
      result.catch(() => {
        /* swallowed on purpose — see comment above; the caller's own await/.then/.catch on this same promise still sees the rejection */
      });
      return result;
    },
    close,
  };
}

// --- Consent gate 2's install interstitial (groundnuty/macf#952) ---

export interface InstallInterstitialOptions {
  /** The role this identity is being installed for (e.g. `code-agent`, `runner-ops`). */
  readonly role: string;
  /** The App's slug/name, for display only. */
  readonly appName: string;
  /** GitHub's real install page — what the page's button links to. NEVER opened directly by the caller; this page is. */
  readonly installUrl: string;
  /**
   * The EXACT repos to select on GitHub's page — literal names, never a
   * class description (groundnuty/macf#952: "'this fleet's repos' is not
   * actionable at a dropdown"). Rendered in `owner/repo` form (unambiguous)
   * with the bare repo name — the form GitHub's own per-account repo picker
   * uses — called out first.
   */
  readonly repos: readonly string[];
  /** One sentence on why "Only select repositories" matters for THIS identity (varies by permission set — see `apply-agent.ts::installWhyText`). */
  readonly whyText: string;
  readonly gateNumber: number;
  readonly gateTotal: number;
}

/** `owner/repo` -> `repo` (the form GitHub's own per-account repository picker lists repos in). Falls back to the full string when there's no `/`. */
function repoShortName(fullName: string): string {
  const i = fullName.lastIndexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

/**
 * The gate-2 interstitial — served on OUR listener, BEFORE the operator ever
 * reaches GitHub's install page. Pure — exported for testing.
 *
 * **Never renders a secret.** {@link InstallInterstitialOptions} carries no
 * credential field at all (role/appName/installUrl/repos/whyText are all
 * plan-level facts, not secrets) — structurally, not just by convention.
 */
export function renderInstallInterstitial(opts: InstallInterstitialOptions): string {
  const roleEsc = escapeHtmlAttribute(opts.role);
  const appNameEsc = escapeHtmlAttribute(opts.appName);
  const installUrlEsc = escapeHtmlAttribute(opts.installUrl);
  const repoItems = opts.repos.length > 0
    ? opts.repos.map((r) => `  <li><strong>${escapeHtmlAttribute(repoShortName(r))}</strong> <span class="dim">(${escapeHtmlAttribute(r)})</span></li>`).join('\n')
    : '  <li><em>(no repos declared in the fleet manifest — verify before installing)</em></li>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Consent gate ${String(opts.gateNumber)} of ${String(opts.gateTotal)} — installing ${appNameEsc}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
  .dim { color: #666; }
  .why { background: #fff3cd; border: 1px solid #d0a02e; border-radius: 4px; padding: 0.75rem 1rem; }
  .button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; background: #1f6feb; color: #fff;
            text-decoration: none; border-radius: 6px; font-weight: 600; }
</style>
</head>
<body>
<h1>Consent gate ${String(opts.gateNumber)} of ${String(opts.gateTotal)} — role "${roleEsc}"</h1>
<p>Installing GitHub App: <strong>${appNameEsc}</strong></p>
<p>On the page this button opens, GitHub will ask which repositories to install this App on. You MUST choose:</p>
<ul>
  <li><strong>&ldquo;Only select repositories&rdquo;</strong> — NOT &ldquo;All repositories&rdquo;</li>
</ul>
<p>Then select exactly:</p>
<ul>
${repoItems}
</ul>
<p class="why">${escapeHtmlAttribute(opts.whyText)}</p>
<p><a class="button" href="${installUrlEsc}">Continue to GitHub to install</a></p>
<p class="dim">If the button doesn't work, open this URL yourself: ${installUrlEsc}</p>
</body></html>`;
}

export interface InstallInterstitialHandles {
  /** Open THIS in a browser — our own page, not GitHub's install URL directly. */
  readonly startUrl: string;
  /** Idempotent shutdown. Always call (e.g. in a `finally`). */
  close: () => Promise<void>;
}

/**
 * Start the single-shot gate-2 interstitial listener on an ephemeral
 * 127.0.0.1 port — the SAME {@link bindEphemeralListener} primitive
 * {@link startManifestFlow} uses (see module doc). Unlike gate 1, this page
 * needs no callback: gate 2's completion is observed by polling
 * `GET /app/installations` (`identity-confirm.ts::waitForAppInstallation`),
 * not by a redirect this listener would need to catch — so the served
 * content is static for the listener's whole lifetime, no per-request state.
 */
export async function startInstallInterstitial(opts: InstallInterstitialOptions): Promise<InstallInterstitialHandles> {
  const { server, baseUrl, close } = await bindEphemeralListener();
  const html = renderInstallInterstitial(opts);
  server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return { startUrl: `${baseUrl}/`, close };
}
