/**
 * Preflight runs apply's own input refusals through the same functions.
 * Each included refusal has a refused input and a valid input, and a guard
 * feeds the refused input to apply's function and to preflight together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreflightCheck, PreflightDeps, PreflightOptions } from '../../src/cli/bootstrap/preflight.js';
import { runLocalPreflight } from '../../src/cli/bootstrap/preflight.js';
import { APPLY_INPUT_REFUSALS } from '../../src/cli/bootstrap/preflight-apply-refusals.js';
import { buildReport, formatPreflightText, preflightToJson } from '../../src/cli/commands/bootstrap-preflight.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetLock } from '../../src/cli/bootstrap/fleet-manifest.js';
import { checkVaultFlagsComplete } from '../../src/cli/bootstrap/plan.js';
import { checkTsOauthFlagsComplete, validateTsOauthPair, TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR } from '../../src/cli/bootstrap/apply-routing-secrets.js';
import { checkAppNameLengths } from '../../src/cli/bootstrap/apply-runner-ops.js';
import { checkRegistryScopePreflight } from '../../src/cli/bootstrap/registry-scope-preflight.js';
import { checkAgeRecipientsNarrowing } from '../../src/cli/bootstrap/age-recipients-narrowing.js';
import { checkProvisionedFleetNeedsVault } from '../../src/cli/bootstrap/provisioned-vault-guard.js';
import { missingRequiredOperatorInputs, readOperatorSecretsFile } from '../../src/cli/bootstrap/operator-secrets-file.js';
import { wouldCreateWithNoRecipient } from '../../src/cli/bootstrap/apply-fleet.js';

const R1 = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const R2 = 'age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const GOOD_SECRET = 'tskey-client-SUPERSECRETVALUE123';
const MANIFEST = '/work/fleet.yaml';
const SECRETS = '/work/secrets.env';
const LOCK = '/work/fleet.lock';

function yaml(o: { name?: string; registry?: string; recipients?: string; override?: string } = {}): string {
  return `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: ${o.name ?? 'demo'}
owner:
  account: acme
  type: org
  registry: ${o.registry ?? '{ type: repo, owner: acme, repo: demo-control }'}
network:
  advertise_host: vm.example.ts.net
transport:
  age_recipients: ${o.recipients ?? `[${R1}]`}
  tailscale_oauth_required: true
defaults:
  role_template: groundnuty/agentic-repo-template
agents:
  - role: code-agent
    repo: acme/demo-code-agent
    deploy_path: /home/ubuntu/repos/demo/demo-code-agent
versions:
  macf: 0.2.79
  actions: v3.6.2
`;
}

const secretsText = (id: string | undefined, secret: string | undefined): string =>
  `${id !== undefined ? `${TS_OAUTH_CLIENT_ID_ENV_VAR}=${id}\n` : ''}${secret !== undefined ? `${TS_OAUTH_SECRET_ENV_VAR}=${secret}\n` : ''}`;

const lockText = (recipients: readonly string[]): string => JSON.stringify({ schema_version: 1, fleet: 'demo', agents: [], age_recipients: recipients });

interface Input {
  readonly files: Record<string, string>;
  readonly opts?: Partial<PreflightOptions>;
}

function depsFor(files: Record<string, string>): PreflightDeps {
  return {
    exec: async (cmd, args) => {
      if (cmd === 'gh' && args[1]?.includes('vault.age')) return { code: 1, stdout: '', stderr: 'Not Found (HTTP 404)' };
      return { code: 0, stdout: '0.2.79', stderr: '' };
    },
    fetchUrl: async () => ({ reached: true, detail: 'HTTP 200' }),
    readText: (p) => files[p],
    fileMode: (p) => (files[p] !== undefined ? { exists: true, mode: 0o600 } : { exists: false }),
    env: { DISPLAY: ':0' },
    platform: 'linux',
    nodeVersion: '22.14.0',
    cliVersion: '0.2.79',
  };
}

async function run(input: Input): Promise<readonly PreflightCheck[]> {
  return runLocalPreflight(depsFor(input.files), { file: MANIFEST, secretsPath: SECRETS, ...input.opts });
}

const goodFiles = (): Record<string, string> => ({ [MANIFEST]: yaml(), [SECRETS]: secretsText('client-1', GOOD_SECRET) });

const find = (checks: readonly PreflightCheck[], id: string): PreflightCheck | undefined => checks.find((c) => c.id === id);

describe('each included apply refusal is reported by preflight, and the valid input is ok', () => {
  it('vault flags: --vault without --identity-key', async () => {
    const bad = await run({ files: goodFiles(), opts: { vaultPath: '/work/vault.age' } });
    expect(find(bad, 'apply-vault-flags')?.status).toBe('wrong');
    expect(find(bad, 'apply-vault-flags')?.detail).toContain('TOGETHER');
    const good = await run({ files: goodFiles(), opts: { vaultPath: '/work/vault.age', identityKeyPath: '/work/key.txt' } });
    expect(find(good, 'apply-vault-flags')?.status).toBe('ok');
  });

  it('Tailscale OAuth pair: only one value set', async () => {
    const bad = await run({ files: { ...goodFiles(), [SECRETS]: secretsText('client-1', undefined) } });
    expect(find(bad, 'apply-ts-oauth-incomplete')?.status).toBe('wrong');
    expect(find(await run({ files: goodFiles() }), 'apply-ts-oauth-incomplete')?.status).toBe('ok');
  });

  it('Tailscale OAuth pair: a placeholder or a secret without its prefix, never printing the value', async () => {
    const placeholder = await run({ files: { ...goodFiles(), [SECRETS]: secretsText('<client-id>', GOOD_SECRET) } });
    expect(find(placeholder, 'apply-ts-oauth-malformed')?.status).toBe('wrong');
    const noPrefix = await run({ files: { ...goodFiles(), [SECRETS]: secretsText('client-1', 'NOPREFIXSECRETVALUE') } });
    const c = find(noPrefix, 'apply-ts-oauth-malformed');
    expect(c?.status).toBe('wrong');
    const out = formatPreflightText(buildReport(noPrefix)) + JSON.stringify(preflightToJson(buildReport(noPrefix)));
    expect(out).not.toContain('NOPREFIXSECRETVALUE');
    expect(find(await run({ files: goodFiles() }), 'apply-ts-oauth-malformed')?.status).toBe('ok');
  });

  it('App names over the length limit', async () => {
    const bad = await run({ files: { ...goodFiles(), [MANIFEST]: yaml({ name: 'a-fleet-name-that-is-far-too-long-for-github' }) } });
    expect(find(bad, 'apply-app-name-length')?.status).toBe('wrong');
    expect(find(await run({ files: goodFiles() }), 'apply-app-name-length')?.status).toBe('ok');
  });

  it('registry type org', async () => {
    const bad = await run({ files: { ...goodFiles(), [MANIFEST]: yaml({ registry: '{ type: org, org: acme }' }) } });
    expect(find(bad, 'apply-registry-scope')?.status).toBe('wrong');
    expect(find(await run({ files: goodFiles() }), 'apply-registry-scope')?.status).toBe('ok');
  });

  it('age_recipients narrowed against fleet.lock', async () => {
    const bad = await run({ files: { ...goodFiles(), [LOCK]: lockText([R1, R2]) } });
    expect(find(bad, 'apply-age-recipients-narrowing')?.status).toBe('wrong');
    expect(find(bad, 'apply-age-recipients-narrowing')?.detail).toContain(R2);
    const good = await run({ files: { ...goodFiles(), [LOCK]: lockText([R1]) } });
    expect(find(good, 'apply-age-recipients-narrowing')?.status).toBe('ok');
  });

  it('age_recipients empty while an agent would be created', async () => {
    const bad = await run({ files: { ...goodFiles(), [MANIFEST]: yaml({ recipients: '[]' }) } });
    expect(find(bad, 'apply-age-recipients-empty')?.status).toBe('wrong');
    expect(find(bad, 'apply-age-recipients-empty')?.detail).toContain('transport.age_recipients is empty');
    expect(find(await run({ files: goodFiles() }), 'apply-age-recipients-empty')).toBeUndefined();
  });

  it('required secrets keys missing when no vault flags are given', async () => {
    const bad = await run({ files: { ...goodFiles(), [SECRETS]: '' } });
    expect(bad.filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['missing', 'missing']);
    const withVault = await run({ files: { ...goodFiles(), [SECRETS]: '' }, opts: { vaultPath: '/v', identityKeyPath: '/k' } });
    expect(withVault.filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['unknown', 'unknown']);
    expect((await run({ files: goodFiles() })).filter((c) => c.id.startsWith('secret-')).map((c) => c.status)).toEqual(['ok', 'ok']);
  });

  it('a provisioned fleet run without the vault flags', async () => {
    const files = { ...goodFiles(), [LOCK]: lockText([R1]) };
    expect(find(await run({ files }), 'apply-provisioned-needs-vault')?.status).toBe('wrong');
    expect(find(await run({ files, opts: { vaultPath: '/v', identityKeyPath: '/k' } }), 'apply-provisioned-needs-vault')?.status).toBe('ok');
    expect(find(await run({ files: goodFiles() }), 'apply-provisioned-needs-vault')?.status).toBe('ok');
  });
});

// One case per included refusal: the refused input, whether apply's own function refuses it, and which preflight check must not be ok.
interface GuardCase {
  readonly input: Input;
  readonly applyRefuses: () => boolean;
  readonly checkIds: readonly string[];
}

const manifestOf = (text: string): ReturnType<typeof parseFleetManifest> => parseFleetManifest(text);
const lockOf = (recipients: readonly string[]): FleetLock => ({ schema_version: 1, fleet: 'demo', agents: [], age_recipients: recipients }) as FleetLock;

const GUARD: Readonly<Record<string, GuardCase>> = {
  'apply-vault-flags': {
    input: { files: goodFiles(), opts: { vaultPath: '/work/vault.age' } },
    applyRefuses: () => checkVaultFlagsComplete('/work/vault.age', undefined) !== undefined,
    checkIds: ['apply-vault-flags'],
  },
  'secrets-file': {
    input: { files: { [MANIFEST]: yaml() } },
    applyRefuses: () => readOperatorSecretsFile('/nonexistent/secrets.env')?.ok === false,
    checkIds: ['secrets-file'],
  },
  'apply-ts-oauth-incomplete': {
    input: { files: { ...goodFiles(), [SECRETS]: secretsText('client-1', undefined) } },
    applyRefuses: () => checkTsOauthFlagsComplete('client-1', undefined) !== undefined,
    checkIds: ['apply-ts-oauth-incomplete'],
  },
  'apply-ts-oauth-malformed': {
    input: { files: { ...goodFiles(), [SECRETS]: secretsText('client-1', 'NOPREFIX') } },
    applyRefuses: () => validateTsOauthPair('client-1', 'NOPREFIX') !== undefined,
    checkIds: ['apply-ts-oauth-malformed'],
  },
  'apply-app-name-length': {
    input: { files: { ...goodFiles(), [MANIFEST]: yaml({ name: 'a-fleet-name-that-is-far-too-long-for-github' }) } },
    applyRefuses: () => !checkAppNameLengths(manifestOf(yaml({ name: 'a-fleet-name-that-is-far-too-long-for-github' }))).ok,
    checkIds: ['apply-app-name-length'],
  },
  'apply-registry-scope': {
    input: { files: { ...goodFiles(), [MANIFEST]: yaml({ registry: '{ type: org, org: acme }' }) } },
    applyRefuses: () => checkRegistryScopePreflight(manifestOf(yaml({ registry: '{ type: org, org: acme }' })).owner) !== undefined,
    checkIds: ['apply-registry-scope'],
  },
  'apply-age-recipients-narrowing': {
    input: { files: { ...goodFiles(), [LOCK]: lockText([R1, R2]) } },
    applyRefuses: () => checkAgeRecipientsNarrowing([R1], lockOf([R1, R2]), undefined) !== undefined,
    checkIds: ['apply-age-recipients-narrowing'],
  },
  'secret-keys': {
    input: { files: { ...goodFiles(), [SECRETS]: '' } },
    applyRefuses: () =>
      missingRequiredOperatorInputs([
        { key: TS_OAUTH_CLIENT_ID_ENV_VAR, required: true, value: undefined },
        { key: TS_OAUTH_SECRET_ENV_VAR, required: true, value: undefined },
      ]).length > 0,
    checkIds: [`secret-${TS_OAUTH_CLIENT_ID_ENV_VAR}`, `secret-${TS_OAUTH_SECRET_ENV_VAR}`],
  },
  'apply-provisioned-needs-vault': {
    input: { files: { ...goodFiles(), [LOCK]: lockText([R1]) } },
    applyRefuses: () => checkProvisionedFleetNeedsVault(lockOf([R1]), undefined, undefined, MANIFEST) !== undefined,
    checkIds: ['apply-provisioned-needs-vault'],
  },
  'apply-age-recipients-empty': {
    input: { files: { ...goodFiles(), [MANIFEST]: yaml({ recipients: '[]' }) } },
    applyRefuses: () => wouldCreateWithNoRecipient(undefined, []),
    checkIds: ['apply-age-recipients-empty'],
  },
};

describe('guard: apply never refuses an input that preflight reports ok', () => {
  const included = APPLY_INPUT_REFUSALS.filter((e) => e.included);

  it('has a refused-input case for every included refusal, and no others', () => {
    expect(Object.keys(GUARD).sort()).toEqual(included.map((e) => e.id).sort());
  });

  for (const entry of included) {
    it(`${entry.id}: apply's ${entry.applyFunction} refuses it and preflight does not say ok`, async () => {
      const c = GUARD[entry.id];
      expect(c).toBeDefined();
      if (c === undefined) return;
      expect(c.applyRefuses()).toBe(true);
      const checks = await run(c.input);
      const hits = c.checkIds.map((id) => find(checks, id));
      expect(hits.every((h) => h !== undefined)).toBe(true);
      expect(hits.some((h) => h?.status !== 'ok')).toBe(true);
    });
  }
});

describe('source shape: every check apply makes before the plan is in the list', () => {
  const root = join(__dirname, '..', '..', 'src', 'cli');
  const applySource = readFileSync(join(root, 'commands', 'bootstrap-apply.ts'), 'utf-8');
  const start = applySource.indexOf('export async function runBootstrapApply(');
  const end = applySource.indexOf('resolved.observe(manifest)', start);
  const head = applySource.slice(start, end).replace(/\/\/.*$/gm, '');

  it('finds the slice of runBootstrapApply before it observes GitHub', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('names every check/validate function apply calls there', () => {
    const called = new Set([...head.matchAll(/\b(check[A-Z]\w*|validate[A-Z]\w*|missingRequired\w*|readOperatorSecretsFile)\(/g)].map((m) => (m[1] ?? '').replace(/\($/, '')));
    const listed = new Set(APPLY_INPUT_REFUSALS.map((e) => e.applyFunction));
    expect([...called].filter((n) => !listed.has(n))).toEqual([]);
    expect(called.size).toBeGreaterThan(5);
  });

  it('wires every included function into preflight (the secrets-file read goes through the injected reader)', () => {
    const preflightSource = ['preflight.ts', 'preflight-apply-refusals.ts'].map((f) => readFileSync(join(root, 'bootstrap', f), 'utf-8')).join('\n');
    for (const e of APPLY_INPUT_REFUSALS.filter((x) => x.included)) {
      const name = e.applyFunction === 'readOperatorSecretsFile' ? 'parseOperatorSecretsFile' : e.applyFunction;
      expect(preflightSource, e.applyFunction).toContain(`${name}(`);
    }
  });
});
