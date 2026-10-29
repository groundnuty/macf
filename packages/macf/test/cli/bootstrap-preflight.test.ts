/**
 * `macf bootstrap preflight` tests. Every external call is injected: no
 * network, no ssh, no real files.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecResult, PreflightDeps } from '../../src/cli/bootstrap/preflight.js';
import { runLocalPreflight } from '../../src/cli/bootstrap/preflight.js';
import { vmChecks, classifySshFailure } from '../../src/cli/bootstrap/preflight-vm.js';
import { runBootstrapPreflight, buildReport, formatPreflightText, preflightToJson } from '../../src/cli/commands/bootstrap-preflight.js';

const FAKE_SECRET = 'tskey-client-SUPERSECRETVALUE123';
const RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const ENDPOINT = 'http://runner-host.tail1234.ts.net:8088';

function fleetYaml(opts: { selfHosted?: boolean; versions?: boolean; type?: 'org' | 'user'; macf?: string } = {}): string {
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
${opts.selfHosted === false ? '' : 'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [self-hosted, macf-vm]\n    warm: 1\n    trusted_actors: [someone]\n'}defaults:
  role_template: groundnuty/agentic-repo-template
agents:
  - role: code-agent
    repo: acme/demo-code-agent
    deploy_path: /home/ubuntu/repos/demo/demo-code-agent
${opts.versions === false ? '' : `versions:\n  macf: ${opts.macf ?? '0.2.79'}\n  actions: v3.6.2\n`}`;
}

const GH_OK = 'HTTP/2.0 200 OK\nX-Oauth-Scopes: admin:org, repo, workflow\n\n{"login":"someone"}';
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const noSuchProgram: ExecResult = { code: null, stdout: '', stderr: 'ENOENT', spawnFailed: true };

interface Setup {
  files?: Record<string, string>;
  modes?: Record<string, number>;
  env?: Record<string, string>;
  exec?: (cmd: string, args: readonly string[], input?: string) => ExecResult | undefined;
  fetch?: (url: string) => boolean;
}

function makeDeps(s: Setup = {}): { deps: PreflightDeps; execCalls: string[]; fetchCalls: string[] } {
  const execCalls: string[] = [];
  const fetchCalls: string[] = [];
  const deps: PreflightDeps = {
    exec: async (cmd, args, opts) => {
      execCalls.push([cmd, ...args].join(' '));
      const custom = s.exec?.(cmd, args, opts?.input);
      if (custom !== undefined) return custom;
      if (cmd === 'macf') return ok('0.2.79\n');
      if (cmd === 'gh') return args[1]?.includes('vault.age') ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : ok(GH_OK);
      if (cmd === 'age') return ok('v1.2.0\n');
      if (cmd === 'tailscale') return ok('{"BackendState":"Running","Peer":{}}');
      return { code: 1, stdout: '', stderr: 'unexpected call' };
    },
    fetchUrl: async (url) => {
      fetchCalls.push(url);
      const reached = s.fetch?.(url) ?? true;
      return { reached, detail: reached ? 'HTTP 200' : 'getaddrinfo ENOTFOUND' };
    },
    readText: (p) => s.files?.[p],
    fileMode: (p) => (s.files?.[p] !== undefined ? { exists: true, mode: s.modes?.[p] ?? 0o600 } : { exists: false }),
    env: s.env ?? {},
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
    expect(checks.filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
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
    const endpoint = checks.find((c) => c.id === 'secret-MACF_RUNNER_PLATFORM_ENDPOINT');
    expect(endpoint?.status).toBe('missing');
    expect(JSON.stringify(checks)).not.toContain(FAKE_SECRET);
  });

  it('takes a key from the environment when the file lacks it', async () => {
    const files = { [MANIFEST_PATH]: fleetYaml(), [SECRETS_PATH]: `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=abc\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=x\n` };
    const r = await byId(makeDeps({ files, env: { MACF_RUNNER_PLATFORM_ENDPOINT: ENDPOINT } }).deps);
    expect(r['secret-MACF_RUNNER_PLATFORM_ENDPOINT']?.detail).toContain('environment');
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

describe('VM', () => {
  const PROBE_OK = 'node|login|v22.14.0\nclaude|login|2.1.300\ntmux|login|tmux 3.4\ngh|login|gh version 2.60\nmacf|login|0.2.79\n';
  const vmDeps = (probe: ExecResult, ping: ExecResult = ok()): PreflightDeps =>
    makeDeps({ exec: (c, a, input) => (c === 'ssh' ? (a.includes('true') ? ping : input !== undefined ? probe : undefined) : undefined) }).deps;

  it('reports every tool on the VM when ready', async () => {
    const checks = await vmChecks(vmDeps(ok(PROBE_OK)), 'ubuntu@vm');
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(checks.find((c) => c.id === 'vm-macf')?.detail).toContain('0.2.79');
  });

  it('uses BatchMode and a 10 s connect timeout, and sends the probe on stdin', async () => {
    const { deps, execCalls } = makeDeps({ exec: (c, a) => (c === 'ssh' ? (a.includes('true') ? ok() : ok(PROBE_OK)) : undefined) });
    await vmChecks(deps, 'ubuntu@vm');
    expect(execCalls[0]).toBe('ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@vm true');
    expect(execCalls[1]).toContain('ubuntu@vm sh -s');
  });

  it.each([
    ['Host key verification failed.', 'host key'],
    ['ubuntu@vm: Permission denied (publickey).', 'permission denied'],
    ['ssh: Could not resolve hostname vm: Name or service not known', 'no route'],
  ])('classifies the ssh failure %s', async (stderr, expected) => {
    const checks = await vmChecks(vmDeps(ok(), { code: 255, stdout: '', stderr }), 'ubuntu@vm');
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('wrong');
    expect(checks[0]?.detail).toContain(expected);
    expect(classifySshFailure(stderr)).not.toBe('other');
  });

  it('flags macf missing from the non-interactive PATH, and macf only in an interactive shell', async () => {
    const probe = 'node|login|v22\nclaude|login|2\ntmux|login|3\ngh|login|2\nmacf|interactive|\n';
    const checks = await vmChecks(vmDeps(ok(probe)), 'ubuntu@vm');
    const macf = checks.find((c) => c.id === 'vm-macf');
    expect(macf?.status).toBe('wrong');
    expect(macf?.detail).toContain('interactive shell');
    const gone = await vmChecks(vmDeps(ok(probe.replace('macf|interactive|', 'macf|none|'))), 'ubuntu@vm');
    expect(gone.find((c) => c.id === 'vm-macf')?.status).toBe('missing');
  });

  it('checks nothing without --vm', async () => {
    expect(await vmChecks(makeDeps().deps, undefined)).toEqual([]);
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
    const code = await runBootstrapPreflight({ file: MANIFEST_PATH }, makeDeps({ files: baseFiles(), env: { MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID: 'a', MACF_BOOTSTRAP_TS_OAUTH_SECRET: 'b', MACF_RUNNER_PLATFORM_ENDPOINT: ENDPOINT } }).deps);
    expect(code).toBe(0);
  });

  it('--json carries schema_version, the counts and each check', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBootstrapPreflight({ ...opts, json: true }, makeDeps({ files: baseFiles(), modes: { [SECRETS_PATH]: 0o644 } }).deps);
    const json = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown> & { checks: { id: string; status: string; fix?: string }[] };
    expect(json['schema_version']).toBe(1);
    expect(json['ready']).toBe(false);
    expect(json['to_fix']).toBe(1);
    expect(json.checks.find((c) => c.id === 'secrets-file')).toMatchObject({ status: 'wrong', fix: expect.stringContaining('chmod 600') });
  });
});
