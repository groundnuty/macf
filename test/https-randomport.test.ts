/**
 * Regression guard for #109 H1: randomPort() must use crypto.randomInt,
 * not Math.random. Port values are not secrets, but the canonical
 * defensive pattern for random in security-adjacent code is the
 * CSPRNG path; Math.random is a known anti-pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomPort, PORT_RANGE_START, PORT_RANGE_SIZE } from '../src/https.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const httpsSource = readFileSync(join(repoRoot, 'src', 'https.ts'), 'utf-8');

describe('randomPort (#109 H1)', () => {
  it('returns a number within the configured range', () => {
    for (let i = 0; i < 200; i++) {
      const port = randomPort();
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
      expect(Number.isInteger(port)).toBe(true);
    }
  });

  it('uses crypto.randomInt (no Math.random in https.ts)', () => {
    // Source-level guard: Math.random is a known-weak PRNG and must
    // not appear in the channel server module.
    expect(httpsSource).not.toMatch(/Math\.random/);
    expect(httpsSource).toContain('randomInt');
  });
});
