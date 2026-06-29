/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-emit-commands.sh`
 * — renders the VM-side handoff (DR-035 outputs #2 + #3): per-agent `git clone`
 * + `macf init` (IDs substituted) and the DR-030 fleet-health verification trio.
 * Pure renderer; the test feeds a spec JSON and asserts the rendered lines.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-emit-commands.sh');

function runWithSpec(spec: unknown): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-emit-'));
  const specFile = join(dir, 'spec.json');
  writeFileSync(specFile, JSON.stringify(spec));
  try {
    return spawnSync('bash', [SCRIPT, '--spec', specFile], { encoding: 'utf-8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_SPEC = {
  project: 'icsoc-2026',
  registry: { type: 'profile', user: 'groundnuty' },
  advertise_host: 'orzech-dev-agents.tail491af.ts.net',
  science_repo: 'groundnuty/icsoc-2026-science-agent',
  agents: [
    {
      role: 'science-agent',
      name: 'icsoc-2026-science-agent',
      repo: 'groundnuty/icsoc-2026-science-agent',
      deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-science-agent',
      app_id: '111111',
      install_id: '22222222',
      key_path: '~/.macf/keys/icsoc-2026-science-agent.pem',
    },
    {
      role: 'code-agent',
      name: 'icsoc-2026-code-agent',
      repo: 'groundnuty/icsoc-2026-experiment',
      deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-experiment',
      app_id: '333333',
      install_id: '44444444',
      key_path: '~/.macf/keys/icsoc-2026-code-agent.pem',
    },
  ],
};

describe('bootstrap-emit-commands.sh', () => {
  it('renders per-agent git clone + macf init with IDs substituted (output #2)', () => {
    const r = runWithSpec(SAMPLE_SPEC);
    expect(r.status).toBe(0);
    const out = r.stdout;
    // science-agent block
    expect(out).toContain('git clone https://github.com/groundnuty/icsoc-2026-science-agent.git /home/ubuntu/repos/agh/icsoc-2026-science-agent');
    expect(out).toContain('--project icsoc-2026 --role science-agent --name icsoc-2026-science-agent');
    expect(out).toContain('--app-id 111111 --install-id 22222222');
    expect(out).toContain('--app-key ~/.macf/keys/icsoc-2026-science-agent.pem');
    expect(out).toContain('--registry-type profile --registry-user groundnuty');
    expect(out).toContain('--advertise-host orzech-dev-agents.tail491af.ts.net');
    expect(out).toContain('--dir /home/ubuntu/repos/agh/icsoc-2026-science-agent');
    // code-agent block present too
    expect(out).toContain('--role code-agent --name icsoc-2026-code-agent');
    expect(out).toContain('--app-id 333333 --install-id 44444444');
  });

  it('renders the DR-030 fleet-health verification trio (output #3)', () => {
    const r = runWithSpec(SAMPLE_SPEC);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('macf fleet status');
    expect(r.stdout).toContain('macf routing doctor');
    expect(r.stdout).toContain('macf fleet doctor');
  });

  it('renders org-registry flags', () => {
    const r = runWithSpec({
      project: 'p',
      registry: { type: 'org', org: 'acme' },
      agents: [{ role: 'code-agent', name: 'p-code', repo: 'acme/p', deploy_path: '/x', app_id: '1', install_id: '2' }],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--registry-type org --registry-org acme');
  });

  it('renders repo-registry flags', () => {
    const r = runWithSpec({
      project: 'p',
      registry: { type: 'repo', repo: 'acme/p' },
      agents: [{ role: 'code-agent', name: 'p-code', repo: 'acme/p', deploy_path: '/x', app_id: '1', install_id: '2' }],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--registry-type repo --registry-repo acme/p');
  });

  it('defaults a missing key_path to ~/.macf/keys/<name>.pem', () => {
    const r = runWithSpec({
      project: 'p',
      registry: { type: 'profile', user: 'u' },
      agents: [{ role: 'code-agent', name: 'p-code', repo: 'u/p', deploy_path: '/x', app_id: '1', install_id: '2' }],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--app-key ~/.macf/keys/p-code.pem');
  });

  it('fails (exit 2) when --spec is missing', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--spec');
  });

  it('fails when the spec is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bs-emit-bad-'));
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{not json');
    try {
      const r = spawnSync('bash', [SCRIPT, '--spec', f], { encoding: 'utf-8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('valid JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
