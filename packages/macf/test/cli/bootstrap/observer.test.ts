/**
 * Tests for `readFleetLock` — the one pure(-ish), no-network piece of the
 * `observer.ts` I/O leaf (DR-043 Slice 1a, groundnuty/macf#838). The `gh`-
 * shelling functions (`checkRepoExists` / `readRepoVariable` /
 * `githubRegistryObserver`) are NOT unit-tested here — same posture as
 * `fleet-doctor-inject.ts`'s network fns (see that file's test-file doc
 * comment): they are thin `execFile('gh', ...)` wrappers, exercised through
 * `computePlan`'s injected-fake orchestration in `plan.test.ts` /
 * `bootstrap.test.ts`, not re-mocked here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetLock } from '../../../src/cli/bootstrap/observer.js';

describe('readFleetLock', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'macf-bootstrap-observer-test-'));
    dirs.push(d);
    return d;
  }

  it('returns null when fleet.lock is absent next to the manifest (the common not-yet-provisioned case)', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    expect(readFleetLock(manifestPath)).toBeNull();
  });

  it('parses a valid co-located fleet.lock', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(
      join(dir, 'fleet.lock'),
      'schema_version: 1\nfleet: icsoc-2026\nagents:\n  - role: code-agent\n    app_id: "1"\n    install_id: "2"\n',
    );
    const lock = readFleetLock(manifestPath);
    expect(lock?.fleet).toBe('icsoc-2026');
    expect(lock?.agents).toHaveLength(1);
  });

  it('returns null (never throws) on a malformed fleet.lock', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(join(dir, 'fleet.lock'), 'schema_version: 999\nfleet: bad\nagents: []\n');
    expect(readFleetLock(manifestPath)).toBeNull();
  });

  it('resolves fleet.lock relative to the manifest\'s DIRECTORY, not cwd', () => {
    const dir = tempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested, { recursive: true });
    const manifestPath = join(nested, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(
      join(nested, 'fleet.lock'),
      'schema_version: 1\nfleet: nested-fleet\nagents: []\n',
    );
    // A fleet.lock at the temp root (NOT next to the manifest) must be ignored.
    writeFileSync(join(dir, 'fleet.lock'), 'schema_version: 1\nfleet: wrong-one\nagents: []\n');
    expect(readFleetLock(manifestPath)?.fleet).toBe('nested-fleet');
  });
});
