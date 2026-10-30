/**
 * Guard: every external program the apply path spawns, and every non-POSIX program the hook scripts
 * and the launcher run, is checked by preflight or excluded with a reason.
 *
 * Source-shape scan, with limits:
 * - TypeScript: finds spawn/exec calls whose FIRST argument is a string literal, in the files reachable
 *   by relative imports from the bootstrap commands. A command name held in a variable is not seen.
 * - Shell: finds command-position uses of a fixed list of well-known external programs, plus any
 *   `command -v X` guard. A tool outside that list that is called without a guard is not seen.
 * A scan cannot prove completeness; it catches the usual way a dependency is added.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPLY_HOST_CHECKED, AGENT_HOST_TOOLS, EXCLUDED_PROGRAMS, POSIX_UTILITIES } from '../../src/cli/bootstrap/preflight-programs.js';

const ROOT = resolve(__dirname, '../..');
const KNOWN = new Set<string>([...APPLY_HOST_CHECKED, ...AGENT_HOST_TOOLS, ...Object.keys(EXCLUDED_PROGRAMS), ...POSIX_UTILITIES]);

function commandEntries(): string[] {
  const dir = resolve(ROOT, 'src/cli/commands');
  return readdirSync(dir).filter((f) => /^bootstrap.*\.ts$/.test(f)).map((f) => resolve(dir, f));
}

function reachableSources(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf-8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
      const p = resolve(dirname(f), (m[1] ?? '').replace(/\.js$/, '.ts'));
      if (existsSync(p)) queue.push(p);
    }
  }
  return [...seen];
}

const SPAWN_CALL = /\b(?:execFile\w*|spawn\w*|execSync|exec|tryExec)\(\s*'([^']+)'/g;

export function spawnedPrograms(files: readonly string[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf-8').matchAll(SPAWN_CALL)) {
      if (m[1] !== undefined && !found.has(m[1])) found.set(m[1], f.replace(`${ROOT}/`, ''));
    }
  }
  return found;
}

const SHELL_WATCH = ['jq', 'curl', 'openssl', 'git', 'gh', 'tmux', 'node', 'python3', 'python', 'perl', 'ruby', 'ssh', 'scp', 'rsync', 'wget', 'nc', 'pgrep', 'pkill', 'flock', 'crontab', 'yq', 'xxd', 'base64', 'uuidgen', 'timeout', 'gtimeout', 'realpath', 'readlink', 'sha256sum', 'shasum', 'md5sum', 'md5', 'stat', 'ps', 'lsof'];
const SHELL_COMMAND_POSITION = new RegExp(`(?:^\\s*['"]?\\s*|\\$\\(\\s*|\\|\\|?\\s*|&&\\s*|;\\s*|\`\\s*|\\bthen\\s+|\\bdo\\s+|\\belse\\s+|\\bif\\s+!?\\s*)(${SHELL_WATCH.join('|')})(?=\\s|$|\\))`, 'g');
const SHELL_GUARD = /command -v\s+([A-Za-z][\w.-]*)(?=\s*(?:>|&&|\|\||\)|;|$))/g;

export function shellPrograms(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  let heredoc: string | undefined;
  for (const raw of text.split('\n')) {
    if (heredoc !== undefined) {
      if (raw.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const here = /<<-?\s*['"]?(\w+)['"]?/.exec(raw);
    const line = raw.replace(/^\s*(?:['"]\s*)?#.*$/, '');
    if (here?.[1] !== undefined) heredoc = here[1];
    for (const m of line.matchAll(SHELL_COMMAND_POSITION)) if (m[1] !== undefined) found.add(m[1]);
    for (const m of line.matchAll(SHELL_GUARD)) if (m[1] !== undefined) found.add(m[1]);
  }
  return found;
}

function shellSources(): string[] {
  const out: string[] = [];
  for (const dir of ['plugin/scripts', 'scripts']) {
    for (const f of readdirSync(resolve(ROOT, dir))) {
      if (f.endsWith('.sh') && !f.endsWith('.test.sh') && (dir === 'plugin/scripts' || /^(macf-|tmux-send)/.test(f))) out.push(resolve(ROOT, dir, f));
    }
  }
  return [...out, resolve(ROOT, 'src/cli/claude-sh.ts'), resolve(ROOT, 'src/cli/env-files.ts')].filter(existsSync);
}

describe('preflight program coverage', () => {
  it('every program the apply path spawns is checked or excluded', () => {
    const found = spawnedPrograms(reachableSources(commandEntries()));
    expect(found.size).toBeGreaterThan(8); // the scan is connected: it saw gh, git, age and more
    const unlisted = [...found].filter(([name]) => !KNOWN.has(name)).map(([name, file]) => `${name} (${file})`);
    expect(unlisted, `add these to preflight-programs.ts and to a preflight check, or exclude with a reason: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('every non-POSIX program the hook scripts and launcher run is checked or excluded', () => {
    const unlisted: string[] = [];
    let total = 0;
    for (const f of shellSources()) {
      const progs = shellPrograms(readFileSync(f, 'utf-8'));
      total += progs.size;
      for (const p of progs) if (!KNOWN.has(p)) unlisted.push(`${p} (${f.replace(`${ROOT}/`, '')})`);
    }
    expect(total).toBeGreaterThan(10); // the scan is connected: it saw jq, git, curl and more
    expect(unlisted, `add these to preflight-programs.ts and to the agent-host probe, or exclude with a reason: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('the scans would flag a new program (they are not vacuous)', () => {
    expect([...shellPrograms('x=$(yq -r .a file)\nif ! command -v frobnicate >/dev/null; then :; fi\nfoo | python3 -c x')].sort()).toEqual(['frobnicate', 'python3', 'yq']);
    expect(shellPrograms('# jq in a comment\ncat <<EOF\njq in a heredoc\nEOF\n').size).toBe(0);
  });

  it('every excluded program carries a reason, and none is also checked', () => {
    for (const [name, why] of Object.entries(EXCLUDED_PROGRAMS)) {
      expect(why.length, name).toBeGreaterThan(10);
      expect([...APPLY_HOST_CHECKED, ...AGENT_HOST_TOOLS] as string[]).not.toContain(name);
    }
  });

  it('the agent-host probe script names every agent-host tool', () => {
    const probe = readFileSync(resolve(ROOT, 'src/cli/bootstrap/preflight-agent-host.ts'), 'utf-8');
    expect(probe).toContain("import { AGENT_HOST_TOOLS } from './preflight-programs.js'");
  });
});
