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

/**
 * `metadata.name` shape (macf#839 review nit 4): lowercase kebab, starting
 * with an alnum. The name propagates verbatim into derived App handles
 * (`deriveAppHandle`) and the registry variable segment (`toVariableSegment`)
 * — an uppercase or underscore-carrying name would produce surprising
 * handle/segment shapes downstream.
 */
export const FLEET_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const FleetMetadataSchema = z
  .object({
    name: z.string().min(1).regex(FLEET_NAME_RE, 'metadata.name must be lowercase kebab-case (^[a-z0-9][a-z0-9-]*$)'),
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
 * `age_recipients` is `[]` when the fleet has no existing age key(s) yet —
 * `apply` mints one + hands it off (DR-043 §D5). The KEY is always present
 * in a well-formed manifest; only the array's LENGTH varies.
 *
 * List, not a single string (macf#852) — §D5's multi-recipient requirement
 * (2026-08-11 operator-confirmed amendment) means `vault.age` and every
 * per-agent recovery artifact encrypt to **two distinct keys**: the
 * operator's (Mac-side reconcile/recovery) and the VM's (`vault.sh`
 * decrypting at agent runtime). A single recipient would force "one
 * master key held in two places" — copying the fleet's highest-value
 * secret between machines instead of minting each principal its own age
 * identity. `writeVault` / `writeAgentRecoveryArtifact` already accept
 * `readonly string[]` and pass every entry to `age -r <r1> -r <r2> ...`
 * (native multi-recipient encryption) — this schema field is what lets a
 * `fleet.yaml` actually declare more than one.
 */
export const FleetTransportSchema = z
  .object({
    age_recipients: z.array(z.string().min(1)),
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

/**
 * v0 supports exactly one CA mode (macf#839 review nit 5) — `.strict()`'s
 * typos-fail-loud rationale argues for an enum over a free string here too.
 */
export const FleetTrustSchema = z
  .object({
    ca: z.enum(['per-project']).default('per-project'),
    federated_cas: z.array(z.string().min(1)),
  })
  .strict();

export const FLEET_MANIFEST_API_VERSION = 'macf/v0';

/**
 * `agents[].role` charset (macf#839 review [BLOCKING] 1): lowercase
 * kebab, no leading/trailing/double dashes. Deliberately does NOT mandate a
 * `-agent` suffix — a future role (e.g. a bare `auditor`) may not carry one.
 */
export const ROLE_CHARSET_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
    // Optional-with-default (macf#839 review nit 5): a MACF fleet always
    // needs a CA, so an omitted `trust:` section must NOT gate the CA plan
    // items off — it defaults to the only v0 mode, per-project, with no
    // federation declared.
    trust: FleetTrustSchema.optional().default({ ca: 'per-project', federated_cas: [] }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // macf#839 review [BLOCKING] 1 + 2: the #791 front door (role mis-written
    // as the prefixed App handle) + role/repo uniqueness. One pass over
    // `agents[]` since both checks need per-agent context; `rolePrefix` needs
    // `metadata.name`, so this can't live on `FleetAgentSchema` alone.
    const rolePrefix = `${manifest.metadata.name}-`;
    const seenRoles = new Set<string>();
    const seenRepos = new Set<string>();

    manifest.agents.forEach((agent, index) => {
      if (agent.role.startsWith(rolePrefix)) {
        ctx.addIssue({
          code: 'custom',
          message:
            `agents[${String(index)}].role "${agent.role}" starts with the fleet name prefix "${rolePrefix}" — ` +
            'this is the macf#791 / DR-032 double-prefix trap: deriveAppHandle would compound it into ' +
            `"${manifest.metadata.name}-${agent.role}". role is the bare <bare-role> shape (deriveAppHandle ` +
            'prepends the fleet name); never write the already-prefixed App handle here.',
          path: ['agents', index, 'role'],
        });
      }

      if (!ROLE_CHARSET_RE.test(agent.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `agents[${String(index)}].role "${agent.role}" must be lowercase kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)`,
          path: ['agents', index, 'role'],
        });
      }

      if (seenRoles.has(agent.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate agents[].role "${agent.role}" — every agent needs a unique role`,
          path: ['agents', index, 'role'],
        });
      }
      seenRoles.add(agent.role);

      if (seenRepos.has(agent.repo)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate agents[].repo "${agent.repo}" — every agent needs its own home repo`,
          path: ['agents', index, 'repo'],
        });
      }
      seenRepos.add(agent.repo);
    });
  });

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

/**
 * Derive a fleet's control-plane repo NAME (bare, no `owner/` prefix — same
 * convention as {@link deriveAppHandle}'s bare handle) from `metadata.name`
 * — DR-043 Amendment F. **Derived, never registry-pointed, never a manifest
 * field** — same "handle derivation, never declaration" posture this module
 * already establishes for App handles (macf#791): "Discovery is
 * deterministic derivation from the fleet name (no lookup, no drift
 * surface)." Callers compose the full `owner/repo` form themselves (see
 * `control-repo.ts::controlRepoFullName`) — this function doesn't take an
 * owner because the derivation itself doesn't need one.
 */
export function deriveControlRepoName(fleetName: string): string {
  return `${fleetName}-control`;
}
