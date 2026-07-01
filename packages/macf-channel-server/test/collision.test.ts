import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Registry, AgentInfo } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';

// Mock node:https request to avoid real network calls
vi.mock('node:https', () => ({
  request: vi.fn(),
}));

// Mock node:fs readFileSync for cert loading
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-cert')),
  };
});

const { request: mockRequest } = await import('node:https');
const { checkCollision } = await import('../src/collision.js');

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockRegistry(getResult: AgentInfo | null = null): Registry {
  return {
    register: vi.fn(),
    registerConditional: vi.fn(),
    deregisterConditional: vi.fn(),
    heartbeatConditional: vi.fn(),
    get: vi.fn().mockResolvedValue(getResult),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
}

const certPaths = {
  caCertPath: '/fake/ca.pem',
  agentCertPath: '/fake/agent.pem',
  agentKeyPath: '/fake/agent-key.pem',
};

const INCOMING = '0.2.34'; // this instance's version in most tests

const existingAgent: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'a8f3c2',
  started: '2026-03-28T18:00:00Z',
};

// DR-031 (groundnuty/macf#568) staleness fixtures. checkCollision reads the
// real `Date.now()`, so heartbeats are built relative to it at call time — a
// 1h-old beat is robustly past the 15-min TTL (stale); a 1-min-old beat is
// robustly within it (fresh). The few-ms gap between construction and check is
// negligible against those margins.
const staleHb = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const freshHb = (): string => new Date(Date.now() - 60 * 1000).toISOString();
const existingWithHb = (lastHeartbeat: string): AgentInfo => ({ ...existingAgent, last_heartbeat: lastHeartbeat });

/** Find the `takeover_stale_heartbeat` override warn, if it fired (DR-031). */
function staleOverrideWarn(logger: Logger): { result?: string; prior_basis?: string } | undefined {
  const call = vi
    .mocked(logger.warn)
    .mock.calls.find(
      (c) => c[0] === 'collision_check' && (c[1] as { result?: string }).result === 'takeover_stale_heartbeat',
    );
  return call?.[1] as { result?: string; prior_basis?: string } | undefined;
}

/**
 * Mock a LIVE /health response (200) whose JSON body advertises `version`
 * (omitted entirely when `version === null`, simulating a pre-#424 instance)
 * and, optionally, the responder's OWN `instance_id` (groundnuty/macf#733;
 * omitted entirely when `instanceId` is undefined, simulating a pre-#733
 * peer whose `/health` body predates the self-report). Wires
 * res.on('data')/on('end') so collision's pingHealth reads the body.
 */
function mockAliveWithVersion(version: string | null, instanceId?: string): void {
  vi.mocked(mockRequest).mockImplementation((_opts, cb) => {
    const bodyObj: Record<string, unknown> = { status: 'online' };
    if (version !== null) bodyObj['version'] = version;
    if (instanceId !== undefined) bodyObj['instance_id'] = instanceId;
    const bodyStr = JSON.stringify(bodyObj);
    const mockRes = {
      statusCode: 200,
      resume: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'data') handler(Buffer.from(bodyStr));
        if (event === 'end') handler();
        return mockRes;
      }),
    };
    if (cb) (cb as (res: typeof mockRes) => void)(mockRes);
    return { on: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
  });
}

/** Mock a dead peer (connection error on end()). */
function mockDead(): void {
  vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const req = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return req;
      }),
      end: vi.fn(() => {
        if (handlers['error']) handlers['error'](new Error('ECONNREFUSED'));
      }),
      destroy: vi.fn(),
    };
    return req as any;
  });
}

/**
 * Mock the just-killed-port race (groundnuty/macf#553): the peer answers 2xx on
 * the first `aliveCount` ping(s) — simulating the dying instance's not-yet-released
 * listening socket — then is dead (ECONNREFUSED on end()) on every subsequent ping.
 * With aliveCount=1 (default) the slot flickers alive once, then the re-confirm
 * fails → the peer must be treated as dead → takeover.
 */
function mockAliveThenDead(version: string | null = INCOMING, aliveCount = 1): void {
  let call = 0;
  vi.mocked(mockRequest).mockImplementation((_opts, cb) => {
    call += 1;
    if (call <= aliveCount) {
      const bodyObj = version === null ? { status: 'online' } : { status: 'online', version };
      const bodyStr = JSON.stringify(bodyObj);
      const mockRes = {
        statusCode: 200,
        resume: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          if (event === 'data') handler(Buffer.from(bodyStr));
          if (event === 'end') handler();
          return mockRes;
        }),
      };
      if (cb) (cb as (res: typeof mockRes) => void)(mockRes);
      return { on: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    }
    const handlers: Record<string, (...args: any[]) => void> = {};
    const req = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; return req; }),
      end: vi.fn(() => { if (handlers['error']) handlers['error'](new Error('ECONNREFUSED')); }),
      destroy: vi.fn(),
    };
    return req as any;
  });
}

/** Find the warn-level collision_check log basis (the #424 decision). */
function decisionBasis(logger: Logger): string | undefined {
  const warn = vi.mocked(logger.warn);
  const call = warn.mock.calls.find((c) => c[0] === 'collision_check');
  return call ? (call[1] as { result?: string }).result : undefined;
}

describe('checkCollision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['MACF_NO_VERSION_TAKEOVER'];
  });

  it('returns register for fresh start (no variable)', async () => {
    const registry = mockRegistry(null);
    const result = await checkCollision('code-agent', registry, certPaths, INCOMING, mockLogger());
    expect(result.action).toBe('register');
    expect(registry.get).toHaveBeenCalledWith('code-agent');
  });

  describe('dead / unreachable existing → takeover (unchanged)', () => {
    it('takeover when existing agent does not respond', async () => {
      mockDead();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
      if (result.action === 'takeover') expect(result.previous.instance_id).toBe('a8f3c2');
    });

    it('takeover when readFileSync throws (cert-rotation race, ultrareview H3)', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      });
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('takeover when health ping times out', async () => {
      vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
        const handlers: Record<string, (...args: any[]) => void> = {};
        const req = {
          on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; return req; }),
          end: vi.fn(() => { if (handlers['timeout']) handlers['timeout'](); }),
          destroy: vi.fn(),
        };
        return req as any;
      });
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
    });
  });

  describe('alive existing → version-aware decision (groundnuty/macf#424)', () => {
    it('aborts when the alive peer runs the SAME version', async () => {
      mockAliveWithVersion('0.2.34');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('aborts when the alive peer runs a NEWER version', async () => {
      mockAliveWithVersion('0.2.40');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('TAKES OVER an alive peer running an OLDER version', async () => {
      mockAliveWithVersion('0.2.20');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_newer_version');
    });

    it('TAKES OVER an alive peer that advertises NO version (pre-#424 ⟹ oldest) — the motivating incident', async () => {
      mockAliveWithVersion(null);
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_unversioned_existing');
    });

    it('TAKES OVER an alive peer whose version is non-null but unparseable (logged distinctly)', async () => {
      mockAliveWithVersion('garbage'); // non-null, but not x.y.z
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_unparseable_existing');
    });

    it('aborts when the INCOMING is unversioned (never displaces a live peer)', async () => {
      mockAliveWithVersion('0.2.20'); // existing older, but incoming is unversioned
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_incoming_unversioned');
    });

    it('MACF_NO_VERSION_TAKEOVER=1 disables takeover even of an older alive peer (escape hatch)', async () => {
      process.env['MACF_NO_VERSION_TAKEOVER'] = '1';
      mockAliveWithVersion('0.2.20'); // older — would normally be taken over
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_version_takeover_disabled');
    });

    it('reports both versions in the decision log line', async () => {
      mockAliveWithVersion('0.2.20');
      const logger = mockLogger();
      await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      const call = vi.mocked(logger.warn).mock.calls.find((c) => c[0] === 'collision_check');
      expect(call?.[1]).toMatchObject({ incoming_version: '0.2.34', existing_version: '0.2.20' });
    });

    it('re-confirms a genuinely-live same-version peer (two pings) before aborting — no #424 regression', async () => {
      mockAliveWithVersion('0.2.34'); // answers EVERY ping → confirmed alive
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
      // The fix must not trust a single 2xx: the live peer is pinged twice.
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('identity-aware liveness (groundnuty/macf#733 — the phantom-on-the-port bug)', () => {
    it('TAKES OVER when the responder self-reports an instance_id that MISMATCHES the registered slot — the motivating bug', async () => {
      // Something is answering 2xx (same version even) but it is NOT the
      // registered owner ('a8f3c2') — a phantom/stray/orphan on the port.
      mockAliveWithVersion('0.2.34', 'some-other-instance');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_stale_owner_gone');
      if (result.action === 'takeover') expect(result.previous.instance_id).toBe('a8f3c2');
    });

    it('mismatch takeover bypasses MACF_NO_VERSION_TAKEOVER=1 (identity, not version, is the question)', async () => {
      process.env['MACF_NO_VERSION_TAKEOVER'] = '1';
      mockAliveWithVersion('0.2.34', 'some-other-instance');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_stale_owner_gone');
    });

    it('mismatch takeover bypasses the unversioned-incoming guard (identity, not version, is the question)', async () => {
      mockAliveWithVersion('0.2.34', 'some-other-instance');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_stale_owner_gone');
    });

    it('ABORTS (unchanged #424) when the responder instance_id MATCHES the slot + SAME version — no regression', async () => {
      mockAliveWithVersion('0.2.34', 'a8f3c2'); // matches existingAgent.instance_id
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('TAKES OVER (unchanged #424) when the responder instance_id MATCHES the slot but version is OLDER', async () => {
      mockAliveWithVersion('0.2.20', 'a8f3c2'); // matches; existing peer genuinely alive + older
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_newer_version');
    });

    it('falls through to the #424 version quadrant (back-compat) when the responder is a pre-#733 peer (no instance_id in body)', async () => {
      // No instance_id field at all in the /health body — can't compare, so the
      // unchanged version quadrant decides (same version → abort).
      mockAliveWithVersion('0.2.34'); // instanceId omitted
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('logs both the slot + responder instance_id on the decision line', async () => {
      mockAliveWithVersion('0.2.34', 'some-other-instance');
      const logger = mockLogger();
      await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      const call = vi.mocked(logger.warn).mock.calls.find((c) => c[0] === 'collision_check');
      expect(call?.[1]).toMatchObject({
        existing_instance_id: 'a8f3c2',
        responder_instance_id: 'some-other-instance',
      });
    });
  });

  describe('just-killed-port race → takeover (groundnuty/macf#553)', () => {
    it('TAKES OVER a same-version peer that flickers alive once then dies (the motivating race)', async () => {
      mockAliveThenDead('0.2.34'); // same version — a single trusting ping would WRONGLY abort
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', mockLogger());
      expect(result.action).toBe('takeover');
      if (result.action === 'takeover') expect(result.previous.instance_id).toBe('a8f3c2');
      // Re-confirm actually happened: alive ping #1, then the dead re-check #2.
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('TAKES OVER a newer-version peer that flickers alive once then dies', async () => {
      mockAliveThenDead('0.2.40'); // newer — would abort under a single trusting ping
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', mockLogger());
      expect(result.action).toBe('takeover');
    });

    it('does NOT waste a re-check when the first ping is already dead (short-circuit)', async () => {
      mockDead();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
      expect(mockRequest).toHaveBeenCalledTimes(1); // dead-first short-circuits; no second ping
    });
  });

  describe('DR-031 complementary staleness override (groundnuty/macf#568)', () => {
    it('TAKES OVER a same-version alive peer whose heartbeat is STALE (resolves the #553 ambiguity)', async () => {
      mockAliveWithVersion('0.2.34'); // answers EVERY confirm ping → quadrant would ABORT (same version)
      const logger = mockLogger();
      const result = await checkCollision(
        'code-agent',
        mockRegistry(existingWithHb(staleHb())),
        certPaths,
        '0.2.34',
        logger,
      );
      expect(result.action).toBe('takeover');
      if (result.action === 'takeover') expect(result.previous.instance_id).toBe('a8f3c2');
      // Attributed to the stale signal, with the would-have-been quadrant basis preserved.
      expect(staleOverrideWarn(logger)).toMatchObject({ prior_basis: 'abort_same_or_newer' });
    });

    it('leaves a same-version abort UNCHANGED when the heartbeat is FRESH (#424/#557 byte-for-byte)', async () => {
      mockAliveWithVersion('0.2.34');
      const logger = mockLogger();
      const result = await checkCollision(
        'code-agent',
        mockRegistry(existingWithHb(freshHb())),
        certPaths,
        '0.2.34',
        logger,
      );
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
      expect(staleOverrideWarn(logger)).toBeUndefined(); // no override fired
    });

    it('an ABSENT heartbeat is never stale → same-version abort unchanged (back-compat)', async () => {
      mockAliveWithVersion('0.2.34');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
      expect(staleOverrideWarn(logger)).toBeUndefined();
    });

    it('a FRESH heartbeat never BLOCKS a legitimate older-version takeover (one-directional)', async () => {
      mockAliveWithVersion('0.2.20'); // older → quadrant TAKES OVER on its own
      const logger = mockLogger();
      const result = await checkCollision(
        'code-agent',
        mockRegistry(existingWithHb(freshHb())),
        certPaths,
        '0.2.34',
        logger,
      );
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_newer_version'); // via the version path, not stale
      expect(staleOverrideWarn(logger)).toBeUndefined();
    });

    it('reclaims a STALE peer even under MACF_NO_VERSION_TAKEOVER=1 (a provably-dead pin must not strand the slot)', async () => {
      process.env['MACF_NO_VERSION_TAKEOVER'] = '1';
      mockAliveWithVersion('0.2.20'); // older — would abort under the flag
      const logger = mockLogger();
      const result = await checkCollision(
        'code-agent',
        mockRegistry(existingWithHb(staleHb())),
        certPaths,
        '0.2.34',
        logger,
      );
      expect(result.action).toBe('takeover');
      expect(staleOverrideWarn(logger)).toMatchObject({ prior_basis: 'abort_version_takeover_disabled' });
    });
  });
});
