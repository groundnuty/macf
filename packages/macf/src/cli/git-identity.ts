/**
 * Git commit identity for an agent workspace (groundnuty/macf#1525).
 *
 * One source for the `GIT_*` exports, shared by `env.github` (env-files.ts)
 * and the `claude.sh` launcher helper (claude-sh.ts) so they cannot drift.
 * Also resolves the bot's GitHub user id, which the noreply email needs.
 */
import { execFileSync } from 'node:child_process';
import { proxyAwareFetch } from '@groundnuty/macf-core';
import type { MacfAgentConfig } from './config.js';

type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** `<slug>[bot]` — tolerant of a value that already carries the suffix. */
export function normalizeBotLogin(login: string): string {
  return login.endsWith('[bot]') ? login : `${login}[bot]`;
}

/** The GitHub noreply address that links a commit to the bot account. */
export function botNoreplyEmail(botUserId: number | string, botLogin: string): string {
  return `${botUserId}+${normalizeBotLogin(botLogin)}@users.noreply.github.com`;
}

/**
 * Lines that set the commit author/committer. Falls back to `agent_name`
 * only when `bot_login` is unset (pre-DR-028 configs).
 */
export function gitIdentityLines(config: MacfAgentConfig): string[] {
  const app = config.github_app;
  const login = normalizeBotLogin(app?.bot_login ?? config.agent_name);
  const lines = [
    `export GIT_AUTHOR_NAME="${login}"`,
    `export GIT_COMMITTER_NAME="${login}"`,
  ];
  const id = app?.bot_user_id;
  if (id !== undefined && id !== '') {
    const email = botNoreplyEmail(id, login);
    lines.push(`export GIT_AUTHOR_EMAIL="${email}"`, `export GIT_COMMITTER_EMAIL="${email}"`);
  } else {
    // Without bot_login, update cannot resolve the id: doctor --fix fills bot_login first.
    const repair = app?.bot_login ? 'macf update' : 'macf doctor --fix, then macf update';
    lines.push(
      `# bot_user_id is unknown, so no GIT_*_EMAIL is set; run ${repair} to resolve it.`,
      `echo "MACF: bot user id unknown; commits will not be linked to ${login}. Run ${repair}." >&2`,
    );
  }
  return lines;
}

/**
 * Resolve the bot's user id with `GET /users/<bot_login>` (a public
 * endpoint: tries the token first, then no auth). Returns null on failure.
 */
export async function resolveBotUserId(
  botLogin: string,
  opts: { readonly token?: string; readonly fetchFn?: FetchFn } = {},
): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? (proxyAwareFetch as unknown as FetchFn);
  const url = `https://api.github.com/users/${encodeURIComponent(normalizeBotLogin(botLogin))}`;
  const base = { Accept: 'application/vnd.github+json' };
  const attempts: Array<Record<string, string>> = opts.token
    ? [{ ...base, Authorization: `Bearer ${opts.token}` }, base]
    : [base];
  for (const headers of attempts) {
    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok) continue;
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id === 'number' && Number.isInteger(body.id)) return String(body.id);
    } catch {
      // try the next attempt
    }
  }
  return null;
}

/**
 * Return the config with `github_app.bot_user_id` filled in when it can be
 * resolved; otherwise warn on stderr and return it unchanged.
 */
export async function withBotUserId(
  config: MacfAgentConfig,
  opts: { readonly token?: string; readonly fetchFn?: FetchFn } = {},
): Promise<MacfAgentConfig> {
  const app = config.github_app;
  if (!app?.bot_login || app.bot_user_id) return config;
  const id = await resolveBotUserId(app.bot_login, opts);
  if (id === null) {
    console.warn(
      `Warning: could not resolve the user id for ${app.bot_login}; commits will not be ` +
        `linked to the bot. Re-run \`macf update\` once GitHub is reachable.`,
    );
    return config;
  }
  return { ...config, github_app: { ...app, bot_user_id: id } };
}

// ---------------------------------------------------------------------------
// Doctor check — git config that would override or defeat the bot identity.
// Warn only; never rewrites git config.
// ---------------------------------------------------------------------------

/** Reads one git config value for a scope; null when unset or unreadable. */
export type GitConfigReader = (scope: 'local' | 'global', key: string) => string | null;

export function defaultGitConfigReader(workspaceDir: string): GitConfigReader {
  return (scope, key) => {
    try {
      const out = execFileSync('git', ['-C', workspaceDir, 'config', `--${scope}`, '--get', key], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === '' ? null : out;
    } catch {
      return null;
    }
  };
}

export function checkGitIdentityConfig(read: GitConfigReader): string[] {
  const warnings: string[] = [];
  const pick = (key: string): string | null => read('local', key) ?? read('global', key);
  const isTrue = (v: string | null): boolean => v !== null && v.toLowerCase() === 'true';
  const signing = isTrue(pick('commit.gpgsign')) ? 'commit.gpgsign' : isTrue(pick('tag.gpgsign')) ? 'tag.gpgsign' : null;
  if (signing !== null && pick('user.signingkey') !== null) {
    warnings.push(`${signing} is true with a signing key set: commits would be signed with a human's key`);
  }
  if (read('local', 'user.email') !== null) {
    warnings.push("repo-local user.email is set: overridden by MACF's bot email; consider removing it");
  }
  return warnings;
}
