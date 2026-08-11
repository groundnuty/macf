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
  renderManifestForm,
  startManifestFlow,
} from '../../../src/cli/bootstrap/manifest-flow-server.js';
import { buildAppManifest } from '../../../src/cli/bootstrap/app-manifest.js';

const FULL = {
  id: 3378862,
  name: 'macf-code-agent',
  slug: 'macf-code-agent',
  client_id: 'Iv1.abc',
  client_secret: 'shhh',
  webhook_secret: 'hook',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n',
};

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
    const html = renderManifestForm(manifest, 'https://github.com/settings/apps/new');
    expect(html).toContain('name="manifest"');
    // The JSON's own double quotes must be entity-escaped inside the value attribute.
    expect(html).not.toMatch(/value="\{"/);
    expect(html).toContain('&quot;');
    expect(html).toContain('demo-code-agent');
  });

  it('escapeHtmlAttribute covers the injection-relevant characters', () => {
    expect(escapeHtmlAttribute(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders distinct callback pages for success and a code-less redirect', () => {
    expect(renderCallbackPage('demo-code-agent', true)).toMatch(/created/);
    expect(renderCallbackPage('demo-code-agent', false)).toMatch(/No manifest code/i);
  });
});

describe('startManifestFlow (live loopback server)', () => {
  it('binds 127.0.0.1, serves the form, and resolves the code from /callback', async () => {
    const flow = await startManifestFlow({
      manifest: buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl: 'http://placeholder/callback' }),
      formAction: 'https://github.com/settings/apps/new',
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
      manifest: buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl: 'http://placeholder/callback' }),
      formAction: 'https://github.com/settings/apps/new',
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
      manifest: buildAppManifest({ fleetName: 'demo', role: 'code-agent', redirectUrl: 'http://placeholder/callback' }),
      formAction: 'https://github.com/settings/apps/new',
    });
    await flow.close();
    await expect(flow.close()).resolves.toBeUndefined();
  });
});
