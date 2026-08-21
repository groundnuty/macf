/**
 * `macf registry prune` — confirm-before-destroy registry maintenance (macf#556).
 *
 * Root hazard: a blind registry `DELETE` orphaned LIVE channel servers. This
 * command mTLS-`/health`-checks each `MACF_AGENT_*` entry and removes ONLY
 * confirmed-dead ones — and only after explicit operator consent (default No;
 * `--yes` bypasses for automation). "Confirmed dead" means the probe failed
 * across a brief retry: a single flaky read NEVER removes an entry.
 *
 * Reuses the existing building blocks: the mTLS `/health` ping
 * (`pingAgentHealth`), the registry list/remove surface
 * (`createRegistryFromConfig`), the CA-cert read (`createClientFromConfig`),
 * and the consent-prompt pattern from `doctor.ts`.
 */
import { createInterface } from 'node:readline';
import {
  readAgentConfig,
  tokenSourceFromConfig,
  agentCertPath,
  agentKeyPath,
} from '../config.js';
import { createClientFromConfig } from '../registry-helper.js';
import {
  createRegistryFromConfig,
  generateToken,
  pingAgentHealth,
  toVariableSegment,
  isStaleEntry,
  DEFAULT_REGISTRY_TTL_MS,
} from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';

/** A registry entry's liveness verdict. `alive` = keep, `dead` = remove. */
export type PruneVerdict = 'alive' | 'dead';

/**
 * Why an entry got its verdict — surfaced in the report so the operator sees the
 * basis before consenting (DR-031, groundnuty/macf#568):
 *  - `'responding'`      — a /health probe answered → keep (a successful probe
 *                          ALWAYS means alive, regardless of heartbeat state).
 *  - `'recent-heartbeat'`— probes failed BUT `last_heartbeat` is fresh (< TTL) →
 *                          keep; the instance beat within the TTL, so an
 *                          unreachable /health is treated as a transient blip.
 *  - `'stale-heartbeat'` — probes failed AND `last_heartbeat` aged past the TTL →
 *                          remove; the stale beat reinforces the dead verdict.
 *  - `'unreachable'`     — probes failed AND there is no heartbeat data (pre-DR-031
 *                          or heartbeat-disabled) → remove (the legacy verdict).
 */
export type PruneReason =
  | 'responding'
  | 'recent-heartbeat'
  | 'stale-heartbeat'
  | 'unreachable';

/** One classified registry entry. */
export interface PruneEntry {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly verdict: PruneVerdict;
  readonly reason: PruneReason;
}

/** Probe a single endpoint's `/health` — returns the body or null on failure. */
export type ProbeFn = (host: string, port: number) => Promise<HealthResponse | null>;

/** Options governing the liveness classification. */
export interface ClassifyOptions {
  /** Extra probe attempts after the first failure (default 1 → 2 total). */
  readonly retries?: number;
  /** Delay between attempts in ms (default 0; the CLI uses a brief pause). */
  readonly delayMs?: number;
  /**
   * Staleness TTL in ms for the DR-031 heartbeat signal (default
   * `DEFAULT_REGISTRY_TTL_MS` = 15 min). An entry with a `last_heartbeat` older
   * than this is treated as a (reinforcing) dead-signal.
   */
  readonly ttlMs?: number;
  /** Injectable epoch-ms clock for deterministic staleness tests (default `Date.now()`). */
  readonly now?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Classify each peer as alive (keep) / dead (remove) via `probe`, with the
 * DR-031 (groundnuty/macf#568) registry-heartbeat staleness as a COMPLEMENTARY
 * dead-signal. A peer is removed only when:
 *
 *   dead = (ALL liveness probes fail) AND (isStaleEntry OR no-heartbeat-data)
 *
 * Two conservative invariants fall out of that formula:
 *  - A SUCCESSFUL probe ALWAYS means alive — a responding agent is NEVER pruned,
 *    regardless of a stale heartbeat (a fresh process may not have beaten yet).
 *  - A FRESH heartbeat (beat within the TTL) keeps an entry even when /health is
 *    momentarily unreachable — the recent beat is a second, independent liveness
 *    signal that guards against pruning on a transient probe blip.
 * A stale heartbeat only ever REINFORCES the dead verdict an unreachable probe
 * already reaches (it never overrides a live probe). Entries with no
 * `last_heartbeat` (pre-DR-031 / heartbeat-disabled) keep the legacy
 * "dead iff all probes fail" behavior, since `isStaleEntry` is false for absence.
 *
 * PURE w.r.t. `probe`, `ttlMs`, and `now` — tests inject fakes. The probe retry
 * is the "never remove on a single flaky read" guard.
 */
export async function classifyEntries(
  peers: readonly { readonly name: string; readonly info: AgentInfo }[],
  probe: ProbeFn,
  opts?: ClassifyOptions,
): Promise<readonly PruneEntry[]> {
  const retries = opts?.retries ?? 1;
  const delayMs = opts?.delayMs ?? 0;
  const ttlMs = opts?.ttlMs ?? DEFAULT_REGISTRY_TTL_MS;
  const now = opts?.now ?? Date.now();
  const results: PruneEntry[] = [];
  for (const peer of peers) {
    let probeAlive = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const health = await probe(peer.info.host, peer.info.port);
      if (health) {
        probeAlive = true;
        break;
      }
      if (attempt < retries) await sleep(delayMs);
    }
    const stale = isStaleEntry(peer.info, ttlMs, now);
    const hasHeartbeat = peer.info.last_heartbeat !== undefined;
    // dead = !probeAlive && (stale || !hasHeartbeat). A live probe wins always;
    // a fresh heartbeat keeps an unreachable entry; absence keeps legacy behavior.
    let reason: PruneReason;
    if (probeAlive) reason = 'responding';
    else if (stale) reason = 'stale-heartbeat';
    else if (!hasHeartbeat) reason = 'unreachable';
    else reason = 'recent-heartbeat';
    const verdict: PruneVerdict =
      reason === 'responding' || reason === 'recent-heartbeat' ? 'alive' : 'dead';
    results.push({
      name: peer.name,
      host: peer.info.host,
      port: peer.info.port,
      verdict,
      reason,
    });
  }
  return results;
}

/** Format a verdict line for the report (pure — exported for tests). */
export function formatVerdictLine(e: PruneEntry): string {
  const where = `${e.host}:${e.port}`;
  const note: string =
    e.reason === 'responding'
      ? 'alive → keep'
      : e.reason === 'recent-heartbeat'
        ? 'unreachable but heartbeat fresh → keep'
        : e.reason === 'stale-heartbeat'
          ? 'confirmed-dead (heartbeat stale) → remove'
          : 'confirmed-dead → remove';
  const glyph = e.verdict === 'alive' ? '✓' : '✗';
  return `  ${glyph} ${e.name.padEnd(28)} ${where.padEnd(24)} ${note}`;
}

/** Prompt the operator for a y/N confirmation on stdin. Default = No. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Options for `runRegistryPrune`. */
export interface RunRegistryPruneOptions {
  /** Skip the confirmation prompt (non-interactive). */
  readonly yes?: boolean;
}

/**
 * `macf registry prune` entry point. Returns the shell exit code. Lists the
 * registry, probes each entry over mTLS (with retry), prints per-entry
 * verdicts, then removes ONLY confirmed-dead entries after consent.
 */
export async function runRegistryPrune(
  projectDir: string,
  opts?: RunRegistryPruneOptions,
): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }
  if (config.registry.type === 'local') {
    console.error(
      'registry prune targets GitHub-backed registries; local-registry mode ' +
        'is not supported. Edit the local JSON registry file directly.',
    );
    return 1;
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const client = createClientFromConfig(config.registry, token);
  const caCertPem = await client.readVariable(`${toVariableSegment(config.project)}_CA_CERT`);
  if (!caCertPem) {
    console.error('CA certificate not found in registry. Run `macf certs init` first.');
    return 1;
  }

  const peers = await registry.list('');
  if (peers.length === 0) {
    console.log('No registry entries to check.');
    return 0;
  }

  const certPath = agentCertPath(projectDir);
  const keyPath = agentKeyPath(projectDir);
  const probe: ProbeFn = (host, port) =>
    pingAgentHealth({ host, port, caCertPem, certPath, keyPath });

  console.log(`Probing ${peers.length} registry entr${peers.length === 1 ? 'y' : 'ies'} via mTLS /health …\n`);
  const results = await classifyEntries(peers, probe, { retries: 1, delayMs: 750 });
  for (const e of results) console.log(formatVerdictLine(e));

  const dead = results.filter((e) => e.verdict === 'dead');
  if (dead.length === 0) {
    console.log('\nAll entries responded — nothing to prune.');
    return 0;
  }

  console.log(`\n${dead.length} confirmed-dead entr${dead.length === 1 ? 'y' : 'ies'} would be REMOVED:`);
  for (const e of dead) {
    const why = e.reason === 'stale-heartbeat' ? ' (heartbeat stale)' : '';
    console.log(`  - ${e.name}${why}`);
  }

  const consent = opts?.yes ? true : await promptYesNo('\nRemove these registry entries?');
  if (!consent) {
    console.log('Aborted — no entries removed.');
    return 0;
  }

  for (const e of dead) {
    await registry.remove(e.name);
    console.log(`  removed ${e.name}`);
  }
  console.log(`\nPruned ${dead.length} dead registry entr${dead.length === 1 ? 'y' : 'ies'}.`);
  return 0;
}
