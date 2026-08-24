/**
 * Tests for `install-scope.ts` — the ONE shared post-gate-2
 * `repository_selection === 'selected'` guard every App-install gate uses
 * (groundnuty/macf#1128). Migrated + extended from the runner-ops-only /
 * router-only copies each App's own test file used to carry
 * (`apply-runner-ops.test.ts`'s `validateRunnerOpsInstall` block,
 * `apply-router-app.test.ts`'s `validateRouterAppInstall` block — both
 * removed in favor of this single suite).
 */
import { describe, it, expect } from 'vitest';
import { validateInstallRepositoryScope, buildInstallScopeValidator } from '../../../src/cli/bootstrap/install-scope.js';
import type { ConfirmedInstall } from '../../../src/cli/bootstrap/identity-confirm.js';

describe('validateInstallRepositoryScope — repository_selection scoped to only the repos an App needs, NEVER "all"', () => {
  it('accepts "selected" — the only passing shape', () => {
    expect(validateInstallRepositoryScope('selected', 'demo-fleet-code-agent')).toBeUndefined();
  });

  it('REFUSES "all" — the exact hazard the task brief names', () => {
    const reason = validateInstallRepositoryScope('all', 'demo-fleet-code-agent');
    expect(reason).toBeDefined();
    expect(reason).toMatch(/repository_selection must be "selected"/);
    expect(reason).toMatch(/"all"/);
  });

  it('REFUSES a missing repository_selection (fails CLOSED, not merely "not all")', () => {
    const reason = validateInstallRepositoryScope(undefined, 'demo-fleet-code-agent');
    expect(reason).toBeDefined();
    expect(reason).toMatch(/not reported by GitHub/);
  });

  it('REFUSES any other unexpected value too', () => {
    const reason = validateInstallRepositoryScope('weird-future-value', 'demo-fleet-code-agent');
    expect(reason).toBeDefined();
  });

  it('names the App (the handle passed in) in the refusal', () => {
    const reason = validateInstallRepositoryScope('all', 'demo-fleet-devops-agent');
    expect(reason).toContain('demo-fleet-devops-agent');
  });

  it('names the exact remediation — open the install page, choose "Only select repositories," re-run apply', () => {
    const reason = validateInstallRepositoryScope('all', 'demo-fleet-code-agent');
    expect(reason).toMatch(/open the install page/);
    expect(reason).toMatch(/Only select repositories/);
    expect(reason).toMatch(/re-run apply/);
  });

  it('never mentions a credential — this function only ever sees the observed string, which carries none', () => {
    const reason = validateInstallRepositoryScope('all', 'demo-fleet-code-agent');
    expect(reason).not.toMatch(/BEGIN.*PRIVATE KEY/);
  });

  it('does not cite an internal issue/DR number in the refusal text (no-internal-citations guard)', () => {
    const reason = validateInstallRepositoryScope('all', 'demo-fleet-code-agent');
    expect(reason).not.toMatch(/\bmacf#\d+\b/);
    expect(reason).not.toMatch(/\bDR-0\d{2}\b/);
  });
});

describe('buildInstallScopeValidator — the AgentApplyDeps.validateInstall-shaped closure builder', () => {
  const base: ConfirmedInstall = { appId: '1', installId: '2', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };

  it('accepts a ConfirmedInstall whose repositorySelection is "selected"', () => {
    const validate = buildInstallScopeValidator('demo-fleet-code-agent');
    expect(validate({ ...base, repositorySelection: 'selected' })).toBeUndefined();
  });

  it('refuses a ConfirmedInstall whose repositorySelection is "all", naming the SAME appHandle it was built with', () => {
    const validate = buildInstallScopeValidator('demo-fleet-code-agent');
    const reason = validate({ ...base, repositorySelection: 'all' });
    expect(reason).toBeDefined();
    expect(reason).toContain('demo-fleet-code-agent');
  });

  it('two closures built for different App handles refuse independently, each naming its OWN handle', () => {
    const validateCode = buildInstallScopeValidator('demo-fleet-code-agent');
    const validateDevops = buildInstallScopeValidator('demo-fleet-devops-agent');
    const codeReason = validateCode({ ...base, repositorySelection: 'all' });
    const devopsReason = validateDevops({ ...base, repositorySelection: 'all' });
    expect(codeReason).toContain('demo-fleet-code-agent');
    expect(codeReason).not.toContain('demo-fleet-devops-agent');
    expect(devopsReason).toContain('demo-fleet-devops-agent');
    expect(devopsReason).not.toContain('demo-fleet-code-agent');
  });
});
