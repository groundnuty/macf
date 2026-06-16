/**
 * Create-only GitHub seam for the auditor Plan membrane
 * (groundnuty/macf#503, DR-026 G1).
 *
 * THE LOAD-BEARING INVARIANT (mirror of F4's read-only `GitHubReader`, inverted
 * for creation): the Plan membrane may, under an explicit `--file` flag, OPEN
 * ratifiable proposal artifacts — but it may do NOTHING else. This interface
 * exposes ONLY `createProposalIssue`. There is deliberately NO merge / close /
 * edit / comment / label-mutate / delete method on the seam, so any
 * non-proposal mutation is *unrepresentable* through the type. This is invariant
 * #8 (auditor-never-acts) enforced structurally at the type boundary: the
 * auditor proposes, the operator ratifies — the auditor can never apply.
 *
 * The default implementation shells out to `gh issue create` via `execFile` (a
 * single create per candidate, with the `auditor-proposal` label). The token is
 * passed via `GH_TOKEN` in the subprocess env (the house bot-auth posture),
 * never baked into a remote or used for any other op.
 *
 * Tests inject a fake implementation and assert it received CREATES only (and
 * zero creates in the default dry-run mode).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The label every auditor-opened proposal issue carries (for filtering). */
export const PROPOSAL_LABEL = 'auditor-proposal';

/** Input to open a single ratifiable proposal issue. */
export interface ProposalIssueInput {
  readonly repo: string;
  readonly title: string;
  /** The full Markdown proposal body (assembled from agent-authored content). */
  readonly body: string;
  /** Labels to apply on creation; always includes `auditor-proposal`. */
  readonly labels: readonly string[];
}

/** Result of opening a proposal issue. */
export interface ProposalIssueResult {
  /** The created issue URL (or number) as returned by the creator. */
  readonly url: string;
}

/**
 * The create-only GitHub seam. Implementations MUST perform only issue
 * CREATION. The membrane depends on this interface (not on `gh` directly) so
 * tests can inject a fake + assert (a) zero creates in dry-run mode and (b)
 * create-only behaviour under `--file`.
 */
export interface ProposalIssueWriter {
  createProposalIssue(input: ProposalIssueInput): Promise<ProposalIssueResult>;
}

/**
 * Production writer: shells out to `gh issue create` for a SINGLE issue per
 * call. `token` is forwarded as `GH_TOKEN` in the subprocess env (canonical bot
 * auth). This class has no merge/close/edit/comment path at all — issue creation
 * is the only operation it can perform.
 */
export function createGhProposalWriter(token: string): ProposalIssueWriter {
  const env = { ...process.env, GH_TOKEN: token };

  return {
    async createProposalIssue(input: ProposalIssueInput): Promise<ProposalIssueResult> {
      const labelArgs: string[] = [];
      for (const label of input.labels) {
        labelArgs.push('--label', label);
      }
      const { stdout } = await execFileAsync(
        'gh',
        [
          'issue', 'create',
          '--repo', input.repo,
          '--title', input.title,
          '--body', input.body,
          ...labelArgs,
        ],
        { encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024 },
      );
      // `gh issue create` prints the new issue URL on stdout.
      return { url: stdout.trim() };
    },
  };
}
