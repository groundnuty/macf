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
