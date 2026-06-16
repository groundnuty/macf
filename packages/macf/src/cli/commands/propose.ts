/**
 * `macf propose` — the auditor Plan membrane (groundnuty/macf#503, DR-026 G1).
 *
 * Pairs with `macf monitor` (the Analyze stage): turns F4's reflection output
 * into RATIFIABLE rule-evolution proposals. This is the highest-blast-radius
 * piece of the auditor's double-loop curated generative evolution.
 *
 * THREE LOAD-BEARING GATES:
 *   1. N>1 = distinct AGENTS, not occurrences — only candidates corroborated
 *      across ≥ `--min-agents` distinct `agent.name`s promote; the rest are HELD
 *      (visible, never dropped). [in `candidates.ts`]
 *   2. Dry-run by DEFAULT — the default emits a report and opens NOTHING; only
 *      an explicit `--file` opens ratifiable artifacts. [enforced here + in run.ts]
 *   3. No-auto-drop on invariant-touch — candidates touching/relaxing a
 *      protected invariant are SURFACED + HIGH-RISK-flagged, never code-dropped.
 *      [in `candidates.ts` + `report.ts`]
 *
 * Dry-run mode performs ZERO GitHub I/O (no token needed). `--file` mode mints a
 * bot token (or uses ambient `GH_TOKEN`) and opens one `auditor-proposal` issue
 * per promoted candidate via the create-only writer seam. The operator ratifies;
 * the auditor never merges/applies (invariants #8 + #9).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import { generateToken } from '@groundnuty/macf-core';
import { runPropose } from '../propose/run.js';
import { createGhProposalWriter } from '../propose/proposal-writer.js';

export interface ProposeCliOptions {
  /** owner/repo target; defaults to the project's `repo` registry config when present. */
  readonly repo?: string;
  /** Distinct-agent threshold (GATE 1). Defaults to env/2 (resolved in index.ts). */
  readonly minAgents?: number;
  /** Reflections ledger dir; defaults to `<projectDir>/.claude/.macf/reflections`. */
  readonly reflectionsDir?: string;
  /** Framework-source repo root for `design/protected-invariants.md`. */
  readonly repoRoot?: string;
  /** Write the report here instead of stdout. */
  readonly output?: string;
  /** When true, OPEN ratifiable artifacts. DEFAULT OFF (dry-run). */
  readonly file?: boolean;
  /** Project directory for config lookup (defaults handled by caller). */
  readonly projectDir: string;
}

/**
 * Derive a default `owner/repo` from a project's registry config when present.
 * The macf substrate has no `.macf/macf-agent.json`, so config may be absent —
 * then the operator must pass `--repo` (only strictly needed in `--file` mode).
 */
function defaultRepo(projectDir: string): string | null {
  const config = readAgentConfig(projectDir);
  if (config && config.registry.type === 'repo' && config.registry.owner && config.registry.repo) {
    return `${config.registry.owner}/${config.registry.repo}`;
  }
  return null;
}

/**
 * Discover the framework-source repo root: walk up from `start` looking for
 * `design/protected-invariants.md`. Falls back to `start` when not found (the
 * subordination-check then surfaces nothing — loud-but-proceeds).
 */
function discoverRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'design', 'protected-invariants.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Entry for `macf propose`. Returns the shell exit code (0 ok, 1 on error).
 */
export async function runProposeCommand(opts: ProposeCliOptions): Promise<number> {
  const fileMode = opts.file === true;

  const repo = opts.repo ?? defaultRepo(opts.projectDir) ?? undefined;
  // `--repo` is only strictly required when we will actually open issues.
  if (fileMode && !repo) {
    console.error(
      'Could not determine target repo for --file mode. Pass --repo <owner/repo>.',
    );
    return 1;
  }

  const reflectionsDir = opts.reflectionsDir
    ? resolve(opts.reflectionsDir)
    : resolve(opts.projectDir, '.claude', '.macf', 'reflections');

  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : discoverRepoRoot(opts.projectDir);

  // GATE 2 — only --file mode touches GitHub, so only it needs a token.
  let writer;
  if (fileMode) {
    let token: string | undefined;
    const config = readAgentConfig(opts.projectDir);
    if (config) {
      try {
        token = await generateToken(tokenSourceFromConfig(opts.projectDir, config));
      } catch {
        token = undefined;
      }
    }
    if (!token) token = process.env['GH_TOKEN'];
    if (!token) {
      console.error(
        '--file mode needs a bot token. Either run in a configured MACF project ' +
        'or set GH_TOKEN in the environment.',
      );
      return 1;
    }
    writer = createGhProposalWriter(token);
  }

  let result;
  try {
    result = await runPropose({
      project: readAgentConfig(opts.projectDir)?.project ?? repo ?? 'project',
      repo: repo ?? '(unset — dry-run)',
      reflectionsDir,
      repoRoot,
      minAgents: opts.minAgents,
      fileMode,
      writer,
    });
  } catch (err) {
    console.error(
      `Propose failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (opts.output) {
    const outPath = resolve(opts.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.report);
    console.error(`Report written to ${outPath}`);
  } else {
    process.stdout.write(result.report);
  }

  if (fileMode) {
    for (const c of result.created) {
      console.error(`Opened proposal: ${c.url}`);
    }
    console.error(
      `--file mode: ${result.created.length} ratifiable auditor-proposal issue(s) opened.`,
    );
  }

  return 0;
}
