import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { MacfError } from '../errors.js';
import { AgentInfoSchema, agentInfoEquals } from './types.js';
import type { AgentInfo, Registry, RegisterResult, DeregisterResult, HeartbeatResult } from './types.js';

/**
 * Local registry implementation per DR-024.
 *
 * Single-file JSON store at the operator-supplied absolute path
 * (typically `~/.macf/registry/<project>.json`). Reads/writes go through
 * a temp-file-then-rename atomic write and a `proper-lockfile` advisory
 * lock so concurrent channel-servers in the same project don't corrupt
 * the file or lose registrations.
 *
 * Filesystem permissions are the trust boundary: the parent directory
 * must be `0700` and (if the file exists) the file must be `0600`. The
 * client fails loud if either is wrong rather than auto-fixing — the
 * operator decides whether to chmod or move the project, per DR-024
 * "Out of Scope" (no auto-repair).
 */

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Wire format of the on-disk JSON file. The envelope (`schema_version`,
 * `project`, `agents`) is local-mode-specific; per-agent records use the
 * shared `AgentInfoSchema` so consumers see the same shape regardless
 * of which `Registry` implementation produced them.
 */
export const RegistryFileSchema = z.object({
  schema_version: z.literal(REGISTRY_SCHEMA_VERSION),
  project: z.string().min(1),
  agents: z.record(z.string().min(1), AgentInfoSchema),
});

export type RegistryFile = z.infer<typeof RegistryFileSchema>;

export class LocalRegistryError extends MacfError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'LocalRegistryError';
  }
}

/**
 * Verify directory + file permissions match the DR-024 trust boundary.
 * The parent dir must be `0700`; if the file already exists it must be
 * `0600`. Throws on mismatch with an actionable diagnostic.
 *
 * On non-POSIX platforms (Windows) `mode & 0o777` semantics differ — we
 * still call the check but don't throw on mode mismatch there. DR-024's
 * threat model is filesystem-permission-based and POSIX-shaped; Windows
 * deployments inherit the same trust assumptions but enforcement is
 * platform-best-effort.
 */
function verifyPermissions(filePath: string): void {
  const dir = path.dirname(filePath);

  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch (err) {
    const cause = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `Directory does not exist: ${dir}. Run \`macf init --local\` to bootstrap.`
      : `Failed to stat directory ${dir}: ${(err as Error).message}`;
    throw new LocalRegistryError('LOCAL_REGISTRY_DIR_MISSING', cause);
  }

  if (!dirStat.isDirectory()) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_DIR_NOT_DIRECTORY',
      `Registry parent path is not a directory: ${dir}`,
    );
  }

  // POSIX-only enforcement; Windows mode bits are not 0700-shaped.
  if (process.platform !== 'win32') {
    const dirMode = dirStat.mode & 0o777;
    if (dirMode !== 0o700) {
      throw new LocalRegistryError(
        'LOCAL_REGISTRY_DIR_PERMS',
        `Registry directory ${dir} has mode ${dirMode.toString(8).padStart(3, '0')}; ` +
          `expected 700 per DR-024. Fix with: chmod 700 ${dir}`,
      );
    }
  }

  // File may or may not exist yet — only check perms if present.
  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_FILE_STAT_FAILED',
      `Failed to stat registry file ${filePath}: ${(err as Error).message}`,
    );
  }

  if (!fileStat.isFile()) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_FILE_NOT_REGULAR',
      `Registry path is not a regular file: ${filePath}`,
    );
  }

  if (process.platform !== 'win32') {
    const fileMode = fileStat.mode & 0o777;
    if (fileMode !== 0o600) {
      throw new LocalRegistryError(
        'LOCAL_REGISTRY_FILE_PERMS',
        `Registry file ${filePath} has mode ${fileMode.toString(8).padStart(3, '0')}; ` +
          `expected 600 per DR-024. Fix with: chmod 600 ${filePath}`,
      );
    }
  }
}

/**
 * Read the registry file. Returns `null` if the file doesn't exist —
 * register-on-empty creates it. Throws `LocalRegistryError` on malformed
 * JSON or unsupported `schema_version` so the operator sees a
 * diagnostic rather than silent partial state (DR-024 §"Out of Scope").
 */
async function readRegistryFile(filePath: string): Promise<RegistryFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_READ_FAILED',
      `Failed to read registry file ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_MALFORMED_JSON',
      `Registry file ${filePath} is not valid JSON: ${(err as Error).message}. ` +
        'Inspect the file and either repair manually or remove + re-init.',
    );
  }

  // Pre-validate `schema_version` so the diagnostic is specific to a
  // version mismatch (vs. a generic Zod failure listing every issue).
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schema_version' in parsed &&
    typeof (parsed as { schema_version: unknown }).schema_version === 'number' &&
    (parsed as { schema_version: number }).schema_version !== REGISTRY_SCHEMA_VERSION
  ) {
    const got = (parsed as { schema_version: number }).schema_version;
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_SCHEMA_MISMATCH',
      `Registry file ${filePath} has schema_version ${got}; ` +
        `this build expects ${REGISTRY_SCHEMA_VERSION}. Migration tooling has not shipped yet.`,
    );
  }

  const result = RegistryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_INVALID_SHAPE',
      `Registry file ${filePath} does not match expected shape: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Atomic write: serialize, write to a temp sibling, fsync, rename. The
 * rename onto the final path is atomic on POSIX so concurrent readers
 * never observe a partial file.
 */
async function writeRegistryFileAtomic(
  filePath: string,
  data: RegistryFile,
): Promise<void> {
  const dir = path.dirname(filePath);
  // Random suffix prevents collisions if multiple writers somehow get
  // past the lock (defense-in-depth — `proper-lockfile` already
  // serializes us).
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const tempPath = path.join(dir, `${path.basename(filePath)}.tmp.${suffix}`);

  const json = `${JSON.stringify(data, null, 2)}\n`;

  let handle;
  try {
    handle = await fs.open(tempPath, 'w', 0o600);
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    if (handle !== undefined) await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Clean up the temp on rename failure so we don't leave debris.
    await fs.unlink(tempPath).catch(() => undefined);
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_WRITE_FAILED',
      `Failed to rename ${tempPath} → ${filePath}: ${(err as Error).message}`,
    );
  }
}

/**
 * Construct an empty registry file shape for first-write bootstrap.
 */
function emptyRegistry(project: string): RegistryFile {
  return {
    schema_version: REGISTRY_SCHEMA_VERSION,
    project,
    agents: {},
  };
}

export interface LocalRegistryOptions {
  /** Absolute path to the registry JSON file. */
  readonly path: string;
  /** Project name; recorded in the JSON envelope. */
  readonly project: string;
}

/**
 * Run `fn` while holding an exclusive lock on the registry's parent
 * directory.
 *
 * Locking the parent dir (rather than the file) keeps the lock target
 * stable across the file's existence boundary — `proper-lockfile`
 * keys lock identity on the inode of the target, so locking the file
 * before vs. after creation would yield two different lock identities
 * and concurrent first-time registrations could race. The dir is the
 * DR-024 trust boundary anyway (`0700`) and is always present
 * (verified at construct time).
 */
async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = path.dirname(filePath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockTarget, {
      // Generous retry count + tight intervals for high-concurrency
      // bursts (e.g. ~10 concurrent registers on one host). Lock holds
      // are typically <50ms (read + JSON write), so 30 retries × 100ms
      // covers ~3s of contention even in pathological cases.
      retries: { retries: 30, minTimeout: 20, maxTimeout: 100, factor: 1.2 },
      stale: 30_000,
      realpath: false,
    });
  } catch (err) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_LOCK_FAILED',
      `Failed to acquire registry lock on ${lockTarget}: ${(err as Error).message}. ` +
        'Another channel-server may be holding it; retry shortly or check for stale processes.',
    );
  }

  try {
    return await fn();
  } finally {
    if (release !== undefined) {
      await release().catch(() => undefined);
    }
  }
}

/**
 * Create a `Registry` backed by a single JSON file on the local
 * filesystem. Validates filesystem permissions at construction time per
 * DR-024 trust-boundary requirements.
 *
 * The returned object implements the same `Registry` interface as
 * `createRegistry()` (the GitHub-backed variant), so consumer sites
 * dispatching on `RegistryConfig.type` get a uniform call surface.
 */
export function createLocalRegistry(
  options: LocalRegistryOptions,
): Registry {
  if (!path.isAbsolute(options.path)) {
    throw new LocalRegistryError(
      'LOCAL_REGISTRY_PATH_NOT_ABSOLUTE',
      `Local registry path must be absolute: ${options.path}`,
    );
  }

  // Fail-loud at construct-time if the trust-boundary perms are wrong.
  // Operators see a diagnostic with the exact chmod command to run. Sync
  // stat keeps the factory function synchronous so all four
  // `RegistryConfig` variants share the same call surface (see
  // `factory.ts`).
  verifyPermissions(options.path);

  return {
    async register(name: string, info: AgentInfo): Promise<void> {
      // Validate the input ourselves — the GitHub-backed registry does
      // this implicitly via the wire JSON path; here we want the same
      // contract enforced before we start mutating the file.
      const validated = AgentInfoSchema.parse(info);

      await withLock(options.path, async () => {
        const existing = await readRegistryFile(options.path);
        const file: RegistryFile = existing ?? emptyRegistry(options.project);
        const next: RegistryFile = {
          schema_version: REGISTRY_SCHEMA_VERSION,
          project: options.project,
          agents: { ...file.agents, [name]: validated },
        };
        await writeRegistryFileAtomic(options.path, next);
      });
    },

    // CAS register (groundnuty/macf#439; over-register semantics per
    // groundnuty/macf#702). Fully atomic for the local backend: the read
    // (current slot), the compare against `expected`, and the write all
    // happen inside the same `withLock` critical section, so a racing second
    // writer is serialized behind the lock and observes the first writer's
    // value — failing the compare and backing off (`ok:false,
    // reason:'lost-to-newer'`). No read-back verify is needed (unlike the
    // GitHub backend, whose read-after-write lag motivated #702's retry
    // logic) — the lock makes the compare-then-write indivisible, so there is
    // no confirmation-gap distinct from a real conflict on this backend:
    // `current == expected` (including a stale/unchanged entry the caller is
    // taking over) ALWAYS claims (`ok:true, reason:'claimed'`); any other
    // `current` is a genuine concurrent writer (`reason:'lost-to-newer'`).
    async registerConditional(
      name: string,
      info: AgentInfo,
      expected: AgentInfo | null,
    ): Promise<RegisterResult> {
      const validated = AgentInfoSchema.parse(info);

      return withLock(options.path, async (): Promise<RegisterResult> => {
        const existing = await readRegistryFile(options.path);
        const current = existing?.agents[name] ?? null;
        if (!agentInfoEquals(current, expected)) {
          return { ok: false, reason: 'lost-to-newer', current };
        }

        const file: RegistryFile = existing ?? emptyRegistry(options.project);
        const next: RegistryFile = {
          schema_version: REGISTRY_SCHEMA_VERSION,
          project: options.project,
          agents: { ...file.agents, [name]: validated },
        };
        await writeRegistryFileAtomic(options.path, next);
        return { ok: true, reason: 'claimed', current: validated };
      });
    },

    // Instance-id-guarded deregister (DR-031, groundnuty/macf#553 root-cause).
    // Fully atomic on this backend: the read (current slot), the instance_id
    // compare, and the delete all happen inside ONE `withLock` critical section,
    // so a concurrent takeover (groundnuty/macf#424) is serialized behind the
    // lock and observed by our read → we return 'not-ours' and never clobber the
    // live newer instance's registration. NEVER throws — any error (incl. a
    // malformed registry file surfaced by `readRegistryFile`) is caught and
    // returned as reason:'error' so a graceful shutdown logs + proceeds.
    async deregisterConditional(
      name: string,
      expectedInstanceId: string,
    ): Promise<DeregisterResult> {
      try {
        return await withLock(options.path, async (): Promise<DeregisterResult> => {
          const existing = await readRegistryFile(options.path);
          const current = existing?.agents[name] ?? null;
          // `existing === null` is folded into the absent branch so TS narrows
          // `existing` to non-null for the delete path below (a non-null
          // `current` implies a non-null `existing`, but the `?? null` erases
          // that link for the type checker).
          if (existing === null || current === null) {
            return { deregistered: false, reason: 'absent' };
          }
          if (current.instance_id !== expectedInstanceId) {
            // A newer instance (groundnuty/macf#424) holds the slot — not ours.
            return { deregistered: false, reason: 'not-ours' };
          }
          const nextAgents: Record<string, AgentInfo> = {};
          for (const [k, v] of Object.entries(existing.agents)) {
            if (k !== name) nextAgents[k] = v;
          }
          const next: RegistryFile = {
            schema_version: REGISTRY_SCHEMA_VERSION,
            project: options.project,
            agents: nextAgents,
          };
          await writeRegistryFileAtomic(options.path, next);
          return { deregistered: true, reason: 'deleted' };
        });
      } catch {
        return { deregistered: false, reason: 'error' };
      }
    },

    // Instance-id-guarded heartbeat (DR-031, groundnuty/macf#568). Fully atomic on
    // this backend: the read (current slot), the instance_id compare, and the
    // re-stamp write all happen inside ONE `withLock` critical section, so a
    // concurrent takeover (groundnuty/macf#424) is serialized behind the lock and
    // observed by our read → 'not-ours', never clobbering the live newer instance.
    // NEVER throws — any error (incl. a malformed registry file surfaced by
    // `readRegistryFile`) is caught and returned as reason:'error' so a heartbeat
    // hiccup never crashes the server; the next interval retries.
    async heartbeatConditional(
      name: string,
      expectedInstanceId: string,
      now: string,
    ): Promise<HeartbeatResult> {
      try {
        return await withLock(options.path, async (): Promise<HeartbeatResult> => {
          const existing = await readRegistryFile(options.path);
          const current = existing?.agents[name] ?? null;
          // `existing === null` is folded into the absent branch so TS narrows
          // `existing` to non-null for the write path below.
          if (existing === null || current === null) {
            return { beat: false, reason: 'absent' };
          }
          if (current.instance_id !== expectedInstanceId) {
            // A newer instance (groundnuty/macf#424) holds the slot — not ours.
            return { beat: false, reason: 'not-ours' };
          }
          // Preserve every other field; only `last_heartbeat` advances.
          const next: RegistryFile = {
            schema_version: REGISTRY_SCHEMA_VERSION,
            project: options.project,
            agents: { ...existing.agents, [name]: { ...current, last_heartbeat: now } },
          };
          await writeRegistryFileAtomic(options.path, next);
          return { beat: true, reason: 'beat' };
        });
      } catch {
        return { beat: false, reason: 'error' };
      }
    },

    async get(name: string): Promise<AgentInfo | null> {
      const file = await readRegistryFile(options.path);
      if (file === null) return null;
      return file.agents[name] ?? null;
    },

    async list(
      filterPrefix: string,
    ): Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>> {
      const file = await readRegistryFile(options.path);
      if (file === null) return [];

      const results: Array<{ name: string; info: AgentInfo }> = [];
      for (const [agentName, info] of Object.entries(file.agents)) {
        if (filterPrefix !== '' && !agentName.startsWith(filterPrefix)) continue;
        results.push({ name: agentName, info });
      }
      return results;
    },

    async remove(name: string): Promise<void> {
      await withLock(options.path, async () => {
        const existing = await readRegistryFile(options.path);
        // Match GitHub-backed semantics: removing a missing agent is a
        // no-op (DELETE returns 204 or 404 — both treated as success).
        if (existing === null) return;
        if (!(name in existing.agents)) return;

        const nextAgents: Record<string, AgentInfo> = {};
        for (const [k, v] of Object.entries(existing.agents)) {
          if (k !== name) nextAgents[k] = v;
        }
        const next: RegistryFile = {
          schema_version: REGISTRY_SCHEMA_VERSION,
          project: options.project,
          agents: nextAgents,
        };
        await writeRegistryFileAtomic(options.path, next);
      });
    },
  };
}
