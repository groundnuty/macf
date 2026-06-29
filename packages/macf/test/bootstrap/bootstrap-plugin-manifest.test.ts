/**
 * Tests for `tools/macf-bootstrap/.claude-plugin/plugin.json`
 * — DR-035 §7: macf-bootstrap is a marketplace plugin versioned INDEPENDENTLY
 * of the macf framework, and DECLARES the framework range it is compatible with
 * (`.compatibility.macf`, enforced by bootstrap-validate-env.sh).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const PLUGIN_JSON = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude-plugin', 'plugin.json');

describe('tools/macf-bootstrap/.claude-plugin/plugin.json', () => {
  it('exists and parses as JSON', () => {
    expect(existsSync(PLUGIN_JSON)).toBe(true);
    expect(() => JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'))).not.toThrow();
  });

  it('declares name macf-bootstrap', () => {
    const m = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(m.name).toBe('macf-bootstrap');
  });

  it('carries an independent x.y.z version (NOT lockstep with the framework)', () => {
    const m = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(typeof m.version).toBe('string');
    // Independent semver; starts the macf-bootstrap line at 0.1.0.
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares a macf-framework compatibility range', () => {
    const m = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(m.compatibility).toBeTypeOf('object');
    expect(typeof m.compatibility.macf).toBe('string');
    // A semver range; the canonical form is a `>=X.Y.Z` minimum.
    expect(m.compatibility.macf).toMatch(/^(>=|>|=)?v?\d+\.\d+\.\d+$/);
  });

  it('requires at least the DR-030/0.2.43 framework baseline', () => {
    const m = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(m.compatibility.macf).toBe('>=0.2.43');
  });

  it('has a non-empty description', () => {
    const m = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(typeof m.description).toBe('string');
    expect(m.description.length).toBeGreaterThan(0);
  });
});
