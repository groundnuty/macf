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
 * command implements #672's "(1) Identity" field list in full, PLUS the
 * "peers" slice of "(2) Capabilities + fleet context" (per the
 * science-agent's 2026-08-31 correction of the original over-broad
 * refusal — see below). It does NOT implement the REST of "(2)" (role's
 * declared remit, which repos route here) — those have no structured,
 * non-prose source in the codebase today (role remit lives only in prose
 * `.claude/rules/agent-identity.md`; "which repos route to me" would need
 * cross-repo enumeration this workspace has no local record of). Inventing
 * a capability model to fill THAT gap would be a differently-shaped
 * inference — the exact failure mode #672 is about. That's left for a
 * follow-up once a structured capability/remit source exists.
 *
 * WHY PEERS IS DIFFERENT (not the same refusal as role-remit): peers are
 * not prose to be structured — they are `<PROJECT>_AGENT_<name>` entries
 * already living in the registry as a lookup table, the exact same store
 * `route-by-label` already reads. Listing them is READING an existing
 * structured store, not INVENTING a model. And an empty result is
 * informative on its own: `macf whoami` reporting "peers: none
 * registered" on a fleet that should have N agents is a FINDING (a
 * registration failure), not a gap in the command — see #672's registered
 * comment thread for the live incident (`#800`) this would have caught
 * immediately instead of at the end of a multi-hour trace.
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
import { createRegistryFromConfig, generateToken } from '@groundnuty/macf-core';
import type { AgentInfo, Registry, RegistryConfig } from '@groundnuty/macf-core';

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
// Peers — read from the registry (#672 comment thread, science-agent
// 2026-08-31). See the file-header "WHY PEERS IS DIFFERENT" note: this is
// READING an existing `<PROJECT>_AGENT_<name>` lookup table (the same one
// `route-by-label` and `macf peers` already read), not inventing a model.
//
// THREE STATES, never collapsed into each other (the specific defect this
// must not have — see whoami.test.ts's mutation-check test):
//   - 'found'      — the registry has one or more `<PROJECT>_AGENT_*` entries.
//   - 'empty'      — the registry was read successfully and has NONE. This is
//                    a RESULT (a finding, per the file header), not an error
//                    and not 'unknown' — reported the same honest way an
//                    empty-but-legitimate identity field would be.
//   - 'unreadable' — the registry could not be read at all (network/
//                    permission failure, or the scope itself is unresolved).
//                    Reported like an unknown identity field: we genuinely
//                    don't know, as opposed to knowing it's empty.
// Plus 'skipped' — the read was never attempted (offline / --no-resolve-peers
// opt-out, mirroring --no-resolve-bot-login's precedent). Distinct from
// 'unreadable': this is an intentional non-attempt, not a failed one.
// ---------------------------------------------------------------------------

export type PeersKind = 'found' | 'empty' | 'unreadable' | 'skipped';

export interface PeerSummary {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly type: string;
  readonly started: string;
}

export interface PeersResult {
  readonly kind: PeersKind;
  readonly peers: ReadonlyArray<PeerSummary>;
  readonly detail: string;
}

/**
 * Reuses the scope decision `buildIdentityReport` ALREADY made
 * (`identity.registryScope.source`) rather than re-deriving config-vs-env
 * dispatch from scratch. When config-sourced, `config.registry` is reused
 * directly (zero re-derivation — it's the very object `registryScope` was
 * read from). When env-sourced, reconstructs the structured `RegistryConfig`
 * `createRegistryFromConfig` needs from the same flat `MACF_REGISTRY_*` vars
 * `buildIdentityReport`'s env branch reads (unavoidable: env only carries
 * flat strings, no structured object to reuse). Returns `null` when the
 * scope itself never resolved — the 'unreadable' case at its widest.
 */
export function resolveRegistryConfigForPeers(
  identity: IdentityReport,
  config: MacfAgentConfig | null,
  env: NodeJS.ProcessEnv,
): RegistryConfig | null {
  if (identity.registryScope.source === 'config' && config) {
    return config.registry;
  }
  if (identity.registryScope.source === 'env') {
    switch (identity.registryScope.value) {
      case 'org': {
        const org = env['MACF_REGISTRY_ORG'];
        return org ? { type: 'org', org } : null;
      }
      case 'profile': {
        const user = env['MACF_REGISTRY_USER'];
        return user ? { type: 'profile', user } : null;
      }
      case 'repo': {
        // MACF_REGISTRY_REPO is the already-combined "owner/repo" string
        // (env-files.ts/claude-sh.ts write it that way) — split it back
        // apart into the two fields createRegistryFromConfig's repo arm
        // needs.
        const repoVar = env['MACF_REGISTRY_REPO'];
        const slash = repoVar?.indexOf('/') ?? -1;
        if (!repoVar || slash <= 0 || slash === repoVar.length - 1) return null;
        return { type: 'repo', owner: repoVar.slice(0, slash), repo: repoVar.slice(slash + 1) };
      }
      case 'local': {
        const path = env['MACF_REGISTRY_PATH'];
        return path ? { type: 'local', path } : null;
      }
      default:
        return null;
    }
  }
  return null;
}

/**
 * Token source for minting an installation token to read the registry.
 * Same config-then-env precedence the bot_login resolution above uses, but
 * requires `install_id` too — unlike the App-level `GET /app` bot_login
 * lookup, minting an installation token needs it. Returns `undefined` when
 * neither source has the full triple; `generateToken` itself still falls
 * back to `GH_TOKEN` / `APP_ID` / `INSTALL_ID` / `KEY_PATH` env in that case.
 */
function resolvePeersTokenSource(
  projectDir: string,
  config: MacfAgentConfig | null,
  identity: IdentityReport,
): { appId: string; installId: string; keyPath: string } | undefined {
  if (config?.github_app) return tokenSourceFromConfig(projectDir, config);
  const rawKeyPath = process.env['KEY_PATH'];
  if (identity.appId.value !== 'unknown' && identity.installId.value !== 'unknown' && rawKeyPath) {
    return { appId: identity.appId.value, installId: identity.installId.value, keyPath: resolve(projectDir, rawKeyPath) };
  }
  return undefined;
}

/**
 * Read peers from an already-constructed registry. Deliberately isolated
 * from scope resolution + token minting so the found/empty/unreadable
 * trichotomy — the decisive behavior under test — is directly unit-testable
 * with a fake `{ list }`, without any network mocking (mirrors this file's
 * existing convention of not re-testing `fetchAppSlug`'s network path here).
 */
export async function readPeersFromRegistry(
  registry: Pick<Registry, 'list'>,
): Promise<PeersResult> {
  let peers: ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>;
  try {
    peers = await registry.list('');
  } catch (err) {
    return { kind: 'unreadable', peers: [], detail: err instanceof Error ? err.message : String(err) };
  }

  if (peers.length === 0) {
    return { kind: 'empty', peers: [], detail: 'none registered' };
  }

  return {
    kind: 'found',
    peers: peers.map((p) => ({
      name: p.name,
      host: p.info.host,
      port: p.info.port,
      type: p.info.type,
      started: p.info.started,
    })),
    detail: `${peers.length} peer(s) registered`,
  };
}

/**
 * Orchestration: skip check → scope resolution → (local: no token needed;
 * else: mint one) → read. Each early-return branch (skip / unresolved scope
 * / token-mint failure) is side-effect-free before it returns, so the
 * offline/opt-out behavior is directly testable without network mocking.
 */
export async function resolvePeersReport(
  projectDir: string,
  config: MacfAgentConfig | null,
  identity: IdentityReport,
  opts: { readonly resolvePeers?: boolean } = {},
): Promise<PeersResult> {
  if (opts.resolvePeers === false) {
    return { kind: 'skipped', peers: [], detail: 'skipped (--no-resolve-peers)' };
  }

  const registryConfig = resolveRegistryConfigForPeers(identity, config, process.env);
  if (!registryConfig) {
    return { kind: 'unreadable', peers: [], detail: 'registry scope is unknown — cannot resolve peers' };
  }

  let token = '';
  if (registryConfig.type !== 'local') {
    try {
      token = await generateToken(resolvePeersTokenSource(projectDir, config, identity));
    } catch (err) {
      return {
        kind: 'unreadable',
        peers: [],
        detail: `could not obtain a registry token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const registry = createRegistryFromConfig(registryConfig, identity.project.value, token);
  return readPeersFromRegistry(registry);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(f: WhoamiField): string {
  return f.value === 'unknown' ? 'unknown' : `${f.value}  (source: ${f.source})`;
}

function formatPeersSection(peers: PeersResult): string[] {
  const lines: string[] = ['Peers (read from the registry, macf#672):'];
  switch (peers.kind) {
    case 'found':
      for (const p of peers.peers) {
        lines.push(`  ${p.name.padEnd(24)} ${p.host}:${p.port}  (${p.type})`);
      }
      break;
    case 'empty':
      lines.push('  none registered');
      break;
    case 'skipped':
      lines.push(`  ${peers.detail}`);
      break;
    case 'unreadable':
      lines.push(`  unknown  (${peers.detail})`);
      break;
  }
  return lines;
}

export function formatWhoamiReport(
  identity: IdentityReport,
  cert: CertInfo,
  token: TokenTypeResult,
  botLoginResolution: BotLoginResolution | null,
  peers: PeersResult,
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
  lines.push(...formatPeersSection(peers));
  lines.push('');
  lines.push(
    'NOT implemented (#672 "(2) Capabilities + fleet context"): role remit ' +
    'and which repos route here have no structured non-prose source yet — ' +
    'see this file\'s header comment. Peers ARE implemented (above).',
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
  /** Set false to skip the best-effort network peer-registry read. */
  readonly resolvePeers?: boolean;
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

  const peers = await resolvePeersReport(projectDir, config, identity, { resolvePeers: opts.resolvePeers });

  if (opts.json) {
    console.log(JSON.stringify({ identity, cert, token, botLoginResolution, peers }, null, 2));
  } else {
    console.log(formatWhoamiReport(identity, cert, token, botLoginResolution, peers));
  }
  return 0;
}
