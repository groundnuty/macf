/** CLI-text fixes from the setup review: runner-token wording, secrets-file mode, widen count. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerTokenHowTo, noRunnerTokenReason, noUsableRunnerWithoutTokenReason } from '../../../src/cli/bootstrap/apply-routing.js';
import { writeOperatorSecretsFileTemplate, operatorSecretsFileTemplate } from '../../../src/cli/bootstrap/operator-secrets-file.js';
import { formatOperatorInteractionLine, installScopeWidenApps, operatorInteractionBudget } from '../../../src/cli/bootstrap/plan.js';
import type { PlanItem } from '../../../src/cli/bootstrap/plan.js';
import { formatPlannedAppCreations } from '../../../src/cli/commands/bootstrap-apply.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runnerTokenHowTo', () => {
  it('org: the org endpoint only', () => {
    const t = runnerTokenHowTo('org');
    expect(t).toContain('/orgs/<org>/actions/runners/registration-token');
    expect(t).not.toContain('/repos/');
  });
  it('user: the per-repo endpoint only', () => {
    const t = runnerTokenHowTo('user', 'me/x');
    expect(t).toContain('/repos/me/x/actions/runners/registration-token');
    expect(t).not.toContain('/orgs/');
  });
  it('unknown: both forms', () => {
    const t = runnerTokenHowTo();
    expect(t).toContain('/orgs/<org>/');
    expect(t).toContain('/repos/<owner>/<repo>/');
  });
  it('the refusal texts branch on owner type', () => {
    expect(noRunnerTokenReason('user')).not.toContain('/orgs/');
    expect(noRunnerTokenReason('org')).not.toContain('/repos/');
    const absent = { presence: 'absent' } as const;
    expect(noUsableRunnerWithoutTokenReason('me/x', absent, false, 'user')).toContain('/repos/me/x/actions');
    expect(noUsableRunnerWithoutTokenReason('o/x', absent, false, 'org')).not.toContain('/repos/o/x');
  });
});

describe('secrets.env mode', () => {
  it('is written 0600, and an existing wide file is tightened', () => {
    const d = mkdtempSync(join(tmpdir(), 'macf-clitext-'));
    dirs.push(d);
    const p = join(d, 'secrets.env');
    writeOperatorSecretsFileTemplate(p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    chmodSync(p, 0o644);
    writeOperatorSecretsFileTemplate(p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    writeFileSync(p, operatorSecretsFileTemplate());
  });
});

describe('widen count', () => {
  const item = (target: string): PlanItem => ({ kind: 'install_scope', target, verb: 'update', reason: 'r', confirm_required: true });
  it('counts a runner-ops-only widen in the interaction line', () => {
    const apps = installScopeWidenApps([item('runner-ops:install_scope:f-runner-ops')]);
    expect(apps).toEqual(['f-runner-ops']);
    const line = formatOperatorInteractionLine(operatorInteractionBudget(0), apps);
    expect(line).not.toContain('no consent gates');
    expect(line).toContain('f-runner-ops');
  });
  it('the apply preview line counts it too', () => {
    const out = formatPlannedAppCreations([], 0, [], ['f-runner-ops']);
    expect(out).not.toContain('no consent gates');
    expect(out).toContain('f-runner-ops');
  });
});
