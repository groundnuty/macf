/**
 * Cross-fleet GUEST bindings — DR-036 Amendment A (groundnuty/macf#679).
 *
 * A consumer fleet depends on a specialist agent that lives in ANOTHER fleet
 * (the worked example: `icsoc-2026` depends on `ppam-2026/code-agent`, the
 * `onedata-mcp` specialist). The consumer carries a LOCAL, consumer-side
 * "guest" binding naming that external agent + the perspectival role it plays
 * from the consumer's viewpoint. The external agent neither sees nor agrees to
 * it — topology-autonomy is preserved (a consumer only ANNOTATES its own view;
 * it cannot impose membership on a peer).
 *
 * The load-bearing invariant (DR-036 Amendment A): **visibility is split from
 * supervision**. A guest MAY be SHOWN in the consumer's `macf fleet status` /
 * `/macf-peers`, clearly marked external + unsupervised — but it is NEVER a
 * supervised member (never owned by the consumer's registry, never under its
 * DR-031 liveness / reconciliation / restart / prune machinery). Only the
 * no-supervision half is mandatory; the visibility half is the new capability.
 *
 * The binding lives in the fleet-scope config `.github/macf-fleet.json`
 * (macf#614 — the same file that carries the `routing_fleet` opt-OUT marker),
 * so this schema describes the WHOLE file, not just the guests array. The
 * `routing_fleet` key is preserved here so the one config file has one schema.
 */
import { z } from 'zod';
import { MacfError } from './errors.js';
import type { AgentInfo } from './registry/types.js';

/**
 * How the consumer reaches the guest (DR-036 §two enabler paths, Amendment A):
 *  - `route`          — the guest is App-scoped + GitHub-@mention-routable
 *                       (paths a/b). Cross-reachable → a live `/health` probe is
 *                       meaningful; the guest shows its live online/offline state.
 *  - `operator-relay` — the guest is a local-mode / private-mesh agent (path c):
 *                       no App, a local-CA mTLS mesh on a host the consumer can't
 *                       reach. A cross-fleet `/health` probe is NOT meaningful (it
 *                       would hit the consumer's own localhost or fail), so the
 *                       guest renders registry-derived state ONLY — never "down".
 */
export const GUEST_DELEGATE_VIA = ['route', 'operator-relay'] as const;
export const GuestDelegateViaSchema = z.enum(GUEST_DELEGATE_VIA);
export type GuestDelegateVia = z.infer<typeof GuestDelegateViaSchema>;

/**
 * `<home-project>/<name>` — the guest's home fleet + agent name. One `/`; no
 * whitespace or additional slashes in either segment. Resolves in the shared
 * registry scope as `<HOME_PROJECT>_AGENT_<NAME>` (DR-006 profile scope; the
 * cross-scope union per macf#621 when the guest lives under a different scope).
 */
const GUEST_AGENT_REF_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * One consumer-side guest binding (DR-036 Amendment A). Consumer-LOCAL: the
 * external agent is unaware. Perspectival — `local_role` is the consumer's
 * vocabulary for the role the guest plays here, NOT a role the guest adopts.
 */
export const GuestBindingSchema = z.object({
  /** `<home-project>/<name>` — home fleet + agent (resolves in the shared registry). */
  agent: z
    .string()
    .regex(GUEST_AGENT_REF_RE, 'guest.agent must be "<home-project>/<name>" (one slash, no spaces)'),
  /** The perspectival role the guest plays from the consumer's viewpoint (e.g. `onedata-specialist`). */
  local_role: z.string().min(1, 'guest.local_role must be non-empty'),
  /** Why this dependency exists (e.g. `data-access dependency (onedata-mcp)`). */
  purpose: z.string().min(1, 'guest.purpose must be non-empty'),
  /** How the consumer reaches the guest — decides path-aware reachability rendering. */
  delegate_via: GuestDelegateViaSchema,
  /**
   * Optional expiry → "temporary" membership. `null` (or absent) = open-ended.
   * A consumer-side annotation scoped in time with no change on the guest's side.
   */
  until: z.string().nullable().optional().default(null),
});
export type GuestBinding = z.infer<typeof GuestBindingSchema>;

/**
 * The whole `.github/macf-fleet.json` fleet-scope config (macf#614 + #679).
 * Non-strict: unknown keys are stripped, so a future additive key doesn't
 * reject the file. `guests` defaults to `[]` so a config with no guests (or the
 * plain `routing_fleet`-only marker) parses to an empty guest list.
 */
export const MacfFleetConfigSchema = z.object({
  /**
   * macf#614 routing-fleet opt-OUT marker: a pinned agent-router-caller repo
   * declares itself non-fleet (`false`) to be excluded from `routing doctor`'s
   * `pins_consistent` verdict. Preserved here so one file has one schema.
   */
  routing_fleet: z.boolean().optional(),
  /** Consumer-side cross-fleet guest bindings (DR-036 Amendment A, #679). */
  guests: z.array(GuestBindingSchema).default([]),
  /**
   * DR-041 Decision 1 (cross-fleet trust federation, macf#784): home-project
   * identifiers whose per-fleet CA is added to this fleet's mTLS trust bundle.
   * Each entry names a project (e.g. `ppam-2026`) — NOT an individual agent —
   * whose `<PROJECT>_CA_CERT` shared-registry variable the channel-server
   * resolves at startup and appends to its `ca` trust bundle. v1 (this) is the
   * static-committed-bundle tier (DR-041 Decision 1c Tier v1); the well-known
   * bundle-endpoint tier is documented as v2 (backlog `#783`). Federating a
   * fleet's CA trusts EVERY certificate that CA has signed — admission is
   * per-fleet-CA, all-or-nothing (intended; per-agent/per-skill restriction is
   * a deferred capability-token concern, NOT this mechanism). Defaults to `[]`
   * so an absent key is exactly "no federation" (unchanged single-CA trust).
   */
  federated_cas: z.array(z.string()).default([]),
});
export type MacfFleetConfig = z.infer<typeof MacfFleetConfigSchema>;

/** Raised when a `.github/macf-fleet.json` value violates the schema. */
export class GuestConfigError extends MacfError {
  constructor(message: string) {
    super('GUEST_CONFIG_ERROR', message);
    this.name = 'GuestConfigError';
  }
}

/**
 * Parse + validate a raw `.github/macf-fleet.json` value. Throws
 * `GuestConfigError` (with the first Zod issue path + message) on any schema
 * violation so a malformed binding fails LOUD rather than silently dropping a
 * guest. Callers that must DEGRADE instead (a config read on a hot path) can use
 * `MacfFleetConfigSchema.safeParse` directly and fall back to an empty config.
 */
export function parseMacfFleetConfig(raw: unknown): MacfFleetConfig {
  const result = MacfFleetConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    const why = first ? first.message : 'invalid config';
    throw new GuestConfigError(`Invalid .github/macf-fleet.json${where}: ${why}`);
  }
  return result.data;
}

/**
 * Split a `<home-project>/<name>` guest ref into its two segments. Assumes the
 * ref already passed `GuestBindingSchema` (exactly one `/`); throws
 * `GuestConfigError` defensively for a malformed ref reaching this path.
 */
export function parseGuestAgentRef(agent: string): {
  readonly homeProject: string;
  readonly name: string;
} {
  const slash = agent.indexOf('/');
  if (slash <= 0 || slash !== agent.lastIndexOf('/') || slash === agent.length - 1) {
    throw new GuestConfigError(
      `guest.agent "${agent}" is not "<home-project>/<name>" (one slash required)`,
    );
  }
  return { homeProject: agent.slice(0, slash), name: agent.slice(slash + 1) };
}

/**
 * DR-041 Amendment A (cross-fleet guest ADDRESSING, groundnuty/macf#786):
 * resolve a guest's `<home-project>/<name>` registry slot to its `AgentInfo`.
 * Mirrors `fleet-guests.ts`'s `GuestResolveFn` shape exactly — kept as an
 * independent type here (rather than the reverse) so the outbound MESSAGING
 * clients (`macf-channel-server`'s `notify_peer` + outbound A2A dispatch,
 * `macf`'s `macf-ping` CLI) can depend on macf-core WITHOUT depending on the
 * `macf` package's `fleet-guests.ts` (the STATUS-layer module, DR-036,
 * which lives one package over and pulls in CLI-only concerns).
 */
export type CrossProjectAgentResolver = (
  homeProject: string,
  name: string,
) => Promise<AgentInfo | null>;

/**
 * Outcome of resolving a `to` address string against DR-041 Amendment A's
 * 4-rung cross-fleet guest resolution ladder (groundnuty/macf#786):
 *
 *   1. `to` parses as `<project>/<name>` + the home project is federated +
 *      the registry slot resolves → `resolved` — attempt delivery.
 *   2. `to` parses but the home project is NOT in `federatedCas` →
 *      `not-federated` — clear DR-041 error, never a silent no-op.
 *   3. `to` parses + home project federated, but the registry slot is
 *      missing/unresolvable → `not-found` — clear error.
 *   4. `to` does NOT parse as a `<project>/<name>` slug at all →
 *      `not-a-guest-ref` — the caller falls through to its OWN, UNCHANGED
 *      own-project resolution. Deliberately NOT folded into this ladder:
 *      each call site's own-project lookup mechanics differ (a direct
 *      `registry.get(name)` in `notify-peer.ts` vs. a sanitized-name
 *      `list()`-then-`find()` in `macf-ping`), so unifying THAT part would
 *      require reshaping call sites that aren't broken, for no shared
 *      benefit — only the GUEST ladder (parse + trust-gate + cross-project
 *      resolve + error text) is common enough to be worth one shared
 *      implementation.
 */
export type GuestAddressResolution =
  | { readonly kind: 'not-a-guest-ref' }
  | {
      readonly kind: 'not-federated';
      readonly homeProject: string;
      readonly name: string;
      readonly error: string;
    }
  | {
      readonly kind: 'not-found';
      readonly homeProject: string;
      readonly name: string;
      readonly error: string;
    }
  | {
      readonly kind: 'resolved';
      readonly homeProject: string;
      readonly name: string;
      readonly info: AgentInfo;
    };

/**
 * DR-041 Amendment A's unified cross-fleet guest resolution ladder
 * (groundnuty/macf#786) — the SINGLE implementation `notify_peer` (outbound
 * `/notify` + outbound A2A `message/send`, both dispatch through the SAME
 * resolved peer in `notify-peer.ts`) and `macf-ping` reuse, so the addressing
 * gate + its exact error text can never drift between call sites.
 *
 * Gated on `federatedCas` ALONE (DR-041 Amendment A decision 1) — NEVER on a
 * `guests` binding. Rationale (science-ratified on macf#786): trust (the
 * per-fleet-CA mTLS bundle, #785) is the SOLE admission gate for cross-fleet
 * addressing — once a fleet's CA is federated, every agent that CA has
 * signed is mTLS-reachable, so gating addressing on that SAME set keeps
 * "can I address it" and "can I mTLS it" consistent. The `guests` binding
 * (`.github/macf-fleet.json` `guests[]`) remains a relationship/metadata
 * layer (DR-036) — consulted for scope-awareness in a FUTURE amendment
 * (`scope_out`/`capabilities`, #779), never a second hard addressing gate.
 *
 * A malformed / non-slug `to` (rung 4) is NOT an error here — it returns
 * `{ kind: 'not-a-guest-ref' }` so the caller falls through to its own
 * unchanged own-project resolution, byte-identical to pre-#786 behavior.
 */
export async function resolveGuestAddress(
  to: string,
  federatedCas: readonly string[],
  resolve: CrossProjectAgentResolver,
): Promise<GuestAddressResolution> {
  let ref: { readonly homeProject: string; readonly name: string };
  try {
    ref = parseGuestAgentRef(to);
  } catch {
    return { kind: 'not-a-guest-ref' };
  }
  const { homeProject, name } = ref;

  if (!federatedCas.includes(homeProject)) {
    return {
      kind: 'not-federated',
      homeProject,
      name,
      error:
        `guest ${homeProject}/${name}: home fleet '${homeProject}' not in federated_cas — ` +
        'federate it (DR-041) to message this guest.',
    };
  }

  const info = await resolve(homeProject, name);
  if (info === null) {
    return {
      kind: 'not-found',
      homeProject,
      name,
      error: `guest ${homeProject}/${name} not found in registry.`,
    };
  }

  return { kind: 'resolved', homeProject, name, info };
}
