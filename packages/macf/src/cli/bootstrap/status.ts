/**
 * `macf bootstrap status` — pure rendering of observed fleet state, no diff
 * (groundnuty/macf#1017).
 *
 * The operator directive this closes, close to verbatim: *"we don't have
 * the status part that Kubernetes would populate automatically... and we
 * don't want this, because we don't have any controller or reconciler that
 * would be updating this. However, I think that we should have a command
 * that will get us such."* — status ON DEMAND (observe now, print what is
 * there, store nothing), never a stored/reconciled field that can go stale
 * and lie.
 *
 * **This is a rendering, not new machinery — confirmed before writing this
 * file (macf#1017's own required first step).** `observer.ts`'s
 * `githubRegistryObserver` / `vaultAwareObserver` already observe
 * EVERYTHING `macf bootstrap plan` needs, into `ObservedState` — nothing is
 * discarded there. The discard `#1017` worried about happens one layer up,
 * in `plan.ts`'s PlanItem BUILDERS: `appItem`/`installItem` render a
 * `reason` STRING that never surfaces `obs.appId`/`obs.installId` (a diff
 * doesn't need to name the App ID of an already-`noop` resource; a status
 * view does), `secretFingerprintItem` collapses a fingerprint MAP into a
 * count-only verb, `caRepoItem` collapses per-repo presence into a
 * create/noop word. So this module renders straight off `ObservedState`
 * (+ the parsed `FleetManifest`, for declared identifiers) and NEVER calls
 * `computePlan` — no verbs, no create/update/noop, no confirm_required.
 *
 * **Provisioning vs. runtime — macf#1017's explicit split.** `fleet
 * status` (`commands/fleet.ts`) already answers "are my agents up" via a
 * live mTLS `/health` probe FROM an already-deployed agent's own workspace
 * (it needs that agent's client cert — `readAgentConfig`/`agentCertPath`).
 * This command's plane (the operator-privileged bootstrap tool, DR-035 §2)
 * structurally holds NO agent client cert — it never mints one, and by the
 * same credential-custody boundary never borrows a deployed agent's either.
 * So "runtime" here can go exactly as far as a `gh api`-only READ of the
 * agent's OWN registry entry (`observer.ts::readAgentRegistryInfo` —
 * `MACF_<PROJECT>_AGENT_<ROLE>`, written at agent-process startup) can
 * prove: that the agent REGISTERED, with what host:port/instance_id, and
 * how long ago its last heartbeat landed. It can NEVER prove the agent is
 * alive RIGHT NOW (online/uptime/cert_expiry are `/health` self-reports,
 * live-probe-only) — that half is rendered as an honest, explicitly-labeled
 * `unknown` with a pointer to `macf fleet status`, never fabricated as
 * "online" or "offline." This is Amendment A's honest-`unknown` floor
 * applied at the plane boundary, not just the per-field boundary.
 */
import { toVariableSegment } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle, deriveControlRepoName } from './fleet-manifest.js';
import { RUNNER_OPS_ROLE, deriveRunnerOpsHandle } from './apply-runner-ops.js';
import { formatTable } from '../commands/ps.js';
import type { ObservedState, Presence } from './plan.js';
import type { AgentRegistryObservation } from './observer.js';
import type { VaultAgentObservation, VaultCaObservation, VaultRecipientsObservation } from './vault-read.js';
import { countVaultAgentPresence, countVaultCaPresence } from './vault-read.js';

// --- View types (pure data — no verbs, no diff) ---

/** One declared agent's full observed state — provisioning + the registry-identity slice of runtime. */
export interface AgentStatusView {
  readonly role: string;
  readonly repo: string;
  readonly appHandle: string;
  readonly app: Presence;
  readonly appId?: string;
  readonly install: Presence;
  readonly installId?: string;
  readonly repoPresence: Presence;
  readonly caRepo: Presence;
  readonly routingClientRepo: Presence;
  readonly fingerprintCount: number;
  readonly deployedVersion?: string;
  readonly actionsPin?: string;
  /** `undefined` = vault not consulted this run (no `--vault`/`--identity-key`) — never a claim about vault contents. */
  readonly vault?: VaultAgentObservation;
  readonly registry: AgentRegistryObservation;
}

/** An agent `fleet.lock` remembers that `fleet.yaml` no longer declares — reported, never pruned (§D3). */
export interface ExtraLockAgentView {
  readonly role: string;
  readonly appId: string;
  readonly installId: string;
  readonly deployedVersion?: string;
}

/** The fleet-level runner-ops App (never in `manifest.agents[]` — macf#943). */
export interface RunnerOpsView {
  readonly appHandle: string;
  /** `'present'` when `fleet.lock` carries an entry; otherwise `'unknown'` — a missing lock entry is never proof of absence (same convention `plan.ts::runnerOpsItem` uses). */
  readonly presence: Presence;
  readonly appId?: string;
  readonly installId?: string;
}

export interface RoutingView {
  readonly runsOn: string;
  readonly warm: number;
  readonly trustedActors?: string;
  readonly runnerRegistered?: Presence;
  readonly runnerHandover?: string;
  readonly runnerDetail?: string;
}

export interface ControlRepoView {
  readonly repo: string;
  readonly presence: Presence;
  readonly archived?: boolean;
}

export interface CaView {
  readonly varName: string;
  readonly registryPresence: Presence;
  readonly vault?: VaultCaObservation;
  readonly perRepo: Readonly<Record<string, Presence>>;
}

export interface VaultRecipientsView {
  readonly declaredCount: number;
  /** `undefined` = vault not consulted this run — same convention as `AgentStatusView.vault`. */
  readonly observation?: VaultRecipientsObservation;
}

/** Everything `macf bootstrap status` renders — one snapshot, no verbs. */
export interface FleetStatusView {
  readonly fleet: string;
  readonly lockPresent: boolean;
  readonly controlRepo: ControlRepoView;
  readonly runnerOps: RunnerOpsView;
  readonly ca: CaView;
  readonly agents: readonly AgentStatusView[];
  readonly extraLockAgents: readonly ExtraLockAgentView[];
  /** `undefined` when `routing.runner` isn't declared — same "nothing was promised" gate `plan.ts` uses. */
  readonly routing?: RoutingView;
  readonly vaultRecipients: VaultRecipientsView;
}

// --- Compute (pure — no I/O; `registry` is pre-fetched by the caller) ---

function buildAgentView(
  fleetName: string,
  agent: FleetAgent,
  observed: ObservedState,
  registry: Readonly<Record<string, AgentRegistryObservation>>,
): AgentStatusView {
  const obs = observed.agents[agent.role];
  return {
    role: agent.role,
    repo: agent.repo,
    appHandle: deriveAppHandle(fleetName, agent.role),
    app: obs?.app ?? 'unknown',
    appId: obs?.appId,
    install: obs?.install ?? 'unknown',
    installId: obs?.installId,
    repoPresence: obs?.repo ?? 'unknown',
    caRepo: observed.caRepos[agent.repo] ?? 'unknown',
    routingClientRepo: observed.routingClientRepos?.[agent.repo] ?? 'unknown',
    fingerprintCount: Object.keys(obs?.fingerprints ?? {}).length,
    deployedVersion: obs?.deployedVersion,
    actionsPin: obs?.actionsPin,
    vault: obs?.vault,
    registry: registry[agent.role] ?? { status: 'unknown', reason: 'registry not queried this run' },
  };
}

/**
 * Render `ObservedState` (+ the manifest, for declared identifiers) as one
 * status snapshot. Pure — no `gh`, no filesystem, no network. `registry` is
 * the caller's pre-fetched, per-role {@link AgentRegistryObservation} map
 * (built via `observer.ts::readAgentRegistryInfo`, one call per declared
 * agent) — kept OUT of `ObservedState`/`githubRegistryObserver` deliberately
 * (see this module's doc): it is a RUNTIME fact `plan.ts`'s `computePlan`
 * has no use for, and folding it into the shared provisioning-observation
 * type would grow a widely-tested pure function's surface for a status-only
 * concern. A role missing from `registry` (or `observed.agents`) degrades
 * to `unknown` here — the caller is never required to have attempted every
 * read, and a partially-provisioned fleet must render, not crash.
 */
export function computeBootstrapStatus(
  manifest: FleetManifest,
  observed: ObservedState,
  registry: Readonly<Record<string, AgentRegistryObservation>>,
): FleetStatusView {
  const fleetName = manifest.metadata.name;
  const seg = toVariableSegment(fleetName);
  const caVarName = `${seg}_CA_CERT`;

  const agents = manifest.agents.map((agent) => buildAgentView(fleetName, agent, observed, registry));

  // §D3 no-prune, rendering flavor: an agent `fleet.lock` remembers that
  // `fleet.yaml` no longer declares is reported, never silently dropped.
  // `RUNNER_OPS_ROLE` is excluded here — it has its own dedicated
  // fleet-level view below (it is NEVER in `manifest.agents[]` by design,
  // so without this exclusion it would ALWAYS render as "extra").
  const manifestRoles = new Set(manifest.agents.map((a) => a.role));
  const extraLockAgents: ExtraLockAgentView[] = (observed.lock?.agents ?? [])
    .filter((a) => a.role !== RUNNER_OPS_ROLE && !manifestRoles.has(a.role))
    .map((a) => ({ role: a.role, appId: a.app_id, installId: a.install_id, deployedVersion: a.deployed_version }));

  const runnerOpsLockEntry = observed.lock?.agents.find((a) => a.role === RUNNER_OPS_ROLE);
  const runnerOps: RunnerOpsView = {
    appHandle: deriveRunnerOpsHandle(fleetName),
    presence: runnerOpsLockEntry ? 'present' : 'unknown',
    appId: runnerOpsLockEntry?.app_id,
    installId: runnerOpsLockEntry?.install_id,
  };

  const controlRepo: ControlRepoView = {
    repo: `${manifest.owner.account}/${deriveControlRepoName(fleetName)}`,
    presence: observed.controlRepoPresence,
    archived: observed.controlRepoArchived,
  };

  const ca: CaView = {
    varName: caVarName,
    registryPresence: observed.caRegistry,
    vault: observed.vaultCa,
    perRepo: Object.fromEntries(manifest.agents.map((a) => [a.repo, observed.caRepos[a.repo] ?? 'unknown'])),
  };

  const routing: RoutingView | undefined = manifest.routing?.runner
    ? {
        runsOn: manifest.routing.runner.runs_on,
        warm: manifest.routing.runner.warm,
        trustedActors: observed.routingTrustedActors,
        runnerRegistered: observed.routingRunnerRegistered,
        runnerHandover: observed.routingRunnerHandover,
        runnerDetail: observed.routingRunnerDetail,
      }
    : undefined;

  const vaultRecipients: VaultRecipientsView = {
    declaredCount: manifest.transport.age_recipients.length,
    observation: observed.vaultRecipients,
  };

  return {
    fleet: fleetName,
    lockPresent: observed.lock !== null,
    controlRepo,
    runnerOps,
    ca,
    agents,
    extraLockAgents,
    routing,
    vaultRecipients,
  };
}

// --- Formatting (human table + --json) ---

const RUNTIME_UNOBSERVABLE_NOTE =
  'unknown — not observable from this plane (run `macf fleet status` from a deployed agent workspace for live health)';

const PROVISIONING_HEADERS = [
  'ROLE',
  'APP',
  'INSTALL',
  'REPO',
  'CA(repo)',
  'ROUTING-CLIENT',
  'SECRETS',
  'VERSION',
  'ACTIONS-PIN',
  'VAULT',
] as const;

function presenceCell(p: Presence, id: string | undefined): string {
  if (p === 'present' && id !== undefined) return `present (${id})`;
  return p;
}

function formatVaultAgentCell(vault: VaultAgentObservation | undefined): string {
  if (vault === undefined) return 'not read this run';
  if (vault.status === 'unknown') return `unknown (${vault.reason})`;
  const { present, total } = countVaultAgentPresence(vault.presence);
  return `${String(present)}/${String(total)} fields`;
}

function formatVaultCaCell(vault: VaultCaObservation | undefined): string {
  if (vault === undefined) return 'not read this run';
  if (vault.status === 'unknown') return `unknown (${vault.reason})`;
  const { present, total } = countVaultCaPresence(vault.presence);
  return `${String(present)}/${String(total)} fields`;
}

/** Build one PROVISIONING row per agent (pure — exported for tests). */
export function buildProvisioningRows(agents: readonly AgentStatusView[]): readonly (readonly string[])[] {
  return agents.map((a) => [
    a.role,
    presenceCell(a.app, a.appId),
    presenceCell(a.install, a.installId),
    a.repoPresence,
    a.caRepo,
    a.routingClientRepo,
    a.fingerprintCount > 0 ? `${String(a.fingerprintCount)} fingerprint(s)` : 'none recorded',
    a.deployedVersion ?? 'unknown',
    a.actionsPin ?? 'unknown',
    formatVaultAgentCell(a.vault),
  ]);
}

const RUNTIME_HEADERS = ['ROLE', 'REGISTRY', 'HOST:PORT', 'INSTANCE-ID', 'TYPE', 'STARTED', 'LAST-HEARTBEAT', 'LIVENESS'] as const;

/** Build one RUNTIME row per agent (pure — exported for tests). */
export function buildRuntimeRows(agents: readonly AgentStatusView[]): readonly (readonly string[])[] {
  return agents.map((a) => {
    const r = a.registry;
    if (r.status === 'unknown') {
      return [a.role, `unknown (${r.reason})`, '—', '—', '—', '—', '—', RUNTIME_UNOBSERVABLE_NOTE];
    }
    if (r.presence === 'absent') {
      return [a.role, 'absent (never registered, or deregistered)', '—', '—', '—', '—', '—', RUNTIME_UNOBSERVABLE_NOTE];
    }
    const { info } = r;
    return [
      a.role,
      'present',
      `${info.host}:${String(info.port)}`,
      info.instance_id,
      info.type,
      info.started,
      info.last_heartbeat ?? '—',
      RUNTIME_UNOBSERVABLE_NOTE,
    ];
  });
}

function formatVaultRecipientsLine(view: VaultRecipientsView): string {
  const base = `vault recipients: declared=${String(view.declaredCount)}`;
  const obs = view.observation;
  if (obs === undefined) return `${base}, observed=not read this run`;
  if (obs.status === 'no-vault') return `${base}, observed=no vault provisioned yet`;
  if (obs.status === 'unknown') return `${base}, observed=unknown (${obs.reason})`;
  const match = obs.stanzaCount === view.declaredCount ? 'matches declared count' : 'DIVERGES from declared count';
  return `${base}, observed stanza count=${String(obs.stanzaCount)} (${match})`;
}

function formatControlRepoLine(view: ControlRepoView): string {
  const archived = view.presence === 'present' ? ` archived=${view.archived === undefined ? 'unknown' : String(view.archived)}` : '';
  return `control repo: ${view.repo} — ${view.presence}${archived}`;
}

function formatRunnerOpsLine(view: RunnerOpsView): string {
  const id = view.appId !== undefined ? ` (app_id=${view.appId})` : '';
  return `runner-ops App: ${view.appHandle} — ${view.presence}${id}`;
}

function formatRoutingBlock(view: RoutingView): readonly string[] {
  const lines = [`ROUTING (declared runs_on=${view.runsOn}, warm=${String(view.warm)})`];
  lines.push(`  trusted actors: ${view.trustedActors ?? 'unknown'}`);
  lines.push(`  runner registered + usable: ${view.runnerRegistered ?? 'unknown'}`);
  if (view.runnerDetail !== undefined) lines.push(`  detail: ${view.runnerDetail}`);
  if (view.runnerHandover !== undefined) lines.push(`  handover: ${view.runnerHandover}`);
  return lines;
}

/** Full human-readable render (pure — exported for tests). */
export function formatBootstrapStatusText(view: FleetStatusView): string {
  const parts: string[] = [
    `macf bootstrap status — ${view.fleet}`,
    '',
    `fleet.lock: ${view.lockPresent ? 'present' : 'absent (fleet never applied from this checkout, or lock not local)'}`,
    formatControlRepoLine(view.controlRepo),
    formatRunnerOpsLine(view.runnerOps),
    '',
    'PROVISIONING',
    formatTable(PROVISIONING_HEADERS, buildProvisioningRows(view.agents)),
    '',
    `CA registry var "${view.ca.varName}": ${view.ca.registryPresence}  [vault CA: ${formatVaultCaCell(view.ca.vault)}]`,
    formatVaultRecipientsLine(view.vaultRecipients),
  ];

  if (view.routing !== undefined) {
    parts.push('', ...formatRoutingBlock(view.routing));
  }

  parts.push(
    '',
    'RUNTIME (registry-observed registration identity only — see header note; this plane cannot confirm liveness)',
    formatTable(RUNTIME_HEADERS, buildRuntimeRows(view.agents)),
  );

  if (view.extraLockAgents.length > 0) {
    parts.push('', 'EXTRA (recorded in fleet.lock, not declared in fleet.yaml — never pruned, §D3):');
    for (const e of view.extraLockAgents) {
      parts.push(`  - role=${e.role} app_id=${e.appId} install_id=${e.installId} deployed_version=${e.deployedVersion ?? 'unknown'}`);
    }
  }

  return parts.join('\n');
}

export const BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION = 1;

/** Structured `--json` shape — carries the SAME facts the text render shows, never a summary of them. */
export function bootstrapStatusToJson(view: FleetStatusView): unknown {
  return {
    schema_version: BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION,
    fleet: view.fleet,
    lock_present: view.lockPresent,
    control_repo: { ...view.controlRepo },
    runner_ops: { ...view.runnerOps },
    ca: { ...view.ca },
    agents: view.agents.map((a) => ({ ...a })),
    extra_lock_agents: view.extraLockAgents.map((e) => ({ ...e })),
    ...(view.routing !== undefined ? { routing: { ...view.routing } } : {}),
    vault_recipients: { ...view.vaultRecipients },
  };
}
