/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/check-bootstrap-url-allowlist.sh`
 * — the PreToolUse hook that fences the macf-bootstrap workspace's Chrome
 * DevTools MCP browser surface to the GitHub-provisioning allowlist
 * (DR-035 §2.2, browser/MCP surface).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
 * (stderr → Claude; exit-2-ONLY, no JSON on stdout). Policy is default-deny:
 * a navigation URL must NOT match the destructive denylist AND must match the
 * provisioning allowlist. Non-navigation chrome tools (no URL) pass through.
 * Override: MACF_BOOTSTRAP_SKIP_URL_GUARD=1.
 *
 * Mirrors the spawn-script-with-stdin convention of check-close-keyword.test.ts
 * / check-gh-token.test.ts. No `gh` is involved, so no PATH stub is needed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

// findCliPackageRoot() resolves to packages/macf; the bootstrap scaffold lives
// at the repo root under tools/.
const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const HOOK_SCRIPT = join(
  REPO_ROOT,
  'tools',
  'macf-bootstrap',
  '.claude',
  'scripts',
  'check-bootstrap-url-allowlist.sh',
);

const CHROME = 'mcp__chrome-devtools__';

function runHook(opts: {
  readonly tool: string;
  readonly url?: string;
  readonly env?: Record<string, string | undefined>;
}): ReturnType<typeof spawnSync> {
  const toolInput: Record<string, unknown> = {};
  if (opts.url !== undefined) toolInput['url'] = opts.url;
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: opts.tool,
    tool_input: toolInput,
  });
  // Clean env: only PATH unless the test adds an override. Prevents an ambient
  // MACF_BOOTSTRAP_* from the runner leaking in.
  const cleanEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], { input: payload, env: cleanEnv, encoding: 'utf-8' });
}

describe('check-bootstrap-url-allowlist.sh (hook)', () => {
  describe('allowlisted provisioning URLs → allow', () => {
    it('allows the manifest-create page (personal)', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/settings/apps/new?state=abc',
      });
      expect(r.status).toBe(0);
    });

    it('allows the manifest-create page (org)', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/organizations/myorg/settings/apps/new',
      });
      expect(r.status).toBe(0);
    });

    it('allows the OAuth authorize page', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/login/oauth/authorize?client_id=x',
      });
      expect(r.status).toBe(0);
    });

    it('allows the 2FA / sessions gate', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/sessions/two-factor',
      });
      expect(r.status).toBe(0);
    });

    it('allows the sudo-mode re-auth gate', () => {
      const r = runHook({ tool: `${CHROME}navigate_page`, url: 'https://github.com/sudo' });
      expect(r.status).toBe(0);
    });

    it('allows the App install flow', () => {
      const r = runHook({
        tool: `${CHROME}new_page`,
        url: 'https://github.com/apps/my-app/installations/new',
      });
      expect(r.status).toBe(0);
    });

    it('allows about:blank', () => {
      const r = runHook({ tool: `${CHROME}new_page`, url: 'about:blank' });
      expect(r.status).toBe(0);
    });
  });

  describe('destructive GitHub URLs → BLOCK (denylist wins)', () => {
    it('blocks a repo Danger Zone', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/myorg/myrepo/settings#danger-zone',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('destructive');
    });

    it('blocks the billing surface', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/settings/billing',
      });
      expect(r.status).toBe(2);
    });

    it('blocks the GitHub App advanced (delete/transfer/revoke) page', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/settings/apps/my-app/advanced',
      });
      expect(r.status).toBe(2);
    });

    it('blocks a transfer URL', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/myorg/myrepo/settings/transfer',
      });
      expect(r.status).toBe(2);
    });

    it('blocks an org member-removal URL', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/orgs/myorg/people/someuser/remove',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('default-deny → BLOCK (not on the allowlist)', () => {
    it('blocks an off-GitHub URL', () => {
      const r = runHook({ tool: `${CHROME}navigate_page`, url: 'https://example.com/' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('allowlist');
    });

    it('blocks an arbitrary (non-provisioning) GitHub page', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/myorg/myrepo/issues/1',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('missing / non-navigation URLs', () => {
    it('fail-closed: new_page with no URL is blocked (url required)', () => {
      const r = runHook({ tool: `${CHROME}new_page` });
      expect(r.status).toBe(2);
    });

    it('allows navigate_page with no URL (history nav: back/forward/reload)', () => {
      const r = runHook({ tool: `${CHROME}navigate_page` });
      expect(r.status).toBe(0);
    });

    it('allows a non-navigation chrome tool (take_screenshot, no URL)', () => {
      const r = runHook({ tool: `${CHROME}take_screenshot` });
      expect(r.status).toBe(0);
    });

    it('allows a non-navigation chrome tool that carries no URL (click)', () => {
      const r = runHook({ tool: `${CHROME}click` });
      expect(r.status).toBe(0);
    });
  });

  describe('override', () => {
    it('MACF_BOOTSTRAP_SKIP_URL_GUARD=1 bypasses even a denied URL', () => {
      const r = runHook({
        tool: `${CHROME}navigate_page`,
        url: 'https://github.com/settings/billing',
        env: { MACF_BOOTSTRAP_SKIP_URL_GUARD: '1' },
      });
      expect(r.status).toBe(0);
    });
  });
});
