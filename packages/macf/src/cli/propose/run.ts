/**
 * Plan-membrane orchestrator for the auditor (groundnuty/macf#503, DR-026 G1).
 *
 * Reads F2 reflection ledgers (reusing F4's reflections reader), loads the
 * ratified protected-invariant set, runs the deterministic candidate pipeline
 * (distinct-agent GATE 1 + tier-router + invariant subordination-check GATE 3),
 * and then EITHER:
 *
 *   - dry-run (DEFAULT): returns a Markdown report (opens NOTHING); or
 *   - `--file`: opens one ratifiable proposal issue per promoted candidate via
 *     the injectable create-only writer seam, then returns the report.
 *
 * GATE 2 (dry-run-by-default) is enforced here: the writer is invoked ONLY when
 * `fileMode` is true. In the default path the writer is never touched — tests
 * inject a recording writer and assert zero creates by default.
 *
 * The writer is OPTIONAL in the options: dry-run callers pass none. When
 * `fileMode` is true a writer MUST be supplied (the command wires the real one).
 */
import { readReflections } from '../monitor/reflections.js';
import { loadInvariants } from './invariants.js';
import { buildCandidates, DEFAULT_MIN_AGENTS, type ProposalCandidate } from './candidates.js';
import { buildReport, buildProposalIssueInput } from './report.js';
import type { ProposalIssueWriter } from './proposal-writer.js';

export interface RunProposeOptions {
  readonly project: string;
  readonly repo: string;
  /** Directory holding the F2 reflection JSONL ledgers. */
  readonly reflectionsDir: string;
  /**
   * Framework-source repo root where `design/protected-invariants.md` lives.
   * The subordination-check surfaces against this set; absence is loud-but-proceeds.
   */
  readonly repoRoot: string;
  /** Distinct-agent threshold for GATE 1 (default `DEFAULT_MIN_AGENTS`). */
  readonly minAgents?: number;
  /** When true, OPEN ratifiable artifacts via the writer. Default false (dry-run). */
  readonly fileMode: boolean;
  /**
   * Create-only writer seam. REQUIRED when `fileMode` is true; ignored in
   * dry-run (and must never be invoked there — GATE 2).
   */
  readonly writer?: ProposalIssueWriter;
}

/** What a single `--file` create produced (or the error that aborted it). */
export interface CreatedProposal {
  readonly title: string;
  readonly url: string;
}

export interface RunProposeResult {
  /** The Markdown report (always produced, in both modes). */
  readonly report: string;
  /** Issues opened in `--file` mode (empty in dry-run). */
  readonly created: readonly CreatedProposal[];
}

/**
 * Run the Plan membrane. Returns the report + any created proposals.
 *
 * Read side is pure filesystem; the only write path is the injected writer,
 * gated behind `fileMode` (GATE 2). A writer failure surfaces as a thrown error
 * to the caller (the CLI command), which decides how to report it.
 */
export async function runPropose(opts: RunProposeOptions): Promise<RunProposeResult> {
  const minAgents = opts.minAgents ?? DEFAULT_MIN_AGENTS;
  const reflections = readReflections(opts.reflectionsDir);
  const invariants = loadInvariants(opts.repoRoot);
  const candidates = buildCandidates(reflections.records, invariants, minAgents);

  const report = buildReport({
    project: opts.project,
    repo: opts.repo,
    candidates,
    fileMode: opts.fileMode,
    invariantsLoaded: invariants.length > 0,
    reflectionRecords: reflections.records.length,
    reflectionsSkipped: reflections.skipped,
    reflectionFiles: reflections.files,
  });

  // GATE 2 — the writer is touched ONLY in --file mode. The default path never
  // opens anything.
  if (!opts.fileMode) {
    return { report, created: [] };
  }

  if (!opts.writer) {
    throw new Error(
      'Internal error: --file mode requires a proposal writer but none was provided.',
    );
  }

  const created: CreatedProposal[] = [];
  for (const c of candidates.promoted as readonly ProposalCandidate[]) {
    const input = buildProposalIssueInput(opts.repo, c);
    const res = await opts.writer.createProposalIssue(input);
    created.push({ title: input.title, url: res.url });
  }

  return { report, created };
}
