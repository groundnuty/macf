/**
 * `macf routing probe` — an end-to-end routing probe that asserts delivery
 * from EVIDENCE, never from a workflow run's conclusion.
 *
 * Why the conclusion is not evidence: the router run concludes `success`
 * both when a mention is delivered and when it is silently dropped (the
 * single-agent-config shape in `silent-fallback-hazards.md` Instance 18),
 * and a self-route skip is green too. So this probe posts ONE clearly
 * labelled probe, finds the router run that event triggered, reads that
 * run's LOG for the routed line naming the recipient, and — when the
 * receiver lives on this host — reads the receiver's own channel log for a
 * `notify_received` after the post time. Each stage is reported separately,
 * so every gap prints in one pass.
 *
 * Matching the run to the probe: the router never echoes our correlation
 * token, so a run is matched by (workflow, triggering event type, created at
 * or after the post time). If several runs qualify, the one whose log names
 * the probe's issue number is chosen; if that still is not exactly one, the
 * verdict is `unknown` (ambiguous) — never a guess.
 *
 * Receiver log: resolved from the receiver's IDENTITY
 * (`<state>/macf/<project>@<agent-name>/channel.log`, or an explicit path),
 * never by scanning the host (Instance 20). A missing file means the
 * receiver is not on this host: reported as not verifiable, never a pass.
 */

import { randomBytes } from 'node:crypto';
import { generateToken } from '@groundnuty/macf-core';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import { createRoutingConfigGhReader } from './routing-doctor-gh.js';
import {
  createProbePoster,
  createProbeRunLister,
  createRunLogReader,
  readLocalLog,
  receiverLogPathFor,
} from './routing-probe-gh.js';

export type ProbeMode = 'mention' | 'label';

export type ProbeVerdict =
  | 'delivered'
  | 'routed-but-not-received'
  | 'not-routed'
  | 'router-failed'
  | 'no-run'
  | 'self-route'
  | 'unknown';

export type StageStatus = 'ok' | 'gap' | 'unknown' | 'skipped';

export interface ProbeStage {
  readonly name: 'post' | 'router-run' | 'routed-line' | 'receiver';
  readonly status: StageStatus;
  readonly detail: string;
}

export interface ProbeResult {
  readonly verdict: ProbeVerdict;
  readonly summary: string;
  readonly stages: readonly ProbeStage[];
  /** Every gap found, in one pass (quoted router errors, receiver caveats, ...). */
  readonly gaps: readonly string[];
  readonly postedAt: string | null;
  readonly probeUrl: string | null;
  readonly runUrl: string | null;
  readonly token: string;
}

export interface ProbeRun {
  readonly id: number;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly url: string;
  readonly createdAt: string;
}

export type PostResult =
  | { readonly ok: true; readonly issueNumber: number; readonly url: string }
  | { readonly ok: false; readonly error: string };

export type TextRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly error: string };

export interface ProbePostSpec {
  readonly repo: string;
  readonly mode: ProbeMode;
  readonly label: string;
  readonly botLogin: string | null;
  readonly issue: number | null;
  readonly token: string;
}

export interface ProbeDeps {
  readonly invokerLabel: string | null;
  readonly readTargetRoutingConfig: (
    repo: string,
  ) => Promise<{ readonly agents: Readonly<Record<string, { readonly app_name?: string }>> } | null>;
  readonly post: (spec: ProbePostSpec) => Promise<PostResult>;
  readonly listRuns: (
    repo: string,
    event: 'issues' | 'issue_comment',
    sinceIso: string,
  ) => Promise<readonly ProbeRun[]>;
  readonly readRunLog: (repo: string, runId: number) => Promise<TextRead>;
  /** Receiver channel-log path derived from identity; null when identity is unknown. */
  readonly receiverLogPath: (agentName: string | null) => string | null;
  readonly readReceiverLog: (path: string) => Promise<TextRead>;
  readonly newToken: () => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface ProbeOptions {
  readonly targetRepo: string;
  readonly recipient: string;
  readonly mode: ProbeMode;
  readonly issue?: number;
  readonly receiverLog?: string;
  readonly timeoutSec?: number;
  readonly pollIntervalMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_SEC = 180;
const SKEW_MS = 5_000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Router-error lines in a run log (`##[error]` as the CLI renders them, or raw `::error`). */
export function extractErrorLines(log: string): readonly string[] {
  const out: string[] = [];
  for (const line of log.split('\n')) {
    const m = /(?:##\[error\]|::error(?:\s[^:]*)?::)\s*(.+)$/.exec(line);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/** The routed line naming the recipient, or null. */
export function findRoutedLine(log: string, recipient: string): string | null {
  const re = new RegExp(
    `Routed (?:issue|mention|pr|pull request|review)\\b[^\\n]*?\\bto ${escapeRe(recipient)}\\b[^\\n]*`,
    'i',
  );
  const m = re.exec(log);
  return m ? m[0].trim() : null;
}

export function findSelfRouteLine(log: string): string | null {
  const m = /[^\n]*skipping self-routing[^\n]*/i.exec(log);
  return m ? m[0].trim() : null;
}

/** First `notify_received` of the expected type at/after `sinceMs`, or null. */
export function findNotifyReceived(
  log: string,
  expectedType: string,
  issue: number,
  sinceMs: number,
): { readonly ts: string } | null {
  for (const line of log.split('\n')) {
    if (!line.includes('notify_received')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj['event'] !== 'notify_received' && obj['msg'] !== 'notify_received') continue;
    const ts = typeof obj['ts'] === 'string' ? Date.parse(obj['ts']) : NaN;
    if (Number.isNaN(ts) || ts < sinceMs - SKEW_MS) continue;
    if (obj['type'] !== expectedType) continue;
    if (obj['issue'] !== undefined && obj['issue'] !== issue) continue;
    return { ts: obj['ts'] as string };
  }
  return null;
}

function stage(name: ProbeStage['name'], status: StageStatus, detail: string): ProbeStage {
  return { name, status, detail };
}

type Base = Pick<ProbeResult, 'token' | 'postedAt' | 'probeUrl' | 'runUrl'>;

function result(
  base: Base,
  verdict: ProbeVerdict,
  summary: string,
  stages: readonly ProbeStage[],
  gaps: readonly string[],
): ProbeResult {
  return { ...base, verdict, summary, stages, gaps };
}

interface RunPick {
  readonly run: ProbeRun | null;
  readonly log: string | null;
  readonly problem: string | null;
}

async function pickRun(
  deps: ProbeDeps,
  repo: string,
  event: 'issues' | 'issue_comment',
  sinceIso: string,
  issue: number,
  maxPolls: number,
  intervalMs: number,
): Promise<RunPick> {
  let last: readonly ProbeRun[] = [];
  for (let i = 0; i < maxPolls; i++) {
    last = await deps.listRuns(repo, event, sinceIso);
    if (last.length > 0 && last.every((r) => r.status === 'completed')) break;
    if (i < maxPolls - 1) await deps.sleep(intervalMs);
  }
  if (last.length === 0) return { run: null, log: null, problem: null };
  const unfinished = last.filter((r) => r.status !== 'completed');
  if (unfinished.length > 0) {
    return { run: unfinished[0] ?? null, log: null, problem: 'the router run had not finished when the wait ended' };
  }
  const logs: { run: ProbeRun; text: string }[] = [];
  for (const r of last) {
    const l = await deps.readRunLog(repo, r.id);
    if (l.kind !== 'ok') {
      const why = l.kind === 'error' ? `: ${l.error}` : '';
      return { run: r, log: null, problem: `the router run log could not be read${why}` };
    }
    logs.push({ run: r, text: l.text });
  }
  if (logs.length === 1 && logs[0]) return { run: logs[0].run, log: logs[0].text, problem: null };
  const named = logs.filter((l) => l.text.includes(`#${String(issue)}`));
  if (named.length === 1 && named[0]) return { run: named[0].run, log: named[0].text, problem: null };
  return {
    run: last[0] ?? null,
    log: null,
    problem: `${String(last.length)} router runs match the post window and the probe cannot tell which one it triggered`,
  };
}

async function judgeRun(
  deps: ProbeDeps,
  opts: ProbeOptions,
  base: Base,
  stages: ProbeStage[],
  run: ProbeRun,
  log: string,
  agentName: string | null,
  issueNumber: number,
  postedMs: number,
): Promise<ProbeResult> {
  const routed = findRoutedLine(log, opts.recipient);
  const errors = extractErrorLines(log).map((e) => `router error: ${e}`);
  stages.push(
    stage('router-run', 'ok', `${run.url} (conclusion ${run.conclusion ?? 'none'}; not used as evidence)`),
  );

  if (!routed) {
    stages.push(
      stage('routed-line', 'gap', `no routed line for ${opts.recipient} in the run log`),
      stage('receiver', 'skipped', 'nothing was routed'),
    );
    const failed = errors.length > 0 || (run.conclusion !== null && run.conclusion !== 'success');
    if (failed) {
      const gaps = errors.length > 0 ? errors : [`router run concluded ${run.conclusion ?? 'unknown'} with no error line`];
      return result(base, 'router-failed', `the router failed before routing: ${gaps[0] ?? ''}`, stages, gaps);
    }
    const skip = findSelfRouteLine(log);
    if (skip) {
      return result(base, 'self-route', `the router skipped this as a self-route (${skip}); nothing was delivered`, stages, [skip]);
    }
    const g = `the router run finished green but logged no routed line for ${opts.recipient}`;
    return result(base, 'not-routed', g, stages, [g]);
  }

  const http = /HTTP (\d{3})/.exec(routed)?.[1];
  if (http && !http.startsWith('2')) {
    stages.push(
      stage('routed-line', 'gap', `the routed line reports HTTP ${http}: ${routed}`),
      stage('receiver', 'skipped', 'the router delivery POST was refused'),
    );
    return result(base, 'router-failed', `the router delivery POST was refused (HTTP ${http})`, stages, [routed, ...errors]);
  }
  stages.push(stage('routed-line', 'ok', routed));

  const logPath = opts.receiverLog ?? deps.receiverLogPath(agentName);
  const rl: TextRead = logPath ? await deps.readReceiverLog(logPath) : { kind: 'absent' };
  if (rl.kind !== 'ok') {
    const s =
      rl.kind === 'error'
        ? `the receiver channel log could not be read: ${rl.error}`
        : `routed, but delivery is not verifiable from this host (no receiver channel log${logPath ? ` at ${logPath}` : ' resolvable from its identity'})`;
    stages.push(stage('receiver', 'unknown', s));
    return result(base, 'unknown', s, stages, [s]);
  }
  const expectedType = opts.mode === 'label' ? 'issue_routed' : 'mention';
  const seen = findNotifyReceived(rl.text, expectedType, issueNumber, postedMs);
  if (!seen) {
    const s = `routed to ${opts.recipient}, but its channel log shows no ${expectedType} receipt after the post`;
    stages.push(stage('receiver', 'gap', s));
    return result(base, 'routed-but-not-received', s, stages, [s]);
  }
  stages.push(stage('receiver', 'ok', `notify_received (${expectedType}) at ${seen.ts}`));
  return result(base, 'delivered', `delivered to ${opts.recipient}: routed line and receiver receipt both present`, stages, []);
}

export async function runRoutingProbeCore(deps: ProbeDeps, opts: ProbeOptions): Promise<ProbeResult> {
  const token = deps.newToken();
  const base: Base = { token, postedAt: null, probeUrl: null, runUrl: null };
  const refuse = (why: string): ProbeResult =>
    result(base, 'unknown', `nothing was posted: ${why}`, [stage('post', 'unknown', `refused before posting: ${why}`)], [why]);

  if (opts.mode === 'mention' && !opts.issue) return refuse('mention mode needs an existing issue to comment on');
  const cfg = await deps.readTargetRoutingConfig(opts.targetRepo);
  const entry = cfg?.agents[opts.recipient];
  if (!entry) return refuse(`${opts.recipient} is not in the target repo's routing table, or the table could not be read`);
  if (deps.invokerLabel !== null && deps.invokerLabel === opts.recipient) {
    return refuse('the recipient is the invoking agent; the router skips self-routing, so no delivery can be probed');
  }
  const botLogin = entry.app_name ?? null;
  if (opts.mode === 'mention' && !botLogin) return refuse(`no bot identity is configured for ${opts.recipient}`);

  const posted = await deps.post({
    repo: opts.targetRepo,
    mode: opts.mode,
    label: opts.recipient,
    botLogin,
    issue: opts.issue ?? null,
    token,
  });
  if (!posted.ok) {
    return result(base, 'unknown', `the probe could not be posted: ${posted.error}`, [stage('post', 'unknown', posted.error)], [`post failed: ${posted.error}`]);
  }
  const postedMs = deps.now();
  const withPost: Base = { ...base, postedAt: new Date(postedMs).toISOString(), probeUrl: posted.url };
  const stages: ProbeStage[] = [stage('post', 'ok', `one ${opts.mode} probe posted: ${posted.url}`)];

  const timeoutSec = opts.timeoutSec ?? DEFAULT_PROBE_TIMEOUT_SEC;
  const intervalMs = opts.pollIntervalMs ?? 10_000;
  const maxPolls = Math.max(1, Math.ceil((timeoutSec * 1000) / Math.max(1, intervalMs)));
  const event = opts.mode === 'label' ? 'issues' : 'issue_comment';
  const since = new Date(postedMs - SKEW_MS).toISOString();
  const pick = await pickRun(deps, opts.targetRepo, event, since, posted.issueNumber, maxPolls, intervalMs);

  if (!pick.run) {
    const s = `no router run started within ${String(timeoutSec)}s of the post`;
    stages.push(
      stage('router-run', 'gap', s),
      stage('routed-line', 'skipped', 'no run to read'),
      stage('receiver', 'skipped', 'nothing was routed'),
    );
    return result(withPost, 'no-run', s, stages, [s]);
  }
  const withRun: Base = { ...withPost, runUrl: pick.run.url };
  if (pick.log === null) {
    const s = pick.problem ?? 'the router run could not be evaluated';
    stages.push(
      stage('router-run', 'unknown', s),
      stage('routed-line', 'unknown', 'run log unavailable'),
      stage('receiver', 'skipped', 'not evaluated'),
    );
    return result(withRun, 'unknown', s, stages, [s]);
  }
  return judgeRun(deps, opts, withRun, stages, pick.run, pick.log, entry.app_name ?? null, posted.issueNumber, postedMs);
}

export function formatProbeText(r: ProbeResult, repo: string): string {
  const lines = [`macf routing probe — ${repo}`, '', `verdict: ${r.verdict}`, r.summary, ''];
  for (const s of r.stages) lines.push(`  [${s.status}] ${s.name}: ${s.detail}`);
  if (r.gaps.length > 0) {
    lines.push('', 'gaps:');
    for (const g of r.gaps) lines.push(`  - ${g}`);
  }
  lines.push('', `probe correlation token: ${r.token}`);
  return lines.join('\n');
}

export const ROUTING_PROBE_JSON_SCHEMA_VERSION = 1;

export function probeToJson(r: ProbeResult): unknown {
  return { schema_version: ROUTING_PROBE_JSON_SCHEMA_VERSION, ...r };
}

export interface RunRoutingProbeCliOptions extends ProbeOptions {
  readonly json?: boolean;
  /** The receiver's project, for its log path (defaults to this workspace's project). */
  readonly receiverProject?: string;
}

/** Production entry point; returns the exit code (0 only for `delivered`). */
export async function runRoutingProbe(
  projectDir: string,
  opts: RunRoutingProbeCliOptions,
  injected?: ProbeDeps,
): Promise<number> {
  let deps = injected;
  if (!deps) {
    const config = readAgentConfig(projectDir);
    if (!config) {
      console.error('No macf-agent.json found. Run `macf init` first.');
      return 1;
    }
    const token = await generateToken(tokenSourceFromConfig(projectDir, config));
    const project = opts.receiverProject ?? config.project;
    deps = {
      invokerLabel: config.routing_label ?? config.agent_name ?? null,
      readTargetRoutingConfig: createRoutingConfigGhReader(token),
      post: createProbePoster(token),
      listRuns: createProbeRunLister(token),
      readRunLog: createRunLogReader(token),
      receiverLogPath: (name) => receiverLogPathFor(project, name),
      readReceiverLog: readLocalLog,
      newToken: () => `macf-probe-${randomBytes(6).toString('hex')}`,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
  }
  const result = await runRoutingProbeCore(deps, opts);
  console.log(opts.json ? JSON.stringify(probeToJson(result), null, 2) : formatProbeText(result, opts.targetRepo));
  return result.verdict === 'delivered' ? 0 : 1;
}
