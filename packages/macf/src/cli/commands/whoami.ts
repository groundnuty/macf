/**
 * `macf whoami` (groundnuty/macf#672) — deterministic self-discovery, NOT
 * model inference.
 *
 * THE PROBLEM THIS SOLVES: an adopted/promoted/resumed agent previously had
 * to reconstruct its own identity by reading scattered sources
 * (`.macf/macf-agent.json`, `.claude/.macf/env.*`, `.claude/rules/*`) and
 * INFERRING the rest. Inference is non-deterministic (different models
 * describe the same role differently) and error-prone (a missing field gets
 * silently guessed rather than reported as missing). See #672 for the live
 * ppam-2026 promotion incident that motivated this.
 *
 * SCOPE (deliberately bounded — see #672 comment thread / PR body): this
 * command implements #672's "(1) Identity" field list in full. It does NOT
 * implement "(2) Capabilities + fleet context" (role's declared remit,
 * peers, which repos route here) — those fields have no structured,
 * non-prose source in the codebase today (role remit lives only in prose
 * `.claude/rules/agent-identity.md`; "which repos route to me" would need
 * cross-repo enumeration this workspace has no local record of). Inventing
 * a capability model to fill that gap would just be a differently-shaped
 * inference — the exact failure mode #672 is about. That's left for a
 * follow-up once a structured capability/remit source exists.
 *
 * TWO AUTHORITATIVE SOURCES, in priority order (mirrors
 * `plugin/scripts/emit-agent-identity.sh` exactly — see that file's header
 * for the full rationale). Both are authoritative, not
 * source-then-degraded-fallback:
 *
 *   1. `.macf/macf-agent.json` (via `readAgentConfig`) — full fidelity.
 *   2. The `MACF_*` / `APP_ID` / `INSTALL_ID` / `KEY_PATH` environment
 *      (sourced by `claude.sh` from `env.identity` / `env.github` /
 *      `env.registry` / `env.certs` before exec). This is the ONLY source
 *      for a `git worktree add` linked-worktree worker
 *      (`Agent(isolation:"worktree")`): `.macf/` is workspace-local +
 *      gitignored, so a worktree checkout never has it, but the worker
 *      inherits the spawning session's `MACF_*` env byte-for-byte. Some
 *      fields (`github_app.bot_login`, `versions.plugin`,
 *      `versions.actions`, `canonicalBranch` override) are simply never
 *      exported to env — genuinely unknown from this source, not a
 *      degraded guess.
 *
 * HONEST-UNKNOWN FLOOR: neither source resolves a field → the field reports
 * `'unknown'` with `source: 'unknown'`. Never falls back to a directory
 * name, a tmux session name, or any other inference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { agentCertPath, readAgentConfig, resolveCanonicalBranch, tokenSourceFromConfig } from '../config.js';
import type { MacfAgentConfig } from '../config.js';
import { fetchAppSlug, deriveBotLogin } from './doctor.js';

// ---------------------------------------------------------------------------
// Field-level result — every reported value carries its provenance so a
// caller (human or --json consumer) can tell "the authoritative answer is X"
// apart from "nothing resolved this, don't trust an absence of a value here
// as meaning X is falsy."
// ---------------------------------------------------------------------------

export type FieldSource = 'config' | 'env' | 'default' | 'unknown';

export interface WhoamiField {
  readonly value: string;
  readonly source: FieldSource;
}

export const UNKNOWN_FIELD: WhoamiField = { value: 'unknown', source: 'unknown' };

function field(value: string | undefined | null, source: Exclude<FieldSource, 'unknown'>): WhoamiField {
  if (value === undefined || value === null || value === '') return UNKNOWN_FIELD;
  return { value, source };
}

// ---------------------------------------------------------------------------
// Identity report
// ---------------------------------------------------------------------------

export interface IdentityReport {
  readonly project: WhoamiField;
  readonly agentName: WhoamiField;
  readonly agentRole: WhoamiField;
  readonly routingLabel: WhoamiField;
  readonly agentType: WhoamiField;
  readonly registryScope: WhoamiField;
  readonly registryTarget: WhoamiField;
  readonly appId: WhoamiField;
  readonly installId: WhoamiField;
  readonly botLogin: WhoamiField;
  readonly advertiseHost: WhoamiField;
  readonly canonicalBranch: WhoamiField;
  readonly operatorLogin: WhoamiField;
  readonly cliVersion: WhoamiField;
  readonly pluginVersion: WhoamiField;
  readonly actionsVersion: WhoamiField;
}

function formatRegistryTarget(registry: MacfAgentConfig['registry']): string {
  switch (registry.type) {
    case 'repo': return `${registry.owner}/${registry.repo}`;
    case 'org': return registry.org;
    case 'profile': return registry.user;
    case 'local': return registry.path;
  }
}

function formatRegistryTargetFromEnv(
  scope: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (scope) {
    case 'repo': return env['MACF_REGISTRY_REPO'];
    case 'org': return env['MACF_REGISTRY_ORG'];
    case 'profile': return env['MACF_REGISTRY_USER'];
    case 'local': return env['MACF_REGISTRY_PATH'];
    default: return undefined;
  }
}

/**
 * Build the identity report. Pure w.r.t. its inputs (no fs/network access)
 * so the honest-unknown floor is directly unit-testable: pass `config: null`
 * and an env with nothing MACF-shaped set, and every field must come back
 * `'unknown'` — never a guess.
 */
export function buildIdentityReport(
  config: MacfAgentConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): IdentityReport {
  // canonicalBranch always resolves (resolveCanonicalBranch has a real,
  // documented default of 'main' — that's a rule-backed default, not a
  // guess, so it gets source: 'default' rather than 'unknown').
  const canonicalBranchValue = resolveCanonicalBranch(config, env);
  const canonicalBranchSource: FieldSource = env['MACF_CANONICAL_BRANCH']
    ? 'env'
    : config?.canonicalBranch
      ? 'config'
      : 'default';
  const canonicalBranch: WhoamiField = { value: canonicalBranchValue, source: canonicalBranchSource };

  if (config) {
    const advertiseHost = config.advertise_host ?? '127.0.0.1';
    return {
      project: field(config.project, 'config'),
      agentName: field(config.agent_name, 'config'),
      agentRole: field(config.agent_role, 'config'),
      routingLabel: field(config.routing_label ?? config.agent_name, 'config'),
      agentType: field(config.agent_type, 'config'),
      registryScope: field(config.registry.type, 'config'),
      registryTarget: field(formatRegistryTarget(config.registry), 'config'),
      appId: field(config.github_app?.app_id, 'config'),
      installId: field(config.github_app?.install_id, 'config'),
      botLogin: field(config.github_app?.bot_login, 'config'),
      advertiseHost: field(advertiseHost, config.advertise_host ? 'config' : 'default'),
      canonicalBranch,
      operatorLogin: field(config.operator_login, 'config'),
      cliVersion: field(config.versions?.cli, 'config'),
      pluginVersion: field(config.versions?.plugin, 'config'),
      actionsVersion: field(config.versions?.actions, 'config'),
    };
  }

  // Source 2: MACF_* / APP_ID / INSTALL_ID / KEY_PATH env. Required as a
  // trio (project + agent_name + agent_role) before treating env as a
  // resolved identity — a partial/corrupt env is not meaningfully "this
  // agent", mirroring emit-agent-identity.sh's same all-or-nothing gate.
  const envProject = env['MACF_PROJECT'];
  const envAgentName = env['MACF_AGENT_NAME'];
  const envAgentRole = env['MACF_AGENT_ROLE'];
  if (envProject && envAgentName && envAgentRole) {
    const registryScope = env['MACF_REGISTRY_TYPE'];
    const advertiseHostEnv = env['MACF_ADVERTISE_HOST'];
    return {
      project: field(envProject, 'env'),
      agentName: field(envAgentName, 'env'),
      agentRole: field(envAgentRole, 'env'),
      routingLabel: field(env['MACF_ROUTING_LABEL'] ?? envAgentName, 'env'),
      agentType: field(env['MACF_AGENT_TYPE'], 'env'),
      registryScope: field(registryScope, 'env'),
      registryTarget: field(formatRegistryTargetFromEnv(registryScope, env), 'env'),
      appId: field(env['APP_ID'], 'env'),
      installId: field(env['INSTALL_ID'], 'env'),
      // bot_login is never exported to env by any generator — genuinely
      // unknown from this source, not a degraded guess.
      botLogin: UNKNOWN_FIELD,
      advertiseHost: field(advertiseHostEnv ?? '127.0.0.1', advertiseHostEnv ? 'env' : 'default'),
      canonicalBranch,
      operatorLogin: field(env['MACF_OPERATOR_LOGIN'], 'env'),
      cliVersion: field(env['MACF_VERSION'], 'env'),
      // plugin/actions version pins live only in macf-agent.json's
      // `versions` block — never exported to env.
      pluginVersion: UNKNOWN_FIELD,
      actionsVersion: UNKNOWN_FIELD,
    };
  }

  // Neither source resolved — honest-unknown across the board.
  return {
    project: UNKNOWN_FIELD,
    agentName: UNKNOWN_FIELD,
    agentRole: UNKNOWN_FIELD,
    routingLabel: UNKNOWN_FIELD,
    agentType: UNKNOWN_FIELD,
    registryScope: UNKNOWN_FIELD,
    registryTarget: UNKNOWN_FIELD,
    appId: UNKNOWN_FIELD,
    installId: UNKNOWN_FIELD,
    botLogin: UNKNOWN_FIELD,
    advertiseHost: UNKNOWN_FIELD,
    canonicalBranch,
    operatorLogin: UNKNOWN_FIELD,
    cliVersion: UNKNOWN_FIELD,
    pluginVersion: UNKNOWN_FIELD,
    actionsVersion: UNKNOWN_FIELD,
  };
}

// ---------------------------------------------------------------------------
// Cert CN + expiry
// ---------------------------------------------------------------------------

export interface CertInfo {
  readonly path: WhoamiField;
  readonly cn: WhoamiField;
  readonly expiresAt: WhoamiField;
}

/**
 * Extract the CN from a `node:crypto` `X509Certificate.subject` string.
 *
 * NOT the same format `@groundnuty/macf-core`'s `certs/agent-cert.ts::extractCN`
 * parses: that helper's regex expects a COMMA-separated subject
 * ("O=Foo,CN=bar" — the `@peculiar/x509` CSR `.subject` shape). Node's
 * built-in `X509Certificate.subject` is NEWLINE-separated ("O=Foo\nCN=bar")
 * — verified empirically against an openssl-generated leaf cert before
 * writing this rather than reusing `extractCN` and getting a silent
 * no-match (its regex requires CN to be preceded by `,` or start-of-string;
 * a newline before CN satisfies neither, so it returns `undefined` on every
 * real Node-parsed cert). The two subject formats are not interchangeable.
 */
export function extractSubjectCNFromNodeCert(subject: string): string | undefined {
  for (const line of subject.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('CN=')) return trimmed.slice('CN='.length);
  }
  return undefined;
}

export function readAgentCertInfo(
  certPath: string | undefined,
  source: 'config' | 'env',
): CertInfo {
  if (!certPath) {
    return { path: UNKNOWN_FIELD, cn: UNKNOWN_FIELD, expiresAt: UNKNOWN_FIELD };
  }
  const pathField = field(certPath, source);
  if (!existsSync(certPath)) {
    return { path: pathField, cn: UNKNOWN_FIELD, expiresAt: UNKNOWN_FIELD };
  }
  try {
    const cert = new X509Certificate(readFileSync(certPath, 'utf-8'));
    const cn = extractSubjectCNFromNodeCert(cert.subject);
    return {
      path: pathField,
      cn: cn ? field(cn, source) : UNKNOWN_FIELD,
      expiresAt: field(cert.validToDate.toISOString(), source),
    };
  } catch {
    return { path: pathField, cn: UNKNOWN_FIELD, expiresAt: UNKNOWN_FIELD };
  }
}

// ---------------------------------------------------------------------------
// Token-type check — the existing macf-whoami.sh job, kept as a sub-section
// (#672 explicitly: "Keep the current token-type check as a sub-section").
// This does NOT replace `.claude/scripts/macf-whoami.sh`, which is still
// shipped + referenced from coordination.md, and deliberately does NOT
// resolve a user token's login via a network `gh api user` call the way the
// shell script does — duplicating that here would make `macf whoami`
// require network access just to report identity, undermining the
// honest-unknown-first, local-first design. Run macf-whoami.sh for the
// login-resolved form.
// ---------------------------------------------------------------------------

export type TokenKind = 'bot' | 'user' | 'unknown-prefix' | 'unset';

export interface TokenTypeResult {
  readonly kind: TokenKind;
  readonly prefix: string | null;
  readonly detail: string;
}

export function classifyTokenType(ghToken: string | undefined): TokenTypeResult {
  if (!ghToken) {
    return { kind: 'unset', prefix: null, detail: 'GH_TOKEN is unset.' };
  }
  const prefix = ghToken.slice(0, 4);
  if (prefix === 'ghs_') {
    return { kind: 'bot', prefix, detail: 'bot installation token (prefix=ghs_)' };
  }
  if (prefix === 'ghp_' || prefix === 'gho_' || prefix === 'ghu_') {
    return {
      kind: 'user',
      prefix,
      detail:
        `user-attributed token (prefix=${prefix}) — NOT a bot installation token; ` +
        'gh/git-push ops will attribute to the operator, not the bot. Run ' +
        '.claude/scripts/macf-whoami.sh to resolve the login, or ' +
        '.claude/scripts/macf-gh-token.sh to mint a fresh bot token.',
    };
  }
  return { kind: 'unknown-prefix', prefix, detail: `unrecognized token prefix (${prefix})` };
}

// ---------------------------------------------------------------------------
// Best-effort bot_login resolution via GET /app (#672: "bot_login resolved
// from the App slug when absent"). Reuses doctor.ts's existing
// fetchAppSlug/deriveBotLogin — same JWT-mint path `macf doctor --fix`
// already exercises — rather than re-implementing RS256 signing. Read-only:
// unlike doctor's `repairBotLogin`, this NEVER writes macf-agent.json back;
// `macf whoami` is an inspection command, not a repair command.
// ---------------------------------------------------------------------------

export type BotLoginResolution = { readonly slug: string; readonly botLogin: string } | { readonly error: string };

async function resolveBotLoginBestEffort(
  appId: string | undefined,
  keyPath: string | undefined,
): Promise<BotLoginResolution | null> {
  if (!appId || !keyPath) return null;
  try {
    const slug = await fetchAppSlug(appId, keyPath);
    return { slug, botLogin: deriveBotLogin(slug) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(f: WhoamiField): string {
  return f.value === 'unknown' ? 'unknown' : `${f.value}  (source: ${f.source})`;
}

export function formatWhoamiReport(
  identity: IdentityReport,
  cert: CertInfo,
  token: TokenTypeResult,
  botLoginResolution: BotLoginResolution | null,
): string {
  const lines: string[] = [];
  lines.push('macf whoami — identity (#672 deterministic self-discovery, never inferred)');
  lines.push('');
  lines.push('Identity:');
  lines.push(`  project              ${fmt(identity.project)}`);
  lines.push(`  agent_name           ${fmt(identity.agentName)}`);
  lines.push(`  agent_role           ${fmt(identity.agentRole)}`);
  lines.push(`  routing_label        ${fmt(identity.routingLabel)}`);
  lines.push(`  agent_type           ${fmt(identity.agentType)}`);
  lines.push(`  canonical_branch     ${fmt(identity.canonicalBranch)}`);
  lines.push('');
  lines.push('GitHub App:');
  lines.push(`  app_id               ${fmt(identity.appId)}`);
  lines.push(`  install_id           ${fmt(identity.installId)}`);
  lines.push(`  bot_login            ${fmt(identity.botLogin)}`);
  if (identity.botLogin.value === 'unknown' && botLoginResolution) {
    if ('botLogin' in botLoginResolution) {
      lines.push(`    resolved via GET /app: ${botLoginResolution.botLogin} (slug=${botLoginResolution.slug})`);
    } else {
      lines.push(`    resolution attempted, failed: ${botLoginResolution.error}`);
    }
  }
  lines.push(`  operator_login       ${fmt(identity.operatorLogin)}`);
  lines.push('');
  lines.push('Registry:');
  lines.push(`  scope                ${fmt(identity.registryScope)}`);
  lines.push(`  target               ${fmt(identity.registryTarget)}`);
  lines.push(`  advertise_host       ${fmt(identity.advertiseHost)}`);
  lines.push('');
  lines.push('mTLS cert:');
  lines.push(`  path                 ${fmt(cert.path)}`);
  lines.push(`  CN                   ${fmt(cert.cn)}`);
  lines.push(`  expires_at           ${fmt(cert.expiresAt)}`);
  lines.push('');
  lines.push('Versions:');
  lines.push(`  cli                  ${fmt(identity.cliVersion)}`);
  lines.push(`  plugin               ${fmt(identity.pluginVersion)}`);
  lines.push(`  actions              ${fmt(identity.actionsVersion)}`);
  lines.push('');
  lines.push('Token attribution (see .claude/scripts/macf-whoami.sh for the login-resolved form):');
  lines.push(`  ${token.detail}`);
  lines.push('');
  lines.push(
    'NOT implemented (#672 "(2) Capabilities + fleet context"): role remit, ' +
    'peers, and which repos route here have no structured non-prose source ' +
    'yet — see this file\'s header comment.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface WhoamiOptions {
  readonly json?: boolean;
  /** Set false to skip the best-effort network bot_login resolution. */
  readonly resolveBotLogin?: boolean;
}

/**
 * `projectDir` is NOT required to contain `.macf/macf-agent.json` — unlike
 * most `--dir`-taking commands (see `requireProjectRoot`), `macf whoami`
 * must work from a linked-worktree worker that never has that file (see
 * file header). Pass `process.cwd()` (or an explicit `--dir`) regardless of
 * whether it looks like a MACF project; `readAgentConfig` degrades to
 * `null` gracefully and the env-source path takes over.
 */
export async function runWhoami(projectDir: string, opts: WhoamiOptions = {}): Promise<number> {
  const config = readAgentConfig(projectDir);
  const identity = buildIdentityReport(config, process.env);

  const certPath = config ? agentCertPath(projectDir) : process.env['MACF_AGENT_CERT'];
  const cert = readAgentCertInfo(certPath, config ? 'config' : 'env');

  const token = classifyTokenType(process.env['GH_TOKEN']);

  let botLoginResolution: BotLoginResolution | null = null;
  if (opts.resolveBotLogin !== false && identity.botLogin.value === 'unknown') {
    if (config?.github_app) {
      const source = tokenSourceFromConfig(projectDir, config);
      botLoginResolution = await resolveBotLoginBestEffort(source.appId, source.keyPath);
    } else if (identity.appId.value !== 'unknown') {
      const rawKeyPath = process.env['KEY_PATH'];
      const keyPath = rawKeyPath ? resolve(projectDir, rawKeyPath) : undefined;
      botLoginResolution = await resolveBotLoginBestEffort(identity.appId.value, keyPath);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ identity, cert, token, botLoginResolution }, null, 2));
  } else {
    console.log(formatWhoamiReport(identity, cert, token, botLoginResolution));
  }
  return 0;
}
