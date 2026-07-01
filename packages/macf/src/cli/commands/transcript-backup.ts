/**
 * Session-transcript backup + pre-state capture for `macf restart-self`
 * (macf#685) — the TRANSCRIPT half of "protect state before the destructive
 * restart". The marked-stash in `restart-self.ts` protects the WORKSPACE
 * (uncommitted git); this protects the CONVERSATION (the `.jsonl` transcript
 * that a wrong `/clear`, a mis-resume, or a bad relaunch can irreversibly lose).
 *
 * Before the detached relauncher spawns + the session is killed, we:
 *   1. Discover the ACTIVE transcript `~/.claude/projects/<slug>/<uuid>.jsonl`,
 *      where `<slug>` = the REAL launch cwd with every non-alnum char → '-'.
 *      Deriving from the launch cwd is more robust than a `<parent>-<repo>`
 *      tail-match across the fleet's Mac/Linux path divergence (macf#685).
 *   2. Copy it to a ROTATING per-session backup (keep newest N, default 5),
 *      reusing `/compact`'s `<uuid>.<ts>.jsonl.bak` naming (align, don't fork).
 *   3. Record pre-state `{projectDir, uuid, size, mtime}` to a shell-sourceable
 *      file the detached relauncher reads AFTER relaunch to ASSERT-SURVIVED
 *      (Pattern A — silent-fallback-hazards: "restart exited 0" ≠ "state survived").
 *
 * Pure decisions (slug, backup filename, rotation-select) are exported +
 * unit-testable WITHOUT real files; every FS effect flows through `TranscriptDeps`.
 */
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `.jsonl` transcript metadata (excludes `.jsonl.bak` compaction backups). */
export interface TranscriptFileInfo {
  /** Basename, e.g. `<uuid>.jsonl`. */
  readonly name: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** A backup file's identity for rotation decisions. */
export interface BackupFileInfo {
  readonly name: string;
  readonly mtimeMs: number;
}

/**
 * Every filesystem effect the backup performs, injected so the discovery +
 * rotation + pre-state write are unit-testable with fakes (no real files).
 */
export interface TranscriptDeps {
  /** The REAL launch cwd (default `process.cwd()`) — the slug source. */
  readonly launchCwd: () => string;
  /** `~/.claude/projects` (override: `MACF_CLAUDE_PROJECTS_DIR`). */
  readonly claudeProjectsDir: () => string;
  /** `~/.macf/session-backups` (override: `MACF_SESSION_BACKUP_DIR`). */
  readonly sessionBackupDir: () => string;
  /** Rotating backups kept per session (override: `MACF_SESSION_BACKUP_KEEP`). */
  readonly backupKeep: () => number;
  /** `.jsonl` transcripts in a project dir (excludes `.jsonl.bak`); `[]` if missing. */
  readonly listTranscripts: (projectDir: string) => readonly TranscriptFileInfo[];
  /** `.jsonl.bak` backups in a dir; `[]` if missing. */
  readonly listBackups: (dir: string) => readonly BackupFileInfo[];
  readonly copyFile: (src: string, dest: string) => void;
  readonly removeFile: (path: string) => void;
  readonly writeFile: (path: string, content: string) => void;
  readonly mkdirp: (path: string) => void;
}

/** The pre-restart transcript state — recorded for the relauncher's assert-survived. */
export interface TranscriptPreState {
  readonly projectDir: string;
  readonly uuid: string;
  readonly size: number;
  /** mtime in epoch SECONDS (matches `stat -c%Y` / `-f%m` the relauncher reads). */
  readonly mtimeSec: number;
  readonly backupDir: string;
  readonly backupPath: string;
}

/** Claude Code's project slug: the launch-cwd path with every non-alnum char → '-'. */
export function deriveProjectSlug(launchCwd: string): string {
  return launchCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Compact UTC timestamp `YYYYMMDD_HHMMSS` — aligns with `/compact`'s `.bak` stamp. */
export function compactTimestamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** Backup filename `<uuid>.<ts>.jsonl.bak` — reuses `/compact`'s naming scheme. */
export function backupFileName(uuid: string, now: Date): string {
  return `${uuid}.${compactTimestamp(now)}.jsonl.bak`;
}

/** Filesystem-safe per-session backup subdir (keeps `@ . _ -`, others → '_'). */
export function backupSubdir(session: string): string {
  return session.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

/**
 * Given the current backups, return the names to PRUNE (everything past the
 * newest `keep`). Newest-first by mtime, ties broken by name descending so the
 * ordering is deterministic for a fixed-clock backup set.
 */
export function selectBackupsToPrune(backups: readonly BackupFileInfo[], keep: number): string[] {
  const sorted = [...backups].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );
  return sorted.slice(Math.max(keep, 0)).map((b) => b.name);
}

/** The active (most-recent-mtime) transcript for the launch cwd, or `null`. */
export function findActiveTranscript(deps: TranscriptDeps): {
  readonly projectDir: string;
  readonly uuid: string;
  readonly size: number;
  readonly mtimeMs: number;
} | null {
  const slug = deriveProjectSlug(deps.launchCwd());
  const projectDir = join(deps.claudeProjectsDir(), slug);
  const files = deps.listTranscripts(projectDir);
  if (files.length === 0) return null;
  const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return {
    projectDir,
    uuid: newest.name.replace(/\.jsonl$/, ''),
    size: newest.size,
    mtimeMs: newest.mtimeMs,
  };
}

/** Single-quote a value for safe shell embedding (closes + escapes any `'`). */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The shell-sourceable pre-state file the detached relauncher reads. */
export function renderPreStateFile(pre: TranscriptPreState): string {
  return [
    '# macf restart-self — session-transcript pre-state (macf#685).',
    '# Read by the detached relauncher to assert-survived AFTER relaunch (Pattern A).',
    'MACF_RESTART_PRESTATE_VERSION=1',
    `MACF_RESTART_PROJECT_DIR=${shq(pre.projectDir)}`,
    `MACF_RESTART_PRE_UUID=${shq(pre.uuid)}`,
    `MACF_RESTART_PRE_SIZE=${pre.size}`,
    `MACF_RESTART_PRE_MTIME=${pre.mtimeSec}`,
    `MACF_RESTART_BACKUP_DIR=${shq(pre.backupDir)}`,
    '',
  ].join('\n');
}

/**
 * Back up the active transcript (rotating) + write the pre-state file. Returns
 * the recorded pre-state, or `null` when no active transcript was found (a bare
 * CLI run outside a Claude session, or a slug mismatch) — in which case the
 * relauncher's guard is a no-op. Never throws on a best-effort backup: a missing
 * transcript simply skips.
 */
export function backupSessionTranscript(
  deps: TranscriptDeps,
  session: string,
  prestatePath: string,
  now: Date,
): TranscriptPreState | null {
  const active = findActiveTranscript(deps);
  if (!active) return null;

  const backupDir = join(deps.sessionBackupDir(), backupSubdir(session));
  deps.mkdirp(backupDir);

  const src = join(active.projectDir, `${active.uuid}.jsonl`);
  const backupPath = join(backupDir, backupFileName(active.uuid, now));
  deps.copyFile(src, backupPath);

  // Rotate — keep the newest N (counts the just-written backup).
  for (const name of selectBackupsToPrune(deps.listBackups(backupDir), deps.backupKeep())) {
    deps.removeFile(join(backupDir, name));
  }

  const pre: TranscriptPreState = {
    projectDir: active.projectDir,
    uuid: active.uuid,
    size: active.size,
    mtimeSec: Math.floor(active.mtimeMs / 1000),
    backupDir,
    backupPath,
  };
  deps.writeFile(prestatePath, renderPreStateFile(pre));
  return pre;
}

/** Real FS-bound `TranscriptDeps` (production wiring). */
export function createRealTranscriptDeps(env: NodeJS.ProcessEnv = process.env): TranscriptDeps {
  const home = homedir();
  return {
    launchCwd: () => process.cwd(),
    claudeProjectsDir: () =>
      env['MACF_CLAUDE_PROJECTS_DIR']?.trim() || join(home, '.claude', 'projects'),
    sessionBackupDir: () =>
      env['MACF_SESSION_BACKUP_DIR']?.trim() || join(home, '.macf', 'session-backups'),
    backupKeep: () => {
      const n = Number.parseInt(env['MACF_SESSION_BACKUP_KEEP'] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 5;
    },
    listTranscripts: (projectDir: string): readonly TranscriptFileInfo[] => {
      let names: string[];
      try {
        names = readdirSync(projectDir);
      } catch {
        return [];
      }
      const out: TranscriptFileInfo[] = [];
      for (const name of names) {
        // `.jsonl` matches the active transcript; `.jsonl.bak` is excluded by suffix.
        if (!name.endsWith('.jsonl')) continue;
        try {
          const st = statSync(join(projectDir, name));
          if (st.isFile()) out.push({ name, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* unreadable — skip */
        }
      }
      return out;
    },
    listBackups: (dir: string): readonly BackupFileInfo[] => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out: BackupFileInfo[] = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl.bak')) continue;
        try {
          out.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
        } catch {
          /* unreadable — skip */
        }
      }
      return out;
    },
    copyFile: (src: string, dest: string) => {
      copyFileSync(src, dest);
    },
    removeFile: (path: string) => {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort rotation */
      }
    },
    writeFile: (path: string, content: string) => {
      writeFileSync(path, content);
    },
    mkdirp: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
  };
}
