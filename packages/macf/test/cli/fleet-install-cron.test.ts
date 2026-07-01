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
 */
import { describe, it, expect } from 'vitest';
import {
  buildReconcileFlags,
  buildTokenPrefix,
  buildCronLine,
  stripMarkerLines,
  computeInstalledCrontab,
  computeUninstalledCrontab,
  runFleetInstallCron,
  WATCHDOG_MARKER,
  DEFAULT_SCHEDULE,
  RECONCILE_INVOCATION,
  type FleetInstallCronDeps,
  type RunFleetInstallCronOptions,
  type AppCreds,
} from '../../src/cli/commands/fleet-install-cron.js';

const WS = '/ws';
const FULL_CREDS: AppCreds = { appId: '123', installId: '456', keyPath: '.github-app-key.pem' };

interface Recorder {
  readonly writes: string[];
  readonly logs: string[];
  readonly warns: string[];
}

/** A fake deps set recording crontab writes + log/warn output. */
function fakeDeps(overrides: Partial<FleetInstallCronDeps> = {}): {
  deps: FleetInstallCronDeps;
  rec: Recorder;
} {
  const rec: Recorder = { writes: [], logs: [], warns: [] };
  const deps: FleetInstallCronDeps = {
    readCrontab: () => null,
    writeCrontab: (content: string) => {
      rec.writes.push(content);
    },
    crontabAvailable: () => true,
    readAppCreds: () => FULL_CREDS,
    helperExists: () => true,
    confirm: async () => true,
    log: (msg: string) => rec.logs.push(msg),
    warn: (msg: string) => rec.warns.push(msg),
    ...overrides,
  };
  return { deps, rec };
}

function baseOpts(over: Partial<RunFleetInstallCronOptions> = {}): RunFleetInstallCronOptions {
  return {
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
    const flags = buildReconcileFlags({ execute: false, allowRestart: false, withRouting: false });
    expect(flags).not.toContain('--execute');
    expect(flags).toEqual([]);
  });

  it('--execute adds the flag', () => {
    const flags = buildReconcileFlags({ execute: true, allowRestart: false, withRouting: false });
    expect(flags).toContain('--execute');
  });

  it('forwards manifest, routing, and allow-restart in reference order', () => {
    const flags = buildReconcileFlags({
      manifest: '/etc/desired.yaml',
      withRouting: true,
      execute: true,
      allowRestart: true,
    });
    expect(flags).toEqual([
      '--manifest',
      '/etc/desired.yaml',
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
    expect(prefix).toContain('/ws/.claude/scripts/macf-gh-token.sh');
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
    expect(prefix).toContain('--key /ws/.github-app-key.pem');
  });

  it('preserves an already-absolute key path', () => {
    const { prefix } = buildTokenPrefix({
      noToken: false,
      workspaceDir: WS,
      creds: { appId: '1', installId: '2', keyPath: '/etc/macf/key.pem' },
      helperExists: () => true,
    });
    expect(prefix).toContain('--key /etc/macf/key.pem');
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
    preludePath: '/ws/.claude/.macf/host-prelude.sh',
    tokenPrefix: 'GH_TOKEN=$(x) || exit 1; export GH_TOKEN; ',
    reconcileFlags: [] as readonly string[],
    logPath: '/home/agent/.macf/watchdog.log',
    marker: WATCHDOG_MARKER,
  };

  it('assembles schedule + prelude + token + reconcile + log + marker', () => {
    const line = buildCronLine(parts);
    expect(line.startsWith(`${DEFAULT_SCHEDULE} `)).toBe(true);
    expect(line).toContain('[ -f /ws/.claude/.macf/host-prelude.sh ] && . /ws/.claude/.macf/host-prelude.sh;');
    expect(line).toContain('GH_TOKEN=$(x) || exit 1; export GH_TOKEN;');
    expect(line).toContain(RECONCILE_INVOCATION);
    expect(line).toContain('>> /home/agent/.macf/watchdog.log 2>&1');
    expect(line.endsWith(WATCHDOG_MARKER)).toBe(true);
  });

  it('report-only line carries no --execute', () => {
    const line = buildCronLine(parts);
    expect(line).not.toContain('--execute');
  });

  it('execute line carries --execute right after the invocation', () => {
    const line = buildCronLine({ ...parts, reconcileFlags: ['--execute'] });
    expect(line).toContain(`${RECONCILE_INVOCATION} --execute >> `);
  });
});

describe('crontab compute helpers', () => {
  it('stripMarkerLines drops the marker line + blanks, keeps the rest', () => {
    const existing = ['@daily /usr/bin/backup', '', `*/5 * * * * old ${WATCHDOG_MARKER}`, '0 3 * * * cleanup'].join('\n');
    expect(stripMarkerLines(existing, WATCHDOG_MARKER)).toEqual([
      '@daily /usr/bin/backup',
      '0 3 * * * cleanup',
    ]);
  });

  it('computeInstalledCrontab is idempotent — replaces a prior marker line', () => {
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * PRIOR ${WATCHDOG_MARKER}`].join('\n');
    const newLine = `${DEFAULT_SCHEDULE} NEW ${WATCHDOG_MARKER}`;
    const out = computeInstalledCrontab(existing, newLine, WATCHDOG_MARKER);
    // Exactly one macf-watchdog line, and it's the new one.
    expect(out.split('\n').filter((l) => l.includes(WATCHDOG_MARKER))).toEqual([newLine]);
    expect(out).toContain('@daily /usr/bin/backup');
    expect(out).not.toContain('PRIOR');
  });

  it('computeUninstalledCrontab removes only the marker line', () => {
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * x ${WATCHDOG_MARKER}`].join('\n');
    const out = computeUninstalledCrontab(existing, WATCHDOG_MARKER);
    expect(out).toBe('@daily /usr/bin/backup\n');
  });

  it('computeUninstalledCrontab yields empty string when nothing else remains', () => {
    const existing = `*/10 * * * * x ${WATCHDOG_MARKER}`;
    expect(computeUninstalledCrontab(existing, WATCHDOG_MARKER)).toBe('');
  });
});

describe('runFleetInstallCron — install', () => {
  it('installs a report-only line by default (no --execute) with --yes', async () => {
    const { deps, rec } = fakeDeps();
    const code = await runFleetInstallCron(baseOpts(), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(1);
    const written = rec.writes[0]!;
    expect(written).toContain(WATCHDOG_MARKER);
    expect(written).toContain(RECONCILE_INVOCATION);
    expect(written).not.toContain('--execute');
    // token-mint baked (full creds available)
    expect(written).toContain('GH_TOKEN=$(');
  });

  it('--execute installs an acting line', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ execute: true }), deps);
    expect(rec.writes[0]!).toContain('--execute');
  });

  it('is idempotent — re-run over an existing marker line replaces, not duplicates', async () => {
    const existing = `*/10 * * * * OLD ${WATCHDOG_MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => existing });
    await runFleetInstallCron(baseOpts(), deps);
    const written = rec.writes[0]!;
    expect(written.split('\n').filter((l) => l.includes(WATCHDOG_MARKER))).toHaveLength(1);
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
    expect(rec.logs.some((l) => l.includes(WATCHDOG_MARKER))).toBe(true);
  });

  it('warns + bakes no token when creds are missing', async () => {
    const { deps, rec } = fakeDeps({ readAppCreds: () => ({ appId: '1' }) });
    await runFleetInstallCron(baseOpts(), deps);
    expect(rec.warns.join('\n')).toMatch(/APP_ID\/INSTALL_ID\/KEY_PATH/);
    expect(rec.writes[0]!).not.toContain('GH_TOKEN=$(');
  });

  it('--no-token bakes no token prefix, no warning', async () => {
    const { deps, rec } = fakeDeps();
    await runFleetInstallCron(baseOpts({ noToken: true }), deps);
    expect(rec.writes[0]!).not.toContain('GH_TOKEN=$(');
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
    const existing = ['@daily /usr/bin/backup', `*/10 * * * * x ${WATCHDOG_MARKER}`].join('\n');
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

  it('declined uninstall confirmation → no write', async () => {
    const existing = `*/10 * * * * x ${WATCHDOG_MARKER}`;
    const { deps, rec } = fakeDeps({ readCrontab: () => existing, confirm: async () => false });
    const code = await runFleetInstallCron(baseOpts({ uninstall: true, yes: false }), deps);
    expect(code).toBe(0);
    expect(rec.writes).toHaveLength(0);
  });
});
