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
    /**
     * groundnuty/macf#1162 — the ORIGIN fleet of a `'shared'`-scope router
     * App credential this fleet holds via the (out-of-scope, operator-only)
     * interim cross-fleet vault copy: `#1094` made the router App
     * owner-scoped so a second fleet REUSES it, but GitHub has no API to
     * re-read an App's private key, so the operator manually copies the
     * FIRST fleet's vault entry into every OTHER fleet's vault
     * (Amendment C/D: only the operator-privileged CLI decrypts/writes a
     * vault, never `apply`). Declaring the source fleet HERE is what lets
     * `apply`'s `fleet.lock` marker (`fleet-lock.ts`'s `scope_credentials`
     * doc) and `plan`'s standing notice (`plan.ts`'s `scopeCredentialNotice`
     * doc) name it, rather than leaving N locally-held copies with no
     * recorded source (the drift surface Amendment N warns about — rotation
     * has nowhere to enumerate without this).
     *
     * Optional; only meaningful when this run's router App resolves the
     * cross-fleet `'vault-reused'` outcome (`router_app_scope: shared`,
     * `apply-router-app.ts::RouterAppApplyOutcome`'s doc) — a `'per-fleet'`
     * scope fleet, or a `'shared'`-scope fleet that is ITSELF the
     * originating fleet (created/reused its own App this run or a prior
     * one), genuinely owns its credential and never writes this marker
     * regardless of whether this field is set. Undeclared is honest
     * "operator has not named a source yet," never an error — `plan`
     * still surfaces the marker (sourced from `fleet.lock` if `apply` has
     * already run) with an explicit "origin not declared" note rather than
     * silently omitting it.
     */
    router_app_origin_fleet: z.string().min(1).optional(),
    /**
     * groundnuty/macf#1211 — the LOWEST-precedence, narrowest tier of the
     * runner-provisioning contract's endpoint resolution (see
     * `runner-platform.ts::resolveRunnerPlatformEndpointWithProvenance` for
     * the full chain: an explicit per-run override, then
     * `MACF_RUNNER_PLATFORM_ENDPOINT` (env), then the fleet's `owner.registry`
     * scope's shared Actions variable — the operator-ruled NORMAL case, set
     * once per scope, every fleet on it inherits for free — then this field,
     * then unconfigured).
     *
     * **An escape hatch for the unusual fleet, not the intended common
     * path.** A fleet only needs this when it genuinely wants a DIFFERENT
     * runner-provisioning platform than its scope's shared one, or as a
     * fallback while the scope variable has not been set yet. Optional;
     * undeclared is the expected steady state once a scope variable exists.
     *
     * **A variable, never a secret** (the operator's own ruling) — a tailnet
     * address's access control is reachability, not obscurity. Committing
     * this to `fleet.yaml` is intentional and safe; do not "harden" it into
     * the vault later.
     */
    runner_platform_endpoint: z.string().min(1).optional(),
    /**
     * groundnuty/macf#1230 — the explicit, operator-typed override for the
     * "narrowing `age_recipients` is a revocation that does not revoke"
     * refusal (see `age-recipients-narrowing.ts`'s module doc for the full
     * mechanism). **Not a boolean.** A flag the operator flips silently
     * re-invites the exact failure this field exists to prevent: an
     * operator who narrows the list reasonably believes access was
     * withdrawn, so the acknowledgment itself must restate — in the
     * committed `fleet.yaml`, not just in a doc comment nobody reads at
     * apply time — that re-encrypting to fewer recipients does NOT revoke
     * the removed recipient's access to any vault copy already held (a
     * backup, a checkout, a laptop). Copying
     * {@link AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT} verbatim into this
     * field is the mechanism; `checkAgeRecipientsNarrowing` compares
     * whitespace-normalized (not byte-exact) so YAML's line-folding cannot
     * turn a genuine, correctly-typed acknowledgment into a cryptic schema
     * rejection — see that function's doc.
     *
     * Optional; undeclared is the ordinary case for every fleet that has
     * never narrowed its recipient set. Presence alone does not silence the
     * refusal — an operator who pastes the WRONG text (a stale copy, a
     * paraphrase, `"true"`) still gets refused, with the exact required
     * text printed so the fix is a copy-paste, not a guess.
     */
    age_recipients_narrowing_override: z.string().min(1).optional(),
  })
  .strict();

/**
 * groundnuty/macf#1230 — the exact acknowledgment text
 * `transport.age_recipients_narrowing_override` must (whitespace-normalized)
 * match for `checkAgeRecipientsNarrowing` to let a narrowing manifest
 * through. Defined here (the schema module), not in `age-recipients-narrowing.ts`,
 * so that module can import it FROM this one without creating the reverse
 * (schema-depends-on-check-logic) edge — `age-recipients-narrowing.ts`
 * already needs `FleetLock`/`FleetManifest` types from here, and this
 * constant is schema-adjacent (it IS the expected shape of a schema field),
 * not check-logic.
 */
export const AGE_RECIPIENTS_NARROWING_OVERRIDE_TEXT =
  'I understand that narrowing age_recipients only stops FUTURE re-encryption from including the removed ' +
  'recipient — it does not revoke that recipient\'s decrypt access to any vault copy already held (a backup, a ' +
  'checkout, a laptop). Real revocation requires rotating the CA and re-issuing everything the old vault protected.';

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

/**
 * The lowest `macf-actions` router version that carries `pick-runner` /
 * `MACF_TRUSTED_ACTORS` at all (groundnuty/macf#1194) — verified against
 * `groundnuty/macf-actions` git history: the origin-routing commit
 * (`3be993d`, "origin-route the runner by trigger trust") first ships in
 * tag `v3.4.0` (confirmed via `git tag --contains 3be993d`); every tag
 * `v3.0.0`–`v3.3.0` hardcodes `runs-on: ubuntu-latest` on EVERY job
 * (confirmed via `git show v3.3.0:.github/workflows/agent-router.yml |
 * grep runs-on` — six matches, all literal `ubuntu-latest`, zero
 * `pick-runner` job). A fleet pinned below this version has NO mechanism
 * that could ever read `MACF_TRUSTED_ACTORS` — `apply` writing it would be
 * silently inert, the exact "declaration and generated workflow disagree"
 * class this constant exists to catch (see {@link isSelfHostedCapableActionsVersion}'s
 * cross-check in `FleetManifestSchema`'s `superRefine`, below).
 */
export const MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION = 'v3.4.0';

/**
 * Parses `vMAJOR`, `vMAJOR.MINOR`, or `vMAJOR.MINOR.PATCH` into `[major,
 * minor]` — patch never affects capability (semver: no new features in a
 * patch release), so it is deliberately not extracted. `minor` is `null`
 * for a bare `vMAJOR` ref (`v3`) — a floating major-only tag whose minor
 * cannot be known without a live GitHub lookup, which this pure schema
 * check deliberately never performs (see {@link isSelfHostedCapableActionsVersion}'s
 * doc for how that ambiguity is resolved). `null` (the whole tuple) for
 * anything that isn't a `vN...` ref at all (a branch name, `main`, empty).
 */
function parseActionsMajorMinor(version: string): readonly [number, number | null] | null {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(version);
  if (!match?.[1]) return null;
  const minorStr = match[2];
  return [Number(match[1]), minorStr !== undefined ? Number(minorStr) : null];
}

/**
 * Whether `version` (a `versions.actions` pin, e.g. `v3.4.1`, `v3.3`,
 * `v3`, `main`) is a `macf-actions` version that could ACTUALLY read
 * `MACF_TRUSTED_ACTORS` — the capability half of groundnuty/macf#1194's
 * "declaration and generated workflow must not disagree" requirement.
 *
 * **The safe direction is INVERTED from this file's neighbor pattern
 * (`repo-init.ts::isBundleCapableActionsVersion`) — deliberately.** There,
 * an unresolved/ambiguous floating ref is treated as NOT capable, because
 * the fallback for "not capable" is `secrets: inherit`, which works
 * regardless of version — a conservative "no" costs nothing. Here, "not
 * capable" means REFUSE the whole manifest, so a conservative "no" on an
 * ordinary `v3`-pinned fleet (verified live: the `v3` floating tag
 * currently resolves to `v3.4.2`, self-hosted-capable) would wrongly block
 * every fleet that pins the common, correct floating major ref. So a bare
 * `vMAJOR` ref (minor unknown) is trusted forward — same convention
 * `isV3PlusActionsVersion` already uses for "a v3+ major floating ref
 * tracks current" — while a FULLY DETERMINATE `vMAJOR.MINOR[.PATCH]` ref
 * is checked exactly (a floating MINOR tag like `v3.3` never crosses into
 * `v3.4.x` — it is permanently below this threshold, not merely
 * ambiguous). `main` is always capable (the dev branch, always current).
 * A ref that doesn't parse as `vN...` at all is NOT capable — genuinely
 * unconfirmable, and unconfirmable must refuse here, not proceed.
 */
export function isSelfHostedCapableActionsVersion(version: string): boolean {
  if (version === 'main') return true;
  const parsed = parseActionsMajorMinor(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (minor === null) return major >= 3;
  // MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION is a fixed, fully-pinned
  // vMAJOR.MINOR.PATCH literal above — its minor is always determinate.
  const [minMajor, minMinor] = parseActionsMajorMinor(MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION)!;
  return major > minMajor || (major === minMajor && minor >= minMinor!);
}

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
     * **Enforced as of groundnuty/macf#943.** `apply-fleet.ts` calls the
     * runner-provisioning contract (`runner-platform.ts::provisionRunner`,
     * `repo`/`labels`/`warm`) for every confirmed self-hosted-runner repo,
     * every run — non-fatally (Amendment I2): a contract failure is reported
     * via `FleetApplyResult.runnerProvision`, never silently, but never fails
     * the run either. "Enforced" means "apply sends it on every call," not
     * "the contract is guaranteed to obey it" — `plan.ts`'s
     * `planItemApplyCoverage` still classifies this `'write-always'` (no
     * live-observable warm/dormant signal to compare a declared value
     * against), but the kind itself moved OUT of `NOT IMPLEMENTED BY APPLY`
     * — see `plan.ts`'s `runnerWarmItem`.
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
 * (`apply-router-app.ts`'s `resolveSharedRouterAppReuse` + the
 * owner-keyed `deriveRouterAppHandle` name, groundnuty/macf#1088) — so the
 * underlying DESIGN this field anticipated is now real. It stays unconsumed
 * anyway: this field is `.strict()` and requires BOTH `routing_app` AND
 * `ts_oauth` together, so wiring just the scope concept from it would force
 * an operator to also supply a `ts_oauth` reference this codebase still has
 * no consumer for — the same "operator believes X, tool does Y" trap
 * `tailscale_oauth_required`'s own doc warns about.
 * `FleetTransportSchema.router_app_scope` (above) is the field that
 * actually carries #1082's shared-vs-per-fleet choice; this one is left
 * here unconsumed pending an explicit future reconciliation of whether an
 * operator-NAMED shared App (vs. the owner-derived name #1088 uses) is
 * ever worth building.
 */
export const FleetSharedSchema = z
  .object({
    routing_app: z.string().min(1),
    ts_oauth: z.string().min(1),
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

    // groundnuty/macf#1194 — a declared runs_on: self-hosted alongside a
    // versions.actions pin the router CANNOT read MACF_TRUSTED_ACTORS on is
    // a self-contradicting manifest: apply would write the variable, but
    // the pinned workflow would never look at it, and every job would
    // silently keep billing on a hosted runner forever with no signal at
    // any layer. Reject at parse time — before any GitHub call, before
    // either consent gate — same "catch it before the operator spends a
    // round-trip on it" reasoning as the labels cross-check above. Only
    // fires when BOTH fields are explicitly declared (an omitted
    // versions.actions defaults to the current floating major tag, always
    // capable; an omitted/non-self-hosted routing.runner has nothing to
    // contradict).
    if (manifest.routing?.runner.runs_on === 'self-hosted' && manifest.versions?.actions !== undefined) {
      const declaredActions = manifest.versions.actions;
      if (!isSelfHostedCapableActionsVersion(declaredActions)) {
        ctx.addIssue({
          code: 'custom',
          message:
            `routing.runner.runs_on is "self-hosted" but versions.actions "${declaredActions}" is a macf-actions ` +
            `pin that cannot read MACF_TRUSTED_ACTORS at all (needs at least ${MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION} ` +
            '— every job in an older pin hardcodes a GitHub-hosted runner). apply would write the variable but the ' +
            'pinned workflow would never read it, so every job would keep routing to a hosted runner indefinitely ' +
            'with no signal that anything is wrong. Bump versions.actions, or remove it and let the current ' +
            'floating major tag apply.',
          path: ['versions', 'actions'],
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
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

/**
 * groundnuty/macf#1201 — `trust.ca` / `trust.federated_cas` were removed
 * from {@link FleetManifestSchema}: `FleetTrust` had zero consumers
 * anywhere in this codebase (the #1200 reconciliation audit,
 * `design/manifest-reconciliation-audit.md` rows 30-31) — the sharpest of
 * that audit's nine inert fields, because the doc comment that used to sit
 * on the removed `trust:` field described a CA-plan gating relationship
 * that never existed. Fleet-level CA/federation trust is `#810`'s still-
 * open design; a schema field landing ahead of that design's enforcement
 * is exactly what produced this problem, so it is not quietly re-added
 * here — read `#810` before reintroducing either sub-field.
 *
 * This check runs BEFORE `FleetManifestSchema.parse` deliberately: a bare
 * `.strict()` "Unrecognized key: trust" is true but useless to an operator
 * holding an old `fleet.yaml`, and — verified empirically — zod's
 * `superRefine` never runs once the object-level strict check has already
 * raised an unrecognized-key issue (the same base-validation-first
 * ordering `manifest-scaffold.ts`'s module doc documents for a missing
 * required field), so a refusal added there would never even execute.
 * Intercepting the raw parsed value here, ahead of `.parse`, is what makes
 * a targeted explanation possible instead.
 */
function rejectDeclaredTrust(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || !('trust' in raw)) return;
  throw new Error(
    'fleet.yaml declares a "trust:" section (trust.ca / trust.federated_cas). Nothing in this version of ' +
      'macf reads that section — an earlier schema parsed it, but no code path ever enforced it, so declaring ' +
      'it changed nothing. Fleet-level CA/federation trust is an unsettled design; until it lands, remove the ' +
      '"trust:" section from this fleet.yaml. This does not weaken anything you already have: every fleet gets ' +
      'its own CA unconditionally, with or without a "trust:" section.',
  );
}

/**
 * Parse + validate a `fleet.yaml` document from its raw text. Throws a
 * `ZodError` (via `.parse`) on any schema violation, or a plain `Error` with
 * a dedicated explanation when the manifest declares a removed field (today:
 * a declared `trust:` section — see {@link rejectDeclaredTrust}). Callers at
 * the CLI boundary (`commands/bootstrap.ts`) catch + render EITHER kind's
 * `.message` into the `--json`-never-empty failure envelope (macf#830
 * lesson), so no caller needs to discriminate the two.
 */
export function parseFleetManifest(yamlText: string): FleetManifest {
  const raw: unknown = parseYaml(yamlText);
  rejectDeclaredTrust(raw);
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
 *
 * **This is the PER-AGENT scope, not the fleet-level one** — see
 * {@link FleetLockSchema.fleet_fingerprints}'s doc (groundnuty/macf#1310)
 * for the sibling field this one must never be confused with. The two used
 * to share the bare name `fingerprints` at two different nesting depths
 * (this one under each `agents[]` entry, the other at the lock's top
 * level) — a real naming collision a reader could trip on even though the
 * two were never actually read from the wrong place in this codebase (the
 * live #1310 incident's root cause turned out to be #1309's lock-fallback
 * gap, not a wrong-home lookup). This field keeps its name (already
 * disambiguated by nesting — `agents[i].fingerprints`, never bare); the
 * fleet-level sibling was the one renamed.
 *

 * `repo` (groundnuty/macf#1296) — the `owner/repo` this role's identity was
 * provisioned against, `FleetAgent.repo`'s value at the time `apply`
 * established/reconfirmed this role. **OPTIONAL, and every existing fleet's
 * lock predates it — `undefined` here means UNKNOWN, never "this role has
 * no repo."** This is `#1252`'s exact lesson (`age_recipients`'s own doc
 * makes the identical distinction): an absent field is "nothing recorded to
 * compare against," not a fact about the role. Recorded specifically so a
 * role can still be NAMED after it is orphaned (dropped from
 * `manifest.agents[]`) — `manifest.agents[]` no longer carries an entry for
 * it at that point, so `deriveRepoName`-style re-derivation is impossible;
 * this field is the only way to know the repo later (`composeFleetLock`'s
 * own doc, `#1296`). Read by `plan.ts`'s row-4 repo-orphan URL and
 * `apply-delete.ts`'s `secret_fingerprint` delete-item resolution.
 *
 * This records "the repo `apply` last provisioned this role against" —
 * NOT a drift signal. Unlike `app_id`/`install_id` (which feed
 * {@link FleetLockIdentityChange} in `fleet-lock.ts` when a touched role's
 * fresh value diverges from what was previously recorded), a changed `repo`
 * is deliberately NOT surfaced as an identity change: `fleet.yaml`'s
 * `agents[].repo` is operator-editable free text (an operator can legitimately
 * rename/move an agent's repo), and `composeFleetLock` always records
 * whatever THIS run's manifest declares — see that module's merge logic.
 */
export const FleetLockAgentSchema = z
  .object({
    role: z.string().min(1),
    app_id: z.string().min(1),
    install_id: z.string().min(1),
    repo: z.string().min(1).optional(),
    fingerprints: z.record(z.string(), z.string()).optional(),
    deployed_version: z.string().optional(),
  })
  .strict();

/**
 * groundnuty/macf#1330 — the LAST-APPROVED age recipient set for ONE
 * federated collaborator (`project` matches {@link FleetCollaboratorSchema.project},
 * `#786`'s home-project identifier). Sibling to {@link FleetLockAgentSchema},
 * added the same additive-optional way `repo` was in `#1300` — but keyed by
 * `project`, not `role`: a collaborator is a peer fleet, never one of this
 * fleet's own agents.
 *
 * **Why this lives on the LOCK, not `FleetCollaboratorSchema` (the manifest)
 * — settled on `#1330`, not this codebase's own inference.** A peer's
 * recipient set is not something this fleet DECLARES (the manifest is
 * intent — what the operator wants); it is something this fleet is TOLD and
 * must REMEMBER (the lock is fact — what was last observed/approved). The
 * eventual live value ({@link FleetCollaboratorSchema}'s own doc notes
 * `collaborators:` reconciliation is day-2, not yet implemented — `plan.ts`'s
 * `skipped_sections`) comes from asking the peer over the authenticated
 * channel (`#789`, not live yet); this field is what PINS that answer once
 * approved, so a re-ask can be compared against something durable instead of
 * trusted blind every time. `#1330`'s ruling: *"the CHANNEL supplies the
 * peer's CURRENT set (fresh, authenticated, unpinned); fleet.lock pins the
 * LAST-APPROVED set (what we agreed to, recorded); the guard fires on the
 * DIFF between them."* See `federated-age-recipients.ts` for that guard.
 *
 * `age_recipients` here follows the SAME `[]`-is-a-real-empty-set /
 * absent-is-unknown convention {@link FleetLockSchema.age_recipients}
 * already establishes for THIS fleet's own set — scoped per collaborator:
 * NO ENTRY for a project in {@link FleetLockSchema.collaborators} means
 * "never federated (or never approved) yet, nothing recorded" (honest
 * unknown — `#1330`'s AC, mirroring `#1252`'s rule); an entry WITH
 * `age_recipients: []` means "recorded, and the peer had zero recipients at
 * last approval" (a real, comparable fact, not a gap). PUBLIC keys — safe to
 * commit verbatim, same posture the top-level `age_recipients` field
 * already takes (`#1330`'s own AC: "the recipient set is public key
 * material... a reader may assume the same sensitivity" as the adjacent
 * `ca_bundle`, so this doc states it explicitly).
 */
export const FleetLockCollaboratorSchema = z
  .object({
    project: z.string().min(1),
    age_recipients: z.array(z.string().min(1)),
  })
  .strict();
export type FleetLockCollaborator = z.infer<typeof FleetLockCollaboratorSchema>;

/**
 * groundnuty/macf#1162 — provenance-only marker for a credential this fleet
 * holds a LOCAL COPY of rather than one it minted/confirmed itself (today:
 * only the router App's `'vault-reused'` cross-fleet-shared-scope outcome —
 * `apply-router-app.ts::RouterAppApplyOutcome`'s doc). Deliberately NOT an
 * `agents[]` entry: that array's `install_id` is a REQUIRED, GitHub-confirmed
 * installation id, and a vault-reused credential was never live-reconfirmed
 * THIS run (no install to record) — see this schema's `install_id` field
 * and `apply-router-app.ts`'s doc for why `apply-fleet.ts` cannot produce
 * one here even if it wanted to.
 *
 * The four literal fields spell out, IN THE RAW JSON, exactly what the
 * interim state is — `scope-level · held locally · origin_fleet ·
 * pending: scope-store` — so a future reader (human or the eventual
 * `#1084` scope-store migration) does not need to consult this schema's
 * docstring to understand what they are looking at; the marker is
 * self-describing on disk. `origin_fleet` is OPTIONAL (not a sentinel
 * string like `"unknown"` — a real fleet could be named that) because an
 * operator who performs the interim cross-fleet vault copy without also
 * declaring `transport.router_app_origin_fleet` in `fleet.yaml` still gets
 * a marker (never silently indistinguishable from genuine ownership) — just
 * one that honestly omits a source it was never told.
 *
 * Provenance ONLY — nothing in this codebase reads this field to change
 * behaviour (`composeFleetLock`'s own module doc); it exists so a reader
 * can tell "this is the interim workaround" from "this is the design," and
 * so rotation has a known source to enumerate rather than N equally
 * plausible, unattributed local copies (the drift class the originating
 * Amendment warns about).
 */
export const ScopeCredentialMarkerSchema = z
  .object({
    role: z.string().min(1),
    scope: z.literal('scope-level'),
    held: z.literal('locally'),
    origin_fleet: z.string().min(1).optional(),
    pending: z.literal('scope-store'),
  })
  .strict();

export type ScopeCredentialMarker = z.infer<typeof ScopeCredentialMarkerSchema>;

export const FleetLockSchema = z
  .object({
    schema_version: z.literal(FLEET_LOCK_SCHEMA_VERSION),
    fleet: z.string().min(1),
    agents: z.array(FleetLockAgentSchema),
    versions: FleetVersionsSchema.partial().strict().optional(),
    /**
     * Fleet-level fingerprints not tied to one agent (CA key, routing-client
     * cert/key, ...). NOT "the shared macf-routing App" (stale as of
     * groundnuty/macf#1074 — the routing App is now a DEDICATED per-fleet
     * identity, recorded like any other role in `agents[]` above, role
     * `'router'` — see `apply-router-app.ts`). TS OAuth is operator-provided
     * and lives only in the vault (Amendment C) — `apply` never fingerprints
     * a value it never mints.
     *
     * **Renamed from the bare `fingerprints` (groundnuty/macf#1310)** — the
     * old name collided with {@link FleetLockAgentSchema.fingerprints}'s
     * PER-AGENT map (same word, different scope, different nesting depth):
     * a naming collision that invited a reader to look in the wrong home
     * even though no code in this repo ever actually did (science-agent's
     * #1310 ruling: "fix the lookup, and disambiguate the names... should
     * not be the same word"). Read via {@link effectiveFleetFingerprints},
     * never this field or the legacy one directly — that helper falls back
     * to {@link fingerprints} (below) for a lock written before this
     * rename, so an already-provisioned fleet's fingerprints keep reading
     * correctly with no re-apply required.
     */
    fleet_fingerprints: z.record(z.string(), z.string()).optional(),
    /**
     * @deprecated groundnuty/macf#1310 — the pre-rename name for
     * {@link fleet_fingerprints}. Kept here, optional, SOLELY so a lock
     * written by a pre-#1310 `apply` still parses (this schema is
     * `.strict()` — an unrecognized key would otherwise fail the whole
     * parse). Never read directly (use {@link effectiveFleetFingerprints})
     * and never written by this codebase going forward — `composeFleetLock`
     * / `serializeFleetLock` both write `fleet_fingerprints` only, even
     * when composing over a `previous` lock that still carries this legacy
     * key (`#1252`'s "a rename must read the old key and write the new
     * one" — the values migrate to the new key the next time this fleet's
     * lock is recomposed; the file is never left half-migrated across two
     * keys).
     */
    fingerprints: z.record(z.string(), z.string()).optional(),
    // groundnuty/macf#1162 — see `ScopeCredentialMarkerSchema`'s doc. Added
    // as a NEW optional field, no `FLEET_LOCK_SCHEMA_VERSION` bump: an
    // additive optional key doesn't change any EXISTING field's meaning
    // (the version-bump contract this schema's callers rely on) — the same
    // precedent `deployed_version` itself set when it was added after this
    // schema's introduction without bumping the version either.
    scope_credentials: z.array(ScopeCredentialMarkerSchema).optional(),
    /**
     * groundnuty/macf#1230 — the recipient set `apply` last successfully
     * wrote the vault against. **This is the record-half of #1230 only** —
     * nothing in this codebase yet REFUSES on this field (that is a
     * separate, deliberately-not-yet-shipped change; see
     * `age-recipients-narrowing.ts`'s eventual module doc). The defect this
     * closes on its own: `transport.age_recipients` (the DECLARED set) is
     * the only artifact recording who is *supposed* to have access, and
     * nothing recorded who a vault was *actually* encrypted to — age's
     * wrapped-key stanzas don't reveal recipient identities either
     * (`vault-read.ts`'s module doc), so absent this field, "who can
     * decrypt this vault?" was unanswerable from any artifact `apply`
     * produces, for every fleet already provisioned.
     *
     * PUBLIC keys — safe to commit verbatim, unlike `fingerprints` (which
     * hashes because ITS inputs are secret): an age recipient IS a public
     * key by construction, same posture `fleet.yaml`'s own
     * `transport.age_recipients` already takes.
     *
     * **`undefined` means UNKNOWN, never "zero recipients."** Two cases
     * collapse to `undefined`: no lock exists yet, or a lock exists but
     * PREDATES this field (any `apply` run from an older CLI never wrote
     * it). Both are "nothing recorded to compare against," not "this fleet
     * has no recipients" — that would be a real, comparable `[]`, written
     * only when the manifest itself legitimately declares an empty set
     * (`transport.age_recipients`'s own doc: `[]` before any key is
     * minted). Reading an absent lock-side value as `[]` would be actively
     * dangerous here — a future narrowing check comparing "recorded" vs.
     * "desired" would see `[] \ desired = []` (no removal) and silently
     * wave through a fleet whose actual recipient history is simply
     * unknown. Order is PRESERVED, never sorted — position is real
     * information for a multi-recipient vault (operator's key first, the
     * VM's second — see `transport.age_recipients`'s own doc).
     *
     * Added as a NEW optional field, no `FLEET_LOCK_SCHEMA_VERSION` bump —
     * same precedent `scope_credentials` immediately above already sets.
     */
    age_recipients: z.array(z.string().min(1)).optional(),
    /**
     * groundnuty/macf#1230 — append-only ledger of every recipient EVER
     * removed via an acknowledged `transport.age_recipients_narrowing_override`
     * (never pruned — same "carry forward, union, never delete" convention
     * every other merge in `fleet-lock.ts` establishes). This is the
     * durable proof a removal from {@link age_recipients} was deliberate
     * and acknowledged, not silent or accidental: comparing two
     * `fleet.lock`s with the SAME (narrow) `age_recipients` array, a reader
     * cannot otherwise tell "this fleet always had this set" from "this
     * fleet had a recipient removed with an acknowledged override."
     * `undefined` (never `[]`) when no override has ever been used,
     * matching this schema's own "omit rather than write a vacuous empty
     * collection" convention. Deduplicated + sorted (unlike
     * {@link age_recipients}, position here carries no meaning — this is a
     * historical SET of removed identities, not a currently-declared
     * ordered list).
     */
    age_recipients_removed_by_override: z.array(z.string().min(1)).optional(),
    /**
     * groundnuty/macf#1330 — the last-approved age recipient set PER
     * FEDERATED PEER (`FleetLockCollaboratorSchema`, keyed by `project`) —
     * distinct from {@link age_recipients} immediately above (which records
     * THIS fleet's OWN set). See that schema's doc for why the value lives
     * here (fact, observed/approved) rather than on `FleetCollaboratorSchema`
     * in `fleet.yaml` (intent, declared) — `#1330`'s ruling: the manifest
     * cannot declare a peer's keys because this fleet does not choose them.
     *
     * `undefined` when this fleet has never federated (or never approved a
     * federation for) any peer — distinct from `[]`, which this field never
     * takes at the array level (an empty array here would mean "federated
     * zero peers," a state indistinguishable from "never touched"; `#1330`
     * follows `scope_credentials`'s own "omit rather than write a vacuous
     * empty collection" convention for that reason). Per-entry, EACH
     * collaborator's `age_recipients` DOES carry the real `[]`-vs-absent
     * distinction — see `FleetLockCollaboratorSchema`'s own doc.
     *
     * Sorted by `project` for {@link serializeFleetLock}'s determinism
     * contract (unlike {@link age_recipients}, where POSITION within one
     * peer's set is real information and is preserved — but the ORDER OF
     * PEERS carries no such meaning, same reasoning `scope_credentials`
     * sorting by `role` already applies at this array's sibling level).
     *
     * Added as a NEW optional field, no `FLEET_LOCK_SCHEMA_VERSION` bump —
     * same precedent `scope_credentials` / `age_recipients` already set.
     */
    collaborators: z.array(FleetLockCollaboratorSchema).optional(),
  })
  .strict();

export type FleetLockAgent = z.infer<typeof FleetLockAgentSchema>;
export type FleetLock = z.infer<typeof FleetLockSchema>;

/**
 * The effective fleet-level fingerprint map (groundnuty/macf#1310) —
 * **never** the per-agent one (that lives at `lock.agents[i].fingerprints`
 * and has no legacy-key concern; see {@link FleetLockAgentSchema}'s doc for
 * why the two must not be confused). Prefers the current
 * {@link FleetLockSchema.fleet_fingerprints} key; falls back to the
 * deprecated {@link FleetLockSchema.fingerprints} key for a lock written
 * before this rename. `undefined` when NEITHER key is recorded — a fleet
 * that has never minted a fleet-level secret (CA key / routing-client
 * cert-key / router App key), or no lock at all.
 *
 * Every reader of fleet-level fingerprints MUST go through this function
 * rather than accessing either key directly — that is the entire point of
 * the rename: a future re-serialize always writes `fleet_fingerprints`
 * only (never the legacy key — see `fleet-lock.ts::composeFleetLock` /
 * `serializeFleetLock`), so a reader still checking the old key alone would
 * see its fingerprints silently "disappear" the moment this fleet's lock is
 * next recomposed, even though nothing was lost.
 */
export function effectiveFleetFingerprints(
  lock: Pick<FleetLock, 'fleet_fingerprints' | 'fingerprints'> | null | undefined,
): Record<string, string> | undefined {
  return lock?.fleet_fingerprints ?? lock?.fingerprints;
}

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
