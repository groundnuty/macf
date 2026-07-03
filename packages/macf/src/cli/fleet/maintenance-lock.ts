/**
 * The maintenance-lock SET-side (DR-040 Decision 4, `groundnuty/macf#752`) —
 * conforms EXACTLY to the canonical VM-driver contract established by
 * `groundnuty/macf-devops-toolkit#158`/`#159` (`fleet/maintenance-lock.sh` +
 * `fleet/MAINTENANCE-LOCK.md`, the bash reference implementation). This module
 * is a THIRD driver (VM-file, TypeScript) speaking the SAME wire format — it
 * does NOT shell out to the bash library (it isn't distributed to macf
 * workspaces); every byte written here must round-trip through the bash
 * reader (and vice versa), because on a real fleet host the two languages'
 * processes share the SAME lock files (`fleet/upgrade.sh` OR
 * `macf fleet upgrade` SETS; `fleet/reconcile.sh` READS — either combination
 * must interoperate).
 *
 * THE CONTRACT (byte-for-byte, verified against the bash source):
 *
 *   - Path: `${MACF_MAINT_LOCK_DIR:-$HOME/.macf/maintenance-locks}/<agent>.lock`
 *   - Schema (one-line JSON): `{"schema_version":1,"agent":"<kebab>",
 *     "target_version":"<ver>","started_at":<epoch-s>,"heartbeat_at":<epoch-s>}`
 *     — timestamps are UNIX EPOCH SECONDS (integers), not ISO8601, matching
 *     the bash contract's own rationale (portable, jq-comparable, sidesteps
 *     the GNU-vs-BSD `date` parsing divergence).
 *   - Atomic write: tempfile in the SAME directory (guarantees `rename` is
 *     same-filesystem ⇒ atomic) + best-effort fsync + `rename()` over the
 *     target. A reader racing the write always sees the OLD complete file or
 *     the NEW complete file, never a half-written one.
 *   - Four verbs: `acquireLock` (create/overwrite, `started_at` = `heartbeat_at`
 *     = now), `heartbeatLock` (refresh `heartbeat_at` only, preserving
 *     `started_at`; a no-op — never resurrects — if the lock is absent),
 *     `releaseLock` (remove; idempotent), `isLockActive` (true iff present AND
 *     heartbeat within TTL; missing/unparseable/non-numeric ⇒ false — fail
 *     TOWARD resuming watchdog healing, never toward blocking it forever).
 *
 * Env (read IDENTICALLY to the bash contract — any divergence desyncs the
 * stale-detection margin between the two drivers on a fleet host running
 * both):
 *   - `MACF_MAINT_LOCK_TTL` (default 900)
 *   - `MACF_MAINT_LOCK_HEARTBEAT_INTERVAL` (default `floor(TTL / 3)` — DERIVED
 *     from the possibly-overridden TTL, not a fixed 300s constant)
 *   - `MACF_MAINT_LOCK_DIR` (default `$HOME/.macf/maintenance-locks`)
 *   - `MACF_MAINT_LOCK_HEARTBEAT_MAX_S` (default 3600 — the dead-man's-switch
 *     bounding the background heartbeat LOOP's own total lifetime, so an
 *     orphaned loop — e.g. its parent process killed before the stop handle
 *     ever runs — cannot refresh the lock forever)
 *
 * Refs: `groundnuty/macf-devops-toolkit#158`/`#159` (the canonical contract +
 *       its full design rationale — read the header of `fleet/maintenance-lock.sh`
 *       + `fleet/MAINTENANCE-LOCK.md` for the complete crash-safety model),
 *       DR-040 Decision 3 (transactional halt — release ONLY on green) +
 *       Decision 4 (this primitive), `groundnuty/macf#752` (this build; wires
 *       these verbs into `FleetDriver` + `rollFleet` via `vm-driver.ts`).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The one-line JSON lock-file schema — byte-for-byte the bash contract's shape. */
export interface MaintenanceLockEntry {
  readonly schema_version: 1;
  readonly agent: string;
  readonly target_version: string;
  /** Unix epoch SECONDS (integer) — deliberately not ISO8601, see file header. */
  readonly started_at: number;
  /** Unix epoch SECONDS (integer). */
  readonly heartbeat_at: number;
}

/** Resolved knobs (env-read once; overridable for tests/operators). */
export interface MaintenanceLockConfig {
  readonly dir: string;
  readonly ttlSec: number;
  readonly heartbeatIntervalSec: number;
  readonly heartbeatMaxS: number;
}

/** `MACF_MAINT_LOCK_TTL` default (seconds) — matches the bash contract. */
export const DEFAULT_MAINT_LOCK_TTL_SEC = 900;
/** `MACF_MAINT_LOCK_HEARTBEAT_MAX_S` default (seconds) — matches the bash contract. */
export const DEFAULT_MAINT_LOCK_HEARTBEAT_MAX_S = 3600;

function defaultLockDir(): string {
  return join(homedir(), '.macf', 'maintenance-locks');
}

/** Parse a non-negative integer env var; falls back on absence/blank/invalid. */
function readIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the maintenance-lock config from environment — IDENTICAL read
 * semantics to `fleet/maintenance-lock.sh`'s env-var defaults (dir / TTL /
 * heartbeat-interval / heartbeat-max-s), so a VM host running BOTH the bash
 * reconcile/upgrade scripts AND `macf fleet upgrade` sees ONE consistent
 * staleness margin regardless of which driver acquired a given lock.
 */
export function resolveMaintenanceLockConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceLockConfig {
  const rawDir = env.MACF_MAINT_LOCK_DIR;
  const dir = rawDir && rawDir.trim().length > 0 ? rawDir : defaultLockDir();
  const ttlSec = readIntEnv(env, 'MACF_MAINT_LOCK_TTL', DEFAULT_MAINT_LOCK_TTL_SEC);
  // Default heartbeat interval is DERIVED from the (possibly-overridden) TTL,
  // matching the bash contract's
  // `${MACF_MAINT_LOCK_HEARTBEAT_INTERVAL:-$((MAINT_LOCK_TTL/3))}` — NOT a
  // fixed 300s constant.
  const heartbeatIntervalSec = readIntEnv(env, 'MACF_MAINT_LOCK_HEARTBEAT_INTERVAL', Math.floor(ttlSec / 3));
  const heartbeatMaxS = readIntEnv(env, 'MACF_MAINT_LOCK_HEARTBEAT_MAX_S', DEFAULT_MAINT_LOCK_HEARTBEAT_MAX_S);
  return { dir, ttlSec, heartbeatIntervalSec, heartbeatMaxS };
}

/** The lock file path for `agent` under `dir`. */
export function lockFilePath(dir: string, agent: string): string {
  return join(dir, `${agent}.lock`);
}

/**
 * Serialize a lock entry to its wire-form JSON object (key order matches the
 * bash `jq -n` construction — `schema_version, agent, target_version,
 * started_at, heartbeat_at` — though any conformant JSON reader, jq included,
 * does not care about key order).
 */
export function serializeLockEntry(entry: MaintenanceLockEntry): string {
  return JSON.stringify({
    schema_version: entry.schema_version,
    agent: entry.agent,
    target_version: entry.target_version,
    started_at: entry.started_at,
    heartbeat_at: entry.heartbeat_at,
  });
}

/**
 * Parse a lock file's raw contents. Returns `null` on ANY shape violation —
 * invalid JSON, missing/wrong `schema_version`, missing `agent`/
 * `target_version`, non-numeric or missing `started_at`/`heartbeat_at` — fail
 * TOWARD "no lock" (the Pattern-B shape-validation posture documented in
 * `silent-fallback-hazards.md`), never toward accepting a malformed lock as a
 * real one.
 */
export function parseLockEntry(raw: string): MaintenanceLockEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.schema_version !== 1) return null;
  if (typeof rec.agent !== 'string' || rec.agent.length === 0) return null;
  if (typeof rec.target_version !== 'string') return null;
  if (typeof rec.started_at !== 'number' || !Number.isFinite(rec.started_at)) return null;
  if (typeof rec.heartbeat_at !== 'number' || !Number.isFinite(rec.heartbeat_at)) return null;
  return {
    schema_version: 1,
    agent: rec.agent,
    target_version: rec.target_version,
    started_at: rec.started_at,
    heartbeat_at: rec.heartbeat_at,
  };
}

/**
 * The active predicate (pure, clock-injected) — `true` iff `entry` is present
 * AND its `heartbeat_at` is within `ttlSec` of `nowSec`. Mirrors the bash
 * `lock_active`'s fail-toward-resume posture: `null` / non-positive / aged-out
 * all read INACTIVE — a corrupt or stale lock must never be able to block a
 * real recovery forever.
 */
export function computeActive(entry: MaintenanceLockEntry | null, nowSec: number, ttlSec: number): boolean {
  if (!entry) return false;
  if (!Number.isFinite(entry.heartbeat_at) || entry.heartbeat_at <= 0) return false;
  const age = nowSec - entry.heartbeat_at;
  return age <= ttlSec;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * The shared ATOMIC-WRITE primitive behind `acquireLock` + `heartbeatLock` —
 * write to a tempfile in the SAME directory (guarantees `rename` is
 * same-filesystem ⇒ atomic), best-effort fsync, then `rename` over the
 * target. A reader racing this always sees a complete file, pre- or
 * post-rename, never a partial write. Mirrors the bash `_maint_lock_write`'s
 * `mktemp` + `sync` + `mv -f` sequence.
 */
function writeLockAtomic(dir: string, entry: MaintenanceLockEntry): void {
  mkdirSync(dir, { recursive: true });
  const target = lockFilePath(dir, entry.agent);
  let tmpPath: string | null = null;
  let fd: number | null = null;
  for (let attempt = 0; attempt < 5 && fd === null; attempt += 1) {
    const candidate = join(dir, `.${entry.agent}.lock.${randomBytes(6).toString('hex')}`);
    try {
      fd = openSync(candidate, 'wx'); // exclusive create — fails if it exists
      tmpPath = candidate;
    } catch (err) {
      if (!isEexist(err)) throw err;
      // EEXIST collision on the random suffix — retry with a fresh one.
    }
  }
  if (fd === null || tmpPath === null) {
    throw new Error(`maintenance-lock: could not create a unique tempfile in ${dir} for ${entry.agent}`);
  }
  try {
    // Trailing newline for interop-friendliness with line-based tools (jq
    // parses either way; this just makes `cat`/`tail -f` output tidy).
    writeSync(fd, `${serializeLockEntry(entry)}\n`);
    try {
      fsyncSync(fd);
    } catch {
      // Best-effort fsync (mirrors the bash `sync "$tmp" || sync || true`) —
      // a missed fsync narrows, but does not remove, the atomicity guarantee.
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, target);
}

/** Read + parse `agent`'s lock file, or `null` if absent/unparseable. */
export function readLockEntry(dir: string, agent: string): MaintenanceLockEntry | null {
  const file = lockFilePath(dir, agent);
  if (!existsSync(file)) return null;
  try {
    return parseLockEntry(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Create/overwrite `agent`'s maintenance lock — `started_at` AND
 * `heartbeat_at` both set to now. Atomic write (see `writeLockAtomic`).
 */
export function acquireLock(
  dir: string,
  agent: string,
  targetVersion: string,
  nowSec: number = nowSeconds(),
): void {
  writeLockAtomic(dir, {
    schema_version: 1,
    agent,
    target_version: targetVersion,
    started_at: nowSec,
    heartbeat_at: nowSec,
  });
}

/**
 * Refresh `agent`'s `heartbeat_at` only (`started_at`/`target_version`
 * preserved from the existing lock). Returns `false` — a NO-OP — if no lock
 * exists: a heartbeat must never resurrect a released/never-acquired lock.
 */
export function heartbeatLock(dir: string, agent: string, nowSec: number = nowSeconds()): boolean {
  const existing = readLockEntry(dir, agent);
  if (!existing) return false;
  writeLockAtomic(dir, {
    schema_version: 1,
    agent,
    target_version: existing.target_version,
    started_at: existing.started_at,
    heartbeat_at: nowSec,
  });
  return true;
}

/** Remove `agent`'s lock file. Idempotent (a no-op if absent). */
export function releaseLock(dir: string, agent: string): void {
  const file = lockFilePath(dir, agent);
  if (existsSync(file)) unlinkSync(file);
}

/** `true` iff `agent`'s lock exists and its heartbeat is within `ttlSec`. */
export function isLockActive(
  dir: string,
  agent: string,
  ttlSec: number,
  nowSec: number = nowSeconds(),
): boolean {
  return computeActive(readLockEntry(dir, agent), nowSec, ttlSec);
}

/**
 * Start a BACKGROUND heartbeat loop for `agent` — ticks every `intervalSec`,
 * calling `heartbeatLock` and swallowing any per-tick failure (mirroring the
 * bash `lock_heartbeat ... || true`: a single failed refresh must never
 * crash the loop or the caller's foreground work). Bounded by a dead-man's
 * switch: `maxS > 0` caps the loop's OWN total lifetime — an orphaned loop
 * (e.g. its parent process was killed before the stop handle ever ran)
 * self-terminates rather than refreshing the lock forever. Returns a
 * synchronous STOP handle; calling it more than once is a safe no-op.
 */
export function startHeartbeatLoop(
  dir: string,
  agent: string,
  intervalSec: number,
  maxS: number,
): () => void {
  const interval = intervalSec > 0 ? intervalSec : DEFAULT_MAINT_LOCK_TTL_SEC / 3;
  const maxTicks = maxS > 0 ? Math.max(1, Math.floor(maxS / interval)) : 0;
  let ticks = 0;
  let stopped = false;
  const timer = setInterval(() => {
    try {
      heartbeatLock(dir, agent);
    } catch {
      // Never let a heartbeat failure crash the interval or the caller.
    }
    ticks += 1;
    if (maxTicks > 0 && ticks >= maxTicks) {
      clearInterval(timer);
    }
  }, interval * 1000);
  // Doesn't keep the process alive on its own — the caller's own await chain
  // (rollFleet) is what keeps the process running; unref just means a stray
  // un-stopped timer can't block a natural process exit.
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
