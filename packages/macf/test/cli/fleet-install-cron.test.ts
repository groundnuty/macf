/**
 * Tests for `macf fleet install-cron` — DR-037 subcommand (macf#686), porting
 * devops-toolkit fleet/install-cron.sh.
 *
 * Pure builders (`buildReconcileFlags` / `buildTokenPrefix` / `buildCronLine` /
 * the crontab-compute trio) are exercised directly; the orchestrator
 * `runFleetInstallCron` is exercised with FAKE deps so nothing touches the real
 * crontab. Load-bearing cases:
 *   - cron-line generation: schedule + `macf fleet reconcile` + report-only-vs-
 *     --execute + the fail-loud token-mint + host-prelude sourcing.
 *   - idempotent install (re-run replaces the marker line, never duplicates).
 *   - --uninstall removes ONLY the macf-watchdog line, preserving the rest.
 *   - report-only DEFAULT (no --execute → the cron runs reconcile dry-run).
 *   - confirm gate (declined → no write) + --print (preview, no write).
 *   - crontab unavailable → exit 2, no write.
 *   - macf#1123: --dir vs ambient MACF_WORKSPACE_DIR precedence in
 *     runFleetInstallCronCommand (the CLI-facing wiring, distinct from the
 *     `runFleetInstallCron` orchestrator above — a bug in the WIRING is
 *     invisible to every test that only calls the orchestrator directly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import {
  buildReconcileFlags,
  buildTokenPrefix,
  buildCronLine,
  buildCronScript,
  cronScriptPath,
  MAX_CRON_LINE,
  stripMarkerLines,
  computeInstalledCrontab,
  computeUninstalledCrontab,
  runFleetInstallCron,
  runFleetInstallCronCommand,
  createRealDeps,
  readAppCreds,
  WATCHDOG_MARKER,
  watchdogMarker,
  DEFAULT_SCHEDULE,
  RECONCILE_ARGS,
  checkMacfBinary,
  type FleetInstallCronDeps,
  type RunFleetInstallCronOptions,
  type AppCreds,
} from '../../src/cli/commands/fleet-install-cron.js';

// macf#1123 — `runFleetInstallCronCommand` shells out to `crontab` via
// `createRealDeps`'s `crontabAvailable`/`readCrontab`. Mock `execFileSync`
// so the wiring test below never touches this host's real crontab (or fails
// on a host with none installed) — `command -v crontab` succeeds; anything
// else throws, which `readCrontab`'s own try/catch already treats as
// "no crontab" (existing, pre-#1123 behavior), so this changes nothing
// about what's under test. Preserve every OTHER real export (`importOriginal`)
// — `@groundnuty/macf-core`'s `token.ts` imports `execFile` from this same
// module, and a from-scratch mock factory drops it, breaking unrelated tests
// transitively importing macf-core in this same file/worker.
const configMock = vi.hoisted(() => ({
  readAgentConfig: vi.fn((_dir: string): { project: string; registry: unknown } | null => ({
    project: 'proj',
    registry: { type: 'org', org: 'acme' },
  })),
}));
vi.mock('../../src/cli/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/config.js')>()),
  readAgentConfig: configMock.readAgentConfig,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args?: readonly string[], opts?: object) => {
      // `<macf> --version` runs for real, against the stub binaries these tests plant.
      if (args?.length === 1 && args[0] === '--version') {
        return actual.execFileSync(cmd, [...args], opts as never);
      }
      if (cmd === 'command' && args?.[0] === '-v' && args?.[1] === 'crontab') {
        return Buffer.from('/usr/bin/crontab\n');
      }
      throw new Error(`ENOENT (mocked node:child_process): ${cmd} ${JSON.stringify(args ?? [])}`);
    }),
  };
});

const WS = '/ws';
const FULL_CREDS: AppCreds = { appId: '123', installId: '456', keyPath: '.github-app-key.pem' };

interface Recorder {
  readonly writes: string[];
  readonly logs: string[];
  readonly warns: string[];
  /** script path → content, as the fake script store holds it. */
  readonly scripts: Map<string, string>;
}

/** A fake deps set recording crontab writes + log/warn output. */
function fakeDeps(overrides: Partial<FleetInstallCronDeps> = {}): {
  deps: FleetInstallCronDeps;
  rec: Recorder;
} {
  const rec: Recorder = { writes: [], logs: [], warns: [], scripts: new Map() };
  const deps: FleetInstallCronDeps = {
    readCrontab: () => null,
    writeCrontab: (content: string) => {
      rec.writes.push(content);
    },
    crontabAvailable: () => true,
    readAppCreds: () => FULL_CREDS,
    installPath: () => INSTALL_PATH,
    resolveMacf: () => MACF_BIN,
    macfVersion: () => CLI_VER,
    helperExists: () => true,
    confirm: async () => true,
    scriptDir: () => SCRIPT_DIR,
    writeScript: (path: string, content: string) => {
      rec.scripts.set(path, content);
    },
    readScript: (path: string) => rec.scripts.get(path) ?? null,
    removeScript: (path: string) => rec.scripts.delete(path),
    log: (msg: string) => rec.logs.push(msg),
    warn: (msg: string) => rec.warns.push(msg),
    ...overrides,
  };
  return { deps, rec };
}

const MARKER = watchdogMarker('acme', 'proj');
const SCRIPT_DIR = '/home/u/.macf/cron';
const SCRIPT = `${SCRIPT_DIR}/acme__proj.sh`;
/** The one script the fake store holds after an install. */
const scriptOf = (rec: Recorder): string => [...rec.scripts.values()][0]!;
const MACF_BIN = '/opt/npm/bin/macf';
const INSTALL_PATH = "/opt/npm/bin:/home/u/.local/bin:/usr/bin";
const CLI_VER = '1.2.3';
const INVOKE = `'${MACF_BIN}' ${RECONCILE_ARGS}`;

function baseOpts(over: Partial<RunFleetInstallCronOptions> = {}): RunFleetInstallCronOptions {
  return {
    project: 'proj',
    owner: 'acme',
    cliVersion: CLI_VER,
    workspaceDir: WS,
    schedule: DEFAULT_SCHEDULE,
    execute: false,
    allowRestart: false,
    withRouting: false,
    noToken: false,
    uninstall: false,
    print: false,
    yes: true,
    prelude: '/ws/.claude/.macf/host-prelude.sh',
    log: '/home/agent/.macf/watchdog.log',
    ...over,
  };
}

describe('buildReconcileFlags', () => {
  it('report-only default omits --execute', () => {
    const flags = buildReconcileFlags({ workspaceDir: '/ws', execute: false, allowRestart: false, withRouting: false });
    expect(flags).not.toContain('--execute');
    expect(flags).toEqual(['--dir', "'/ws'"]);
  });

  it('--execute adds the flag', () => {
    const flags = buildReconcileFlags({ workspaceDir: '/ws', execute: true, allowRestart: false, withRouting: false });
    expect(flags).toContain('--execute');
  });

  it('forwards manifest, routing, and allow-restart in reference order', () => {
    const flags = buildReconcileFlags({
      workspaceDir: '/ws',
      manifest: '/etc/desired.yaml',
      withRouting: true,
      execute: true,
      allowRestart: true,
    });
    expect(flags).toEqual([
      '--dir',
      "'/ws'",
      '--manifest',
      "'/etc/desired.yaml'",
      '--with-routing',
      '--execute',
      '--allow-restart',
    ]);
  });
});

describe('buildTokenPrefix', () => {
  it('bakes a fail-loud mint with export on full creds', () => {
    const { prefix, warning } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: FULL_CREDS,
      helperExists: () => true,
    });
    expect(warning).toBeUndefined();
    expect(prefix).toContain("'/ws/.claude/scripts/macf-gh-token.sh'");
    expect(prefix).toContain('--app-id 123');
    expect(prefix).toContain('--install-id 456');
    // fail-loud: || exit 1 aborts the sweep on a mint failure; then export.
    expect(prefix).toContain('|| exit 1;');
    expect(prefix).toContain('export GH_TOKEN;');
    // $(...) must stay LITERAL so cron mints fresh at run-time.
    expect(prefix).toContain('GH_TOKEN=$(');
  });

  it('absolutizes a relative key path against the workspace', () => {
    const { prefix } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: { appId: '1', installId: '2', keyPath: '.github-app-key.pem' },
      helperExists: () => true,
    });
    expect(prefix).toContain("--key '/ws/.github-app-key.pem'");
  });

  it('preserves an already-absolute key path', () => {
    const { prefix } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: { appId: '1', installId: '2', keyPath: '/etc/macf/key.pem' },
      helperExists: () => true,
    });
    expect(prefix).toContain("--key '/etc/macf/key.pem'");
  });

  it('--no-token yields an empty prefix, no warning', () => {
    const { prefix, warning } = buildTokenPrefix({
      noToken: true,
      workspaceDir: WS,
      creds: FULL_CREDS,
      helperExists: () => true,
    });
    expect(prefix).toBe('');
    expect(warning).toBeUndefined();
  });

  it('missing helper → empty prefix + loud warning', () => {
    const { prefix, warning } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: FULL_CREDS,
      helperExists: () => false,
    });
    expect(prefix).toBe('');
    expect(warning).toMatch(/token helper missing/);
  });

  it('missing creds → empty prefix + loud warning', () => {
    const { prefix, warning } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: { appId: '1' }, // install/key missing
      helperExists: () => true,
    });
    expect(prefix).toBe('');
    expect(warning).toMatch(/APP_ID\/INSTALL_ID\/KEY_PATH/);
  });
});

describe('buildCronLine', () => {
  const parts = {
    schedule: DEFAULT_SCHEDULE,
    scriptPath: SCRIPT,
    logPath: '/home/agent/.macf/watchdog.log',
    marker: MARKER,
  };

  it('runs only the script: schedule + sh script + log + marker', () => {
    expect(buildCronLine(parts)).toBe(
      `${DEFAULT_SCHEDULE} /bin/sh '${SCRIPT}' >> '/home/agent/.macf/watchdog.log' 2>&1 ${MARKER}`,
    );
  });

  it('carries no PATH, token mint or macf path', () => {
    const line = buildCronLine(parts);
    expect(line).not.toContain('PATH=');
    expect(line).not.toContain('GH_TOKEN');
    expect(line).not.toContain(RECONCILE_ARGS);
  });

  it('quotes a script path containing a space and a single quote', () => {
    expect(buildCronLine({ ...parts, scriptPath: "/my h/it's.sh" })).toContain(`'/my h/it'\\''s.sh'`);
  });
});

describe('buildCronScript', () => {
  const parts = {
    macfPath: MACF_BIN,
    installPath: INSTALL_PATH,
    preludePath: '/ws/.claude/.macf/host-prelude.sh',
    tokenPrefix: 'GH_TOKEN=$(x) || exit 1; export GH_TOKEN; ',
    reconcileFlags: [] as readonly string[],
    marker: MARKER,
  };

  it('holds shebang, marker, PATH, prelude, token, exec — in that order', () => {
    const lines = buildCronScript(parts).split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]!.startsWith(MARKER)).toBe(true);
    expect(lines[2]).toBe(`PATH='${INSTALL_PATH}'; export PATH`);
    expect(lines[3]).toBe("[ -f '/ws/.claude/.macf/host-prelude.sh' ] && . '/ws/.claude/.macf/host-prelude.sh'");
    expect(lines[4]).toBe('GH_TOKEN=$(x) || exit 1; export GH_TOKEN;');
    expect(lines[5]).toBe(`exec ${INVOKE}`);
  });

  it('an empty token prefix leaves no blank line', () => {
    expect(buildCronScript({ ...parts, tokenPrefix: '' }).split('\n')).toHaveLength(6);
  });

  it('report-only carries no --execute; execute carries it after the invocation', () => {
    expect(buildCronScript(parts)).not.toContain('--execute');
    expect(buildCronScript({ ...parts, reconcileFlags: ['--execute'] })).toContain(`exec ${INVOKE} --execute\n`);
  });

  it('carries --dir for a plain path and quotes an awkward one', () => {
    const plain = buildReconcileFlags({ workspaceDir: '/ws', withRouting: false, execute: false, allowRestart: false });
    expect(buildCronScript({ ...parts, reconcileFlags: plain })).toContain(`${INVOKE} --dir '/ws'`);
    const odd = buildReconcileFlags({ workspaceDir: "/my ws/it's", withRouting: false, execute: false, allowRestart: false });
    expect(buildCronScript({ ...parts, reconcileFlags: odd })).toContain(`--dir '/my ws/it'\\''s'`);
  });

  it('cronScriptPath is <owner>__<project>.sh', () => {
    expect(cronScriptPath('/d', 'acme', 'proj')).toBe('/d/acme__proj.sh');
  });
});

describe('script naming and a failed crontab write', () => {
  const REFUSAL = (what: string, v: string): string =>
    `macf fleet install-cron: cannot name this fleet's cron script: ${what} "${v}" ` +
    'contains characters other than letters, digits, "." and "-".';

  it.each([
    ['project', 'my_project', {}],
    ['project', 'my project', {}],
    ['owner', 'my_org', {}],
    ['project', 'my project', { print: true }],
    ['project', 'my project', { uninstall: true }],
  ] as const)('refuses %s %j with exit 2 and writes nothing', async (what, value, extra) => {
    const { deps, rec } = fakeDeps({ readCrontab: () => `* * * * * x ${MARKER}\n` });
    const over = what === 'owner' ? { owner: value } : { project: value };
    const code = await runFleetInstallCron(baseOpts({ ...over, ...extra }), deps);
    expect(code).toBe(2);
    expect(rec.warns).toContain(REFUSAL(what, value));
    expect(rec.writes).toEqual([]);
    expect(rec.scripts.size).toBe(0);
  });

  it('a failed crontab write leaves an existing script byte-identical', async () => {
    const { deps, rec } = fakeDeps({
      writeCrontab: () => {
        throw new Error('crontab: boom');
      },
    });
    rec.scripts.set(SCRIPT, 'old script\n');
    await expect(runFleetInstallCron(baseOpts(), deps)).rejects.toThrow('boom');
    expect(rec.scripts.get(SCRIPT)).toBe('old script\n');
  });

  it('a failed crontab write with no existing script leaves none', async () => {
    const { deps, rec } = fakeDeps({
      writeCrontab: () => {
        throw new Error('crontab: boom');
      },
    });
    await expect(runFleetInstallCron(baseOpts(), deps)).rejects.toThrow('boom');
    expect(rec.scripts.size).toBe(0);
  });
});

describe('executed: the crontab line command, from outside the workspace, under env -i', () => {
  it('runs the script, and macf gets fleet reconcile --dir <workspace>', async () => {
    const ws = "/my ws/it's";
    const root = mkdtempSync(join(tmpdir(), 'cron-exec-'));
    try {
      const bin = join(root, 'bin');
      const tools = join(root, 'tools');
      const cwd = join(root, 'elsewhere');
      const out = join(root, 'argv.txt');
      mkdirSync(bin); mkdirSync(cwd); mkdirSync(tools);
      // `fakenode` is on the installing PATH only, as node is under npm's bin.
      writeFileSync(join(tools, 'fakenode'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'macf'), `#!/usr/bin/env fakenode\n{ pwd; for a in "$@"; do printf "%s\\n" "$a"; done; } > '${out}'\n`, { mode: 0o755 });
      const scriptDir = join(root, 'cron');
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const { deps } = fakeDeps({
        installPath: () => `${tools}:/usr/bin:/bin`,
        resolveMacf: () => join(bin, 'macf'),
        scriptDir: () => scriptDir,
        // the real writer, so the line runs what an install really writes
        writeScript: createRealDeps(ws).writeScript,
        helperExists: () => false,
      });
      const logs: string[] = [];
      await runFleetInstallCron(
        baseOpts({ workspaceDir: ws, noToken: true, execute: true, prelude: '/nonexistent/prelude.sh', log: '/dev/null' }),
        { ...deps, log: (m) => logs.push(m), writeCrontab: (c) => logs.push(`CRON:${c}`) },
      );
      const line = logs.find((l) => l.startsWith('CRON:'))!.slice('CRON:'.length).trimEnd();
      const cmd = line.slice(DEFAULT_SCHEDULE.length + 1, line.length - MARKER.length - 1);
      writeFileSync(join(root, 'cron.sh'), cmd + '\n');
      real.execFileSync('/usr/bin/env', ['-i', `HOME=${root}`, 'PATH=/usr/bin:/bin', '/bin/sh', join(root, 'cron.sh')], { cwd });
      const lines = readFileSync(out, 'utf-8').trimEnd().split('\n');
      expect(lines[0]).toBe(realpathSync(cwd));
      expect(lines.slice(1)).toEqual(['fleet', 'reconcile', '--dir', ws, '--execute']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('crontab line length', () => {
  it('a 2,000-character PATH leaves the line well under the cap; the script carries the PATH', async () => {
    const longPath = Array.from({ length: 130 }, (_, i) => `/opt/dir${String(i).padStart(3, '0')}/bin`).join(':');
    expect(longPath.length).toBeGreaterThan(1999);
    const { deps, rec } = fakeDeps({ installPath: () => longPath });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(0);
    const line = rec.writes[0]!.trimEnd();
    expect(line.length).toBeLessThan(MAX_CRON_LINE / 2);
    expect(line).not.toContain(longPath);
    expect(scriptOf(rec)).toContain(`PATH='${longPath}'; export PATH`);
  });

  it('a log path that pushes the line over the cap is refused, exit 2, naming it, nothing written', async () => {
    for (const print of [false, true]) {
      const { deps, rec } = fakeDeps();
      const code = await runFleetInstallCron(baseOpts({ print, log: `/var/log/${'l'.repeat(900)}.log` }), deps);
      expect(code).toBe(2);
      expect(rec.writes).toHaveLength(0);
      expect(rec.scripts.size).toBe(0);
      const msg = rec.warns.join('\n');
      expect(msg).toContain('1000');
      expect(msg).toContain('log path');
    }
  });

  it('measures the cap in UTF-8 bytes: a multibyte log path under 900 characters but over 900 bytes is refused', async () => {
    const log = `/var/log/${'ł'.repeat(400)}.log`;
    expect(log.length).toBeLessThan(MAX_CRON_LINE - 200);
    const { deps, rec } = fakeDeps();
    const code = await runFleetInstallCron(baseOpts({ log }), deps);
    expect(code).toBe(2);
    expect(rec.writes).toHaveLength(0);
    expect(rec.warns.join('\n')).toContain('bytes');
  });
});

describe('the script file', () => {
  it('is written 0700 in a 0700 dir, with the content built from the parts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cron-script-'));
    try {
      const path = cronScriptPath(join(root, 'nested', 'cron'), 'acme', 'proj');
      createRealDeps('/ws').writeScript(path, 'content\n');
      expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'nested', 'cron')).mode & 0o777).toBe(0o700);
      expect(readFileSync(path, 'utf-8')).toBe('content\n');
      expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('install writes the script at <dir>/<owner>__<project>.sh with the built content', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ execute: true }), deps);
    expect([...rec.scripts.keys()]).toEqual([SCRIPT]);
    const script = rec.scripts.get(SCRIPT)!;
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(`PATH='${INSTALL_PATH}'; export PATH\n`);
    expect(script).toContain('GH_TOKEN=$(');
    expect(script).toContain(`exec ${INVOKE} --dir '/ws' --execute\n`);
  });

  it('--print shows the line and the full script, writes nothing', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ print: true }), deps);
    expect(rec.writes).toHaveLength(0);
    expect(rec.scripts.size).toBe(0);
    const out = rec.logs.join('\n');
    expect(out).toContain(`/bin/sh '${SCRIPT}'`);
    expect(out).toContain('#!/bin/sh');
    expect(out).toContain('GH_TOKEN=$(');
    expect(out).toContain(`exec ${INVOKE}`);
  });

  it('a declined confirmation writes no script', async () => {
    const { deps, rec } = fakeDeps({ confirm: async () => false });
    await runFleetInstallCron(baseOpts({ yes: false }), deps);
    expect(rec.scripts.size).toBe(0);
  });
});

describe('installing PATH', () => {
  it('install bakes the installing PATH into the written line', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts(), deps);
    expect(scriptOf(rec)).toContain(`PATH='${INSTALL_PATH}'; export PATH\n`);
  });

  it('--print shows the PATH', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ print: true }), deps);
    expect(rec.logs.join('\n')).toContain(`PATH='${INSTALL_PATH}'; export PATH`);
  });

  it('an empty PATH → exit 2, no write', async () => {
    for (const empty of ['', '  ', null]) {
      const { deps, rec } = fakeDeps({ installPath: () => empty });
      expect(await runFleetInstallCron(baseOpts(), deps)).toBe(2);
      expect(rec.writes).toHaveLength(0);
    }
  });

  it('--uninstall needs no PATH', async () => {
    const { deps, rec } = fakeDeps({
      installPath: () => null,
      readCrontab: () => `*/10 * * * * x ${MARKER}`,
    });
    expect(await runFleetInstallCron(baseOpts({ uninstall: true }), deps)).toBe(0);
    expect(rec.writes).toHaveLength(1);
  });
});

describe('crontab compute helpers', () => {
  it('stripMarkerLines drops the marker line + blanks, keeps the rest', () => {
    const existing = ['@daily /usr/bin/backup', '', `*/5 * * * * old ${MARKER}`, '0 3 * * * cleanup'].join('\n');
    expect(stripMarkerLines(existing, MARKER, WS)).toEqual([
      '@daily /usr/bin/backup',
      '0 3 * * * cleanup',
    ]);
  });

  it('computeInstalledCrontab is idempotent — replaces a prior marker line', () => {
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * PRIOR ${MARKER}`].join('\n');
    const newLine = `${DEFAULT_SCHEDULE} NEW ${MARKER}`;
    const out = computeInstalledCrontab(existing, newLine, MARKER, WS);
    // Exactly one macf-watchdog line, and it's the new one.
    expect(out.split('\n').filter((l) => l.includes(MARKER))).toEqual([newLine]);
    expect(out).toContain('@daily /usr/bin/backup');
    expect(out).not.toContain('PRIOR');
  });

  it('computeUninstalledCrontab removes only the marker line', () => {
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * x ${MARKER}`].join('\n');
    const out = computeUninstalledCrontab(existing, MARKER, WS);
    expect(out).toBe('@daily /usr/bin/backup\n');
  });

  it('computeUninstalledCrontab yields empty string when nothing else remains', () => {
    const existing = `*/10 * * * * x ${MARKER}`;
    expect(computeUninstalledCrontab(existing, MARKER, WS)).toBe('');
  });
});

describe('runFleetInstallCron — install', () => {
  it('installs a report-only line by default (no --execute) with --yes', async () => {
    const { deps, rec } = fakeDeps();
    const code = await runFleetInstallCron(baseOpts(), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(1);
    const written = rec.writes[0]!;
    expect(written).toContain(MARKER);
    expect(scriptOf(rec)).toContain(INVOKE);
    expect(scriptOf(rec)).not.toContain('--execute');
    // token-mint baked (full creds available)
    expect(scriptOf(rec)).toContain('GH_TOKEN=$(');
  });

  it('--execute installs an acting line', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ execute: true }), deps);
    expect(scriptOf(rec)).toContain('--execute');
  });

  it('is idempotent — re-run over an existing marker line replaces, not duplicates', async () => {
    const existing = `*/10 * * * * OLD ${MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => existing });
    await runFleetInstallCron(baseOpts(), deps);
    const written = rec.writes[0]!;
    expect(written.split('\n').filter((l) => l.includes(MARKER))).toHaveLength(1);
    expect(written).not.toContain('OLD');
  });

  it('declined confirmation → no write', async () => {
    const { deps, rec } = fakeDeps({ confirm: async () => false });
    const code = await runFleetInstallCron(baseOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(0);
    expect(rec.logs.join('\n')).toMatch(/Aborted/);
  });

  it('--print previews the line without touching the crontab', async () => {
    const { deps, rec } = fakeDeps();
    const code = await runFleetInstallCron(baseOpts({ print: true }), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(0);
    expect(rec.logs.some((l) => l.includes(MARKER))).toBe(true);
  });

  it('warns + bakes no token when creds are missing', async () => {
    const { deps, rec } = fakeDeps({ readAppCreds: () => ({ appId: '1' }) });
    await runFleetInstallCron(baseOpts(), deps);
    expect(rec.warns.join('\n')).toMatch(/APP_ID\/INSTALL_ID\/KEY_PATH/);
    expect(scriptOf(rec)).not.toContain('GH_TOKEN=$(');
  });

  it('--no-token bakes no token prefix, no warning', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ noToken: true }), deps);
    expect(scriptOf(rec)).not.toContain('GH_TOKEN=$(');
    expect(rec.warns).toHaveLength(0);
  });

  it('crontab unavailable → exit 2, no write', async () => {
    const { deps, rec } = fakeDeps({ crontabAvailable: () => false });
    const code = await runFleetInstallCron(baseOpts(), deps);
    expect(code).toBe(2);
    expect(rec.writes).toHaveLength(0);
  });
});

describe('runFleetInstallCron — uninstall', () => {
  it('removes only the macf-watchdog line, preserves the rest', async () => {
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * x ${MARKER}`].join('\n');
    const { deps, rec } = fakeDeps({ readCrontab: () => existing });
    const code = await runFleetInstallCron(baseOpts({ uninstall: true }), deps);
    expect(code).toBe(0);
    expect(rec.writes[0]!).toBe('@daily /usr/bin/backup\n');
  });

  it('no marker present → no write, reports nothing to remove', async () => {
    const { deps, rec } = fakeDeps({ readCrontab: () => '@daily /usr/bin/backup' });
    const code = await runFleetInstallCron(baseOpts({ uninstall: true }), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(0);
    expect(rec.logs.join('\n')).toMatch(/nothing to remove/i);
  });

  it('removes this fleet script and leaves another fleet script alone', async () => {
    const other = `${SCRIPT_DIR}/acme__other.sh`;
    const { deps, rec } = fakeDeps({ readCrontab: () => `*/10 * * * * x ${MARKER}` });
    rec.scripts.set(SCRIPT, 'mine');
    rec.scripts.set(other, 'theirs');
    expect(await runFleetInstallCron(baseOpts({ uninstall: true }), deps)).toBe(0);
    expect([...rec.scripts.keys()]).toEqual([other]);
  });

  it('with no line left, still removes a leftover script of this fleet; --print removes nothing', async () => {
    const a = fakeDeps({ readCrontab: () => '@daily y' });
    a.rec.scripts.set(SCRIPT, 'mine');
    await runFleetInstallCron(baseOpts({ uninstall: true, print: true }), a.deps);
    expect(a.rec.scripts.size).toBe(1);
    await runFleetInstallCron(baseOpts({ uninstall: true }), a.deps);
    expect(a.rec.scripts.size).toBe(0);
  });

  it('declined uninstall confirmation → no write, script kept', async () => {
    const existing = `*/10 * * * * x ${MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => existing, confirm: async () => false });
    rec.scripts.set(SCRIPT, 'mine');
    const code = await runFleetInstallCron(baseOpts({ uninstall: true, yes: false }), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(0);
    expect(rec.scripts.size).toBe(1);
  });
});

describe('absolute macf path', () => {
  const fix = `npm install -g @groundnuty/macf@${CLI_VER}`;

  it('the installed line contains the resolved absolute path, not a bare macf', async () => {
    const { deps, rec } = fakeDeps({ resolveMacf: () => '/home/u/.npm-global/bin/macf' });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(0);
    expect(scriptOf(rec)).toContain("exec '/home/u/.npm-global/bin/macf' fleet reconcile");
    expect(scriptOf(rec)).not.toMatch(/[; ]macf fleet reconcile/);
  });

  it('no macf on PATH → exit 2 with the install command, no write', async () => {
    const { deps, rec } = fakeDeps({ resolveMacf: () => null });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(2);
    expect(rec.writes).toHaveLength(0);
    expect(rec.warns.join('\n')).toContain(fix);
  });

  it('version mismatch → exit 2 naming both versions and the install command', async () => {
    const { deps, rec } = fakeDeps({ macfVersion: () => '0.9.0' });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(2);
    expect(rec.writes).toHaveLength(0);
    const w = rec.warns.join('\n');
    expect(w).toContain('0.9.0');
    expect(w).toContain(CLI_VER);
    expect(w).toContain(fix);
  });

  it('an unreadable --version is a refusal too', () => {
    const r = checkMacfBinary(CLI_VER, { resolveMacf: () => MACF_BIN, macfVersion: () => null });
    expect(r.ok).toBe(false);
  });

  it('--print applies the same checks, and prints the resolved line when good', async () => {
    const bad = fakeDeps({ resolveMacf: () => null });
    expect(await runFleetInstallCron(baseOpts({ print: true }), bad.deps)).toBe(2);
    expect(bad.rec.logs).toHaveLength(0);
    const mismatch = fakeDeps({ macfVersion: () => '0.9.0' });
    expect(await runFleetInstallCron(baseOpts({ print: true }), mismatch.deps)).toBe(2);
    const good = fakeDeps();
    expect(await runFleetInstallCron(baseOpts({ print: true }), good.deps)).toBe(0);
    expect(good.rec.logs.join('\n')).toContain(INVOKE);
  });

  it('--uninstall needs no macf binary', async () => {
    const { deps, rec } = fakeDeps({
      resolveMacf: () => null,
      readCrontab: () => `*/10 * * * * x ${MARKER}\n@daily y`,
    });
    expect(await runFleetInstallCron(baseOpts({ uninstall: true }), deps)).toBe(0);
    expect(rec.writes[0]!).toBe('@daily y\n');
  });
});

describe('per-project marker', () => {
  const A = watchdogMarker('acme', 'A');
  const lineB = `*/10 * * * * run-b ${watchdogMarker('acme', 'B')}`;
  const legacyOther = `*/10 * * * * cd /other/ws && reconcile.sh ${WATCHDOG_MARKER}`;
  const legacyMine = `*/10 * * * * '${WS}/.claude/scripts/macf-gh-token.sh' x ${WATCHDOG_MARKER}`;
  const crontab = (...ls: string[]) => ls.join('\n');
  const optsA = (over: Partial<RunFleetInstallCronOptions> = {}) => baseOpts({ project: 'A', ...over });

  it('marker is bracketed per project', () => {
    expect(A).toBe(`${WATCHDOG_MARKER} [fleet=acme/A]`);
  });

  it('install for A keeps B line and an unrelated legacy line byte-identical, and notes the legacy one', async () => {
    const { deps, rec } = fakeDeps({ readCrontab: () => crontab('@daily x', lineB, legacyOther) });
    await runFleetInstallCron(optsA(), deps);
    const lines = rec.writes[0]!.split('\n');
    expect(lines).toContain(lineB);
    expect(lines).toContain(legacyOther);
    expect(lines.filter((l) => l.endsWith(A))).toHaveLength(1);
    expect(rec.warns.filter((w) => w.includes('does not belong to this fleet'))).toHaveLength(1);
    expect(rec.warns.join('\n')).toContain('/other/ws');
  });

  it('the notice cuts a long line to about 100 chars', async () => {
    const long = `*/10 * * * * ${'x'.repeat(300)} ${WATCHDOG_MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => long });
    await runFleetInstallCron(optsA(), deps);
    const note = rec.warns.find((w) => w.includes('does not belong'))!;
    expect(note.length).toBeLessThan(220);
    expect(note).not.toContain('x'.repeat(150));
  });

  it('re-install for A replaces A line: exactly one', async () => {
    const first = fakeDeps();
    await runFleetInstallCron(optsA(), first.deps);
    const second = fakeDeps({ readCrontab: () => first.rec.writes[0]! });
    await runFleetInstallCron(optsA({ schedule: '*/5 * * * *' }), second.deps);
    const mine = second.rec.writes[0]!.split('\n').filter((l) => l.endsWith(A));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.startsWith('*/5 * * * * ')).toBe(true);
  });

  it('a legacy line containing A workspace path is replaced', async () => {
    const { deps, rec } = fakeDeps({ readCrontab: () => crontab(legacyMine, lineB) });
    await runFleetInstallCron(optsA(), deps);
    const out = rec.writes[0]!;
    expect(out).not.toContain(legacyMine);
    expect(out).toContain(lineB);
    expect(rec.warns.filter((w) => w.includes('does not belong'))).toHaveLength(0);
  });

  it('a workspace path that is a prefix of another does not claim its legacy line', () => {
    const other = `*/10 * * * * '${WS}-2/.claude/scripts/h.sh' ${WATCHDOG_MARKER}`;
    expect(stripMarkerLines(other, A, WS)).toEqual([other]);
  });

  it('--uninstall for A removes only A line', async () => {
    const lineA = `*/10 * * * * run-a ${A}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => crontab('@daily x', lineA, lineB, legacyOther) });
    await runFleetInstallCron(optsA({ uninstall: true }), deps);
    expect(rec.writes[0]!).toBe(crontab('@daily x', lineB, legacyOther) + '\n');
  });

  it('--uninstall with only foreign lines writes nothing', async () => {
    const { deps, rec } = fakeDeps({ readCrontab: () => crontab(lineB, legacyOther) });
    await runFleetInstallCron(optsA({ uninstall: true }), deps);
    expect(rec.writes).toHaveLength(0);
  });

  it('same project, different owners: A never touches the B line', async () => {
    const lineOther = `*/10 * * * * run ${watchdogMarker('ownerB', 'proj')}`;
    const mine = baseOpts({ owner: 'ownerA' });
    const inst = fakeDeps({ readCrontab: () => lineOther });
    await runFleetInstallCron(mine, inst.deps);
    expect(inst.rec.writes[0]!.split('\n')).toContain(lineOther);
    const un = fakeDeps({ readCrontab: () => lineOther });
    await runFleetInstallCron({ ...mine, uninstall: true }, un.deps);
    expect(un.rec.writes).toHaveLength(0);
  });

  it('legacy lines match at the path boundary', () => {
    const legacy = (dir: string) => `*/10 * * * * '${dir}/.claude/scripts/macf-gh-token.sh' x ${WATCHDOG_MARKER}`;
    expect(stripMarkerLines(legacy('/srv/fleet'), A, '/srv/fleet')).toEqual([]);
    for (const other of ['/srv/fleet/other', '/backup/srv/fleet']) {
      expect(stripMarkerLines(legacy(other), A, '/srv/fleet')).toEqual([legacy(other)]);
    }
  });

  it('a legacy --no-token line naming the workspace host-prelude is claimed and replaced', async () => {
    const prelude = `${WS}/.claude/.macf/host-prelude.sh`;
    const old = `*/10 * * * * [ -f ${prelude} ] && . ${prelude}; macf fleet reconcile ${WATCHDOG_MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => crontab(old, lineB) });
    await runFleetInstallCron(optsA(), deps);
    const out = rec.writes[0]!;
    expect(out).not.toContain(old);
    expect(out).toContain(lineB);
    expect(rec.warns.filter((w) => w.includes('does not belong'))).toHaveLength(0);
    const un = fakeDeps({ readCrontab: () => crontab(old) });
    await runFleetInstallCron(optsA({ uninstall: true }), un.deps);
    expect(un.rec.writes[0]!).toBe('');
  });

  it('a legacy line naming a different prelude path stays foreign', () => {
    const other = `*/10 * * * * [ -f '/backup${WS}/.claude/.macf/host-prelude.sh' ] && x ${WATCHDOG_MARKER}`;
    expect(stripMarkerLines(other, A, WS)).toEqual([other]);
  });

  it('project=foo does not touch project=foobar', async () => {
    const foobar = `*/10 * * * * run ${watchdogMarker('acme', 'foobar')}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => foobar });
    await runFleetInstallCron(baseOpts({ project: 'foo' }), deps);
    expect(rec.writes[0]!.split('\n')).toContain(foobar);
    const un = fakeDeps({ readCrontab: () => foobar });
    await runFleetInstallCron(baseOpts({ project: 'foo', uninstall: true }), un.deps);
    expect(un.rec.writes).toHaveLength(0);
  });
});

describe('runFleetInstallCronCommand — --dir vs ambient MACF_WORKSPACE_DIR (macf#1123)', () => {
  const ORIGINAL_ENV = process.env['MACF_WORKSPACE_DIR'];
  const ORIGINAL_PATH = process.env['PATH'];
  let stubDir = '';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A stub `macf` at this CLI's version, so the real deps resolve a matching binary.
    stubDir = mkdtempSync(join(tmpdir(), 'macf-stub-'));
    writeFileSync(join(stubDir, 'macf'), `#!/bin/sh\necho ${PACKAGE_VERSION}\n`, { mode: 0o755 });
    process.env['PATH'] = `${stubDir}:${ORIGINAL_PATH ?? ''}`;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.env['PATH'] = ORIGINAL_PATH;
    rmSync(stubDir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env['MACF_WORKSPACE_DIR'];
    else process.env['MACF_WORKSPACE_DIR'] = ORIGINAL_ENV;
  });

  /**
   * The decisive marker: `--print` echoes the generated cron line, which
   * embeds the resolved workspaceDir in its host-prelude path
   * (`<workspaceDir>/.claude/.macf/host-prelude.sh`, the default when
   * `--prelude` is not passed). `--no-token` skips the app-creds lookup
   * entirely, so this needs no real files on disk — the printed line is the
   * ONLY signal, and per assert-the-wrong-path.md it's the target the code
   * actually bound, not merely "the command returned 0" (a broken
   * implementation returns 0 here too, having printed the WRONG line).
   */
  it('THE REGRESSION: --dir <B> with MACF_WORKSPACE_DIR=<A> set prints a line scoped to B, not A', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    const code = await runFleetInstallCronCommand('/target-b', {
      print: true,
      token: false,
      dirExplicit: true,
    });
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('/target-b/.claude/.macf/host-prelude.sh');
    expect(printed).not.toContain('/caller-a');
  });

  it('the --dir vs env disagreement is REPORTED, not swallowed', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    await runFleetInstallCronCommand('/target-b', { print: true, token: false, dirExplicit: true });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('/caller-a'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('/target-b'));
  });

  it('no --dir: the ambient MACF_WORKSPACE_DIR default still applies (ordinary in-session case unbroken)', async () => {
    process.env['MACF_WORKSPACE_DIR'] = '/caller-a';
    const code = await runFleetInstallCronCommand('/auto-discovered', { print: true, token: false });
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('/caller-a/.claude/.macf/host-prelude.sh');
    expect(printed).not.toContain('/auto-discovered');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('no --dir, no env: falls back to the auto-discovered projectDir', async () => {
    delete process.env['MACF_WORKSPACE_DIR'];
    const code = await runFleetInstallCronCommand('/auto-discovered', { print: true, token: false });
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('/auto-discovered/.claude/.macf/host-prelude.sh');
  });

  it('no derivable owner → exit 2, no output line', async () => {
    configMock.readAgentConfig.mockReturnValueOnce({ project: 'proj', registry: { type: 'local' } });
    const code = await runFleetInstallCronCommand('/target-b', { print: true, token: false });
    expect(code).toBe(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('no project in macf-agent.json → exit 2, no output line', async () => {
    configMock.readAgentConfig.mockReturnValueOnce(null);
    const code = await runFleetInstallCronCommand('/target-b', { print: true, token: false });
    expect(code).toBe(2);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('refuses "%" in the crontab line', () => {
  it('a "%" in the log path → exit 2, names log, also with --print', async () => {
    for (const print of [false, true]) {
      const { deps, rec } = fakeDeps();
      const code = await runFleetInstallCron(baseOpts({ print, log: '/var/100%/w.log' }), deps);
      expect(code).toBe(2);
      expect(rec.writes).toHaveLength(0);
      expect(rec.scripts.size).toBe(0);
      expect(rec.warns.join('\n')).toContain('log contains "%"');
    }
  });

  it('a "%" in the script dir is refused, naming the script', async () => {
    const { deps, rec } = fakeDeps({ scriptDir: () => '/home/100%/.macf/cron' });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(2);
    expect(rec.warns.join('\n')).toContain('script contains "%"');
  });

  it('a "%" in PATH, workspace, manifest or prelude is harmless: it goes only into the script', async () => {
    const cases: ReadonlyArray<Partial<RunFleetInstallCronOptions>> = [
      { workspaceDir: '/w%s' }, { manifest: '/m%.yaml' }, { prelude: '/p%.sh' },
    ];
    for (const over of cases) {
      const { deps, rec } = fakeDeps();
      expect(await runFleetInstallCron(baseOpts(over), deps)).toBe(0);
      expect(rec.writes[0]!).not.toContain('%');
      expect(scriptOf(rec)).toContain('%');
    }
    const { deps, rec } = fakeDeps({ installPath: () => '/opt/a%b/bin:/usr/bin' });
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(0);
    expect(scriptOf(rec)).toContain("PATH='/opt/a%b/bin:/usr/bin'");
  });

  it('a clean line is unaffected', async () => {
    const { deps, rec } = fakeDeps();
    expect(await runFleetInstallCron(baseOpts(), deps)).toBe(0);
    expect(rec.writes).toHaveLength(1);
  });

  it('--uninstall still works with a "%" in PATH', async () => {
    const { deps, rec } = fakeDeps({
      installPath: () => '/opt/a%b/bin',
      readCrontab: () => `*/10 * * * * x ${MARKER}`,
    });
    expect(await runFleetInstallCron(baseOpts({ uninstall: true }), deps)).toBe(0);
    expect(rec.writes).toHaveLength(1);
  });
});

describe('readAppCreds + token prefix', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'cron-creds-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    configMock.readAgentConfig.mockImplementation(() => ({
      project: 'proj',
      registry: { type: 'org', org: 'acme' },
    }));
  });
  const prefixFor = (dir: string) =>
    buildTokenPrefix({
      noToken: false,
      workspaceDir: dir,
      creds: readAppCreds(dir),
      helperExists: () => true,
    });

  it('macf-agent.json github_app with no settings.local.json bakes a token, no warning', () => {
    configMock.readAgentConfig.mockImplementation(() => ({
      project: 'proj',
      registry: { type: 'org', org: 'acme' },
      github_app: { app_id: '777', install_id: '888', key_path: '.github-app-key.pem' },
    }));
    const { prefix, warning } = prefixFor(ws);
    expect(warning).toBeUndefined();
    expect(prefix).toContain('--app-id 777 --install-id 888');
    expect(prefix).toContain(`'${join(ws, '.github-app-key.pem')}'`);
  });

  it('settings.local.json alone still works', () => {
    configMock.readAgentConfig.mockImplementation(() => null);
    mkdirSync(join(ws, '.claude'), { recursive: true });
    writeFileSync(
      join(ws, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { APP_ID: '11', INSTALL_ID: '22', KEY_PATH: '/k/key.pem' } }),
    );
    const { prefix, warning } = prefixFor(ws);
    expect(warning).toBeUndefined();
    expect(prefix).toContain('--app-id 11 --install-id 22');
    expect(prefix).toContain("'/k/key.pem'");
  });

  it('neither source warns, naming both places', () => {
    configMock.readAgentConfig.mockImplementation(() => null);
    const { prefix, warning } = prefixFor(ws);
    expect(prefix).toBe('');
    expect(warning).toContain(join(ws, '.macf', 'macf-agent.json'));
    expect(warning).toContain(join(ws, '.claude', 'settings.local.json'));
  });
});
