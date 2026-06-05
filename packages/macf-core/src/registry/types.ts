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

/**
 * Value equality for two `AgentInfo`s (or absence). `null` represents an
 * empty registry slot; two nulls are equal, a null and a value are not.
 * Used by the conditional-register CAS to compare the slot's observed
 * state against its current state.
 */
export function agentInfoEquals(a: AgentInfo | null, b: AgentInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.type === b.type &&
    a.instance_id === b.instance_id &&
    a.started === b.started
  );
}

/**
 * Outcome of a conditional (compare-and-set) register (groundnuty/macf#439).
 *
 * `ok: true`  — this instance now owns the slot; `current` is the value just
 *               written (=== the `info` passed in). Ownership strength is
 *               backend-dependent: the local backend is **exclusive-at-return**
 *               (the compare+write is lock-atomic), whereas the GitHub-Variables
 *               backend is **best-effort / eventually-reconciled** — a racer
 *               writing in the same instant can still win (no native CAS on that
 *               API; see registry.ts `registerConditional`).
 * `ok: false` — a concurrent writer changed the slot between the collision
 *               check and this write; `current` is the conflicting value
 *               observed (null if the slot was emptied). The caller must NOT
 *               treat itself as the registered owner — abort or re-check.
 */
export interface RegisterResult {
  readonly ok: boolean;
  readonly current: AgentInfo | null;
}

// --- Registry interface ---

export interface Registry {
  readonly register: (name: string, info: AgentInfo) => Promise<void>;
  /**
   * Compare-and-set register (groundnuty/macf#439): write `info` only if the
   * slot still matches `expected` (the value observed during the collision
   * check; `null` = expected-absent). Closes the TOCTOU window between the
   * collision check's read and the registration write — a racing second
   * writer can't silently clobber the first. Returns whether this instance
   * won the slot. Backends differ in atomicity: the local registry is fully
   * atomic under its file lock; the GitHub-Variables backend narrows the
   * window with a pre-write compare + post-write read-back verify (no native
   * CAS primitive exists on that API — see registry.ts).
   */
  readonly registerConditional: (
    name: string,
    info: AgentInfo,
    expected: AgentInfo | null,
  ) => Promise<RegisterResult>;
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

/**
 * Local-registry mode (DR-024). The `path` field is the absolute filesystem
 * path to the project's registry JSON file (e.g.
 * `~/.macf/registry/<project>.json` after operator-side `~` expansion). The
 * config schema is intentionally minimal — init-time concerns (default
 * path resolution, `--local` flag aliasing, CA generation) live in the
 * `macf` CLI package, not here.
 */
export const LocalRegistryConfigSchema = z.object({
  type: z.literal('local'),
  path: z.string().min(1),
});

export const RegistryConfigSchema = z.union([
  OrgRegistryConfigSchema,
  ProfileRegistryConfigSchema,
  RepoRegistryConfigSchema,
  LocalRegistryConfigSchema,
]);

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

// --- GitHub Variables API client interface ---

export interface GitHubVariablesClient {
  readonly writeVariable: (name: string, value: string) => Promise<void>;
  readonly readVariable: (name: string) => Promise<string | null>;
  readonly listVariables: () => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>;
  readonly deleteVariable: (name: string) => Promise<void>;
}
