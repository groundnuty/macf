import { z } from 'zod';

// --- Agent registration info stored in GitHub variable ---

export const AgentInfoSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  type: z.enum(['permanent', 'worker']),
  instance_id: z.string(),
  started: z.string(),
});

export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// --- Registry interface ---

export interface Registry {
  readonly register: (name: string, info: AgentInfo) => Promise<void>;
  readonly get: (name: string) => Promise<AgentInfo | null>;
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>>;
  readonly remove: (name: string) => Promise<void>;
}

// --- Registry configuration ---

export const OrgRegistryConfigSchema = z.object({
  type: z.literal('org'),
  org: z.string().min(1),
});

export const ProfileRegistryConfigSchema = z.object({
  type: z.literal('profile'),
  user: z.string().min(1),
});

export const RepoRegistryConfigSchema = z.object({
  type: z.literal('repo'),
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const RegistryConfigSchema = z.union([
  OrgRegistryConfigSchema,
  ProfileRegistryConfigSchema,
  RepoRegistryConfigSchema,
]);

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

// --- GitHub Variables API client interface ---

export interface GitHubVariablesClient {
  readonly writeVariable: (name: string, value: string) => Promise<void>;
  readonly readVariable: (name: string) => Promise<string | null>;
  readonly listVariables: () => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>;
  readonly deleteVariable: (name: string) => Promise<void>;
}
