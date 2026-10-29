import { describe, it, expect, vi } from 'vitest';
import { generateEnvGitHub } from '../../src/cli/env-files.js';
import {
  checkGitIdentityConfig,
  resolveBotUserId,
  withBotUserId,
  type GitConfigReader,
} from '../../src/cli/git-identity.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function cfg(app: Record<string, string> = {}): MacfAgentConfig {
  return {
    project: 'proj',
    agent_name: 'code-agent',
    agent_role: 'code-agent',
    registry: { type: 'repo', owner: 'o', repo: 'r' },
    github_app: { app_id: '1', install_id: '2', key_path: 'k.pem', ...app },
    versions: { cli: '0.0.0', plugin: '0.0.0', actions: 'v3' },
  } as unknown as MacfAgentConfig;
}

describe('env.github git identity', () => {
  it('known id: name = bot_login and the noreply email', () => {
    const out = generateEnvGitHub(cfg({ bot_login: 'proj-code-agent[bot]', bot_user_id: '123' }));
    expect(out).toContain('export GIT_AUTHOR_NAME="proj-code-agent[bot]"');
    expect(out).toContain('export GIT_COMMITTER_NAME="proj-code-agent[bot]"');
    expect(out).toContain('export GIT_AUTHOR_EMAIL="123+proj-code-agent[bot]@users.noreply.github.com"');
    expect(out).toContain('export GIT_COMMITTER_EMAIL="123+proj-code-agent[bot]@users.noreply.github.com"');
  });

  it('unknown id: name only, no email exports, a comment and a launch warning', () => {
    const out = generateEnvGitHub(cfg({ bot_login: 'proj-code-agent[bot]' }));
    expect(out).toContain('export GIT_AUTHOR_NAME="proj-code-agent[bot]"');
    expect(out).not.toContain('export GIT_AUTHOR_EMAIL');
    expect(out).not.toContain('export GIT_COMMITTER_EMAIL');
    expect(out).toContain('# bot_user_id is unknown');
    expect(out).toContain('MACF: bot user id unknown; commits will not be linked to proj-code-agent[bot]. Run macf update.');
  });
});

describe('bot user id resolution', () => {
  it('stores the id from an injected fetch', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 123 }) });
    const out = await withBotUserId(cfg({ bot_login: 'x[bot]' }), { fetchFn });
    expect(out.github_app?.bot_user_id).toBe('123');
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.github.com/users/x%5Bbot%5D');
  });

  it('retries without auth when the token attempt fails', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 9 }) });
    expect(await resolveBotUserId('x[bot]', { token: 't', fetchFn })).toBe('9');
    expect(fetchFn.mock.calls[1]![1]!.headers).not.toHaveProperty('Authorization');
  });

  it('a failure warns and leaves the id unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const input = cfg({ bot_login: 'x[bot]' });
    const out = await withBotUserId(input, { fetchFn });
    expect(out.github_app?.bot_user_id).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('doctor git identity check', () => {
  const reader = (vals: Record<string, string>): GitConfigReader => (scope, key) => vals[`${scope}:${key}`] ?? null;

  it('warns on gpgsign with a signing key, and on a repo-local email', () => {
    const w = checkGitIdentityConfig(reader({
      'global:commit.gpgsign': 'true',
      'global:user.signingkey': 'ABC',
      'local:user.email': 'a@b.c',
    }));
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("signed with a human's key");
    expect(w[1]).toContain('repo-local user.email');
  });

  it('a clean config gives no warnings', () => {
    expect(checkGitIdentityConfig(reader({ 'global:user.email': 'a@b.c' }))).toEqual([]);
    expect(checkGitIdentityConfig(reader({ 'local:commit.gpgsign': 'true' }))).toEqual([]);
  });
});
