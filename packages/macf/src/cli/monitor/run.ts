/**
 * Read-only Monitor orchestrator for the auditor (groundnuty/macf#502, DR-026 F4).
 *
 * Aggregates a project's coordination substrate — GitHub (open issues + open
 * PRs, via an injectable read-only seam), F2 reflection ledgers, and a defensive
 * project-tier rule count — and renders a protocol-health digest via the pure
 * `buildDigest`.
 *
 * Everything here is a READ. The GitHub seam is `GitHubReader` (list-only by
 * type); reflections + project-rule counts are filesystem reads. The clock is
 * injected so output is deterministic under test.
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDigest, type Clock } from './digest.js';
import type { GitHubReader } from './github-reader.js';
import { readReflections } from './reflections.js';

export interface RunMonitorOptions {
  readonly project: string;
  readonly repo: string;
  readonly sinceDays: number;
  /** Directory holding the F2 reflection JSONL ledgers. */
  readonly reflectionsDir: string;
  /**
   * Workspace root used to locate `.claude/rules/project/*.md` for the
   * (optional, defensive) project-tier rule count. F3 (`project-rules.ts`) is
   * not on this branch, so we check the filesystem directly rather than import.
   */
  readonly workspaceDir: string;
  readonly reader: GitHubReader;
  readonly now: Clock;
}

/**
 * Count `.claude/rules/project/*.md` files. Defensive: returns 0 (never throws)
 * when the directory is absent — F3 isn't merged, so its absence is normal.
 */
export function countProjectRules(workspaceDir: string): number {
  const dir = join(workspaceDir, '.claude', 'rules', 'project');
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => {
      if (!f.endsWith('.md')) return false;
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Run the Monitor: read everything, build the digest, return the Markdown.
 *
 * Only READS are performed. Any GitHub read failure is surfaced as a thrown
 * error to the caller (the CLI command), which decides how to report it.
 */
export async function runMonitor(opts: RunMonitorOptions): Promise<string> {
  const [issues, prs] = await Promise.all([
    opts.reader.listOpenIssues(opts.repo),
    opts.reader.listOpenPRs(opts.repo),
  ]);

  const reflections = readReflections(opts.reflectionsDir);
  const projectRulesCount = countProjectRules(opts.workspaceDir);

  return buildDigest({
    project: opts.project,
    repo: opts.repo,
    sinceDays: opts.sinceDays,
    issues,
    prs,
    reflections: reflections.records,
    reflectionsSkipped: reflections.skipped,
    reflectionFiles: reflections.files,
    projectRulesCount,
    now: opts.now,
  });
}
