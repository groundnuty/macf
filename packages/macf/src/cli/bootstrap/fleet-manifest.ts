/**
 * `fleet.yaml` / `fleet.lock` schema — DR-043 §D1 (declarative fleet
 * provisioning), Slice 1a (groundnuty/macf#838).
 *
 * `fleet.yaml` is the **desired-state** manifest an operator commits to a
 * fleet's science/coordination repo: roles, repos, versions, topology. It is
 * secret-free-by-construction — no App IDs, no keys, no install IDs (those are
 * *outputs* of provisioning, not inputs — DR-043 §D1). `fleet.lock` is the
 * **observed non-secret state** `macf bootstrap apply` writes back: app_ids,
 * install_ids, deployed versions, and secret **fingerprints** (never secret
 * values — those live only in `secrets/vault.age`, DR-043 §D5).
 *
 * Both schemas are `.strict()` throughout: YAML natively supports `#`
 * comments, so there is no legitimate reason for an unrecognized key to
 * survive a parse — an operator typo (`respository:` for `repository:`) must
 * be a loud validation error, not a silently-dropped field (mirrors the
 * `.strict()` convention in `@groundnuty/macf-core`'s `prompt-responses.ts` /
 * `stall-signatures.ts`).
 *
 * **Handle derivation, never declaration (macf#791 / DR-032 Amendment).** The
 * #1 provisioning trap the DR encodes structurally: the manifest's per-agent
 * `role` field is DR-032's "name" shape (`<bare-role>-agent`, e.g.
 * `code-agent`) — the routing label / cert CN / registry segment / tmux
 * session / agent-config key. The GitHub App **handle** (`<project>-<role>`,
 * globally unique) is *derived* from `metadata.name` + `role` via
 * {@link deriveAppHandle} and is NEVER a manifest field — `FleetAgentSchema`
 * is `.strict()` with no `app_handle` / `app_id` key, so declaring one is a
 * parse-time rejection, not a silently-ignored override.
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { RegistryConfigSchema } from '@groundnuty/macf-core';

// --- fleet.yaml (desired state) ---

export const FleetMetadataSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

/**
 * GitOps steering input for `macf fleet upgrade` (DR-043 §D6). Reconciled
 * against registry-reported deployed versions — day-2 wiring (Slice 1a parses
 * this section but does not reconcile it; see `plan.ts`'s `skipped_sections`).
 */
export const FleetVersionsSchema = z
  .object({
    macf: z.string().min(1),
    actions: z.string().min(1),
  })
  .strict();

export const FleetOwnerSchema = z
  .object({
    account: z.string().min(1),
    type: z.enum(['user', 'org']),
    registry: RegistryConfigSchema,
  })
  .strict();

export const FleetNetworkSchema = z
  .object({
    advertise_host: z.string().min(1),
  })
  .strict();

/**
 * `age_recipient` is `null` when the fleet has no existing age key yet —
 * `apply` mints one + hands it off (DR-043 §D5). The KEY is always present in
 * a well-formed manifest; only the VALUE is nullable.
 */
export const FleetTransportSchema = z
  .object({
    vault_repo: z.string().min(1),
    age_recipient: z.string().min(1).nullable(),
  })
  .strict();

export const FleetDefaultsSchema = z
  .object({
    role_template: z.string().min(1),
    app_manifest: z.string().min(1),
  })
  .strict();

/**
 * One fleet agent. `role` is DR-032's "name" shape (`<bare-role>-agent`) —
 * see the module doc for why this is NOT a bare role and why the App handle
 * is derived, never declared, from it.
 *
 * `provenance` mirrors the DR-035 field lesson (`repo_provenance: template`
 * vs `overleaf-mirror`) under the shorter v0 name: `template` (default —
 * `apply` clones `repo` into `deploy_path`) or `mirror` (an existing dir,
 * e.g. an Overleaf-backed paper repo, that `apply` remote-adds + pushes to
 * `repo` instead of cloning).
 */
export const FleetAgentSchema = z
  .object({
    role: z.string().min(1),
    profile: z.string().min(1),
    repo: z.string().min(1),
    deploy_path: z.string().min(1),
    provenance: z.enum(['template', 'mirror']).optional(),
  })
  .strict();

export const FleetRoutingRunnerSchema = z
  .object({
    runs_on: z.string().min(1),
  })
  .strict();

export const FleetRoutingSchema = z
  .object({
    runner: FleetRoutingRunnerSchema,
  })
  .strict();

/**
 * A cross-fleet guest collaborator (DR-036 / DR-041). Reconciles as a UNION
 * into `<SEG>_FEDERATED_CAS` — never an override (DR-041 Amendment B). Slice
 * 1a parses this section but does not reconcile it (day-2; see `plan.ts`'s
 * `skipped_sections`).
 */
export const FleetCollaboratorSchema = z
  .object({
    project: z.string().min(1),
    registry: RegistryConfigSchema,
    ca_bundle: z.string().min(1),
  })
  .strict();

/**
 * Account-level, cross-fleet resources — detected + reused, never re-created
 * (the `macf-routing` App silent-duplicate-create hazard DR-035 documented).
 * `ts_oauth` is a REFERENCE (an out-of-band-supplied credential name), never
 * a stored value — the manifest stays secret-free.
 */
export const FleetSharedSchema = z
  .object({
    routing_app: z.string().min(1),
    ts_oauth: z.string().min(1),
  })
  .strict();

export const FleetTrustSchema = z
  .object({
    ca: z.string().min(1),
    federated_cas: z.array(z.string().min(1)),
  })
  .strict();

export const FLEET_MANIFEST_API_VERSION = 'macf/v0';

export const FleetManifestSchema = z
  .object({
    apiVersion: z.literal(FLEET_MANIFEST_API_VERSION),
    kind: z.literal('Fleet'),
    metadata: FleetMetadataSchema,
    versions: FleetVersionsSchema.optional(),
    owner: FleetOwnerSchema,
    network: FleetNetworkSchema,
    transport: FleetTransportSchema,
    defaults: FleetDefaultsSchema,
    agents: z.array(FleetAgentSchema).min(1),
    routing: FleetRoutingSchema.optional(),
    collaborators: z.array(FleetCollaboratorSchema).optional(),
    shared: FleetSharedSchema.optional(),
    trust: FleetTrustSchema.optional(),
  })
  .strict();

export type FleetMetadata = z.infer<typeof FleetMetadataSchema>;
export type FleetVersions = z.infer<typeof FleetVersionsSchema>;
export type FleetOwner = z.infer<typeof FleetOwnerSchema>;
export type FleetNetwork = z.infer<typeof FleetNetworkSchema>;
export type FleetTransport = z.infer<typeof FleetTransportSchema>;
export type FleetDefaults = z.infer<typeof FleetDefaultsSchema>;
export type FleetAgent = z.infer<typeof FleetAgentSchema>;
export type FleetRoutingRunner = z.infer<typeof FleetRoutingRunnerSchema>;
export type FleetRouting = z.infer<typeof FleetRoutingSchema>;
export type FleetCollaborator = z.infer<typeof FleetCollaboratorSchema>;
export type FleetShared = z.infer<typeof FleetSharedSchema>;
export type FleetTrust = z.infer<typeof FleetTrustSchema>;
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

/**
 * Parse + validate a `fleet.yaml` document from its raw text. Throws a
 * `ZodError` (via `.parse`) on any schema violation — callers at the CLI
 * boundary (`commands/bootstrap.ts`) catch + render it into the `--json`-
 * never-empty failure envelope (macf#830 lesson).
 */
export function parseFleetManifest(yamlText: string): FleetManifest {
  const raw: unknown = parseYaml(yamlText);
  return FleetManifestSchema.parse(raw);
}

// --- fleet.lock (observed non-secret state) ---

export const FLEET_LOCK_SCHEMA_VERSION = 1;

/**
 * One agent's observed provisioning state. `fingerprints` is the DR-043 §D5
 * fingerprint-pairing map — secret name (`app_private_key`, `client_secret`,
 * `webhook_secret`, ...) → a non-secret fingerprint of the value actually
 * written. The registry holds the SAME fingerprint (readable, for drift
 * detection); the vault holds the sealed value; the lock holds the mapping
 * between them.
 */
export const FleetLockAgentSchema = z
  .object({
    role: z.string().min(1),
    app_id: z.string().min(1),
    install_id: z.string().min(1),
    fingerprints: z.record(z.string(), z.string()).optional(),
    deployed_version: z.string().optional(),
  })
  .strict();

export const FleetLockSchema = z
  .object({
    schema_version: z.literal(FLEET_LOCK_SCHEMA_VERSION),
    fleet: z.string().min(1),
    agents: z.array(FleetLockAgentSchema),
    versions: FleetVersionsSchema.partial().strict().optional(),
    // Fleet-level fingerprints not tied to one agent (CA key, the shared
    // macf-routing App creds, TS OAuth, ...).
    fingerprints: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type FleetLockAgent = z.infer<typeof FleetLockAgentSchema>;
export type FleetLock = z.infer<typeof FleetLockSchema>;

/**
 * Parse + validate a `fleet.lock` document from its raw text. `fleet.lock` is
 * machine-written (by `apply`, day-2) but kept in the same YAML-superset
 * format as `fleet.yaml` (YAML parses plain JSON too) so one parser serves
 * both artifacts. Throws a `ZodError` on any schema violation.
 */
export function parseFleetLock(text: string): FleetLock {
  const raw: unknown = parseYaml(text);
  return FleetLockSchema.parse(raw);
}

/**
 * Derive a fleet agent's GitHub App handle (the App slug, no `[bot]` suffix)
 * from the fleet name + the agent's `role` field. **This is the ONLY place
 * the handle is computed** — never read it off a manifest field (there isn't
 * one; see the module doc + macf#791).
 *
 * `role` is already DR-032's "name" shape (`<bare-role>-agent`), so the
 * handle is simply `<project>-<role>` per DR-032's Amendment table (e.g.
 * fleet `icsoc-2026` + role `code-agent` → handle `icsoc-2026-code-agent`).
 * Callers append `[bot]` when rendering a GitHub bot login / git author.
 */
export function deriveAppHandle(fleetName: string, role: string): string {
  return `${fleetName}-${role}`;
}
