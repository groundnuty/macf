/**
 * Content guard for plugin/.claude-plugin/plugin.json (#109 H3).
 *
 * Claude Code's plugin spec treats a missing `version` field as
 * "unversioned" — consumers have no way to distinguish a fresh
 * install from an upgrade beyond the marketplace tag. Include
 * `version` so downstream tooling can surface it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginJsonPath = join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');

describe('plugin.json (#109 H3)', () => {
  const manifest = JSON.parse(readFileSync(pluginJsonPath, 'utf-8')) as Record<string, unknown>;

  it('has a version field', () => {
    expect(manifest['version']).toBeTruthy();
  });

  it('version is a valid semver-ish string', () => {
    const v = manifest['version'] as string;
    // Accept plain semver, v-prefix, pre-release, build meta.
    expect(v).toMatch(/^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/);
  });
});
