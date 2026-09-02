import { z } from 'zod';

// --- Agent registration info stored in GitHub variable ---

export const AgentInfoSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  type: z.enum(['permanent', 'worker']),
  instance_id: z.string(),
  started: z.string(),
  /**
   * Liveness re-stamp written periodically by the live instance's registry
   * heartbeat (DR-031, groundnuty/macf#568). ISO-8601. ADDITIVE-OPTIONAL: older
   * entries (and pre-DR-031 channel-server versions that never heartbeat) parse
   * fine without it, and an ABSENT `last_heartbeat` must NEVER be judged stale
   * (`isStaleEntry` returns false for absence — unknown, not dead). Staleness is
   * asserted only when a heartbeat IS present and has aged past the TTL — the
   * backstop for the UNGRACEFUL-death case (kill -9 / OOM / power loss) that the
   * graceful-deregister (#586) shutdown handler never runs for.
   */
  last_heartbeat: z.string().optional(),
  /**
   * The agent's OTEL wire identity — `MACF_AGENT_NAME`, written at
   * registration (groundnuty/macf#1393, `groundnuty/macf-devops-toolkit#203`).
   * ADDITIVE-OPTIONAL: the registry KEY is (and stays) `routing_label`
   * (`MACF_ROUTING_LABEL`, defaulting to `agent_name` when unset — see
   * `config.ts`), so this field records a SECOND name, not a replacement.
   * The two are allowed to differ by design (`coordination.md` §tmux launch
   * — e.g. science: `agent_name=macf-science-agent`,
   * `routing_label=science-agent`) and OTEL's `gen_ai.agent.name` carries
   * `agent_name`, not the routing label.
   *
   * A reader MUST treat an ABSENT `agent_name` as unknown — NEVER default it
   * to `routing_label`. Doing so would silently reintroduce the exact "I
   * can't tell a real name from a guess" ambiguity this field exists to
   * remove: entries written before this field existed (and any future
   * channel-server predating it) parse fine without it, and defaulting the
   * absence would make every pre-existing entry look like a coincidentally
   * name-matching agent instead of an honestly-unknown one.
   */
  agent_name: z.string().optional(),
});

export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/**
 * Value equality for two `AgentInfo`s (or absence). `null` represents an
 * empty registry slot; two nulls are equal, a null and a value are not.
 * Used by the conditional-register CAS to compare the slot's observed
 * state against its current state.
 *
 * `last_heartbeat` is INTENTIONALLY EXCLUDED from the comparison (DR-031): it is
 * liveness-churn, not identity. Including it would spuriously fail the startup
 * CAS if a heartbeat from the prior instance landed in the collision-check →
 * register-write window (a re-stamp must not block a legitimate #424 version-
 * takeover). The five identity fields below fully determine slot ownership.
 *
 * `agent_name` is ALSO excluded (groundnuty/macf#1393) — it is descriptive
 * metadata (the OTEL wire name), not identity; the registry KEY + these five
 * fields already fully determine slot ownership, and `agent_name` is constant
 * for a given instance's whole lifetime, so excluding it from the CAS is
 * purely a "don't widen the identity surface" choice, not a functional need
 * the way `last_heartbeat`'s exclusion is. It also keeps a pre-existing entry
 * (written before this field existed, so `agent_name` is absent) comparing
 * correctly against a freshly composed one that carries it.
 */
export function agentInfoEquals(a: AgentInfo | null, b: AgentInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.type === b.type &&
    a.instance_id === b.instance_id &&
    a.started === b.started
  );
}

/**
 * Outcome of a conditional (compare-and-set) register (groundnuty/macf#439,
 * reshaped by groundnuty/macf#702 — over-register).
 *
 * `ok: true`  — this instance now owns the slot; `current` is the value just
 *               written (=== the `info` passed in). Ownership strength is
 *               backend-dependent: the local backend is **exclusive-at-return**
 *               (the compare+write is lock-atomic), whereas the GitHub-Variables
 *               backend is **best-effort / eventually-reconciled** — a racer
 *               writing in the same instant can still win (no native CAS on that
 *               API; see registry.ts `registerConditional`).
 * `ok: false` — a concurrent writer changed the slot between the collision
 *               check and this write; `current` is the conflicting value
 *               observed (null if the slot was emptied). The caller decides
 *               claim-vs-yield from `reason` (see below) — `ok:false` is NO
 *               LONGER an unconditional abort signal (groundnuty/macf#702 fixed
 *               the devops 8h-outage bug where it was).
 *
 * `reason` discriminates WHY the CAS resolved the way it did — this is the
 * groundnuty/macf#702 fix. Before #702, `ok:false` was always treated as "lost
 * a race, abort" (`RegisterRaceError`), which mis-fired when the write
 * actually succeeded but the GitHub Variables API's read-after-write lag
 * served a stale GET on the post-write read-back (the exact devops bug:
 * `current == expected` — nothing changed — yet the read-back momentarily
 * still showed the pre-write value, and the old code aborted anyway):
 *
 *  - `'claimed'`          — `ok:true`. The write landed and (when a read-back
 *                           exists) is confirmed, OR the pre-write compare
 *                           found the slot unchanged from `expected` and the
 *                           write was issued — the CAS ALWAYS claims in this
 *                           case, never aborts, even if a same-backend
 *                           read-back lag means confirmation isn't
 *                           immediately visible (groundnuty/macf#702 §1).
 *  - `'lost-to-newer'`    — `ok:false`. The write-time re-read (or read-back)
 *                           observed a DIFFERENT registration than `expected`
 *                           — a genuine concurrent writer. The caller
 *                           (server.ts) is responsible for classifying that
 *                           `current` as newer-live (yield) vs stale/older
 *                           (retry the takeover) — the registry layer only
 *                           reports the conflicting value; it doesn't probe
 *                           liveness (that's `collision.ts`'s job).
 */
export interface RegisterResult {
  readonly ok: boolean;
  readonly reason: 'claimed' | 'lost-to-newer';
  readonly current: AgentInfo | null;
}

/**
 * Outcome of a conditional (instance-id-guarded) deregister — the graceful-
 * shutdown root-cause fix for the stale-registry-entry class (DR-031,
 * groundnuty/macf#553; #557 fixed only the takeover *symptom*).
 *
 * The slot is deleted ONLY when it is still ours — its `instance_id` matches
 * the `expectedInstanceId` we registered. This is the load-bearing inverse-of-
 * #553 guard: if a newer instance took over our slot (groundnuty/macf#424) while
 * we were running, the slot now carries the newer instance's `instance_id`, so
 * we must NOT delete it on our exit (that would re-introduce a missing/stale
 * entry for a live peer).
 *
 * `reason` distinguishes the four terminal states so the caller can log a
 * precise diagnostic:
 *  - `'deleted'`   — slot was ours; deleted.
 *  - `'not-ours'`  — slot is present but held by a different instance_id (a
 *                    newer instance took over); left intact (NOT a failure).
 *  - `'absent'`    — slot already gone (or unreadable/corrupt → treated as
 *                    not-ours-to-delete); nothing to do.
 *  - `'error'`     — a registry read/delete failed. `deregisterConditional`
 *                    NEVER throws — a deregister failure must not crash
 *                    shutdown; the caller logs + proceeds.
 */
export interface DeregisterResult {
  readonly deregistered: boolean;
  readonly reason: 'deleted' | 'not-ours' | 'absent' | 'error';
}

/**
 * Outcome of an instance-id-guarded registry heartbeat (DR-031,
 * groundnuty/macf#568). The live instance periodically re-stamps `last_heartbeat`
 * on its OWN slot so a reader can TTL-judge an entry whose heartbeat aged out as
 * dead — the backstop for the UNGRACEFUL death (kill -9 / OOM / power loss) that
 * never runs the graceful-deregister (#586) shutdown handler.
 *
 * The write is guarded EXACTLY like `deregisterConditional`: re-stamp ONLY if the
 * slot still carries OUR `instance_id`. If a newer instance took over the slot
 * (groundnuty/macf#424) we must NOT re-stamp it (that would clobber the live
 * newer peer's registration / mask its own heartbeat) — we report `not-ours` and
 * let it heartbeat its own entry.
 *
 *  - `'beat'`     — slot was ours; `last_heartbeat` re-stamped.
 *  - `'not-ours'` — slot held by a different instance_id (a newer instance took
 *                   over); left untouched (NOT a failure).
 *  - `'absent'`   — slot already gone (or unreadable/corrupt); nothing to stamp.
 *  - `'error'`    — a registry read/write failed. `heartbeatConditional` NEVER
 *                   throws — a heartbeat hiccup must never crash the server or
 *                   block anything; the caller logs + the next interval retries.
 */
export interface HeartbeatResult {
  readonly beat: boolean;
  readonly reason: 'beat' | 'not-ours' | 'absent' | 'error';
}

// --- Registry interface ---

export interface Registry {
  readonly register: (name: string, info: AgentInfo) => Promise<void>;
  /**
   * Compare-and-set register (groundnuty/macf#439; over-register semantics
   * per groundnuty/macf#702): write `info` if the slot still matches
   * `expected` (the value observed during the collision check; `null` =
   * expected-absent). Closes the TOCTOU window between the collision check's
   * read and the registration write — a racing second writer can't silently
   * clobber the first. Backends differ in atomicity: the local registry is
   * fully atomic under its file lock (no read-back needed); the
   * GitHub-Variables backend narrows the window with a pre-write compare and
   * best-effort-confirms via a post-write read-back (no native CAS primitive
   * exists on that API — see registry.ts).
   *
   * **groundnuty/macf#702 (over-register):** `current == expected` — the slot
   * is UNCHANGED, including the case where `expected` is itself a stale/dead
   * entry the caller decided to take over — is ALWAYS a claim (`ok:true,
   * reason:'claimed'`), never a failure. This holds even when a same-backend
   * read-back can't yet observe the write (GitHub Variables API
   * read-after-write lag) — a lagging read-back is a confirmation gap, not a
   * lost race, and must not be reported as one (this was the devops 8h-outage
   * bug: `current==expected==<stale>` incorrectly returned `ok:false`).
   * `ok:false, reason:'lost-to-newer'` fires ONLY when the write-time re-read
   * (or the read-back) observes a value that is a genuinely different
   * registration than the caller's own `info` AND different from `expected`
   * — a real concurrent writer. The registry layer reports the conflicting
   * `current` but does not classify it as live/dead/newer/older — that
   * liveness judgment is the caller's (server.ts + collision.ts), which
   * decides claim-over-stale (retry) vs yield-to-newer-live.
   */
  readonly registerConditional: (
    name: string,
    info: AgentInfo,
    expected: AgentInfo | null,
  ) => Promise<RegisterResult>;
  /**
   * Instance-id-guarded deregister (DR-031, groundnuty/macf#553 root-cause). Read
   * the slot named `name`; delete it ONLY if its `instance_id` still equals
   * `expectedInstanceId` (i.e. it is still OUR registration). If a newer instance
   * took over the slot (groundnuty/macf#424) — different `instance_id` — or the
   * slot is already gone / unreadable, this is a no-op (we never clobber a live
   * newer instance's registration on our own shutdown). NEVER throws: a registry
   * failure surfaces as `{ deregistered: false, reason: 'error' }` so a graceful
   * shutdown can log + proceed rather than crash.
   *
   * Atomicity is backend-dependent (same posture as `registerConditional`): the
   * local backend is fully atomic (read-compare-delete inside one file-lock
   * critical section); the GitHub-Variables backend is best-effort (the Actions
   * Variables API exposes no If-Match / conditional-delete primitive, so the
   * read→delete window can't be closed hard — but the dominant #424-takeover
   * case, where the newer instance wrote its instance_id well before our SIGTERM,
   * is fully caught by the instance_id compare).
   */
  readonly deregisterConditional: (
    name: string,
    expectedInstanceId: string,
  ) => Promise<DeregisterResult>;
  /**
   * Instance-id-guarded registry heartbeat (DR-031, groundnuty/macf#568). Read
   * the slot named `name`; re-stamp its `last_heartbeat` to `now` (ISO-8601),
   * PRESERVING all other fields, ONLY if its `instance_id` still equals
   * `expectedInstanceId` (it is still OUR registration). If a newer instance took
   * over the slot (groundnuty/macf#424) — different `instance_id` — or the slot
   * is already gone / unreadable, this is a no-op. NEVER throws: a registry
   * failure surfaces as `{ beat: false, reason: 'error' }` so the periodic caller
   * logs + retries on the next interval rather than crashing the server.
   *
   * Atomicity is backend-dependent (same posture as `registerConditional` /
   * `deregisterConditional`): the local backend is fully atomic (read-compare-
   * write inside one file-lock critical section); the GitHub-Variables backend is
   * best-effort read-then-write (the Actions Variables API exposes no If-Match /
   * conditional-write primitive — groundnuty/macf#439 — so the read→write window
   * can't be closed hard, but the dominant #424-takeover case is caught by the
   * instance_id compare since the newer instance wrote its id at ITS startup).
   * The cadence is deliberately COARSE (default 5 min) to bound the App-token
   * write budget and the #439 TOCTOU surface.
   */
  readonly heartbeatConditional: (
    name: string,
    expectedInstanceId: string,
    now: string,
  ) => Promise<HeartbeatResult>;
  readonly get: (name: string) => Promise<AgentInfo | null>;
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>>;
  readonly remove: (name: string) => Promise<void>;
}

// --- Registry configuration ---

export const OrgRegistryConfigSchema = z.object({
  type: z.literal('org'),
  org: z.string().min(1),
});

export const ProfileRegistryConfigSchema = z.object({
  type: z.literal('profile'),
  user: z.string().min(1),
});

export const RepoRegistryConfigSchema = z.object({
  type: z.literal('repo'),
  owner: z.string().min(1),
  repo: z.string().min(1),
});

/**
 * Local-registry mode (DR-024). The `path` field is the absolute filesystem
 * path to the project's registry JSON file (e.g.
 * `~/.macf/registry/<project>.json` after operator-side `~` expansion). The
 * config schema is intentionally minimal — init-time concerns (default
 * path resolution, `--local` flag aliasing, CA generation) live in the
 * `macf` CLI package, not here.
 */
export const LocalRegistryConfigSchema = z.object({
  type: z.literal('local'),
  path: z.string().min(1),
});

export const RegistryConfigSchema = z.union([
  OrgRegistryConfigSchema,
  ProfileRegistryConfigSchema,
  RepoRegistryConfigSchema,
  LocalRegistryConfigSchema,
]);

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

// --- GitHub Variables API client interface ---

export interface GitHubVariablesClient {
  readonly writeVariable: (name: string, value: string) => Promise<void>;
  readonly readVariable: (name: string) => Promise<string | null>;
  readonly listVariables: () => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>;
  readonly deleteVariable: (name: string) => Promise<void>;
}
