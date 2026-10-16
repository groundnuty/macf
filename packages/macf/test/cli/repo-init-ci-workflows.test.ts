/**
 * groundnuty/macf#1479 — the router caller subscribes to `workflow_run` for
 * the repo's CI workflows. `check_suite` alone never fires for GitHub Actions
 * CI (GitHub does not trigger workflows from check suites Actions created).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  generateWorkflow,
  isCiWorkflowRunCapableActionsVersion,
  repoInit,
} from '../../src/cli/commands/repo-init.js';
import { scanCiWorkflowNames } from '../../src/cli/commands/repo-init-ci-workflows.js';

const V3 = { project: 'macf', registryApiPath: '/orgs/o' };
type On = Record<string, { workflows?: string[]; types?: string[] }>;
const onOf = (yaml: string): On => (parseYaml(yaml) as { on: On }).on;

describe('isCiWorkflowRunCapableActionsVersion', () => {
  it.each([
    ['v3.6.0', true],
    ['v3.6.1', true],
    ['v3.7.0', true],
    ['v4.0.0', true],
    ['main', true],
    ['v3.5.0', false],
    ['v3.4.2', false],
    ['v3', false], // floating: cannot confirm it carries the handler
    ['v1.3.1', false],
  ])('%s -> %s', (v, want) => {
    expect(isCiWorkflowRunCapableActionsVersion(v)).toBe(want);
  });
});

describe('generateWorkflow — workflow_run trigger (macf#1479)', () => {
  it('emits workflow_run with the CI names and keeps check_suite for third-party CI', () => {
    const on = onOf(generateWorkflow('v3.6.0', V3, ['CI', 'E2E']));
    expect(on['workflow_run']).toEqual({ workflows: ['CI', 'E2E'], types: ['completed'] });
    expect(on['check_suite']).toEqual({ types: ['completed'] });
  });

  it('quotes names so YAML-significant characters survive', () => {
    const on = onOf(generateWorkflow('v3.6.0', V3, ['Build: "all"', 'lint #2']));
    expect(on['workflow_run']?.workflows).toEqual(['Build: "all"', 'lint #2']);
  });

  it('emits no workflow_run block for a repo with no CI workflows', () => {
    expect(Object.keys(onOf(generateWorkflow('v3.6.0', V3, [])))).not.toContain('workflow_run');
    expect(Object.keys(onOf(generateWorkflow('v3.6.0', V3)))).not.toContain('workflow_run');
  });

  it('emits none for a pin whose router would ignore it', () => {
    expect(Object.keys(onOf(generateWorkflow('v3.5.0', V3, ['CI'])))).not.toContain('workflow_run');
    expect(Object.keys(onOf(generateWorkflow('v1', undefined, ['CI'])))).not.toContain('workflow_run');
  });

  it('emits for main', () => {
    expect(onOf(generateWorkflow('main', V3, ['CI']))['workflow_run']?.workflows).toEqual(['CI']);
  });
});

describe('scanCiWorkflowNames', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-ci-scan-'));
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (f: string, body: string) => writeFileSync(join(dir, '.github', 'workflows', f), body);

  it('returns [] when there is no workflows dir', () => {
    expect(scanCiWorkflowNames(join(dir, 'nope'))).toEqual([]);
  });

  it('lists named push/pull_request workflows, sorted, and an unnamed one by path', () => {
    put('ci.yml', 'name: CI\non:\n  push:\n    branches: [main]\njobs: {}\n');
    put('e2e.yaml', 'name: E2E\non: [pull_request]\njobs: {}\n');
    put('lint.yml', 'on: pull_request\njobs: {}\n');
    expect(scanCiWorkflowNames(dir)).toEqual(['.github/workflows/lint.yml', 'CI', 'E2E']);
  });

  it('skips the router caller by file and by name, schedule-only and dispatch-only workflows, and broken YAML', () => {
    put('agent-router.yml', 'name: Caller\non:\n  push: {}\njobs: {}\n');
    put('other-router.yml', 'name: Agent Router\non:\n  push: {}\njobs: {}\n');
    put('nightly.yml', 'name: Nightly\non:\n  schedule:\n    - cron: "0 7 * * *"\njobs: {}\n');
    put('manual.yml', 'name: Manual\non: workflow_dispatch\njobs: {}\n');
    put('broken.yml', 'name: [unclosed\non: push\n');
    put('notes.txt', 'name: Notes\non: push\n');
    expect(scanCiWorkflowNames(dir)).toEqual([]);
  });

  it('de-duplicates identical names', () => {
    put('a.yml', 'name: CI\non: push\njobs: {}\n');
    put('b.yml', 'name: CI\non: push\njobs: {}\n');
    expect(scanCiWorkflowNames(dir)).toEqual(['CI']);
  });
});

describe('repoInit — workflow_run end to end (macf#1479)', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-ci-repoinit-'));
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: pull_request\njobs: {}\n');
    process.env['GH_TOKEN'] = 'test-token';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });
  const written = () => readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');

  it('scans the repo and writes workflow_run for a capable pin', async () => {
    await repoInit(dir, { repo: 'o/r', actionsVersion: 'v3.6.0', force: false });
    expect(onOf(written())['workflow_run']?.workflows).toEqual(['CI']);
  });

  it('writes none for a pin below the threshold, even though the repo has CI', async () => {
    await repoInit(dir, { repo: 'o/r', actionsVersion: 'v3.5.0', force: false });
    expect(Object.keys(onOf(written()))).not.toContain('workflow_run');
  });

  it('an explicit list replaces the scan', async () => {
    await repoInit(dir, { repo: 'o/r', actionsVersion: 'v3.6.0', force: false, ciWorkflows: ['Build'] });
    expect(onOf(written())['workflow_run']?.workflows).toEqual(['Build']);
  });
});
