import { z } from 'zod';

// --- Notify payload (POST /notify body) ---

export const NotifyTypeSchema = z.enum([
  'issue_routed',
  'mention',
  'startup_check',
]);

export type NotifyType = z.infer<typeof NotifyTypeSchema>;

export const NotifyPayloadSchema = z.object({
  type: NotifyTypeSchema,
  issue_number: z.number().int().positive().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
});

export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

// --- Health response (GET /health body) ---

export const HealthResponseSchema = z.object({
  agent: z.string(),
  status: z.literal('online'),
  type: z.string(),
  uptime_seconds: z.number().int().nonnegative(),
  current_issue: z.number().int().positive().nullable(),
  version: z.string(),
  last_notification: z.string().nullable(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Agent config (parsed from env vars) ---

export interface AgentConfig {
  readonly agentName: string;
  readonly agentType: string;
  readonly agentRole: string;
  readonly host: string;
  readonly advertiseHost: string;
  readonly port: number;
  readonly caCertPath: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly debug: boolean;
  readonly logPath: string | undefined;
  readonly project: string;
  readonly instanceId: string;
  readonly registry: import('./registry/types.js').RegistryConfig;
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
}
