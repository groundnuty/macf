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
