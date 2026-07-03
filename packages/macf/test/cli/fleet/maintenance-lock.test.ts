/**
 * Tests for the maintenance-lock SET-side (DR-040 Decision 4, macf#752) — the
 * TypeScript VM-file driver that interops with the bash reference
 * (`groundnuty/macf-devops-toolkit#158`/`#159`, `fleet/maintenance-lock.sh`).
 * Covers: pure serialize/parse/computeActive logic, env-symmetry with the
 * bash contract's defaults, real-fs atomic acquire/heartbeat/release against
 * a tmp dir, the background heartbeat loop's dead-man's-switch, and a
 * round-trip interop check against `jq` — the same tool the bash contract
 * itself uses to read/write the lock file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAINT_LOCK_HEARTBEAT_MAX_S,
  DEFAULT_MAINT_LOCK_TTL_SEC,
  acquireLock,
  computeActive,
  heartbeatLock,
  isLockActive,
  lockFilePath,
  parseLockEntry,
  readLockEntry,
  releaseLock,
  resolveMaintenanceLockConfig,
  serializeLockEntry,
  startHeartbeatLoop,
  type MaintenanceLockEntry,
} from '../../../src/cli/fleet/maintenance-lock.js';

// --- serialize / parse round-trip -------------------------------------------

describe('serializeLockEntry / parseLockEntry (round-trip)', () => {
  const entry: MaintenanceLockEntry = {
    schema_version: 1,
    agent: 'code-agent',
    target_version: '0.2.48',
    started_at: 1_751_500_000,
    heartbeat_at: 1_751_500_300,
  };

  it('round-trips a well-formed entry exactly', () => {
    const raw = serializeLockEntry(entry);
    expect(parseLockEntry(raw)).toEqual(entry);
  });

  it('rejects invalid JSON', () => {
    expect(parseLockEntry('not json')).toBeNull();
  });

  it('rejects a non-object (array / scalar) payload', () => {
    expect(parseLockEntry('[1,2,3]')).toBeNull();
    expect(parseLockEntry('"just a string"')).toBeNull();
    expect(parseLockEntry('42')).toBeNull();
    expect(parseLockEntry('null')).toBeNull();
  });

  it('rejects the wrong schema_version', () => {
    expect(parseLockEntry(JSON.stringify({ ...entry, schema_version: 2 }))).toBeNull();
    expect(parseLockEntry(JSON.stringify({ agent: 'x', target_version: '1', started_at: 1, heartbeat_at: 1 }))).toBeNull();
  });

  it('rejects a missing or empty agent', () => {
    expect(parseLockEntry(JSON.stringify({ ...entry, agent: '' }))).toBeNull();
    expect(
      parseLockEntry(JSON.stringify({ schema_version: 1, target_version: '0.2.48', started_at: 1, heartbeat_at: 1 })),
    ).toBeNull();
  });

  it('rejects a missing target_version', () => {
    expect(
      parseLockEntry(JSON.stringify({ schema_version: 1, agent: 'code-agent', started_at: 1, heartbeat_at: 1 })),
    ).toBeNull();
  });

  it('rejects non-numeric or missing started_at / heartbeat_at', () => {
    expect(parseLockEntry(JSON.stringify({ ...entry, started_at: 'not-a-number' }))).toBeNull();
    expect(parseLockEntry(JSON.stringify({ ...entry, heartbeat_at: null }))).toBeNull();
    expect(
      parseLockEntry(JSON.stringify({ schema_version: 1, agent: 'code-agent', target_version: '0.2.48', heartbeat_at: 1 })),
    ).toBeNull();
    expect(
      parseLockEntry(JSON.stringify({ schema_version: 1, agent: 'code-agent', target_version: '0.2.48', started_at: 1 })),
    ).toBeNull();
  });
});

// --- computeActive -----------------------------------------------------------

describe('computeActive', () => {
  const base: MaintenanceLockEntry = {
    schema_version: 1,
    agent: 'code-agent',
    target_version: '0.2.48',
    started_at: 1000,
    heartbeat_at: 1000,
  };

  it('is true when the heartbeat is within the TTL', () => {
    expect(computeActive(base, 1000 + 899, 900)).toBe(true);
  });

  it('is true exactly AT the TTL boundary (age === ttl)', () => {
    expect(computeActive(base, 1000 + 900, 900)).toBe(true);
  });

  it('is false once the heartbeat ages PAST the TTL', () => {
    expect(computeActive(base, 1000 + 901, 900)).toBe(false);
  });

  it('is false for a null (absent) entry', () => {
    expect(computeActive(null, 2000, 900)).toBe(false);
  });

  it('is false for a non-positive or non-finite heartbeat_at (defensive — fail toward resume)', () => {
    expect(computeActive({ ...base, heartbeat_at: 0 }, 100, 900)).toBe(false);
    expect(computeActive({ ...base, heartbeat_at: -5 }, 100, 900)).toBe(false);
    expect(computeActive({ ...base, heartbeat_at: Number.NaN }, 100, 900)).toBe(false);
  });
});

// --- resolveMaintenanceLockConfig (env symmetry with the bash contract) ----

describe('resolveMaintenanceLockConfig (env symmetry with the bash contract)', () => {
  it('defaults exactly match macf-devops-toolkit#158: dir=$HOME/.macf/maintenance-locks, ttl=900, heartbeatInterval=300, heartbeatMaxS=3600', () => {
    const cfg = resolveMaintenanceLockConfig({});
    expect(cfg.dir).toBe(join(homedir(), '.macf', 'maintenance-locks'));
    expect(cfg.ttlSec).toBe(900);
    expect(cfg.ttlSec).toBe(DEFAULT_MAINT_LOCK_TTL_SEC);
    expect(cfg.heartbeatIntervalSec).toBe(300);
    expect(cfg.heartbeatMaxS).toBe(3600);
    expect(cfg.heartbeatMaxS).toBe(DEFAULT_MAINT_LOCK_HEARTBEAT_MAX_S);
  });

  it('honors MACF_MAINT_LOCK_DIR', () => {
    expect(resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_DIR: '/custom/dir' }).dir).toBe('/custom/dir');
  });

  it('honors MACF_MAINT_LOCK_TTL', () => {
    expect(resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_TTL: '60' }).ttlSec).toBe(60);
  });

  it('DERIVES the default heartbeat interval from an OVERRIDDEN TTL (floor(TTL/3)), not a fixed 300s', () => {
    expect(resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_TTL: '300' }).heartbeatIntervalSec).toBe(100);
    expect(resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_TTL: '10' }).heartbeatIntervalSec).toBe(3); // floor(10/3)
  });

  it('honors an EXPLICIT MACF_MAINT_LOCK_HEARTBEAT_INTERVAL even when TTL is also overridden', () => {
    const cfg = resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_TTL: '300', MACF_MAINT_LOCK_HEARTBEAT_INTERVAL: '42' });
    expect(cfg.heartbeatIntervalSec).toBe(42);
  });

  it('honors MACF_MAINT_LOCK_HEARTBEAT_MAX_S', () => {
    expect(resolveMaintenanceLockConfig({ MACF_MAINT_LOCK_HEARTBEAT_MAX_S: '120' }).heartbeatMaxS).toBe(120);
  });

  it('falls back to defaults on blank / non-numeric env values', () => {
    const cfg = resolveMaintenanceLockConfig({
      MACF_MAINT_LOCK_DIR: '   ',
      MACF_MAINT_LOCK_TTL: 'not-a-number',
      MACF_MAINT_LOCK_HEARTBEAT_MAX_S: '',
    });
    expect(cfg.dir).toBe(join(homedir(), '.macf', 'maintenance-locks'));
    expect(cfg.ttlSec).toBe(900);
    expect(cfg.heartbeatMaxS).toBe(3600);
  });
});

// --- acquireLock / heartbeatLock / releaseLock (real fs, tmp dir) ----------

describe('acquireLock / heartbeatLock / releaseLock (real fs, tmp dir)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-maint-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a well-formed lock file with started_at === heartbeat_at === now, and leaves NO stray tempfiles behind (atomic write)', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 5000);
    const entry = readLockEntry(dir, 'code-agent');
    expect(entry).toEqual({
      schema_version: 1,
      agent: 'code-agent',
      target_version: '0.2.48',
      started_at: 5000,
      heartbeat_at: 5000,
    });
    // Exactly one file in the dir — the final lock, no `.code-agent.lock.XXXXXX` debris.
    const files = readdirSync(dir);
    expect(files).toEqual(['code-agent.lock']);
    expect(existsSync(lockFilePath(dir, 'code-agent'))).toBe(true);
  });

  it('acquireLock OVERWRITES an existing lock (re-acquire resets started_at)', () => {
    acquireLock(dir, 'code-agent', '0.2.47', 1000);
    acquireLock(dir, 'code-agent', '0.2.48', 2000);
    expect(readLockEntry(dir, 'code-agent')).toMatchObject({
      target_version: '0.2.48',
      started_at: 2000,
      heartbeat_at: 2000,
    });
  });

  it('heartbeatLock refreshes heartbeat_at ONLY, preserving started_at + target_version', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1000);
    const refreshed = heartbeatLock(dir, 'code-agent', 1300);
    expect(refreshed).toBe(true);
    expect(readLockEntry(dir, 'code-agent')).toEqual({
      schema_version: 1,
      agent: 'code-agent',
      target_version: '0.2.48',
      started_at: 1000,
      heartbeat_at: 1300,
    });
  });

  it('heartbeatLock is a NO-OP (returns false, creates nothing) when no lock exists — never resurrects a released lock', () => {
    const refreshed = heartbeatLock(dir, 'never-acquired', 1000);
    expect(refreshed).toBe(false);
    expect(existsSync(lockFilePath(dir, 'never-acquired'))).toBe(false);
  });

  it('releaseLock removes the lock file', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1000);
    releaseLock(dir, 'code-agent');
    expect(existsSync(lockFilePath(dir, 'code-agent'))).toBe(false);
  });

  it('releaseLock is idempotent — a no-op (does not throw) when no lock exists', () => {
    expect(() => releaseLock(dir, 'never-acquired')).not.toThrow();
  });

  it('isLockActive: true within TTL, false once stale, false when absent', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1000);
    expect(isLockActive(dir, 'code-agent', 900, 1000 + 899)).toBe(true);
    expect(isLockActive(dir, 'code-agent', 900, 1000 + 901)).toBe(false);
    expect(isLockActive(dir, 'never-acquired', 900, 1000)).toBe(false);
  });

  it('isLockActive is false for a malformed lock file on disk (fail toward resuming watchdog healing)', () => {
    writeFileSync(lockFilePath(dir, 'code-agent'), 'not valid json at all');
    expect(isLockActive(dir, 'code-agent', 900, 1000)).toBe(false);
  });
});

// --- startHeartbeatLoop ------------------------------------------------------

describe('startHeartbeatLoop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-maint-lock-loop-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ticks every intervalSec, refreshing heartbeat_at each time (started_at preserved)', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 0);
    const stop = startHeartbeatLoop(dir, 'code-agent', 10, 0); // 0 = unbounded (no dead-man's-switch)
    vi.advanceTimersByTime(10_000);
    const afterOneTick = readLockEntry(dir, 'code-agent');
    expect(afterOneTick?.started_at).toBe(0);
    expect(afterOneTick?.heartbeat_at).toBeGreaterThan(0);
    vi.advanceTimersByTime(10_000);
    const afterTwoTicks = readLockEntry(dir, 'code-agent');
    expect(afterTwoTicks?.heartbeat_at).toBeGreaterThanOrEqual(afterOneTick!.heartbeat_at);
    stop();
  });

  it('stop() halts further heartbeats immediately', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 0);
    const stop = startHeartbeatLoop(dir, 'code-agent', 10, 0);
    vi.advanceTimersByTime(10_000);
    const beforeStop = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    stop();
    vi.advanceTimersByTime(50_000);
    const afterStop = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    expect(afterStop).toBe(beforeStop);
  });

  it('calling stop() more than once is a safe no-op', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 0);
    const stop = startHeartbeatLoop(dir, 'code-agent', 10, 0);
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('dead-man’s-switch: the loop self-terminates after maxS seconds even if stop() is never called', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 0);
    // interval=10s, maxS=30s -> exactly 3 ticks, then the loop clears itself.
    startHeartbeatLoop(dir, 'code-agent', 10, 30);
    vi.advanceTimersByTime(10_000);
    const afterTick1 = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    vi.advanceTimersByTime(10_000);
    const afterTick2 = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    vi.advanceTimersByTime(10_000);
    const afterTick3 = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    expect(afterTick2).toBeGreaterThanOrEqual(afterTick1);
    expect(afterTick3).toBeGreaterThanOrEqual(afterTick2);
    // A 4th tick would have fired at 40s under an unbounded loop; the
    // dead-man's-switch means NO further heartbeat happens past ~30s.
    vi.advanceTimersByTime(50_000);
    const afterOrphanWindow = readLockEntry(dir, 'code-agent')!.heartbeat_at;
    expect(afterOrphanWindow).toBe(afterTick3);
  });

  it('a per-tick heartbeat failure (e.g. the lock was released mid-loop) does not crash the loop or throw', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 0);
    const stop = startHeartbeatLoop(dir, 'code-agent', 10, 0);
    releaseLock(dir, 'code-agent'); // heartbeatLock will now see "absent" and no-op
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(existsSync(lockFilePath(dir, 'code-agent'))).toBe(false); // stays released, not resurrected
    stop();
  });
});

// --- interop round-trip with the bash contract (macf-devops-toolkit#158) --

describe('interop round-trip with the bash contract (macf-devops-toolkit#158)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-maint-lock-interop-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** True iff `jq` is present on PATH — skip the interop suite gracefully otherwise. */
  function hasJq(): boolean {
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  const maybeIt = hasJq() ? it : it.skip;

  maybeIt('a lock written by acquireLock() has all 5 fields present + correctly typed per jq (byte-compatible with the bash reader)', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1_751_500_000);
    const file = lockFilePath(dir, 'code-agent');
    const out = execFileSync('jq', [
      '-c',
      '{schema_version: (.schema_version|type=="number"), agent: (.agent|type=="string"), target_version: (.target_version|type=="string"), started_at: (.started_at|type=="number"), heartbeat_at: (.heartbeat_at|type=="number"), schema_version_value: .schema_version, agent_value: .agent}',
      file,
    ]).toString('utf-8');
    const shape = JSON.parse(out) as Record<string, unknown>;
    expect(shape.schema_version).toBe(true);
    expect(shape.agent).toBe(true);
    expect(shape.target_version).toBe(true);
    expect(shape.started_at).toBe(true);
    expect(shape.heartbeat_at).toBe(true);
    expect(shape.schema_version_value).toBe(1);
    expect(shape.agent_value).toBe('code-agent');
  });

  maybeIt('mirrors the bash lock_active predicate EXACTLY via jq — a fresh lock reads active, a stale one reads inactive', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1000);
    const file = lockFilePath(dir, 'code-agent');
    // The bash `lock_active` shape: (now - heartbeat_at) <= TTL.
    const isActive = (now: number, ttl: number): boolean => {
      try {
        execFileSync('jq', ['-e', `(${now} - (.heartbeat_at // 0)) <= ${ttl}`, file], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    expect(isActive(1000 + 899, 900)).toBe(true);
    expect(isActive(1000 + 901, 900)).toBe(false);
    // And the TS side agrees exactly with jq's verdict for the same inputs.
    expect(isLockActive(dir, 'code-agent', 900, 1000 + 899)).toBe(isActive(1000 + 899, 900));
    expect(isLockActive(dir, 'code-agent', 900, 1000 + 901)).toBe(isActive(1000 + 901, 900));
  });

  maybeIt('heartbeatLock()-refreshed lock still round-trips through jq after a refresh', () => {
    acquireLock(dir, 'code-agent', '0.2.48', 1000);
    heartbeatLock(dir, 'code-agent', 1300);
    const file = lockFilePath(dir, 'code-agent');
    const out = execFileSync('jq', ['-c', '{started_at, heartbeat_at, target_version}', file]).toString('utf-8');
    expect(JSON.parse(out)).toEqual({ started_at: 1000, heartbeat_at: 1300, target_version: '0.2.48' });
  });
});
