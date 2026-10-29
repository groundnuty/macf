/**
 * Agent-team teammates need the App credentials and git identity in the
 * tmux session env (never GH_TOKEN), env.github must be sourceable outside
 * claude.sh, and the identity hook says when credentials are missing (#1525).
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateClaudeSh } from '../../src/cli/claude-sh.js';
import { generateEnvGitHub } from '../../src/cli/env-files.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const config: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: {
    app_id: '12345',
    install_id: '67890',
    key_path: '.github-app-key.pem',
    bot_login: 'macf-code-agent[bot]',
    bot_user_id: '4242',
  },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'macf-tmenv-'));
}

describe('tmux wrap passes credentials, never GH_TOKEN', () => {
  it('records -e flags for the App creds and git identity and none for GH_TOKEN', () => {
    const out = generateClaudeSh(config);
    const start = out.indexOf('if [ -z "${TMUX:-}" ]');
    const end = out.indexOf('\nfi\n', start) + 4;
    const helper = out.slice(out.indexOf('macf_session_env_lines() {'), out.indexOf('\n}\n', out.indexOf('macf_session_env_lines() {')) + 3);
    const fragment = helper + '\n' + out.slice(start, end);
    const dir = tmp();
    mkdirSync(join(dir, 'bin'));
    const argvFile = join(dir, 'argv');
    writeFileSync(
      join(dir, 'bin', 'tmux'),
      `#!/bin/sh\nif [ "$1" = has-session ]; then exit 1; fi\nprintf '%s\\n' "$@" > "${argvFile}"\n`,
    );
    chmodSync(join(dir, 'bin', 'tmux'), 0o755);
    const script = `SCRIPT_DIR=${dir}\n${fragment}\n`;
    const r = spawnSync('bash', ['-c', script, 'claude.sh'], {
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        MACF_PROJECT: 'TEST',
        MACF_ROUTING_LABEL: 'code-agent',
        APP_ID: '12345',
        INSTALL_ID: '67890',
        KEY_PATH: '/abs/key.pem',
        GIT_AUTHOR_NAME: 'macf-code-agent[bot]',
        GIT_AUTHOR_EMAIL: '4242+macf-code-agent[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'macf-code-agent[bot]',
        GIT_COMMITTER_EMAIL: '4242+macf-code-agent[bot]@users.noreply.github.com',
        GH_TOKEN: 'ghs_secret',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const argv = readFileSync(argvFile, 'utf8').split('\n');
    for (const want of [
      'APP_ID=12345',
      'INSTALL_ID=67890',
      'KEY_PATH=/abs/key.pem',
      'GIT_AUTHOR_NAME=macf-code-agent[bot]',
      'GIT_AUTHOR_EMAIL=4242+macf-code-agent[bot]@users.noreply.github.com',
      'GIT_COMMITTER_NAME=macf-code-agent[bot]',
      'GIT_COMMITTER_EMAIL=4242+macf-code-agent[bot]@users.noreply.github.com',
    ]) {
      expect(argv).toContain(want);
    }
    expect(argv.some((a) => a.startsWith('GH_TOKEN'))).toBe(false);
    expect(argv.join('\n')).not.toContain('ghs_secret');
  });
});

function workspace(helperBody: string): string {
  const ws = tmp();
  mkdirSync(join(ws, '.claude', '.macf'), { recursive: true });
  mkdirSync(join(ws, '.claude', 'scripts'));
  writeFileSync(join(ws, '.claude', '.macf', 'env.github'), generateEnvGitHub(config));
  const helper = join(ws, '.claude', 'scripts', 'macf-gh-token.sh');
  writeFileSync(helper, `#!/bin/sh\n${helperBody}\n`);
  chmodSync(helper, 0o755);
  return ws;
}

describe('env.github is sourceable outside claude.sh', () => {
  it('resolves its own dir from another cwd and sets the creds', () => {
    const ws = workspace('echo ghs_x');
    const r = spawnSync(
      'bash',
      ['-c', `cd / && source "${ws}/.claude/.macf/env.github" && echo "$KEY_PATH|$APP_ID|$GH_TOKEN"`],
      { env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n').pop()).toBe(`${resolve(ws)}/.github-app-key.pem|12345|ghs_x`);
  });

  it('a failing helper makes source return non-zero without killing the shell', () => {
    const ws = workspace('exit 3');
    const r = spawnSync(
      'bash',
      ['-c', `cd / && source "${ws}/.claude/.macf/env.github"; echo "rc=$? survived"`],
      { env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    expect(r.stdout).toContain('rc=1 survived');
  });

  it('still aborts claude.sh under set -e when the helper fails', () => {
    const ws = workspace('exit 3');
    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail; for f in "${ws}/.claude/.macf"/env.*; do [ -f "$f" ] && source "$f"; done; echo continued`],
      { env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    expect(r.stdout).not.toContain('continued');
    expect(r.status).not.toBe(0);
  });
});

describe('emit-agent-identity.sh credentials line', () => {
  const script = resolve(__dirname, '../../plugin/scripts/emit-agent-identity.sh');
  const line = 'This session has no App credentials (APP_ID/INSTALL_ID/KEY_PATH), so it cannot mint a bot token; ask the lead session to run GitHub writes.';
  function run(extra: Record<string, string>): string {
    const r = spawnSync('bash', [script], {
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: tmp(),
        MACF_PROJECT: 'TEST',
        MACF_AGENT_NAME: 'code-agent',
        MACF_AGENT_ROLE: 'code-agent',
        ...extra,
      },
      input: '{}',
      encoding: 'utf8',
    });
    return r.stdout;
  }
  it('prints the line when credentials are absent', () => {
    expect(run({})).toContain(line);
    expect(run({ APP_ID: '1', INSTALL_ID: '2' })).toContain(line);
  });
  it('prints nothing extra when all three are present', () => {
    expect(run({ APP_ID: '1', INSTALL_ID: '2', KEY_PATH: '/k' })).not.toContain('App credentials');
  });
});
