/**
 * `macf bootstrap preflight` CLI entry point: one report on whether this
 * machine (and the agent host) is ready for `bootstrap apply`.
 * READ-ONLY: nothing is written, no token is kept, nothing on GitHub changes.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { packageVersionDisplay } from '../../package-version.js';
import type { ExecResult, FetchResult, PreflightCheck, PreflightDeps, PreflightOptions } from '../bootstrap/preflight.js';
import { PREFLIGHT_JSON_SCHEMA_VERSION, loadManifestChecks, runLocalPreflight } from '../bootstrap/preflight.js';
import { agentHostChecks } from '../bootstrap/preflight-agent-host.js';

export interface RunBootstrapPreflightOptions extends PreflightOptions {
  readonly json?: boolean;
}

export interface PreflightReport {
  readonly ready: boolean;
  readonly toFix: number;
  readonly unknown: number;
  readonly checks: readonly PreflightCheck[];
}

export function buildReport(checks: readonly PreflightCheck[]): PreflightReport {
  const toFix = checks.filter((c) => c.status === 'missing' || c.status === 'wrong').length;
  return { ready: toFix === 0, toFix, unknown: checks.filter((c) => c.status === 'unknown').length, checks };
}

export function formatPreflightText(report: PreflightReport): string {
  const lines = report.checks.map((c) => {
    const base = `${c.status.padEnd(7)} ${c.id}: ${c.detail}`;
    return c.fix !== undefined && c.status !== 'ok' ? `${base}\n        fix: ${c.fix}` : base;
  });
  lines.push(report.ready ? 'preflight: ready' : `preflight: ${report.toFix} to fix`);
  return lines.join('\n');
}

export function preflightToJson(report: PreflightReport): Record<string, unknown> {
  return {
    schema_version: PREFLIGHT_JSON_SCHEMA_VERSION,
    ready: report.ready,
    to_fix: report.toFix,
    unknown: report.unknown,
    agent_host: report.checks.find((c) => c.id === 'agent-host')?.detail.replace(/^agents run on /, '') ?? null,
    checks: report.checks.map((c) => ({ id: c.id, group: c.group, status: c.status, detail: c.detail, ...(c.fix !== undefined ? { fix: c.fix } : {}) })),
  };
}

function realExec(cmd: string, args: readonly string[], opts?: { readonly timeoutMs?: number; readonly input?: string }): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ExecResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout, stderr: `${stderr}\ntimed out`.trim() });
    }, opts?.timeoutMs ?? 30000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: err.message, spawnFailed: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on('error', () => { /* the child exited before reading */ });
    child.stdin.end(opts?.input ?? '');
  });
}

async function realFetch(url: string, timeoutMs: number): Promise<FetchResult> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return { reached: true, status: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    return { reached: false, detail: cause ?? (err instanceof Error ? err.message : String(err)) };
  }
}

export function realPreflightDeps(): PreflightDeps {
  return {
    exec: realExec,
    fetchUrl: realFetch,
    readText: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return undefined;
      }
    },
    fileMode: (path) => (existsSync(path) ? { exists: true, mode: statSync(path).mode & 0o777 } : { exists: false }),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    cliVersion: /(\d+\.\d+\.\d+)/.exec(packageVersionDisplay())?.[1] ?? packageVersionDisplay(),
  };
}

/** The manifest's owner and fleet name, which name the watchdog script; undefined when the manifest does not parse. */
function fleetFor(deps: PreflightDeps, file: string): { owner: string; project: string } | undefined {
  const m = loadManifestChecks(deps, file).manifest;
  return m === undefined ? undefined : { owner: m.owner.account, project: m.metadata.name };
}

/** Returns the shell exit code: 0 when ready, 1 when anything is missing or wrong. Never exits the process itself. */
export async function runBootstrapPreflight(opts: RunBootstrapPreflightOptions, deps: PreflightDeps = realPreflightDeps()): Promise<number> {
  const resolved: PreflightOptions = {
    file: resolvePath(opts.file),
    ...(opts.secretsPath !== undefined ? { secretsPath: resolvePath(opts.secretsPath) } : {}),
    ...(opts.identityKeyPath !== undefined ? { identityKeyPath: resolvePath(opts.identityKeyPath) } : {}),
    ...(opts.vaultPath !== undefined ? { vaultPath: resolvePath(opts.vaultPath) } : {}),
    ...(opts.agentHost !== undefined ? { agentHost: opts.agentHost } : {}),
  };
  const [local, host] = await Promise.all([runLocalPreflight(deps, resolved), agentHostChecks(deps, resolved.agentHost, fleetFor(deps, resolved.file))]);
  const report = buildReport([...local, ...host]);
  console.log(opts.json ? JSON.stringify(preflightToJson(report), null, 2) : formatPreflightText(report));
  return report.ready ? 0 : 1;
}
