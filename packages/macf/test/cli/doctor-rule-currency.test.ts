/**
 * Tests for `macf doctor`'s distributed-rule-currency check
 * (groundnuty/macf#1360 "consider whether the same gap applies to rules,
 * not just scripts" — the auditor's own stale workspace had BOTH a
 * nineteen-day-stale `check-gh-token.sh` (fixed by #1364's script-currency
 * check) AND `.claude/rules/*.md` copies that had drifted behind canonical,
 * with nothing able to say so for the rule half).
 *
 * Sibling of `doctor-script-currency.test.ts` — same four states (PASS /
 * WARN / INFO / UNKNOWN), same content-not-presence discipline, same
 * honest-unknown contract. The one rule-specific wrinkle:
 * `copyCanonicalRules` prepends a managed-file header to any canonical
 * source that doesn't already start with `<!--` (`computeCanonicalRuleFile`
 * / `MANAGED_HEADER` in rules.ts) — a byte-for-byte compare against the RAW
 * canonical source would report every distributed rule as permanently
 * stale. The "header-prepend trap" tests below assert the check compares
 * against the header-prepended form, not the raw source.
 *
 * `checkDistributedRuleCurrency` is exercised directly (with fake canonical
 * dirs, offline, no network) for the decisive pair + the unmanaged/unknown
 * cases + the header-prepend trap. The final describe block drives the
 * check through the full `runDoctor` report and reads the RENDERED console
 * output (not a helper's return value) — per #1364's own lesson, a
 * correct-but-unreachable branch (the early-return-before-any-output path
 * when no macf-agent.json exists) is only caught by a test reading output
 * through the real entrypoint, not the helper alone.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkDistributedRuleCurrency, runDoctor } from '../../src/cli/commands/doctor.js';
import { computeCanonicalRuleFile, copyCanonicalRules } from '../../src/cli/rules.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import { installSandboxFdAllowRead } from '../../src/cli/settings-writer.js';

function localConfig(): MacfAgentConfig {
  return {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'local', path: '/tmp/macf-test-registry.json' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

describe('checkDistributedRuleCurrency (groundnuty/macf#1360)', () => {
  let tmpRoot: string;
  let fakeCanonical: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-rule-currency-'));
    fakeCanonical = join(tmpRoot, 'canonical-rules');
    mkdirSync(fakeCanonical, { recursive: true });
    // Deliberately NOT starting with `<!--` — the normal shape of every
    // real canonical rule source file, which triggers the header-prepend
    // path in `computeCanonicalRuleContent`.
    writeFileSync(
      join(fakeCanonical, 'coordination.md'),
      '# Coordination Rules (canonical, shared)\n\ncanonical, current shape\n',
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const dirs = () => ({ canonicalDir: fakeCanonical });

  it('WARN: a managed workspace with a DELIBERATELY OLD rule is reported stale, naming the file', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'rules', 'coordination.md'),
      '# Coordination Rules (canonical, shared)\n\nOLD pre-refresh shape\n',
    );

    const result = checkDistributedRuleCurrency(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toContainEqual({ name: 'coordination.md', reason: 'stale' });
    expect(result.detail).toMatch(/stale/);
  });

  it('PASS: a managed workspace freshly refreshed is reported current, no noise', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    // The real refresh path — copyCanonicalRules is exactly what
    // `macf update` calls, so "freshly refreshed" means literally this.
    copyCanonicalRules(tmpRoot, dirs());

    const result = checkDistributedRuleCurrency(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
    expect(result.checkedCount).toBeGreaterThan(0);
  });

  it('INFO: an unmanaged workspace (no .macf/) with rule files present is reported unmanaged, distinctly from stale', () => {
    // Deliberately NO .macf/ — root cause 2's shape (macf-fleet-build):
    // a hand-placed copy with no distribution relationship to canonical.
    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'rules', 'coordination.md'),
      '# ancient, hand-placed, never touched by macf update\n',
    );

    const result = checkDistributedRuleCurrency(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.status).not.toBe('WARN');
    expect(result.findings).toEqual([]);
    expect(result.detail).toMatch(/no .macf\/ directory/i);
    expect(result.detail).not.toMatch(/stale/i);
  });

  it('UNKNOWN: canonical undeterminable — the rules source dir does not exist — never reported as current', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });

    const result = checkDistributedRuleCurrency(tmpRoot, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  it('WARN: a canonically-distributed rule entirely absent from a managed workspace is reported missing (distinct from stale)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    // coordination.md is never written to the workspace at all.

    const result = checkDistributedRuleCurrency(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toContainEqual({ name: 'coordination.md', reason: 'missing' });
  });

  describe('header-prepend trap', () => {
    it('a workspace copy carrying the header-prepended form (what copyCanonicalRules ACTUALLY writes) is current, not stale', () => {
      mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
      mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
      const expected = computeCanonicalRuleFile('coordination.md', dirs());
      expect(expected).not.toBeNull();
      writeFileSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'), expected as string);

      const result = checkDistributedRuleCurrency(tmpRoot, dirs());
      expect(result.status).toBe('PASS');
    });

    it('a workspace copy carrying the RAW (un-prepended) canonical source bytes is reported STALE — proves the check does not naively byte-compare against the source file', () => {
      mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
      mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
      // Copy the raw fixture bytes directly — this is what `macf update`
      // would NEVER actually write (it always goes through
      // computeCanonicalRuleContent's header-prepend), so this on-disk
      // shape is genuinely stale relative to what a real refresh produces.
      writeFileSync(
        join(tmpRoot, '.claude', 'rules', 'coordination.md'),
        readFileSync(join(fakeCanonical, 'coordination.md')),
      );

      const result = checkDistributedRuleCurrency(tmpRoot, dirs());
      expect(result.status).toBe('WARN');
      expect(result.findings).toContainEqual({ name: 'coordination.md', reason: 'stale' });
    });
  });
});

describe('runDoctor — Distributed rule currency section (rendered output, groundnuty/macf#1360)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-rule-currency-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Real canonical rules (no override) — the assertion is against what an
   * operator actually sees when the running CLI's OWN bundled rules are the
   * reference. Deliberately mirrors the auditor's real incident: an
   * existing `coordination.md` copy that predates canonical.
   */
  it('names coordination.md as stale in the rendered report for a deliberately old copy', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    // Satisfy the unrelated sandbox-fd check so the exit code isolates
    // whether THIS check affects it, rather than piggybacking on a
    // pre-existing FAIL from an empty settings.json.
    installSandboxFdAllowRead(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'rules', 'coordination.md'),
      '# a rule file that will never match the real canonical bytes\n',
    );

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // WARN-only — does not affect exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed rule currency');
    expect(out).toContain('coordination.md');
    expect(out).toMatch(/stale/i);
    expect(out).toMatch(/\[WARN\]/);
    expect(out).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
  });

  it('reports current with no findings after a real macf-update-equivalent refresh', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    // The real refresh — same function `macf update` calls, no fakes.
    copyCanonicalRules(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed rule currency');
    expect(out).toMatch(/match canonical.*\[PASS\]|\[PASS\]/i);
    expect(out).not.toMatch(/✗ .*— stale/);
    expect(out).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
  });

  /**
   * groundnuty/macf#1362-shaped root cause 2 (macf-fleet-build), reached
   * through the ACTUAL `macf doctor` entrypoint rather than the helper
   * function directly — the exact reachability bug #1364 found for the
   * script-currency section, now guarded against for rules too.
   */
  it('renders the unmanaged line even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    // Deliberately NO writeAgentConfig call — `.macf/macf-agent.json` never
    // existed. Rule files present anyway (the hand-placed-copy shape).
    mkdirSync(join(tmpRoot, '.claude', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'rules', 'coordination.md'),
      '# ancient hand-placed copy, no .macf/ at all\n',
    );

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to staleness

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed rule currency');
    expect(out).toMatch(/no .macf\/ directory/i);
    expect(out).toMatch(/\[INFO\]/);
    expect(out).not.toMatch(/stale/i);
    expect(out).not.toMatch(/match canonical/i);
  });
});
