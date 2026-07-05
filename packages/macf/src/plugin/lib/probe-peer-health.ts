import { readFileSync } from 'node:fs';
import { pingAgent } from './health.js';
import type { PeerEntry } from './registry.js';
import { resolveGuestProbeCaBundle } from '@groundnuty/macf-core';
import type { GitHubVariablesClient, HealthResponse, Logger } from '@groundnuty/macf-core';

/** No-op logger for CLI/plugin probe calls — trust-bundle diagnostics aren't
 * actionable mid-listing (a single guest's probe failure just degrades that
 * guest to offline; see `GuestProbeContext` doc below). */
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * DR-041 Amendment B (federation-aware guest probe, groundnuty/macf#794):
 * extra context `probePeerHealth` needs to probe a CROSS-FLEET guest
 * (a `<project>/<name>` slug whose project differs from this agent's own)
 * rather than a same-fleet peer. Omit this parameter entirely for a
 * same-fleet peer — behavior is BYTE-IDENTICAL to pre-#794 (own CA only).
 */
export interface GuestProbeContext {
  /** The guest's home project (e.g. `ppam-2026`). */
  readonly homeProject: string;
  /** The `federated_cas` list declared in `.github/macf-fleet.json` (loaded ONCE by the caller). */
  readonly federatedCaProjects: readonly string[];
  /** Shared-registry client to resolve `<PROJECT>_CA_CERT` — `undefined` in DR-024 local mode. */
  readonly varsClient: GitHubVariablesClient | undefined;
}

/**
 * Probe a peer's `/health` endpoint over mTLS using the cert paths set by
 * `claude.sh` (MACF_CA_CERT / MACF_AGENT_CERT / MACF_AGENT_KEY env vars).
 *
 * Returns `null` when env vars are missing or CA-cert read fails — caller's
 * UI layer renders that as "offline" (matches `formatPeerTable` behaviour).
 *
 * Used by the `peers` and `status` cases in `macf-plugin-cli.ts`. The `ping`
 * case keeps its own inline copy because it has a different UX contract:
 * operator-invoked `/macf-ping` should fail loudly when env is incomplete,
 * not silently render "offline" — same reasoning extends to a guest-probe
 * trust-bundle failure there (see `macf-plugin-cli.ts`'s `ping` case, which
 * calls `resolveGuestProbeCaBundle` directly and lets it throw).
 *
 * Surfaced by macf#325 — `peers` case was previously a stub mapping every
 * peer to `health: null`, producing misleading "all offline" output even
 * when channel-servers were running. This helper is the structural fix.
 *
 * `guest`, when supplied, makes this a FEDERATION-AWARE probe (macf#794): the
 * CA bundle used for the mTLS handshake is `resolveGuestProbeCaBundle`'s
 * result (own CA + the guest's federated fleet CA, when declared) instead of
 * the own-CA-only value. A `TrustBundleError` from an unresolvable DECLARED
 * federated project is swallowed to `null` here (NOT re-thrown) — this
 * function's documented contract is "null on any failure," and a listing
 * command (`/macf-peers`, `macf fleet status`) must isolate ONE
 * misconfigured guest from crashing the whole roster (mirrors
 * `gatherGuestStatuses`'s per-guest probe isolation). A non-federated
 * `homeProject` is UNCHANGED pre-#794 behavior — probes with the own CA only.
 */
export async function probePeerHealth(
  peer: PeerEntry,
  guest?: GuestProbeContext,
): Promise<HealthResponse | null> {
  const caCertPath = process.env['MACF_CA_CERT'];
  const agentCertPath = process.env['MACF_AGENT_CERT'];
  const agentKeyPath = process.env['MACF_AGENT_KEY'];
  if (!caCertPath || !agentCertPath || !agentKeyPath) return null;
  let caCertPem: string;
  try {
    caCertPem = readFileSync(caCertPath, 'utf-8');
  } catch {
    return null;
  }

  if (guest) {
    try {
      caCertPem = await resolveGuestProbeCaBundle(
        caCertPem,
        guest.homeProject,
        guest.federatedCaProjects,
        guest.varsClient,
        silentLogger,
      );
    } catch {
      return null;
    }
  }

  return await pingAgent({
    host: peer.info.host,
    port: peer.info.port,
    caCertPem,
    certPath: agentCertPath,
    keyPath: agentKeyPath,
  });
}
