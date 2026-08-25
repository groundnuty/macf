/**
 * `macf bootstrap manifest scaffold` — draft a `fleet.yaml` from live
 * GitHub state for a fleet that predates the manifest (groundnuty/macf#1153).
 *
 * `#878` migrates three live fleets (`macf`, `icsoc-2026`, `ppam-2026`) to
 * Amendment F control repos; none has a `fleet.yaml` — each manifest has to
 * be reverse-engineered from a fleet that already exists. This module reads
 * live state via `observer.ts`'s EXISTING exported primitives — it never
 * adds a second way to ask GitHub the same question those already answer
 * (repo/archived/actions-pin/CA-var/routing-client-secret/registry-var
 * reads all reuse `observer.ts` verbatim). Two NEW primitives are added
 * HERE (not in `observer.ts`) because they answer questions `observer.ts`
 * never needed to: {@link fetchOwnerType} (`owner.type` has no existing
 * reader) and {@link readAgentConfigWorkspaceDirReal} (a repo's committed
 * `.github/agent-config.json`, which `observer.ts` never reads).
 *
 * **The circularity this module must not fall into (macf#1153 amendment
 * comment, citing `#1132`'s modal-pin defect):** `observer.ts` is what
 * `bootstrap plan` diffs a manifest AGAINST. A manifest scaffolded from
 * that same observation and then validated by running `plan` against it
 * yields an EMPTY plan by construction — not because the manifest is
 * correct, but because its reference value is derived from the population
 * it is checked against. **No test in this codebase may assert "scaffolded
 * manifest ⇒ empty plan"** (see `assert-the-wrong-path.md`'s canonical
 * worked example, which names this exact scenario) — the only real
 * verification is a human reading the draft, especially its TODOs. This
 * module never imports `plan.ts::computePlan`.
 *
 * **`versions:` is a hard exclusion (Amendment L).** `apply` converges the
 * live fleet TOWARD whatever `versions:` declares. Scaffolding it from
 * observed reality would RATIFY today's drift as tomorrow's enforced
 * intent — the tool would then converge everyone toward a version nobody
 * chose, with `apply` working exactly as designed throughout. `versions:`
 * is therefore NEVER emitted as a declared key (the section is `.optional()`
 * — omitting it entirely keeps the draft schema-legal); the observed value
 * is surfaced only as a comment.
 *
 * **`age_recipients: []` is the single most dangerous default in this
 * schema and this module NEVER emits it.** Per `fleet-manifest.ts`'s own
 * doc, an empty array is not "unknown" — it is the SPECIFIC declaration "no
 * age key exists yet," which tells `apply` to MINT A FRESH ONE. Emitting
 * `[]` for an already-provisioned fleet (the only kind this command drafts
 * for) would silently instruct a future `apply` to mint a second key for a
 * fleet that already has one. `age_recipients` is therefore ALWAYS a TODO,
 * unconditionally — see the audit table below.
 *
 * **No field is ever a placeholder string VALUE.** A `role_template: TODO`
 * literal would silently satisfy `z.string().min(1)` and validate as if it
 * were a real template name — the exact false-positive this module exists
 * to prevent (found while writing this module: the first draft did this
 * for four fields before being caught). Every unconfirmed-or-irreducible
 * field is instead an OMITTED key plus an explanatory comment — the schema
 * then fails it honestly, as "required, missing," at parse time.
 *
 * ---
 *
 * ## Observability audit — every v0 `FleetManifestSchema` field
 *
 * `input` = operator-supplied on the command line, not something the
 * observer could confirm or refute. `observable` = a live GitHub read
 * confirms it (reusing `observer.ts` where the read already exists).
 * `derivable` = a deterministic rule or schema default fills it, never a
 * guess about data the tool cannot see. `unconfirmable` = no live signal
 * exists (or the issue's own instruction forbids deciding it), so the field
 * is ALWAYS a TODO. See {@link MANIFEST_SCAFFOLD_AUDIT_TABLE} for the
 * machine-readable form of this same table.
 *
 * | field                              | verdict                | why |
 * |---|---|---|
 * | apiVersion                         | derivable               | protocol constant `macf/v0` |
 * | kind                                | derivable               | protocol constant `Fleet` |
 * | metadata.name                       | input                   | `--fleet` |
 * | versions.macf                       | unconfirmable (by design) | Amendment L; no live signal exists anyway (no `fleet.lock`, no mTLS `/health` route from this plane) |
 * | versions.actions                    | unconfirmable (by design) | Amendment L; the CURRENT per-repo pin IS live-observable (`readCallerActionsPin`) and is surfaced as a comment, never declared |
 * | owner.account                       | input                   | `--owner` |
 * | owner.type                          | observable              | live `GET /users/{account}` (`.type`) — ambient auth, no App JWT |
 * | owner.registry                      | observable (conditional) | tries the conventional org/profile candidate (from `owner.type`) and confirms via a live registry-scope CA-var read; TODO if not confirmed present |
 * | network.advertise_host              | observable (conditional) | cross-agent registry-entry `host` agreement (`readAgentRegistryInfo`); TODO if no agent is registered yet or hosts disagree |
 * | transport.age_recipients            | unconfirmable (always)  | recipient public keys are cryptographically unrecoverable from the vault file itself (anonymous recipient stanzas) — only the stanza COUNT is derivable, surfaced as a comment; `[]` is never emitted (see module doc above) |
 * | transport.tailscale_oauth_required  | derivable (vault-conditional) | omitted (schema default `false`) unless `--vault`/`--identity-key` confirm both TS_OAUTH fields present |
 * | transport.router_app_scope          | derivable               | omitted; schema default `'shared'` applies — its own schema doc: a standing operator preference, not a vault-observable fact |
 * | defaults.role_template              | unconfirmable (by instruction) | a fleet predating the role-template convention has no answer; reported as a question for the reporter, never decided here |
 * | defaults.app_manifest               | unconfirmable           | UNCONSUMED anywhere downstream (verified: zero non-schema/non-fixture references) — every fixture uses `'dr-019'` by convention, but that is fixture convention, not fleet observation; deriving from it would be the same move `versions:` deliberately avoids, one layer removed |
 * | agents[].role                       | input                   | `--agent role=repo` |
 * | agents[].repo                       | input                   | `--agent role=repo` — genuinely undiscoverable otherwise: enumerating an App installation's repos needs `GET /installation/repositories`, which authenticates AS the installation and needs an install access token this credential-free, JWT-less tool structurally never holds (Amendment A) |
 * | agents[].profile                    | unconfirmable           | provably NOT a function of `role` — real fixtures show `science-agent`→`research` and `runner-ops`→`code`, so no derivation rule exists |
 * | agents[].deploy_path                | observable (conditional) | live content-read of the repo's own committed `.github/agent-config.json`, `agents[<role>].workspace_dir`; TODO if the file/entry is absent or unreadable |
 * | agents[].provenance                 | omitted (optional)      | no live signal distinguishes template-clone vs mirror-remote provenance after the fact |
 * | routing.*                           | omitted (optional)      | declarative routing-target/label/hibernation policy; no live signal drives any of the three sub-fields |
 * | collaborators                       | omitted (optional)      | cross-fleet federation membership has no live discovery path implemented (day-2 per its own schema doc) |
 * | shared                              | omitted (optional)      | unconsumed field per its own schema doc |
 * | trust.ca                            | derivable               | v0 supports exactly one mode (`'per-project'`) — a schema enum literal, not an observation |
 * | trust.federated_cas                 | omitted (defaulted)     | no live discovery path; schema default `[]` applies, representing "no federation declared" rather than a confirmed absence |
 *
 * **`defaults.role_template` is flagged, never decided, per explicit
 * instruction** — this module reports it as a judgment call for whoever
 * reviews the draft; it does not attempt a `template_repository`-field
 * guess even though one theoretically exists on GitHub's repo API,
 * because "report it, don't decide it" was explicit.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYamlText } from 'yaml';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { FleetManifestSchema } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import type { AgentRegistryObservation, AgentRepoState, RepoArchivedMeta } from './observer.js';
import {
  checkRegistryVariablePresence,
  checkRepoArchivedState,
  readAgentRegistryInfo,
  readCallerActionsPin,
  resolveAgentRepoState,
} from './observer.js';
import type { VaultReadOptions, VaultRecipientCountResult } from './vault-read.js';
import { readVault, readVaultRecipientCount, vaultTsOauthClientId, vaultTsOauthSecret } from './vault-read.js';

const execFileAsync = promisify(execFile);

// --- Inputs ---

/** One operator-supplied role<->repo pairing — the seed the whole draft is built from (see the audit table: `agents[].repo` is genuinely undiscoverable without an App JWT this tool never holds). */
export interface ScaffoldAgentInput {
  readonly role: string;
  readonly repo: string;
}

export interface ManifestScaffoldInput {
  readonly owner: string;
  readonly fleetName: string;
  readonly agents: readonly ScaffoldAgentInput[];
}

/** Same contract as `bootstrap plan --vault`: BOTH fields together, or neither — the CLI layer enforces this via `plan.ts::checkVaultFlagsComplete` before calling in. */
export interface ManifestScaffoldVaultInput {
  readonly vaultPath: string;
  readonly identityKeyPath: string;
}

// --- Audit table (machine-readable form of the module doc's table) ---

export type ScaffoldVerdict = 'input' | 'observable' | 'derivable' | 'unconfirmable';

export interface ScaffoldAuditRow {
  readonly field: string;
  readonly verdict: ScaffoldVerdict;
  readonly note: string;
}

/** Machine-readable mirror of the module doc's audit table — kept in lockstep by hand (both describe the same fixed set of v0 schema fields; neither is derived from the other). */
export const MANIFEST_SCAFFOLD_AUDIT_TABLE: readonly ScaffoldAuditRow[] = [
  { field: 'apiVersion', verdict: 'derivable', note: 'protocol constant macf/v0' },
  { field: 'kind', verdict: 'derivable', note: "protocol constant 'Fleet'" },
  { field: 'metadata.name', verdict: 'input', note: '--fleet' },
  { field: 'versions.macf', verdict: 'unconfirmable', note: 'never declared, always a TODO comment; no live signal exists either' },
  { field: 'versions.actions', verdict: 'unconfirmable', note: 'never declared; the current per-repo pin IS observable and surfaced as a comment' },
  { field: 'owner.account', verdict: 'input', note: '--owner' },
  { field: 'owner.type', verdict: 'observable', note: 'live GET /users/{account} .type, no App JWT needed' },
  { field: 'owner.registry', verdict: 'observable', note: 'conventional candidate confirmed via a live registry CA-var read; TODO if unconfirmed' },
  { field: 'network.advertise_host', verdict: 'observable', note: 'cross-agent registry-entry host agreement; TODO if no agent registered or hosts disagree' },
  { field: 'transport.age_recipients', verdict: 'unconfirmable', note: 'recipient identities are cryptographically unrecoverable; NEVER defaulted to [] (that means "mint a fresh key")' },
  { field: 'transport.tailscale_oauth_required', verdict: 'derivable', note: 'vault-conditional; schema default false otherwise' },
  { field: 'transport.router_app_scope', verdict: 'derivable', note: "omitted; schema default 'shared' applies" },
  { field: 'defaults.role_template', verdict: 'unconfirmable', note: 'explicit instruction: report as a question, never decide' },
  { field: 'defaults.app_manifest', verdict: 'unconfirmable', note: 'unconsumed downstream; fixture convention is not fleet observation' },
  { field: 'agents[].role', verdict: 'input', note: '--agent role=repo' },
  { field: 'agents[].repo', verdict: 'input', note: '--agent role=repo; undiscoverable without an install token' },
  { field: 'agents[].profile', verdict: 'unconfirmable', note: 'provably not a function of role (science-agent -> research, runner-ops -> code)' },
  { field: 'agents[].deploy_path', verdict: 'observable', note: 'live .github/agent-config.json workspace_dir read; TODO if absent' },
  { field: 'agents[].provenance', verdict: 'derivable', note: 'omitted (optional); no live signal' },
  { field: 'routing.*', verdict: 'derivable', note: 'omitted (optional); no live signal' },
  { field: 'collaborators', verdict: 'derivable', note: 'omitted (optional); day-2, no discovery path' },
  { field: 'shared', verdict: 'derivable', note: 'omitted (optional); unconsumed field' },
  { field: 'trust.ca', verdict: 'derivable', note: "v0's only mode ('per-project')" },
  { field: 'trust.federated_cas', verdict: 'derivable', note: 'omitted; schema default [] applies' },
];

// --- New primitives (not duplicates of anything observer.ts already reads) ---

/**
 * Live `user`-vs-`org` account-type read. `GET /users/{account}` works with
 * AMBIENT `gh` auth (no App JWT) and returns `type: "User"|"Organization"`
 * for EITHER kind of account — GitHub exposes orgs under the same `/users`
 * path. `owner.type` has no existing `observer.ts` reader, so this is a
 * genuinely NEW fact, not a second way to ask a question `observer.ts`
 * already answers. Any failure (network, `gh` missing, 404) degrades to
 * `'unknown'` — Amendment A's honest-unknown floor, never a guess. NEVER
 * throws.
 */
export async function fetchOwnerType(account: string): Promise<'user' | 'org' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `users/${account}`, '--jq', '.type'], { encoding: 'utf-8' });
    const type = stdout.trim();
    if (type === 'Organization') return 'org';
    if (type === 'User') return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Parses `.github/agent-config.json`'s `agents[role].workspace_dir`; `undefined` on any shape mismatch — defensive (untyped JSON off the wire, same posture as `observer.ts`'s own parse helpers). */
function extractWorkspaceDir(parsed: unknown, role: string): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('agents' in parsed)) return undefined;
  const agents = (parsed as { agents?: unknown }).agents;
  if (typeof agents !== 'object' || agents === null) return undefined;
  const entry = (agents as Record<string, unknown>)[role];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const workspaceDir = (entry as { workspace_dir?: unknown }).workspace_dir;
  return typeof workspaceDir === 'string' && workspaceDir.length > 0 ? workspaceDir : undefined;
}

/**
 * Best-effort read of a repo's own committed `.github/agent-config.json` —
 * `agents[].deploy_path` has no other live signal (this Mac-side tool never
 * touches the VM). Reuses the SAME content-read shape
 * `observer.ts::readCallerActionsPin` already establishes (`gh api
 * repos/<repo>/contents/<path> --jq .content`, base64 decode, best-effort
 * `undefined` on ANY failure) — a genuinely different FILE, so this is not
 * a duplicate of that function, just the same established shape. NEVER
 * throws.
 */
export async function readAgentConfigWorkspaceDirReal(repo: string, role: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}/contents/.github/agent-config.json`, '--jq', '.content'], {
      encoding: 'utf-8',
    });
    const decoded = Buffer.from(stdout.replace(/\s+/g, ''), 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(decoded);
    return extractWorkspaceDir(parsed, role);
  } catch {
    return undefined;
  }
}

// --- Injectable seam ---

export interface ManifestScaffoldDeps {
  readonly fetchOwnerType: (account: string) => Promise<'user' | 'org' | 'unknown'>;
  readonly checkRegistryVariablePresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly readAgentRegistryInfo: (registry: RegistryConfig, fleetName: string, role: string) => Promise<AgentRegistryObservation>;
  readonly checkRepoArchivedState: (repo: string) => Promise<RepoArchivedMeta>;
  readonly readCallerActionsPin: (repo: string) => Promise<string | undefined>;
  readonly resolveAgentRepoState: (repo: string, caVarName: string, routingClientSecretName: string) => Promise<AgentRepoState>;
  readonly readAgentConfigWorkspaceDir: (repo: string, role: string) => Promise<string | undefined>;
  readonly readVault: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  readonly readVaultRecipientCount: (vaultPath: string) => VaultRecipientCountResult;
}

/** Production wiring — every gh-shelling function this module reuses from `observer.ts`, plus the two new primitives above. */
export const REAL_MANIFEST_SCAFFOLD_DEPS: ManifestScaffoldDeps = {
  fetchOwnerType,
  checkRegistryVariablePresence,
  readAgentRegistryInfo,
  checkRepoArchivedState,
  readCallerActionsPin,
  resolveAgentRepoState,
  readAgentConfigWorkspaceDir: readAgentConfigWorkspaceDirReal,
  readVault,
  readVaultRecipientCount,
};

// --- Result ---

export interface ManifestScaffoldResult {
  readonly yaml: string;
  readonly todos: readonly string[];
  readonly todoCount: number;
  /** Real `FleetManifestSchema.safeParse()` issue paths (dot-joined), verbatim — proves well-formedness only; see the module doc for why an irreducible set of these can NEVER be empty. */
  readonly schemaIssuePaths: readonly string[];
}

/**
 * The fixed disclaimer every render carries — the command's OWN output
 * stating its limit, read every time anyone runs it (not just once, in the
 * issue, at implementation time).
 */
export const SCAFFOLD_LIMIT_STATEMENT =
  'This draft is derived from observation, not correctness. A clean plan run against it would prove only that ' +
  'the draft agrees with itself — its reference value comes from the same observation that built it — never ' +
  'mistake that for verification. Review every field below, especially each TODO, before treating this file as ' +
  'ready to commit.';

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function candidateRegistry(ownerType: 'user' | 'org', account: string): RegistryConfig {
  return ownerType === 'org' ? { type: 'org', org: account } : { type: 'profile', user: account };
}

interface OwnerResolution {
  readonly ownerType?: 'user' | 'org';
  readonly ownerTypeTodo?: string;
  readonly registry?: RegistryConfig;
  readonly registryTodo?: string;
}

/** Resolves `owner.type` (live) then, if confirmed, `owner.registry` (candidate + live CA-var confirm). Cascades: an unconfirmed `owner.type` makes `owner.registry` unconfirmable too — there is no candidate to test without knowing user-vs-org. */
async function resolveOwner(input: ManifestScaffoldInput, deps: ManifestScaffoldDeps): Promise<OwnerResolution> {
  const ownerType = await deps.fetchOwnerType(input.owner);
  if (ownerType === 'unknown') {
    return {
      ownerTypeTodo: `owner.type could not be confirmed (live "gh api users/${input.owner}" read failed or returned neither User nor Organization) — owner.registry cannot be derived without it either.`,
      registryTodo: 'owner.type is unconfirmed (see above) — no candidate registry scope to test.',
    };
  }
  const candidate = candidateRegistry(ownerType, input.owner);
  const caVarName = `${toVariableSegment(input.fleetName)}_CA_CERT`;
  const presence = await deps.checkRegistryVariablePresence(candidate, caVarName);
  if (presence === 'present') {
    return { ownerType, registry: candidate };
  }
  const scopeDesc = ownerType === 'org' ? `org scope (org: "${input.owner}")` : `profile scope (user: "${input.owner}")`;
  return {
    ownerType,
    registryTodo: `could not confirm — tried the conventional ${scopeDesc} and "${caVarName}" read back "${presence}" there. Confirm the actual registry scope and declare it manually.`,
  };
}

interface AdvertiseHostResolution {
  readonly host?: string;
  readonly todo?: string;
}

/** `network.advertise_host` — cross-agent registry-entry host agreement, probed against the CANDIDATE registry (independent of whether `owner.registry` itself confirmed present — a positive multi-agent-agreement finding is valuable evidence either way). */
async function resolveAdvertiseHost(
  input: ManifestScaffoldInput,
  ownerType: 'user' | 'org' | undefined,
  deps: ManifestScaffoldDeps,
): Promise<AdvertiseHostResolution> {
  if (ownerType === undefined) {
    return { todo: 'owner.type is unconfirmed — no candidate registry to read agent entries from.' };
  }
  const registry = candidateRegistry(ownerType, input.owner);
  const hosts = new Set<string>();
  for (const agent of input.agents) {
    const obs = await deps.readAgentRegistryInfo(registry, input.fleetName, agent.role);
    if (obs.status === 'confirmed' && obs.presence === 'present') hosts.add(obs.info.host);
  }
  if (hosts.size === 1) return { host: [...hosts][0] };
  if (hosts.size === 0) {
    return { todo: 'no declared agent has a confirmed registry entry yet (or the candidate registry itself is unreachable) — nothing to read a host from.' };
  }
  return { todo: `declared agents disagree on advertised host (${[...hosts].sort().join(', ')}) — this is drift, not a single value to declare.` };
}

interface AgentObservation {
  readonly input: ScaffoldAgentInput;
  readonly repoState: AgentRepoState;
  readonly archived?: boolean;
  readonly actionsPin?: string;
  readonly deployPath?: string;
}

async function resolveAgent(agent: ScaffoldAgentInput, fleetName: string, deps: ManifestScaffoldDeps): Promise<AgentObservation> {
  const caVarName = `${toVariableSegment(fleetName)}_CA_CERT`;
  const [repoState, archivedMeta, actionsPin, deployPath] = await Promise.all([
    deps.resolveAgentRepoState(agent.repo, caVarName, 'ROUTING_CLIENT_CERT'),
    deps.checkRepoArchivedState(agent.repo),
    deps.readCallerActionsPin(agent.repo),
    deps.readAgentConfigWorkspaceDir(agent.repo, agent.role),
  ]);
  return { input: agent, repoState, archived: archivedMeta.archived, actionsPin, deployPath };
}

interface VaultFacts {
  readonly recipientStanzaCount?: number;
  readonly tsOauthPresent?: boolean;
  readonly readError?: string;
}

async function resolveVaultFacts(vault: ManifestScaffoldVaultInput | undefined, deps: ManifestScaffoldDeps): Promise<VaultFacts> {
  if (vault === undefined) return {};
  const countResult = deps.readVaultRecipientCount(vault.vaultPath);
  const recipientStanzaCount = countResult.status === 'counted' ? countResult.count : undefined;
  try {
    const raw = await deps.readVault({ vaultPath: vault.vaultPath, identityPath: vault.identityKeyPath });
    return { recipientStanzaCount, tsOauthPresent: vaultTsOauthClientId(raw) !== undefined && vaultTsOauthSecret(raw) !== undefined };
  } catch (err) {
    return { recipientStanzaCount, readError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Renders one `agents:` list entry's YAML lines, plus its own TODO entries.
 * `role`/`repo` are ALWAYS present (operator input). `profile` is ALWAYS
 * OMITTED (see audit table — unconditionally unconfirmable); `deploy_path`
 * is omitted only when the `.github/agent-config.json` read failed. Neither
 * omitted field is ever rendered as a placeholder VALUE — see the module
 * doc's "no field is ever a placeholder string VALUE" note.
 */
function renderAgentBlock(obs: AgentObservation, index: number): { readonly lines: readonly string[]; readonly todos: readonly string[] } {
  const { input: agent } = obs;
  const todos: string[] = [];
  const observedBits: string[] = [
    `repo=${obs.repoState.repo}`,
    obs.archived === undefined ? 'archived=unknown' : `archived=${String(obs.archived)}`,
    `actions_pin=${obs.actionsPin ?? 'unknown'}`,
    `ca_var=${obs.repoState.caRepo}`,
    `routing_client_secret=${obs.repoState.routingClientRepo}`,
  ];
  const lines: string[] = [
    `  - role: ${yamlScalar(agent.role)}`,
    `    # observed: ${observedBits.join(', ')}`,
  ];

  const profileTodo = `agents[${String(index)}].profile ("${agent.role}"): not observable from GitHub state — names a local Claude-Code agent-identity template with no live signal, and is provably not a function of role (e.g. science-agent -> research).`;
  todos.push(profileTodo);
  lines.push(`    # TODO ${profileTodo} (key omitted below — fill in "profile: <name>")`);

  lines.push(`    repo: ${yamlScalar(agent.repo)}`);

  if (obs.deployPath !== undefined) {
    lines.push(`    deploy_path: ${yamlScalar(obs.deployPath)} # observed via .github/agent-config.json`);
  } else {
    const deployTodo = `agents[${String(index)}].deploy_path ("${agent.role}"): .github/agent-config.json on "${agent.repo}" has no readable workspace_dir entry for this role.`;
    todos.push(deployTodo);
    lines.push(`    # TODO ${deployTodo} (key omitted below — fill in "deploy_path: <path>")`);
  }

  return { lines, todos };
}

/**
 * Draft a `fleet.yaml` from live GitHub state (groundnuty/macf#1153).
 * READ-ONLY end to end — never writes to a repo (stdout/local-file
 * rendering is the CLI layer's job, `commands/bootstrap-manifest-scaffold.ts`);
 * this function makes exactly the reads {@link ManifestScaffoldDeps} lists,
 * nothing else, and no GitHub mutation exists anywhere in its call graph.
 */
export async function scaffoldManifest(
  input: ManifestScaffoldInput,
  deps: ManifestScaffoldDeps = REAL_MANIFEST_SCAFFOLD_DEPS,
  vault?: ManifestScaffoldVaultInput,
): Promise<ManifestScaffoldResult> {
  const todos: string[] = [];
  const owner = await resolveOwner(input, deps);
  const advertiseHost = await resolveAdvertiseHost(input, owner.ownerType, deps);
  const agentObs = await Promise.all(input.agents.map((a) => resolveAgent(a, input.fleetName, deps)));
  const vaultFacts = await resolveVaultFacts(vault, deps);
  const actionsPins = agentObs.map((o) => `${o.input.role}=${o.actionsPin ?? 'unknown'}`).join(', ');

  const lines: string[] = [];
  lines.push('# fleet.yaml — SCAFFOLDED DRAFT (macf bootstrap manifest scaffold)');
  lines.push('#');
  for (const l of wrapComment(SCAFFOLD_LIMIT_STATEMENT)) lines.push(`# ${l}`);
  lines.push('');
  lines.push('apiVersion: macf/v0');
  lines.push('kind: Fleet');
  lines.push('');
  lines.push('metadata:');
  lines.push(`  name: ${yamlScalar(input.fleetName)}`);
  lines.push('');

  const versionsTodo = `versions.macf: not observable from GitHub state alone (no fleet.lock yet, no live agent /health.version route from this plane). versions.actions: observed per-repo agent-router.yml pins — ${actionsPins}. Neither is declared here (key omitted) — see the module doc for why: declaring converts observation into enforced intent.`;
  todos.push(versionsTodo);
  lines.push(`# TODO ${versionsTodo}`);
  lines.push('');

  lines.push('owner:');
  lines.push(`  account: ${yamlScalar(input.owner)}`);
  if (owner.ownerType !== undefined) {
    lines.push(`  type: ${yamlScalar(owner.ownerType)}`);
  } else {
    todos.push(`owner.type: ${owner.ownerTypeTodo ?? 'unconfirmed'}`);
    lines.push(`  # TODO owner.type: ${owner.ownerTypeTodo ?? 'unconfirmed'} (key omitted below)`);
  }
  if (owner.registry !== undefined) {
    lines.push(`  registry: ${JSON.stringify(owner.registry)}`);
  } else {
    todos.push(`owner.registry: ${owner.registryTodo ?? 'unconfirmed'}`);
    lines.push(`  # TODO owner.registry: ${owner.registryTodo ?? 'unconfirmed'} (key omitted below)`);
  }
  lines.push('');

  lines.push('network:');
  if (advertiseHost.host !== undefined) {
    lines.push(`  advertise_host: ${yamlScalar(advertiseHost.host)} # observed: every declared agent's registry entry agrees`);
  } else {
    todos.push(`network.advertise_host: ${advertiseHost.todo ?? 'unconfirmed'}`);
    lines.push(`  # TODO network.advertise_host: ${advertiseHost.todo ?? 'unconfirmed'} (key omitted below)`);
    // `network:` would otherwise have ZERO keys and parse as `null`, not an
    // (incomplete) object — an empty flow mapping keeps the per-field zod
    // issue precise (`network.advertise_host`, not just `network`).
    lines.push('  {}');
  }
  lines.push('');

  lines.push('transport:');
  const recipientNote =
    vaultFacts.recipientStanzaCount !== undefined
      ? `the vault currently has ${String(vaultFacts.recipientStanzaCount)} recipient stanza(s)`
      : vault === undefined
        ? 'no --vault/--identity-key given — stanza count not read this run'
        : `vault read failed: ${vaultFacts.readError ?? 'unknown error'}`;
  const ageTodo =
    `age_recipients: recipient PUBLIC KEYS cannot be recovered from the vault file (anonymous recipient stanzas) — ` +
    `${recipientNote}. NEVER default this to [] — that value means "no key yet, mint one" and would be dangerous ` +
    'for an already-provisioned fleet. Supply the operator-held age public key(s) directly.';
  todos.push(ageTodo);
  lines.push(`  # TODO ${ageTodo} (key omitted below)`);
  lines.push('  # router_app_scope omitted — schema default "shared" applies (a standing preference, not vault-observable)');
  if (vaultFacts.tsOauthPresent === true) {
    lines.push('  tailscale_oauth_required: true # observed: vault has both TS_OAUTH_CLIENT_ID and TS_OAUTH_SECRET');
  } else {
    // Same `{}`-vs-`null` reasoning as `network:` above — age_recipients is
    // ALWAYS omitted, so without this fallback `transport:` would have zero
    // keys whenever tailscale_oauth_required also isn't declared.
    lines.push('  {}');
  }
  lines.push('');

  lines.push('defaults:');
  const roleTemplateTodo =
    'defaults.role_template: a repo WAS created from some template, but a fleet predating the role-template ' +
    'convention has no recorded answer — this is a project decision, reported here as a question, not decided.';
  todos.push(roleTemplateTodo);
  lines.push(`  # TODO ${roleTemplateTodo} (key omitted below)`);
  const appManifestTodo =
    "defaults.app_manifest: unconsumed anywhere downstream today; every existing fixture uses 'dr-019' by " +
    'convention, but that is fixture convention, not fleet observation — confirm and declare explicitly.';
  todos.push(appManifestTodo);
  lines.push(`  # TODO ${appManifestTodo} (key omitted below)`);
  // Both fields in this section are ALWAYS omitted (see the audit table) —
  // same `{}`-vs-`null` reasoning as `network:`/`transport:` above.
  lines.push('  {}');
  lines.push('');

  lines.push('agents:');
  for (const [index, obs] of agentObs.entries()) {
    const { lines: agentLines, todos: agentTodos } = renderAgentBlock(obs, index);
    lines.push(...agentLines);
    todos.push(...agentTodos);
  }
  lines.push('');
  lines.push('# routing / collaborators / shared / trust: omitted — see the module doc audit table for why each is safe to omit');

  const yaml = lines.join('\n') + '\n';
  const schemaIssuePaths = computeSchemaIssuePaths(yaml);

  return { yaml, todos, todoCount: todos.length, schemaIssuePaths };
}

/** Wraps a long disclaimer sentence to ~78 cols for the YAML header comment block — purely cosmetic, never changes content. */
function wrapComment(text: string): readonly string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > 78) {
      out.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/**
 * The REAL round-trip: parse the rendered YAML text and run it through
 * `FleetManifestSchema.safeParse()`, returning the issue paths verbatim
 * (dot-joined). Proves well-formedness only (per the module doc) — an
 * irreducible subset of these paths (`defaults.role_template`,
 * `defaults.app_manifest`, `transport.age_recipients`, and every
 * `agents[N].profile`) can NEVER be empty in v0, by design; see the module
 * doc for why that is not a defect in this function.
 */
function computeSchemaIssuePaths(yamlText: string): readonly string[] {
  const raw: unknown = parseYamlText(yamlText);
  const result = FleetManifestSchema.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}
