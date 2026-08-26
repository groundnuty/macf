/**
 * `network.advertise_host` vs. the LIVE registered `host` — comparison
 * (groundnuty/macf#1203).
 *
 * The gap this closes: `fleet.yaml`'s `network.advertise_host` is a single,
 * fleet-wide, WRITE-ONCE declared value (`FleetNetworkSchema`,
 * `fleet-manifest.ts` — required, not per-agent). Each agent separately
 * writes its OWN live registration (`MACF_<PROJECT>_AGENT_<ROLE>`, an
 * {@link AgentInfo} carrying its own `host`) at process startup. Nothing
 * compared the two — `bootstrap status` already prints the registered
 * `host:port` (`status.ts`'s RUNTIME table) via a read that was already
 * wired (`observer.ts::readAgentRegistryInfo`); this module is the missing
 * diff, not a new observation.
 *
 * **Why it matters:** `advertise_host` is how peers reach an agent. If the
 * declared value and an agent's registered value diverge — a VM moved, a
 * tailnet name changed, an agent registered from the wrong host — routing
 * breaks in a way that looks like the agent being offline, and nothing
 * today reports the disagreement.
 *
 * **A multi-host fleet is not a legitimate topology this comparison should
 * tolerate — the framework already treats it as drift, not variation.**
 * `manifest-scaffold.ts::resolveAdvertiseHost` (drafting a fresh
 * `fleet.yaml` from live state) reads every declared agent's registry entry
 * and REFUSES to emit a single `advertise_host` value when they disagree —
 * `declared agents disagree on advertised host (…) — this is drift, not a
 * single value to declare` (that function's own comment). So a fleet-wide
 * single declared value being diffed against each agent's own registered
 * host, as this module does, is not a design choice unique to THIS
 * comparison — it is the existing model `network.advertise_host` already
 * commits to at scaffold time; this module is the runtime-side enforcement
 * of that same commitment.
 *
 * **Honest-unknown floor.** An agent that has never registered (or whose
 * registry read itself failed) has no live host to compare — that is
 * `'unknown'`, never `'mismatch'`. A fleet that is provisioned but not yet
 * deployed must not light up as drifted; see
 * {@link detectAdvertiseHostDriftForAgent}'s two `'unknown'`-producing
 * branches below.
 *
 * **Host-only, deliberately — the port is EXCLUDED from this comparison.**
 * `advertise_host` is declared as a bare host string (`FleetNetworkSchema`
 * has no `advertise_port` field — nothing in `fleet.yaml` declares a port
 * to compare against). `AgentInfo.port` is assigned by the agent process at
 * launch (its own listen port) and MAY legitimately differ agent to agent
 * and run to run — comparing it would manufacture false drift against a
 * value the manifest never claims to govern. This module reads
 * `AgentRegistryObservation`'s `info.host` field only; `info.port` is never
 * even referenced here — see `advertise-host-drift.test.ts`'s decisive
 * "same host, different port → still match" case, which pins this choice
 * against a regression that starts comparing `host:port` as a pair.
 *
 * **Report-only — `apply` does NOT converge this (a deliberate, separate
 * decision, not an oversight).** Re-registering an agent under the
 * declared host is a REAL action with real risk, and — more fundamentally
 * — the operator-privileged bootstrap tool structurally CANNOT perform it:
 * DR-035 §2 holds that this tool never mints a fleet-agent bot token and
 * never borrows a deployed agent's own credentials, so it has no identity
 * to write that agent's OWN registry entry (`MACF_<PROJECT>_AGENT_<ROLE>`)
 * under. The only writer of that key is the agent's own process, at its
 * own startup, with its own token (see `@groundnuty/macf-core`'s
 * `registry.ts::registerConditional`) — `bootstrap`'s own modules only
 * ever READ it (`observer.ts`) or DELETE it on teardown (`teardown.ts`);
 * none WRITE a new value. This module therefore has no `apply`-side
 * counterpart and is never modeled as a `plan.ts` create/update `PlanItem`
 * verb (which would wrongly imply `apply` can act on it)
 * — it is a standalone report, surfaced by both `macf bootstrap plan` and
 * `macf bootstrap status`, same as the routing block / vault-recipients
 * line those two commands already render as their own sections.
 */
import type { AgentInfo } from '@groundnuty/macf-core';
import type { AgentRegistryObservation } from './observer.js';

export type AdvertiseHostDriftStatus = 'match' | 'mismatch' | 'unknown';

/** One declared agent's advertise-host comparison verdict. Always names the declared value; the registered value + reason are present exactly when the status needs them. */
export interface AdvertiseHostDriftEntry {
  readonly role: string;
  readonly declaredHost: string;
  readonly status: AdvertiseHostDriftStatus;
  /** The registered `AgentInfo.host` — present only when `status` is `'match'` or `'mismatch'` (a live value existed to compare). */
  readonly registeredHost?: string;
  /** Human-readable detail — present for `'mismatch'` and `'unknown'`, omitted for `'match'` (nothing to explain). */
  readonly reason?: string;
  /**
   * WHY `status` is `'unknown'` — a genuine per-agent fact, present only
   * when `status === 'unknown'`. `'read-failed'` means `reason` is
   * `registry.reason` FORWARDED VERBATIM from an `AgentRegistryObservation`
   * with `status: 'unknown'` — the exact same string `status.ts`'s RUNTIME
   * table may ALSO footnote for this identical agent, so
   * `formatAdvertiseHostDriftLines` routes it through a SHARED footnote
   * registry (string-equality dedup collapses the two into one).
   * `'never-registered'` means the registry entry is CONFIRMED absent — its
   * message is locally synthesized and unique to THIS module, so it is
   * NEVER footnoted into a registry another render section also reads
   * (that would manufacture a footnote entry that section never asked for
   * — see `status.test.ts`'s "marker in each cell maps unambiguously to
   * its footnote" test, which depends on RUNTIME's OWN footnote registry
   * staying untouched for exactly this "confirmed absent" shape).
   */
  readonly unknownKind?: 'read-failed' | 'never-registered';
}

/** `AgentInfo.port` is intentionally never read here — see this module's doc "Host-only, deliberately." */
function registeredHostOf(info: AgentInfo): string {
  return info.host;
}

/**
 * Pure per-agent comparison — the decisive core. Never throws; every branch
 * is total over {@link AgentRegistryObservation}'s three shapes.
 */
export function detectAdvertiseHostDriftForAgent(
  role: string,
  declaredHost: string,
  registry: AgentRegistryObservation,
): AdvertiseHostDriftEntry {
  if (registry.status === 'unknown') {
    return { role, declaredHost, status: 'unknown', reason: registry.reason, unknownKind: 'read-failed' };
  }
  if (registry.presence === 'absent') {
    return {
      role,
      declaredHost,
      status: 'unknown',
      reason: 'never registered, or deregistered — no live host to compare against the declared value',
      unknownKind: 'never-registered',
    };
  }
  const registeredHost = registeredHostOf(registry.info);
  if (registeredHost === declaredHost) {
    return { role, declaredHost, status: 'match', registeredHost };
  }
  return {
    role,
    declaredHost,
    status: 'mismatch',
    registeredHost,
    reason: `registered host "${registeredHost}" does not match declared network.advertise_host "${declaredHost}"`,
  };
}

/**
 * Fleet-level: one entry per role, in the SAME order `roles` is given
 * (callers pass `manifest.agents.map((a) => a.role)`, so this naturally
 * matches manifest declaration order). A role absent from `registry`
 * degrades to the SAME "not queried this run" `'unknown'` `status.ts`'s
 * `buildAgentView` already falls back to for its own `registry` field —
 * the identical honest-unknown convention, not a new one.
 */
export function detectAdvertiseHostDrift(
  declaredHost: string,
  registry: Readonly<Record<string, AgentRegistryObservation>>,
  roles: readonly string[],
): readonly AdvertiseHostDriftEntry[] {
  return roles.map((role) =>
    detectAdvertiseHostDriftForAgent(
      role,
      declaredHost,
      registry[role] ?? { status: 'unknown', reason: 'registry not queried this run' },
    ),
  );
}

/** `true` when ANY entry is `'mismatch'` — the routing-breaking verdict this module exists to surface. */
export function hasAdvertiseHostMismatch(entries: readonly AdvertiseHostDriftEntry[]): boolean {
  return entries.some((e) => e.status === 'mismatch');
}

/**
 * Minimal shape `status.ts`'s (module-private) `FootnoteRegistry` already
 * satisfies — accepted structurally rather than by importing that class, so
 * this module stays independent of `status.ts` (its own doc's "no `gh`/
 * network, pure comparison" posture — see the `bootstrap-status.test.ts`
 * read-only-imports allowlist this module is on). `commands/bootstrap.ts`
 * (the `plan` render, no footnote machinery of its own) simply omits it.
 */
export interface FootnoteRefFn {
  readonly ref: (reason: string | undefined) => string;
}

/**
 * Human-readable render — its own section (mirrors `status.ts`'s
 * `formatRoutingBlock` / `formatVaultRecipientsLine`: a cross-cutting fact
 * beyond the per-column table, printed as a labeled block). `[]` when there
 * are no agents to report (mirrors `formatFootnotes`'s empty convention).
 *
 * `footnotes`, when given, is used for `'unknown'` entries whose
 * `unknownKind` is `'read-failed'` INSTEAD of inlining `reason` — NOT for
 * every `'unknown'` entry; a `'never-registered'` entry always inlines
 * (see `unknownKind`'s doc for why). This is load-bearing, not cosmetic:
 * a `'read-failed'` entry's reason is frequently the VERBATIM SAME
 * `AgentRegistryObservation` reason `status.ts`'s RUNTIME table already
 * footnotes for the identical agent (both read off the identical registry
 * observation — see `detectAdvertiseHostDriftForAgent`). Passing the SAME
 * `FootnoteRegistry` instance RUNTIME already populated means `ref()`'s
 * string-equality dedup reuses RUNTIME's existing footnote number instead
 * of printing the same long reason text a second time — the #1030 "say
 * once, not once per section" discipline, extended across sections instead
 * of only across cells within one table. `commands/bootstrap.ts` (the
 * `plan` command, which has no RUNTIME table to dedup against) omits
 * `footnotes` and gets the reason inlined directly regardless of kind.
 */
export function formatAdvertiseHostDriftLines(
  entries: readonly AdvertiseHostDriftEntry[],
  footnotes?: FootnoteRefFn,
): readonly string[] {
  if (entries.length === 0) return [];
  const declared = entries[0]?.declaredHost ?? '';
  const lines: string[] = [`ADVERTISE-HOST (declared: ${declared})`];
  for (const e of entries) {
    if (e.status === 'match') {
      lines.push(`  ${e.role}: match (registered as ${e.registeredHost ?? declared})`);
    } else if (e.status === 'mismatch') {
      lines.push(`  ${e.role}: MISMATCH — registered as "${e.registeredHost ?? 'unknown'}"`);
    } else {
      // Only route through the SHARED footnote registry when this reason is
      // the verbatim registry-read-failure text RUNTIME might also cite for
      // this agent (see `unknownKind`'s doc) — the "never registered" kind's
      // locally-synthesized message is NEVER footnoted here, so it never
      // manufactures an entry in a registry another section (RUNTIME)
      // didn't itself populate.
      const marker = e.unknownKind === 'read-failed' ? footnotes?.ref(e.reason) : undefined;
      lines.push(
        marker !== undefined && marker !== ''
          ? `  ${e.role}: unknown${marker}`
          : `  ${e.role}: unknown (${e.reason ?? 'no live registration to compare'})`,
      );
    }
  }
  return lines;
}

/** `--json` shape for one entry — snake_case field names, same convention `status.ts`/`plan.ts` use elsewhere in this CLI. Explicitly whitelisted (never a spread) — same field set for both `plan`'s and `status`'s JSON output. */
export function advertiseHostDriftEntryToJson(e: AdvertiseHostDriftEntry): unknown {
  return {
    role: e.role,
    declared_host: e.declaredHost,
    status: e.status,
    registered_host: e.registeredHost,
    reason: e.reason,
    unknown_kind: e.unknownKind,
  };
}
