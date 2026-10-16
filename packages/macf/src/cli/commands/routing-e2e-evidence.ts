/**
 * Evidence judging for `macf routing doctor --e2e` — pure, no I/O.
 *
 * A router run concludes `success` both when a message is delivered and when
 * it is silently dropped, and a self-route skip is green too, so the run's
 * conclusion is NEVER used to decide delivery. Delivery is asserted from
 * three pieces of evidence: the router run LOG carries the routed line for
 * the recipient, and the receiver recorded a receipt (its channel log, or
 * the health endpoint's recorded issue). A receiver log that is not on this
 * host is "not verifiable", never a pass.
 */

export type EvidenceVerdict =
  | 'delivered'
  | 'routed-but-not-received'
  | 'not-routed'
  | 'router-failed'
  | 'no-run'
  | 'self-route'
  | 'unknown';

export type StageStatus = 'ok' | 'gap' | 'unknown' | 'skipped';

export interface EvidenceStage {
  readonly name: 'post' | 'router-run' | 'routed-line' | 'receiver';
  readonly status: StageStatus;
  readonly detail: string;
}

export type TextRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly error: string };

export interface EvidenceVerdictResult {
  readonly verdict: EvidenceVerdict;
  readonly summary: string;
  readonly stages: readonly EvidenceStage[];
  /** Every gap, collected in one pass (quoted router errors, receiver caveats). */
  readonly gaps: readonly string[];
}

export interface EvidenceInput {
  readonly mode: 'label' | 'mention';
  readonly recipient: string;
  readonly issueNumber: number;
  readonly postedMs: number;
  readonly run: {
    readonly found: boolean;
    readonly status: string | null;
    readonly conclusion: string | null;
    readonly url: string | null;
  };
  /** The router run's log; null when it could not be obtained. */
  readonly runLog: TextRead | null;
  /** Health endpoint recorded the probe issue (label mode only). */
  readonly healthReceipt: boolean;
  readonly everReachable: boolean;
  readonly receiverLog: TextRead;
  readonly receiverLogPath: string | null;
  /** Set when several runs started in the window and none could be singled out. */
  readonly ambiguousRuns?: number;
}

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
    `Routed (?:issue|mention|pr|pull request|review)\\b[^\\n]*?\\bto ${escapeRe(recipient)}(?![\\w-])[^\\n]*`,
    'i',
  );
  const m = re.exec(log);
  return m ? m[0].trim() : null;
}

export function findSelfRouteLine(log: string): string | null {
  const m = /[^\n]*skipping self-routing[^\n]*/i.exec(log);
  return m ? m[0].trim() : null;
}

/** First `notify_received` of the expected type and issue at/after the post, or null. */
export function findNotifyReceived(
  log: string,
  expectedType: string,
  issue: number,
  postedMs: number,
): { readonly ts: string } | null {
  for (const line of log.split('\n')) {
    if (!line.includes('notify_received')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj['event'] !== 'notify_received') continue;
    const ts = typeof obj['ts'] === 'string' ? Date.parse(obj['ts']) : NaN;
    if (Number.isNaN(ts) || ts < postedMs - SKEW_MS) continue;
    if (obj['type'] !== expectedType) continue;
    if (obj['issue'] !== issue) continue;
    return { ts: obj['ts'] as string };
  }
  return null;
}

function st(name: EvidenceStage['name'], status: StageStatus, detail: string): EvidenceStage {
  return { name, status, detail };
}

function out(
  verdict: EvidenceVerdict,
  summary: string,
  stages: readonly EvidenceStage[],
  gaps: readonly string[],
): EvidenceVerdictResult {
  return { verdict, summary, stages, gaps };
}

/**
 * Does a router run log name this issue? Keyed on what the log reliably
 * carries: the `#N` in a routed line ("Routed issue #N to ...") or the issue
 * number in the run's env block (`ISSUE_NUMBER: N` / `issue_number: N`).
 * A bare number elsewhere never counts.
 */
export function logNamesIssue(log: string, issue: number): boolean {
  const n = String(issue);
  return new RegExp(`#${n}\\b|\\b(?:ISSUE_NUMBER|issue_number|ISSUE)\\b["']?\\s*[:=]\\s*["']?${n}\\b`, 'i').test(log);
}

export type RunSelection<R> =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly run: R; readonly log: TextRead | null }
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * Pick THE router run for the probe from every candidate. One candidate:
 * used as-is. Several: only those whose log names the probe's issue; exactly
 * one survivor is used, zero or several is ambiguous — never a guess.
 */
export function selectRun<R extends { readonly title?: string }>(
  candidates: readonly { readonly run: R; readonly log: TextRead | null }[],
  issue: number,
  probeTitle?: string,
): RunSelection<R> {
  let pool = candidates;
  if (probeTitle !== undefined) {
    // A run's display_title is its triggering issue's title on EVERY run, including ones
    // that fail before routing or skip as a self-route (their logs name no issue). A
    // titled run with another title is never the probe's, however few candidates there are.
    const untitled = candidates.filter((c) => c.run.title === undefined);
    const mine = candidates.filter((c) => c.run.title === probeTitle);
    if (untitled.length === 0 && mine.length === 0) return { kind: 'none' };
    pool = [...mine, ...untitled];
  }
  if (pool.length === 0) return { kind: 'none' };
  if (pool.length === 1 && pool[0]) return { kind: 'one', ...pool[0] };
  const named = pool.filter((c) => c.log?.kind === 'ok' && logNamesIssue(c.log.text, issue));
  if (named.length === 1 && named[0]) return { kind: 'one', ...named[0] };
  return { kind: 'ambiguous', count: pool.length };
}

export function judgeEvidence(i: EvidenceInput): EvidenceVerdictResult {
  const stages: EvidenceStage[] = [];
  if (i.ambiguousRuns !== undefined) {
    const s = `ambiguous: ${String(i.ambiguousRuns)} router runs started in the window and the log could not single out the probe's`;
    return out('unknown', s, [st('router-run', 'unknown', s), st('routed-line', 'skipped', 'no single run to read'), st('receiver', 'skipped', 'not evaluated')], [s]);
  }
  if (!i.run.found) {
    const s = 'no router run started for the probe within the wait';
    return out('no-run', s, [st('router-run', 'gap', s), st('routed-line', 'skipped', 'no run to read'), st('receiver', 'skipped', 'nothing was routed')], [s]);
  }
  if (i.runLog === null || i.runLog.kind !== 'ok' || i.run.status !== 'completed') {
    const why =
      i.run.status !== 'completed'
        ? 'the router run had not finished when the wait ended'
        : i.runLog?.kind === 'error'
          ? `the router run log could not be read: ${i.runLog.error}`
          : 'the router run log could not be read';
    return out('unknown', why, [st('router-run', 'unknown', why), st('routed-line', 'unknown', 'run log unavailable'), st('receiver', 'skipped', 'not evaluated')], [why]);
  }
  const log = i.runLog.text;
  stages.push(st('router-run', 'ok', `${i.run.url ?? '(no url)'} (conclusion ${i.run.conclusion ?? 'none'}; not used as evidence)`));

  const routed = findRoutedLine(log, i.recipient);
  const errors = extractErrorLines(log).map((e) => `router error: ${e}`);
  if (!routed) {
    stages.push(st('routed-line', 'gap', `no routed line for ${i.recipient} in the run log`), st('receiver', 'skipped', 'nothing was routed'));
    if (errors.length > 0 || (i.run.conclusion !== null && i.run.conclusion !== 'success')) {
      const gaps = errors.length > 0 ? errors : [`router run concluded ${i.run.conclusion ?? 'unknown'} with no error line`];
      return out('router-failed', `the router failed before routing: ${gaps[0] ?? ''}`, stages, gaps);
    }
    const skip = findSelfRouteLine(log);
    if (skip) return out('self-route', `the router skipped this as a self-route (${skip}); nothing was delivered`, stages, [skip]);
    const g = `the router run finished green but logged no routed line for ${i.recipient}`;
    return out('not-routed', g, stages, [g]);
  }
  const http = /HTTP (\d{3})/.exec(routed)?.[1];
  if (http && !http.startsWith('2')) {
    stages.push(st('routed-line', 'gap', `the routed line reports HTTP ${http}: ${routed}`), st('receiver', 'skipped', 'the router delivery POST was refused'));
    return out('router-failed', `the router delivery POST was refused (HTTP ${http})`, stages, [routed, ...errors]);
  }
  stages.push(st('routed-line', 'ok', routed));

  const expectedType = i.mode === 'label' ? 'issue_routed' : 'mention';
  const logHit = i.receiverLog.kind === 'ok' ? findNotifyReceived(i.receiverLog.text, expectedType, i.issueNumber, i.postedMs) : null;
  if (logHit) {
    stages.push(st('receiver', 'ok', `channel log: notify_received (${expectedType}) at ${logHit.ts}`));
    return out('delivered', `delivered to ${i.recipient}: routed line and receiver receipt both present`, stages, []);
  }
  if (i.healthReceipt) {
    stages.push(st('receiver', 'ok', 'the receiver endpoint recorded the probe issue'));
    return out('delivered', `delivered to ${i.recipient}: routed line and receiver receipt both present`, stages, []);
  }
  if (i.receiverLog.kind === 'ok' || i.everReachable) {
    const s = `routed to ${i.recipient}, but its ${i.receiverLog.kind === 'ok' ? 'channel log shows' : 'endpoint recorded'} no receipt after the post`;
    stages.push(st('receiver', 'gap', s));
    return out('routed-but-not-received', s, stages, [s]);
  }
  const s =
    i.receiverLog.kind === 'error'
      ? `the receiver channel log could not be read: ${i.receiverLog.error}`
      : `routed, but delivery is not verifiable from this host (no receiver channel log${i.receiverLogPath ? ` at ${i.receiverLogPath}` : ' resolvable from its identity'})`;
  stages.push(st('receiver', 'unknown', s));
  return out('unknown', s, stages, [s]);
}
