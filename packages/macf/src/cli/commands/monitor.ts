/**
 * `macf monitor` — read-only auditor Monitor + digest-to-operator
 * (groundnuty/macf#502, DR-026 F4).
 *
 * Reads a project's coordination substrate (GitHub open issues + PRs, F2
 * reflection ledgers, project-tier rule presence) and emits a periodic
 * protocol-health digest to stdout or a `--output` file.
 *
 * THE LOAD-BEARING INVARIANT — strictly read-only. This command NEVER mutates:
 * no issue/PR create, comment, close, edit, or merge. It issues only GitHub
 * READS (via the list-only `GitHubReader` seam) + local-file reads, and writes
 * only the digest artifact itself. This is the SAFE half of the MAPE-K loop; the
 * Analyze→Plan→propose half is a separate, ratification-gated issue (DR-026 G1).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import { generateToken } from '@groundnuty/macf-core';
import { createGhReader } from '../monitor/github-reader.js';
import { runMonitor } from '../monitor/run.js';

export interface MonitorCliOptions {
  /** owner/repo; defaults to the project's `repo` registry config. */
  readonly repo?: string;
  /** Stale threshold in days (default 14). */
  readonly since?: number;
  /** Write the digest here instead of stdout. */
  readonly output?: string;
  /** Reflections ledger dir; defaults to `<project>/.claude/.macf/reflections`. */
  readonly reflectionsDir?: string;
}

/**
 * Derive a default `owner/repo` from the project's registry config when the
 * operator didn't pass `--repo`. Only the `repo` registry type carries an
 * owner/repo pair; other types (org/profile/local) have no canonical repo, so
 * we require `--repo` there.
 */
function defaultRepo(
  registry: { readonly type: string; readonly owner?: string; readonly repo?: string },
): string | null {
  if (registry.type === 'repo' && registry.owner && registry.repo) {
    return `${registry.owner}/${registry.repo}`;
  }
  return null;
}

/**
 * Entry for `macf monitor`. Returns the shell exit code (0 ok, 1 on a
 * config/repo/read error).
 */
export async function runMonitorCommand(
  projectDir: string,
  opts: MonitorCliOptions,
): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }

  const repo = opts.repo ?? defaultRepo(config.registry);
  if (!repo) {
    console.error(
      'Could not determine target repo. Pass --repo <owner/repo> ' +
      '(the project\'s registry type carries no owner/repo pair).',
    );
    return 1;
  }

  // Mint the bot token the same way every other GitHub-reading command does.
  // Local-registry projects have no github_app block; tokenSourceFromConfig
  // throws there, so guide the operator to the bot-auth fallback.
  let token: string;
  try {
    token = await generateToken(tokenSourceFromConfig(projectDir, config));
  } catch (err) {
    console.error(
      `Could not mint a GitHub token: ${err instanceof Error ? err.message : String(err)}\n` +
      'For a local-registry project, set GH_TOKEN in the environment and re-run.',
    );
    // Fall back to an ambient GH_TOKEN if one is present — still read-only.
    const ambient = process.env['GH_TOKEN'];
    if (!ambient) return 1;
    token = ambient;
  }

  const sinceDays = opts.since ?? 14;
  const reflectionsDir = opts.reflectionsDir
    ? resolve(opts.reflectionsDir)
    : resolve(projectDir, '.claude', '.macf', 'reflections');

  let digest: string;
  try {
    digest = await runMonitor({
      project: config.project,
      repo,
      sinceDays,
      reflectionsDir,
      workspaceDir: projectDir,
      reader: createGhReader(token),
      now: Date.now,
    });
  } catch (err) {
    console.error(
      `Monitor read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (opts.output) {
    const outPath = resolve(opts.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, digest);
    console.error(`Digest written to ${outPath}`);
  } else {
    process.stdout.write(digest);
  }
  return 0;
}
