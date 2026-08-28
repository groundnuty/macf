/**
 * Executing test for groundnuty/macf#1332 — the `ping` case's cross-fleet
 * guest resolution (DR-041 Amendment A, macf#786) had ONLY a source-shape
 * test (`test/plugin/guest-peers-wiring.test.ts`): it greps the `ping` case's
 * source slice for `resolveGuestAddress` + the three ladder branches, but
 * never actually INVOKES `ping`. A source-shape test proves the call is
 * written; it cannot prove the call is reached (see
 * `plugin/rules/assert-the-wrong-path.md` + `#1292`, where exactly that gap
 * hid a defect: tests drove something adjacent to the live path and passed
 * while the live path was broken).
 *
 * This file drives the REAL, unmodified `main()` — same wiring
 * `macf-plugin-cli.ts`'s `ping` case has always had — through `process.argv`
 * + env vars, exactly as the compiled binary is invoked
 * (`packages/macf/plugin/skills/macf-ping/SKILL.md`). `main()` was changed
 * ONLY at the entry seam (exported + gated behind `isMainModule()`, mirroring
 * `plugin/lib/stale-issue-citations.ts`) — no line inside the `ping` case's
 * dispatch, resolution, or transport logic was touched, and no resolver is
 * injected into `ping` (that would reproduce #1292's fixture-supplies-the-
 * precondition failure exactly).
 *
 * Mock boundary, chosen to mirror `notify-peer.test.ts:414`'s sibling test
 * for the SAME DR-041 Amendment A ladder:
 *   - `node:https` — the actual wire transport `pingAgentHealth`
 *     (`@groundnuty/macf-core`) hits. Mocked so the test can observe the
 *     resolved host:port without a real network call — identical mock shape
 *     to `notify-peer.test.ts`.
 *   - `@groundnuty/macf-core`'s `createRegistryFromConfig` — the registry
 *     factory the `ping` case's inline `resolveCrossProjectAgent` closure
 *     builds internally (`createRegistryFromConfig(registryConfig,
 *     homeProject, token).get(name)`). `notify-peer.test.ts` can inject its
 *     resolver directly because `notifyPeer()` accepts it as a constructor
 *     dependency (real production DI, wired for real in `server.ts`);
 *     `macf-plugin-cli.ts`'s `main()` has no such seam — it constructs the
 *     registry client itself — so the equivalent boundary is the registry
 *     FACTORY (the external-system entry point), not a resolver parameter
 *     on `ping`. `resolveGuestAddress` itself — the function under test —
 *     is the REAL macf-core export throughout, kept via `importOriginal`.
 *   - `@groundnuty/macf-core`'s `resolveGuestProbeCaBundle` — the DR-041
 *     Amendment B CA-federation step downstream of a successful guest
 *     resolution. Orthogonal to what #1332 is about (guest ADDRESS
 *     resolution, not CA-bundle federation, which has its own test
 *     coverage in `trust-bundle.test.ts`); mocked to pass the CA PEM through
 *     unchanged so it can't block reaching the transport.
 *
 * `MACF_REGISTRY_TYPE=local` sidesteps `mintFreshGitHubToken()` entirely
 * (`main()`'s own ternary: `registryConfig.type === 'local' ? '' :
 * await mintFreshGitHubToken()`) — no real GitHub App credentials needed.
 * Since `createRegistryFromConfig` is mocked outright, the local registry's
 * real file-permission machinery (0700/0600 checks) is never reached either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requestMock = vi.fn();
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const createRegistryFromConfigMock = vi.fn();
const resolveGuestProbeCaBundleMock = vi.fn();
vi.mock('@groundnuty/macf-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRegistryFromConfig: (...args: unknown[]) => createRegistryFromConfigMock(...args),
    resolveGuestProbeCaBundle: (...args: unknown[]) => resolveGuestProbeCaBundleMock(...args),
  };
});

const { main } = await import('../../../src/plugin/bin/macf-plugin-cli.js');

const guestInfo = {
  host: '10.0.0.5',
  port: 8443,
  type: 'permanent' as const,
  instance_id: 'inst-guest',
  started: 't',
};

const healthBody = {
  agent: 'code-agent',
  status: 'online',
  type: 'permanent',
  uptime_seconds: 42,
  current_issue: null,
  version: '0.0.0-test',
  last_notification: null,
};

let lastRequestOptions: Record<string, unknown> | undefined;

/** Same mock shape as `notify-peer.test.ts`'s `nextHttpsRespondsWith` — arms
 * ONE `node:https.request` call to synchronously drive the req/res lifecycle
 * `pingAgentHealth` (macf-core) expects for a GET: no `req.write`, just
 * `req.end()` → callback(res) → `res` emits `data` + `end`. */
function nextHttpsRespondsWithHealth(body: Record<string, unknown>): void {
  requestMock.mockImplementationOnce((...args: unknown[]) => {
    lastRequestOptions = args[0] as Record<string, unknown>;
    const cb = args[1] as (res: EventEmitter & { statusCode: number; resume: () => void }) => void;
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      res.statusCode = 200;
      res.resume = () => undefined;
      cb(res);
      Promise.resolve().then(() => {
        res.emit('data', Buffer.from(JSON.stringify(body)));
        res.emit('end');
      });
    };
    req.destroy = () => undefined;
    return req;
  });
}

let workDir: string;
let getMock: ReturnType<typeof vi.fn>;

function writeFleetConfig(federatedCas: readonly string[]): void {
  mkdirSync(join(workDir, '.github'), { recursive: true });
  writeFileSync(
    join(workDir, '.github', 'macf-fleet.json'),
    JSON.stringify({ federated_cas: federatedCas }),
  );
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'macf-ping-guest-'));
  writeFileSync(join(workDir, 'ca.pem'), 'test-ca-pem');
  writeFileSync(join(workDir, 'agent-cert.pem'), 'test-cert-pem');
  writeFileSync(join(workDir, 'agent-key.pem'), 'test-key-pem');

  process.env['MACF_CA_CERT'] = join(workDir, 'ca.pem');
  process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
  process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
  process.env['MACF_WORKSPACE_DIR'] = workDir;
  process.env['MACF_REGISTRY_TYPE'] = 'local';
  process.env['MACF_REGISTRY_PATH'] = join(workDir, 'registry.json');
  process.env['MACF_PROJECT'] = 'my-project';
  process.env['MACF_AGENT_NAME'] = 'my-agent';

  process.argv[2] = 'ping';

  requestMock.mockReset();
  createRegistryFromConfigMock.mockReset();
  resolveGuestProbeCaBundleMock.mockReset();
  resolveGuestProbeCaBundleMock.mockImplementation(async (ownCaCertPem: string) => ownCaCertPem);

  getMock = vi.fn().mockResolvedValue(guestInfo);
  createRegistryFromConfigMock.mockImplementation(() => ({
    get: getMock,
    list: vi.fn().mockResolvedValue([]),
    register: vi.fn(),
    registerConditional: vi.fn(),
    remove: vi.fn(),
  }));

  lastRequestOptions = undefined;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = undefined;
  delete process.argv[3];
});

describe('macf-plugin-cli ping — cross-fleet guest addressing, EXECUTING (groundnuty/macf#1332)', () => {
  it('federated guest slug resolves via resolveGuestAddress and reaches the transport with the guest\'s address', async () => {
    writeFleetConfig(['ppam-2026']);
    process.argv[3] = 'ppam-2026/code-agent';
    nextHttpsRespondsWithHealth(healthBody);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main();

    // The registry factory's guest-scoped `.get()` was actually invoked with
    // the guest's bare name (proves resolveCrossProjectAgent → resolveGuestAddress
    // wiring was reached, not merely written).
    expect(getMock).toHaveBeenCalledWith('code-agent');
    expect(createRegistryFromConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local' }),
      'ppam-2026',
      '',
    );

    // The transport was reached with the GUEST's resolved host:port — not
    // the own-project registry, not a silent no-op.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(lastRequestOptions?.['hostname']).toBe('10.0.0.5');
    expect(lastRequestOptions?.['port']).toBe(8443);

    expect(process.exitCode).toBeUndefined();
    // Assert BEFORE mockRestore() — restoring a vi.spyOn spy also clears its
    // recorded call history (mockRestore = mockReset + restore original impl).
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ppam-2026/code-agent'));
    logSpy.mockRestore();
  });

  it('non-federated guest slug gives the clear DR-041 error and NEVER invokes the resolver or the transport', async () => {
    writeFleetConfig([]); // home fleet NOT federated
    process.argv[3] = 'ppam-2026/code-agent';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();

    // The clear DR-041 not-federated error — never a silent empty result.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('not in federated_cas'),
    );
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();

    // Decisive negative assertions (per #1321's standard — assert the
    // not-called, not merely "no crash happened"): the guest-scoped
    // resolver's `.get()` and the wire transport were NEVER reached.
    expect(getMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
