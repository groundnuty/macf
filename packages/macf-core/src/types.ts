import { z } from 'zod';

// --- Notify payload (POST /notify body) ---

export const NotifyTypeSchema = z.enum([
  'issue_routed',
  'mention',
  'startup_check',
  // `ci_completion` landed with macf-actions v2.0.1 / #122 — routed
  // by the macf-actions route-by-ci-completion job when a check_suite
  // completes on an agent-authored PR. Prior to this variant, the job
  // shoehorned the notification into `type: 'mention'` with
  // `source: 'ci_completion'` as a discriminator.
  'ci_completion',
  // `peer_notification` landed with macf#256 — sent by the channel
  // server's `notify_peer` MCP tool (DR-023 UC-1) when a hook fires
  // a peer-to-peer event (e.g., `Stop` hook → `event: "session-end"`).
  // Distinct from `mention` so observability surfaces (Tempo span
  // attributes, Langfuse op-name dimension) keep peer-notification
  // traffic separate from GitHub @mention routing — important for
  // Phase D / Claim 1b cell-effect measurements where conflating the
  // two would muddy framework-induced traffic signal.
  'peer_notification',
  // `pr_review_state` landed with macf-actions#39 (v3.3.0) — routed by
  // the route-by-pr-review-state job when a PR review is submitted
  // (action=submitted) with state in {approved, changes_requested}.
  // Receiver is the PR author's channel-server. Closes the LGTM→merge
  // handoff gap that was the final cv-e2e-test cascade cause: routing-
  // Action's pre-#39 event coverage didn't fire when reviewers approved
  // without an explicit @<author>[bot] in the review body. The
  // structural state-change IS the notification.
  'pr_review_state',
]);

export type NotifyType = z.infer<typeof NotifyTypeSchema>;

// Check suite conclusions reaching the receiver — match GitHub's
// terminal check_suite states that macf-actions treats as actionable
// (see macf-actions#6 and agent-router.yml).
export const CheckSuiteConclusionSchema = z.enum([
  'success', 'failure', 'timed_out', 'action_required',
]);

export type CheckSuiteConclusion = z.infer<typeof CheckSuiteConclusionSchema>;

export const NotifyPayloadSchema = z.object({
  type: NotifyTypeSchema,
  issue_number: z.number().int().positive().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
  // Origin repo of the routing event in `<owner>/<name>` form.
  // Added with macf-actions v3.2.0 (#30) so multi-homed receivers can
  // emit `--repo <repo>` instructions in the surfaced notification —
  // bare `gh issue view N` defaults to the agent's cwd-repo, which is
  // rarely the routing-source repo when an agent serves multiple
  // repos. Optional at the schema level for backward compat with
  // producers on macf-actions <v3.2.0.
  repo: z.string().optional(),
  // CI-completion variant fields (#122). All optional at the top
  // level to preserve backward compat with producers that only send
  // the base shape. Producers that want a type-narrowed shape for
  // ci_completion can validate against CiCompletionPayloadSchema
  // below before POST.
  pr_number: z.number().int().positive().optional(),
  pr_title: z.string().optional(),
  pr_url: z.string().url().optional(),
  conclusion: CheckSuiteConclusionSchema.optional(),
  failing_check_name: z.string().nullable().optional(),
  // peer_notification variant fields (macf#256, DR-023 UC-1). Optional
  // at the top level to preserve backward-compat with producers that
  // only send other variants. Producers (the channel-server's
  // `notify_peer` MCP tool) construct + validate against the narrower
  // PeerNotificationPayloadSchema below before POST.
  // macf#355: `event` field IS the wake-policy discriminator. Receiver-
  // side `decideWake()` reads `event === 'custom'` → wake; autonomous
  // events (session-end / turn-complete / error) → skip wake (Pattern E,
  // macf#267 Option d cross-agent Stop-hook loop prevention). The
  // previously-shipped `wake?: boolean` field was removed in v0.2.21
  // (one-release-cycle window post-v0.2.20) — it leaked Pattern E
  // implementation detail into the agent-facing API; the cleaner
  // design discriminates at the receiver from a property already there
  // for other reasons.
  event: z.enum(['session-end', 'turn-complete', 'error', 'custom']).optional(),
  // macf#473: optional owner/repo#N anchor a peer_notification nudge is tied to, for the comms-ledger graph join.
  github_anchor: z.string().optional(),
  // pr_review_state variant fields (macf-actions#39, v3.3.0). Optional
  // at the top level to preserve backward-compat. Producers (the
  // route-by-pr-review-state job) construct + validate against the
  // narrower PrReviewStatePayloadSchema below before POST. `pr_number`
  // and `pr_url` reuse the ci_completion variant's fields (same
  // semantic meaning); `review_state`, `reviewer_login`, `review_url`
  // are review-specific.
  review_state: z.enum(['approved', 'changes_requested']).optional(),
  reviewer_login: z.string().optional(),
  review_url: z.string().url().optional(),
});

export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

/**
 * Narrower schema for `ci_completion` payloads (#122). Producers
 * (notably the macf-actions route-by-ci-completion job, v2.0.1+)
 * should construct-and-validate against this schema for type-level
 * clarity, then send over the wire. The receiver parses against the
 * wider `NotifyPayloadSchema` (backward-compat across variants) and
 * narrows via the `type === 'ci_completion'` discriminator.
 *
 * Required fields: everything the receiver needs to render the
 * notification WITHOUT falling back to free-form `message` parsing.
 * `failing_check_name` is null when conclusion is 'success'; string
 * otherwise.
 */
export const CiCompletionPayloadSchema = z.object({
  type: z.literal('ci_completion'),
  source: z.literal('ci_completion'),
  pr_number: z.number().int().positive(),
  pr_title: z.string(),
  pr_url: z.string().url(),
  conclusion: CheckSuiteConclusionSchema,
  failing_check_name: z.string().nullable(),
  message: z.string(),
});

export type CiCompletionPayload = z.infer<typeof CiCompletionPayloadSchema>;

/**
 * Narrower schema for `peer_notification` payloads (macf#256, DR-023 UC-1).
 * Producers (the channel server's `notify_peer` MCP tool) construct +
 * validate against this before POST. Receivers parse via the wider
 * `NotifyPayloadSchema` (backward-compat) and narrow via the
 * `type === 'peer_notification'` discriminator.
 *
 * `event` distinguishes the triggering hook context (per DR-023 §UC-1
 * inputSchema). `source` is the sending peer's agent name. `message`
 * is optional human-readable; `context` is optional structured payload.
 */
export const PeerNotificationPayloadSchema = z.object({
  type: z.literal('peer_notification'),
  source: z.string().min(1),
  event: z.enum(['session-end', 'turn-complete', 'error', 'custom']),
  message: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  // macf#355: receiver-side wake policy reads `event === 'custom'` only.
  // No flag-on-the-wire — Pattern E (cross-agent Stop-hook loop
  // prevention) is enforced by the receiver's `decideWake()` from
  // `event` alone, removing per-call sender-side wake leakage.
});

export type PeerNotificationPayload = z.infer<typeof PeerNotificationPayloadSchema>;

/**
 * Narrower schema for `pr_review_state` payloads (macf-actions#39, v3.3.0).
 * Producers (the route-by-pr-review-state job) construct + validate against
 * this before POST. Receivers parse via the wider `NotifyPayloadSchema`
 * (backward-compat) and narrow via the `type === 'pr_review_state'`
 * discriminator.
 *
 * `review_state` discriminates the actionable verb at the receiver:
 *   - `approved`         → PR author can react with merge
 *   - `changes_requested` → PR author can react with fix
 *
 * `reviewer_login` is the reviewer's bot login (e.g., `cv-architect[bot]`)
 * so the rendered notification surfaces who acted. `pr_number` + `pr_url`
 * locate the work unit. `review_url` deep-links to the review comment for
 * receivers that want to fetch the body programmatically (optional —
 * cheap to include, free at the receiver if unused).
 *
 * The job filters at the workflow layer to action=submitted only (per
 * issue#39 design Q3 disposition — dismissed reviews are out-of-scope at
 * v3.3.0). State filter is workflow-side too; the schema only carries the
 * narrowed enum so receivers don't need to re-validate.
 */
export const PrReviewStatePayloadSchema = z.object({
  type: z.literal('pr_review_state'),
  review_state: z.enum(['approved', 'changes_requested']),
  reviewer_login: z.string().min(1),
  pr_number: z.number().int().positive(),
  pr_url: z.string().url(),
  review_url: z.string().url().optional(),
});

export type PrReviewStatePayload = z.infer<typeof PrReviewStatePayloadSchema>;

// --- Health response (GET /health body) ---

export const HealthResponseSchema = z.object({
  agent: z.string(),
  status: z.literal('online'),
  type: z.string(),
  uptime_seconds: z.number().int().nonnegative(),
  current_issue: z.number().int().positive().nullable(),
  version: z.string(),
  last_notification: z.string().nullable(),
  // DR-030 phase-1 (mesh self-report). Additive + `.optional()` so a newer
  // parser still validates an older agent's /health body that lacks these
  // (mixed-version fleets during rollout); `.nullable()` for the absent-value
  // case (e.g. cert unreadable). The #553 collision parser reads only
  // `version` + liveness, so these don't affect it.
  instance_id: z.string().nullable().optional(),
  cert_expiry: z.string().nullable().optional(),
  // DR-030 phase-1 increment B (mesh self-report — live agent turn-state).
  // Read from the `${MACF_WORKSPACE_DIR}/.macf/turn-state.json` marker that
  // plugin hooks write. `.nullable()` for the absent/garbage-marker case
  // (server idle, marker missing, or unparseable → null) and `.optional()`
  // so a newer parser still validates an older agent's /health body that
  // predates this field. `elapsed_ms` is computed live (now − started_at)
  // on each /health call so it grows through a long tool wait.
  state: z.object({
    status: z.enum(['busy', 'idle']),
    turn_number: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    phase: z.enum(['thinking', 'tool']).nullable(),
    current_tool: z.string().nullable(),
    current_command: z.string().nullable(),
    last_turn_duration_ms: z.number().int().nonnegative().nullable(),
    tool_use_count: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
  }).nullable().optional(),
  // DR-030 phase-1 increment B (the server's own OTLP exporter self-report).
  // `endpoint` is the live `OTEL_EXPORTER_OTLP_ENDPOINT`; `endpoint_is_canonical`
  // is an env-driven comparison (see health.ts `computeOtelEndpointInfo`);
  // `endpoint_reachable` is a cached best-effort background TCP probe result.
  // Same `.nullable().optional()` back-compat posture as `state`.
  otel: z.object({
    endpoint: z.string().nullable(),
    endpoint_is_canonical: z.boolean(),
    endpoint_reachable: z.boolean(),
  }).nullable().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Agent config (parsed from env vars) ---

export interface AgentConfig {
  readonly agentName: string;
  /**
   * The routing identity — registry key + cert CN (macf#538). Distinct from
   * `agentName` (the OTEL bot-name): on the substrate `agentName` is
   * `macf-devops-agent` while `routingLabel` is `devops-agent`; on greenfield
   * agents they coincide. Sourced from `MACF_ROUTING_LABEL`, defaulting to
   * `agentName` (back-compat). Use this — not `agentName` — for registry
   * register/remove/collision lookups.
   */
  readonly routingLabel: string;
  readonly agentType: string;
  readonly agentRole: string;
  readonly host: string;
  readonly advertiseHost: string;
  readonly port: number;
  readonly caCertPath: string;
  readonly caKeyPath: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly debug: boolean;
  readonly logPath: string | undefined;
  readonly project: string;
  readonly instanceId: string;
  readonly registry: import('./registry/types.js').RegistryConfig;
  /**
   * Workspace root directory. Used to locate helper scripts
   * (.claude/scripts/tmux-send-to-claude.sh) for the on-notify tmux
   * wake path (macf#185). Sourced from the `MACF_WORKSPACE_DIR` env
   * that claude.sh exports.
   */
  readonly workspaceDir: string | undefined;
  /**
   * Tmux session:window target for on-notify wake via
   * `tmux-send-to-claude.sh`. Optional — when unset, the wake path
   * auto-detects from `$TMUX` + `tmux display-message`, and no-ops
   * outside tmux entirely. See macf#185 + `src/tmux-wake.ts`.
   */
  readonly tmuxSession: string | undefined;
  readonly tmuxWindow: string | undefined;
}

// --- Sign request (POST /sign body) ---
//
// Two-step challenge-response (DR-010, security fix per #80).
// Step 1: `{csr, agent_name, project?}` (no challenge_done, no challenge_id).
// Step 2: `{csr, agent_name, project?, challenge_done: true, challenge_id}`.
//
// Step 2 MUST include the `challenge_id` the server returned in step 1,
// and the client MUST have written the expected value to the registry
// using its own token. See src/certs/challenge.ts for the full protocol.

export const SignRequestSchema = z.object({
  csr: z.string().min(1),
  agent_name: z.string().min(1),
  project: z.string().optional(),
  challenge_done: z.boolean().optional(),
  challenge_id: z.string().uuid().optional(),
}).refine(
  (req) => !req.challenge_done || !!req.challenge_id,
  { message: 'challenge_id is required when challenge_done is true' },
);

export type SignRequest = z.infer<typeof SignRequestSchema>;

// --- Sign responses ---

export const SignChallengeResponseSchema = z.object({
  challenge_id: z.string(),
  instruction: z.string(),
});

export const SignCertResponseSchema = z.object({
  cert: z.string(),
});

// --- Notify endpoint response ---

export const NotifyResponseSchema = z.object({
  status: z.literal('received'),
});

// --- Error response ---

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

// --- Logger interface ---

export interface Logger {
  readonly info: (event: string, data?: Record<string, unknown>) => void;
  readonly warn: (event: string, data?: Record<string, unknown>) => void;
  readonly error: (event: string, data?: Record<string, unknown>) => void;
}

// --- MCP channel interface ---

export interface McpChannel {
  readonly connect: () => Promise<void>;
  readonly pushNotification: (content: string, meta: Record<string, string>) => Promise<void>;
}

// --- HTTPS server interface ---

export interface HttpsServer {
  readonly start: (port: number, host: string) => Promise<{ readonly actualPort: number }>;
  readonly stop: () => Promise<void>;
}

// --- Health state interface ---

export interface HealthState {
  readonly getHealth: () => HealthResponse;
  readonly setCurrentIssue: (issueNumber: number | null) => void;
  readonly recordNotification: () => void;
  /**
   * Release any background resources (e.g. the DR-030 OTLP-reachability probe
   * interval). Optional + idempotent so existing constructors/mocks that don't
   * hold resources stay valid; the shutdown handler calls it best-effort.
   */
  readonly dispose?: () => void;
}
