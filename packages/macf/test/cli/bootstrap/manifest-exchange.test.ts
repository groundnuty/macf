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
  renderCopyableRepoBlock,
  renderInstallInterstitial,
  renderManifestForm,
  renderVerbatimInstructionBlock,
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

/** Shared "why" sentence fixture — one of {@link RUNNER_OPS_MESSAGE_LINES}, and asserted for individually below (the escaping test). */
const RUNNER_OPS_WHY_TEXT =
  'Why: this App holds administration:write; granting it every repository in the account is blast radius ' +
  'the fleet does not need, and apply will refuse an "all" install.';
const RUNNER_OPS_INSTALL_URL = 'https://github.com/apps/demo-fleet-runner-ops/installations/new';

/**
 * groundnuty/macf#1173 — the CANONICAL instruction body a live gate-2 run
 * would compute (`apply-agent.ts::gate2DefaultInstructionLines`) for this
 * fixture's repos/why-text. This is the ONLY content
 * {@link renderInstallInterstitial} renders as prose — see that function's
 * own doc for why it no longer derives its own text from `repos`/`whyText`.
 */
const RUNNER_OPS_MESSAGE_LINES = [
  'on the page that opens, choose "Only select repositories" — NOT "All repositories".',
  'select exactly: groundnuty/exp-science-agent, groundnuty/exp-code-agent',
  RUNNER_OPS_WHY_TEXT,
  `GitHub's install page: ${RUNNER_OPS_INSTALL_URL}`,
];

/** groundnuty/macf#1176 — the bare-name copyable payload for the fixture above (`installReposForIdentity`-shaped `owner/repo` entries, bared). */
const RUNNER_OPS_REPO_NAMES = ['exp-science-agent', 'exp-code-agent'];

/**
 * groundnuty/macf#1176 — extracts the `<pre>` content of the named `<h2>`
 * block, split into lines. Used to assert the copyable-repo block and the
 * verbatim-instruction block WITHOUT re-parsing `<li>` markup that no
 * longer exists (superseded by #1173's own `<li>`-per-`messageLines`-entry
 * shape, which #1176 replaces with two distinct `<pre>` blocks — see
 * `manifest-flow-server.ts::renderInstallInterstitial`'s doc).
 */
function preBlockLines(html: string, heading: string): readonly string[] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<h2>${escapedHeading}<\\/h2>\\n<pre>([\\s\\S]*?)<\\/pre>`);
  const match = re.exec(html);
  return match ? match[1]!.split('\n') : [];
}

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

describe('renderCopyableRepoBlock (groundnuty/macf#1176 — pure; the copyable payload in isolation)', () => {
  it('is EXACTLY the repo names, one per line, nothing else — no bullets, no prose', () => {
    expect(renderCopyableRepoBlock(RUNNER_OPS_REPO_NAMES)).toBe(
      '<h2>Repositories to select — copy exactly</h2>\n<pre>exp-science-agent\nexp-code-agent</pre>',
    );
  });

  it('escapes a repo name that carries HTML-relevant characters', () => {
    expect(renderCopyableRepoBlock(['<script>evil</script>'])).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(renderCopyableRepoBlock(['<script>evil</script>'])).not.toContain('<script>evil</script>');
  });

  it('renders nothing for an empty list (a caller bug upstream, not a case this function papers over)', () => {
    expect(renderCopyableRepoBlock([])).toBe('');
  });
});

describe('renderVerbatimInstructionBlock (groundnuty/macf#1176 — pure; the terminal-fidelity block in isolation)', () => {
  it('is EXACTLY messageLines, each prefixed `Role "<role>": ` and escaped — the SAME form announceAndOpenGate prints', () => {
    expect(renderVerbatimInstructionBlock('runner-ops', ['line one', 'line two'])).toBe(
      '<h2>The instruction, as printed</h2>\n<pre>Role "runner-ops": line one\nRole "runner-ops": line two</pre>',
    );
  });

  it('renders nothing for an empty messageLines (mirrors renderCopyableRepoBlock\'s empty-list posture)', () => {
    expect(renderVerbatimInstructionBlock('runner-ops', [])).toBe('');
  });
});

describe('renderInstallInterstitial (groundnuty/macf#952 — pure; content shape per groundnuty/macf#1173 + #1176)', () => {
  const OPTS = {
    role: 'runner-ops',
    appName: 'demo-fleet-runner-ops',
    installUrl: RUNNER_OPS_INSTALL_URL,
    messageLines: RUNNER_OPS_MESSAGE_LINES,
    repoNames: RUNNER_OPS_REPO_NAMES,
    gateNumber: 2,
    gateTotal: 2,
  };

  it('names the literal repositories from the manifest', () => {
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
    expect(renderInstallInterstitial(OPTS)).toContain(escapeHtmlAttribute(RUNNER_OPS_WHY_TEXT));
  });

  it('handles an empty repo list honestly rather than rendering nothing (groundnuty/macf#1173: the "no repos declared" wording is now ONE of messageLines, computed upstream by gate2DefaultInstructionLines — this test only proves the page renders whatever line it is given)', () => {
    const html = renderInstallInterstitial({
      ...OPTS,
      messageLines: [
        RUNNER_OPS_MESSAGE_LINES[0]!,
        'select exactly: (no repos declared in the fleet manifest — verify before installing)',
        RUNNER_OPS_WHY_TEXT,
        `GitHub's install page: ${RUNNER_OPS_INSTALL_URL}`,
      ],
    });
    expect(html).toMatch(/no repos declared/i);
  });

  it('NEVER renders a secret — the options shape has no credential field, and the rendered HTML proves it (groundnuty/macf#952)', () => {
    const html = renderInstallInterstitial(OPTS);
    for (const sentinel of ['BEGIN RSA PRIVATE KEY', 'clientSecret', 'webhookSecret', 'client_secret', 'webhook_secret']) {
      expect(html).not.toContain(sentinel);
    }
  });

  // groundnuty/macf#1176 — decisive: the copyable block contains the repo
  // names AND NOTHING ELSE (no bullets, no prose, no trailing punctuation),
  // and it is the SAME set `messageLines`' own "select exactly:" sentence
  // names — compared against each other (per #1168's own precedent), never
  // against a hand-typed literal on both sides.
  it('DECISIVE: the copyable repo block is exactly the repo names — nothing else — and matches the set messageLines names', () => {
    const html = renderInstallInterstitial(OPTS);
    const blockLines = preBlockLines(html, 'Repositories to select — copy exactly');
    expect(blockLines).toEqual(OPTS.repoNames);
    // Nothing but bare names in the block — no bullet markers, no trailing
    // punctuation, no owner/ prefix (that lives in messageLines' prose).
    for (const line of blockLines) {
      expect(line).not.toMatch(/^[-*•]/);
      expect(line).not.toMatch(/[.,;]$/);
      expect(line).not.toContain('/');
    }
    // Cross-referenced against the OTHER surface's own repo mention —
    // messageLines' "select exactly: owner/repo, owner/repo" sentence —
    // every bare name in the block is a substring of that sentence.
    const selectExactlyLine = OPTS.messageLines.find((l) => l.startsWith('select exactly:'));
    expect(selectExactlyLine).toBeDefined();
    for (const bareName of blockLines) {
      expect(selectExactlyLine).toContain(bareName);
    }
  });

  it('groundnuty/macf#1176 — the copyable repo block appears BEFORE the verbatim instruction block (most prominent element first)', () => {
    const html = renderInstallInterstitial(OPTS);
    const repoHeadingIndex = html.indexOf('Repositories to select — copy exactly');
    const instructionHeadingIndex = html.indexOf('The instruction, as printed');
    expect(repoHeadingIndex).toBeGreaterThan(-1);
    expect(instructionHeadingIndex).toBeGreaterThan(-1);
    expect(repoHeadingIndex).toBeLessThan(instructionHeadingIndex);
  });

  it('groundnuty/macf#1176 — the verbatim instruction block is exactly messageLines, escaped + role-prefixed, in order, nothing added or dropped (supersedes the pre-#1176 `<li>`-per-line shape)', () => {
    const html = renderInstallInterstitial(OPTS);
    const items = preBlockLines(html, 'The instruction, as printed');
    expect(items).toEqual(OPTS.messageLines.map((line) => `Role "${OPTS.role}": ${escapeHtmlAttribute(line)}`));
  });
});

describe('startInstallInterstitial (live loopback server, groundnuty/macf#952)', () => {
  const OPTS = {
    role: 'code-agent',
    appName: 'demo-fleet-code-agent',
    installUrl: 'https://github.com/apps/demo-fleet-code-agent/installations/new',
    messageLines: [
      'on the page that opens, choose "Only select repositories" — NOT "All repositories".',
      'select exactly: groundnuty/demo-code',
      'Why: this App only needs access to the repo(s) listed above.',
      "GitHub's install page: https://github.com/apps/demo-fleet-code-agent/installations/new",
    ],
    repoNames: ['demo-code'],
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
