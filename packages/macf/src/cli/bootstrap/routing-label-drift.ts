/**
 * Manifest-role vs config-`routing_label` drift detection (groundnuty/macf#1059).
 *
 * `routing_label` is load-bearing far past the workspace that carries it — it
 * keys the registry variable, the mTLS cert CN, and the tmux session name
 * (`coordination.md` §"Canonical tmux launch pattern"). `apply-repo-init.ts`
 * mints a repo's routing label (and its GitHub issue-assignment label) from
 * the FLEET MANIFEST's `agents[].role` at provisioning time — see that
 * module's own doc for why `role` IS the routing label at THAT layer. But
 * `role` and a workspace's live `routing_label` can only be compared AT
 * provisioning time; nothing re-asserts they still agree afterward. If an
 * operator (or a future tool) later edits a deployed workspace's
 * `.macf/macf-agent.json` `routing_label` (or `agent_name`) without touching
 * the manifest — or the reverse, a manifest role rename with no redeploy —
 * the repo's assignment label still names the OLD role while the router
 * resolves the registry key from whatever the workspace registers under NOW.
 * The label exists, the workflow exists, the issue gets labelled successfully,
 * and nothing routes. No error anywhere — the exact `#791` shape, reached
 * from provisioning-vs-deployment drift instead of the DR-031 watchdog.
 *
 * **The join key is `agent_role`, not the label under test.** A workspace's
 * `.macf/macf-agent.json` carries BOTH `agent_role` (frozen, once, from
 * `macf init --role <role>` — see `commands/init.ts`, `agent_role: opts.role`)
 * and the routing identity actually in force
 * (`routing_label ?? agent_name` — the SAME precedence `discovery.ts`,
 * `certs.ts`, `restart-self.ts`, and `vm-driver.ts` all use). Matching a
 * manifest role to "the workspace that was deployed as that role" via the
 * effective label would be circular — that label is exactly the value under
 * test. `agent_role` is written once at init/deploy time and nothing routes
 * on it, so it is the one stable, independent join key available in the
 * current schema.
 *
 * **Consequence — a manifest role rename with no redeploy is NOT detectable
 * here.** Without a join key independent of BOTH `role` and the routing
 * label (e.g. a per-agent `repo` field recorded in `macf-agent.json`, which
 * does not exist today), a renamed-but-undeployed role has no local
 * workspace whose `agent_role` matches it — it reports `unknown`, honestly,
 * rather than a false `clean`. Extending the join key is future work; see
 * this module's own limitation note below.
 *
 * **Honest-unknown floor (`#1078`/`#1096`, extended here).** A manifest role
 * with no matching local workspace, an unreadable `macf-agent.json`, or an
 * AMBIGUOUS match (two+ discovered workspaces sharing one `agent_role` for
 * the same project) all resolve to `'unknown'` — never silently folded into
 * `'clean'`.
 *
 * **Warn vs fail — decided FAIL, uniformly, and here is why there is no
 * cosmetic sub-case in this design.** Every `'drift'` entry is a workspace
 * whose OWN `agent_role` (its declared identity) no longer matches its OWN
 * effective routing label — and that label is exactly what the registry
 * key / cert CN / tmux session are derived from TODAY, on THIS running
 * workspace. There is no "the manifest moved but nothing is broken yet"
 * middle state reachable through the `agent_role` join: that state would
 * require detecting a manifest role change *independently of* the identity
 * a workspace already claims, which — per the limitation above — this
 * design cannot do (it would show as `unknown`, not a distinct warn tier).
 * So within what IS detectable here, `'drift'` always means "this workspace
 * is answering to a different name than the one its repo's routing config
 * was minted for" — routing-breaking by construction. A future join-key
 * extension that CAN see a not-yet-redeployed manifest edit would be the
 * place to introduce a genuine cosmetic/warn tier; it does not exist yet.
 */
import type { FleetManifest } from './fleet-manifest.js';
import { parseFleetManifest } from './fleet-manifest.js';
import type { MacfAgentConfig } from '../config.js';
import type { WorkspaceRecord } from '@groundnuty/macf-core';

/**
 * The result of trying to find + read the local workspace that was deployed
 * for a given manifest role, keyed on `agent_role` (see module doc for why).
 */
export type RoutingLabelConfigLookup =
  | { readonly kind: 'found'; readonly config: MacfAgentConfig; readonly source: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type RoutingLabelDriftStatus = 'clean' | 'drift' | 'unknown';

/** One manifest agent's drift verdict. Always names BOTH values + BOTH artifacts they came from. */
export interface RoutingLabelDriftEntry {
  /** `manifest.agents[].role` — the identity declared in the manifest. */
  readonly role: string;
  /** Where `role` was declared (the manifest path/URL passed to the check). */
  readonly manifestSource: string;
  readonly status: RoutingLabelDriftStatus;
  /** The workspace's effective `routing_label ?? agent_name`, or `null` when `status === 'unknown'`. */
  readonly recordedLabel: string | null;
  /** The workspace path the config was read from, or `null` when `status === 'unknown'`. */
  readonly configSource: string | null;
  /** Human-readable detail — always present for `'drift'` / `'unknown'`, omitted for `'clean'`. */
  readonly reason?: string;
}

/**
 * Pure core: for every agent the manifest declares, resolve its local config
 * via the injected `lookupConfig` (production wiring: {@link buildAgentRoleLookup};
 * tests: a synthetic `Map`-backed callback) and compare the effective routing
 * label to the declared role. Reports one entry PER AGENT — never collapses
 * a multi-agent fleet into one verdict (a fleet where agent 2 of 3 drifted
 * must not read as a single opaque "fleet has a problem" — see this file's
 * own tests + `assert-the-wrong-path.md`).
 */
export function detectRoutingLabelDrift(
  manifest: FleetManifest,
  manifestSource: string,
  lookupConfig: (role: string) => RoutingLabelConfigLookup,
): readonly RoutingLabelDriftEntry[] {
  return manifest.agents.map((agent): RoutingLabelDriftEntry => {
    const lookup = lookupConfig(agent.role);
    if (lookup.kind === 'unknown') {
      return {
        role: agent.role,
        manifestSource,
        status: 'unknown',
        recordedLabel: null,
        configSource: null,
        reason: lookup.reason,
      };
    }
    const recordedLabel = lookup.config.routing_label ?? lookup.config.agent_name;
    if (recordedLabel === agent.role) {
      return {
        role: agent.role,
        manifestSource,
        status: 'clean',
        recordedLabel,
        configSource: lookup.source,
      };
    }
    return {
      role: agent.role,
      manifestSource,
      status: 'drift',
      recordedLabel,
      configSource: lookup.source,
      reason:
        `role "${agent.role}" declared in ${manifestSource} vs routing label "${recordedLabel}" ` +
        `recorded in ${lookup.source}`,
    };
  });
}

/** `true` when ANY entry is `'drift'` — the routing-breaking verdict (see module doc's warn-vs-fail reasoning). */
export function hasRoutingLabelDrift(entries: readonly RoutingLabelDriftEntry[]): boolean {
  return entries.some((e) => e.status === 'drift');
}

/**
 * Build the production `lookupConfig` callback from a host-wide workspace
 * scan (`discoverWorkspaces()`, macf#710/#037) + a raw config reader
 * (`readAgentConfig`). Reads every discovered workspace's config ONCE up
 * front (not once per manifest role) and groups by `agent_role`. A missing
 * or unreadable config for a discovered workspace path — `readConfig`
 * returning `null` — drops that workspace from consideration entirely; the
 * manifest role it might have matched then resolves to `'unknown'` via the
 * "no match" path below, never a silent `'clean'` (the honest-unknown floor
 * this module's doc names).
 */
export function buildAgentRoleLookup(
  project: string,
  workspaces: readonly WorkspaceRecord[],
  readConfig: (workspaceDir: string) => MacfAgentConfig | null,
): (role: string) => RoutingLabelConfigLookup {
  const byAgentRole = new Map<string, { readonly workspace: string; readonly config: MacfAgentConfig }[]>();
  for (const ws of workspaces) {
    if (ws.project !== project) continue;
    const config = readConfig(ws.workspace);
    if (!config) continue;
    const existing = byAgentRole.get(config.agent_role) ?? [];
    existing.push({ workspace: ws.workspace, config });
    byAgentRole.set(config.agent_role, existing);
  }

  return (role: string): RoutingLabelConfigLookup => {
    const matches = byAgentRole.get(role) ?? [];
    if (matches.length === 0) {
      return {
        kind: 'unknown',
        reason: `no locally discovered, readable workspace for project "${project}" has agent_role "${role}"`,
      };
    }
    if (matches.length > 1) {
      const paths = matches.map((m) => m.workspace).join(', ');
      return {
        kind: 'unknown',
        reason:
          `${String(matches.length)} locally discovered workspaces for project "${project}" share ` +
          `agent_role "${role}" (${paths}) — ambiguous, refusing to guess`,
      };
    }
    const only = matches[0];
    if (only === undefined) {
      // Unreachable: matches.length === 1 guarantees index 0 exists. Guarded
      // for noUncheckedIndexedAccess, not because this path is expected to run.
      return { kind: 'unknown', reason: `internal inconsistency resolving agent_role "${role}"` };
    }
    return { kind: 'found', config: only.config, source: only.workspace };
  };
}

/** Injectable seam for {@link detectRoutingLabelDriftFromManifestFile} — real fs / discovery in production, fakes in tests. */
export interface RoutingLabelDriftDeps {
  readonly readManifestText: (path: string) => string;
  readonly discover: () => readonly WorkspaceRecord[];
  readonly readConfig: (workspaceDir: string) => MacfAgentConfig | null;
}

/**
 * Production entry point: load the manifest from `manifestPath`, resolve
 * every declared agent's local config via a host-wide workspace discovery
 * scan, and report drift. Throws on a malformed manifest (mirrors
 * `parseFleetManifest`'s own contract — the CLI-boundary caller catches +
 * renders it, same as every other `fleet.yaml`-consuming command).
 */
export function detectRoutingLabelDriftFromManifestFile(
  manifestPath: string,
  deps: RoutingLabelDriftDeps,
): readonly RoutingLabelDriftEntry[] {
  const manifest = parseFleetManifest(deps.readManifestText(manifestPath));
  const lookup = buildAgentRoleLookup(manifest.metadata.name, deps.discover(), deps.readConfig);
  return detectRoutingLabelDrift(manifest, manifestPath, lookup);
}
