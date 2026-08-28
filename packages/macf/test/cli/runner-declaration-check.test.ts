/**
 * Tests for `macf routing runner-declaration-check` (groundnuty/macf#1194) —
 * the CLI wrapper over `bootstrap/runner-declaration-reach.ts::checkRunnerDeclarationReach`.
 */
import { describe, it, expect, vi } from 'vitest';
import { runRunnerDeclarationCheck } from '../../src/cli/commands/runner-declaration-check.js';
import type { RunnerDeclarationDeps } from '../../src/cli/bootstrap/runner-declaration-reach.js';

const TODAYS_CALLER_YAML = `jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.4.2
    with:
      project: myproject
      registry-api-path: /orgs/myorg
`;

// A hypothetical caller whose with: block grew a THIRD key — reachable
// only from a fixture today (no real router emits this), and per
// `runner-declaration-reach.ts`'s own doc, `conveysRunnerIntent` cannot
// tell "the new key is runner-intent" apart from "the new key is
// something unrelated" — hence the CLI's UNCERTAIN tag + non-zero exit
// rather than treating it as a confirmed pass.
const UNKNOWN_THIRD_KEY_CALLER_YAML = `jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.6.0
    with:
      project: myproject
      registry-api-path: /orgs/myorg
      runner-intent: self-hosted
`;

describe('runRunnerDeclarationCheck', () => {
  it('requires at least one repo', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runRunnerDeclarationCheck({ repos: [], runsOn: 'self-hosted' });
    expect(code).toBe(1);
    errorSpy.mockRestore();
  });

  it('exit 0 and no per-repo read when runsOn is not self-hosted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let called = false;
    const deps: RunnerDeclarationDeps = {
      readInstalledWorkflow: async () => {
        called = true;
        return undefined;
      },
    };
    const code = await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'hosted' }, deps);
    expect(code).toBe(0);
    expect(called).toBe(false);
    logSpy.mockRestore();
  });

  it('DECISIVE: exit non-zero + "NOT HONOURED" rendered when self-hosted is declared but the installed router cannot carry it', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => TODAYS_CALLER_YAML };
    const code = await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'self-hosted' }, deps);
    expect(code).toBe(1);
    expect(printed).toMatch(/\[NOT HONOURED\]/);
    expect(printed).toContain('groundnuty/x');
    expect(printed).toContain('MACF_TRUSTED_ACTORS');
    logSpy.mockRestore();
  });

  it('exit non-zero + "UNKNOWN" rendered when the installed workflow cannot be read', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => undefined };
    const code = await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'self-hosted' }, deps);
    expect(code).toBe(1);
    expect(printed).toMatch(/\[UNKNOWN\]/);
    logSpy.mockRestore();
  });

  it('DECISIVE: an "honoured" verdict is STILL non-zero exit, tagged UNCERTAIN — never treated as a confirmed pass', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => UNKNOWN_THIRD_KEY_CALLER_YAML };
    const code = await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'self-hosted' }, deps);
    expect(code).toBe(1);
    expect(printed).toMatch(/\[UNCERTAIN\]/);
    expect(printed).not.toMatch(/\[N\/A\]/);
    logSpy.mockRestore();
  });

  it('audits every named repo, not just the first', async () => {
    const seen: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps: RunnerDeclarationDeps = {
      readInstalledWorkflow: async (repo) => {
        seen.push(repo);
        return TODAYS_CALLER_YAML;
      },
    };
    await runRunnerDeclarationCheck({ repos: ['groundnuty/a', 'groundnuty/b'], runsOn: 'self-hosted' }, deps);
    expect(seen).toEqual(['groundnuty/a', 'groundnuty/b']);
    logSpy.mockRestore();
  });

  it('citation guard: the human-readable finding carries no internal issue numbers or DR names', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed += `${s}\n`;
    });
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => TODAYS_CALLER_YAML };
    await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'self-hosted' }, deps);
    expect(printed).not.toMatch(/#\d+/);
    expect(printed).not.toMatch(/DR-\d+/);
    expect(printed).not.toMatch(/Amendment/i);
    logSpy.mockRestore();
  });

  it('--json emits one machine-readable finding per repo', async () => {
    let printed = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      printed = s;
    });
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => TODAYS_CALLER_YAML };
    await runRunnerDeclarationCheck({ repos: ['groundnuty/x'], runsOn: 'self-hosted', json: true }, deps);
    const parsed = JSON.parse(printed) as { findings: readonly { repo: string; verdict: string }[] };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.repo).toBe('groundnuty/x');
    expect(parsed.findings[0]?.verdict).toBe('not-honoured');
    logSpy.mockRestore();
  });
});
