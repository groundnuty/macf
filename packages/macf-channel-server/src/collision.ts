import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AgentInfo, Registry } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';
import { MacfError, compareSemver } from '@groundnuty/macf-core';

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

const HEALTH_PING_TIMEOUT_MS = 5000;

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
 * `/health` (dead → takeover regardless):
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

  logger.info('collision_check', {
    result: 'variable_exists',
    agent: name,
    host: existing.host,
    port: existing.port,
    instance_id: existing.instance_id,
  });

  const { alive, version: existingVersion } = await pingHealth(
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
    return { action: 'abort', existing };
  }

  logger.info('collision_check', {
    result: 'takeover',
    agent: name,
    previous_instance: existing.instance_id,
  });
  return { action: 'takeover', previous: existing };
}
