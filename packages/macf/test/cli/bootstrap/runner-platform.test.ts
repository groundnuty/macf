/**
 * Tests for `runner-platform.ts` — the runner-provisioning contract client
 * (groundnuty/macf#943, DR-043 Amendment I2). Fully offline: every test
 * injects a fake `fetchImpl`, never touches the network. See
 * `apply-fleet.test.ts`'s "runner-provisioning contract" describe block for
 * the end-to-end wiring (real `applyFleet`, asserting the call was actually
 * made — the decisive pair `assert-the-wrong-path.md` requires).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RUNNER_PLATFORM_ENDPOINT_ENV_VAR,
  resolveRunnerPlatformEndpoint,
  provisionRunner,
  deprovisionRunner,
  runnerPlatformCredentialsFromOutcome,
} from '../../../src/cli/bootstrap/runner-platform.js';
import type { RunnerOpsApplyOutcome } from '../../../src/cli/bootstrap/apply-runner-ops.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveRunnerPlatformEndpoint (groundnuty/macf#943)', () => {
  const savedEnv = process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR];
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR];
    else process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR] = savedEnv;
  });

  it('explicit value wins over the env var', () => {
    process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR] = 'http://env-value:8088';
    expect(resolveRunnerPlatformEndpoint('http://explicit:8088')).toBe('http://explicit:8088');
  });

  it('falls through to the env var when explicit is undefined', () => {
    process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR] = 'http://env-value:8088';
    expect(resolveRunnerPlatformEndpoint(undefined)).toBe('http://env-value:8088');
  });

  it('NO baked-in default — undefined explicit AND unset env resolves to undefined, never a guessed hostname', () => {
    delete process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR];
    expect(resolveRunnerPlatformEndpoint(undefined)).toBeUndefined();
  });

  it('an empty-string env var is treated as unset, not a valid (empty) endpoint', () => {
    process.env[RUNNER_PLATFORM_ENDPOINT_ENV_VAR] = '';
    expect(resolveRunnerPlatformEndpoint(undefined)).toBeUndefined();
  });

  it('strips trailing slashes so path-joining never double-slashes', () => {
    expect(resolveRunnerPlatformEndpoint('http://x:8088/')).toBe('http://x:8088');
    expect(resolveRunnerPlatformEndpoint('http://x:8088///')).toBe('http://x:8088');
  });
});

describe('provisionRunner (groundnuty/macf#943)', () => {
  it('DECISIVE: not-configured when endpoint is undefined — the call is never attempted, never conflated with success', async () => {
    let fetchCalled = false;
    const result = await provisionRunner(
      { endpoint: undefined, fetchImpl: (async () => { fetchCalled = true; return jsonResponse(200, { ok: true }); }) as typeof fetch },
      { repo: 'groundnuty/x' },
    );
    expect(result.status).toBe('not-configured');
    expect(fetchCalled).toBe(false); // honest-unknown: no network call was even attempted
  });

  it('DECISIVE: 200 -> ok, and the request was POSTed to the right URL with the right JSON body', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(200, { ok: true, applied: ['RunnerDeployment', 'HorizontalRunnerAutoscaler'] });
    }) as typeof fetch;
    const result = await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl },
      { repo: 'groundnuty/x', labels: ['self-hosted', 'macf-vm'], warm: 1, fleet: 'demo-fleet' },
    );
    expect(result).toEqual({ status: 'ok', applied: ['RunnerDeployment', 'HorizontalRunnerAutoscaler'] });
    expect(capturedUrl).toBe('http://platform:8088/runners');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      repo: 'groundnuty/x',
      labels: ['self-hosted', 'macf-vm'],
      warm: 1,
      fleet: 'demo-fleet',
    });
  });

  it('200 with no applied array in the body still resolves ok (the field is optional)', async () => {
    const result = await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl: (async () => jsonResponse(200, { ok: true })) as typeof fetch },
      { repo: 'groundnuty/x' },
    );
    expect(result).toEqual({ status: 'ok' });
  });

  it('400 -> contract-error, carrying the body\'s error field verbatim (e.g. the OWNER_ALLOWLIST refusal)', async () => {
    const result = await provisionRunner(
      {
        endpoint: 'http://platform:8088',
        fetchImpl: (async () => jsonResponse(400, { ok: false, error: "owner 'macf-experiment' is not in OWNER_ALLOWLIST ['groundnuty']" })) as typeof fetch,
      },
      { repo: 'macf-experiment/x' },
    );
    expect(result.status).toBe('contract-error');
    expect(result.status === 'contract-error' && result.reason).toContain('OWNER_ALLOWLIST');
  });

  it('404 -> not-ready', async () => {
    const result = await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl: (async () => jsonResponse(404, { ok: false, error: 'not provisioned' })) as typeof fetch },
      { repo: 'groundnuty/x' },
    );
    expect(result.status).toBe('not-ready');
  });

  it('DECISIVE (Amendment I2 — "502 should not fail your provisioning run"): 502 -> cluster-problem, non-fatal', async () => {
    const result = await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl: (async () => jsonResponse(502, {})) as typeof fetch },
      { repo: 'groundnuty/x' },
    );
    expect(result.status).toBe('cluster-problem');
  });

  it('an unexpected status code (not in the documented 200/400/404/502 set) degrades to cluster-problem, never throws', async () => {
    const result = await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl: (async () => jsonResponse(500, {})) as typeof fetch },
      { repo: 'groundnuty/x' },
    );
    expect(result.status).toBe('cluster-problem');
  });

  it('DECISIVE (honest-unknown floor): a network failure (fetch throws) -> unreachable, distinct from every other status, NEVER throws out of this function', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    const result = await provisionRunner(
      {
        endpoint: 'http://platform:8088',
        fetchImpl: (async () => {
          throw err;
        }) as unknown as typeof fetch,
      },
      { repo: 'groundnuty/x' },
    );
    expect(result.status).toBe('unreachable');
    expect(result.status === 'unreachable' && result.reason).toContain('ECONNREFUSED');
  });

  it('a response body that is not JSON at all still resolves a status, never throws', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    const result = await provisionRunner({ endpoint: 'http://platform:8088', fetchImpl }, { repo: 'groundnuty/x' });
    expect(result).toEqual({ status: 'ok' });
  });

  it('credentials, when supplied, are included verbatim in the request body', async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    await provisionRunner(
      { endpoint: 'http://platform:8088', fetchImpl },
      {
        repo: 'macf-experiment/x',
        credentials: { app_id: '4616819', installation_id: '154246953', private_key: 'SENTINEL-PEM' },
      },
    );
    expect(capturedBody).toEqual({
      repo: 'macf-experiment/x',
      credentials: { app_id: '4616819', installation_id: '154246953', private_key: 'SENTINEL-PEM' },
    });
  });
});

describe('deprovisionRunner (groundnuty/macf#943 — no caller yet, see runner-platform.ts\'s "Teardown — deliberately unwired")', () => {
  it('DELETEs the owner/repo path, symmetric to provisionRunner', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init?.method;
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    const result = await deprovisionRunner({ endpoint: 'http://platform:8088', fetchImpl }, 'groundnuty/x');
    expect(result.status).toBe('ok');
    expect(capturedUrl).toBe('http://platform:8088/runners/groundnuty/x');
    expect(capturedMethod).toBe('DELETE');
  });

  it('not-configured, same honest-unknown floor as provisionRunner, when the endpoint is unset', async () => {
    const result = await deprovisionRunner({ endpoint: undefined }, 'groundnuty/x');
    expect(result.status).toBe('not-configured');
  });
});

describe('runnerPlatformCredentialsFromOutcome (groundnuty/macf#943)', () => {
  it('DECISIVE: a freshly-created (this run) outcome yields the credential, verbatim from AppCredentials', () => {
    const outcome: RunnerOpsApplyOutcome = {
      role: 'runner-ops',
      status: 'created',
      appId: '4616819',
      installId: '154246953',
      credentials: { appId: '4616819', name: 'x', slug: 'x', clientId: 'c', clientSecret: 's', webhookSecret: 'w', pem: 'SENTINEL-PEM' },
    };
    expect(runnerPlatformCredentialsFromOutcome(outcome)).toEqual({
      app_id: '4616819',
      installation_id: '154246953',
      private_key: 'SENTINEL-PEM',
    });
  });

  it('a reused (from a prior run) outcome, with NO vaultPem supplied, yields undefined — no PEM is in memory this run and nothing was resolved from the vault either', () => {
    const outcome: RunnerOpsApplyOutcome = { role: 'runner-ops', status: 'reused', appId: '4616819', installId: '154246953' };
    expect(runnerPlatformCredentialsFromOutcome(outcome)).toBeUndefined();
  });

  it('a resumed-install outcome, with NO vaultPem supplied, ALSO yields undefined, same reason as reused', () => {
    const outcome: RunnerOpsApplyOutcome = { role: 'runner-ops', status: 'resumed-install', appId: '4616819', installId: '154246953' };
    expect(runnerPlatformCredentialsFromOutcome(outcome)).toBeUndefined();
  });

  // --- groundnuty/macf#943 follow-up (the run-2 credential-less-POST fix) —
  // the vaultPem fallback second argument, sourced by apply-fleet.ts's
  // `resolveRunnerOpsVaultPem` from `AgentApplyDeps.resolveKeyPath`.

  it('DECISIVE: a reused outcome WITH a vaultPem supplied yields the credential, appId/installId from the outcome + the PEM from the vault', () => {
    const outcome: RunnerOpsApplyOutcome = { role: 'runner-ops', status: 'reused', appId: '4616819', installId: '154246953' };
    expect(runnerPlatformCredentialsFromOutcome(outcome, 'SENTINEL-VAULT-PEM')).toEqual({
      app_id: '4616819',
      installation_id: '154246953',
      private_key: 'SENTINEL-VAULT-PEM',
    });
  });

  it('a resumed-install outcome WITH a vaultPem supplied ALSO yields the credential, same shape as reused', () => {
    const outcome: RunnerOpsApplyOutcome = { role: 'runner-ops', status: 'resumed-install', appId: '4616819', installId: '154246953' };
    expect(runnerPlatformCredentialsFromOutcome(outcome, 'SENTINEL-VAULT-PEM')).toEqual({
      app_id: '4616819',
      installation_id: '154246953',
      private_key: 'SENTINEL-VAULT-PEM',
    });
  });

  it('a `created` outcome ignores a supplied vaultPem entirely — the in-memory PEM always wins, never overridden by a stale vault read', () => {
    const outcome: RunnerOpsApplyOutcome = {
      role: 'runner-ops',
      status: 'created',
      appId: '4616819',
      installId: '154246953',
      credentials: { appId: '4616819', name: 'x', slug: 'x', clientId: 'c', clientSecret: 's', webhookSecret: 'w', pem: 'IN-MEMORY-PEM' },
    };
    expect(runnerPlatformCredentialsFromOutcome(outcome, 'STALE-VAULT-PEM')).toEqual({
      app_id: '4616819',
      installation_id: '154246953',
      private_key: 'IN-MEMORY-PEM',
    });
  });

  it('not-needed / failed / drift / skipped-unverified outcomes all yield undefined regardless of vaultPem — no App identity to build a credential from', () => {
    expect(runnerPlatformCredentialsFromOutcome({ role: 'runner-ops', status: 'not-needed', reason: 'x' }, 'SENTINEL-VAULT-PEM')).toBeUndefined();
    expect(runnerPlatformCredentialsFromOutcome({ role: 'runner-ops', status: 'failed', reason: 'x' }, 'SENTINEL-VAULT-PEM')).toBeUndefined();
    expect(runnerPlatformCredentialsFromOutcome({ role: 'runner-ops', status: 'drift', reason: 'x', installs: [] }, 'SENTINEL-VAULT-PEM')).toBeUndefined();
    expect(runnerPlatformCredentialsFromOutcome({ role: 'runner-ops', status: 'skipped-unverified', appId: 'a', reason: 'x' }, 'SENTINEL-VAULT-PEM')).toBeUndefined();
  });
});
