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
 * GitOps steering input for `macf fleet upgrade` (DR-043 §D6). Reconciled by
 * `computePlan` against `fleet.lock`'s recorded `deployed_version` (macf,
 * per agent — honest-`unknown` when never recorded; see `plan.ts`'s
 * `UNKNOWN_REASONS.deployedVersion`) and a live read of each agent repo's
 * committed `agent-router.yml` `uses:@<pin>` line (actions, per repo) —
 * see `plan.ts`'s `macfVersionItem` / `actionsVersionItem`.
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
    /**
     * groundnuty/macf#1074 — declares that this fleet's router NEEDS
     * Tailscale OAuth credentials (`TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`,
     * two of the six secrets `macf-actions`' `agent-router.yml` declares as
     * REQUIRED `workflow_call` secrets — see `apply-routing-secrets.ts`'s
     * module doc). Same shape as `age_recipients`'s own contract: an
     * operator-provided, never-tool-minted credential (Amendment C) whose
     * ABSENCE, when declared, refuses BEFORE consent gate 1 rather than
     * wasting a browser click on a fleet that cannot route
     * (`checkTailscaleOauthPreflight` in `commands/bootstrap-apply.ts`).
     *
     * **Optional, default `false` — undeclared is NOT an error.** A fleet
     * that hasn't set up Tailscale yet (or is mid-provisioning) simply gets
     * no refusal and no TS_OAUTH publish attempt this run; the other four
     * routing secrets (router-App id/key, routing-client cert/key) still
     * get provisioned/published independently — see
     * `apply-routing-secrets.ts`'s per-secret resolution.
     *
     * **Deliberately NOT `shared.ts_oauth`** (`FleetSharedSchema`, below).
     * `shared` models a DIFFERENT, unbuilt design — an account-level App
     * DETECTED AND REUSED across fleets (its own doc: "detected + reused,
     * never re-created") — and requires a companion `routing_app` string
     * this codebase has no consumer for. #1074's ruling is a DEDICATED
     * PER-FLEET routing App (see `apply-router-app.ts`), so overloading
     * `shared`'s presence as the Tailscale-declared signal would force an
     * operator to supply a `routing_app` name that gets silently ignored —
     * exactly the "operator believes X, tool does Y" class this whole issue
     * is about. `transport.age_recipients` is the precedent this field
     * actually matches: a flat, purpose-built, operator-supplied-credential
     * declaration with a refuse-before-gate-1 contract.
     */
    tailscale_oauth_required: z.boolean().optional().default(false),
    /**
     * groundnuty/macf#1082 — the routing App's SCOPE: one App shared across
     * every fleet on the account (`'shared'`, the DEFAULT), or a dedicated
     * App minted fresh for THIS fleet alone (`'per-fleet'`, #1081's shipped
     * behavior, retained as an explicit opt-in). Mode is otherwise
     * INPUT-implied (does the vault carry `MACF_ROUTING_APP_ID`/
     * `MACF_ROUTING_APP_KEY_B64`?) rather than flag-implied — this field is
     * the one exception, because "isolate this fleet's router from every
     * other fleet's" is a standing preference an operator states once, not
     * a per-run fact the vault's contents can express (see
     * `apply-router-app.ts`'s module doc for the full reversal narrative).
     *
     * **`transport`, not `shared`** (`FleetSharedSchema`, below). `shared`
     * is `.strict()` and requires BOTH `routing_app` AND `ts_oauth` —
     * consuming just the scope concept from it would force an operator to
     * additionally supply a `ts_oauth` reference this codebase still has no
     * consumer for, the exact "operator believes X, tool does Y" trap that
     * field's own doc warns about. `transport.age_recipients` /
     * `tailscale_oauth_required` are the precedent this field actually
     * matches: a flat, purpose-built, operator-facing declaration.
     *
     * **`transport` (required), not `shared` (optional), also matters for
     * where the zod default resolves.** `.optional().default('shared')`
     * inside a REQUIRED parent object always fills in a value post-parse;
     * inside an optional parent, an omitted `shared:` block would leave
     * this field unreachable rather than defaulted.
     */
    router_app_scope: z.enum(['shared', 'per-fleet']).optional().default('shared'),
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

/**
 * The label set `macf-actions`' `pick-runner` job emits VERBATIM on its
 * self-hosted branch (`agent-router.yml`, confirmed against
 * `groundnuty/macf-actions` `origin/main`: `labels='["self-hosted","macf-vm"]'`
 * — see `router-trusted-actors-contract.test.ts`'s live-parse pin, extended
 * for this constant). A GitHub Actions job is claimed iff `runner.labels ⊇`
 * this set — the router hard-codes its emission independent of what any
 * fleet declares, so THIS constant is the authoritative expected set
 * (macf#934 / DR-043 Amendment I4), never `routing.runner.labels` (below).
 * Hard-coded deliberately: the value is not a magic number but the other
 * half of a contract owned by `macf-actions`, and a config knob here would
 * let the two constants drift independently — exactly how macf#934's bug
 * would keep regenerating. A future change to the router's emitted labels
 * needs a code change here (and the live-parse test above will catch a
 * silent drift), not an operator-editable setting.
 */
export const ROUTER_EMITTED_LABELS: readonly string[] = ['self-hosted', 'macf-vm'];

export const FleetRoutingRunnerSchema = z
  .object({
    runs_on: z.string().min(1),
    /**
     * The label set the operator INTENDS a provisioned runner to carry
     * (DR-043 §D1 example, Amendment H/I) — optional; v0 fleets have relied
     * on the `macf-vm` convention without declaring it at all. When present,
     * this is a CROSS-CHECK against {@link ROUTER_EMITTED_LABELS}
     * (`FleetManifestSchema`'s `superRefine` below), never the value that
     * decides what a live runner needs to carry — see
     * `observer.ts::checkRunnerUsableByRepo` for the LIVE half of the same
     * invariant, and this field's `superRefine` check for why deriving the
     * expected label set from the manifest would check the wrong side of
     * the router's contract (macf#934).
     */
    labels: z.array(z.string().min(1)).optional(),
    /**
     * Per-fleet hibernation posture for the runner-provisioning contract's
     * `warm` argument (groundnuty/macf#942, DR-043 Amendment I). DR-009
     * §7.4: *"latency above all; `warm: 1` is mandatory, not a default to
     * tune"* — so this is optional-with-default, not merely optional:
     * every parsed manifest carries a concrete `warm` value, defaulting to
     * **1**. `0` is meaningful only for a fleet explicitly declared
     * dormant.
     *
     * **Not yet enforced.** `apply` does not yet call the runner-
     * provisioning contract (`repo`/`labels`/`warm`) that would act on this
     * value — that wiring is groundnuty/macf#943, still blocked. Declaring
     * `warm` here only RECORDS the posture; `plan.ts`'s
     * `planItemApplyCoverage` (groundnuty/macf#861's honest-state
     * mechanism) surfaces this loudly as NOT IMPLEMENTED BY APPLY on every
     * `macf bootstrap plan` run, rather than silently accepting a value
     * nothing acts on — see `plan.ts`'s `runnerWarmItem` +
     * `APPLY_UNIMPLEMENTED_REASONS.runnerWarm`.
     */
    warm: z.number().int().nonnegative().default(1),
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
 *
 * **STILL unconsumed as of groundnuty/macf#1082, same status as
 * `collaborators` below — but for a NARROWER reason than the #1074 doc this
 * replaces.** #1074 shipped a dedicated PER-FLEET routing App and dismissed
 * this field's account-wide model outright; #1082 reversed that instance
 * count and built the shared/reused App this field's OWN doc describes
 * (`apply-router-app.ts`'s `resolveSharedRouterAppReuse` + the fixed
 * `SHARED_ROUTER_APP_HANDLE` name) — so the underlying DESIGN this field
 * anticipated is now real. It stays unconsumed anyway: this field is
 * `.strict()` and requires BOTH `routing_app` AND `ts_oauth` together, so
 * wiring just the scope concept from it would force an operator to also
 * supply a `ts_oauth` reference this codebase still has no consumer for —
 * the same "operator believes X, tool does Y" trap `tailscale_oauth_required`'s
 * own doc warns about. `FleetTransportSchema.router_app_scope` (above) is
 * the field that actually carries #1082's shared-vs-per-fleet choice; this
 * one is left here unconsumed pending an explicit future reconciliation of
 * whether an operator-NAMED shared App (vs. the fixed name #1082 uses) is
 * ever worth building.
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
            'this is a double-prefix trap: deriveAppHandle would compound it into ' +
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

    // macf#934 — a declared `routing.runner.labels` is a CROSS-CHECK against
    // ROUTER_EMITTED_LABELS, never the value that decides runner usability
    // (see that constant's doc). Reject at parse time, before any GitHub
    // call: a manifest that declares e.g. `[self-hosted, arc-runner]` while
    // the router keeps emitting `[self-hosted, macf-vm]` would provision a
    // runner the router can never dispatch to — every routed job queues to
    // timeout, and nothing about that manifest LOOKS wrong until a live
    // apply's register-before-route gate fails, by which point the operator
    // has already spent a consent-gate round-trip on it. The check is a
    // superset test (declared ⊇ router-emitted), not equality — a fleet is
    // free to declare EXTRA labels (e.g. a `gpu` tag) alongside the two the
    // router requires.
    const declaredLabels = manifest.routing?.runner.labels;
    if (declaredLabels !== undefined) {
      const declaredSet = new Set(declaredLabels);
      const missing = ROUTER_EMITTED_LABELS.filter((label) => !declaredSet.has(label));
      if (missing.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `routing.runner.labels [${declaredLabels.join(', ')}] does not carry every label ` +
            `macf-actions' router actually emits for the self-hosted branch (missing: [${missing.join(', ')}]). ` +
            'A runner provisioned with these labels would never be dispatched a routed job — every job would ' +
            'queue to timeout while the plan looks clean. Declare routing.runner.labels as a superset of ' +
            `[${ROUTER_EMITTED_LABELS.join(', ')}] (extra labels are fine), or omit the field entirely and let ` +
            'the convention apply.',
          path: ['routing', 'runner', 'labels'],
        });
      }
    }
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
    // Fleet-level fingerprints not tied to one agent (CA key, routing-client
    // cert/key, ...). NOT "the shared macf-routing App" (stale as of
    // groundnuty/macf#1074 — the routing App is now a DEDICATED per-fleet
    // identity, recorded like any other role in `agents[]` above, role
    // `'router'` — see `apply-router-app.ts`). TS OAuth is operator-provided
    // and lives only in the vault (Amendment C) — `apply` never fingerprints
    // a value it never mints.
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
 * Compute the `MACF_TRUSTED_ACTORS` value for a fleet — every declared
 * agent's bot login, space-joined (macf#922). **Every entry carries the
 * `[bot]` suffix** — this is NOT {@link deriveAppHandle}'s bare handle.
 * `macf-actions`' `agent-router.yml` `pick-runner` job compares entries
 * DIRECTLY against `github.actor` with no in-workflow suffix append
 * (`[ "$a" = "$ACTOR" ]`; contrast the router's OTHER `${APP_NAME}[bot]`-
 * constructing comparisons elsewhere in the same file), and `github.actor`
 * for a GitHub-App-authored event IS `<app-slug>[bot]` — confirmed against a
 * real operator-run example in `macf-devops-toolkit/runner/RUNNER.md`
 * §"The security model" (`gh variable set MACF_TRUSTED_ACTORS --body
 * 'groundnuty macf-code-agent[bot] macf-science-agent[bot] ...'`) and this
 * repo's own `repo-init.ts` comment ("app_name is the GitHub App handle used
 * by the router to resolve mention/review participants (`${app_name}[bot]`)").
 *
 * **Space-separated — NOT comma, NOT JSON.** RUNNER.md is explicit: a JSON
 * array "silently fails to match (splits into bracket/quote tokens) →
 * everything routes github-hosted + the self-hosted runner sits idle." The
 * router's own split (`${TRUSTED_ACTORS//,/ }`) tolerates commas too, but
 * space matches the documented operator convention.
 */
export function buildTrustedActorsValue(fleetName: string, agents: readonly FleetAgent[]): string {
  return agents.map((agent) => `${deriveAppHandle(fleetName, agent.role)}[bot]`).join(' ');
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

/**
 * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
 * — the FULL set of repos that carry a committed macf-actions router
 * workflow: every declared agent's repo, AND the control repo (which has
 * carried one since `#1070` — `apply-control-repo-init.ts` runs
 * `repoInit()` against it on every `apply`). Single source of truth for
 * "derive the target set from repos carrying the router, never a hardcoded
 * list" — both `plan.ts::computePlan` (which repos get an `actions_pin`
 * item) and `apply-fleet.ts`'s reconcile step (which repos get a
 * force-rewrite attempt when their pin diverges) enumerate THIS list, so a
 * router added to a THIRD kind of repo in the future is a one-line change
 * here, never a two-place drift risk between plan and apply.
 */
export function routerCarryingRepos(manifest: FleetManifest): readonly string[] {
  return [...manifest.agents.map((a) => a.repo), `${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`];
}
