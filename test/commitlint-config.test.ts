/**
 * Tests for commitlint.config.mjs — specifically that:
 * - `security` is in the type-enum (#88).
 * - `reliability` is in the type-enum (#133) — precedent-matched from
 *   `security`, distinguishes observability/robustness hardening from
 *   plain bug fixes in release notes and `git log --grep='^reliability'`.
 * Without these, such commits would be rejected by CI and we'd conflate
 * them with generic `fix:` in changelogs.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — config file has no type definitions
import config from '../commitlint.config.mjs';

describe('commitlint type-enum', () => {
  // Shape check — rules.type-enum is [level, applicability, enumList]
  const typeEnum = (config as { rules: { 'type-enum': [number, string, readonly string[]] } })
    .rules['type-enum'];

  it('is an error-level rule (level 2)', () => {
    expect(typeEnum[0]).toBe(2);
    expect(typeEnum[1]).toBe('always');
  });

  it('includes security (#88)', () => {
    expect(typeEnum[2]).toContain('security');
  });

  it('includes reliability (#133)', () => {
    expect(typeEnum[2]).toContain('reliability');
  });

  it('retains the pre-#88 types (no regression)', () => {
    for (const t of ['feat', 'fix', 'refactor', 'docs', 'test', 'chore',
                     'perf', 'ci', 'revert', 'build', 'style']) {
      expect(typeEnum[2]).toContain(t);
    }
  });

  it('has no unexpected entries (drift guard)', () => {
    const expected = new Set([
      'feat', 'fix', 'security', 'reliability',
      'refactor', 'perf', 'docs', 'test',
      'chore', 'ci', 'revert', 'build', 'style',
    ]);
    for (const t of typeEnum[2]) {
      expect(expected.has(t), `unexpected type: ${t}`).toBe(true);
    }
  });
});
