/**
 * Cross-fleet GUEST visibility — DR-036 Amendment A (groundnuty/macf#679).
 *
 * Shared by `macf fleet status` (this package's `fleet.ts`) AND `/macf-peers`
 * (the `macf-plugin-cli peers` case). Renders a distinct GUEST / external-
 * collaborators block, SEPARATE from the fleet's own members: each guest is an
 * external agent the consumer DEPENDS on but does NOT supervise (DR-031 liveness
 * / reconciliation / restart / prune NEVER apply — the load-bearing invariant).
 *
 * Guests are resolved from the SHARED registry scope (DR-006 profile scope; the
 * cross-scope union per macf#621) by keying a registry on the guest's HOME
 * project, then reading its slot. Reachability is PATH-AWARE (science #675):
 *   - `route`          guest → attempt a live mTLS `/health` probe. If the guest's
 *                      home project is declared in `federated_cas`
 *                      (`.github/macf-fleet.json`, DR-041), the probe uses a
 *                      federation-aware trust bundle (own CA + the guest's fleet
 *                      CA, DR-041 Amendment B / macf#794) so a federated guest
 *                      shows online + its live self-report even under a
 *                      different per-fleet CA. Non-federated guests fall back to
 *                      the pre-#794 behavior (B1): we reuse the consumer's own
 *                      mTLS material as-is — a "shared-operator" (same-CA) guest
 *                      still verifies; a genuinely-foreign-CA guest still reads
 *                      offline (still visible via the registry).
 *   - `operator-relay` guest (local-mode / path c) → NEVER probed. A cross-fleet
 *                      probe is not meaningful (it would hit the consumer's own
 *                      localhost or fail), so it renders registry-derived state +
 *                      "local-mode — home-fleet-observable only" and NEVER "down"
 *                      (mirrors macf#621's registry-only treatment). A false DOWN
 *                      is exactly the misleading "is it down? restart it?" signal
 *                      this amendment exists to prevent.
 *
 * This module deliberately touches NEITHER `fleet doctor` NOR any supervision /
 * reconcile path: guests are never added to the supervised-member list, so the
 * "MUST NOT propose restart/prune/reconcile against a guest" invariant holds by
 * construction (fleet doctor iterates the project registry only). The `--json`
 * shape carries `supervised: false` on every guest to make that explicit.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MacfFleetConfigSchema,
  parseGuestAgentRef,
  isStaleEntry,
  DEFAULT_REGISTRY_TTL_MS,
} from '@groundnuty/macf-core';
import type {
  AgentInfo,
  GuestBinding,
  HealthResponse,
  MacfFleetConfig,
  CrossProjectAgentResolver,
} from '@groundnuty/macf-core';
import { formatTable } from './ps.js';
import { formatRunState, rawField } from './health-fields.js';

/**
 * Resolve a guest's registry slot: `(homeProject, name) → AgentInfo | null`.
 * Structurally IDENTICAL to macf-core's `CrossProjectAgentResolver` (DR-041
 * Amendment A, groundnuty/macf#786) — aliased rather than redefined so the
 * STATUS layer (this file, DR-036) and the MESSAGING layer (`notify_peer` /
 * outbound A2A / `macf-ping`) share one resolver shape, never two that could
 * drift apart.
 */
export type GuestResolveFn = CrossProjectAgentResolver;

/**
 * mTLS `/health` probe for a guest; null on any failure. Takes the guest's
 * HOME project (DR-041 Amendment B, groundnuty/macf#794) so the probe can
 * build a federation-aware trust bundle when that project is declared in
 * `federated_cas` — same shape extension as `probePeerHealth`'s optional
 * `GuestProbeContext` in the plugin-lib layer, applied here to the CLI-layer
 * probe function type.
 */
export type GuestProbeFn = (
  homeProject: string,
  host: string,
  port: number,
) => Promise<HealthResponse | null>;

/**
 * Path-aware reachability verdict for a guest:
 *  - `online`     — a `route` guest whose `/health` answered.
 *  - `offline`    — a `route` guest resolved in the registry but whose `/health`
 *                   did not answer (genuinely down, OR behind a non-shared CA).
 *  - `unresolved` — a `route` guest NOT found in the shared registry (nothing to
 *                   probe). Visible as a static binding; no live state.
 *  - `local-mode` — an `operator-relay` (path c) guest: NEVER probed, NEVER
 *                   "down"; registry-derived state only ("home-fleet-observable").
 */
export type GuestReachability = 'online' | 'offline' | 'unresolved' | 'local-mode';

/** One guest's binding + resolved registry entry + reachability + raw self-report. */
export interface GuestStatus {
  readonly binding: GuestBinding;
  /** The guest's home project (parsed from `binding.agent`). */
  readonly homeProject: string;
  /** The guest's agent name (parsed from `binding.agent`). */
  readonly name: string;
  /** Registry slot, or null when unresolvable in the reachable scope. */
  readonly info: AgentInfo | null;
  readonly reachability: GuestReachability;
  /** Raw `/health` body (route guests only), or null. NEVER read for local-mode. */
  readonly health: HealthResponse | null;
}

/**
 * Shared parse of `<projectDir>/.github/macf-fleet.json` (macf#614 fleet-scope
 * config) — both `loadGuestBindings` (DR-036) and `loadFederatedCas` (DR-041
 * Amendment A, macf#786) read the SAME file for different fields, so the
 * degrade-on-absent/malformed logic lives here once. DEGRADES rather than
 * crashes: an absent file → `null`; a malformed file → a LOUD stderr warning
 * + `null` (loud-but-proceeds, the house posture — a broken fleet config
 * must not take down `fleet status` / `/macf-peers` / `macf-ping`).
 */
function loadMacfFleetConfig(projectDir: string): MacfFleetConfig | null {
  const path = join(projectDir, '.github', 'macf-fleet.json');
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.error(`Warning: .github/macf-fleet.json is not valid JSON — ignoring guests/federation (${String(e)}).`);
    return null;
  }
  const result = MacfFleetConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    console.error(
      `Warning: .github/macf-fleet.json failed validation${where} — ignoring guests/federation ` +
        `(${first ? first.message : 'invalid config'}).`,
    );
    return null;
  }
  return result.data;
}

/**
 * Load the consumer-local guest bindings from `<projectDir>/.github/macf-fleet.json`
 * (macf#614 fleet-scope config). DEGRADES rather than crashes: an absent file →
 * `[]`; a malformed file → a LOUD stderr warning + `[]` (loud-but-proceeds, the
 * house posture — a broken guest binding must not take down `fleet status`).
 */
export function loadGuestBindings(projectDir: string): readonly GuestBinding[] {
  return loadMacfFleetConfig(projectDir)?.guests ?? [];
}

/**
 * Load the `federated_cas` project list from `<projectDir>/.github/macf-fleet.json`
 * (DR-041 Amendment A, groundnuty/macf#786) — the SAME trust list
 * `trust-bundle.ts`'s `loadFederatedCaProjects` reads for the channel-server's
 * mTLS trust bundle, re-read here because `macf-ping` (this package) does not
 * depend on `@groundnuty/macf-channel-server`. Gates `macf-ping`'s
 * `<project>/<name>` cross-fleet guest addressing via `resolveGuestAddress`
 * (macf-core) — the SAME ladder + gate `notify_peer` / outbound A2A use.
 * DEGRADES the same way `loadGuestBindings` does: absent/malformed file → `[]`
 * (the safe "no federation" default, never a crash).
 */
export function loadFederatedCas(projectDir: string): readonly string[] {
  return loadMacfFleetConfig(projectDir)?.federated_cas ?? [];
}

/**
 * Resolve ONE guest to its status. PURE w.r.t. `resolve`/`probe` — tests inject
 * fakes so nothing hits the registry or the network. `operator-relay` guests are
 * NEVER probed (path c): they resolve to `local-mode` regardless of whether the
 * registry slot is present, so a private-mesh guest is never shown "down".
 */
export async function resolveGuestStatus(
  binding: GuestBinding,
  resolve: GuestResolveFn,
  probe: GuestProbeFn,
): Promise<GuestStatus> {
  const { homeProject, name } = parseGuestAgentRef(binding.agent);
  const info = await resolve(homeProject, name).catch(() => null);

  // Path (c): local-mode / operator-relay — registry-derived state ONLY, never a
  // cross-fleet probe, never "down".
  if (binding.delegate_via === 'operator-relay') {
    return { binding, homeProject, name, info, reachability: 'local-mode', health: null };
  }

  // Path (a/b): route — resolvable + live-probeable.
  if (info === null) {
    return { binding, homeProject, name, info: null, reachability: 'unresolved', health: null };
  }
  const health = await probe(homeProject, info.host, info.port).catch(() => null);
  return {
    binding,
    homeProject,
    name,
    info,
    reachability: health !== null ? 'online' : 'offline',
    health,
  };
}

/**
 * Resolve every guest, isolating each (a rejected resolve/probe degrades only
 * that guest, never aborts the block — mirrors `gatherFleetStatus`'s #609
 * per-peer isolation).
 */
export async function gatherGuestStatuses(
  bindings: readonly GuestBinding[],
  resolve: GuestResolveFn,
  probe: GuestProbeFn,
): Promise<readonly GuestStatus[]> {
  const settled = await Promise.allSettled(bindings.map((b) => resolveGuestStatus(b, resolve, probe)));
  const out: GuestStatus[] = [];
  for (let i = 0; i < bindings.length; i++) {
    const r = settled[i]!;
    if (r.status === 'fulfilled') {
      out.push(r.value);
    } else {
      // resolveGuestStatus already swallows resolve/probe rejections, so this is
      // belt-and-braces: a fully-failed guest still renders as unresolved.
      const b = bindings[i]!;
      const ref = ((): { homeProject: string; name: string } => {
        try {
          return parseGuestAgentRef(b.agent);
        } catch {
          return { homeProject: b.agent, name: '' };
        }
      })();
      out.push({
        binding: b,
        homeProject: ref.homeProject,
        name: ref.name,
        info: null,
        reachability: b.delegate_via === 'operator-relay' ? 'local-mode' : 'unresolved',
        health: null,
      });
    }
  }
  return out;
}

/** Human-readable reachability cell — the load-bearing "never down" for local-mode. */
export function formatGuestReachability(r: GuestReachability): string {
  switch (r) {
    case 'online':
      return 'online';
    case 'offline':
      return 'offline';
    case 'unresolved':
      return 'unresolved (not in shared registry)';
    case 'local-mode':
      return 'local-mode — home-fleet-observable only';
  }
}

/**
 * Registry-heartbeat freshness cell (DR-031). `fresh` when a heartbeat is present
 * and within TTL; `stale ⚠` when present but aged past TTL; `—` when absent
 * (unknown, NEVER judged dead — `isStaleEntry` returns false for absence) or the
 * guest is unresolved.
 */
export function formatGuestHeartbeat(info: AgentInfo | null, now: number): string {
  if (!info || !info.last_heartbeat) return '—';
  return isStaleEntry(info, DEFAULT_REGISTRY_TTL_MS, now) ? 'stale ⚠' : 'fresh';
}

const GUEST_HEADERS = [
  'GUEST',
  'LOCAL-ROLE',
  'VIA',
  'HOST:PORT',
  'REACHABILITY',
  'STATE',
  'INSTANCE',
  'HEARTBEAT',
] as const;

/**
 * Build one display row per guest (pure — exported for tests). The STATE
 * column (DR-041 Amendment B, groundnuty/macf#794) renders the SAME
 * `/health.state` self-report field the fleet MEMBERS table shows
 * (`fleet.ts`'s `formatRunState`) — a federated, live guest surfaces its
 * idle/busy turn-state exactly like a same-fleet peer does. `—` for any
 * guest with no live `/health` body (offline / unresolved / local-mode).
 */
export function buildGuestRows(
  statuses: readonly GuestStatus[],
  now: number,
): readonly (readonly string[])[] {
  return statuses.map((s) => {
    const where = s.info ? `${s.info.host}:${s.info.port}` : '—';
    return [
      s.binding.agent,
      s.binding.local_role,
      s.binding.delegate_via,
      where,
      formatGuestReachability(s.reachability),
      formatRunState(rawField(s.health, 'state')),
      s.info?.instance_id ?? '—',
      formatGuestHeartbeat(s.info, now),
    ];
  });
}

/** Full rendered GUEST table (pure — exported for tests). */
export function formatGuestTable(statuses: readonly GuestStatus[], now: number): string {
  return formatTable(GUEST_HEADERS, buildGuestRows(statuses, now));
}

/**
 * The GUEST block as a single rendered string, with the section header + the
 * unsupervised legend. Empty string when there are no guests (callers gate the
 * whole block on that so nothing prints for a fleet with no guests).
 */
export function formatGuestBlock(statuses: readonly GuestStatus[], now: number): string {
  if (statuses.length === 0) return '';
  return [
    'GUEST / external collaborators (DR-036 — visible, NOT supervised):',
    formatGuestTable(statuses, now),
    'Note: guests are external agents this fleet DEPENDS on but does NOT supervise —',
    '      DR-031 liveness/restart/prune NEVER apply. A local-mode (operator-relay)',
    '      guest shows home-fleet-observable state only and is NEVER reported "down".',
  ].join('\n');
}

/**
 * Structured `--json` shape for the guest block. Carries `supervised: false` on
 * every guest — the explicit machine-readable form of the no-supervision
 * invariant — plus the raw `/health` body (route guests) so any present
 * state/otel fields pass through untouched.
 */
export function guestStatusesToJson(statuses: readonly GuestStatus[]): unknown {
  return statuses.map((s) => ({
    agent: s.binding.agent,
    home_project: s.homeProject,
    name: s.name,
    local_role: s.binding.local_role,
    purpose: s.binding.purpose,
    delegate_via: s.binding.delegate_via,
    until: s.binding.until ?? null,
    // The load-bearing invariant, made explicit for any watchdog consuming this:
    // a guest is NEVER supervised by the consumer fleet (DR-036 Amendment A).
    supervised: false,
    reachability: s.reachability,
    host: s.info?.host ?? null,
    port: s.info?.port ?? null,
    instance_id: s.info?.instance_id ?? null,
    last_heartbeat: s.info?.last_heartbeat ?? null,
    health: s.health,
  }));
}
