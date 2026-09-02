/**
 * Tests for `macf doctor`'s distributed-script-currency check
 * (groundnuty/macf#1362 — a workspace could not tell its distributed
 * `.claude/scripts/` had fallen behind canonical; the auditor lost two
 * sessions to a `check-gh-token.sh` copy that sat nineteen days stale with
 * nothing able to say so).
 *
 * Two root causes, distinguished:
 *   - a MANAGED workspace (`.macf/` present) whose `.claude/scripts/` copy
 *     has drifted from what `macf update` would write right now → WARN,
 *     naming the file, distinguishing `stale` (bytes differ) from `missing`
 *     (canonical distributes the name, workspace has none).
 *   - an UNMANAGED workspace (no `.macf/`) → INFO, distinctly worded — its
 *     scripts have no distribution relationship to canonical at all, so
 *     calling them "stale" would be the wrong word.
 *   - canonical itself undeterminable (the running CLI's own script source
 *     dirs can't be found) → UNKNOWN, never reported as current.
 *
 * `checkDistributedScriptCurrency` is exercised directly (with fake
 * canonical dirs, offline, no network) for the decisive pair + the
 * unmanaged/unknown cases. The final describe block drives the check
 * through the full `runDoctor` report and reads the RENDERED console
 * output (not a helper's return value) — a local-registry config (DR-024)
 * so `runDoctor` skips the network DR-019 token check entirely, and the
 * REAL bundled canonical scripts (no override) so the rendered assertion
 * is against what an operator would actually see.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkDistributedScriptCurrency, runDoctor } from '../../src/cli/commands/doctor.js';
import { copyCanonicalScripts } from '../../src/cli/rules.js';
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

describe('checkDistributedScriptCurrency (groundnuty/macf#1362)', () => {
  let tmpRoot: string;
  let fakeCanonical: string;
  let fakePluginScripts: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-script-currency-'));
    fakeCanonical = join(tmpRoot, 'canonical');
    fakePluginScripts = join(tmpRoot, 'plugin-canonical');
    mkdirSync(fakeCanonical, { recursive: true });
    mkdirSync(fakePluginScripts, { recursive: true });
    // check-gh-token.sh lives in the PLUGIN canonical dir per DR-039 phase 2
    // (groundnuty/macf#698) — mirror that placement so the fixture matches
    // the real distribution shape.
    writeFileSync(
      join(fakePluginScripts, 'check-gh-token.sh'),
      '#!/usr/bin/env bash\n# canonical, current shape\ncase "$TOKEN" in ghs_*) ok;; esac\n',
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const dirs = () => ({ canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

  it('WARN: a managed workspace with a DELIBERATELY OLD script is reported stale, naming the file', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'),
      '#!/usr/bin/env bash\n# OLD pre-#827 shape\ncase "$TOKEN" in ghs_[A-Za-z0-9_]*) ok;; esac\n',
    );

    const result = checkDistributedScriptCurrency(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toContainEqual({ name: 'check-gh-token.sh', reason: 'stale' });
    expect(result.detail).toMatch(/stale/);
  });

  it('PASS: a managed workspace freshly refreshed is reported current, no noise', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    // The real refresh path — copyCanonicalScripts is exactly what
    // `macf update` calls, so "freshly refreshed" means literally this.
    copyCanonicalScripts(tmpRoot, dirs());

    const result = checkDistributedScriptCurrency(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
    expect(result.checkedCount).toBeGreaterThan(0);
  });

  it('INFO: an unmanaged workspace (no .macf/) with hook scripts present is reported unmanaged, distinctly from stale', () => {
    // Deliberately NO .macf/ — root cause 2's shape (macf-fleet-build):
    // a hand-placed copy with no distribution relationship to canonical.
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'),
      '#!/usr/bin/env bash\n# ancient, hand-placed, never touched by macf update\n',
    );

    const result = checkDistributedScriptCurrency(tmpRoot, dirs());
    expect(result.status).toBe('INFO');
    expect(result.status).not.toBe('WARN');
    expect(result.findings).toEqual([]);
    expect(result.detail).toMatch(/no .macf\/ directory/i);
    expect(result.detail).not.toMatch(/stale/i);
  });

  it('UNKNOWN: canonical undeterminable — neither source dir exists — never reported as current', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });

    const result = checkDistributedScriptCurrency(tmpRoot, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
      pluginScriptsDir: join(tmpRoot, 'also-does-not-exist'),
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.status).not.toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  // groundnuty/macf#1403 — the actual bug shape: ONE source dir present
  // (the legacy `scripts/`), the OTHER absent (`plugin/scripts/` — omitted
  // from `package.json` files[] on every published CLI through 0.2.59).
  // Before the fix, this silently narrowed `names` to whatever the present
  // dir alone contains and reported PASS/WARN against that narrowed
  // population — an "8/8 match" green report while 14 scripts (including
  // the entire PreToolUse guard family) went uncompared. Must be FAIL, and
  // must NOT be conflated with UNKNOWN (both-missing, above) or PASS.
  it('FAIL: exactly ONE source dir exists — never silently narrows the comparison population, never PASS (the real macf#1403 shape)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    const missingPlugin = join(tmpRoot, 'plugin-does-not-exist');

    const result = checkDistributedScriptCurrency(tmpRoot, {
      canonicalDir: fakeCanonical,
      pluginScriptsDir: missingPlugin,
    });
    expect(result.status).toBe('FAIL');
    expect(result.status).not.toBe('PASS');
    expect(result.status).not.toBe('UNKNOWN');
    expect(result.status).not.toBe('WARN');
    expect(result.findings).toEqual([]);
    expect(result.detail).toContain(missingPlugin);
  });

  it('FAIL: symmetric — only the LEGACY dir is absent, plugin dir present', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    const missingLegacy = join(tmpRoot, 'legacy-does-not-exist');

    const result = checkDistributedScriptCurrency(tmpRoot, {
      canonicalDir: missingLegacy,
      pluginScriptsDir: fakePluginScripts,
    });
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain(missingLegacy);
  });

  it('WARN: a canonically-distributed script entirely absent from a managed workspace is reported missing (distinct from stale)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    // check-gh-token.sh is never written to the workspace at all.

    const result = checkDistributedScriptCurrency(tmpRoot, dirs());
    expect(result.status).toBe('WARN');
    expect(result.findings).toContainEqual({ name: 'check-gh-token.sh', reason: 'missing' });
  });

  it('mutation check: a canonical-identical on-disk copy is never reported stale (positive control)', () => {
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'),
      readFileSync(join(fakePluginScripts, 'check-gh-token.sh')),
    );

    const result = checkDistributedScriptCurrency(tmpRoot, dirs());
    expect(result.status).toBe('PASS');
  });
});

describe('runDoctor — Distributed script currency section (rendered output, groundnuty/macf#1362)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-script-currency-rendered-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Real canonical scripts (no override) — the assertion is against what an
   * operator actually sees when the running CLI's OWN bundled scripts are
   * the reference. Deliberately mirrors #1360's real incident: an existing
   * `check-gh-token.sh` copy whose validator regex predates canonical.
   */
  it('names check-gh-token.sh as stale in the rendered report for a deliberately old copy', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    // Satisfy the unrelated sandbox-fd check so the exit code isolates
    // whether THIS check affects it, rather than piggybacking on a
    // pre-existing FAIL from an empty settings.json.
    installSandboxFdAllowRead(tmpRoot);
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'),
      '#!/usr/bin/env bash\n# a script that will never match the real canonical bytes\necho pre-1360-shape\n',
    );

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0); // WARN-only — does not affect exit code

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed script currency');
    expect(out).toContain('check-gh-token.sh');
    expect(out).toMatch(/stale/i);
    expect(out).toMatch(/\[WARN\]/);
    // The WARN line must not claim unqualified "current" — it names WHICH
    // CLI's canonical it compared against (the honesty fix for the PASS/WARN
    // provenance gap: "canonical" here means this running CLI's bundled
    // copy, not the groundnuty/macf source repo's HEAD).
    expect(out).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
  });

  it('reports current with no findings after a real macf-update-equivalent refresh', async () => {
    writeAgentConfig(tmpRoot, localConfig());
    installSandboxFdAllowRead(tmpRoot);
    // The real refresh — same function `macf update` calls, no fakes.
    copyCanonicalScripts(tmpRoot);

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed script currency');
    expect(out).toMatch(/match canonical.*\[PASS\]|\[PASS\]/i);
    // No stale finding should be listed for a fresh copy.
    expect(out).not.toMatch(/✗ .*— stale/);
    // PASS must stamp CLI-version provenance too — "match canonical" alone
    // over-claims when "canonical" is scoped to this CLI's own bundled copy
    // (a pinned-old npm install would PASS against its own stale bundle).
    expect(out).toMatch(/as shipped by this CLI \(v[\d.]+|version unknown\)/);
  });

  /**
   * groundnuty/macf#1362 root cause 2's shape (macf-fleet-build), reached
   * through the ACTUAL `macf doctor` entrypoint rather than the helper
   * function directly. `runDoctor` returns 1 immediately when no
   * macf-agent.json is found — before this fix that early return skipped
   * every section, so the honest "unmanaged" line the AC asks for was never
   * shown for the exact workspace shape it names. This is the altitude the
   * issue means by "`macf doctor` reports it": the printed report, not just
   * a helper's return value.
   */
  it('renders the unmanaged line even when macf-agent.json is entirely absent (no early-return skip)', async () => {
    // Deliberately NO writeAgentConfig call — `.macf/macf-agent.json` never
    // existed. Hook scripts present anyway (the hand-placed-copy shape).
    mkdirSync(join(tmpRoot, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'scripts', 'check-gh-token.sh'),
      '#!/usr/bin/env bash\n# ancient hand-placed copy, no .macf/ at all\n',
    );

    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1); // pre-existing "run `macf init` first" exit — unrelated to staleness

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Distributed script currency');
    expect(out).toMatch(/no .macf\/ directory/i);
    expect(out).toMatch(/\[INFO\]/);
    // Must NOT read as stale/current — the unmanaged wording is distinct.
    expect(out).not.toMatch(/stale/i);
    expect(out).not.toMatch(/match canonical/i);
  });
});
