/**
 * Source-of-truth guard for packages/macf/plugin/ (groundnuty/macf#426).
 *
 * The mountable plugin manifest (`.claude-plugin/plugin.json`) is canonical in
 * the SEPARATE marketplace repo (groundnuty/macf-marketplace:macf-agent/) — what
 * consumers actually fetch + mount. The vestigial repo copy was removed (it had
 * drifted to a stale `node dist/server.js` / 0.1.0 form and misled readers as
 * the source). This guard fails if someone re-adds the stale duplicate, and
 * confirms the README pointer is present.
 *
 * The plugin.json `version` field guard (the old #109 H3 concern) now lives at
 * release time: `.github/workflows/publish.yml` asserts the marketplace
 * plugin.json `version` matches the release tag (cross-repo, can't be a unit
 * test here).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');

describe('plugin source-of-truth (#426)', () => {
  it('does NOT carry a vestigial .claude-plugin/plugin.json (marketplace is canonical)', () => {
    expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(false);
  });

  it('has a README pointer to the marketplace canonical source', () => {
    const readmePath = join(pluginDir, 'README.md');
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, 'utf-8');
    expect(readme).toContain('macf-marketplace');
  });

  it('keeps rules/ as the CLI-canonical source (the exception)', () => {
    // rules/ IS canonical here (distributed by rules.ts) — guard it stays.
    expect(existsSync(join(pluginDir, 'rules', 'coordination.md'))).toBe(true);
  });
});
