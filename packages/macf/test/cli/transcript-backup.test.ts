/**
 * Tests for the session-transcript backup + pre-state capture (macf#685) — the
 * TRANSCRIPT half of restart-self's "protect state before the destructive
 * restart". Pure decisions (slug / backup filename / rotation-select) run
 * without files; the backup orchestration runs against a FAKE `TranscriptDeps`.
 */
import { describe, it, expect } from 'vitest';
import {
  backupFileName,
  backupSessionTranscript,
  backupSubdir,
  compactTimestamp,
  deriveProjectSlug,
  findActiveTranscript,
  renderPreStateFile,
  selectBackupsToPrune,
  type BackupFileInfo,
  type TranscriptDeps,
  type TranscriptFileInfo,
} from '../../src/cli/commands/transcript-backup.js';

const NOW = new Date('2026-07-01T09:08:07.000Z');

describe('deriveProjectSlug', () => {
  it('replaces every non-alnum char with a dash (Claude Code project slug)', () => {
    expect(deriveProjectSlug('/Users/orzech/Dropbox/home/repos/groundnuty/macf')).toBe(
      '-Users-orzech-Dropbox-home-repos-groundnuty-macf',
    );
  });
  it('handles the Linux launch-cwd form (matches whatever cwd claude used)', () => {
    expect(deriveProjectSlug('/home/ubuntu/repos/groundnuty/macf')).toBe(
      '-home-ubuntu-repos-groundnuty-macf',
    );
  });
});

describe('compactTimestamp / backupFileName', () => {
  it('formats YYYYMMDD_HHMMSS in UTC', () => {
    expect(compactTimestamp(NOW)).toBe('20260701_090807');
  });
  it('reuses /compact\'s <uuid>.<ts>.jsonl.bak naming', () => {
    expect(backupFileName('abc-123', NOW)).toBe('abc-123.20260701_090807.jsonl.bak');
  });
});

describe('backupSubdir', () => {
  it('keeps the canonical <project>@<label> session shape, sanitizes the rest', () => {
    expect(backupSubdir('macf@code-agent')).toBe('macf@code-agent');
    expect(backupSubdir('weird/sess name')).toBe('weird_sess_name');
  });
});

describe('selectBackupsToPrune', () => {
  const mk = (name: string, mtimeMs: number): BackupFileInfo => ({ name, mtimeMs });
  it('keeps the newest N by mtime, returns the rest to prune', () => {
    const backups = [mk('a', 100), mk('b', 500), mk('c', 300), mk('d', 400), mk('e', 200)];
    // newest-first: b(500) d(400) c(300) e(200) a(100); keep 3 → prune e,a
    expect(selectBackupsToPrune(backups, 3).sort()).toEqual(['a', 'e']);
  });
  it('prunes nothing when at/under the keep count', () => {
    expect(selectBackupsToPrune([mk('a', 100), mk('b', 200)], 5)).toEqual([]);
  });
  it('keep=0 prunes everything', () => {
    expect(selectBackupsToPrune([mk('a', 1), mk('b', 2)], 0).sort()).toEqual(['a', 'b']);
  });
});

// --- Fake TranscriptDeps -----------------------------------------------------

interface FakeState {
  readonly launchCwd: string;
  readonly projectsDir: string;
  readonly backupRoot: string;
  readonly keep: number;
  transcripts: TranscriptFileInfo[];
  backups: BackupFileInfo[];
}

interface FakeRec {
  copied: { src: string; dest: string }[];
  removed: string[];
  written: { path: string; content: string }[];
  mkdirs: string[];
}

function fakeDeps(over: Partial<FakeState> = {}): {
  deps: TranscriptDeps;
  rec: FakeRec;
  state: FakeState;
} {
  const state: FakeState = {
    launchCwd: '/Users/orzech/Dropbox/home/repos/groundnuty/macf',
    projectsDir: '/home/ubuntu/.claude/projects',
    backupRoot: '/home/ubuntu/.macf/session-backups',
    keep: 5,
    transcripts: [],
    backups: [],
    ...over,
  };
  const rec: FakeRec = { copied: [], removed: [], written: [], mkdirs: [] };
  const deps: TranscriptDeps = {
    launchCwd: () => state.launchCwd,
    claudeProjectsDir: () => state.projectsDir,
    sessionBackupDir: () => state.backupRoot,
    backupKeep: () => state.keep,
    listTranscripts: () => state.transcripts,
    listBackups: () => state.backups,
    copyFile: (src, dest) => {
      rec.copied.push({ src, dest });
    },
    removeFile: (path) => {
      rec.removed.push(path);
    },
    writeFile: (path, content) => {
      rec.written.push({ path, content });
    },
    mkdirp: (path) => {
      rec.mkdirs.push(path);
    },
  };
  return { deps, rec, state };
}

describe('findActiveTranscript', () => {
  it('picks the most-recent-mtime .jsonl under the derived slug dir', () => {
    const { deps } = fakeDeps({
      transcripts: [
        { name: 'old.jsonl', mtimeMs: 100, size: 10 },
        { name: 'active.jsonl', mtimeMs: 900, size: 42 },
        { name: 'mid.jsonl', mtimeMs: 500, size: 20 },
      ],
    });
    const a = findActiveTranscript(deps);
    expect(a).not.toBeNull();
    expect(a!.uuid).toBe('active');
    expect(a!.size).toBe(42);
    expect(a!.projectDir).toBe(
      '/home/ubuntu/.claude/projects/-Users-orzech-Dropbox-home-repos-groundnuty-macf',
    );
  });
  it('returns null when the slug dir has no transcripts', () => {
    expect(findActiveTranscript(fakeDeps().deps)).toBeNull();
  });
});

describe('backupSessionTranscript', () => {
  const PRESTATE = '/ws/.claude/.macf/restart-self-session-prestate.env';

  it('copies the active transcript into a per-session rotating backup + writes pre-state', () => {
    const { deps, rec } = fakeDeps({
      transcripts: [{ name: 'sess-uuid.jsonl', mtimeMs: 1_751_360_887_000, size: 123 }],
    });
    const pre = backupSessionTranscript(deps, 'macf@code-agent', PRESTATE, NOW);
    expect(pre).not.toBeNull();

    // backup dir is per-session under the backup root; the copy uses /compact naming.
    const expectedDir = '/home/ubuntu/.macf/session-backups/macf@code-agent';
    expect(rec.mkdirs).toContain(expectedDir);
    expect(rec.copied).toHaveLength(1);
    expect(rec.copied[0].src).toBe(
      '/home/ubuntu/.claude/projects/-Users-orzech-Dropbox-home-repos-groundnuty-macf/sess-uuid.jsonl',
    );
    expect(rec.copied[0].dest).toBe(
      `${expectedDir}/sess-uuid.20260701_090807.jsonl.bak`,
    );

    // pre-state summary + mtime floored to seconds.
    expect(pre!.uuid).toBe('sess-uuid');
    expect(pre!.size).toBe(123);
    expect(pre!.mtimeSec).toBe(1_751_360_887);

    // pre-state file is written for the relauncher (shell-sourceable).
    const written = rec.written.find((w) => w.path === PRESTATE);
    expect(written).toBeDefined();
    expect(written!.content).toContain('MACF_RESTART_PRE_UUID=\'sess-uuid\'');
    expect(written!.content).toContain('MACF_RESTART_PRE_SIZE=123');
    expect(written!.content).toContain('MACF_RESTART_PRE_MTIME=1751360887');
  });

  it('rotates — prunes backups past keep-N (counting the just-written one)', () => {
    const existing: BackupFileInfo[] = [
      { name: 'u.20260701_090000.jsonl.bak', mtimeMs: 6 },
      { name: 'u.20260630_090000.jsonl.bak', mtimeMs: 5 },
      { name: 'u.20260629_090000.jsonl.bak', mtimeMs: 4 },
    ];
    const { deps, rec } = fakeDeps({
      keep: 2,
      transcripts: [{ name: 'u.jsonl', mtimeMs: 7000, size: 1 }],
      backups: existing,
    });
    backupSessionTranscript(deps, 'macf@code-agent', PRESTATE, NOW);
    // keep newest 2 (mtime 6,5) → prune the mtime-4 one.
    expect(rec.removed).toEqual([
      '/home/ubuntu/.macf/session-backups/macf@code-agent/u.20260629_090000.jsonl.bak',
    ]);
  });

  it('is a no-op (returns null, no copy/write) when there is no active transcript', () => {
    const { deps, rec } = fakeDeps({ transcripts: [] });
    expect(backupSessionTranscript(deps, 'macf@code-agent', PRESTATE, NOW)).toBeNull();
    expect(rec.copied).toEqual([]);
    expect(rec.written).toEqual([]);
  });
});

describe('renderPreStateFile', () => {
  it('emits shell-sourceable KEY=VALUE the relauncher can `. source`', () => {
    const content = renderPreStateFile({
      projectDir: "/p/it's-tricky",
      uuid: 'u1',
      size: 999,
      mtimeSec: 1_751_360_887,
      backupDir: '/b/macf@code-agent',
      backupPath: '/b/macf@code-agent/u1.20260701_090807.jsonl.bak',
    });
    expect(content).toContain('MACF_RESTART_PRESTATE_VERSION=1');
    // single-quote escaping keeps a literal apostrophe safe for `.`-sourcing.
    expect(content).toContain("MACF_RESTART_PROJECT_DIR='/p/it'\\''s-tricky'");
    expect(content).toContain("MACF_RESTART_BACKUP_DIR='/b/macf@code-agent'");
  });
});
