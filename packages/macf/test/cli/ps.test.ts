/**
 * Tests for `macf ps` + the `/proc` scanner (macf#556).
 *
 * Offline + deterministic by construction: the scan reads through an injectable
 * `ProcReader`, so every test feeds SYNTHETIC `/proc` data — no dependency on
 * real running processes. The whole point of the issue is multi-tenant
 * correctness (cwd-keyed, never `head -1`), so the disambiguation cases below
 * are the load-bearing ones.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  agentIdentityFromEnv,
  channelServerPkgRootFromCmdline,
  classifyCmdline,
  parseEnviron,
  parseOtelResourceAttributes,
  scanMacfProcesses,
  splitNul,
  type ProcReader,
} from '../../src/cli/proc-scan.js';
import {
  buildPsEntries,
  buildPsRows,
  formatPsTable,
  formatTable,
  psToJson,
  runPs,
} from '../../src/cli/commands/ps.js';
import type { WorkspaceRecord } from '@groundnuty/macf-core';

/** No-op discovery for the process-only tests (keeps them deterministic). */
const noWorkspaces = (): readonly WorkspaceRecord[] => [];

interface FakeProc {
  readonly cwd?: string;
  readonly cmdline: readonly string[];
  readonly environ?: Record<string, string>;
}

/**
 * Build a synthetic ProcReader from a pid→proc map. `pkgVersions` maps a resolved
 * package-root path → version, backing `readPkgVersion` (macf#682); omit it and
 * the reader has no `readPkgVersion` (the VERSION column degrades to `—`).
 */
function fakeReader(
  procs: Record<string, FakeProc>,
  available = true,
  pkgVersions?: Record<string, string>,
): ProcReader {
  const nul = (parts: readonly string[]): string => parts.join('\0') + '\0';
  return {
    available: () => available,
    listPids: () => Object.keys(procs),
    readCwd: (pid) => procs[pid]?.cwd ?? null,
    readCmdline: (pid) => (procs[pid] ? nul(procs[pid]!.cmdline) : null),
    readEnviron: (pid) => {
      const env = procs[pid]?.environ;
      if (!env) return null;
      return nul(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    },
    ...(pkgVersions ? { readPkgVersion: (root: string) => pkgVersions[root] ?? null } : {}),
  };
}

describe('splitNul', () => {
  it('splits NUL-separated blobs and drops trailing empties', () => {
    expect(splitNul('a\0b\0c\0')).toEqual(['a', 'b', 'c']);
    expect(splitNul('')).toEqual([]);
  });
});

describe('parseEnviron', () => {
  it('parses key=value NUL entries, splitting on the FIRST =', () => {
    const env = parseEnviron('MACF_PORT=4123\0OTEL_EXPORTER_OTLP_ENDPOINT=https://h:4318\0X=a=b\0');
    expect(env['MACF_PORT']).toBe('4123');
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('https://h:4318');
    expect(env['X']).toBe('a=b');
  });

  it('ignores malformed entries (no =, leading =)', () => {
    const env = parseEnviron('NOEQUALS\0=novalue\0OK=1\0');
    expect(env).toEqual({ OK: '1' });
  });
});

describe('parseOtelResourceAttributes', () => {
  it('parses comma-separated k=v attribute strings', () => {
    const attrs = parseOtelResourceAttributes('service.name=macf, gen_ai.agent.name=code-agent');
    expect(attrs['gen_ai.agent.name']).toBe('code-agent');
    expect(attrs['service.name']).toBe('macf');
  });
});

describe('agentIdentityFromEnv', () => {
  it('prefers gen_ai.agent.name from OTEL_RESOURCE_ATTRIBUTES (source=otel)', () => {
    const id = agentIdentityFromEnv({
      OTEL_RESOURCE_ATTRIBUTES: 'gen_ai.agent.name=science-agent',
      MACF_AGENT_NAME: 'should-not-win',
    });
    expect(id).toEqual({ identity: 'science-agent', source: 'otel' });
  });

  it('falls back to MACF_AGENT_NAME (source=env-name)', () => {
    const id = agentIdentityFromEnv({ MACF_AGENT_NAME: 'code-agent' });
    expect(id).toEqual({ identity: 'code-agent', source: 'env-name' });
  });

  it('falls back to MACF_ROUTING_LABEL (source=env-label)', () => {
    const id = agentIdentityFromEnv({ MACF_ROUTING_LABEL: 'macf-devops-agent' });
    expect(id).toEqual({ identity: 'macf-devops-agent', source: 'env-label' });
  });

  it('returns null when no identity signal is present', () => {
    expect(agentIdentityFromEnv({ PATH: '/usr/bin' })).toBeNull();
  });
});

describe('classifyCmdline', () => {
  it('classifies a claude argv0 (by basename)', () => {
    expect(classifyCmdline('claude\0')).toBe('claude');
    expect(classifyCmdline('/usr/local/bin/claude\0--flag\0')).toBe('claude');
  });

  it('classifies a channel-server (substring match wins over claude)', () => {
    expect(classifyCmdline('node\0/x/@groundnuty/macf-channel-server/dist/server.js\0')).toBe(
      'channel-server',
    );
  });

  it('returns null for unrelated processes', () => {
    expect(classifyCmdline('node\0/some/other/app.js\0')).toBeNull();
    expect(classifyCmdline('grep\0claude\0')).not.toBe('channel-server');
    // `grep claude` matches 'claude' as an argv token basename → claude. That's
    // an acceptable, documented heuristic; the important invariant is it never
    // misclassifies as a channel-server.
  });

  it('returns null for an empty cmdline', () => {
    expect(classifyCmdline('')).toBeNull();
  });
});

describe('channelServerPkgRootFromCmdline (macf#682)', () => {
  it('truncates the server.js token at the package marker (inclusive)', () => {
    expect(
      channelServerPkgRootFromCmdline('node\0/x/@groundnuty/macf-channel-server/dist/server.js\0'),
    ).toBe('/x/@groundnuty/macf-channel-server');
  });

  it('handles an npx cache path form', () => {
    expect(
      channelServerPkgRootFromCmdline(
        'node\0/home/u/.npm/_npx/abc/node_modules/@groundnuty/macf-channel-server/dist/server.js\0',
      ),
    ).toBe('/home/u/.npm/_npx/abc/node_modules/@groundnuty/macf-channel-server');
  });

  it('returns null when no token carries the marker (e.g. a claude process)', () => {
    expect(channelServerPkgRootFromCmdline('claude\0--flag\0')).toBeNull();
  });
});

describe('scanMacfProcesses — multi-tenant correctness', () => {
  it('keys EACH process by its own cwd + identity (never head -1)', () => {
    const reader = fakeReader({
      '100': {
        cwd: '/home/u/repos/macf',
        cmdline: ['claude'],
        environ: {
          OTEL_RESOURCE_ATTRIBUTES: 'gen_ai.agent.name=code-agent',
          MACF_PORT: '4100',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mon:4318',
        },
      },
      '200': {
        cwd: '/home/u/repos/science',
        cmdline: ['/usr/bin/claude'],
        environ: { MACF_AGENT_NAME: 'science-agent', MACF_PORT: '4200' },
      },
      '300': {
        cwd: '/home/u/repos/macf',
        cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
        environ: { MACF_ROUTING_LABEL: 'macf-devops-agent', MACF_PORT: '4300' },
      },
      '999': { cwd: '/tmp', cmdline: ['node', '/unrelated.js'], environ: {} },
    });

    const procs = scanMacfProcesses(reader);
    // The unrelated node process is excluded; the 3 MACF processes are kept.
    // Sort = cwd, then kind ('channel-server' < 'claude'), then pid: within the
    // shared macf cwd the channel-server (300) precedes the claude (100).
    expect(procs.map((p) => p.pid)).toEqual(['300', '100', '200']);

    const code = procs.find((p) => p.pid === '100')!;
    expect(code.kind).toBe('claude');
    expect(code.agentIdentity).toBe('code-agent');
    expect(code.identitySource).toBe('otel');
    expect(code.cwdBasename).toBe('macf');
    expect(code.port).toBe('4100');
    expect(code.otelEndpoint).toBe('https://mon:4318');

    const science = procs.find((p) => p.pid === '200')!;
    expect(science.agentIdentity).toBe('science-agent');
    expect(science.otelEndpoint).toBeNull(); // no OTEL — surfaced per-process, not masked

    const cs = procs.find((p) => p.pid === '300')!;
    expect(cs.kind).toBe('channel-server');
    expect(cs.agentIdentity).toBe('macf-devops-agent');
  });

  it('degrades gracefully when a process has unreadable cwd/environ (null)', () => {
    const reader: ProcReader = {
      available: () => true,
      listPids: () => ['100'],
      readCwd: () => null, // EACCES race
      readCmdline: () => 'claude\0',
      readEnviron: () => null,
    };
    const procs = scanMacfProcesses(reader);
    expect(procs).toHaveLength(1);
    expect(procs[0]!.cwd).toBeNull();
    expect(procs[0]!.agentIdentity).toBeNull();
  });

  it('returns [] when /proc is unavailable', () => {
    expect(scanMacfProcesses(fakeReader({}, false))).toEqual([]);
  });

  it('resolves a channel-server VERSION from its on-disk package.json (macf#682)', () => {
    const reader = fakeReader(
      {
        '300': {
          cwd: '/home/u/repos/macf',
          cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
          environ: { MACF_AGENT_NAME: 'code-agent', MACF_PORT: '4300' },
        },
        // A claude process has no framework version of its own → null.
        '100': {
          cwd: '/home/u/repos/macf',
          cmdline: ['claude'],
          environ: { MACF_AGENT_NAME: 'code-agent' },
        },
      },
      true,
      { '/x/@groundnuty/macf-channel-server': '0.2.41' },
    );

    const procs = scanMacfProcesses(reader);
    expect(procs.find((p) => p.pid === '300')!.version).toBe('0.2.41');
    expect(procs.find((p) => p.pid === '100')!.version).toBeNull();
  });

  it('degrades VERSION to null when the reader has no readPkgVersion', () => {
    const reader = fakeReader({
      '300': {
        cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
        environ: { MACF_PORT: '4300' },
      },
    });
    expect(scanMacfProcesses(reader)[0]!.version).toBeNull();
  });
});

describe('formatTable', () => {
  it('pads columns to the widest cell and aligns', () => {
    const out = formatTable(['A', 'BB'], [['xxxx', 'y'], ['z', 'wwww']]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('A     BB');
    expect(lines).toHaveLength(4); // header + sep + 2 rows
  });

  it('handles zero rows without crashing', () => {
    expect(() => formatTable(['A', 'B'], [])).not.toThrow();
  });
});

describe('buildPsRows / formatPsTable', () => {
  it('renders one row per process with placeholders for missing fields', () => {
    const reader = fakeReader({
      '7': { cwd: '/w/macf', cmdline: ['claude'], environ: {} },
    });
    const entries = buildPsEntries(scanMacfProcesses(reader), []);
    const rows = buildPsRows(entries);
    expect(rows).toHaveLength(1);
    // Columns: STATUS PID KIND WORKSPACE AGENT VERSION PIN MACF_PORT OTEL_ENDPOINT CWD
    expect(rows[0]).toEqual([
      'alive', '7', 'claude', 'macf', '—', '—', '—', '—', '(none)', '/w/macf',
    ]);
    expect(formatPsTable(entries)).toContain('(none)');
  });

  it('surfaces a channel-server VERSION cell (macf#682)', () => {
    const reader = fakeReader(
      {
        '9': {
          cwd: '/w/macf',
          cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
          environ: { MACF_PORT: '4300' },
        },
      },
      true,
      { '/x/@groundnuty/macf-channel-server': '0.2.41' },
    );
    const rows = buildPsRows(buildPsEntries(scanMacfProcesses(reader), []));
    expect(rows[0]![5]).toBe('0.2.41'); // VERSION column (running)
  });
});

describe('psToJson (macf#682 + #141)', () => {
  it('emits the entry list + available flag as structured data', () => {
    const reader = fakeReader(
      {
        '9': {
          cwd: '/w/macf',
          cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
          environ: { MACF_AGENT_NAME: 'code-agent', MACF_PORT: '4300' },
        },
      },
      true,
      { '/x/@groundnuty/macf-channel-server': '0.2.41' },
    );
    const json = psToJson(buildPsEntries(scanMacfProcesses(reader), []), true) as {
      available: boolean;
      processes: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.available).toBe(true);
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]).toMatchObject({
      alive: true,
      pid: '9',
      kind: 'channel-server',
      agent: 'code-agent',
      version: '0.2.41',
      port: '4300',
    });
  });

  it('reports available=false with an empty list off-/proc', () => {
    const json = psToJson([], false) as { available: boolean; processes: unknown[] };
    expect(json).toEqual({ available: false, processes: [] });
  });
});

describe('buildPsEntries — alive∪dead union (DR-037 / #141)', () => {
  const ws = (
    agent: string,
    workspace: string,
    versionPin: string | null,
    registry = 'groundnuty',
  ): WorkspaceRecord => ({ agent, workspace, registry, versionPin });

  it('marks a workspace with a matching live process ALIVE and one without DEAD', () => {
    const procs = scanMacfProcesses(
      fakeReader(
        {
          '9': {
            cwd: '/canon/macf',
            cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
            environ: { MACF_AGENT_NAME: 'code-agent', MACF_PORT: '4300' },
          },
        },
        true,
        { '/x/@groundnuty/macf-channel-server': '0.2.44' },
      ),
    );
    const workspaces = [
      ws('code-agent', '/canon/macf', '0.2.44'),
      ws('science-agent', '/canon/science', '0.2.41'),
    ];
    const entries = buildPsEntries(procs, workspaces);

    const alive = entries.find((e) => e.workspacePath === '/canon/macf')!;
    expect(alive.alive).toBe(true);
    expect(alive.version).toBe('0.2.44'); // running
    expect(alive.pinnedVersion).toBe('0.2.44'); // on-disk pin
    expect(alive.registry).toBe('groundnuty');

    const dead = entries.find((e) => e.workspacePath === '/canon/science')!;
    expect(dead.alive).toBe(false);
    expect(dead.pid).toBeNull();
    expect(dead.version).toBeNull(); // no running version for a dead agent
    expect(dead.pinnedVersion).toBe('0.2.41'); // resolves from the on-disk pin
    expect(dead.agent).toBe('science-agent');
  });

  it('renders a dead workspace with a dead STATUS + the pin, cwd falls back to the path', () => {
    const entries = buildPsEntries([], [ws('science-agent', '/canon/science', '0.2.41')]);
    const rows = buildPsRows(entries);
    expect(rows[0]).toEqual([
      'dead', '—', '—', 'science', 'science-agent', '—', '0.2.41', '—', '(none)', '/canon/science',
    ]);
  });

  it('keeps a live process that matches NO discovered workspace (never drops it)', () => {
    const procs = scanMacfProcesses(
      fakeReader({
        '5': { cwd: '/outside/roots', cmdline: ['claude'], environ: { MACF_AGENT_NAME: 'x' } },
      }),
    );
    const entries = buildPsEntries(procs, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alive).toBe(true);
    expect(entries[0]!.pinnedVersion).toBeNull(); // unknown — no workspace matched
  });

  it('emits dead entries under psToJson with alive=false + pinned_version', () => {
    const json = psToJson(
      buildPsEntries([], [ws('science-agent', '/canon/science', '0.2.41')]),
      true,
    ) as { processes: ReadonlyArray<Record<string, unknown>> };
    expect(json.processes[0]).toMatchObject({
      alive: false,
      agent: 'science-agent',
      version: null,
      pinned_version: '0.2.41',
      registry: 'groundnuty',
    });
  });
});

describe('runPs', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('prints a degradation message when introspection is unavailable + no workspaces', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(fakeReader({}, false), {}, noWorkspaces);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/no supported process source/);
  });

  it('still lists discovered workspaces (as dead) when introspection is unavailable', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(fakeReader({}, false), {}, () => [
      { agent: 'science-agent', workspace: '/canon/science', registry: 'groundnuty', versionPin: '0.2.41' },
    ]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('dead');
    expect(out).toContain('science-agent');
    expect(out).toMatch(/liveness unconfirmed/);
  });

  it('prints a no-processes message when nothing matches', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(fakeReader({ '1': { cmdline: ['node', '/x.js'] } }), {}, noWorkspaces);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/No MACF claude/);
  });

  it('prints the table when processes are found', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(
      fakeReader({
        '5': {
          cwd: '/w/macf',
          cmdline: ['claude'],
          environ: { MACF_AGENT_NAME: 'code-agent', MACF_PORT: '4001' },
        },
      }),
      {},
      noWorkspaces,
    );
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('code-agent');
    expect(out).toContain('/w/macf');
    expect(out).toContain('4001');
  });

  it('emits JSON under --json (macf#682)', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(
      fakeReader(
        {
          '5': {
            cwd: '/w/macf',
            cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
            environ: { MACF_AGENT_NAME: 'code-agent', MACF_PORT: '4001' },
          },
        },
        true,
        { '/x/@groundnuty/macf-channel-server': '0.2.41' },
      ),
      { json: true },
      noWorkspaces,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      available: boolean;
      processes: Array<Record<string, unknown>>;
    };
    expect(parsed.available).toBe(true);
    expect(parsed.processes[0]!.version).toBe('0.2.41');
    expect(parsed.processes[0]!.agent).toBe('code-agent');
    expect(parsed.processes[0]!.alive).toBe(true);
  });

  it('emits valid JSON (available=false) off-/proc under --json', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runPs(fakeReader({}, false), { json: true }, noWorkspaces);
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed).toEqual({ available: false, processes: [] });
  });
});
