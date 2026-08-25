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
 *
 * **groundnuty/macf#1173 — gate 2's served page renders NO prose of its
 * own.** {@link InstallInterstitialOptions.messageLines} is the SAME array
 * the terminal prints; this file only escapes it into a verbatim block (see
 * {@link renderVerbatimInstructionBlock}). See {@link renderInstallInterstitial}'s
 * own doc for the incident this closes, and its groundnuty/macf#1176 note
 * for the copyable repo-names block ({@link renderCopyableRepoBlock}) added
 * alongside it.
 *
 * **groundnuty/macf#1179 — the consent-gate interaction model.** Gate 2's
 * page grew two affordances, both because the operator's attention is IN
 * THE BROWSER at the moment they'd want them, not at the terminal: **"I've
 * updated the install — check again"** (re-run the SAME validation without
 * waiting for the next scheduled poll tick) and **"cancel this identity"**
 * (stop waiting on THIS identity only — see `apply-agent.ts`'s
 * `Gate2Interactive` doc for the CLI-side wiring). {@link startInstallInterstitial}
 * therefore stopped being purely static: it now serves the SAME bound port
 * dynamically (`current` is mutable, updated via {@link
 * InstallInterstitialHandles.updateContent} on every poll tick that observes
 * a rejection) and answers two new POST routes. Never a THIRD "close the tab
 * means cancel" affordance — see {@link renderGate2Controls}'s doc for why.
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
   * groundnuty/macf#1173 — THE canonical instruction body, one entry per
   * sentence, escaped and rendered verbatim as this page's ONLY prose.
   * This is the EXACT SAME array `apply-agent.ts::runGate2WithInterstitial`
   * hands to `announceAndOpenGate`'s `instructionLines` for the terminal —
   * computed ONCE by the caller, threaded to both surfaces, never
   * re-derived here. Before #1173, this page built its own independent
   * text from `repos`/`whyText` fields — the fourth confirmed instance of
   * the SAME "one instruction, two texts" drift this repo had already
   * fixed three times (#1156, #1164, #1168) at other sites. There is now
   * exactly one text; this field IS it. An empty array renders nothing —
   * every real caller supplies at least the repo-selection line, so an
   * empty array would itself be a bug upstream, not a case this function
   * papers over.
   */
  readonly messageLines: readonly string[];
  /**
   * groundnuty/macf#1176 — the bare repo names (see `apply-agent.ts::
   * bareRepoName`'s doc for why bare, not `owner/repo`) the operator pastes
   * into GitHub's own repository picker. THE payload of this whole page —
   * rendered as its own prominent, copy-with-nothing-to-trim block, distinct
   * from `messageLines`' prose (which explains what to do; this is what to
   * paste). Computed ONCE by the caller (`apply-agent.ts::
   * runGate2WithInterstitial`) from the SAME `repos`/`missingRepos` value
   * that built `messageLines`' own repo-selection sentence, so the two can
   * never name a different set. Empty renders no block — same "an empty
   * array is a caller bug, not a case this function papers over" posture as
   * `messageLines`.
   */
  readonly repoNames: readonly string[];
  readonly gateNumber: number;
  readonly gateTotal: number;
}

/**
 * groundnuty/macf#1176 — the copyable payload, its own small function so it
 * can be asserted directly ("names and nothing else") without parsing it
 * back out of the full page. One repo name per line, nothing else — no
 * bullets, no surrounding prose inside the block itself.
 */
export function renderCopyableRepoBlock(repoNames: readonly string[]): string {
  if (repoNames.length === 0) return '';
  const body = repoNames.map((name) => escapeHtmlAttribute(name)).join('\n');
  // groundnuty/macf#1179 — `macf-repos` (distinct from `macf-instructions`
  // below): the operator's report was specifically about the PROSE block's
  // font/wrap, not this one. This block is the payload (#1176) — it must
  // stay prominent and one-name-per-line, so its styling is UNCHANGED from
  // before this issue. A shared `pre` selector restyle would have shrunk
  // this block right along with the prose fix; see `renderInstallInterstitial`'s
  // CSS block for the two rules this class name resolves to.
  return `<h2>Repositories to select — copy exactly</h2>\n<pre class="macf-repos">${body}</pre>`;
}

/**
 * groundnuty/macf#1176 — `messageLines`, verbatim, formatted exactly as
 * `apply-agent.ts::announceAndOpenGate` prints them to the terminal (the
 * SAME `Role "<role>": ` prefix per line) — never a re-render, never a
 * paraphrase. Labeled "the instruction, as printed" rather than "what the
 * terminal printed": `announceAndOpenGate` also prints a gate-label/URL
 * line, the repo block, and the final "waiting for you to click" line
 * AFTER this page's HTML is already built (this page's content is static
 * for its whole lifetime — see {@link startInstallInterstitial}'s doc), so
 * this block cannot claim to be the terminal's ENTIRE output for this gate
 * — only the instruction body both surfaces share.
 */
export function renderVerbatimInstructionBlock(role: string, messageLines: readonly string[]): string {
  if (messageLines.length === 0) return '';
  const roleEsc = escapeHtmlAttribute(role);
  const body = messageLines.map((line) => `Role "${roleEsc}": ${escapeHtmlAttribute(line)}`).join('\n');
  // groundnuty/macf#1179 — `macf-instructions` (distinct from `macf-repos`
  // above). Operator-reported live: "the font is a little bit too big, and
  // it has a horizontal scroller which makes it impossible to see it in one
  // pass" — this is PROSE, not a payload to copy verbatim, so it gets a
  // smaller font + wraps instead of scrolling. Wrapping is visual only (no
  // characters inserted), so it does not touch the copyable block's own
  // "nothing to trim" property — that block keeps its OWN class, unaffected.
  return `<h2>The instruction, as printed</h2>\n<pre class="macf-instructions">${body}</pre>`;
}

/**
 * The gate-2 interstitial — served on OUR listener, BEFORE the operator ever
 * reaches GitHub's install page. Pure — exported for testing.
 *
 * **Never renders a secret.** {@link InstallInterstitialOptions} carries no
 * credential field at all (role/appName/installUrl/messageLines/repoNames
 * are all plan-level facts, not secrets) — structurally, not just by
 * convention.
 *
 * **groundnuty/macf#1173 — formatting regresses on purpose.** Before this
 * issue, this function hand-built its own bullet list (short repo name in
 * bold + full `owner/repo` in a dim span) and a separately-styled "why" box
 * — content nowhere else, so it could (and did) drift from what the
 * terminal told the SAME operator during the SAME gate. The operator's own
 * ruling: *"It can have a little bit worse formatting, but at the moment we
 * are managing two different sets of user messages."* Every sentence in the
 * verbatim-instruction block below is `opts.messageLines` — no sentence
 * this function adds on its own, none it drops.
 *
 * **groundnuty/macf#1176 — the copyable repo block comes FIRST and is the
 * most visually prominent element.** The operator's own words: *"what
 * should I copy… I usually copy the name of the repositories I have to
 * add."* {@link renderCopyableRepoBlock} renders it; the prose (via
 * {@link renderVerbatimInstructionBlock}) is context around it, never a
 * peer to it — same ordering + prominence intent, applied structurally.
 */
/**
 * groundnuty/macf#1179 — the two operator-facing controls, present on every
 * gate-2 render. **"I've updated the install — check again"** POSTs to
 * `/check-again`: wakes the CLI's wait loop (`apply-agent.ts::
 * pollForInstallFix`) immediately instead of waiting for its next scheduled
 * tick, and re-runs the SAME validation. **"cancel this identity"** POSTs to
 * `/cancel`: ends the wait for THIS identity only (`apply-agent.ts::
 * Gate2Interactive` — every gate-2 wait strategy races it against its own
 * poll, never just the resumed-fix one) — the App and its already-durable
 * credential are untouched either way (DR-043 Amendment B).
 *
 * **Why there is no THIRD "closing this tab cancels" affordance.** Proposed
 * during this issue's own review, then withdrawn once the form action above
 * was re-checked: it has no `target="_blank"`, so the operator's own click on
 * "Continue to GitHub to install" NAVIGATES AWAY from this page — the normal,
 * successful case. A close/unload event cannot tell that apart from actually
 * giving up (or the browser discarding/restoring the tab, or the operator
 * finishing and tidying up afterward) — "close-as-cancel" would fire on the
 * happy path. The explicit button above is the only honest fast-path signal;
 * the overall gate timeout remains the (slower, but never-wrong) fallback for
 * a genuine walk-away. Do not re-add a `beforeunload`/`visibilitychange`
 * cancel hook here — this is a considered omission, not a gap.
 *
 * **groundnuty/macf#1174's "one message source" now covers these labels
 * too.** {@link CHECK_AGAIN_LABEL}/{@link CANCEL_LABEL} are exported so
 * `apply-agent.ts::runGate2WithInterstitial` prints the SAME two strings to
 * the terminal (once, right after the page opens) — never a paraphrase a
 * future edit could drift from what the button itself says.
 */
export const CHECK_AGAIN_LABEL = "I've updated the install — check again";
export const CANCEL_LABEL = 'Cancel this identity';

function renderGate2Controls(): string {
  return `<h2>While you wait</h2>
<form method="post" action="/check-again" style="display:inline-block">
  <button type="submit">${CHECK_AGAIN_LABEL}</button>
</form>
<form method="post" action="/cancel" style="display:inline-block; margin-left: 0.75rem">
  <button type="submit" class="secondary">${CANCEL_LABEL}</button>
</form>`;
}

export function renderInstallInterstitial(opts: InstallInterstitialOptions): string {
  const roleEsc = escapeHtmlAttribute(opts.role);
  const appNameEsc = escapeHtmlAttribute(opts.appName);
  const installUrlEsc = escapeHtmlAttribute(opts.installUrl);
  const repoBlock = renderCopyableRepoBlock(opts.repoNames);
  const instructionBlock = renderVerbatimInstructionBlock(opts.role, opts.messageLines);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Consent gate ${String(opts.gateNumber)} of ${String(opts.gateTotal)} — installing ${appNameEsc}</title>
<style>
  /* WHY (groundnuty/macf#1181): the operator's own diagnosis — a 42rem prose
     column was the root cause of the horizontal scroller, not the font. A
     full API path or an owner/repo pair does not fit in ~672px. */
  body { font-family: system-ui, sans-serif; max-width: 68rem; margin: 2rem auto; padding: 0 1.5rem; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 0.75rem 1rem; }
  /* groundnuty/macf#1179 — DISTINCT classes, not a shared pre-tag restyle.
     Operator's live report: "the font is a little bit too big, and it has a
     horizontal scroller which makes it impossible to see it in one pass" —
     about the PROSE block only. Restyling the bare pre selector would have
     shrunk the copyable repo block (the payload, #1176) right along with it. */
  /* WHY (groundnuty/macf#1181): the PAYLOAD wraps too — a scroller here is the
     same unreadability one element over. Wrapping is safe for copying: CSS
     wrapping is visual and inserts no characters into a selection. Larger +
     bolder than the prose because it is what the operator came for. */
  .macf-repos { font-size: 1.05rem; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
  .macf-instructions { font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .dim { color: #666; }
  .button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; background: #1f6feb; color: #fff;
            text-decoration: none; border-radius: 6px; font-weight: 600; }
  button[type="submit"] { padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #fff; color: #57606a; border: 1px solid #d0d7de; }
</style>
</head>
<body>
<h1>Consent gate ${String(opts.gateNumber)} of ${String(opts.gateTotal)} — role "${roleEsc}"</h1>
<p>Installing GitHub App: <strong>${appNameEsc}</strong></p>
${repoBlock}
${instructionBlock}
<p><a class="button" href="${installUrlEsc}">Continue to GitHub to install</a></p>
<p class="dim">If the button doesn't work, open this URL yourself: ${installUrlEsc}</p>
${renderGate2Controls()}
</body></html>`;
}

/** groundnuty/macf#1179 — the page returned by a successful `/check-again` POST. Never claims the fix is confirmed (the CLI's own re-check, running independently, decides that) — only that the request was received. */
function renderCheckAgainAckPage(role: string): string {
  const roleEsc = escapeHtmlAttribute(role);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Checking again</title>
<meta http-equiv="refresh" content="2;url=/"></head>
<body><h1>Checking again</h1>
<p>Role "${roleEsc}": apply will re-check the install now. This page refreshes itself in a couple of seconds —
if the install is fixed, you're done; if not, this page will name what's still missing.</p></body></html>`;
}

/** groundnuty/macf#1179 — the page returned by `/cancel`. Terminal — no refresh, nothing left to wait for on THIS identity. */
function renderCancelledPage(role: string): string {
  const roleEsc = escapeHtmlAttribute(role);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cancelled</title></head>
<body><h1>Cancelled</h1>
<p>Role "${roleEsc}": this identity's install was cancelled. The App and its credential remain saved exactly as
they were — nothing else in the fleet is affected. Close this tab; re-run apply whenever you want to finish it.</p>
</body></html>`;
}

export interface InstallInterstitialHandles {
  /** Open THIS in a browser — our own page, not GitHub's install URL directly. */
  readonly startUrl: string;
  /** Idempotent shutdown. Always call (e.g. in a `finally`). */
  close: () => Promise<void>;
  /**
   * groundnuty/macf#1179 — resolves the next time the operator POSTs
   * `/check-again`. Re-armed immediately after each resolution (an internal
   * generation counter, not a promise identity) so a click that arrives
   * BEFORE anything is awaiting it is never lost, and a caller can await it
   * again for the NEXT click. Optional so a fake/older `InstallInterstitialHandles`
   * literal (every pre-#1179 test) omits it — `apply-agent.ts`'s
   * `Gate2Interactive` normalizes a missing hook to "never fires," which
   * reproduces exactly the pre-#1179 blind-timed-poll behavior.
   */
  readonly waitForCheckAgain?: () => Promise<void>;
  /** groundnuty/macf#1179 — resolves once the operator POSTs `/cancel`, and stays resolved (repeat calls resolve immediately). Optional for the same reason as {@link waitForCheckAgain}. */
  readonly waitForCancel?: () => Promise<void>;
  /**
   * groundnuty/macf#1179 — re-render the served page's message body for
   * subsequent GETs, WITHOUT re-opening a new listener. `apply-agent.ts::
   * pollForInstallFix` calls this on every tick that observes a rejection,
   * passing the SAME `messageLines`/`repoNames` it would otherwise log — the
   * #1173/#1174 "one message source" discipline extended from "computed once
   * at gate-open" to "recomputed once per tick, still never re-derived on
   * this page's own." Optional for the same reason as {@link waitForCheckAgain}.
   */
  readonly updateContent?: (messageLines: readonly string[], repoNames: readonly string[]) => void;
}

/**
 * Start the gate-2 interstitial listener on an ephemeral 127.0.0.1 port — the
 * SAME {@link bindEphemeralListener} primitive {@link startManifestFlow} uses
 * (see module doc). Unlike gate 1, this page needs no redirect callback:
 * gate 2's completion is observed by polling `GET /app/installations`
 * (`identity-confirm.ts::waitForAppInstallation`) — but as of groundnuty/
 * macf#1179 the served content is no longer static for the listener's WHOLE
 * lifetime: `current` is a mutable snapshot re-read on every GET, so a
 * `/check-again`-triggered re-check that still fails can narrow the page
 * without tearing the listener down and standing up a new one.
 */
export async function startInstallInterstitial(opts: InstallInterstitialOptions): Promise<InstallInterstitialHandles> {
  const { server, baseUrl, close } = await bindEphemeralListener();
  let current = opts;

  // groundnuty/macf#1179 — generation counter, not a single re-usable
  // Promise object. A single Promise that gets reassigned on every POST has
  // a lost-wakeup hazard: a click that lands BEFORE anything is awaiting
  // `waitForCheckAgain()` would resolve a promise nobody is holding, and the
  // NEXT `waitForCheckAgain()` call would then hand back a freshly-armed,
  // still-pending promise — silently dropping the click. Comparing against a
  // monotonic counter means "has the operator clicked since I last checked"
  // is answered correctly regardless of ordering.
  let checkAgainGeneration = 0;
  let lastObservedGeneration = 0;
  let checkAgainWaiters: (() => void)[] = [];
  const waitForCheckAgain = (): Promise<void> => {
    if (checkAgainGeneration > lastObservedGeneration) {
      lastObservedGeneration = checkAgainGeneration;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      checkAgainWaiters.push(() => {
        lastObservedGeneration = checkAgainGeneration;
        resolve();
      });
    });
  };

  // Cancel is one-shot and never un-fires — a single Promise is the right
  // primitive here (no lost-wakeup hazard: once resolved, every subsequent
  // `await` on it resolves immediately, which is exactly "stays cancelled").
  let resolveCancel: (() => void) | undefined;
  const cancelPromise = new Promise<void>((resolve) => { resolveCancel = resolve; });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/check-again') {
      checkAgainGeneration += 1;
      const waiters = checkAgainWaiters;
      checkAgainWaiters = [];
      for (const w of waiters) w();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCheckAgainAckPage(current.role));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      resolveCancel?.();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCancelledPage(current.role));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderInstallInterstitial(current));
  });

  return {
    startUrl: `${baseUrl}/`,
    close,
    waitForCheckAgain,
    waitForCancel: () => cancelPromise,
    updateContent: (messageLines, repoNames) => {
      current = { ...current, messageLines, repoNames };
    },
  };
}
