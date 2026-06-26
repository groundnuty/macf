import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { HealthResponse, HealthState } from '@groundnuty/macf-core';

function readVersion(): string {
  const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

/**
 * Parse a leaf-cert PEM and return its `notAfter` as an ISO-8601 string, or
 * `null` if the PEM can't be parsed. DR-030 §4 per-agent `cert_expiry`
 * self-report (an expired leaf = silent off-channels; thresholds — warn <30d
 * / crit <7d — are the consumer's call). Uses `node:crypto` (zero-dep):
 * `@peculiar/x509` is only needed to *create* X.509, not to read one.
 */
export function leafCertExpiry(pem: string): string | null {
  try {
    return new X509Certificate(pem).validToDate.toISOString();
  } catch {
    return null;
  }
}

/** Read a leaf cert from disk and return its expiry; `null` if unreadable. */
function readCertExpiry(certPath: string): string | null {
  try {
    return leafCertExpiry(readFileSync(certPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Optional self-report inputs for the DR-030 mesh-layer `/health` extension. */
export interface HealthStateOpts {
  /** The registration instance id (registry/health staleness disambiguator). */
  readonly instanceId?: string;
  /** Path to the agent's leaf cert, for the `cert_expiry` self-report. */
  readonly certPath?: string;
}

export function createHealthState(
  agentName: string,
  agentType: string,
  opts: HealthStateOpts = {},
): HealthState {
  const version = readVersion();
  const startTime = Date.now();
  const instanceId = opts.instanceId ?? null;
  // Read once at construction — the leaf doesn't change over a process lifetime.
  const certExpiry = opts.certPath ? readCertExpiry(opts.certPath) : null;

  let currentIssue: number | null = null;
  let lastNotification: string | null = null;

  return {
    getHealth(): HealthResponse {
      return {
        agent: agentName,
        status: 'online',
        type: agentType,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        current_issue: currentIssue,
        version,
        last_notification: lastNotification,
        instance_id: instanceId,
        cert_expiry: certExpiry,
      };
    },

    setCurrentIssue(issueNumber: number | null): void {
      currentIssue = issueNumber;
    },

    recordNotification(): void {
      lastNotification = new Date().toISOString();
    },
  };
}
