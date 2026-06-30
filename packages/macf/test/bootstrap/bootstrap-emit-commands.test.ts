/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-emit-commands.sh`
 * — renders the VM-side handoff (DR-035 outputs #2 + #3): per-agent `git clone`
 * + `macf init` (IDs substituted) and the DR-030 fleet-health verification trio.
 * Pure renderer; the test feeds a spec JSON and asserts the rendered lines.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

  // ── First-run dogfood fixes (macf-automated-github-setup#1, PR #2) ──────────

  it('emits `macf certs rotate` per agent (the No-CA-on-VM fix)', () => {
    const r = runWithSpec(SAMPLE_SPEC);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('macf certs rotate --dir /home/ubuntu/repos/agh/icsoc-2026-science-agent');
    expect(r.stdout).toContain('macf certs rotate --dir /home/ubuntu/repos/agh/icsoc-2026-experiment');
  });

  it('warns never to run `macf certs init` on the VM (it clobbers the registry CA var)', () => {
    const r = runWithSpec(SAMPLE_SPEC);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Do NOT run `macf certs init` on the VM/);
    // mentions the CA materialize from the vault + the <SEG>_CA_CERT var it protects
    expect(r.stdout).toContain('ICSOC_2026_CA_CERT');
    expect(r.stdout).toContain('ca-{cert,key}.pem');
  });

  it('renders the overleaf-mirror branch (git remote add + push, NOT git clone)', () => {
    const r = runWithSpec({
      project: 'p',
      registry: { type: 'profile', user: 'u' },
      agents: [
        {
          role: 'writer-agent',
          name: 'p-writer',
          repo: 'u/p-paper',
          deploy_path: '/papers/p',
          repo_provenance: 'overleaf-mirror',
          app_id: '1',
          install_id: '2',
        },
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git remote add github https://github.com/u/p-paper.git');
    expect(r.stdout).toContain('git push -u github HEAD');
    expect(r.stdout).toContain('cd /papers/p');
    // and it must NOT clone into the existing dir
    expect(r.stdout).not.toContain('git clone https://github.com/u/p-paper.git');
  });

  it('still clones for default (template) provenance', () => {
    const r = runWithSpec(SAMPLE_SPEC); // no repo_provenance → defaults to template
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git clone https://github.com/groundnuty/icsoc-2026-science-agent.git');
  });

  it('setup-asserts use `macf doctor`, NOT a `gh api /app/installations` command (403s with user token)', () => {
    const r = runWithSpec(SAMPLE_SPEC);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('macf doctor --dir <home-of-icsoc-2026-science-agent>');
    // No EMITTED COMMAND may invoke `gh api /app/installations` (an explanatory
    // `#`-comment that mentions why the endpoint is unusable is fine).
    const commandLines = r.stdout.split('\n').filter((l) => !/^\s*#/.test(l));
    expect(commandLines.join('\n')).not.toContain('gh api /app/installations');
  });
});

describe('bootstrap-spec.example.json', () => {
  it('carries the per-agent repo_provenance field', () => {
    const exampleSpec = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'tools', 'macf-bootstrap', 'templates', 'bootstrap-spec.example.json'),
        'utf-8',
      ),
    );
    const provenances = exampleSpec.agents.map((a: { repo_provenance?: string }) => a.repo_provenance);
    // every agent declares it, and at least one exercises the overleaf-mirror path
    expect(provenances.every((p: string | undefined) => typeof p === 'string')).toBe(true);
    expect(provenances).toContain('overleaf-mirror');
    expect(provenances).toContain('template');
  });
});
