/**
 * Regression guard for #81: agent templates must NOT re-introduce the naive
 * `export GH_TOKEN=$(gh token generate ... | jq -r '.token')` pattern that
 * coordination.md explicitly warns against (attribution trap — pipefail
 * unset, jq success masks gh failure, GH_TOKEN becomes "null", gh falls
 * back to stored user auth).
 *
 * Post-#81, every agent template uses `./.claude/scripts/macf-gh-token.sh`.
 * If anyone re-introduces the anti-pattern, this test fails.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentsDir = join(repoRoot, 'plugin', 'agents');

function agentFiles(): readonly string[] {
  return readdirSync(agentsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(agentsDir, f));
}

describe('plugin/agents/*.md token-refresh pattern (#81 regression guard)', () => {
  // The anti-pattern: gh token generate piped into jq to extract .token.
  // Any capture in the templates is the attribution trap.
  const ANTI_PATTERN = /gh token generate[^\n]*\|\s*jq/;

  it('no agent template uses the naive gh-token-generate | jq pattern', () => {
    const offenders: string[] = [];
    for (const path of agentFiles()) {
      const body = readFileSync(path, 'utf-8');
      if (ANTI_PATTERN.test(body)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('every template that refreshes GH_TOKEN uses the canonical helper', () => {
    // Some templates (e.g. writing-agent.md) may not refresh tokens at all.
    // For those that DO, they must use the helper — not any bare CLI pattern.
    for (const path of agentFiles()) {
      const body = readFileSync(path, 'utf-8');
      const mentionsGhToken = body.includes('GH_TOKEN');
      const mentionsHelper = body.includes('macf-gh-token.sh');
      // If a template references GH_TOKEN assignment/refresh, it must
      // also reference the canonical helper.
      const assignsGhToken = /GH_TOKEN=\$\(/.test(body);
      if (assignsGhToken) {
        expect(mentionsHelper, `${path} assigns GH_TOKEN without using the helper`).toBe(true);
      }
      // No template should reference gh token generate directly (bare CLI).
      expect(body.includes('gh token generate'), `${path} uses bare 'gh token generate'`).toBe(false);
      // Suppress lint on unused.
      void mentionsGhToken;
    }
  });

  it('every helper call uses quoted args (guards against path/space injection)', () => {
    // Per coordination.md the canonical form quotes APP_ID / INSTALL_ID /
    // KEY_PATH. A pattern of `--app-id $APP_ID` without quotes would break
    // on paths/ids with whitespace or shell-special chars.
    for (const path of agentFiles()) {
      const body = readFileSync(path, 'utf-8');
      if (!body.includes('macf-gh-token.sh')) continue;
      // Every --app-id / --install-id / --key invocation should have a
      // quoted arg immediately after.
      const unquotedAppId = /--app-id\s+\$APP_ID\b/.test(body);
      const unquotedInstallId = /--install-id\s+\$INSTALL_ID\b/.test(body);
      const unquotedKey = /--key\s+\$KEY_PATH\b/.test(body);
      expect(unquotedAppId, `${path} passes unquoted $APP_ID`).toBe(false);
      expect(unquotedInstallId, `${path} passes unquoted $INSTALL_ID`).toBe(false);
      expect(unquotedKey, `${path} passes unquoted $KEY_PATH`).toBe(false);
    }
  });
});
