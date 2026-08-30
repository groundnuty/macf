/**
 * Tests for `macf doctor`'s disk-space check (groundnuty/macf#1365 — a full
 * disk on this VM read as `227 failed` vitest test files and a broken
 * devbox `nix profile` install, with nothing anywhere naming the disk as
 * the cause; the reader who greps for `Tests` reads a regression that
 * never happened).
 *
 * `checkDiskSpace` is exercised directly via its injectable `readStats`/
 * `tmpDir` options for the decisive pair (below-threshold vs. ample),
 * the honest-unknown case, and the never-deletes assertion — no disk is
 * actually filled or read from real low-space state to get there.
 *
 * The final describe block drives it through the REAL `runDoctor`
 * entrypoint and reads the RENDERED console output (not a helper's return
 * value) — mocking only `node:fs`'s `statfsSync` (passthrough to the real
 * implementation via `importOriginal`, same pattern as
 * macf-channel-server's collision.test.ts) so every other doctor section
 * still reads real on-disk state and the `#1364` early-return trap
 * (`readAgentConfig` finding no `macf-agent.json`) is exercised for real.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Passthrough by default (real statfsSync) — individual rendered-output
    // tests override with a deterministic implementation so they don't
    // depend on this VM's actual free space.
    statfsSync: vi.fn(actual.statfsSync),
  };
});

const fs = await import('node:fs');
const {
  checkDiskSpace,
  runDoctor,
  DISK_SPACE_FAIL_BYTES,
  DISK_SPACE_WARN_BYTES,
} = await import('../../src/cli/commands/doctor.js');
const { writeAgentConfig } = await import('../../src/cli/config.js');
const { installSandboxFdAllowRead } = await import('../../src/cli/settings-writer.js');
import type { MacfAgentConfig } from '../../src/cli/config.js';

function localConfig(): MacfAgentConfig {
  return {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'local', path: '/tmp/macf-test-registry-disk.json' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

/** A statfsSync-shaped result whose `bavail * bsize` equals `availableBytes` exactly (bsize=1). */
function statfsResult(availableBytes: number) {
  return {
    type: 0,
    bsize: 1,
    blocks: 0,
    bfree: availableBytes,
    bavail: availableBytes,
    files: 0,
    ffree: 0,
  };
}

describe('checkDiskSpace (groundnuty/macf#1365)', () => {
  const AMPLE = DISK_SPACE_WARN_BYTES * 10;
  const BELOW_FAIL = Math.floor(DISK_SPACE_FAIL_BYTES / 2);
  const BETWEEN_WARN_AND_FAIL = DISK_SPACE_FAIL_BYTES + Math.floor((DISK_SPACE_WARN_BYTES - DISK_SPACE_FAIL_BYTES) / 2);

  it('FAIL: a target below the FAIL floor is reported FAIL, naming the ENOSPC consequence', () => {
    const result = checkDiskSpace('/some/workspace', {
      tmpDir: '/some/tmp',
      readStats: () => BELOW_FAIL,
    });
    expect(result.status).toBe('FAIL');
    const workspaceFinding = result.targets.find((t) => t.label === 'workspace')!;
    expect(workspaceFinding.status).toBe('FAIL');
    expect(workspaceFinding.detail).toMatch(/ENOSPC/);
    // #1361's lesson: name the CONSEQUENCE, not just the number — say what
    // the reader will otherwise misdiagnose (unrelated test/build failures).
    expect(workspaceFinding.detail).toMatch(/unrelated failures/);
  });

  it('WARN: a target between the WARN and FAIL floors is reported WARN, naming the consequence', () => {
    const result = checkDiskSpace('/ws', {
      tmpDir: '/tmp-target',
      readStats: () => BETWEEN_WARN_AND_FAIL,
    });
    expect(result.status).toBe('WARN');
    for (const t of result.targets) {
      expect(t.status).toBe('WARN');
      expect(t.detail).toMatch(/ENOSPC/);
    }
  });

  it('PASS: both targets ample — no WARN/FAIL/ENOSPC noise (decisive pair #2)', () => {
    const result = checkDiskSpace('/ws', {
      tmpDir: '/tmp-target',
      readStats: () => AMPLE,
    });
    expect(result.status).toBe('PASS');
    expect(result.detail).not.toMatch(/ENOSPC/);
    expect(result.detail).not.toMatch(/WARN|FAIL/);
    for (const t of result.targets) {
      expect(t.status).toBe('PASS');
      expect(t.detail).not.toMatch(/ENOSPC/);
    }
  });

  it('UNKNOWN: free space undeterminable is reported unknown — NEVER "ok"/PASS', () => {
    const result = checkDiskSpace('/ws', {
      tmpDir: '/tmp-target',
      readStats: () => {
        throw new Error('statfs not supported on this platform');
      },
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    for (const t of result.targets) {
      expect(t.status).toBe('UNKNOWN');
      expect(t.availableBytes).toBeNull();
    }
  });

  it('a FAIL target and an UNKNOWN target aggregate to FAIL (a definite bad reading beats an undeterminable one)', () => {
    const workspacePath = resolve('/ws');
    const result = checkDiskSpace('/ws', {
      tmpDir: '/tmp-target',
      readStats: (path: string) => {
        if (path === workspacePath) return BELOW_FAIL;
        throw new Error('boom');
      },
    });
    expect(result.status).toBe('FAIL');
    const tmpFinding = result.targets.find((t) => t.label === 'tmp')!;
    expect(tmpFinding.status).toBe('UNKNOWN');
  });

  it('reports BOTH the filesystem holding the workspace AND tmp — not just one', () => {
    const result = checkDiskSpace('/ws', { tmpDir: '/tmp-target', readStats: () => AMPLE });
    expect(result.targets.map((t) => t.label).sort()).toEqual(['tmp', 'workspace']);
  });

  it('defaults tmpDir to os.tmpdir() (honors $TMPDIR) when not overridden', () => {
    const result = checkDiskSpace('/ws', { readStats: () => AMPLE });
    const tmpFinding = result.targets.find((t) => t.label === 'tmp')!;
    expect(tmpFinding.path).toBe(tmpdir());
  });

  it('mutation guard: an implementation that always reports ample would pass test 1 (FAIL case) trivially wrong — assert the WARN/FAIL case actually discriminates on the input', () => {
    // A broken "always PASS" implementation would still satisfy a test that
    // only checks the ample case (decisive-pair AC: "(1) alone is satisfied
    // by always warning" — the same trap in the other direction). Assert
    // BOTH branches actually respond to the input, not just log a status.
    const low = checkDiskSpace('/ws', { tmpDir: '/tmp-target', readStats: () => BELOW_FAIL });
    const ample = checkDiskSpace('/ws', { tmpDir: '/tmp-target', readStats: () => AMPLE });
    expect(low.status).not.toBe(ample.status);
    expect(low.status).toBe('FAIL');
    expect(ample.status).toBe('PASS');
  });

  describe('never deletes anything (groundnuty/macf#1365 — reporting only)', () => {
    let realTmpRoot: string;

    beforeEach(() => {
      realTmpRoot = mkdtempSync(join(tmpdir(), 'doctor-disk-space-'));
    });

    afterEach(() => {
      rmSync(realTmpRoot, { recursive: true, force: true });
    });

    it('the shipped implementation (real statfsSync, no injected fake) never calls rm/unlink/rmdir', () => {
      const rmSpy = vi.spyOn(fs, 'rmSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const rmdirSpy = vi.spyOn(fs, 'rmdirSync');
      const rmPromiseSpy = vi.spyOn(fs.promises, 'rm');
      const unlinkPromiseSpy = vi.spyOn(fs.promises, 'unlink');
      const rmdirPromiseSpy = vi.spyOn(fs.promises, 'rmdir');

      // Real invocation — no readStats override, exercises the actual
      // statfsSync path against a real directory.
      const result = checkDiskSpace(realTmpRoot);
      expect(result.status).not.toBe(undefined); // sanity: the call completed

      expect(rmSpy).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmdirSpy).not.toHaveBeenCalled();
      expect(rmPromiseSpy).not.toHaveBeenCalled();
      expect(unlinkPromiseSpy).not.toHaveBeenCalled();
      expect(rmdirPromiseSpy).not.toHaveBeenCalled();

      rmSpy.mockRestore();
      unlinkSpy.mockRestore();
      rmdirSpy.mockRestore();
      rmPromiseSpy.mockRestore();
      unlinkPromiseSpy.mockRestore();
      rmdirPromiseSpy.mockRestore();
    });
  });
});

describe('runDoctor — Disk space section (rendered output, groundnuty/macf#1365)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const AMPLE = DISK_SPACE_WARN_BYTES * 10;
  const BELOW_FAIL = Math.floor(DISK_SPACE_FAIL_BYTES / 2);

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-disk-space-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.mocked(fs.statfsSync).mockReset();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('names the low-space target as FAIL in the rendered report, with the ENOSPC consequence (decisive pair #1)', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    vi.mocked(fs.statfsSync).mockReturnValue(statfsResult(BELOW_FAIL) as ReturnType<typeof fs.statfsSync>);

    await runDoctor(tmpRoot);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Disk space');
    expect(out).toMatch(/\[FAIL\]/);
    expect(out).toMatch(/ENOSPC/);
    expect(out).toMatch(/unrelated failures/);
  });

  it('reports ample space with NO WARN/FAIL/ENOSPC noise (decisive pair #2)', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    vi.mocked(fs.statfsSync).mockReturnValue(statfsResult(AMPLE) as ReturnType<typeof fs.statfsSync>);

    await runDoctor(tmpRoot);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Disk space');
    expect(out).toMatch(/\[PASS\]/);
    // The decisive negative assertion — an implementation that always warns
    // would fail exactly this line.
    const diskSection = out.slice(out.indexOf('Disk space'));
    expect(diskSection).not.toMatch(/\[WARN\]/);
    expect(diskSection.split('\n').slice(0, 6).join('\n')).not.toMatch(/ENOSPC/);
  });

  it('honest-unknown: statfs failure renders [UNKNOWN], never [PASS]/"ok"', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    vi.mocked(fs.statfsSync).mockImplementation(() => {
      throw new Error('EPERM: statfs not permitted');
    });

    await runDoctor(tmpRoot);

    const out = logSpy.mock.calls.flat().join('\n');
    const diskSection = out.slice(out.indexOf('Disk space'), out.indexOf('Disk space') + 400);
    expect(diskSection).toMatch(/\[UNKNOWN\]/);
    expect(diskSection).not.toMatch(/\[PASS\]/);
  });

  /**
   * groundnuty/macf#1364's trap, applied to this new section: `runDoctor`
   * returns 1 immediately when no `macf-agent.json` is found, and a check
   * that only prints AFTER that point is unreachable for exactly the
   * workspaces that most need diagnosing (an unmanaged workspace running
   * low on space has no macf-agent.json either). Deliberately NO
   * writeAgentConfig call here — this drives the check through the real
   * early-return path, not around it.
   */
  it('renders the Disk space section even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    vi.mocked(fs.statfsSync).mockReturnValue(statfsResult(AMPLE) as ReturnType<typeof fs.statfsSync>);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to disk space

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Disk space');
    // Scoped to the Disk space section specifically (it's the last section
    // printed on the early-return path) — not just "a [PASS] appears
    // somewhere in the report."
    const diskSection = out.slice(out.indexOf('Disk space'));
    expect(diskSection).toMatch(/\[PASS\]/);
  });
});
