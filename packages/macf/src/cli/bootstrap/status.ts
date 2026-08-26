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
 *
 * **groundnuty/macf#1030 — loud is not voluminous (DR-044 Decision 6).**
 * The #1026 fix above made `unknown` cells honest by inlining a diagnostic
 * `reason` — correct in substance, but a `reason` shared by REPO/CA(repo)/
 * ROUTING-CLIENT was repeated in full in all three cells, producing
 * ~1400-char PROVISIONING columns that pushed every OTHER agent's row off a
 * readable width. A status view nobody can read is not better than one that
 * lies. The fix keeps the reason text verbatim but says it ONCE — a short
 * `[N]` marker in the cell, the full text as a numbered footnote printed
 * once below the table (`FootnoteRegistry`, dedup'd by string equality
 * across cells AND across agents) — the same "detail on its own line, not
 * inlined per occurrence" treatment `formatRoutingBlock`'s `runnerDetail`
 * line already models. `--json` is untouched: it reads the raw
 * `AgentStatusView`/`AgentRegistryObservation` fields directly, never the
 * footnote-bearing table-cell strings, so structured consumers still get
 * the reason per-field.
 *
 * **groundnuty/macf#1202 — a lock-derived value must not render as an
 * observation.** `AgentStatusView.deployedVersion` (`versions.macf`) is
 * sourced from `fleet.lock` ONLY — see `ObservedAgentState.deployedVersion`'s
 * doc — this plane structurally has no mTLS route to a LIVE `/health.version`
 * read (Amendment A's honest-unknown floor forbids adding one just to make
 * this column "true"; the fix is disclosure, not new privilege). A bare
 * `"0.2.60"` cell is indistinguishable from `actionsPin` (`versions.actions`),
 * which genuinely IS re-read live every run (`observer.ts::readCallerActionsPin`)
 * — exactly the disclosure gap #1202 flags. Every lock-derived render
 * therefore carries an explicit `(from lock)` qualifier (`lockVersionCell`);
 * the live sibling (`liveVersionCell`) renders unlabeled, so the two
 * columns' provenance is visually distinguishable, not merely documented.
 * `--json` carries the SAME distinction structurally, not just in prose —
 * `deployedVersionSource`/`actionsPinSource` name the provenance per field.
 *
 * This also covers an offline agent's stale entry (#1202 requirement 3):
 * `(from lock)` is the honest caveat that the value may have aged, since
 * this plane cannot refresh it — `macf fleet upgrade` skips an offline
 * agent's roll entirely (`@groundnuty/macf-core`'s
 * `fleet-upgrade.ts::planFleetUpgrade`, the `'offline'` disposition), so a
 * long-offline agent's `deployed_version` can silently age indefinitely
 * with nothing here to detect that. `(from lock)` never claims freshness —
 * it names the source, and the source's own staleness is the reader's to
 * judge, honestly, rather than this plane fabricating a claim it cannot
 * verify. Applies uniformly to `extraLockAgents` too (§D3's "reported,
 * never pruned" agents are, if anything, MORE likely to be stale than a
 * still-declared one).
 *
 * **Convergence ruling (#1202 requirement 4), stated once for both
 * `versions.*` fields:** manifest-authoritative. DR-043 Amendment L makes
 * `versions:` authoritative and `apply` converges the fleet TOWARD it —
 * "toward" is not one-directional, so a host recorded NEWER than declared
 * is DRIFT here, the same as older, never silently "at target". This
 * matches how `plan.ts`'s `macfVersionItem`/`actionsVersionItem` ALREADY
 * treat any difference (either direction) as `update`+`confirm_required` —
 * both `versions.*` fields are already consistent with this ruling at the
 * PLANNING layer, and this module's `lockVersionCell`/`liveVersionCell`
 * apply the identical rule for STATUS's own DRIFT note. The one place this
 * ruling does NOT reach is `@groundnuty/macf-core`'s LIVE roll classifier
 * (`fleet-upgrade.ts::planFleetUpgrade`, `compareSemver(running, target) >= 0
 * ⇒ 'at-target'`) — a deliberate, SEPARATE operational safety choice for
 * `macf fleet upgrade` itself (never restart/downgrade an agent already
 * ahead of the declared target). That live-roll asymmetry is intentionally
 * left UNCHANGED here: #1202 explicitly permits a reporting-only fix when
 * changing convergence itself is out of scope, and this module's own
 * "never calls computePlan" contract (above) makes touching a live
 * production roll's disposition logic doubly out of place here.
 */
import { toVariableSegment } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest, FleetVersions } from './fleet-manifest.js';
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
  /**
   * WHY `repoPresence`/`caRepo`/`routingClientRepo` read `'unknown'` instead
   * of a committed value — set only when that downgrade happened
   * (groundnuty/macf#1026: a 404 on a per-agent repo-scoped resource is
   * ambiguous between "doesn't exist" and "this token can't see it," so a
   * confident `'absent'` requires independently proving the caller can see
   * the repo first — see `observer.ts::resolveAgentRepoState`). `undefined`
   * when `repoPresence === 'present'` (nothing to explain).
   */
  readonly repoVisibilityReason?: string;
  readonly fingerprintCount: number;
  /** `versions.macf`, sourced from `fleet.lock` ONLY — see this module's doc "groundnuty/macf#1202" paragraph. `undefined` iff never recorded. */
  readonly deployedVersion?: string;
  /**
   * `'lock'` whenever {@link deployedVersion} is defined — the ONLY
   * provenance this plane can ever produce for it (no mTLS route to a live
   * `/health.version` read, Amendment A). `undefined` iff `deployedVersion`
   * is `undefined` (nothing to qualify) — never a free-standing claim.
   */
  readonly deployedVersionSource?: 'lock';
  /** `versions.actions` — genuinely LIVE every run (`observer.ts::readCallerActionsPin`), unlike {@link deployedVersion}. */
  readonly actionsPin?: string;
  /** `'live'` whenever {@link actionsPin} is defined — see {@link deployedVersionSource}'s doc for the contrast this exists to make explicit. */
  readonly actionsPinSource?: 'live';
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
  /** Same "always 'lock', only when {@link deployedVersion} is defined" contract as {@link AgentStatusView.deployedVersionSource} — an extra-lock agent's version is, if anything, MORE likely to be stale (§D3, never touched by a roll once dropped from the manifest). */
  readonly deployedVersionSource?: 'lock';
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
  /**
   * The manifest's declared `versions:` block, verbatim — the comparison
   * target for {@link lockVersionCell}/{@link liveVersionCell}'s DRIFT note
   * (groundnuty/macf#1202). `undefined` when the manifest doesn't declare
   * `versions:` at all (nothing to compare against — the honest-unknown
   * floor applies to the comparison itself, not only to the observed side).
   */
  readonly declaredVersions?: FleetVersions;
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
    repoVisibilityReason: obs?.repoVisibilityReason,
    fingerprintCount: Object.keys(obs?.fingerprints ?? {}).length,
    // groundnuty/macf#1202 — the source qualifier is a PURE function of
    // whether the value exists, never a separate observation: this plane
    // can only ever populate `deployedVersion` from `fleet.lock`, and can
    // only ever populate `actionsPin` from a live `gh api` read (see this
    // module's doc). No branch here can produce the opposite pairing.
    deployedVersion: obs?.deployedVersion,
    deployedVersionSource: obs?.deployedVersion !== undefined ? 'lock' : undefined,
    actionsPin: obs?.actionsPin,
    actionsPinSource: obs?.actionsPin !== undefined ? 'live' : undefined,
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
    .map((a) => ({
      role: a.role,
      appId: a.app_id,
      installId: a.install_id,
      deployedVersion: a.deployed_version,
      // groundnuty/macf#1202 — same "lock is the only possible source"
      // reasoning as `buildAgentView`'s `deployedVersionSource` above.
      deployedVersionSource: a.deployed_version !== undefined ? 'lock' : undefined,
    }));

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
    declaredVersions: manifest.versions,
  };
}

// --- Formatting (human table + --json) ---

const RUNTIME_UNOBSERVABLE_NOTE =
  'unknown — not observable from this plane (run `macf fleet status` from a deployed agent workspace for live health)';

/**
 * groundnuty/macf#1202's closure condition, verbatim: "an operator reading
 * `status` can tell whether a version was observed or recalled." The
 * `(from lock)` qualifier on individual VERSION cells satisfies that at the
 * per-cell level, but a reader still has to notice a qualifier's PRESENCE
 * on one column and ABSENCE on its neighbor and already know what that
 * means. Naming both columns' provenance ONCE, next to the table itself
 * (same placement `RUNTIME_UNOBSERVABLE_NOTE` already uses for the RUNTIME
 * table's own liveness caveat), makes the distinction legible without
 * requiring that inference.
 */
const PROVISIONING_VERSION_PROVENANCE_NOTE =
  "VERSION is fleet.lock's last-recorded value, never a live read this run; ACTIONS-PIN is read live from the repo every run";

/** Exported for tests — column-width assertions (groundnuty/macf#1030) need the same header list `formatTable` renders against. */
export const PROVISIONING_HEADERS = [
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

/**
 * Collects distinct "why is this unknown" reason strings into numbered
 * footnotes so a table cell can carry a short marker (`unknown[1]`) instead
 * of repeating the FULL explanation inline in every cell it applies to —
 * groundnuty/macf#1030: the identical repo-visibility reason, printed
 * verbatim in the REPO/CA(repo)/ROUTING-CLIENT cells of one row, produced
 * ~1400-char columns and pushed every other agent's row off past a readable
 * width. Dedup is by string EQUALITY, not by call site or row — two cells
 * (same row, a different row, even a different agent) that cite the
 * identical reason text share ONE footnote, per the operator's requirement
 * that a shared cause gets one explanation, not one per cell it touches.
 * Same "say once, not per cell" treatment as {@link formatRoutingBlock}'s
 * `runnerDetail` line already gives its one long field — the model this
 * class generalizes to every reason that can recur across cells.
 */
class FootnoteRegistry {
  private readonly order: string[] = [];
  private readonly indexOf = new Map<string, number>();

  /** `undefined` (nothing to explain) → `''`, no marker. Otherwise registers (or reuses) the reason and returns `[N]`. */
  ref(reason: string | undefined): string {
    if (reason === undefined) return '';
    const existing = this.indexOf.get(reason);
    if (existing !== undefined) return `[${String(existing)}]`;
    const index = this.order.length + 1;
    this.indexOf.set(reason, index);
    this.order.push(reason);
    return `[${String(index)}]`;
  }

  /** `true` when no cell in this render section ever cited a reason — caller skips the footnote block entirely. */
  isEmpty(): boolean {
    return this.order.length === 0;
  }

  /** Ordered `{ index, reason }` pairs, 1-based, in first-cited order — the footnote list to print below the table. */
  entries(): readonly { readonly index: number; readonly reason: string }[] {
    return this.order.map((reason, i) => ({ index: i + 1, reason }));
  }
}

/**
 * REPO / CA(repo) / ROUTING-CLIENT cell renderer — the same "say why"
 * treatment {@link formatVaultAgentCell}/{@link formatVaultCaCell} already
 * give an `unknown` vault read, applied to the groundnuty/macf#1026
 * repo-visibility downgrade: a bare `unknown` cell can't distinguish "never
 * observed" from "this token cannot see the repo," and the latter is
 * actionable (check the App's install scope) in a way the former isn't.
 * The reason itself is a `footnotes` marker (groundnuty/macf#1030), not the
 * inlined text — see {@link FootnoteRegistry}.
 */
function repoScopedCell(p: Presence, reason: string | undefined, footnotes: FootnoteRegistry): string {
  if (p === 'unknown' && reason !== undefined) return `unknown${footnotes.ref(reason)}`;
  return p;
}

function formatVaultAgentCell(vault: VaultAgentObservation | undefined, footnotes: FootnoteRegistry): string {
  if (vault === undefined) return 'not read this run';
  if (vault.status === 'unknown') return `unknown${footnotes.ref(vault.reason)}`;
  const { present, total } = countVaultAgentPresence(vault.presence);
  return `${String(present)}/${String(total)} fields`;
}

function formatVaultCaCell(vault: VaultCaObservation | undefined): string {
  if (vault === undefined) return 'not read this run';
  if (vault.status === 'unknown') return `unknown (${vault.reason})`;
  const { present, total } = countVaultCaPresence(vault.presence);
  return `${String(present)}/${String(total)} fields`;
}

/**
 * VERSION cell renderer — groundnuty/macf#1202. `value` is `deployedVersion`,
 * lock-derived ONLY (see this module's doc "groundnuty/macf#1202" paragraph
 * for the full disclosure + drift rationale). Always carries the explicit
 * `(from lock)` qualifier when a value exists, so it never renders
 * indistinguishably from a genuine observation — the exact disclosure gap
 * this issue closes. `declared` is the manifest's `versions.macf`, when
 * known; any difference (either direction — a host newer than declared is
 * DRIFT here, not "at target") is called out, never silently accepted.
 */
function lockVersionCell(value: string | undefined, declared: string | undefined): string {
  if (value === undefined) return 'unknown';
  const base = `${value} (from lock)`;
  if (declared === undefined || declared === value) return base;
  return `${base}, declared ${declared} — DRIFT`;
}

/**
 * ACTIONS-PIN cell renderer — the live-observed sibling of
 * {@link lockVersionCell}. `value` is `actionsPin`, genuinely re-read every
 * run (`observer.ts::readCallerActionsPin`), so it renders UNLABELED —
 * that contrast with {@link lockVersionCell}'s qualifier is what proves the
 * two columns' provenance is actually distinguished, not blanket-suppressed.
 * Same DRIFT rule as {@link lockVersionCell} — see this module's doc.
 */
function liveVersionCell(value: string | undefined, declared: string | undefined): string {
  if (value === undefined) return 'unknown';
  if (declared === undefined || declared === value) return value;
  return `${value}, declared ${declared} — DRIFT`;
}

/**
 * Build one PROVISIONING row per agent (pure — exported for tests).
 * `footnotes` defaults to a fresh, throwaway registry so ad-hoc callers
 * (tests checking presence/shape, not footnote text) don't need to thread
 * one through; `formatBootstrapStatusText` passes its own so it can print
 * the accumulated footnote list right after the table (groundnuty/macf#1030).
 * `declaredVersions` defaults to `undefined` (no comparison target) for the
 * same ad-hoc-caller convenience — see groundnuty/macf#1202.
 */
export function buildProvisioningRows(
  agents: readonly AgentStatusView[],
  footnotes: FootnoteRegistry = new FootnoteRegistry(),
  declaredVersions?: FleetVersions,
): readonly (readonly string[])[] {
  return agents.map((a) => [
    a.role,
    presenceCell(a.app, a.appId),
    presenceCell(a.install, a.installId),
    repoScopedCell(a.repoPresence, a.repoVisibilityReason, footnotes),
    repoScopedCell(a.caRepo, a.repoVisibilityReason, footnotes),
    repoScopedCell(a.routingClientRepo, a.repoVisibilityReason, footnotes),
    a.fingerprintCount > 0 ? `${String(a.fingerprintCount)} fingerprint(s)` : 'none recorded',
    lockVersionCell(a.deployedVersion, declaredVersions?.macf),
    liveVersionCell(a.actionsPin, declaredVersions?.actions),
    formatVaultAgentCell(a.vault, footnotes),
  ]);
}

/** Exported for tests — see {@link PROVISIONING_HEADERS}'s doc. */
export const RUNTIME_HEADERS = ['ROLE', 'REGISTRY', 'HOST:PORT', 'INSTANCE-ID', 'TYPE', 'STARTED', 'LAST-HEARTBEAT', 'LIVENESS'] as const;

/** Build one RUNTIME row per agent (pure — exported for tests). Same `footnotes` default-param convention as {@link buildProvisioningRows}. */
export function buildRuntimeRows(
  agents: readonly AgentStatusView[],
  footnotes: FootnoteRegistry = new FootnoteRegistry(),
): readonly (readonly string[])[] {
  return agents.map((a) => {
    const r = a.registry;
    if (r.status === 'unknown') {
      return [a.role, `unknown${footnotes.ref(r.reason)}`, '—', '—', '—', '—', '—', RUNTIME_UNOBSERVABLE_NOTE];
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

/**
 * Render a footnote registry as trailing lines — `[]` when empty (no
 * footnote section at all, matching {@link formatBootstrapStatusText}'s
 * pre-#1030 output byte-for-byte on an all-known fleet), otherwise a
 * leading blank line plus one `[N] <reason>` line per distinct cause, in
 * first-cited order.
 */
function formatFootnotes(footnotes: FootnoteRegistry): readonly string[] {
  if (footnotes.isEmpty()) return [];
  return ['', ...footnotes.entries().map((e) => `[${String(e.index)}] ${e.reason}`)];
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

/**
 * Full human-readable render (pure — exported for tests).
 *
 * PROVISIONING and RUNTIME each get their OWN {@link FootnoteRegistry}
 * (groundnuty/macf#1030) — the two tables' `unknown` reasons come from
 * unrelated causes (repo visibility / vault reads vs. registry reads), so
 * numbering them independently and printing each table's footnotes
 * immediately below it keeps a footnote physically near the cells it
 * explains, the same placement `formatRoutingBlock`'s `runnerDetail` line
 * already uses for its one long field.
 */
export function formatBootstrapStatusText(view: FleetStatusView): string {
  const provisioningFootnotes = new FootnoteRegistry();
  const provisioningRows = buildProvisioningRows(view.agents, provisioningFootnotes, view.declaredVersions);
  const runtimeFootnotes = new FootnoteRegistry();
  const runtimeRows = buildRuntimeRows(view.agents, runtimeFootnotes);

  const parts: string[] = [
    `macf bootstrap status — ${view.fleet}`,
    '',
    `fleet.lock: ${view.lockPresent ? 'present' : 'absent (fleet never applied from this checkout, or lock not local)'}`,
    formatControlRepoLine(view.controlRepo),
    formatRunnerOpsLine(view.runnerOps),
    '',
    `PROVISIONING (${PROVISIONING_VERSION_PROVENANCE_NOTE})`,
    formatTable(PROVISIONING_HEADERS, provisioningRows),
    ...formatFootnotes(provisioningFootnotes),
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
    formatTable(RUNTIME_HEADERS, runtimeRows),
    ...formatFootnotes(runtimeFootnotes),
  );

  if (view.extraLockAgents.length > 0) {
    parts.push('', 'EXTRA (recorded in fleet.lock, not declared in fleet.yaml — never pruned, §D3):');
    for (const e of view.extraLockAgents) {
      // groundnuty/macf#1202 — same `(from lock)` disclosure as the
      // PROVISIONING table's VERSION column (`lockVersionCell`); an extra
      // agent is no longer touched by ANY roll, so its recorded version is
      // at least as likely to be stale as a still-declared agent's.
      const version = e.deployedVersion !== undefined ? `${e.deployedVersion} (from lock)` : 'unknown';
      parts.push(`  - role=${e.role} app_id=${e.appId} install_id=${e.installId} deployed_version=${version}`);
    }
  }

  return parts.join('\n');
}

// groundnuty/macf#1202 — bumped 1 → 2. `agents[].deployedVersion` is a
// SAME-NAME field gaining a source qualifier: pre-#1202, a consumer reading
// a bare `deployedVersion` string had no structural way to tell it apart
// from a genuine observation (`actionsPin` carried no such distinction
// either). Post-#1202, `deployedVersionSource`/`actionsPinSource` +
// `declared_versions` change what the SAME fields mean to a consumer that
// was already parsing them — the same "a new fact feeding an existing
// value is breaking" precedent this codebase already applies (see
// `routing-doctor.ts`'s schema_version 3→4 / 4→5 history).
export const BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION = 2;

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
    // groundnuty/macf#1202 — the comparison target `agents[].deployedVersion`/
    // `agents[].actionsPin` are judged against for their DRIFT note (text
    // render: `lockVersionCell`/`liveVersionCell`); `undefined` when the
    // manifest doesn't declare `versions:` (nothing to compare against).
    ...(view.declaredVersions !== undefined ? { declared_versions: { ...view.declaredVersions } } : {}),
  };
}
