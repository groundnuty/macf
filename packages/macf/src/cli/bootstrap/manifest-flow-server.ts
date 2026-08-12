/**
 * The ephemeral localhost listener for GitHub's App-manifest flow — DR-043 §D2
 * consent gate 1 (Slice 2b increment 2, groundnuty/macf#838).
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
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHubAppManifest } from './app-manifest.js';

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

/**
 * The self-submitting form GitHub's manifest flow requires: a POST to
 * `settings/apps/new` with the manifest JSON in a `manifest` field. Pure —
 * exported for testing.
 */
export function renderManifestForm(manifest: GitHubAppManifest, action: string): string {
  const json = escapeHtmlAttribute(JSON.stringify(manifest));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Creating ${escapeHtmlAttribute(manifest.name)}…</title></head>
<body>
<p>Submitting the App manifest for <strong>${escapeHtmlAttribute(manifest.name)}</strong> to GitHub…</p>
<p>If this page does not advance on its own, press the button.</p>
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
  const server: Server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 ONLY — the callback carries a credential-bearing one-shot code.
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
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
    res.end(renderManifestForm(manifest, opts.formAction));
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  };

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
