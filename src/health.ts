import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HealthResponse, HealthState } from './types.js';

function readVersion(): string {
  const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

export function createHealthState(agentName: string, agentType: string): HealthState {
  const version = readVersion();
  const startTime = Date.now();

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
