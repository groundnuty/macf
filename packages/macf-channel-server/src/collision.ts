import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AgentInfo, Registry } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';
import { MacfError, compareSemver, isStaleEntry, DEFAULT_REGISTRY_TTL_MS } from '@groundnuty/macf-core';

/** Matches a parseable `x.y.z` (optional leading `v`) version string. */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

export class CollisionError extends MacfError {
  constructor(name: string, host: string, port: number) {
    super(
      'AGENT_COLLISION',
      `Agent '${name}' is already running at ${host}:${port}. ` +
      'Stop the existing agent before starting another.',
    );
    this.name = 'CollisionError';
  }
}

/**
 * Thrown ONLY when a `registerConditional` write-time race is lost to a
 * GENUINELY DIFFERENT + NEWER + LIVE instance (groundnuty/macf#702 reshaped
 * this from groundnuty/macf#439's original "any `ok:false` aborts" — the bug
 * that bricked devops for 8h: a stale/same/older `current` must FORCE the
 * claim via retry, never throw this).
 *
 * This is a CLEAN YIELD, not a crash-loop failure — a legitimately newer live
 * peer already holds the slot, so standing down is the correct outcome. The
 * caller (server.ts) catches this distinctly and exits 0 ("a newer instance
 * owns the slot, I yield"), NOT the fatal exit-1 path used for
 * `CollisionError` and other bootstrap aborts. `current` is the conflicting
 * (newer, live) registration observed at write time.
 */
export class RegisterRaceError extends MacfError {
  constructor(name: string, current: AgentInfo | null) {
    super(
      'AGENT_REGISTER_RACE',
      current === null
        ? `Agent '${name}' lost a registration race: the slot changed between ` +
          'the collision check and the write (now empty). Yielding; relaunch to retry.'
        : `Agent '${name}' lost a registration race to a newer live instance ` +
          `(now ${current.host}:${current.port}, instance ${current.instance_id}). ` +
          'Yielding; the newer instance holds the slot.',
    );
    this.name = 'RegisterRaceError';
  }
}

/**
 * Bound on the over-register retry loop (groundnuty/macf#702): how many
 * times server.ts re-attempts `registerConditional` after a `lost-to-newer`
 * result classifies as claim-over-stale (not yield-to-newer-live). Each
 * retry re-reads + re-classifies the conflicting `current` via
 * `classifyPeer`, so this bounds the number of `/health` liveness probes a
 * relaunch will issue against a pathologically flapping slot before giving
 * up. In practice a single retry resolves the devops-class case (the
 * conflicting `current` IS the stale entry we already decided to take over);
 * the extra headroom absorbs a second legitimate racer without looping
 * forever.
 */
export const MAX_REGISTER_RETRIES = 5;

const HEALTH_PING_TIMEOUT_MS = 5000;

/**
 * Liveness re-confirmation against the just-killed-port race (groundnuty/macf#553).
 *
 * A killed channel server's listening socket can momentarily still accept a
 * TCP/TLS connection and answer ONE `/health` 2xx during the narrow window
 * before the OS finishes releasing the port. Trusting that single 2xx
 * mis-classifies a just-killed prior instance as `alive`, and the #424 version
 * quadrant then aborts the restart against a doomed peer — stranding the slot
 * until a manual registry delete.
 *
 * To be robust we require HEALTH_CONFIRM_ATTEMPTS *consecutive* 2xx answers
 * (HEALTH_CONFIRM_DELAY_MS apart). Any failed attempt short-circuits to dead →
 * the caller takes over the slot. A genuinely-live peer answers every attempt →
 * still alive → still aborts (no groundnuty/macf#424 regression). Bounded: at
 * most HEALTH_CONFIRM_ATTEMPTS pings and (HEALTH_CONFIRM_ATTEMPTS - 1) delays of
 * added startup latency, paid only when the first ping is alive.
 */
const HEALTH_CONFIRM_ATTEMPTS = 2;
const HEALTH_CONFIRM_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Result of a collision /health ping: liveness + the advertised version
 *  (null when the peer answered but carried no `version` field — a
 *  pre-groundnuty/macf#424 instance — or was unreachable/unparseable). */
export interface HealthPingResult {
  readonly alive: boolean;
  readonly version: string | null;
}

/**
 * Ping an agent's /health endpoint via mTLS.
 * Returns `{ alive, version }`: alive iff the agent responds 2xx; version is
 * the `version` field parsed from the JSON body (null if absent/unparseable).
 */
function pingHealth(
  host: string,
  port: number,
  caCertPath: string,
  agentCertPath: string,
  agentKeyPath: string,
  timeoutMs: number = HEALTH_PING_TIMEOUT_MS,
): Promise<HealthPingResult> {
  // readFileSync on missing/unreadable cert files throws ENOENT/EACCES
  // as raw Node errors with no descriptive context. During a cert-
  // rotation race at startup, the agent cert/key files may be
  // momentarily absent — without this guard the error propagates as
  // an unhandled rejection up through main() and crashes startup.
  // Treat any read error the same way we treat network errors: the
  // peer is effectively unreachable for the purpose of the collision
  // check. Ultrareview finding H3.
  let ca: Buffer;
  let cert: Buffer;
  let key: Buffer;
  try {
    ca = readFileSync(caCertPath);
    cert = readFileSync(agentCertPath);
    key = readFileSync(agentKeyPath);
  } catch {
    return Promise.resolve({ alive: false, version: null });
  }

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'GET',
        path: '/health',
        ca,
        cert,
        key,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (res) => {
        const alive = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        if (!alive) {
          res.resume(); // drain
          resolve({ alive: false, version: null });
          return;
        }
        // Alive — read the body to extract the advertised version. A peer
        // that answers 2xx but carries no `version` field (or an unparseable
        // body) is treated as version=null (a pre-#424 instance).
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let version: string | null = null;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { version?: unknown };
            if (typeof body.version === 'string') version = body.version;
          } catch {
            // alive but unparseable → version stays null
          }
          resolve({ alive: true, version });
        });
        res.on('error', () => resolve({ alive: true, version: null }));
      },
    );

    req.on('error', () => resolve({ alive: false, version: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false, version: null });
    });
    req.end();
  });
}

/**
 * Classify the existing peer's liveness, robust to the just-killed-port race
 * (groundnuty/macf#553). Pings `/health` up to HEALTH_CONFIRM_ATTEMPTS times,
 * waiting HEALTH_CONFIRM_DELAY_MS between attempts. The FIRST non-alive answer
 * short-circuits to dead (`{ alive:false, version:null }`), so a flickering
 * just-killed peer is treated as dead → the caller takes over the slot. Only a
 * peer that answers 2xx on EVERY attempt is classified alive; the returned
 * version is that of the final (still-answering) ping, feeding the #424 quadrant.
 */
async function confirmLiveness(
  host: string,
  port: number,
  caCertPath: string,
  agentCertPath: string,
  agentKeyPath: string,
): Promise<HealthPingResult> {
  let result: HealthPingResult = { alive: false, version: null };
  for (let attempt = 0; attempt < HEALTH_CONFIRM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(HEALTH_CONFIRM_DELAY_MS);
    result = await pingHealth(host, port, caCertPath, agentCertPath, agentKeyPath);
    if (!result.alive) return { alive: false, version: null };
  }
  return result;
}

export type CollisionResult =
  | { readonly action: 'register' }
  | { readonly action: 'takeover'; readonly previous: AgentInfo }
  | { readonly action: 'abort'; readonly existing: AgentInfo };

/**
 * Check if an agent is already registered and alive.
 *
 * Returns the action to take: register (fresh), takeover (the slot is held by a
 * dead OR alive-but-older instance), or abort (a same/newer live peer holds it).
 *
 * Version-aware takeover (groundnuty/macf#424): a same-version alive peer is
 * still protected (alive → abort), but an alive instance running an *older*
 * version no longer permanently squats the slot — a newer incoming displaces
 * it. The "missing version = oldest" asymmetry is load-bearing: a `/health`
 * with no `version` field is, by construction, a pre-#424 instance (the exact
 * squatter that motivated this), so a versioned incoming takes it over.
 *
 * Quadrant (incoming × existing-alive), assuming the existing peer answers
 * `/health` on every re-confirm ping (dead, OR alive-then-dead flicker per the
 * just-killed-port race groundnuty/macf#553 → takeover regardless):
 *
 *   incoming versioned, existing unversioned   → takeover (takeover_unversioned_existing)
 *   incoming versioned, existing older         → takeover (takeover_newer_version)
 *   incoming versioned, existing same/newer    → abort    (abort_same_or_newer)
 *   incoming unversioned, existing versioned   → abort    (abort_incoming_unversioned)
 *   incoming unversioned, existing unversioned → abort    (abort_incoming_unversioned)
 *
 * `MACF_NO_VERSION_TAKEOVER=1` disables the version predicate (alive → abort
 * always) for the known exception: an operator intentionally pinning an older
 * version while a newer instance launches. Sister escape to MACF_OUTBOUND_LEGACY.
 *
 * Takeover-after-serve: the registry write (takeover/register) happens in the
 * caller AFTER this instance's server is up + answering, so a newer-but-crashing
 * instance never strands the slot. The version compare adds no new TOCTOU window
 * over the existing ping→decide→register sequence — two racing newer instances
 * degrade to the same race the current `variable_exists` check already has.
 *
 * Complementary staleness signal (DR-031, groundnuty/macf#568): when the quadrant
 * above would ABORT against a /health-answering peer but that peer's registry
 * `last_heartbeat` has aged past the TTL, the entry is taken over anyway — the
 * stale heartbeat is a SECOND, version-independent liveness signal that resolves
 * the just-killed-port ambiguity (#553) toward "dead". It is purely additive: it
 * only ever turns a would-abort into a takeover, never the reverse, and a fresh or
 * absent heartbeat leaves the quadrant's decision exactly as-is.
 *
 * @param incomingVersion this instance's channel-server version (PACKAGE_VERSION).
 */
export async function checkCollision(
  name: string,
  registry: Registry,
  certPaths: {
    readonly caCertPath: string;
    readonly agentCertPath: string;
    readonly agentKeyPath: string;
  },
  incomingVersion: string,
  logger: Logger,
): Promise<CollisionResult> {
  const existing = await registry.get(name);

  if (existing === null) {
    logger.info('collision_check', { result: 'fresh', agent: name });
    return { action: 'register' };
  }

  return classifyPeer(name, existing, certPaths, incomingVersion, logger);
}

/**
 * Classify a KNOWN existing registration (`existing`) as register-target-
 * absent-equivalent / takeover / abort — the liveness + #424 version quadrant
 * + DR-031 staleness override, factored out of `checkCollision` so the
 * groundnuty/macf#702 over-register retry loop in server.ts can re-classify
 * the `current` value returned by a lost `registerConditional` race WITHOUT
 * an extra `registry.get()` round-trip (which would reopen a fresh TOCTOU
 * window against the very value we just observed at write-time). Byte-for-
 * byte the same decision logic `checkCollision` has always run — this is a
 * pure extraction, not a behavior change for the original call path.
 */
export async function classifyPeer(
  name: string,
  existing: AgentInfo,
  certPaths: {
    readonly caCertPath: string;
    readonly agentCertPath: string;
    readonly agentKeyPath: string;
  },
  incomingVersion: string,
  logger: Logger,
): Promise<CollisionResult> {
  logger.info('collision_check', {
    result: 'variable_exists',
    agent: name,
    host: existing.host,
    port: existing.port,
    instance_id: existing.instance_id,
  });

  // Liveness is re-confirmed across HEALTH_CONFIRM_ATTEMPTS pings to defeat the
  // just-killed-port race (groundnuty/macf#553): a single momentary 2xx from a
  // dying prior instance must NOT count as alive. A confirmed-live peer then
  // flows into the unchanged #424 version quadrant below.
  const { alive, version: existingVersion } = await confirmLiveness(
    existing.host,
    existing.port,
    certPaths.caCertPath,
    certPaths.agentCertPath,
    certPaths.agentKeyPath,
  );

  if (alive) {
    const versionTakeoverDisabled = process.env['MACF_NO_VERSION_TAKEOVER'] === '1';
    const incomingVersioned = VERSION_PATTERN.test(incomingVersion);

    // Decide takeover-vs-abort against a LIVE peer (the #424 quadrant).
    let takeover: boolean;
    let basis: string;
    if (versionTakeoverDisabled) {
      takeover = false;
      basis = 'abort_version_takeover_disabled';
    } else if (!incomingVersioned) {
      // An unversioned incoming never displaces a live peer.
      takeover = false;
      basis = 'abort_incoming_unversioned';
    } else if (existingVersion === null) {
      // Existing answered but advertised no version → pre-#424 ⟹ oldest.
      takeover = true;
      basis = 'takeover_unversioned_existing';
    } else if (!VERSION_PATTERN.test(existingVersion)) {
      // Non-null but unparseable (malformed /health body, or a pre-release tag
      // the x.y.z parser can't read) → treated as oldest → takeover, but logged
      // with a distinct basis so the line doesn't falsely claim a real version
      // comparison happened (#438 review note 3).
      takeover = true;
      basis = 'takeover_unparseable_existing';
    } else if (compareSemver(incomingVersion, existingVersion) > 0) {
      takeover = true;
      basis = 'takeover_newer_version';
    } else {
      takeover = false;
      basis = 'abort_same_or_newer';
    }

    logger.warn('collision_check', {
      result: basis,
      agent: name,
      incoming_version: incomingVersion,
      existing_version: existingVersion,
      host: existing.host,
      port: existing.port,
    });

    if (takeover) return { action: 'takeover', previous: existing };

    // DR-031 (groundnuty/macf#568) — COMPLEMENTARY staleness override. PURELY
    // ADDITIVE and ONE-DIRECTIONAL: it can only turn a would-ABORT into a
    // takeover, never the reverse. The #424 version quadrant + #553 confirmLiveness
    // above are byte-for-byte unchanged; we only reach here when that quadrant
    // already decided to ABORT against a peer that answered /health on EVERY
    // confirm ping. The registry heartbeat (#589) re-stamps `last_heartbeat` on a
    // coarse cadence, so an entry whose heartbeat aged past the TTL is almost
    // certainly a DEAD instance whose freed/recycled port merely still answers (the
    // #553 just-killed-port race, or a zombie squatting the port) — the stale
    // signal resolves that ambiguity toward "dead → take over", exactly as the
    // dead-`/health` path below already does (which likewise ignores the version
    // policy). Safety: this can ONLY add a takeover, never block one — a FRESH
    // heartbeat leaves the abort exactly as the quadrant decided, and an ABSENT or
    // unparseable `last_heartbeat` is NEVER stale (`isStaleEntry` returns false), so
    // pre-DR-031 entries and heartbeat-disabled-but-live instances take the
    // unchanged path. A genuinely-live instance keeps its heartbeat fresh (it beats
    // every cadence) and registration itself writes no heartbeat — so the only way
    // to be stale here is to have beaten once and then stopped (the ungraceful
    // death this backstops). The TTL slack (3× the 5-min cadence) prevents a
    // healthy-but-briefly-unlucky instance from being judged stale.
    if (isStaleEntry(existing, DEFAULT_REGISTRY_TTL_MS, Date.now())) {
      logger.warn('collision_check', {
        result: 'takeover_stale_heartbeat',
        agent: name,
        prior_basis: basis,
        incoming_version: incomingVersion,
        existing_version: existingVersion,
        last_heartbeat: existing.last_heartbeat ?? null,
        host: existing.host,
        port: existing.port,
      });
      return { action: 'takeover', previous: existing };
    }

    return { action: 'abort', existing };
  }

  logger.info('collision_check', {
    result: 'takeover',
    agent: name,
    previous_instance: existing.instance_id,
  });
  return { action: 'takeover', previous: existing };
}
