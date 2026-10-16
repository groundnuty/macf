// Real router-run logs captured from the first cross-agent round on
// macf-experiment/macf-trial-control (2026-10-16), trimmed to the lines the
// probe's evidence functions read. The synthetic fixtures elsewhere were
// written before anyone had seen a real log; these pin the real shapes.
import { describe, it, expect } from 'vitest';
import { findRoutedLine, logNamesIssue, findSelfRouteLine, findNotifyReceived } from '../../src/cli/commands/routing-e2e-evidence.js';

const LABEL_RUN = [
  'route / route-by-label\tUNKNOWN STEP\t2026-10-16T11:56:01.3425475Z   ISSUE_NUMBER: 3',
  'route / route-by-label\tUNKNOWN STEP\t2026-10-16T11:56:06.4179142Z Routed issue #3 to science-agent via mTLS POST (HTTP 200)',
].join('\n');
const MENTION_RUN = [
  'route / route-by-mention\tUNKNOWN STEP\t2026-10-16T11:57:57.5003409Z   ISSUE_NUMBER: 3',
  'route / route-by-mention\tUNKNOWN STEP\t2026-10-16T11:58:03.8163194Z Routed mention to code-agent via mTLS POST',
].join('\n');
const SELF_ROUTE_RUN = 'route / route-by-label\tUNKNOWN STEP\t2026-10-16T00:50:51.3801867Z Actor is the same agent, skipping self-routing';
const CHANNEL_LOG = [
  '{"ts":"2026-10-16T11:57:58.877Z","level":"info","event":"notify_received","type":"mention","issue":3}',
  '{"ts":"2026-10-16T11:58:03.711Z","level":"info","event":"tmux_wake_delivered","target":"%200","prompt_length":142}',
].join('\n');

describe('evidence functions against real router logs (2026-10-16)', () => {
  it('the real label-mode receipt (type issue_routed) is found for the label probe', () => {
    const scienceLog = '{"ts":"2026-10-16T11:56:02.065Z","level":"info","event":"notify_received","type":"issue_routed","issue":3}';
    expect(findNotifyReceived(scienceLog, 'issue_routed', 3, Date.parse('2026-10-16T11:55:32Z'))).toEqual({ ts: '2026-10-16T11:56:02.065Z' });
  });
  it('finds the routed line in a real label run and a real mention run', () => {
    expect(findRoutedLine(LABEL_RUN, 'science-agent')).toContain('Routed issue #3 to science-agent');
    expect(findRoutedLine(MENTION_RUN, 'code-agent')).toContain('Routed mention to code-agent');
  });
  it('a real routed line for one recipient is not taken as routed to another', () => {
    expect(findRoutedLine(LABEL_RUN, 'code-agent')).toBeNull();
  });
  it('both real runs name their issue (env block ISSUE_NUMBER), and not a different one', () => {
    expect(logNamesIssue(LABEL_RUN, 3)).toBe(true);
    expect(logNamesIssue(MENTION_RUN, 3)).toBe(true);
    expect(logNamesIssue(MENTION_RUN, 30)).toBe(false);
    expect(logNamesIssue(MENTION_RUN, 4)).toBe(false);
  });
  it('the real self-route skip line is recognised', () => {
    expect(findSelfRouteLine(SELF_ROUTE_RUN)).toContain('skipping self-routing');
  });
  it('the real channel-log receipt for the mention is found after the post, not before', () => {
    expect(findNotifyReceived(CHANNEL_LOG, 'mention', 3, Date.parse('2026-10-16T11:57:30Z'))).toEqual({ ts: '2026-10-16T11:57:58.877Z' });
    expect(findNotifyReceived(CHANNEL_LOG, 'mention', 3, Date.parse('2026-10-16T11:59:00Z'))).toBeNull();
    expect(findNotifyReceived(CHANNEL_LOG, 'issue_routed', 3, Date.parse('2026-10-16T11:57:30Z'))).toBeNull();
  });
});
