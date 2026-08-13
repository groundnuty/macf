/**
 * Tests for `age-key-shred.ts` — DR-043 Amendment G's explicit opt-in
 * age-identity crypto-shredding (groundnuty/macf#867). Real filesystem
 * (a scratch temp dir), no network/`gh`/`age` binary involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAgeIdentityReadable, realShredAgeIdentity } from '../../../src/cli/bootstrap/age-key-shred.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratchFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-age-shred-test-'));
  dirs.push(dir);
  const p = join(dir, 'identity.txt');
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('assertAgeIdentityReadable', () => {
  it('does not throw for a real, readable file', () => {
    const p = scratchFile('AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
    expect(() => assertAgeIdentityReadable(p)).not.toThrow();
  });

  it('throws an ACTIONABLE error for a path that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-age-shred-test-'));
    dirs.push(dir);
    const p = join(dir, 'never-existed.txt');
    expect(() => assertAgeIdentityReadable(p)).toThrow(/not found or not readable/);
  });
});

describe('realShredAgeIdentity', () => {
  it('the file no longer exists after shredding', async () => {
    const p = scratchFile('AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
    expect(existsSync(p)).toBe(true);
    await realShredAgeIdentity(p);
    expect(existsSync(p)).toBe(false);
  });

  it('THROWS (does NOT silently succeed) when the path is already absent — never claim a shred that did not happen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-age-shred-test-'));
    dirs.push(dir);
    const p = join(dir, 'never-existed.txt');
    expect(existsSync(p)).toBe(false);
    await expect(realShredAgeIdentity(p)).rejects.toThrow(/nothing was shredded/);
  });

  it('handles an empty file without throwing (zero-length randomBytes(0) is valid)', async () => {
    const p = scratchFile('');
    await expect(realShredAgeIdentity(p)).resolves.toBeUndefined();
    expect(existsSync(p)).toBe(false);
  });

  it('a larger identity file (multi-recipient PEM-shaped content) shreds cleanly too', async () => {
    const p = scratchFile('AGE-SECRET-KEY-1\n'.repeat(200));
    await realShredAgeIdentity(p);
    expect(existsSync(p)).toBe(false);
  });
});
