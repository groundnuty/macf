/**
 * `macf bootstrap preflight` tests. Every external call is injected: no
 * network, no ssh, no real files.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecResult, PreflightDeps } from '../../src/cli/bootstrap/preflight.js';
import { runLocalPreflight } from '../../src/cli/bootstrap/preflight.js';
import { agentHostChecks, classifySshFailure } from '../../src/cli/bootstrap/preflight-agent-host.js';
import { runBootstrapPreflight, buildReport, formatPreflightText, preflightToJson } from '../../src/cli/commands/bootstrap-preflight.js';

const FAKE_SECRET = 'tskey-client-SUPERSECRETVALUE123';
const RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const ENDPOINT = 'http://runner-host.tail1234.ts.net:8088';

function fleetYaml(opts: { selfHosted?: boolean; versions?: boolean; type?: 'org' | 'user'; macf?: string; tsOauth?: boolean } = {}): string {
  const type = opts.type ?? 'org';
  return `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo
owner:
  account: acme
  type: ${type}
  registry: { type: repo, owner: acme, repo: demo-control }
network:
  advertise_host: vm.example.ts.net
transport:
  age_recipients: [${RECIPIENT}]
${(opts.tsOauth ?? opts.selfHosted !== false) ? '  tailscale_oauth_required: true\n' : ''}${opts.selfHosted === false ? '' : 'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [self-hosted, macf-vm]\n    warm: 1\n    trusted_actors: [someone]\n'}defaults:
  role_template: groundnuty/agentic-repo-template
agents:
  - role: code-agent
    repo: acme/demo-code-agent
    deploy_path: /home/ubuntu/repos/demo/demo-code-agent
${opts.versions === false ? '' : `versions:\n  macf: ${opts.macf ?? '0.2.79'}\n  actions: v3.6.2\n`}`;
}

const GH_OK = 'HTTP/2.0 200 OK\nX-Oauth-Scopes: admin:org, repo, workflow\n\n{"login":"someone"}';
const PROBE_OK = 'node|login|v22.14.0\nclaude|login|2.1.300\ntmux|login|tmux 3.4\ncrontab|login|empty\ngh|login|gh version 2.60\nbash|login|GNU bash, version 5.2.21(1)-release\nmacf|login|0.2.79\ngit|login|git version 2.43.0\njq|login|jq-1.7\nopenssl|login|OpenSSL 3.0.13\ncurl|login|curl 8.5.0\ngh-token|login|installed';
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const noSuchProgram: ExecResult = { code: null, stdout: '', stderr: 'ENOENT', spawnFailed: true };

interface Setup {
  files?: Record<string, string>;
  modes?: Record<string, number>;
  env?: Record<string, string>;
  exec?: (cmd: string, args: readonly string[], input?: string) => ExecResult | undefined;
  fetch?: (url: string) => boolean;
  status?: (url: string) => number | undefined;
  platform?: string;
}

function makeDeps(s: Setup = {}): { deps: PreflightDeps; execCalls: string[]; fetchCalls: string[] } {
  const execCalls: string[] = [];
  const fetchCalls: string[] = [];
  const deps: PreflightDeps = {
    exec: async (cmd, args, opts) => {
      execCalls.push([cmd, ...args].join(' '));
      const custom = s.exec?.(cmd, args, opts?.input);
      if (custom !== undefined) return custom;
      if (cmd === 'sh') return args[0] === '-s' ? ok(PROBE_OK) : ok('/usr/bin/xdg-open');
      if (cmd === 'macf') return ok('0.2.79\n');
      if (cmd === 'gh' && args[0] === 'extension') return ok('gh token\tLink-/gh-token\tv2.0.0\n');
      if (cmd === 'gh') return args[1]?.includes('vault.age') ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : ok(GH_OK);
      if (cmd === 'age') return ok('v1.2.0\n');
      if (cmd === 'git') return ok('git version 2.43.0\n');
      if (cmd === 'tailscale') return ok('{"BackendState":"Running","Peer":{}}');
      return { code: 1, stdout: '', stderr: 'unexpected call' };
    },
    fetchUrl: async (url) => {
      fetchCalls.push(url);
      const status = s.status?.(url);
      if (status !== undefined) return { reached: true, status, detail: `HTTP ${String(status)}` };
      const reached = s.fetch?.(url) ?? true;
      return { reached, ...(reached ? { status: 200 } : {}), detail: reached ? 'HTTP 200' : 'getaddrinfo ENOTFOUND' };
    },
    readText: (p) => s.files?.[p],
    fileMode: (p) => (s.files?.[p] !== undefined ? { exists: true, mode: s.modes?.[p] ?? 0o600 } : { exists: false }),
    env: { DISPLAY: ':0', ...(s.env ?? {}) },
    platform: s.platform ?? 'linux',
    nodeVersion: '22.14.0',
    cliVersion: '0.2.79',
  };
  return { deps, execCalls, fetchCalls };
}

const SECRETS_PATH = '/work/secrets.env';
const MANIFEST_PATH = '/work/fleet.yaml';
const FULL_SECRETS = `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=abc\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=${FAKE_SECRET}\nMACF_RUNNER_PLATFORM_ENDPOINT=${ENDPOINT}\n`;
const baseFiles = (): Record<string, string> => ({ [MANIFEST_PATH]: fleetYaml(), [SECRETS_PATH]: FULL_SECRETS });
const opts = { file: MANIFEST_PATH, secretsPath: SECRETS_PATH };

async function byId(deps: PreflightDeps, o = opts): Promise<Record<string, { status: string; detail: string; fix?: string }>> {
  const checks = await runLocalPreflight(deps, o);
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

afterEach(() => vi.restoreAllMocks());

describe('tools', () => {
  it('is all ok on a ready machine', async () => {
    const r = await byId(makeDeps({ files: baseFiles() }).deps);
    for (const id of ['node', 'macf-on-path', 'gh', 'age', 'tailscale']) expect(r[id]?.status, id).toBe('ok');
  });

  it('flags an old node, a missing macf, a different macf, no gh, no age', async () => {
    const { deps } = makeDeps({
      files: baseFiles(),
      exec: (cmd) => (cmd === 'macf' ? noSuchProgram : cmd === 'gh' ? noSuchProgram : cmd === 'age' ? noSuchProgram : cmd === 'tailscale' ? noSuchProgram : undefined),
    });
    const r = await byId({ ...deps, nodeVersion: '20.1.0' });
    expect(r['node']?.status).toBe('wrong');
    expect(r['macf-on-path']?.status).toBe('missing');
    expect(r['gh']?.status).toBe('missing');
    expect(r['age']?.status).toBe('missing');
    expect(r['tailscale']?.status).toBe('unknown');
    const other = await byId(makeDeps({ files: baseFiles(), exec: (cmd) => (cmd === 'macf' ? ok('0.2.70') : undefined) }).deps);
    expect(other['macf-on-path']?.status).toBe('wrong');
    expect(other['macf-on-path']?.detail).toContain('0.2.70');
  });

  it('reports gh not logged in, missing scopes for an org, and an unreadable scope header', async () => {
    const notLoggedIn = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'gh' ? { code: 1, stdout: '', stderr: 'not logged in' } : undefined) }).deps);
    expect(notLoggedIn['gh']?.status).toBe('missing');
    const lowScopes = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'gh' ? ok('HTTP/2 200\nX-Oauth-Scopes: repo\n\n{"login":"someone"}') : undefined) }).deps);
    expect(lowScopes['gh']?.status).toBe('wrong');
    expect(lowScopes['gh']?.fix).toContain('workflow,admin:org');
    const noHeader = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'gh' ? ok('HTTP/2 200\n\n{"login":"someone"}') : undefined) }).deps);
    expect(noHeader['gh']?.status).toBe('unknown');
  });

  it('an org token with only workflow and admin:org lacks repo', async () => {
    const r = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'gh' ? ok('HTTP/2 200\nX-Oauth-Scopes: workflow, admin:org\n\n{"login":"someone"}') : undefined) }).deps);
    expect(r['gh']?.status).toBe('wrong');
    expect(r['gh']?.detail).toContain('missing repo');
    expect(r['gh']?.fix).toContain('repo');
  });

  it('age: EACCES and a non-zero exit are wrong, exit 0 is ok, ENOENT is missing', async () => {
    const age = async (res: ExecResult) => (await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'age' ? res : undefined) }).deps))['age'];
    const eacces = await age({ code: null, stdout: '', stderr: 'spawn age EACCES' });
    expect(eacces?.status).toBe('wrong');
    expect(eacces?.detail).toContain('EACCES');
    const bad = await age({ code: 2, stdout: '', stderr: 'bad things\nmore' });
    expect(bad?.status).toBe('wrong');
    expect(bad?.detail).toContain('bad things');
    expect(bad?.detail).not.toContain('more');
    expect((await age({ code: null, stdout: '', stderr: 'timed out' }))?.status).toBe('wrong');
    expect((await age(ok('v1.2.0')))?.status).toBe('ok');
    expect((await age(noSuchProgram))?.status).toBe('missing');
  });

  it('macf on PATH and gh: a failed or unrunnable probe is wrong', async () => {
    const macf = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'macf' ? { code: 1, stdout: '0.2.79', stderr: 'boom' } : undefined) }).deps);
    expect(macf['macf-on-path']?.status).toBe('wrong');
    const gh = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'gh' ? { code: null, stdout: '', stderr: 'spawn gh EACCES' } : undefined) }).deps);
    expect(gh['gh']?.status).toBe('wrong');
  });

  it('needs repo (not admin:org) for a user owner, and the login must be the owner', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml({ type: 'user' }), [SECRETS_PATH]: FULL_SECRETS };
    const wrongLogin = await byId(makeDeps({ files }).deps);
    expect(wrongLogin['gh']?.status).toBe('wrong');
    expect(wrongLogin['gh']?.detail).toContain('owner.account is acme');
    const right = await byId(makeDeps({ files, exec: (c) => (c === 'gh' ? ok('HTTP/2 200\nX-Oauth-Scopes: repo, workflow\n\n{"login":"acme"}') : undefined) }).deps);
    expect(right['gh']?.status).toBe('ok');
  });

  it('flags a tailscale that is not Running', async () => {
    const r = await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'tailscale' ? ok('{"BackendState":"Stopped"}') : undefined) }).deps);
    expect(r['tailscale']?.status).toBe('wrong');
  });
});

describe('manifest', () => {
  it('is ok when it parses and versions equal the CLI', async () => {
    const r = await byId(makeDeps({ files: baseFiles() }).deps);
    expect(r['manifest']?.status).toBe('ok');
    expect(r['manifest-owner-type']?.detail).toContain('org');
    expect(r['manifest-versions-macf']?.status).toBe('ok');
    expect(r['manifest-versions-actions']?.status).toBe('ok');
  });

  it('reports a missing file and an invalid manifest', async () => {
    expect((await byId(makeDeps({ files: {} }).deps))['manifest']?.status).toBe('missing');
    expect((await byId(makeDeps({ files: { [MANIFEST_PATH]: 'kind: nope' } }).deps))['manifest']?.status).toBe('wrong');
  });

  it('reports absent versions, and a versions.macf newer or older than this CLI', async () => {
    const none = await byId(makeDeps({ files: { [MANIFEST_PATH]: fleetYaml({ versions: false }), [SECRETS_PATH]: FULL_SECRETS } }).deps);
    expect(none['manifest-versions-macf']?.status).toBe('missing');
    expect(none['manifest-versions-actions']?.status).toBe('missing');
    const newer = await byId(makeDeps({ files: { [MANIFEST_PATH]: fleetYaml({ macf: '0.2.90' }), [SECRETS_PATH]: FULL_SECRETS } }).deps);
    expect(newer['manifest-versions-macf']?.status).toBe('wrong');
    const older = await byId(makeDeps({ files: { [MANIFEST_PATH]: fleetYaml({ macf: '0.2.70' }), [SECRETS_PATH]: FULL_SECRETS } }).deps);
    expect(older['manifest-versions-macf']?.status).toBe('ok');
    expect(older['manifest-versions-macf']?.detail).toContain('older');
  });
});

describe('secrets.env', () => {
  it('is ok at mode 600 with every key, and never prints a value', async () => {
    const checks = await runLocalPreflight(makeDeps({ files: baseFiles() }).deps, opts);
    expect(checks.find((c) => c.id === 'secrets-file')?.status).toBe('ok');
    expect(checks.filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['ok', 'ok']);
    const text = formatPreflightText(buildReport(checks)) + JSON.stringify(preflightToJson(buildReport(checks)));
    expect(text).not.toContain(FAKE_SECRET);
  });

  it('gives wrong for mode 644, with the chmod', async () => {
    const r = await byId(makeDeps({ files: baseFiles(), modes: { [SECRETS_PATH]: 0o644 } }).deps);
    expect(r['secrets-file']?.status).toBe('wrong');
    expect(r['secrets-file']?.fix).toBe(`chmod 600 ${SECRETS_PATH}`);
  });

  it('gives missing for an absent file and for an absent key, never printing values', async () => {
    const noFile = await byId(makeDeps({ files: { [MANIFEST_PATH]: fleetYaml() } }).deps);
    expect(noFile['secrets-file']?.status).toBe('missing');
    const partial = `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=abc\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=${FAKE_SECRET}\n`;
    const checks = await runLocalPreflight(makeDeps({ files: { [MANIFEST_PATH]: fleetYaml(), [SECRETS_PATH]: partial } }).deps, opts);
    expect(checks.find((c) => c.id === 'secret-MACF_RUNNER_PLATFORM_ENDPOINT')).toBeUndefined();
    expect(JSON.stringify(checks)).not.toContain(FAKE_SECRET);
  });

  it('takes a key from the environment when the file lacks it', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml(), [SECRETS_PATH]: `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=abc\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=x\n` };
    const r = await byId(makeDeps({ files, env: { MACF_RUNNER_PLATFORM_ENDPOINT: ENDPOINT } }).deps);
    expect(r['runner-endpoint-source']?.detail).toBe(`runner endpoint: ${ENDPOINT} (from the MACF_RUNNER_PLATFORM_ENDPOINT environment variable)`);
  });

  it('self-hosted with tailscale_oauth_required false checks no Tailscale keys', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml({ tsOauth: false }), [SECRETS_PATH]: '' };
    const checks = await runLocalPreflight(makeDeps({ files }).deps, opts);
    expect(checks.filter((c) => c.id.startsWith('secret-'))).toEqual([]);
  });

  it('self-hosted with tailscale_oauth_required true checks both keys', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml({ tsOauth: true }), [SECRETS_PATH]: '' };
    const checks = await runLocalPreflight(makeDeps({ files }).deps, opts);
    expect(checks.filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['missing', 'missing']);
  });

  it('requires none of the keys for a hosted fleet', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml({ selfHosted: false }), [SECRETS_PATH]: '' };
    const checks = await runLocalPreflight(makeDeps({ files }).deps, opts);
    expect(checks.filter((c) => c.id.startsWith('secret-'))).toEqual([]);
  });
});

describe('runner platform endpoint', () => {
  it('reachable by name', async () => {
    const { deps, fetchCalls } = makeDeps({ files: baseFiles() });
    const r = await byId(deps);
    expect(r['runner-endpoint']?.status).toBe('ok');
    expect(r['runner-endpoint']?.detail).toContain('by name');
    expect(fetchCalls).toEqual([`${ENDPOINT}/`]);
  });

  it('reachable only by IP, via tailscale ip', async () => {
    const { deps, fetchCalls } = makeDeps({
      files: baseFiles(),
      fetch: (u) => u.includes('100.64.0.9'),
      exec: (c, a) => (c === 'tailscale' && a[0] === 'ip' ? ok('100.64.0.9\n') : undefined),
    });
    const r = await byId(deps);
    expect(r['runner-endpoint']?.status).toBe('wrong');
    expect(r['runner-endpoint']?.detail).toContain('only by IP 100.64.0.9');
    expect(r['runner-endpoint']?.fix).toContain('http://100.64.0.9:8088');
    expect(fetchCalls[1]).toContain('100.64.0.9:8088');
  });

  it('finds the IP through tailscale status when tailscale ip fails', async () => {
    const status = JSON.stringify({ BackendState: 'Running', Peer: { k: { DNSName: 'runner-host.tail1234.ts.net.', HostName: 'runner-host', TailscaleIPs: ['100.64.0.7', 'fd7a::1'] } } });
    const { deps } = makeDeps({
      files: baseFiles(),
      fetch: (u) => u.includes('100.64.0.7'),
      exec: (c, a) => (c === 'tailscale' ? (a[0] === 'ip' ? { code: 1, stdout: '', stderr: 'no such host' } : ok(status)) : undefined),
    });
    expect((await byId(deps))['runner-endpoint']?.detail).toContain('only by IP 100.64.0.7');
  });

  it('unreachable by name and by IP, and unreachable with no tailscale', async () => {
    const both = makeDeps({ files: baseFiles(), fetch: () => false, exec: (c, a) => (c === 'tailscale' && a[0] === 'ip' ? ok('100.64.0.9') : undefined) });
    const r = await byId(both.deps);
    expect(r['runner-endpoint']?.status).toBe('wrong');
    expect(r['runner-endpoint']?.detail).toContain('unreachable by name and by IP');
    const noTs = await byId(makeDeps({ files: baseFiles(), fetch: () => false, exec: (c) => (c === 'tailscale' ? noSuchProgram : undefined) }).deps);
    expect(noTs['runner-endpoint']?.detail).toMatch(/^runner endpoint unreachable by name \(/);
  });

  it('503 by name is wrong, with the status in the detail', async () => {
    const { deps } = makeDeps({ files: baseFiles(), status: () => 503 });
    const r = await byId(deps);
    expect(r['runner-endpoint']?.status).toBe('wrong');
    expect(r['runner-endpoint']?.detail).toContain('HTTP 503');
    expect(r['runner-endpoint']?.detail).toContain('by name');
    expect(r['runner-endpoint']?.detail).not.toContain('unreachable');
    expect(r['runner-endpoint']?.fix).toContain('health');
  });

  it('200 by name is ok, with the status in the detail', async () => {
    const { deps } = makeDeps({ files: baseFiles(), status: () => 200 });
    const r = await byId(deps);
    expect(r['runner-endpoint']?.status).toBe('ok');
    expect(r['runner-endpoint']?.detail).toContain('HTTP 200');
  });

  it('unreachable by name, then 503 by IP, is wrong and names the IP', async () => {
    const { deps } = makeDeps({
      files: baseFiles(),
      fetch: () => false,
      status: (u) => (u.includes('100.64.0.9') ? 503 : undefined),
      exec: (c, a) => (c === 'tailscale' && a[0] === 'ip' ? ok('100.64.0.9\n') : undefined),
    });
    const r = await byId(deps);
    expect(r['runner-endpoint']?.status).toBe('wrong');
    expect(r['runner-endpoint']?.detail).toContain('HTTP 503');
    expect(r['runner-endpoint']?.detail).toContain('by IP 100.64.0.9');
    expect(r['runner-endpoint']?.detail).not.toContain('only by IP');
  });

  it('an exported but empty env var falls back to the secrets file, as apply does', async () => {
    const { deps, fetchCalls } = makeDeps({ files: baseFiles(), env: { MACF_RUNNER_PLATFORM_ENDPOINT: '' } });
    expect((await byId(deps))['runner-endpoint']?.status).toBe('ok');
    expect(fetchCalls).toEqual([`${ENDPOINT}/`]);
  });

  const noEndpointFiles = (extraManifest = ''): Record<string, string> => ({
    [MANIFEST_PATH]: fleetYaml().replace('transport:\n', `transport:\n${extraManifest}`),
    [SECRETS_PATH]: 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=abc\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=x\n',
  });
  const noScopeVar = (c: string, a: readonly string[]): ExecResult | undefined =>
    c === 'gh' && a[1]?.includes('actions/variables') ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : undefined;

  it('finds the endpoint in fleet.yaml and probes it', async () => {
    const { deps, fetchCalls } = makeDeps({ files: noEndpointFiles(`  runner_platform_endpoint: ${ENDPOINT}\n`), exec: noScopeVar });
    const r = await byId(deps);
    expect(r['runner-endpoint-source']?.status).toBe('ok');
    expect(r['runner-endpoint-source']?.detail).toBe(`runner endpoint: ${ENDPOINT} (from transport.runner_platform_endpoint in fleet.yaml)`);
    expect(r['runner-endpoint']?.status).toBe('ok');
    expect(fetchCalls).toEqual([`${ENDPOINT}/`]);
  });

  it('finds the endpoint in the scope variable and probes it', async () => {
    const { deps, fetchCalls, execCalls } = makeDeps({
      files: noEndpointFiles(),
      exec: (c, a) => (c === 'gh' && a[1]?.includes('actions/variables/MACF_RUNNER_PLATFORM_ENDPOINT') ? ok(`${ENDPOINT}\n`) : undefined),
    });
    const r = await byId(deps);
    expect(r['runner-endpoint-source']?.detail).toContain("from the scope's shared Actions variable");
    expect(r['runner-endpoint']?.status).toBe('ok');
    expect(fetchCalls).toEqual([`${ENDPOINT}/`]);
    expect(execCalls).toContain('gh api repos/acme/demo-control/actions/variables/MACF_RUNNER_PLATFORM_ENDPOINT --jq .value');
  });

  it('is missing, with every source named, when none sets it', async () => {
    const { deps, fetchCalls } = makeDeps({ files: noEndpointFiles(), exec: noScopeVar });
    const r = await byId(deps);
    expect(r['runner-endpoint-source']?.status).toBe('missing');
    for (const where of ['MACF_RUNNER_PLATFORM_ENDPOINT', 'secrets.env', 'Actions variable', 'transport.runner_platform_endpoint']) {
      expect(r['runner-endpoint-source']?.fix, where).toContain(where);
    }
    expect(fetchCalls).toEqual([]);
  });

  it('is ok with a runner token and no endpoint, and never prints the token', async () => {
    const TOKEN = 'ATOKENVALUE-SECRET-9988';
    const { deps } = makeDeps({ files: noEndpointFiles(), exec: noScopeVar, env: { MACF_BOOTSTRAP_RUNNER_TOKEN: TOKEN } });
    const checks = await runLocalPreflight(deps, opts);
    const c = checks.find((x) => x.id === 'runner-endpoint-source');
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('a runner-registration token is set instead');
    expect(formatPreflightText(buildReport(checks)) + JSON.stringify(preflightToJson(buildReport(checks)))).not.toContain(TOKEN);
  });

  it('missing with neither endpoint nor token, and the fix names both', async () => {
    const r = await byId(makeDeps({ files: noEndpointFiles(), exec: noScopeVar }).deps);
    expect(r['runner-endpoint-source']?.status).toBe('missing');
    expect(r['runner-endpoint-source']?.fix).toContain('MACF_RUNNER_PLATFORM_ENDPOINT');
    expect(r['runner-endpoint-source']?.fix).toContain('MACF_BOOTSTRAP_RUNNER_TOKEN');
  });

  it('an endpoint present ignores the token', async () => {
    const r = await byId(makeDeps({ files: baseFiles(), env: { MACF_BOOTSTRAP_RUNNER_TOKEN: 'x' } }).deps);
    expect(r['runner-endpoint-source']?.detail).toContain(`runner endpoint: ${ENDPOINT}`);
  });

  it('is unknown, not missing, when the scope variable cannot be read', async () => {
    const { deps } = makeDeps({ files: noEndpointFiles(), exec: (c, a) => (c === 'gh' && a[1]?.includes('actions/variables') ? { code: 1, stdout: '', stderr: 'HTTP 403' } : undefined) });
    expect((await byId(deps))['runner-endpoint-source']?.status).toBe('unknown');
  });

  it('does nothing when no endpoint is declared', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml({ selfHosted: false }), [SECRETS_PATH]: '' };
    const { deps, fetchCalls } = makeDeps({ files });
    expect((await byId(deps))['runner-endpoint']).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });
});

describe('identity key', () => {
  const KEY = '/work/key.txt';
  const withKey = (recipient: string): Setup => ({
    files: { ...baseFiles(), [KEY]: 'AGE-SECRET-KEY-1XXXX' },
    exec: (c, a) => (c === 'age-keygen' && a[0] === '-y' ? ok(`${recipient}\n`) : undefined),
  });

  it('ok when the recipient is among age_recipients', async () => {
    const r = await byId(makeDeps(withKey(RECIPIENT)).deps, { ...opts, identityKeyPath: KEY });
    expect(r['identity-key']?.status).toBe('ok');
  });

  it('wrong when the recipient is not listed; wrong when not an age key; missing when unreadable', async () => {
    const other = 'age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    const notListed = await byId(makeDeps(withKey(other)).deps, { ...opts, identityKeyPath: KEY });
    expect(notListed['identity-key']?.status).toBe('wrong');
    expect(notListed['identity-key']?.fix).toContain(other);
    const bad = makeDeps({ ...withKey(RECIPIENT), exec: (c) => (c === 'age-keygen' ? { code: 1, stdout: '', stderr: 'bad' } : undefined) });
    expect((await byId(bad.deps, { ...opts, identityKeyPath: KEY }))['identity-key']?.status).toBe('wrong');
    expect((await byId(makeDeps({ files: baseFiles() }).deps, { ...opts, identityKeyPath: KEY }))['identity-key']?.status).toBe('missing');
  });

  it('is missing when the control repo has a vault and no key was given', async () => {
    const vaultThere = makeDeps({ files: baseFiles(), exec: (c, a) => (c === 'gh' && a[0] === 'api' && a[1]?.includes('vault.age') ? ok('vault.age') : undefined) });
    expect((await byId(vaultThere.deps))['identity-key']?.status).toBe('missing');
    const noVault = makeDeps({ files: baseFiles(), exec: (c, a) => (c === 'gh' && a[1]?.includes('vault.age') ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : undefined) });
    expect((await byId(noVault.deps))['identity-key']).toBeUndefined();
  });
});

describe('agent host over ssh', () => {
  const vmDeps = (probe: ExecResult, ping: ExecResult = ok()): PreflightDeps =>
    makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ping : input !== undefined ? probe : undefined) : undefined) }).deps;

  it('reports every tool on the VM when ready', async () => {
    const checks = await agentHostChecks(vmDeps(ok(PROBE_OK)), 'ubuntu@vm');
    expect(checks.map((c) => c.status)).toEqual(Array(14).fill('ok'));
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['agent-host-git', 'agent-host-jq', 'agent-host-openssl', 'agent-host-curl']));
    expect(checks[0]?.detail).toBe('agents run on ubuntu@vm');
    expect(checks.find((c) => c.id === 'agent-host-macf')?.detail).toContain('0.2.79');
  });

  it('uses BatchMode and a 10 s connect timeout, and sends the probe on stdin', async () => {
    const { deps, execCalls } = makeDeps({ exec: (c, a) => (c === 'ssh' ? (a.includes('true') ? ok() : ok(PROBE_OK)) : undefined) });
    await agentHostChecks(deps, 'ubuntu@vm');
    expect(execCalls[0]).toBe('ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@vm true');
    expect(execCalls[1]).toContain('ubuntu@vm sh -s');
  });

  it.each([
    ['Host key verification failed.', 'host key'],
    ['ubuntu@vm: Permission denied (publickey).', 'permission denied'],
    ['ssh: Could not resolve hostname vm: Name or service not known', 'no route'],
  ])('classifies the ssh failure %s', async (stderr, expected) => {
    const checks = await agentHostChecks(vmDeps(ok(), { code: 255, stdout: '', stderr }), 'ubuntu@vm');
    expect(checks).toHaveLength(2);
    expect(checks[1]?.status).toBe('wrong');
    expect(checks[1]?.detail).toContain(expected);
    expect(classifySshFailure(stderr)).not.toBe('other');
  });

  it('flags macf missing from the non-interactive PATH, and macf only in an interactive shell', async () => {
    const probe = 'node|login|v22\nclaude|login|2\ntmux|login|3\ncrontab|login|empty\ngh|login|2\nbash|login|GNU bash, version 5.2.21(1)-release\nmacf|interactive|\n';
    const checks = await agentHostChecks(vmDeps(ok(probe)), 'ubuntu@vm');
    const macf = checks.find((c) => c.id === 'agent-host-macf');
    expect(macf?.status).toBe('wrong');
    expect(macf?.detail).toContain('interactive shell');
    const gone = await agentHostChecks(vmDeps(ok(probe.replace('macf|interactive|', 'macf|none|'))), 'ubuntu@vm');
    expect(gone.find((c) => c.id === 'agent-host-macf')?.status).toBe('missing');
  });

  it('reads crontab states: empty is fine, an error is wrong, absent is missing', async () => {
    const base = 'node|login|v22\nclaude|login|2\ntmux|login|3\ngh|login|2\nbash|login|GNU bash, version 5.2.21(1)-release\nmacf|login|0.2.79\n';
    const cron = async (line: string) => (await agentHostChecks(vmDeps(ok(base + line)), 'ubuntu@vm')).find((c) => c.id === 'agent-host-crontab');
    expect((await cron('crontab|login|empty\n'))?.status).toBe('ok');
    expect((await cron('crontab|login|present\n'))?.status).toBe('ok');
    expect((await cron('crontab|login|error: Operation not permitted\n'))?.status).toBe('wrong');
    expect((await cron('crontab|none|\n'))?.status).toBe('missing');
  });
});

describe('agent-host version floors', () => {
  const vmDeps = (probe: ExecResult): PreflightDeps =>
    makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ok() : input !== undefined ? probe : undefined) : undefined) }).deps;
  const run = async (probe: string) => {
    const checks = await agentHostChecks(vmDeps(ok(probe)), 'ubuntu@vm');
    return Object.fromEntries(checks.map((c) => [c.id, c]));
  };
  it('an old Claude Code on the agent host is wrong (below 2.1.277 it does not read AGENTS.md)', async () => {
    const r = await run(PROBE_OK.replace('claude|login|2.1.300', 'claude|login|2.1.276 (Claude Code)'));
    expect(r['agent-host-claude']?.status).toBe('wrong');
    expect(r['agent-host-claude']?.detail).toContain('older than 2.1.277');
    expect(r['agent-host-claude']?.fix).toContain('AGENTS.md');
  });
  it('Claude Code 2.1.277 is ok', async () => {
    const r = await run(PROBE_OK.replace('claude|login|2.1.300', 'claude|login|2.1.277 (Claude Code)'));
    expect(r['agent-host-claude']?.status).toBe('ok');
  });
  it('an old node on the agent host is wrong', async () => {
    const r = await run(PROBE_OK.replace('node|login|v22.14.0', 'node|login|v20.11.1'));
    expect(r['agent-host-node']?.status).toBe('wrong');
  });
  it('an unreadable version is unknown, current versions are ok', async () => {
    expect((await run(PROBE_OK.replace('claude|login|2.1.300', 'claude|login|weird')))['agent-host-claude']?.status).toBe('unknown');
    const fine = await run(PROBE_OK);
    expect(fine['agent-host-claude']?.status).toBe('ok');
    expect(fine['agent-host-node']?.status).toBe('ok');
  });
});

describe('bash on the agent host', () => {
  const vmDeps = (probe: string): PreflightDeps =>
    makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ok() : input !== undefined ? ok(probe) : undefined) : undefined) }).deps;
  const bashCheck = async (line: string) =>
    (await agentHostChecks(vmDeps(PROBE_OK.replace(/bash\|login\|.*\n/, line)), 'ubuntu@vm')).find((c) => c.id === 'agent-host-bash');
  it('3.2 is wrong with the install fix, 5.2 is ok, an unparseable version is unknown', async () => {
    const old = await bashCheck('bash|login|GNU bash, version 3.2.57(1)-release\n');
    expect(old?.status).toBe('wrong');
    expect(old?.fix).toBe('install Bash 4+ (on macOS: brew install bash) and make sure it comes first on the non-interactive login PATH.');
    expect((await bashCheck('bash|login|GNU bash, version 5.2.21(1)-release\n'))?.status).toBe('ok');
    expect((await bashCheck('bash|login|weird\n'))?.status).toBe('unknown');
  });
  it('the probe script itself avoids Bash 4 features', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../src/cli/bootstrap/preflight-agent-host.ts'), 'utf-8');
    expect(src).not.toMatch(/mapfile|readarray|declare -A|\$\{[a-z_]+,,\}/);
  });
});

describe('the gh-token extension on the apply host', () => {
  const withExt = (r: ExecResult) => makeDeps({ files: baseFiles(), exec: (c, a) => (c === 'gh' && a[0] === 'extension' ? r : undefined) }).deps;
  const host = { ...opts, agentHost: 'ubuntu@vm' };
  it('is missing, with the install fix, when this machine lacks it', async () => {
    const r = await byId(withExt(ok('gh other\towner/gh-other\tv1\n')), host);
    expect(r['gh-token']?.status).toBe('missing');
    expect(r['gh-token']?.fix).toBe('gh extension install Link-/gh-token');
  });
  it('is ok when installed', async () => {
    expect((await byId(withExt(ok('gh token\tLink-/gh-token\tv2\n')), host))['gh-token']?.status).toBe('ok');
  });
  it('a non-zero exit is wrong, not missing', async () => {
    expect((await byId(withExt({ code: 1, stdout: '', stderr: 'boom' }), host))['gh-token']?.status).toBe('wrong');
  });
  it('a one-machine run shows exactly one gh-token line', async () => {
    const { deps } = makeDeps({ files: baseFiles() });
    const checks = [...(await runLocalPreflight(deps, opts)), ...(await agentHostChecks(deps, undefined))];
    expect(checks.filter((c) => c.id === 'gh-token' || c.id === 'agent-host-gh-token')).toHaveLength(1);
  });
});

describe('the gh-token extension on the agent host', () => {
  const vmDeps = (probe: ExecResult): PreflightDeps =>
    makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ok() : input !== undefined ? probe : undefined) : undefined) }).deps;
  it('missing when gh has no gh-token extension, with the install command', async () => {
    const checks = await agentHostChecks(vmDeps(ok(PROBE_OK.replace('gh-token|login|installed', 'gh-token|none|'))), 'ubuntu@vm');
    const c = checks.find((x) => x.id === 'agent-host-gh-token');
    expect(c?.status).toBe('missing');
    expect(c?.fix).toContain('gh extension install Link-/gh-token');
  });
  it('the identity fix names --vault and --identity-key together', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../src/cli/bootstrap/preflight.ts'), 'utf-8');
    expect(src).toContain('apply needs --vault and --identity-key together');
  });
});

describe('the agent-host probe script', () => {
  it('reads crontab in the same shell that found it', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../src/cli/bootstrap/preflight-agent-host.ts'), 'utf-8');
    expect(src).toContain('out=$(run "crontab -l" 2>&1)');
    expect(src).not.toMatch(/out=\$\(crontab -l/);
  });
});

describe('agent host on this machine', () => {
  it('says agents run on this machine, runs the probe locally and never calls ssh', async () => {
    const { deps, execCalls } = makeDeps();
    const checks = await agentHostChecks(deps, undefined);
    expect(checks[0]).toMatchObject({ id: 'agent-host', status: 'ok', detail: 'agents run on this machine' });
    expect(checks.slice(1).every((c) => c.status === 'ok')).toBe(true);
    expect(execCalls.some((c) => c.startsWith('ssh'))).toBe(false);
    expect(execCalls).toContain('sh -s');
  });

  it('flags a tool that is missing from the local non-interactive PATH', async () => {
    const probe = PROBE_OK.replace('tmux|login|tmux 3.4', 'tmux|none|');
    const checks = await agentHostChecks(makeDeps({ exec: (c, a) => (c === 'sh' && a[0] === '-s' ? ok(probe) : undefined) }).deps, undefined);
    expect(checks.find((c) => c.id === 'agent-host-tmux')?.status).toBe('missing');
  });
});

describe('browser (apply host only)', () => {
  it('macOS: ok when open exists, missing when it does not', async () => {
    const mac = await byId(makeDeps({ files: baseFiles(), platform: 'darwin', env: {} }).deps);
    expect(mac['browser']?.status).toBe('ok');
    const noOpen = makeDeps({ files: baseFiles(), platform: 'darwin', exec: (c, a) => (c === 'sh' && a[0] === '-c' ? { code: 1, stdout: '', stderr: '' } : undefined) });
    expect((await byId(noOpen.deps))['browser']?.status).toBe('missing');
    expect(noOpen.execCalls).toContain('sh -c command -v open');
  });

  it('Linux: needs xdg-open and a display; Wayland counts', async () => {
    const files = baseFiles();
    expect((await byId(makeDeps({ files }).deps))['browser']?.status).toBe('ok');
    const headless = makeDeps({ files });
    const noDisplay = { ...headless.deps, env: {} };
    expect((await byId(noDisplay))['browser']?.status).toBe('wrong');
    expect((await byId({ ...headless.deps, env: { WAYLAND_DISPLAY: 'wayland-0' } }))['browser']?.status).toBe('ok');
    const noOpener = makeDeps({ files, exec: (c, a) => (c === 'sh' && a[0] === '-c' ? { code: 1, stdout: '', stderr: '' } : undefined) });
    expect((await byId(noOpener.deps))['browser']?.fix).toContain('xdg-utils');
  });

  it('is unknown, not wrong, on a platform it cannot judge', async () => {
    expect((await byId(makeDeps({ files: baseFiles(), platform: 'win32' }).deps))['browser']?.status).toBe('unknown');
  });
});

describe('platform differences', () => {
  it('macOS: falls back to the Tailscale app CLI when tailscale is not on PATH', async () => {
    const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    const { deps, execCalls } = makeDeps({
      files: baseFiles(), platform: 'darwin',
      exec: (c) => (c === 'tailscale' ? noSuchProgram : c === app ? ok('{"BackendState":"Running","Peer":{}}') : undefined),
    });
    expect((await byId(deps))['tailscale']?.status).toBe('ok');
    expect(execCalls).toContain(`${app} status --json`);
  });

  it('Linux: does not try the macOS app path', async () => {
    const { deps, execCalls } = makeDeps({ files: baseFiles(), exec: (c) => (c === 'tailscale' ? noSuchProgram : undefined) });
    expect((await byId(deps))['tailscale']?.status).toBe('unknown');
    expect(execCalls.some((c) => c.includes('Tailscale.app'))).toBe(false);
  });

  it('secrets mode comes from the permission bits on both platforms (same 0o077 rule)', async () => {
    for (const platform of ['darwin', 'linux']) {
      const bad = await byId(makeDeps({ files: baseFiles(), platform, modes: { [SECRETS_PATH]: 0o640 } }).deps);
      expect(bad['secrets-file']?.status, platform).toBe('wrong');
    }
  });
});

describe('command: exit code and --json', () => {
  it('exits 0 and prints "preflight: ready" when everything is ok', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await runBootstrapPreflight(opts, makeDeps({ files: baseFiles() }).deps);
    expect(code).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/preflight: ready$/);
  });

  it('exits 1 and counts what to fix', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await runBootstrapPreflight(opts, makeDeps({ files: baseFiles(), modes: { [SECRETS_PATH]: 0o644 } }).deps);
    expect(code).toBe(1);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/preflight: 1 to fix$/);
  });

  it('does not count unknown as a failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await runBootstrapPreflight({ file: MANIFEST_PATH }, makeDeps({ files: baseFiles(), env: { MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID: 'a', MACF_BOOTSTRAP_TS_OAUTH_SECRET: 'tskey-client-b', MACF_RUNNER_PLATFORM_ENDPOINT: ENDPOINT } }).deps);
    expect(code).toBe(0);
  });

  it('--json carries schema_version, the counts and each check', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBootstrapPreflight({ ...opts, json: true }, makeDeps({ files: baseFiles(), modes: { [SECRETS_PATH]: 0o644 } }).deps);
    const json = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown> & { checks: { id: string; status: string; fix?: string }[] };
    expect(json['schema_version']).toBe(1);
    expect(json['ready']).toBe(false);
    expect(json['to_fix']).toBe(1);
    expect(json['agent_host']).toBe('this machine');
    expect(json.checks.find((c) => c.id === 'secrets-file')).toMatchObject({ status: 'wrong', fix: expect.stringContaining('chmod 600') });
  });
});

describe('every program apply and the agents run', () => {
  it('the local checks run each apply-host program that has a command probe', async () => {
    const { deps, execCalls } = makeDeps({ files: baseFiles() });
    await runLocalPreflight(deps, { ...opts, agentHost: 'ubuntu@vm' });
    const ran = new Set(execCalls.map((c) => c.split(' ')[0]));
    for (const p of ['macf', 'gh', 'git', 'age', 'tailscale']) expect(ran.has(p), p).toBe(true);
  });
  it('apply host: git missing is reported with an install command; a failing git is wrong', async () => {
    const run = async (r: ExecResult) => (await byId(makeDeps({ files: baseFiles(), exec: (c) => (c === 'git' ? r : undefined) }).deps)).git;
    expect((await run(noSuchProgram))?.status).toBe('missing');
    expect((await run(noSuchProgram))?.fix).toContain('install git');
    expect((await run({ code: 1, stdout: '', stderr: 'boom' }))?.status).toBe('wrong');
    expect((await run(ok('git version 2.43.0')))?.status).toBe('ok');
  });
  it.each(['git', 'jq', 'openssl', 'curl'])('agent host: %s absent from the login PATH is missing', async (tool) => {
    const probe = PROBE_OK.replace(new RegExp(`${tool}\\|login\\|.*\n`), `${tool}|none|\n`);
    const deps = makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ok() : input !== undefined ? ok(probe) : undefined) : undefined) }).deps;
    const c = (await agentHostChecks(deps, 'ubuntu@vm')).find((x) => x.id === `agent-host-${tool}`);
    expect(c?.status).toBe('missing');
  });
  it('the probe script asks about every agent-host tool, and openssl by its own version command', async () => {
    let script = '';
    const deps = makeDeps({ exec: (c, _a, input) => { if (c === 'sh') { script = input ?? ''; return ok(PROBE_OK); } return undefined; } }).deps;
    await agentHostChecks(deps, undefined);
    for (const t of ['git', 'jq', 'openssl', 'curl']) expect(script).toContain(t);
    expect(script).toContain('openssl version');
  });
});
