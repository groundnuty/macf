/**
 * Preflight takes every apply option that carries an input a check reads, and resolves it like apply:
 * flag, per-fleet file, per-scope file, environment.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Command } from 'commander';
import type { ExecResult, PreflightDeps } from '../../src/cli/bootstrap/preflight.js';
import { runLocalPreflight } from '../../src/cli/bootstrap/preflight.js';
import { PREFLIGHT_NOT_NEEDED_APPLY_OPTIONS } from '../../src/cli/bootstrap/preflight-inputs.js';

const RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const FLEET_ENDPOINT = 'http://fleet-host.tail1.ts.net:8088';
const SCOPE_ENDPOINT = 'http://scope-host.tail1.ts.net:8088';
const SECRET = 'tskey-client-SCOPESECRETVALUE';
const MANIFEST = '/work/fleet.yaml';
const FLEET_FILE = '/work/secrets.env';
const SCOPE_FILE = '/work/scope.env';
const YAML = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo
owner:
  account: acme
  type: org
  registry: { type: repo, owner: acme, repo: demo-control }
network:
  advertise_host: vm.example.ts.net
transport:
  age_recipients: [${RECIPIENT}]
  tailscale_oauth_required: true
routing:
  runner:
    runs_on: self-hosted
    labels: [self-hosted, macf-vm]
    warm: 1
    trusted_actors: [someone]
defaults:
  role_template: groundnuty/agentic-repo-template
agents:
  - role: code-agent
    repo: acme/demo-code-agent
    deploy_path: /home/ubuntu/repos/demo/demo-code-agent
`;
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

function depsFor(files: Record<string, string>, env: Record<string, string> = {}, fetched: string[] = []): PreflightDeps {
  return {
    exec: async (cmd, args) => {
      if (cmd === 'gh') return args[1]?.includes('vault.age') || args[1]?.includes('actions/variables') ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : ok('HTTP/2.0 200 OK\nX-Oauth-Scopes: admin:org, repo, workflow\n\n{"login":"someone"}');
      if (cmd === 'macf') return ok('0.2.79\n');
      if (cmd === 'tailscale') return ok('{"BackendState":"Running","Peer":{}}');
      return ok('v1.2.0\n');
    },
    fetchUrl: async (url) => {
      fetched.push(url);
      return { reached: true, status: 200, detail: 'HTTP 200' };
    },
    readText: (p) => files[p],
    fileMode: (p) => (files[p] !== undefined ? { exists: true, mode: 0o600 } : { exists: false }),
    env: { DISPLAY: ':0', ...env },
    platform: 'linux',
    nodeVersion: '22.14.0',
    cliVersion: '0.2.79',
  };
}

async function run(files: Record<string, string>, extra: Record<string, string> = {}, env: Record<string, string> = {}, fetched: string[] = []) {
  const checks = await runLocalPreflight(depsFor({ [MANIFEST]: YAML, ...files }, env, fetched), { file: MANIFEST, ...extra });
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

const SCOPE_PAIR = `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=scopeid\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=${SECRET}\n`;

describe('the per-scope secrets file', () => {
  it('supplies the Tailscale pair, so the keys are ok', async () => {
    const r = await run({ [SCOPE_FILE]: SCOPE_PAIR }, { scopeSecretsPath: SCOPE_FILE });
    expect(r['scope-secrets-file']?.status).toBe('ok');
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID']?.status).toBe('ok');
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID']?.detail).toContain('the scope secrets file');
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_SECRET']?.status).toBe('ok');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('without it the same keys are missing', async () => {
    const r = await run({});
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID']?.status).toBe('missing');
  });

  it('supplies the runner endpoint: found, probed, and the source names the scope file', async () => {
    const fetched: string[] = [];
    const r = await run({ [SCOPE_FILE]: `MACF_RUNNER_PLATFORM_ENDPOINT=${SCOPE_ENDPOINT}\n` }, { scopeSecretsPath: SCOPE_FILE }, {}, fetched);
    expect(r['runner-endpoint-source']?.detail).toBe(`runner endpoint: ${SCOPE_ENDPOINT} (from the scope secrets file)`);
    expect(fetched).toEqual([`${SCOPE_ENDPOINT}/`]);
  });

  it('a per-fleet value wins over the scope file, as in apply', async () => {
    const fetched: string[] = [];
    const r = await run(
      { [FLEET_FILE]: `MACF_RUNNER_PLATFORM_ENDPOINT=${FLEET_ENDPOINT}\n${SCOPE_PAIR}`, [SCOPE_FILE]: `MACF_RUNNER_PLATFORM_ENDPOINT=${SCOPE_ENDPOINT}\nMACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=other\n` },
      { secretsPath: FLEET_FILE, scopeSecretsPath: SCOPE_FILE },
      {},
      fetched,
    );
    expect(r['runner-endpoint-source']?.detail).toBe(`runner endpoint: ${FLEET_ENDPOINT} (from the secrets file)`);
    expect(fetched).toEqual([`${FLEET_ENDPOINT}/`]);
  });

  it('a missing or loose scope file is reported like the per-fleet one', async () => {
    const r = await run({}, { scopeSecretsPath: SCOPE_FILE });
    expect(r['scope-secrets-file']?.status).toBe('missing');
  });
});

describe('the flags', () => {
  it('--ts-oauth-client-id and --ts-oauth-secret supply the pair and win over the scope file', async () => {
    const r = await run({ [SCOPE_FILE]: `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=scopeid\n` }, { scopeSecretsPath: SCOPE_FILE, tsOauthClientId: 'flagid', tsOauthSecret: SECRET });
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID']?.detail).toContain('a flag');
    expect(r['secret-MACF_BOOTSTRAP_TS_OAUTH_SECRET']?.status).toBe('ok');
    expect(r['apply-ts-oauth-incomplete']?.status).toBe('ok');
  });

  it('a lone --ts-oauth-client-id with no secret anywhere is the half-pair refusal', async () => {
    const r = await run({}, { tsOauthClientId: 'flagid' });
    expect(r['apply-ts-oauth-incomplete']?.status).toBe('wrong');
  });

  it('--runner-token stands in for a runner endpoint', async () => {
    const r = await run({}, { runnerToken: 'AAAA' });
    expect(r['runner-endpoint-source']?.status).toBe('ok');
    expect(r['runner-endpoint-source']?.detail).toContain('runner-registration token');
    expect(JSON.stringify(r)).not.toContain('AAAA');
  });

  it('a runner token in the scope file does the same', async () => {
    const r = await run({ [SCOPE_FILE]: 'MACF_BOOTSTRAP_RUNNER_TOKEN=BBBB\n' }, { scopeSecretsPath: SCOPE_FILE });
    expect(r['runner-endpoint-source']?.status).toBe('ok');
  });
});

describe('guard: every input-carrying apply option is mirrored or listed as not needed', () => {
  let apply: readonly string[];
  let preflight: readonly string[];
  beforeAll(async () => {
    let root: Command | undefined;
    const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command) {
      root = this;
      return Promise.resolve(this);
    });
    try {
      await import('../../src/cli/index.js');
    } finally {
      spy.mockRestore();
    }
    const bootstrap = root?.commands.find((c) => c.name() === 'bootstrap');
    const longs = (name: string): string[] => (bootstrap?.commands.find((c) => c.name() === name)?.options ?? []).flatMap((o) => (o.long !== undefined ? [o.long] : []));
    apply = longs('apply');
    preflight = longs('preflight');
  }, 120_000);

  it('reads both commands from the real tree', () => {
    expect(apply).toContain('--scope-secrets-file');
    expect(preflight).toContain('--secrets-file');
  });

  it('has no apply option that preflight neither takes nor lists', () => {
    const listed = new Set(PREFLIGHT_NOT_NEEDED_APPLY_OPTIONS.map((o) => o.flag));
    const unaccounted = apply.filter((f) => !preflight.includes(f) && !listed.has(f));
    expect(unaccounted).toEqual([]);
  });

  it('lists only real apply options that preflight really does not take', () => {
    for (const o of PREFLIGHT_NOT_NEEDED_APPLY_OPTIONS) {
      expect(apply, o.flag).toContain(o.flag);
      expect(preflight, o.flag).not.toContain(o.flag);
    }
  });
});
