/**
 * Tests for the App-manifest exchange + localhost flow server (DR-043 §D2
 * consent gate 1, Slice 2b increment 2 of groundnuty/macf#838).
 *
 * `normalizeConversionResponse` carries the two guards ported from
 * `bootstrap-exchange-manifest.sh`: a 2xx with an empty `app_id` or `pem` is a
 * FAILURE (Pattern A result-invariant), not a success that writes a useless
 * vault entry. `exchangeManifestCode`'s `gh` shell-out is not unit-tested here
 * (thin I/O leaf, observer convention).
 */
import { describe, it, expect } from 'vitest';
import {
  ManifestExchangeError,
  normalizeConversionResponse,
} from '../../../src/cli/bootstrap/manifest-exchange.js';
import {
  escapeHtmlAttribute,
  manifestFormAction,
  renderCallbackPage,
  renderInstallInterstitial,
  renderManifestForm,
  startInstallInterstitial,
  startManifestFlow,
} from '../../../src/cli/bootstrap/manifest-flow-server.js';
import { buildAppManifest } from '../../../src/cli/bootstrap/app-manifest.js';
import type { GitHubAppManifest } from '../../../src/cli/bootstrap/app-manifest.js';

const FULL = {
  id: 3378862,
  name: 'macf-code-agent',
  slug: 'macf-code-agent',
  client_id: 'Iv1.abc',
  client_secret: 'shhh',
  webhook_secret: 'hook',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n',
};

/**
 * groundnuty/macf#971 — gate 2's exact rendered output, captured from
 * `renderInstallInterstitial` on `main` BEFORE this issue's change (which
 * touches gate 1 only). Gate 2 must come out of this issue byte-identical;
 * see the "gate 2's rendered HTML is BYTE-IDENTICAL" test below.
 */
const GATE2_GOLDEN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Consent gate 2 of 2 — installing demo-fleet-runner-ops</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
  .dim { color: #666; }
  .why { background: #fff3cd; border: 1px solid #d0a02e; border-radius: 4px; padding: 0.75rem 1rem; }
  .button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; background: #1f6feb; color: #fff;
            text-decoration: none; border-radius: 6px; font-weight: 600; }
</style>
</head>
<body>
<h1>Consent gate 2 of 2 — role "runner-ops"</h1>
<p>Installing GitHub App: <strong>demo-fleet-runner-ops</strong></p>
<p>On the page this button opens, GitHub will ask which repositories to install this App on. You MUST choose:</p>
<ul>
  <li><strong>&ldquo;Only select repositories&rdquo;</strong> — NOT &ldquo;All repositories&rdquo;</li>
</ul>
<p>Then select exactly:</p>
<ul>
  <li><strong>exp-science-agent</strong> <span class="dim">(groundnuty/exp-science-agent)</span></li>
  <li><strong>exp-code-agent</strong> <span class="dim">(groundnuty/exp-code-agent)</span></li>
</ul>
<p class="why">Why: this App holds administration:write; granting it every repository in the account is blast radius the fleet does not need, and apply will refuse an &quot;all&quot; install.</p>
<p><a class="button" href="https://github.com/apps/demo-fleet-runner-ops/installations/new">Continue to GitHub to install</a></p>
<p class="dim">If the button doesn't work, open this URL yourself: https://github.com/apps/demo-fleet-runner-ops/installations/new</p>
</body></html>`;

describe('normalizeConversionResponse (ported guards)', () => {
  it('normalizes the full response, stringifying the numeric id', () => {
    const c = normalizeConversionResponse(FULL);
    expect(c.appId).toBe('3378862');
    expect(c.slug).toBe('macf-code-agent');
    expect(c.pem).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('THROWS on a 2xx with no app_id (never a silently-useless credential set)', () => {
    expect(() => normalizeConversionResponse({ ...FULL, id: undefined })).toThrow(ManifestExchangeError);
    try {
      normalizeConversionResponse({ ...FULL, id: undefined });
    } catch (e) {
      expect((e as ManifestExchangeError).code).toBe('exchange_no_app_id');
    }
  });

  it('THROWS on a 2xx with no pem — an App that could never mint a token', () => {
    try {
      normalizeConversionResponse({ ...FULL, pem: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ManifestExchangeError).code).toBe('exchange_no_pem');
    }
  });

  it('THROWS on a non-object body (array / null / string)', () => {
    for (const bad of [[], null, 'nope', 42]) {
      expect(() => normalizeConversionResponse(bad)).toThrow(ManifestExchangeError);
    }
  });

  it('tolerates missing OPTIONAL fields as empty strings (never collapses the object)', () => {
    const c = normalizeConversionResponse({ id: 1, pem: 'x' });
    expect(c.appId).toBe('1');
    expect(c.pem).toBe('x');
    expect(c.clientSecret).toBe('');
    expect(c.webhookSecret).toBe('');
    expect(c.slug).toBe('');
  });
});

describe('manifest-flow-server (pure parts)', () => {
  const manifest = buildAppManifest({
    fleetName: 'demo',
    role: 'code-agent',
    redirectUrl: 'http://127.0.0.1:1234/callback',
  });

  it('targets the org App-creation URL for an org owner, personal otherwise', () => {
    expect(manifestFormAction({ account: 'macf-experiment', type: 'org' })).toBe(
      'https://github.com/organizations/macf-experiment/settings/apps/new',
    );
    expect(manifestFormAction({ account: 'groundnuty', type: 'user' })).toBe(
      'https://github.com/settings/apps/new',
    );
  });

  it('escapes the manifest JSON into the form value (no attribute break-out)', () => {
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new', 'code-agent');
    expect(html).toContain('name="manifest"');
    // The JSON's own double quotes must be entity-escaped inside the value attribute.
    expect(html).not.toMatch(/value="\{"/);
    expect(html).toContain('&quot;');
    expect(html).toContain('demo-code-agent');
  });

  // groundnuty/macf#971 — gate 1's served page is now a BARE redirect: it
  // still identifies which App (role + name) is being created, but the
  // explanation prose that used to live here (groundnuty/macf#952 via #962)
  // is GONE — it moved to the terminal (apply-agent.test.ts's ordering
  // test), because this page's own auto-submit script makes any prose here
  // unreadable by construction.
  it('still identifies role + App name + gate numbering (minimal, no-JS-fallback context)', () => {
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new', 'code-agent');
    expect(html).toContain('role "code-agent"');
    expect(html).toContain('demo-code-agent'); // the App name (manifest.name)
    expect(html).toMatch(/consent gate 1 of 2/i);
  });

  it('no longer contains the moved explanation prose (groundnuty/macf#971 — it is unreadable by construction on an auto-submitting page)', () => {
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new', 'code-agent');
    for (const removedProse of [
      // Literal removed phrases only (not the bare word "submitted" — the
      // manifest JSON is embedded in the page as an escaped `value`
      // attribute, so a future `buildAppManifest` description containing
      // that substring would fail this test for the wrong reason).
      'This page automatically submits',
      'submitted <strong>as-is</strong>',
      'nothing here to review or edit',
      'own confirmation page',
      '&ldquo;Create GitHub App&rdquo;',
    ]) {
      expect(html).not.toContain(removedProse);
    }
  });

  it('keeps the no-JS fallback: the manual "Continue to GitHub" button + the auto-submit script (groundnuty/macf#971)', () => {
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new', 'code-agent');
    expect(html).toContain('<button type="submit">Continue to GitHub</button>');
    expect(html).toContain("document.getElementById('macf-manifest-form').submit();");
    expect(html).toMatch(/does not advance on its own/);
  });

  it('NEVER renders a secret on gate 1 — GitHubAppManifest has no credential field, and the rendered HTML proves it (groundnuty/macf#952)', () => {
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new', 'code-agent');
    for (const sentinel of ['BEGIN RSA PRIVATE KEY', 'clientSecret', 'webhookSecret', 'client_secret', 'webhook_secret']) {
      expect(html).not.toContain(sentinel);
    }
  });

  it('escapeHtmlAttribute covers the injection-relevant characters', () => {
    expect(escapeHtmlAttribute(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders distinct callback pages for success and a code-less redirect', () => {
    expect(renderCallbackPage('demo-code-agent', true)).toMatch(/created/);
    expect(renderCallbackPage('demo-code-agent', false)).toMatch(/No manifest code/i);
  });
});

describe('renderInstallInterstitial (groundnuty/macf#952 — pure)', () => {
  const OPTS = {
    role: 'runner-ops',
    appName: 'demo-fleet-runner-ops',
    installUrl: 'https://github.com/apps/demo-fleet-runner-ops/installations/new',
    repos: ['groundnuty/exp-science-agent', 'groundnuty/exp-code-agent'],
    whyText:
      'Why: this App holds administration:write; granting it every repository in the account is blast radius ' +
      'the fleet does not need, and apply will refuse an "all" install.',
    gateNumber: 2,
    gateTotal: 2,
  };

  it('names the literal repositories from the manifest (bare name AND owner/repo)', () => {
    const html = renderInstallInterstitial(OPTS);
    expect(html).toContain('exp-science-agent');
    expect(html).toContain('exp-code-agent');
    expect(html).toContain('groundnuty/exp-science-agent');
  });

  it('states the "Only select repositories" requirement', () => {
    const html = renderInstallInterstitial(OPTS);
    expect(html).toMatch(/Only select repositories/);
    expect(html).toMatch(/NOT.*All repositories/);
  });

  it('links to the correct GitHub install URL', () => {
    const html = renderInstallInterstitial(OPTS);
    expect(html).toContain(`href="${OPTS.installUrl}"`);
  });

  it('is numbered and role-attributed', () => {
    const html = renderInstallInterstitial(OPTS);
    expect(html).toMatch(/consent gate 2 of 2/i);
    expect(html).toContain('role "runner-ops"');
  });

  it('carries the why-text (HTML-attribute-escaped — the source `"`s become `&quot;`)', () => {
    expect(renderInstallInterstitial(OPTS)).toContain(escapeHtmlAttribute(OPTS.whyText));
  });

  it('handles an empty repo list honestly rather than rendering nothing', () => {
    const html = renderInstallInterstitial({ ...OPTS, repos: [] });
    expect(html).toMatch(/no repos declared/i);
  });

  it('NEVER renders a secret — the options shape has no credential field, and the rendered HTML proves it (groundnuty/macf#952)', () => {
    const html = renderInstallInterstitial(OPTS);
    for (const sentinel of ['BEGIN RSA PRIVATE KEY', 'clientSecret', 'webhookSecret', 'client_secret', 'webhook_secret']) {
      expect(html).not.toContain(sentinel);
    }
  });

  // groundnuty/macf#971 — gate 2 is EXPLICITLY unchanged by this issue (it
  // does not auto-submit, and is where a real choice — "Only select
  // repositories" + which repos — actually gets made). Pinned byte-for-byte
  // against a captured-before-this-change fixture so a future edit to THIS
  // page cannot silently degrade the one page in the flow the operator
  // actually reads. A deliberate future change to gate 2 updates this
  // constant along with the code; that is the point of a pin, not a bug in
  // this test.
  it('gate 2\'s rendered HTML is BYTE-IDENTICAL to its pre-#971 fixture (pinned regression guard)', () => {
    expect(renderInstallInterstitial(OPTS)).toBe(GATE2_GOLDEN_HTML);
  });
});

describe('startInstallInterstitial (live loopback server, groundnuty/macf#952)', () => {
  const OPTS = {
    role: 'code-agent',
    appName: 'demo-fleet-code-agent',
    installUrl: 'https://github.com/apps/demo-fleet-code-agent/installations/new',
    repos: ['groundnuty/demo-code'],
    whyText: 'Why: this App only needs access to the repo(s) listed above.',
    gateNumber: 2,
    gateTotal: 2,
  };

  it('binds 127.0.0.1 and serves the interstitial, linking to the real install URL', async () => {
    const handles = await startInstallInterstitial(OPTS);
    try {
      expect(handles.startUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const res = await fetch(handles.startUrl);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('demo-code');
      expect(html).toContain(`href="${OPTS.installUrl}"`);
      expect(html).toMatch(/Only select repositories/);
    } finally {
      await handles.close();
    }
  });

  it('close() is idempotent', async () => {
    const handles = await startInstallInterstitial(OPTS);
    await handles.close();
    await expect(handles.close()).resolves.toBeUndefined();
  });
});

/**
 * Inverse of `escapeHtmlAttribute`, for pulling the manifest JSON back out of
 * the served form's `value="..."` attribute in tests. The specific 4 entities
 * decode BEFORE `&amp;` (the last thing `escapeHtmlAttribute` produces), the
 * mirror of the encode order (`&` escaped first, so it can't double-encode the
 * others) — standard HTML-attribute-unescape ordering.
 */
function unescapeHtmlAttribute(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Fetches `flow.startUrl` and extracts+parses the served `manifest` field. */
async function fetchServedManifest(startUrl: string): Promise<GitHubAppManifest> {
  const html = await (await fetch(startUrl)).text();
  const match = html.match(/name="manifest" value="([^"]*)"/);
  if (!match) throw new Error('served form is missing the manifest field');
  return JSON.parse(unescapeHtmlAttribute(match[1])) as GitHubAppManifest;
}

describe('startManifestFlow (live loopback server)', () => {
  it('binds 127.0.0.1, serves the form, and resolves the code from /callback', async () => {
    const flow = await startManifestFlow({
      buildManifest: (redirectUrl) => buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl }),
      formAction: 'https://github.com/settings/apps/new',
      role: 'code-agent',
    });
    try {
      expect(flow.startUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(flow.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const formRes = await fetch(flow.startUrl);
      expect(formRes.status).toBe(200);
      expect(await formRes.text()).toContain('name="manifest"');

      const codePromise = flow.waitForCode();
      const cbRes = await fetch(`${flow.redirectUrl}?code=abc123`);
      expect(cbRes.status).toBe(200);
      await expect(codePromise).resolves.toBe('abc123');
    } finally {
      await flow.close();
    }
  });

  it('rejects when GitHub redirects back without a code', async () => {
    const flow = await startManifestFlow({
      buildManifest: (redirectUrl) => buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl }),
      formAction: 'https://github.com/settings/apps/new',
      role: 'code-agent',
    });
    try {
      const codePromise = flow.waitForCode();
      const res = await fetch(flow.redirectUrl);
      expect(res.status).toBe(400);
      await expect(codePromise).rejects.toThrow(/without a `code`/);
    } finally {
      await flow.close();
    }
  });

  it('close() is idempotent', async () => {
    const flow = await startManifestFlow({
      buildManifest: (redirectUrl) => buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl }),
      formAction: 'https://github.com/settings/apps/new',
      role: 'code-agent',
    });
    await flow.close();
    await expect(flow.close()).resolves.toBeUndefined();
  });

  // Regression test for macf#843: the round-trip test above fetches
  // `flow.redirectUrl` directly, bypassing the manifest → GitHub → redirect
  // hop that actually carries `redirect_url` in production. GitHub echoes the
  // code to the `redirect_url` DECLARED INSIDE THE SUBMITTED MANIFEST, not to
  // wherever the form was served from — so this asserts the served manifest's
  // own `redirect_url` field, parsed back out of the form HTML exactly as
  // GitHub would see it, matches the listener's real callback URL.
  it('serves a manifest whose redirect_url equals the listener callback URL (macf#843)', async () => {
    const flow = await startManifestFlow({
      buildManifest: (redirectUrl) => buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl }),
      formAction: 'https://github.com/settings/apps/new',
      role: 'code-agent',
    });
    try {
      const served = await fetchServedManifest(flow.startUrl);
      expect(served.redirect_url).toBe(flow.redirectUrl);
    } finally {
      await flow.close();
    }
  });
});
