/**
 * `macf bootstrap preflight` checks: is this machine (and the VM) ready for
 * `bootstrap apply`? Read-only: it reads files, runs `--version`-style
 * commands and makes plain HTTP requests. Every external call goes through
 * {@link PreflightDeps} so tests drive it with no network, ssh or disk.
 *
 * A secret VALUE is never put in a check's text: only key names, paths and
 * the source tier appear.
 */
import { compareSemver } from '@groundnuty/macf-core';
import type { FleetManifest } from './fleet-manifest.js';
import { parseFleetManifest } from './fleet-manifest.js';
import { controlRepoFullName } from './control-repo.js';
import { TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR } from './apply-routing-secrets.js';
import { RUNNER_TOKEN_ENV_VAR } from './apply-routing.js';
import {
  RUNNER_PLATFORM_ENDPOINT_ENV_VAR,
  registerRunnerPlatformEndpointFileTier,
  resolveRunnerPlatformEndpointWithProvenance,
  type RunnerPlatformEndpointSource,
} from './runner-platform.js';
import { registryPathPrefix } from '../registry-helper.js';
import { parseOperatorSecretsFile, missingRequiredOperatorInputs } from './operator-secrets-file.js';
import { resolvePreflightInput, type OperatorInputs } from './preflight-inputs.js';
import { ghTokenListed } from './preflight-agent-host.js';
import { applyFlagRefusalChecks, applyManifestRefusalChecks } from './preflight-apply-refusals.js';

export const PREFLIGHT_JSON_SCHEMA_VERSION = 1;

export type PreflightStatus = 'ok' | 'missing' | 'wrong' | 'unknown';

export interface PreflightCheck {
  readonly id: string;
  readonly group: 'tools' | 'manifest' | 'secrets' | 'endpoint' | 'identity' | 'browser' | 'agent-host';
  readonly status: PreflightStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The program could not be started at all (not on PATH). */
  readonly spawnFailed?: boolean;
}

export interface FetchResult {
  /** The host answered with an HTTP response (any status). */
  readonly reached: boolean;
  /** The HTTP status when `reached`; absent when the host did not answer. */
  readonly status?: number;
  readonly detail: string;
}

export interface PreflightDeps {
  readonly exec: (cmd: string, args: readonly string[], opts?: { readonly timeoutMs?: number; readonly input?: string }) => Promise<ExecResult>;
  readonly fetchUrl: (url: string, timeoutMs: number) => Promise<FetchResult>;
  /** File text, or `undefined` when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
  /** `mode` is the permission bits only (`& 0o777`). */
  readonly fileMode: (path: string) => { readonly exists: boolean; readonly mode?: number };
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `process.platform`: 'darwin', 'linux', ... */
  readonly platform: string;
  readonly nodeVersion: string;
  readonly cliVersion: string;
}

export interface PreflightOptions {
  readonly file: string;
  readonly secretsPath?: string;
  /** Apply's per-scope secrets file, shared across a scope's fleets. */
  readonly scopeSecretsPath?: string;
  /** Apply's `--runner-token`, `--ts-oauth-client-id` and `--ts-oauth-secret`. */
  readonly runnerToken?: string;
  readonly tsOauthClientId?: string;
  readonly tsOauthSecret?: string;
  readonly identityKeyPath?: string;
  /** The vault apply would be given; only used to judge the vault flags together. */
  readonly vaultPath?: string;
  readonly agentHost?: string;
}

export const MIN_NODE = '22.12.0';
const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const NET_TIMEOUT_MS = 5000;

function check(id: string, group: PreflightCheck['group'], status: PreflightStatus, detail: string, fix?: string): PreflightCheck {
  return fix === undefined ? { id, group, status, detail } : { id, group, status, detail, fix };
}

function firstSemver(text: string): string | undefined {
  return SEMVER_RE.exec(text)?.[1];
}

// --- 1. Tools here ---

function nodeCheck(deps: PreflightDeps): PreflightCheck {
  const have = firstSemver(deps.nodeVersion);
  if (have === undefined) return check('node', 'tools', 'unknown', `could not read the node version "${deps.nodeVersion}"`);
  if (compareSemver(have, MIN_NODE) < 0) {
    return check('node', 'tools', 'wrong', `node ${have} is older than ${MIN_NODE}`, 'install Node.js 22.12 or later');
  }
  return check('node', 'tools', 'ok', `node ${have}`);
}

/** Why a probe that started did not succeed: the first line of stderr, else the exit state. */
function probeFailure(r: ExecResult): string {
  const line = r.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? (r.code === null ? 'it did not finish' : `it exited ${r.code}`);
}

async function macfOnPathCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const r = await deps.exec('macf', ['--version'], { timeoutMs: 10000 });
  const fix = `npm install -g @groundnuty/macf@${deps.cliVersion}`;
  if (r.spawnFailed === true) return check('macf-on-path', 'tools', 'missing', 'macf is not on PATH', fix);
  if (r.code !== 0) return check('macf-on-path', 'tools', 'wrong', `macf --version failed: ${probeFailure(r)}`, fix);
  const onPath = firstSemver(r.stdout);
  if (onPath === undefined) return check('macf-on-path', 'tools', 'unknown', 'macf --version printed no version');
  if (onPath !== deps.cliVersion) {
    return check('macf-on-path', 'tools', 'wrong', `macf on PATH is ${onPath} but this CLI is ${deps.cliVersion}`, fix);
  }
  return check('macf-on-path', 'tools', 'ok', `macf ${onPath} on PATH, same as this CLI`);
}

function parseGhApi(stdout: string): { readonly login?: string; readonly scopes?: readonly string[] } {
  const split = stdout.split(/\r?\n\r?\n/);
  const headers = split[0] ?? '';
  const body = split.slice(1).join('\n\n');
  let login: string | undefined;
  try {
    const parsed = JSON.parse(body) as { login?: unknown };
    if (typeof parsed.login === 'string') login = parsed.login;
  } catch {
    // body is not JSON: login stays undefined
  }
  const header = /^x-oauth-scopes:\s*(.*)$/im.exec(headers);
  const scopes = header === null ? undefined : (header[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return { ...(login !== undefined ? { login } : {}), ...(scopes !== undefined ? { scopes } : {}) };
}

function ghScopeResult(login: string, scopes: readonly string[] | undefined, manifest: FleetManifest | undefined): PreflightCheck {
  if (scopes === undefined) {
    return check('gh', 'tools', 'unknown', `gh is logged in as ${login}; the token reports no scopes (fine-grained or app token), so they were not checked`);
  }
  const have = `gh is logged in as ${login} with scopes: ${scopes.join(', ') || 'none'}`;
  if (manifest === undefined) return check('gh', 'tools', 'ok', have);
  const needed = manifest.owner.type === 'org' ? ['workflow', 'repo', 'admin:org'] : ['workflow', 'repo'];
  const absent = needed.filter((s) => !scopes.includes(s));
  if (absent.length > 0) {
    return check('gh', 'tools', 'wrong', `${have}; missing ${absent.join(', ')}`, `gh auth refresh -h github.com -s ${absent.join(',')}`);
  }
  if (manifest.owner.type === 'user' && login.toLowerCase() !== manifest.owner.account.toLowerCase()) {
    return check('gh', 'tools', 'wrong', `${have}; the manifest's owner.account is ${manifest.owner.account}`, `gh auth login as ${manifest.owner.account}`);
  }
  return check('gh', 'tools', 'ok', have);
}

async function ghCheck(deps: PreflightDeps, manifest: FleetManifest | undefined): Promise<PreflightCheck> {
  const r = await deps.exec('gh', ['api', '-i', 'user'], { timeoutMs: 15000 });
  if (r.spawnFailed === true) return check('gh', 'tools', 'missing', 'gh is not on PATH', 'install the GitHub CLI (https://cli.github.com)');
  if (r.code === null) return check('gh', 'tools', 'wrong', `gh could not run: ${probeFailure(r)}`, 'check that the gh binary is executable and not hung');
  if (r.code !== 0) return check('gh', 'tools', 'missing', 'gh is not logged in', 'gh auth login');
  const { login, scopes } = parseGhApi(r.stdout);
  if (login === undefined) return check('gh', 'tools', 'unknown', 'gh answered but the login could not be read');
  return ghScopeResult(login, scopes, manifest);
}

/**
 * apply mints App tokens with `gh token generate` on THIS machine, so the extension must be here.
 * Only run with --agent-host: with no agent host the agent-host probe already covers this machine.
 */
async function ghTokenExtensionCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const fix = 'gh extension install Link-/gh-token';
  const r = await deps.exec('gh', ['extension', 'list'], { timeoutMs: 15000 });
  if (r.spawnFailed === true) return check('gh-token', 'tools', 'missing', 'gh is not on PATH, so the gh-token extension cannot be checked', 'install the GitHub CLI (https://cli.github.com)');
  if (r.code !== 0) return check('gh-token', 'tools', 'wrong', `gh extension list failed: ${probeFailure(r)}`, 'run gh extension list by hand to see the error');
  if (ghTokenListed(r.stdout)) return check('gh-token', 'tools', 'ok', 'the gh-token extension is installed on this machine (apply mints App tokens with it)');
  return check('gh-token', 'tools', 'missing', 'the gh-token extension is not installed on this machine (apply mints App tokens with it)', fix);
}

/** apply runs `git clone`, `add`, `commit` and `push` on this machine (control repo, repo-init, deploy). */
async function gitCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const r = await deps.exec('git', ['--version'], { timeoutMs: 10000 });
  if (r.spawnFailed === true) return check('git', 'tools', 'missing', 'git is not on PATH', 'install git (brew install git on Mac, sudo apt install git on Ubuntu)');
  if (r.code !== 0) return check('git', 'tools', 'wrong', `git --version failed: ${probeFailure(r)}`, 'reinstall git and check the binary is executable');
  return check('git', 'tools', 'ok', `git ${firstSemver(r.stdout) ?? 'present'}`);
}

async function ageCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const r = await deps.exec('age', ['--version'], { timeoutMs: 10000 });
  if (r.spawnFailed === true) {
    return check('age', 'tools', 'missing', 'age is not on PATH', 'brew install age (Mac) or sudo apt install age (Ubuntu)');
  }
  if (r.code !== 0) {
    return check('age', 'tools', 'wrong', `age --version failed: ${probeFailure(r)}`, 'reinstall age (brew install age on Mac, sudo apt install age on Ubuntu) and check the binary is executable');
  }
  return check('age', 'tools', 'ok', `age ${firstSemver(r.stdout) ?? 'present'}`);
}

const MAC_TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** `tailscale`, or on macOS the app's own CLI when the command is not on PATH. */
async function tailscaleExec(deps: PreflightDeps, args: readonly string[]): Promise<ExecResult> {
  const r = await deps.exec('tailscale', args, { timeoutMs: 10000 });
  if (r.spawnFailed === true && deps.platform === 'darwin') return deps.exec(MAC_TAILSCALE_APP, args, { timeoutMs: 10000 });
  return r;
}

async function tailscaleStatusJson(deps: PreflightDeps): Promise<{ readonly spawnFailed: boolean; readonly json?: Record<string, unknown> }> {
  const r = await tailscaleExec(deps, ['status', '--json']);
  if (r.spawnFailed === true) return { spawnFailed: true };
  try {
    return { spawnFailed: false, json: JSON.parse(r.stdout) as Record<string, unknown> };
  } catch {
    return { spawnFailed: false };
  }
}

async function tailscaleCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const s = await tailscaleStatusJson(deps);
  if (s.spawnFailed) return check('tailscale', 'tools', 'unknown', 'tailscale is not installed here, so the runner endpoint cannot be tried by IP');
  if (s.json === undefined) return check('tailscale', 'tools', 'unknown', 'tailscale status gave no readable answer');
  const state = s.json['BackendState'];
  if (state !== 'Running') return check('tailscale', 'tools', 'wrong', `tailscale is ${String(state)}, not Running`, 'tailscale up');
  return check('tailscale', 'tools', 'ok', 'tailscale is Running');
}

// --- 1b. A browser for the consent pages (apply host only) ---

/** `apply` opens pages with `open` (macOS) or `xdg-open` (Linux); see `realOpenUrl` in bootstrap-apply.ts. */
export async function browserCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const id = 'browser';
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    return check(id, 'browser', 'unknown', `cannot tell whether a browser can be opened on ${deps.platform}`);
  }
  const opener = deps.platform === 'darwin' ? 'open' : 'xdg-open';
  const found = await deps.exec('sh', ['-c', `command -v ${opener}`], { timeoutMs: 5000 });
  if (found.code !== 0) {
    return check(id, 'browser', 'missing', `${opener} is not on PATH, so apply cannot open the consent pages`, deps.platform === 'linux' ? 'install xdg-utils, or run apply on a machine with a browser' : 'run apply on a machine with a browser');
  }
  if (deps.platform === 'linux' && !deps.env['DISPLAY'] && !deps.env['WAYLAND_DISPLAY']) {
    return check(id, 'browser', 'wrong', `${opener} exists but neither DISPLAY nor WAYLAND_DISPLAY is set, so no browser can open here`, 'run apply from a desktop session on the machine whose browser is logged in to GitHub');
  }
  return check(id, 'browser', 'ok', deps.platform === 'darwin' ? 'open is available' : 'xdg-open is available and a display is set');
}

// --- 2. The manifest ---

export interface ManifestLoad {
  readonly manifest?: FleetManifest;
  readonly checks: readonly PreflightCheck[];
}

function versionsChecks(manifest: FleetManifest, cliVersion: string): readonly PreflightCheck[] {
  const v = manifest.versions;
  const out: PreflightCheck[] = [];
  const fixDecl = (k: string): string => `add versions.${k} to fleet.yaml`;
  if (v?.macf === undefined) out.push(check('manifest-versions-macf', 'manifest', 'missing', 'versions.macf is not declared', fixDecl('macf')));
  else {
    const cmp = compareSemver(v.macf, cliVersion);
    if (cmp > 0) out.push(check('manifest-versions-macf', 'manifest', 'wrong', `versions.macf ${v.macf} is newer than this CLI ${cliVersion}`, `npm install -g @groundnuty/macf@${v.macf}`));
    else if (cmp < 0) out.push(check('manifest-versions-macf', 'manifest', 'ok', `versions.macf ${v.macf} is older than this CLI ${cliVersion}`));
    else out.push(check('manifest-versions-macf', 'manifest', 'ok', `versions.macf ${v.macf} equals this CLI`));
  }
  if (v?.actions === undefined) out.push(check('manifest-versions-actions', 'manifest', 'missing', 'versions.actions is not declared', fixDecl('actions')));
  else out.push(check('manifest-versions-actions', 'manifest', 'ok', `versions.actions ${v.actions}`));
  return out;
}

export function loadManifestChecks(deps: PreflightDeps, file: string): ManifestLoad {
  const text = deps.readText(file);
  if (text === undefined) {
    return { checks: [check('manifest', 'manifest', 'missing', `fleet manifest not found or unreadable: ${file}`, 'pass the path to fleet.yaml with -f')] };
  }
  let manifest: FleetManifest;
  try {
    manifest = parseFleetManifest(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { checks: [check('manifest', 'manifest', 'wrong', `fleet manifest failed validation: ${msg.split('\n')[0]}`, 'fix fleet.yaml; `macf bootstrap plan -f` prints the full error')] };
  }
  const checks = [
    check('manifest', 'manifest', 'ok', `${manifest.metadata.name} parses`),
    check('manifest-owner-type', 'manifest', 'ok', `owner.type is ${manifest.owner.type}`),
    ...versionsChecks(manifest, deps.cliVersion),
  ];
  return { manifest, checks };
}

// --- 3. secrets.env ---

interface RequiredKey {
  readonly key: string;
  readonly why: string;
}

function requiredSecretKeys(manifest: FleetManifest): readonly RequiredKey[] {
  const keys: RequiredKey[] = [];
  // Same condition apply uses (bootstrap-apply.ts missing-inputs check).
  if (manifest.transport.tailscale_oauth_required) {
    keys.push({ key: TS_OAUTH_CLIENT_ID_ENV_VAR, why: 'Tailscale OAuth client id' });
    keys.push({ key: TS_OAUTH_SECRET_ENV_VAR, why: 'Tailscale OAuth secret' });
  }
  return keys;
}

function secretsFileCheck(deps: PreflightDeps, path: string, id = 'secrets-file'): { readonly check: PreflightCheck; readonly values?: Readonly<Record<string, string>> } {
  const m = deps.fileMode(path);
  if (!m.exists) return { check: check(id, 'secrets', 'missing', `${path} does not exist`, 'macf bootstrap secrets template --out secrets.env') };
  const text = deps.readText(path);
  if (text === undefined) return { check: check(id, 'secrets', 'wrong', `${path} cannot be read`, `chmod 600 ${path}`) };
  const values = parseOperatorSecretsFile(text);
  if (m.mode !== undefined && (m.mode & 0o077) !== 0) {
    return { check: check(id, 'secrets', 'wrong', `${path} has mode ${m.mode.toString(8)}, not 600`, `chmod 600 ${path}`), values };
  }
  return { check: check(id, 'secrets', 'ok', `${path} exists with mode 600`), values };
}

const SECRET_SOURCE_LABEL: Readonly<Record<string, string>> = {
  flag: 'a flag',
  'fleet-file': 'the secrets file',
  'scope-file': 'the scope secrets file',
  env: 'the environment',
};

function secretKeyCheck(req: RequiredKey, source: string, isMissing: boolean, files: readonly string[], vaultGiven: boolean): PreflightCheck {
  const id = `secret-${req.key}`;
  if (!isMissing) return check(id, 'secrets', 'ok', `${req.key} (${req.why}) is set in ${SECRET_SOURCE_LABEL[source] ?? 'the environment'}`);
  if (vaultGiven) return check(id, 'secrets', 'unknown', `${req.key} (${req.why}) is not set here; it may be in the vault, which preflight does not decrypt`);
  const where = files.length > 0 ? `${files.join(', ')} or the environment` : 'the environment (no --secrets-file given)';
  return check(id, 'secrets', 'missing', `${req.key} (${req.why}) is not set in ${where}`, `set ${req.key} in secrets.env`);
}

export function secretsChecks(
  deps: PreflightDeps,
  manifest: FleetManifest | undefined,
  opts: Pick<PreflightOptions, 'secretsPath' | 'scopeSecretsPath' | 'runnerToken' | 'tsOauthClientId' | 'tsOauthSecret'>,
  vaultGiven = false,
): { readonly checks: readonly PreflightCheck[]; readonly inputs: OperatorInputs } {
  const checks: PreflightCheck[] = [];
  let fleet: Readonly<Record<string, string>> | undefined;
  let scope: Readonly<Record<string, string>> | undefined;
  if (opts.secretsPath === undefined) {
    checks.push(check('secrets-file', 'secrets', 'unknown', 'no --secrets-file given, so none was checked', 'pass --secrets-file <path>'));
  } else {
    const r = secretsFileCheck(deps, opts.secretsPath);
    checks.push(r.check);
    fleet = r.values;
  }
  if (opts.scopeSecretsPath !== undefined) {
    const r = secretsFileCheck(deps, opts.scopeSecretsPath, 'scope-secrets-file');
    checks.push(r.check);
    scope = r.values;
  }
  const inputs: OperatorInputs = {
    ...(fleet !== undefined ? { fleet } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(opts.runnerToken !== undefined ? { runnerToken: opts.runnerToken } : {}),
    ...(opts.tsOauthClientId !== undefined ? { tsOauthClientId: opts.tsOauthClientId } : {}),
    ...(opts.tsOauthSecret !== undefined ? { tsOauthSecret: opts.tsOauthSecret } : {}),
  };
  if (manifest !== undefined) {
    // Apply's own aggregate: the keys it would refuse on as missing.
    const required = requiredSecretKeys(manifest);
    const resolved = required.map((r) => ({ req: r, res: resolvePreflightInput(deps.env, inputs, r.key) }));
    const missing = new Set(missingRequiredOperatorInputs(resolved.map((r) => ({ key: r.req.key, required: true, value: r.res.value }))));
    const files = [...(opts.secretsPath !== undefined ? ['the secrets file'] : []), ...(opts.scopeSecretsPath !== undefined ? ['the scope secrets file'] : [])];
    for (const r of resolved) checks.push(secretKeyCheck(r.req, r.res.source, missing.has(r.req.key), files, vaultGiven));
  }
  return { checks, inputs };
}

// --- 4. The runner platform endpoint ---

const ENDPOINT_SOURCE_LABEL: Readonly<Record<Exclude<RunnerPlatformEndpointSource, 'none'>, string>> = {
  flag: 'the environment',
  env: `the ${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} environment variable`,
  'fleet-file': 'the secrets file',
  'scope-file': 'the scope secrets file',
  scope: "the scope's shared Actions variable",
  manifest: 'transport.runner_platform_endpoint in fleet.yaml',
};

const ENDPOINT_FIX =
  `set ${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} in the environment or in secrets.env, as a shared Actions variable on the scope, ` +
  'or set transport.runner_platform_endpoint in fleet.yaml';

const ENDPOINT_OR_TOKEN_FIX = `${ENDPOINT_FIX} (preferred); or pass a runner-registration token as ${RUNNER_TOKEN_ENV_VAR}`;

type ScopeRead = { readonly value?: string; readonly state: 'read' | 'absent' | 'unreadable' };

/** A GET of the scope's shared variable, the same read plan makes. Never throws. */
async function readScopeEndpoint(deps: PreflightDeps, manifest: FleetManifest): Promise<ScopeRead> {
  let prefix: string;
  try {
    prefix = registryPathPrefix(manifest.owner.registry);
  } catch {
    return { state: 'unreadable' };
  }
  const r = await deps.exec('gh', ['api', `${prefix.replace(/^\//, '')}/actions/variables/${RUNNER_PLATFORM_ENDPOINT_ENV_VAR}`, '--jq', '.value'], { timeoutMs: 15000 });
  if (r.spawnFailed === true) return { state: 'unreadable' };
  if (r.code === 0) {
    const value = r.stdout.trim();
    return value.length > 0 ? { value, state: 'read' } : { state: 'absent' };
  }
  return /404|Not Found/i.test(r.stderr + r.stdout) ? { state: 'absent' } : { state: 'unreadable' };
}

/** Apply's own chain: flag, env, secrets file, scope variable, manifest. */
async function resolveEndpoint(
  deps: PreflightDeps,
  manifest: FleetManifest | undefined,
  inputs: OperatorInputs | undefined,
): Promise<{ readonly value?: string; readonly source: RunnerPlatformEndpointSource; readonly scope: ScopeRead }> {
  const envValue = deps.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR];
  const manifestValue = manifest?.transport.runner_platform_endpoint;
  registerRunnerPlatformEndpointFileTier(inputs?.fleet?.[RUNNER_PLATFORM_ENDPOINT_ENV_VAR], inputs?.scope?.[RUNNER_PLATFORM_ENDPOINT_ENV_VAR]);
  try {
    const first = resolveRunnerPlatformEndpointWithProvenance({ explicit: envValue, manifestValue: undefined, scopeValue: undefined });
    if (first.value !== undefined) return { value: first.value, source: first.source === 'flag' ? 'env' : first.source, scope: { state: 'unreadable' } };
    const scope: ScopeRead = manifest === undefined ? { state: 'unreadable' } : await readScopeEndpoint(deps, manifest);
    const full = resolveRunnerPlatformEndpointWithProvenance({ explicit: undefined, manifestValue, scopeValue: scope.value });
    return { ...(full.value !== undefined ? { value: full.value } : {}), source: full.source, scope };
  } finally {
    registerRunnerPlatformEndpointFileTier(undefined, undefined);
  }
}

async function resolveTailnetIp(deps: PreflightDeps, host: string): Promise<string | undefined> {
  const viaIp = await tailscaleExec(deps, ['ip', '-4', host]);
  const direct = viaIp.spawnFailed === true || viaIp.code !== 0 ? undefined : /(\d+\.\d+\.\d+\.\d+)/.exec(viaIp.stdout)?.[1];
  if (direct !== undefined) return direct;
  const s = await tailscaleStatusJson(deps);
  const peers = (s.json?.['Peer'] ?? {}) as Record<string, { DNSName?: string; HostName?: string; TailscaleIPs?: string[] }>;
  const want = host.toLowerCase();
  for (const peer of Object.values(peers)) {
    const dns = (peer.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    const short = (peer.HostName ?? '').toLowerCase();
    if (dns === want || short === want) return (peer.TailscaleIPs ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  }
  return undefined;
}

export async function endpointCheck(
  deps: PreflightDeps,
  manifest: FleetManifest | undefined,
  inputs: OperatorInputs | undefined,
): Promise<readonly PreflightCheck[]> {
  if (manifest !== undefined && manifest.routing?.runner.runs_on !== 'self-hosted') return [];
  const found = await resolveEndpoint(deps, manifest, inputs);
  const endpoint = found.value?.replace(/\/+$/, '');
  if (endpoint === undefined) {
    if (manifest === undefined) return [];
    const sourceId = 'runner-endpoint-source';
    if (found.scope.state === 'unreadable') {
      return [check(sourceId, 'endpoint', 'unknown', 'runner endpoint: not in the environment, secrets file or fleet.yaml, and the scope variable could not be read', ENDPOINT_FIX)];
    }
    if (resolvePreflightInput(deps.env, inputs, RUNNER_TOKEN_ENV_VAR).value !== undefined) {
      return [check(sourceId, 'endpoint', 'ok', 'no runner platform endpoint; a runner-registration token is set instead (it expires about an hour after it was issued)')];
    }
    return [check(sourceId, 'endpoint', 'missing', 'runner endpoint: not set anywhere', ENDPOINT_OR_TOKEN_FIX)];
  }
  const label = found.source === 'none' ? 'unknown' : ENDPOINT_SOURCE_LABEL[found.source];
  const sourceCheck = check('runner-endpoint-source', 'endpoint', 'ok', `runner endpoint: ${endpoint} (from ${label})`);
  return [sourceCheck, await probeEndpoint(deps, endpoint)];
}

/** The platform's `GET /` answers 2xx when it is up; any other status means the host is there but not healthy. */
function isHealthy(r: FetchResult): boolean {
  return r.status === undefined || (r.status >= 200 && r.status < 300);
}

function unhealthyCheck(r: FetchResult, via: string): PreflightCheck {
  return check('runner-endpoint', 'endpoint', 'wrong', `runner endpoint answered HTTP ${String(r.status)} (${via})`, "the host answered but the runner platform is not healthy: check the platform's own health and logs");
}

async function probeEndpoint(deps: PreflightDeps, endpoint: string): Promise<PreflightCheck> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return check('runner-endpoint', 'endpoint', 'wrong', `${RUNNER_PLATFORM_ENDPOINT_ENV_VAR} is not a URL`, 'use http://<tailnet-host>:<port>');
  }
  const byName = await deps.fetchUrl(url.toString(), NET_TIMEOUT_MS);
  if (byName.reached) {
    if (!isHealthy(byName)) return unhealthyCheck(byName, 'by name');
    return check('runner-endpoint', 'endpoint', 'ok', `runner endpoint reachable by name (${url.host}), ${byName.detail}`);
  }
  const ip = await resolveTailnetIp(deps, url.hostname);
  if (ip !== undefined) {
    const ipUrl = new URL(url.toString());
    ipUrl.hostname = ip;
    const byIp = await deps.fetchUrl(ipUrl.toString(), NET_TIMEOUT_MS);
    if (byIp.reached && !isHealthy(byIp)) return unhealthyCheck(byIp, `by IP ${ip}`);
    if (byIp.reached) {
      return check('runner-endpoint', 'endpoint', 'wrong', `runner endpoint reachable only by IP ${ip} (MagicDNS off here)`, `put http://${ip}:${url.port || '80'} in secrets.env as ${RUNNER_PLATFORM_ENDPOINT_ENV_VAR}`);
    }
  }
  return check('runner-endpoint', 'endpoint', 'wrong', `runner endpoint unreachable by name${ip !== undefined ? ' and by IP' : ''} (${byName.detail})`, 'check `tailscale status` and that the runner platform is up');
}

// --- 5. The identity key ---

async function vaultExists(deps: PreflightDeps, manifest: FleetManifest): Promise<boolean | undefined> {
  const r = await deps.exec('gh', ['api', `repos/${controlRepoFullName(manifest)}/contents/secrets/vault.age`, '--jq', '.name'], { timeoutMs: 15000 });
  if (r.spawnFailed === true) return undefined;
  if (r.code === 0) return true;
  return /404|Not Found/i.test(r.stderr + r.stdout) ? false : undefined;
}

export async function identityChecks(deps: PreflightDeps, manifest: FleetManifest | undefined, keyPath: string | undefined): Promise<readonly PreflightCheck[]> {
  if (keyPath === undefined) {
    if (manifest === undefined) return [];
    const has = await vaultExists(deps, manifest);
    if (has === true) return [check('identity-key', 'identity', 'missing', 'the control repo already has a vault, and no --identity-key was given', 'apply needs --vault and --identity-key together: clone the control repo (gh repo clone <owner>/<project>-control) and pass --vault <clone>/secrets/vault.age --identity-key <your age key>; give preflight --identity-key too')];
    return [];
  }
  if (deps.readText(keyPath) === undefined) {
    return [check('identity-key', 'identity', 'missing', `${keyPath} cannot be read`, 'point --identity-key at your age key file')];
  }
  const r = await deps.exec('age-keygen', ['-y', keyPath], { timeoutMs: 10000 });
  if (r.spawnFailed === true) return [check('identity-key', 'identity', 'missing', 'age-keygen is not on PATH', 'install age')];
  const recipient = r.code === 0 ? /(age1[a-z0-9]+)/.exec(r.stdout)?.[1] : undefined;
  if (recipient === undefined) return [check('identity-key', 'identity', 'wrong', `${keyPath} is not a usable age identity`, 'generate one: age-keygen -o <path>')];
  if (manifest === undefined) return [check('identity-key', 'identity', 'ok', `identity key readable; its recipient is ${recipient}`)];
  if (!manifest.transport.age_recipients.includes(recipient)) {
    return [check('identity-key', 'identity', 'wrong', `recipient ${recipient} is not among transport.age_recipients`, `add ${recipient} to transport.age_recipients`)];
  }
  return [check('identity-key', 'identity', 'ok', `identity key readable; recipient ${recipient} is in transport.age_recipients`)];
}

// --- Assembly of checks 1-5 (the agent host is in preflight-agent-host.ts) ---

export async function runLocalPreflight(deps: PreflightDeps, opts: PreflightOptions): Promise<readonly PreflightCheck[]> {
  const load = loadManifestChecks(deps, opts.file);
  const vaultGiven = opts.vaultPath !== undefined && opts.identityKeyPath !== undefined;
  const secrets = secretsChecks(deps, load.manifest, opts, vaultGiven);
  const [macf, gh, ghToken, git, age, tailscale, browser, endpoint, identity] = await Promise.all([
    macfOnPathCheck(deps),
    ghCheck(deps, load.manifest),
    opts.agentHost !== undefined ? ghTokenExtensionCheck(deps) : Promise.resolve(undefined),
    gitCheck(deps),
    ageCheck(deps),
    tailscaleCheck(deps),
    browserCheck(deps),
    endpointCheck(deps, load.manifest, secrets.inputs),
    identityChecks(deps, load.manifest, opts.identityKeyPath),
  ]);
  return [nodeCheck(deps), macf, gh, ...(ghToken !== undefined ? [ghToken] : []), git, age, tailscale, browser, ...load.checks, ...(load.manifest !== undefined ? applyManifestRefusalChecks(deps, load.manifest, opts) : []), ...secrets.checks, ...applyFlagRefusalChecks(deps, opts, secrets.inputs), ...endpoint, ...identity];
}
